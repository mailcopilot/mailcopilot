/**
 * §2.124 — off-thread MIME parsing for large messages.
 *
 * WHY THIS EXISTS (measured, not guessed)
 * ---------------------------------------
 * Opening a 9.6 MB message straight out of the local EML cache blocked the
 * UI for 17.5 s with no network involved at all. Profiling the very same
 * cached `.eml` files outside Electron showed the parse itself costs ~100 ms
 * of CPU for 2.5 MB and ~760 ms for 35 MB — two orders of magnitude less
 * than what production reported. The cost is not CPU, not attachment
 * buffering (the EML path already uses a streaming parser that drains
 * attachment content), not html-to-text and not linkify.
 *
 * The cost is EVENT-LOOP TURNS. `@zone-eu/mailsplit` (the MIME splitter
 * underneath `mailparser`) calls `setImmediate(iterateData)` once per line of
 * the message — see `message-splitter.js`, the `iterateData` loop. Measured
 * turn counts on real cached messages:
 *
 *     2 473 615 B  ->  32 023 setImmediate turns  (97 ms in plain Node)
 *     5 598 463 B  ->  71 960 turns              (125 ms)
 *    34 828 315 B  -> 446 591 turns              (760 ms)
 *
 * i.e. ~1 turn per 77 bytes. In plain Node a turn costs ~3 µs, so nobody
 * notices. In the Electron MAIN process the libuv loop is pumped by
 * Chromium's message loop and shared with IPC, timers, SQLite work and the
 * IMAP sockets, so a turn costs ~0.1–0.25 ms. Production log line for a file
 * we profiled directly:
 *
 *    EML hit: uid=144484 size=2473615 parse=8025ms
 *
 * 8025 ms over 2 × 32 023 turns (the EML path parses twice — once lightweight
 * for the body, once in full for a possible calendar part) = 0.125 ms/turn.
 * Applying the same model to the reported incident: 9 605 085 B ≈ 124 400
 * turns per parse, ×2 ≈ 249 000 turns ≈ 17.5 s. The reported number falls
 * straight out of the turn count.
 *
 * THE FIX. Turn cost is a property of the loop, not of the work, so the fix
 * is to run the parse on a loop that is cheap: a `worker_threads` worker has
 * its own libuv loop, not pumped by Chromium and not shared with the app's
 * main-thread work. The same 32 000 turns then cost ~100 ms again, and — more
 * importantly — zero of them land on the main thread FOR AS LONG AS THE
 * OFFLOAD HOLDS. It does not always hold: when the worker cannot run here the
 * parse falls back inline and the whole cost above comes back, silently and
 * with the app still working. That is why every dispatch is counted
 * (`recordEmlParseDispatch`) instead of trusted.
 *
 * SCOPE. Only messages at or above `EML_WORKER_MIN_BYTES` are offloaded;
 * see the constant for how the threshold was picked. Everything smaller keeps
 * parsing inline, so the ordinary message-open path does not acquire a
 * dependency on worker health.
 *
 * FAILURE POLICY IN ONE LINE, because the rest of this comment refers to it:
 * a worker DEATH is blamed on the message whenever that worker had ANNOUNCED
 * ITSELF (readiness handshake) — bytes are dispatched only to an announced
 * worker, so anything that dies afterwards died holding our work, and that
 * message is rejected and never re-parsed on the main thread. A worker that
 * dies BEFORE announcing itself was never given anything, so it means "workers
 * do not run here": offload latches off for the session and the message falls
 * back to an inline parse. A TIMEOUT is a third thing — settled by
 * `abandonJob`, which rejects the caller and never falls back inline, ready or
 * not. Full statement — `onWorkerFailure`.
 *
 * ADMISSION POLICY, the other half of what this client is for: work waiting on
 * the worker is bounded (`MAX_QUEUED_JOBS` / `MAX_QUEUED_BYTES`) and a duplicate
 * request for a message already running OR queued JOINS that job instead of
 * adding a second copy of the same bytes. Every queued entry pins a raw
 * message buffer in the main process, and `net:messageDetails` is a whitelisted
 * preload channel, so an unbounded queue was an unbounded pinned set one
 * compromised renderer away. Over the bound the parse is REFUSED
 * (`EmlParseQueueOverflowError`) rather than queued or run inline — see the
 * constants for why refusing is the failure that degrades least.
 *
 * TRUST BOUNDARY — AND WHAT THIS IS NOT. The worker receives raw, untrusted
 * message bytes, and a `worker_threads` worker is a THREAD INSIDE THE SAME
 * PROCESS with the same privileges. Concretely:
 *
 *  - Privilege: unchanged. A mailparser exploit lands in the same domain it
 *    lands in today. This is not a sandbox and must not be described as one.
 *  - Memory: NOT isolated, and `resourceLimits` does not make it so.
 *    `maxOldGenerationSizeMb` bounds the worker's V8 OLD-SPACE HEAP and
 *    nothing else. It does not bound `Buffer`s (allocated outside the V8 heap,
 *    which is what a message and its decoded attachments actually are), nor
 *    native allocations inside the parser, nor address space in general — and
 *    the thread shares the process address space, so an allocation that
 *    escapes the V8 heap exhausts the app exactly as it did before this task.
 *    What the limit buys is narrow, but it is now UNIFORM, which it was not
 *    before the readiness handshake. An OOM death arrives as a worker `error`
 *    and is classified like any other death — and because bytes are dispatched
 *    only to a worker that has announced itself, a worker that dies of the
 *    bytes it was given is by construction an announced one. So the outcome is
 *    single: the thread dies with `ERR_WORKER_OUT_OF_MEMORY`, THAT MESSAGE IS
 *    REJECTED, and the bytes are never re-parsed on the main thread. One
 *    thread, one message, offload intact for everything else. (Before the
 *    handshake this was the outcome only for a worker that had already answered
 *    something; hostile MIME opened as the first large message of a session, or
 *    the first after the 60 s idle retirement, was instead read as "workers do
 *    not run here" and handed to the main process for an inline retry.)
 *    Still not isolation, and the residue is worth naming: the parse's own
 *    appetite is unbounded, so a message can cost a whole worker per open
 *    attempt, and an allocation that escapes the V8 heap kills the process
 *    before any of the above runs. REAL memory isolation would require a
 *    separate PROCESS (`utilityProcess` / `child_process`, at the cost of a
 *    structured-clone hop over an IPC channel instead of a thread-local one)
 *    and/or an explicit bound applied before the bytes are accepted at all — a
 *    maximum input size on the offload path, and a cap on decoded output inside
 *    the worker. Neither exists today; both are filed as followups. Do not read
 *    the `resourceLimits` line below as if either were already in place.
 *  - Liveness: this genuinely does help, and it is the containment claim that
 *    survives. A job that never finishes is bounded by `JOB_TIMEOUT_MS` on the
 *    MAIN thread's own timer, so the caller is released no matter what the
 *    worker is doing — the main loop's recovery does not depend on the wedged
 *    thread cooperating. Terminating it afterwards is the cleanup, not the
 *    mechanism (V8 stops a worker at the next interruption point, which a JS
 *    parse loop like mailsplit's reaches constantly). And this outcome does NOT
 *    depend on readiness: a timeout is settled by `abandonJob`, which never
 *    raises `EmlWorkerUnavailableError`, so timed-out bytes are rejected and
 *    are never re-parsed on the main thread — announced worker or not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Worker, isMainThread } from 'node:worker_threads'
import type { MessageDetails } from './types'
import { reportNetError, reportNetEvent } from './telemetry'
// Zero-dependency pure bucketing helpers. `packages/net` must not pull
// Sentry / electron-log / electron-store into its import graph, and this
// module has none of them — it is shared deliberately so message size means
// the same thing on `smtp.send` and here (see packages/net/smtp.ts, which
// imports it for exactly this reason).
import { bucketBodySize } from '../../electron/metricsBuckets'

/**
 * Offload threshold, in bytes of raw `.eml`, known before parsing starts.
 *
 * Picked from the turn model above: at ~77 bytes per splitter yield, 64 KiB is
 * ~850 main-loop turns, i.e. ~85–210 ms at the production-measured 0.1–0.25 ms
 * per turn. That is exactly the band where `electron/ipc.ts` starts logging
 * `UiFreeze` (its `FREEZE_THRESHOLD_MS` is 200 ms), so it is the point at
 * which an inline parse stops being invisible. Below it, inline parsing keeps
 * the common path free of worker dependency for a few ms of theoretical loss;
 * above it, inline wall time grows linearly and without bound (9.6 MB → 17.5 s).
 */
export const EML_WORKER_MIN_BYTES = 64 * 1024

/**
 * A single job may not run forever. A malformed message that wedges the
 * parser must cost one worker, not the application: the timer runs on the main
 * thread, so the caller is rejected on time regardless of what the worker is
 * doing; the worker is then terminated and the next job gets a fresh one.
 * 60 s is far above any legitimate parse (35 MB measured at 760 ms) and low
 * enough that a wedge is bounded.
 */
const JOB_TIMEOUT_MS = 60_000

/**
 * Terminate an idle worker so a one-off large message does not keep a thread
 * and its heap alive for the rest of the session.
 *
 * Exported because the retire-and-replace cycle is exactly where failure
 * classification gets interesting (see `readyGeneration`), and a spec that
 * hard-codes 60 s would keep passing if this value changed underneath it.
 */
export const EML_WORKER_IDLE_SHUTDOWN_MS = 60_000

/**
 * How long a freshly spawned worker has to announce itself before the client
 * gives up on it (see the READINESS HANDSHAKE note in emlParseWorker.ts).
 *
 * Boot is a module load of a bundled chunk — no network, no database, no
 * Electron API — and measures in tens of milliseconds; 10 s is two orders of
 * magnitude of headroom for a loaded or cold machine. Expiry is not a failure
 * of the message: nothing was dispatched, so the bytes are provably innocent
 * and the client falls back inline and latches, i.e. the app keeps working and
 * gets slower. That asymmetry is why the value can afford to be generous.
 */
const WORKER_READY_TIMEOUT_MS = 10_000

/**
 * Admission bounds for work waiting on the single worker.
 *
 * Every queued job holds a REFERENCE to a raw message buffer (the copy happens
 * later, at `postMessage`), so an unbounded queue is an unbounded set of pinned
 * multi-megabyte buffers in the main process. `net:messageDetails` is a
 * whitelisted preload channel, so a compromised renderer can burst it before
 * any cache is warm and pin one buffer per call.
 *
 * Sized against reality rather than taste: legitimate concurrency here is one
 * message open plus, at most, a background path or two, and the largest message
 * seen in the wild is 35 MB. Eight entries and 64 MiB are far above that and
 * far below "the main process runs out of memory".
 *
 * `MAX_QUEUED_BYTES` counts the ACTIVE job too: its buffer is still referenced
 * on this side while the worker parses its copy.
 */
const MAX_QUEUED_JOBS = 8
const MAX_QUEUED_BYTES = 64 * 1024 * 1024

/**
 * V8 old-space ceiling for the worker, in MiB. `extractIcsFromRawEml` runs a
 * full parse that buffers attachment content, so the worker legitimately needs
 * several times the message size; 1 GiB is generous against the largest
 * messages seen in the wild (35 MB).
 *
 * Read this for exactly what it is — see the TRUST BOUNDARY note in the file
 * header. It bounds the worker's V8 heap, not the process: `Buffer`s and other
 * external allocations are not charged against it, and the worker shares the
 * process address space. It does NOT make a hostile allocation bomb
 * survivable; it only stops a runaway JS-object allocation at a known point
 * (the thread dies with `ERR_WORKER_OUT_OF_MEMORY`) rather than letting it
 * compete with the main heap. What that death costs is one rejected message —
 * bytes are dispatched only to a worker that has announced itself, so an OOM on
 * our work is always classified as message-specific and never retried inline
 * (`onWorkerFailure`). Bounding the hostile case properly needs an input-size
 * cap plus a separate process.
 */
const WORKER_MAX_OLD_GEN_MB = 1024

/** Raised when the worker cannot be started at all (missing build artifact,
 *  constructor failure). Message-independent, so callers may safely fall back
 *  to the inline parse. Distinct from a crash while parsing a SPECIFIC
 *  message, which must not be retried inline. */
export class EmlWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmlWorkerUnavailableError'
  }
}

/**
 * Raised when a parse is refused because too much work is already waiting —
 * see `MAX_QUEUED_JOBS` / `MAX_QUEUED_BYTES`.
 *
 * Deliberately NOT an `EmlWorkerUnavailableError`: refusing must not trigger
 * the inline fallback. The whole point is to stop spending main-process
 * resources on a burst, and an inline parse spends the most expensive one
 * there is. The caller sees one failed message open; the queue drains and the
 * next request is admitted normally.
 */
export class EmlParseQueueOverflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmlParseQueueOverflowError'
  }
}

/**
 * Where one parse dispatch actually ran. Mirrors `DOMAINS.eml_parse_path` in
 * electron/metricsSchema.ts, which is where the operational meaning of each
 * member is written down; keep the two in step.
 */
export type EmlParsePath =
  | 'worker'
  | 'worker_failed'
  | 'worker_aborted'
  | 'inline_below_threshold'
  | 'inline_unavailable'

/**
 * Why off-thread parsing is not possible. Mirrors
 * `DOMAINS.eml_worker_unavailable_reason` in electron/metricsSchema.ts.
 *
 * Three of the four are runtime outcomes. `'not_main_thread'` is NOT: no
 * current caller can produce it (see `offloadBlockedBy`), and it exists as an
 * invariant assertion rather than as a condition the field is expected to
 * report. If it ever appears in telemetry, that report is a bug report.
 */
export type EmlWorkerUnavailableReason =
  | 'script_missing'
  | 'spawn_failed'
  | 'startup_failed'
  | 'not_main_thread'

/** The dispatch decision for one message, before it is attempted. `reason` is
 *  present exactly when the worker was ruled out rather than not needed — the
 *  distinction the whole metric exists to make. */
export type EmlParsePlan =
  | { path: 'worker' }
  | { path: 'inline_below_threshold' }
  | { path: 'inline_unavailable'; reason: EmlWorkerUnavailableReason }

/** Job description without the correlation id the client assigns. */
export type EmlWorkerJob =
  | { type: 'parseDetails'; uid: number; raw: Uint8Array }
  | { type: 'extractIcs'; raw: Uint8Array }

export type EmlWorkerRequest = EmlWorkerJob & { id: number }

/** Sent once per worker, before any request is dispatched to it. Carries no
 *  correlation id because it answers no request — it announces the thread. */
export type EmlWorkerReady = { ready: true }

export type EmlWorkerResponse =
  | EmlWorkerReady
  | { id: number; ok: true; type: 'parseDetails'; details: MessageDetails }
  | { id: number; ok: true; type: 'extractIcs'; ics: string | undefined }
  | { id: number; ok: false; error: string }

type JobResult = MessageDetails | string | undefined

/**
 * One caller waiting on a job. Separate from the job because several callers
 * can wait on the SAME parse: asking for a message that is already being
 * parsed joins the job in flight instead of queueing a second copy of the same
 * bytes (see `findCoalescible`). One caller walking away must not cancel the
 * parse the others are still waiting for.
 */
type Waiter = {
  resolve: (value: JobResult) => void
  reject: (error: Error) => void
  settled: boolean
  detachAbort: (() => void) | null
}

type Job = {
  id: number
  request: EmlWorkerRequest
  /** Raw byte length, kept for the admission bound and read after the request
   *  has been handed over, so it must not be recomputed from a moved buffer. */
  bytes: number
  waiters: Waiter[]
  finished: boolean
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Byte-exact equality, used to decide whether two requests are the same
 * message. Exact on purpose: a cheap fingerprint (length plus a prefix) can
 * collide, and the cost of a collision here is one caller receiving ANOTHER
 * message's parsed content — a correctness and privacy failure strictly worse
 * than the duplicated work it would save. `Buffer.equals` is a memcmp over
 * views (no copy) and runs against at most `MAX_QUEUED_JOBS` candidates that
 * already matched on type, uid and length.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true
  if (a.byteLength !== b.byteLength) return false
  const av = Buffer.from(a.buffer, a.byteOffset, a.byteLength)
  const bv = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  return av.equals(bv)
}

function abortError(): Error {
  const err = new Error('EML parse aborted')
  err.name = 'AbortError'
  return err
}

/**
 * Worker path resolution. In the packaged / built main process this module is
 * bundled into `dist-electron/main*.cjs`, next to the `eml-parse-worker.js`
 * entry emitted by the same Vite build (see `vite.config.ts` `lib.entry`) —
 * the exact arrangement `electron/services/searchWorkerClient.ts` already
 * relies on. Under vitest the sources are loaded as ESM from
 * `packages/net/`, where no built worker exists: `__dirname` is not defined
 * and the `typeof` guard resolves to `null`, so every call takes the inline
 * path and the tests exercise real parsing.
 */
function resolveWorkerPath(): string | null {
  if (workerPathOverride !== undefined) return workerPathOverride
  // Resolved once: this runs on every above-threshold message open, and the
  // build layout does not change while the app is running.
  if (resolvedWorkerPath !== undefined) return resolvedWorkerPath
  const dir = typeof __dirname !== 'undefined' ? __dirname : null
  if (!dir) {
    resolvedWorkerPath = null
    return null
  }
  const candidate = path.join(dir, 'eml-parse-worker.js')
  try {
    resolvedWorkerPath = fs.existsSync(candidate) ? candidate : null
  } catch {
    resolvedWorkerPath = null
  }
  return resolvedWorkerPath
}

let workerPathOverride: string | null | undefined
let resolvedWorkerPath: string | null | undefined
/** Test seam: force a worker script path (or `null` to force the inline path). */
export function __setEmlWorkerPathForTest(value: string | null | undefined): void {
  workerPathOverride = value
  resolvedWorkerPath = undefined
}

class EmlParseWorkerClient {
  private worker: Worker | null = null
  private queue: Job[] = []
  private active: Job | null = null
  private nextId = 1
  /** Set only when the worker cannot be STARTED, and then never cleared for
   *  the rest of the session. Never set by a crash while parsing a message —
   *  see EmlWorkerUnavailableError. Doubles as the report latch: the first
   *  assignment is the transition, everything after it is the same standing
   *  condition. */
  private unavailableReason: EmlWorkerUnavailableReason | null = null
  /** Monotonic id of the worker instance this client currently owns; bumped on
   *  every spawn. Makes "the worker that is actually running" a value we can
   *  compare against instead of an implicit session-wide state. */
  private generation = 0
  /**
   * The generation that has ANNOUNCED ITSELF, or null.
   *
   * This is the discriminator the failure policy runs on, and it is scoped per
   * worker for the same reason the generation counter exists: a replacement
   * inherits nothing from its predecessor.
   *
   * Readiness rather than "has answered a job", because only readiness is
   * causally independent of the message. A worker announces itself before any
   * bytes are dispatched to it (emlParseWorker.ts, READINESS HANDSHAKE), so a
   * death before this is set provably was not caused by a message — while a
   * death after it happened on a thread that was demonstrably running, with the
   * suspect bytes in it. The earlier "has answered a job" version left a real
   * hole: bytes crafted to kill a parser, opened as the first large message of
   * a session or the first after the 60 s idle retirement, killed a worker that
   * had answered nothing, were classified as "workers do not run here" and were
   * handed to the MAIN PROCESS for an inline retry.
   */
  private readyGeneration: number | null = null
  /** The last `terminate()` this client issued, if any. Never awaited in
   *  production — the main thread must not wait on a thread it has already
   *  given up on — but it is the only honest evidence that a worker actually
   *  stopped, as opposed to merely being dereferenced (see `__stateForTest`). */
  private lastTermination: Promise<number> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  /** Raw bytes referenced by jobs waiting in `queue` (the active job is counted
   *  separately — see `pendingBytes`). Maintained incrementally because it is
   *  read on every admission decision, i.e. on every message open. */
  private queuedBytes = 0
  /** Overload report latch: one Sentry event per episode of overload, reset
   *  when the queue drains. A burst is one incident, not one per refusal —
   *  the same reasoning as `markUnavailable`. */
  private overloadReported = false
  /** How many parses this client has refused. In-process evidence for tests
   *  and for an e2e gate; the Sentry side is latched, so a counter is the only
   *  way to see the size of an episode. */
  private refused = 0

  /**
   * Record the one moment that matters: off-thread parsing just stopped being
   * possible, and every large message from here on pays the inline cost.
   *
   * Latched deliberately. After this flip `planParse` never chooses the worker
   * again, so the condition is reported by exactly one event instead of one
   * per message opened for the rest of the session — the transition is the
   * signal, the ongoing cost is what `eml.parse_dispatch` counts. The Sentry
   * side goes out through `reportNetError`, which sanitises into a closed
   * error class in electron/services/netErrorTelemetry.ts; the raw error is
   * never transmitted.
   *
   * Fire-and-forget: both seams swallow their own failures, and the whole body
   * is guarded, because this runs on the message-open path.
   */
  private markUnavailable(reason: EmlWorkerUnavailableReason, err?: unknown): void {
    if (this.unavailableReason) return
    this.unavailableReason = reason
    try {
      reportNetEvent('eml.parse_worker_unavailable', { reason })
      // `exit_reason` rather than a key of our own: it is the one allowlisted
      // context key in electron/services/netErrorTelemetry.ts for a
      // code-controlled enum, so the reason survives sanitisation and reaches
      // Sentry. Any other key would be silently dropped and the alert would
      // arrive saying only that something about the worker failed.
      if (err !== undefined) reportNetError('eml.parse.worker', err, { exit_reason: reason })
    } catch { /* telemetry must never break a parse */ }
  }

  /** Why an offload cannot happen, or null when it can. Resolving the script
   *  is itself a way to discover the answer, so the missing-chunk case latches
   *  here rather than staying invisible until something crashes. */
  private offloadBlockedBy(): EmlWorkerUnavailableReason | null {
    if (!isMainThread) {
      // INVARIANT ASSERTION, not a runtime outcome. No current caller can
      // reach this: the offloading entry points live in `parseEmlBuffer` /
      // `extractIcsFromRawEml`, and the worker entry (emlParseWorker.ts) calls
      // the `*Inline` functions directly, so nothing off the main thread ever
      // asks this client for a plan. It is kept as a hard stop against a future
      // wiring in which the worker entry offloads to itself — that would fork a
      // thread per message, recursively. Treat a field report of this reason as
      // "somebody broke the invariant", not as a condition users hit.
      this.markUnavailable('not_main_thread')
      return 'not_main_thread'
    }
    if (this.unavailableReason) return this.unavailableReason
    if (resolveWorkerPath() === null) {
      // The build/packaging failure: the app keeps working, 10× slower, and
      // nothing crashes. Without this report it is invisible in the field.
      this.markUnavailable('script_missing')
      return 'script_missing'
    }
    return null
  }

  /** Has the worker instance we own right now announced itself? Nothing is
   *  dispatched before this is true, which is what makes it a sound basis for
   *  deciding whether a death can be blamed on a message. */
  private isCurrentWorkerReady(): boolean {
    return this.readyGeneration !== null && this.readyGeneration === this.generation
  }

  /** Bytes pinned on this side by work in progress: everything queued plus the
   *  active job, whose buffer is still referenced here while the worker parses
   *  its own copy. */
  private pendingBytes(): number {
    return this.queuedBytes + (this.active?.bytes ?? 0)
  }

  /**
   * Admission control. Returns false when this request would push the pinned
   * set past the bound.
   *
   * A lone request is ALWAYS admitted, whatever its size: the bound exists to
   * stop accumulation, not to change what a single message costs, and refusing
   * a 100 MB message that arrives on an empty queue would be a behaviour
   * regression dressed up as a security fix.
   */
  private admits(bytes: number): boolean {
    if (!this.active && this.queue.length === 0) return true
    if (this.queue.length >= MAX_QUEUED_JOBS) return false
    return this.pendingBytes() + bytes <= MAX_QUEUED_BYTES
  }

  /**
   * Report an overload episode once.
   *
   * Latched like `markUnavailable`, and for a sharper reason: the condition is
   * reached by a BURST, so an event per refusal would let the reporter amplify
   * the very flood it is reporting. The counter carries the size; the event
   * carries the fact.
   */
  private reportOverload(): void {
    this.refused += 1
    if (this.overloadReported) return
    this.overloadReported = true
    try {
      // Synthetic error built here from literals — nothing about the refused
      // message travels. `exit_reason` is the allowlisted code-controlled enum
      // key in electron/services/netErrorTelemetry.ts.
      reportNetError('eml.parse.queue', new Error('EML parse queue overflow'), {
        exit_reason: 'queue_overflow',
      })
    } catch { /* telemetry must never break a parse */ }
  }

  /**
   * Find a job that is already parsing exactly these bytes, or null.
   *
   * Two callers asking for the same message must not queue two copies of it:
   * the second joins the first. This is the fix for the repeated click on a
   * message that has not finished loading, and it takes the duplicate half of a
   * burst out of the admission bound entirely.
   *
   * Identity is (type, uid, exact bytes) — see `sameBytes` for why exact.
   * A finished job is never a candidate, so a late duplicate starts fresh
   * rather than attaching to something that will never settle again.
   */
  private findCoalescible(request: EmlWorkerJob): Job | null {
    const candidates = this.active ? [this.active, ...this.queue] : this.queue
    for (const job of candidates) {
      if (job.finished) continue
      if (job.request.type !== request.type) continue
      if (job.request.type === 'parseDetails' && request.type === 'parseDetails'
        && job.request.uid !== request.uid) continue
      if (job.bytes !== request.raw.byteLength) continue
      if (sameBytes(job.request.raw, request.raw)) return job
    }
    return null
  }

  /** Decide where one message should be parsed. Below the threshold the worker
   *  is not consulted at all, so an unavailable worker never makes an ordinary
   *  message look like an incident. */
  planParse(bytes: number): EmlParsePlan {
    if (bytes < EML_WORKER_MIN_BYTES) return { path: 'inline_below_threshold' }
    const reason = this.offloadBlockedBy()
    return reason ? { path: 'inline_unavailable', reason } : { path: 'worker' }
  }

  /**
   * Queue one job.
   *
   * `signal` is OPTIONAL AND UNUSED IN PRODUCTION TODAY. No caller in
   * `electron/main.ts` passes one — cancelling an in-flight open needs an IPC
   * cancel channel through `preload.ts`, which is not wired and is filed as a
   * followup owned by the electron boundary. The consequence to keep straight
   * when reading this file, its specs and the `worker_aborted` metric: the
   * abandoned-open behaviour described below is implemented and covered by
   * tests, but nothing user-visible reaches it yet, so a `worker_aborted` count
   * of zero in the field means "not wired", not "users never walk away from a
   * slow open". The only cancellation that actually happens in production is
   * the job timeout, which uses the same `abandonJob` path.
   *
   * Two things can happen before a job exists at all: the request may JOIN a
   * parse of the same bytes already in flight, and it may be REFUSED because
   * too much work is already pinned (see `admits`).
   */
  run(request: EmlWorkerJob, signal?: AbortSignal): Promise<JobResult> {
    return new Promise<JobResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const waiter: Waiter = { resolve, reject, settled: false, detachAbort: null }

      // Joining costs nothing and pins nothing, so it is decided before
      // admission: a duplicate request must never be refused for the size of
      // bytes the client is already holding on its behalf.
      const existing = this.findCoalescible(request)
      if (existing) {
        this.attach(existing, waiter, signal)
        return
      }

      if (!this.admits(request.raw.byteLength)) {
        this.reportOverload()
        reject(new EmlParseQueueOverflowError(
          `EML parse refused: ${this.queue.length} jobs / ${this.pendingBytes()} bytes already queued`,
        ))
        return
      }

      const id = this.nextId++
      const job: Job = {
        id,
        request: { ...request, id } as EmlWorkerRequest,
        bytes: request.raw.byteLength,
        waiters: [],
        finished: false,
        timer: null,
      }
      this.attach(job, waiter, signal)
      this.queue.push(job)
      this.queuedBytes += job.bytes
      this.pump()
    })
  }

  /** Register one caller's interest in a job, including its abort wiring. */
  private attach(job: Job, waiter: Waiter, signal?: AbortSignal): void {
    if (signal) {
      const onAbort = () => this.cancelWaiter(job, waiter)
      signal.addEventListener('abort', onAbort, { once: true })
      waiter.detachAbort = () => signal.removeEventListener('abort', onAbort)
    }
    job.waiters.push(waiter)
  }

  /** Settle the job and every caller waiting on it. */
  private settleJob(job: Job, error: Error | null, value?: JobResult): void {
    if (job.finished) return
    job.finished = true
    if (job.timer) {
      clearTimeout(job.timer)
      job.timer = null
    }
    const waiters = job.waiters.splice(0, job.waiters.length)
    for (const waiter of waiters) this.settleWaiter(waiter, error, value)
  }

  private settleWaiter(waiter: Waiter, error: Error | null, value?: JobResult): void {
    if (waiter.settled) return
    waiter.settled = true
    waiter.detachAbort?.()
    waiter.detachAbort = null
    if (error) waiter.reject(error)
    else waiter.resolve(value)
  }

  /** Remove a job from the queue, keeping the byte accounting exact. */
  private dequeue(job: Job): boolean {
    const idx = this.queue.indexOf(job)
    if (idx < 0) return false
    this.queue.splice(idx, 1)
    this.queuedBytes -= job.bytes
    return true
  }

  /** One caller walked away. The parse itself survives as long as anybody else
   *  is still waiting on it — coalescing must not let one abandoned open cancel
   *  another window's. */
  private cancelWaiter(job: Job, waiter: Waiter): void {
    if (waiter.settled || job.finished) return
    const idx = job.waiters.indexOf(waiter)
    if (idx >= 0) job.waiters.splice(idx, 1)
    this.settleWaiter(waiter, abortError())
    if (job.waiters.length === 0) this.abandonJob(job, abortError())
  }

  /** Abort or time out a whole job. A job still in the queue is simply dropped;
   *  the job currently executing also costs the worker, because the only way to
   *  stop work already running inside it is to terminate the thread. The
   *  queue survives and is re-dispatched to a fresh worker.
   *
   *  In production this is reached only from the job timeout: the abort half is
   *  wired to an `AbortSignal` that nothing user-facing supplies yet (see
   *  `run`). */
  private abandonJob(job: Job, error: Error): void {
    if (job.finished) return
    const wasActive = this.active === job
    if (!wasActive) {
      this.dequeue(job)
      this.settleJob(job, error)
      return
    }
    this.settleJob(job, error)
    this.active = null
    this.discardWorker()
    this.pump()
  }

  /** Drop the current worker without letting its late events reach us. The
   *  terminate promise is kept (not awaited) so termination can be observed;
   *  a rejection is recorded as an unknown exit code rather than surfacing as
   *  an unhandled rejection, because a termination race is not actionable. */
  private discardWorker(): void {
    const worker = this.worker
    this.worker = null
    this.clearIdleTimer()
    this.clearReadyTimer()
    if (!worker) return
    worker.removeAllListeners()
    this.lastTermination = worker.terminate().catch(() => -1)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }

  /** The worker announced itself. Nothing was dispatched before this point, so
   *  from here on a death is attributable to the work. */
  private onReady(): void {
    this.clearReadyTimer()
    this.readyGeneration = this.generation
    this.pump()
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer()
    if (!this.worker) return
    const timer = setTimeout(() => {
      this.idleTimer = null
      if (!this.active && this.queue.length === 0) this.discardWorker()
    }, EML_WORKER_IDLE_SHUTDOWN_MS)
    // A telemetry-grade timer must never hold the process open.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref()
    }
    this.idleTimer = timer
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    // Once the flip has happened, spawning is known to be futile. Refusing
    // here keeps the documented policy ("offload stays off for the rest of the
    // session rather than paying a doomed spawn per message") true for jobs
    // that were already queued when it happened, and keeps the transition to a
    // single report instead of one per stranded job.
    if (this.unavailableReason) {
      throw new EmlWorkerUnavailableError(`EML parse worker unavailable: ${this.unavailableReason}`)
    }
    const workerPath = resolveWorkerPath()
    if (!workerPath) {
      throw new EmlWorkerUnavailableError('EML parse worker script not found')
    }
    let worker: Worker
    try {
      // See WORKER_MAX_OLD_GEN_MB: a V8 heap ceiling, NOT process isolation.
      worker = new Worker(workerPath, {
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB },
      })
    } catch (err) {
      throw new EmlWorkerUnavailableError(
        `EML parse worker failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // A new instance has announced nothing yet, so the generation moves before
    // any listener can record a readiness that belongs to its predecessor.
    this.generation += 1
    worker.on('message', (message: EmlWorkerResponse) => this.onMessage(message))
    worker.on('error', (err) => this.onWorkerFailure(err))
    worker.on('exit', (code) => {
      if (code === 0 && !this.active) return
      this.onWorkerFailure(new Error(`EML parse worker exited with code ${code}`))
    })
    // A worker that comes up but never announces itself would otherwise hold
    // its jobs forever: the dispatch gate is waiting for a signal that is not
    // coming, and the job timeout cannot help because no job ever started.
    // Expiry is deliberately treated as a startup failure — nothing was
    // dispatched, so the pending bytes cannot be the cause.
    const readyTimer = setTimeout(() => {
      this.readyTimer = null
      this.onWorkerFailure(
        new Error(`EML parse worker did not signal readiness within ${WORKER_READY_TIMEOUT_MS}ms`),
      )
    }, WORKER_READY_TIMEOUT_MS)
    if (typeof (readyTimer as { unref?: () => void }).unref === 'function') {
      (readyTimer as { unref: () => void }).unref()
    }
    this.readyTimer = readyTimer
    this.worker = worker
    return worker
  }

  private onMessage(message: EmlWorkerResponse): void {
    if ('ready' in message) {
      this.onReady()
      return
    }
    const job = this.active
    if (!job || job.id !== message.id) return
    this.active = null
    if (!message.ok) {
      this.settleJob(job, new Error(message.error))
    } else if (message.type === 'parseDetails') {
      this.settleJob(job, null, message.details)
    } else {
      this.settleJob(job, null, message.ics)
    }
    this.pump()
  }

  /**
   * The worker died (uncaught error, unexpected exit, or never announced
   * itself). Two readings, and the discriminator is whether THE WORKER THAT
   * DIED had announced itself — `readyGeneration === generation`:
   *
   *  - it had not announced itself — nothing had been dispatched to it, so the
   *    death cannot have been caused by a message. That is the worker script
   *    failing to load or run here (missing chunk, broken build, environment
   *    without threads). Report it as "unavailable": the caller falls back to
   *    the inline parse and the feature keeps working exactly as it did before
   *    this task. Offload stays off for the rest of the session rather than
   *    paying a doomed spawn per message.
   *  - it had announced itself — the thread was demonstrably running, and what
   *    it was doing when it died is the work we gave it. Propagate. Retrying
   *    those bytes inline would aim a parse that just killed a thread at the
   *    main process, which is the very failure this task exists to remove. A
   *    fresh worker serves the next job, so one bad message costs one message,
   *    not the feature.
   *
   * Readiness, not "has answered a job" — this is a security property, not a
   * refinement. A remote sender can craft MIME that exhausts the parser. Under
   * the old discriminator, opening such a message as the first large one of the
   * session (or the first after the 60 s idle retirement) killed a worker that
   * had answered nothing, which was read as "workers do not run here" — and the
   * fallback then handed those exact bytes to the MAIN PROCESS. Readiness
   * closes it by construction rather than by heuristic: the announcement
   * precedes any dispatch, so "died before ready" is causally independent of
   * the message in a way that "died before answering" never was.
   *
   * The asymmetry that remains is the safe one: a ready worker that dies for an
   * environmental reason (an OS-level kill, say) with a job in flight has that
   * message blamed and rejected. One failed message open, and offload survives
   * — the opposite mistake would put suspect bytes on the main thread.
   */
  private onWorkerFailure(err: unknown): void {
    const job = this.active
    this.active = null
    const startupFailure = !this.isCurrentWorkerReady()
    this.discardWorker()
    if (startupFailure) {
      // Latched: reports the transition once, Sentry included.
      this.markUnavailable('startup_failed', err)
    } else {
      // A message-specific death, by contrast, IS per message — each one is a
      // separate incident with its own suspect bytes.
      //
      // `exit_reason` again, and for the same reason as in `markUnavailable`:
      // it is the one allowlisted context key in
      // electron/services/netErrorTelemetry.ts that carries a code-controlled
      // enum, so the value survives sanitisation. This call used to pass
      // `stage` and `startup`, neither of which is on that allowlist — both
      // were dropped in silence and the alert arrived saying only that
      // something about the worker had failed. `startup` is gone rather than
      // renamed: this branch is by construction the non-startup one, and
      // 'job_crash' vs 'idle_crash' already carries what `stage` encoded.
      reportNetError('eml.parse.worker', err, { exit_reason: job ? 'job_crash' : 'idle_crash' })
    }
    if (job) {
      this.settleJob(
        job,
        startupFailure
          ? new EmlWorkerUnavailableError(
              `EML parse worker failed to start: ${err instanceof Error ? err.message : String(err)}`,
            )
          : err instanceof Error
            ? err
            : new Error(String(err)),
      )
    }
    this.pump()
  }

  /**
   * Dispatch the head of the queue, if there is one and the worker is ready
   * for it.
   *
   * The job is PEEKED, not shifted, until it can actually be handed over: while
   * a freshly spawned worker is still coming up, the head must stay in the
   * queue (and keep counting against the admission bound) rather than sit in a
   * limbo the client cannot account for. `onReady` calls back in here.
   */
  private pump(): void {
    if (this.active) return
    // Drop heads abandoned while they waited.
    while (this.queue.length > 0 && this.queue[0].finished) this.dequeue(this.queue[0])
    const job = this.queue[0]
    if (!job) {
      // A drained queue ends the overload episode: the next refusal, if any,
      // is a new incident and reports again.
      this.overloadReported = false
      this.scheduleIdleShutdown()
      return
    }
    let worker: Worker
    try {
      worker = this.ensureWorker()
    } catch (err) {
      this.markUnavailable('spawn_failed', err)
      const unavailable =
        err instanceof EmlWorkerUnavailableError
          ? err
          : new EmlWorkerUnavailableError(String(err))
      // Everything queued shares the same fate — the worker is gone.
      const stranded = this.queue.splice(0, this.queue.length)
      this.queuedBytes = 0
      for (const other of stranded) this.settleJob(other, unavailable)
      return
    }
    // Nothing is handed to a worker that has not announced itself. This is the
    // dispatch half of the readiness handshake, and it is what makes "died
    // before ready" mean "cannot have been the message".
    if (!this.isCurrentWorkerReady()) return
    this.dequeue(job)
    this.clearIdleTimer()
    this.active = job
    job.timer = setTimeout(() => {
      this.abandonJob(job, new Error(`EML parse timed out after ${JOB_TIMEOUT_MS}ms`))
    }, JOB_TIMEOUT_MS)
    if (typeof (job.timer as { unref?: () => void }).unref === 'function') {
      (job.timer as { unref: () => void }).unref()
    }
    try {
      worker.postMessage(job.request)
    } catch (err) {
      this.active = null
      this.discardWorker()
      this.settleJob(job, err instanceof Error ? err : new Error(String(err)))
      this.pump()
    }
  }

  /** Test seam: drop all state so each spec starts from a cold client. */
  __resetForTest(): void {
    const pending = [...this.queue]
    this.queue = []
    this.queuedBytes = 0
    const active = this.active
    this.active = null
    this.discardWorker()
    this.unavailableReason = null
    this.generation = 0
    this.readyGeneration = null
    this.lastTermination = null
    this.overloadReported = false
    this.refused = 0
    resetDispatchCounts()
    for (const job of pending) this.settleJob(job, abortError())
    if (active) this.settleJob(active, abortError())
  }

  /** Test seam: observable internals, so specs can assert lifecycle rather
   *  than timing. `dispatch` is also the introspection surface an e2e gate
   *  needs to prove that a live Electron process really parses off-thread:
   *  a non-zero `worker` count is the only in-process evidence that the
   *  offload happened rather than silently degrading to the inline path.
   *
   *  `hasWorker` says only whether this client HOLDS a reference. It is not
   *  evidence that a discarded thread has stopped — for that, await
   *  `__terminationForTest()`. */
  __stateForTest(): {
    hasWorker: boolean
    queued: number
    active: boolean
    unavailable: boolean
    unavailableReason: EmlWorkerUnavailableReason | null
    generation: number
    currentWorkerReady: boolean
    queuedBytes: number
    pendingBytes: number
    refused: number
    waiters: number
    dispatch: Readonly<Record<EmlParsePath, number>>
  } {
    return {
      hasWorker: this.worker !== null,
      queued: this.queue.length,
      active: this.active !== null,
      unavailable: this.unavailableReason !== null,
      unavailableReason: this.unavailableReason,
      generation: this.generation,
      currentWorkerReady: this.isCurrentWorkerReady(),
      queuedBytes: this.queuedBytes,
      pendingBytes: this.pendingBytes(),
      refused: this.refused,
      // Total callers waiting across every job — the only way to see that two
      // requests joined ONE parse rather than each getting their own.
      waiters: (this.active ? this.active.waiters.length : 0)
        + this.queue.reduce((sum, job) => sum + job.waiters.length, 0),
      dispatch: emlParseDispatchCounts(),
    }
  }

  /** Test seam: the last termination this client issued, or null if it has
   *  never terminated a worker. Node settles it once the thread has actually
   *  stopped, which is the difference between "we let go of it" and "it is
   *  gone" — the assertion a timeout spec has to make. */
  __terminationForTest(): Promise<number> | null {
    return this.lastTermination
  }
}

const client = new EmlParseWorkerClient()

/**
 * Decide where one message should be parsed, and — when the worker is ruled
 * out — say why. Callers use the plan to dispatch AND to report, which is the
 * point: "inline because this message is small" and "inline because off-thread
 * parsing is broken in this build" are the same observable behaviour and
 * wildly different health states.
 */
export function planEmlParseDispatch(raw: { length: number }): EmlParsePlan {
  return client.planParse(raw.length)
}

const EMPTY_DISPATCH_COUNTS: Record<EmlParsePath, number> = {
  worker: 0,
  worker_failed: 0,
  worker_aborted: 0,
  inline_below_threshold: 0,
  inline_unavailable: 0,
}

let dispatchCounts: Record<EmlParsePath, number> = { ...EMPTY_DISPATCH_COUNTS }

function resetDispatchCounts(): void {
  dispatchCounts = { ...EMPTY_DISPATCH_COUNTS }
}

/**
 * Count one completed parse dispatch.
 *
 * Fire-and-forget by contract: the whole body is guarded, and the counter is
 * bumped before the seam is touched so in-process introspection survives a
 * broken sink. A parse must never fail because telemetry did.
 *
 * Not aggregated (see `eml.parse_dispatch` in electron/metricsSchema.ts):
 * buffering would suppress the local log line under a closed consent gate,
 * which is exactly the situation where it is the only evidence available.
 */
export function recordEmlParseDispatch(path: EmlParsePath, bytes: number): void {
  try {
    dispatchCounts[path] += 1
    reportNetEvent('eml.parse_dispatch', { path, size_bucket: bucketBodySize(bytes) })
  } catch { /* telemetry must never break a parse */ }
}

/** Per-path dispatch counts for this process. Cheap in-process evidence of
 *  which path parses actually took — see `__stateForTest`. */
export function emlParseDispatchCounts(): Readonly<Record<EmlParsePath, number>> {
  return { ...dispatchCounts }
}

/** `signal` is accepted but not supplied by any production caller yet — see
 *  `EmlParseWorkerClient.run`. */
export function parseEmlDetailsInWorker(
  uid: number,
  raw: Buffer,
  signal?: AbortSignal,
): Promise<MessageDetails> {
  // Structured clone copies the bytes rather than transferring them: the
  // caller keeps ownership of `raw` (the EML path uses the same buffer again
  // for the calendar scan), and a copy of even 9.6 MB is a few milliseconds.
  return client.run({ type: 'parseDetails', uid, raw }, signal) as Promise<MessageDetails>
}

/** `signal` is accepted but not supplied by any production caller yet — see
 *  `EmlParseWorkerClient.run`. */
export function extractIcsInWorker(
  raw: Buffer,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return client.run({ type: 'extractIcs', raw }, signal) as Promise<string | undefined>
}

export function __resetEmlWorkerForTest(): void {
  client.__resetForTest()
}

export function __emlWorkerStateForTest(): ReturnType<EmlParseWorkerClient['__stateForTest']> {
  return client.__stateForTest()
}

/** Test seam: settles when the most recently discarded worker thread has
 *  actually stopped; null if this client has never discarded one. */
export function __emlWorkerTerminationForTest(): Promise<number> | null {
  return client.__terminationForTest()
}
