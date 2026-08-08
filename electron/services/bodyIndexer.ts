/**
 * Background body text indexer for Search Excellence.
 *
 * Walks cached messages without body_text and fetches their body from IMAP
 * in small batches, filling the FTS5 index without requiring the user to open
 * each message manually.
 *
 * Semantics:
 * - body_text IS NULL → not indexed, will be retried
 * - body_text = ''    → indexed, message has no text/html parts (e.g. image-only)
 * - body_text = '...' → indexed with content
 *
 * Messages without text/plain or text/html BODYSTRUCTURE parts are marked as ''
 * (no retry).  The full-parse fallback (simpleParser) is intentionally skipped
 * to keep the indexer lightweight; users can still open such messages manually,
 * which triggers net:messageDetails with its full-parse path.
 *
 * Search Excellence Hardening additions:
 * - Per-folder error backoff after `maxFolderRetries` consecutive fetch errors.
 * - Prioritized folder ordering: INBOX → Sent → Archive → Drafts/Trash/Junk →
 *   everything else. There is no "current folder" input: the indexer has no
 *   view of the UI, and the header claimed one for a while although
 *   `folderSortPriority` never had a parameter for it.
 * - Checkpoint/resume: folders with errors are skipped and retried after backoff.
 *
 * §2.115 — scheduling and the cost of "nothing to do":
 * - The tick starts from `listFoldersWithPendingBodies()`, i.e. from the
 *   backlog itself, instead of enumerating every folder and probing each one.
 *   On a drained mailbox this is one query against a partial index that
 *   returns nothing, whatever the corpus size.
 * - The interval is adaptive: a tick that moved nothing doubles the delay up
 *   to `idleMaxIntervalMs`; any progress snaps it back to the base interval.
 *   A run of empty ticks therefore costs a handful of queries per hour rather
 *   than one every two seconds.
 * - The indexer has no push signal of its own, so it cannot notice new mail
 *   between ticks. Freshness therefore depends on the caller: main calls
 *   `resetBodyIndexerBackoff()` after a sync that actually fetched/committed
 *   rows, which pulls the next tick forward to the base interval. Without such
 *   a call the ceiling is the worst-case staleness — nothing inside this file
 *   can shorten it.
 * - A tick skipped because of pause/offline keeps the base cadence — that is
 *   "not now", not "no work". This only applies when the caller supplies
 *   `isPaused` / `isOffline`; a caller that omits `isPaused` gets no pause
 *   handling at all, not a silent equivalent.
 * - The folder loop yields to the event loop between folders so a long pass
 *   never holds the main thread in one piece.
 */
import {
  getUidsWithoutBodyText,
  updateMessageBodyText,
  listIndexedFolders,
  listFoldersWithPendingBodies,
  getSearchIndexStats,
} from '../../packages/db'
import type { SearchIndexStats } from '../../packages/db'
import { createHash } from 'node:crypto'
import { createLogger } from '../logger'
import { captureException } from '../sentry'
import {
  recordEvent,
  recordHistogram,
  recordGauge,
  folderRoleFromPath,
  bucketBatchSize,
  startMetricSpan,
} from '../metrics'
import { bucketCount } from '../metricsBuckets'

const log = createLogger('BodyIndexer')

// --- captureException dedup gate ---
//
// The body indexer tick runs every ~2s. If a persistent (non-transient) bug
// flips the tick into a fail state, raw captureException would flood Sentry
// thousands of times per hour. We gate by error signature + cooldown so the
// SAME repeating bug emits at most once per CAPTURE_COOLDOWN_MS, while a NEW
// failure mode still gets captured immediately. log.error remains unguarded
// so local diagnostics see every occurrence.
//
// Map size is bounded: at most CAPTURE_KEY_LIMIT entries; on insertion past
// the cap the oldest entry is dropped (insertion-order LRU via Map iteration).
const CAPTURE_COOLDOWN_MS = 5 * 60 * 1000
const CAPTURE_KEY_LIMIT = 50
const captureLastSeen = new Map<string, number>()

/**
 * Cooldown gate over a bounded, insertion-ordered map.
 *
 * Returns true when `key` has not been seen within `cooldownMs` (and records
 * it), false while it is still inside the window. Shared by the Sentry gate
 * and the predicate-failure log gate so the two cannot drift apart.
 */
function passesCooldown(map: Map<string, number>, key: string, cooldownMs: number): boolean {
  const now = Date.now()
  const last = map.get(key)
  if (last !== undefined && now - last < cooldownMs) return false
  // Refresh insertion order: delete then set so the entry moves to the end.
  map.delete(key)
  map.set(key, now)
  // Cap size — drop oldest (Map iteration is insertion order).
  if (map.size > CAPTURE_KEY_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  return true
}

export function captureOnce(
  key: string,
  err: unknown,
  context: Record<string, unknown>,
  cooldownMs: number = CAPTURE_COOLDOWN_MS,
): void {
  if (!passesCooldown(captureLastSeen, key, cooldownMs)) return
  try {
    captureException(err, context)
  } catch {
    /* telemetry must not throw */
  }
}

/**
 * Local-only dedup fingerprint. NEVER transmitted.
 *
 * The value is derived from the error text, which is exactly why it stays
 * inside this process: it is used solely as a key into the in-memory cooldown
 * `Map`s above. `captureOnce(key, ...)` takes the key for the gate and passes
 * only `err` and `context` to `captureException` — the key itself is not part
 * of any payload. (Stated explicitly because the shape looks alarming: a
 * message-derived string next to a Sentry call.)
 *
 * The message is HASHED rather than truncated. A 100-character prefix was the
 * fingerprint before, and two genuinely different failures that agree on their
 * first 100 characters — the common case for `EACCES: permission denied, open
 * '<long path>'` against neighbouring files — silently suppressed each other
 * for the whole cooldown window. A digest over the whole message distinguishes
 * them while keeping the key bounded in size.
 */
function errorKey(err: unknown): string {
  const name = err instanceof Error ? err.name : 'Unknown'
  const message = err instanceof Error ? (err.message ?? '') : String(err)
  return `${name}:${createHash('sha256').update(message).digest('hex').slice(0, 32)}`
}

/** Reset capture dedup state (for testing). */
export function resetBodyIndexerCaptureGate(): void {
  captureLastSeen.clear()
  predicateLogLastSeen.clear()
}

// --- Caller-supplied predicates ---
//
// `isOffline` and `isPaused` are functions handed in by main: in production
// they read the settings store (`workOffline`) and the header-sync counter.
// A settings read is I/O and can fail — EACCES on the store under concurrent
// access has been observed in this repo — so these predicates can throw.
//
// They used to be evaluated OUTSIDE the tick's try/catch. A throw therefore
// rejected `tick()`, which the scheduler calls as a floating promise: an
// unhandled rejection every `intervalMs`, forever, while the tick's own
// `nextDelayMs` bookkeeping and `finally` never ran.
//
// Direction on failure: FAIL SAFE — "cannot tell" is treated as "hold off".
// The two possible readings are not symmetric. Guessing "not paused" resumes
// IMAP fetches during a header sync (the pool contention `isPaused` exists to
// prevent) and keeps indexing while the user's explicit work-offline setting
// may well be on — we would be acting against a stated preference we simply
// failed to read. Guessing "paused" costs only search staleness, and it is
// self-correcting: the next tick asks again, and the base cadence is kept
// (skips never feed the idle backoff), so the moment the predicate recovers
// indexing resumes within one interval.
//
// Both the log line and the Sentry event are throttled: a broken predicate
// repeats at tick cadence by construction, so "once per occurrence" would be
// thousands of identical lines per hour.
const predicateLogLastSeen = new Map<string, number>()

// --- What a predicate failure is allowed to transmit ---
//
// The predicates read local state on the user's own machine: in production
// `isOffline` is `() => getSettings().workOffline === true`, i.e. a settings
// store read. When that fails the exception is FREE TEXT written by a third
// party (Node's fs layer, electron-store, JSON.parse) and it routinely embeds
// a filesystem path — `EACCES: permission denied, open
// '/home/<user>/.config/MailCopilot/config.json'`.
//
// `scrubEventPii` in `beforeSend` is the LAST line of defence, not the only
// one (CLAUDE.md §5 "Telemetry consent"): every send site owes it to emit
// aggregates itself, and the standing rule against third-party free text is an
// ALLOWLIST, not a denylist. An arbitrary exception message has no shape for a
// regex to recognise, so the promise is kept by not transmitting the message at
// all — the same boundary `electron/services/netErrorTelemetry.ts` draws for
// server text, and the same synthetic-exception shape as `AiKeyStoreUnavailable`
// in `electron/services/ai.ts` (§2.122).
//
// The split is therefore:
//   - Sentry gets a SYNTHETIC error whose every field is a literal in this file
//     (a fixed name, a message built from the predicate name and the closed
//     class set) plus code-controlled context.
//   - `log.error` keeps the RAW error, deliberately. electron-log writes to a
//     local file on the user's own machine and never leaves it — that is where
//     diagnostics belong, and it is the only place the actual path/errno text
//     survives. Stripping it too would cost the entire diagnostic value of the
//     report and buy nothing, because nothing here is transmitted. Do not
//     "harden" this line; see the identical carve-out in netErrorTelemetry.ts.
//
// No transient-network gate (unlike netErrorTelemetry): these predicates touch
// local state only, so `isTransientNetworkError` has nothing to match and a
// laptop lid cannot produce one of these events.

/** Predicate identity is a literal at every call site, pinned by the type. */
type PredicateName = 'isOffline' | 'isPaused'

/**
 * Closed set of failure classes. Every member is a LITERAL below and no branch
 * derives one from the error's own text, so the class cannot carry PII whatever
 * the store threw.
 *
 * Why these five: the reachable failure modes of "read a small local JSON store
 * / an in-process counter" are the store being unreadable (`permission`), not
 * there at all (`missing`), there but unparseable (`corrupt`), or the read
 * failing at the device/handle level (`io`). Everything else — including a
 * programming error inside the predicate — degrades to `unknown`, which is the
 * only safe direction: an unrecognised error yields LESS information, never a
 * leak. `error_kind` below still separates a genuine bug (TypeError) from an
 * unrecognised environment failure without reading any text.
 */
type PredicateErrorClass = 'permission' | 'missing' | 'corrupt' | 'io' | 'unknown'

/** Prototype-chain kind. Never `err.name` — that property is assignable, so an
 *  arbitrary throw could set it to anything, including PII. */
type PredicateErrorKind = 'TypeError' | 'RangeError' | 'SyntaxError' | 'ReferenceError' | 'Error' | 'UnknownError'

/** libuv/Node errno values, which Node sets itself on `err.code`. Structured
 *  input, matched against a fixed map: a code we do not know contributes
 *  nothing rather than travelling as a string. */
const PREDICATE_CODE_CLASS: Readonly<Record<string, PredicateErrorClass>> = {
  EACCES: 'permission',
  EPERM: 'permission',
  ENOENT: 'missing',
  EIO: 'io',
  EBUSY: 'io',
  EAGAIN: 'io',
  EMFILE: 'io',
  ENFILE: 'io',
  ENOSPC: 'io',
  EROFS: 'io',
  EISDIR: 'io',
  ENOTDIR: 'io',
  ENAMETOOLONG: 'io',
}

/**
 * Last-resort classifiers for errors that arrive without a `code` — a wrapper
 * that kept the wording and dropped the structured field, which is what
 * electron-store/conf do on some paths.
 *
 * These patterns are AUTHORED HERE and only ever select a literal from the set
 * above; the message is an input to the match and never an output. Order is
 * irrelevant because the classes are disjoint by construction.
 */
const PREDICATE_MESSAGE_CLASS: ReadonlyArray<readonly [RegExp, PredicateErrorClass]> = [
  [/\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i, 'permission'],
  [/\bENOENT\b|no such file or directory/i, 'missing'],
  [/unexpected token|unexpected end of (?:json|input)|is not valid json|invalid json|json at position/i, 'corrupt'],
  [/\bEIO\b|\bEBUSY\b|\bENOSPC\b|\bEROFS\b|\bEMFILE\b|\bENFILE\b/i, 'io'],
]

/** Read a string property without trusting it — used for LOOKUPS only. */
function readErrorString(err: unknown, key: string): string {
  const v = (err as Record<string, unknown> | null | undefined)?.[key]
  return typeof v === 'string' ? v : ''
}

/**
 * Map a predicate failure onto the closed class set, walking `cause` because a
 * store wrapper typically hides the errno one level down. Bounded depth and a
 * seen-set: a self-referential `cause` must not spin.
 */
function classifyPredicateError(err: unknown): PredicateErrorClass {
  const seen = new Set<unknown>()
  let cur: unknown = err
  for (let depth = 0; depth < 5 && cur !== null && cur !== undefined; depth++) {
    if (seen.has(cur)) break
    seen.add(cur)
    const code = readErrorString(cur, 'code').toUpperCase()
    if (code && Object.prototype.hasOwnProperty.call(PREDICATE_CODE_CLASS, code)) {
      return PREDICATE_CODE_CLASS[code]!
    }
    if (cur instanceof SyntaxError) return 'corrupt'
    const message = readErrorString(cur, 'message')
    if (message) {
      for (const [re, cls] of PREDICATE_MESSAGE_CLASS) {
        if (re.test(message)) return cls
      }
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return 'unknown'
}

function classifyPredicateErrorKind(err: unknown): PredicateErrorKind {
  if (err instanceof TypeError) return 'TypeError'
  if (err instanceof RangeError) return 'RangeError'
  if (err instanceof SyntaxError) return 'SyntaxError'
  if (err instanceof ReferenceError) return 'ReferenceError'
  if (err instanceof Error) return 'Error'
  return 'UnknownError'
}

/**
 * Report a predicate failure across the boundary described above: raw error to
 * the local log, synthetic error to Sentry. Never throws — the caller is a
 * scheduler tick that must settle either way.
 */
function reportPredicateFailure(name: PredicateName, err: unknown): void {
  const errorClass = classifyPredicateError(err)
  // Local-only dedup key (see `errorKey`); shared by the log gate and the
  // Sentry gate so the two cannot report at different cadences.
  const key = `predicate:${name}:${errorKey(err)}`
  if (passesCooldown(predicateLogLastSeen, key, CAPTURE_COOLDOWN_MS)) {
    // RAW, and on purpose — local sink, never transmitted.
    log.error(`Body indexer ${name}() threw; holding off until it recovers:`, err)
  }
  // Synthetic: message, name and every context value below are literals from
  // this file or members of the closed sets above. Nothing is derived from the
  // exception's own text.
  const synthetic = new Error(`body_indexer_predicate_${name}_${errorClass}`)
  synthetic.name = 'BodyIndexerPredicateError'
  captureOnce(key, synthetic, {
    source: 'bodyIndexer',
    predicate: name,
    error_class: errorClass,
    error_kind: classifyPredicateErrorKind(err),
  })
}

function evalPredicate(fn: (() => boolean) | undefined, name: PredicateName): boolean {
  if (!fn) return false
  try {
    return fn() === true
  } catch (e) {
    try {
      reportPredicateFailure(name, e)
    } catch { /* telemetry must not change the hold-off decision */ }
    return true
  }
}

/** Minimal callback interface so the indexer doesn't depend on the IMAP layer directly. */
export type FetchBodyFn = (
  accountId: number,
  folder: string,
  uid: number,
) => Promise<{ text?: string; html?: string } | null>

export type BodyIndexerOptions = {
  /** How many messages to index per folder, per tick (default: 200). */
  batchSize?: number
  /** Base interval between ticks in ms, used while there is work (default: 2 000). */
  intervalMs?: number
  /** Ceiling for the empty-tick backoff in ms (default: 2 min). */
  idleMaxIntervalMs?: number
  /**
   * Ceiling for the backoff while a backlog exists but nothing moved — i.e.
   * while folders are inside their own error backoff (default: 60 s).
   */
  retryMaxIntervalMs?: number
  /** Delay before the very first tick in ms (default: 5 000). */
  initialDelayMs?: number
  /** Minimum gap between `onProgress` stat recomputations in ms (default: 30 000). */
  statsIntervalMs?: number
  /** Callback to fetch body text from IMAP. */
  fetchBody: FetchBodyFn
  /**
   * Returns true when work-offline mode is active (skip indexing).
   * Omitted ⇒ the indexer never considers itself offline.
   * A throw is contained and read as "offline" — see `evalPredicate`.
   */
  isOffline?: () => boolean
  /**
   * Returns true when header sync is active (pause indexing to avoid IMAP
   * contention). Omitted ⇒ no pause handling: ticks keep running during header
   * sync, exactly as they did before this option existed. Skipped ticks are the
   * only ones that keep the base cadence for free, so a caller that omits this
   * relies entirely on `resetBodyIndexerBackoff()` for freshness.
   * A throw is contained and read as "paused" — see `evalPredicate`.
   */
  isPaused?: () => boolean
  /** Called with stats after each batch completes. */
  onProgress?: (stats: SearchIndexStats) => void
  /**
   * Consecutive per-UID fetch errors within one folder that put the folder
   * into its exponential error backoff (default: 3, minimum 1).
   */
  maxFolderRetries?: number
}

function htmlToPlainText(html: string): string {
  return (html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function getSearchableBodyText(details: { text?: string; html?: string }): string | null {
  const text = (details.text || '').trim()
  if (text) return text
  const html = (details.html || '').trim()
  if (!html) return null
  const plain = htmlToPlainText(html)
  return plain || null
}

// --- Per-folder error backoff ---

type FolderErrorState = { count: number; nextRetryAt: number }
const folderErrors = new Map<string, FolderErrorState>()

function folderKey(accountId: number, folder: string): string { return `${accountId}:${folder}` }

function shouldSkipFolder(accountId: number, folder: string): boolean {
  const state = folderErrors.get(folderKey(accountId, folder))
  if (!state) return false
  // Always respect backoff timer; once it expires, allow retry regardless of count
  return Date.now() < state.nextRetryAt
}

function recordFolderError(accountId: number, folder: string): void {
  const k = folderKey(accountId, folder)
  const prev = folderErrors.get(k)
  const count = (prev?.count ?? 0) + 1
  // Exponential backoff: 30s, 60s, 120s, 240s...
  const backoffMs = Math.min(30_000 * Math.pow(2, count - 1), 600_000)
  folderErrors.set(k, { count, nextRetryAt: Date.now() + backoffMs })
  recordEvent('body_indexer.folder_error', {
    folder_role: folderRoleFromPath(folder),
    error_streak: count,
    backoff_ms: backoffMs,
  })
}

function clearFolderError(accountId: number, folder: string): void {
  folderErrors.delete(folderKey(accountId, folder))
}

/** Reset all error state (for testing). */
export function resetBodyIndexerErrors(): void {
  folderErrors.clear()
}

// --- Folder priority ---

function folderSortPriority(folder: string): number {
  if (folder === 'INBOX') return 0
  const lower = folder.toLowerCase()
  if (lower.includes('sent')) return 1
  if (lower.includes('archive') || lower.includes('all mail')) return 2
  if (lower.includes('draft') || lower.includes('trash') || lower.includes('junk') || lower.includes('spam')) return 3
  return 10
}

function sortFoldersByPriority<T extends { folder: string }>(folders: T[]): T[] {
  return [...folders].sort((a, b) => folderSortPriority(a.folder) - folderSortPriority(b.folder))
}

/**
 * Hand the event loop back for one full turn. Called between folders so a pass
 * over a long work list is a sequence of short main-thread slices instead of
 * one uninterruptible block (§2.115 — the freezes were measured as event-loop
 * delay, so what matters is the length of a single slice, not the total).
 *
 * `setTimeout(0)` and not `setImmediate`: an immediate scheduled from the
 * continuation of an awaited immediate is picked up by the *same* check phase,
 * so a chain of them never lets the timers phase run — verified with a probe
 * while writing this (`folder0 → immediate → folder1 → …`, the pending timer
 * only fired after the whole loop). A timer forces the real turn.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

// --- Span helper ---
//
// startMetricSpan is a thin wrapper around Sentry.startInactiveSpan and may
// return undefined when tracing is off or sampled out. It does not itself
// swallow errors from span.end()/setAttributes() — we do that here so a
// broken telemetry pipeline can never turn a successful indexer batch into
// a failure. Mirrors the safety invariants in packages/net/telemetry.ts.
type SafeSpanHandle = {
  setAttributes(attrs: Record<string, string | number | boolean | undefined>): void
  end(): void
}

function safeStartBatchSpan(attrs: Record<string, string | number | boolean | undefined>): SafeSpanHandle {
  let raw: ReturnType<typeof startMetricSpan> | undefined
  try {
    raw = startMetricSpan('body_indexer.batch', attrs)
  } catch {
    raw = undefined
  }
  return {
    setAttributes(extra) {
      if (!raw) return
      try {
        const r = raw as unknown as {
          setAttributes?: (a: Record<string, unknown>) => void
          setAttribute?: (k: string, v: unknown) => void
        }
        if (typeof r.setAttributes === 'function') {
          r.setAttributes(extra)
        } else if (typeof r.setAttribute === 'function') {
          for (const [k, v] of Object.entries(extra)) {
            if (v !== undefined) r.setAttribute(k, v)
          }
        }
      } catch { /* telemetry must not throw */ }
    },
    end() {
      if (!raw) return
      try {
        (raw as unknown as { end?: () => void }).end?.()
      } catch { /* telemetry must not throw */ }
    },
  }
}

// --- State ---

const DEFAULT_INTERVAL_MS = 2_000
/**
 * Ceiling for the empty-tick backoff: 2s → 4 → 8 → 16 → 32 → 64 → 120, i.e.
 * the ceiling is reached after seven empty ticks (~4 min of idleness).
 *
 * Why two minutes and not longer: the ceiling is the worst-case delay before a
 * message that just arrived becomes searchable by body text. `main` shortens
 * the common case by calling `resetBodyIndexerBackoff()` after a sync that
 * fetched rows, but the ceiling still governs everything that appears without
 * such a call (a retried body, a folder that came back from error backoff, any
 * future writer that forgets the hint). Going from 2 s to 120 s already removes
 * 98% of the wake-ups; stretching it further buys a rounding error of
 * main-thread time (a tick at rest is one indexed query) and pays for it in how
 * stale search can be.
 */
const DEFAULT_IDLE_MAX_INTERVAL_MS = 2 * 60_000
const DEFAULT_INITIAL_DELAY_MS = 5_000
const DEFAULT_STATS_INTERVAL_MS = 30_000
/**
 * Ceiling for the backoff while the backlog is NOT empty but the tick still
 * moved nothing — typically every pending folder is inside its per-folder
 * error backoff (30 s … 10 min). Keeping this well under `idleMaxIntervalMs`
 * means recovery is paced by the folder backoff that owns the decision, not
 * by the idle curve, which knows nothing about it.
 */
const RETRY_MAX_INTERVAL_MS = 60_000
/** Consecutive per-UID fetch errors that put a folder into its error backoff. */
const DEFAULT_MAX_FOLDER_RETRIES = 3

let timer: ReturnType<typeof setTimeout> | null = null
/** Wall-clock deadline of the armed timer; 0 when nothing is armed. */
let timerDueAt = 0
let started = false
let running = false
/**
 * Incremented on every start. A tick that was already in flight when the
 * indexer was stopped resolves later and would otherwise re-arm the timer of a
 * generation that no longer exists (and, after a restart, run a second chain
 * next to the live one).
 */
let generation = 0
/** Delay used for the next tick; grows on empty ticks, snaps back on progress. */
let nextDelayMs = DEFAULT_INTERVAL_MS
let baseIntervalMs = DEFAULT_INTERVAL_MS
let lastStatsAt = 0
/**
 * Set by `resetBodyIndexerBackoff()`, cleared at the start of every tick.
 *
 * A reset can land *during* a tick — the usual shape is a sync that commits
 * rows a moment after this tick already asked the DB for work. Without this
 * flag the tick finishes "empty" and doubles off the value the reset just
 * wrote, so the hint decays to 2× base instead of being honoured.
 */
let resetRequested = false
/**
 * The live tick scheduler, published by `startBodyIndexer` so the exported
 * reset can re-arm the timer instead of only touching a variable.
 */
let scheduleTick: ((delayMs: number) => void) | null = null

/**
 * Bring the next tick forward to the base interval.
 *
 * This has to move the *timer*, not just the variable: by the time a reset
 * arrives the next tick is already armed with the backed-off delay, and a tick
 * recomputes `nextDelayMs` from its own outcome anyway. Assigning the variable
 * alone therefore changed nothing observable — work made visible right after a
 * reset was still fetched only when the already-armed ceiling timeout expired
 * (999 ms of a 1 000 ms ceiling in the report that found this, 246 ms of
 * whatever remained of it in the regression test). At production values that
 * is the ~2 min staleness this call exists to prevent.
 *
 * Hazards handled here:
 * - Reset during a tick: the in-flight tick re-arms in its own `finally`, so
 *   we only record the request (`resetRequested`) and let it schedule.
 * - Repeated resets in quick succession (main resets once per synced folder):
 *   an armed timer that is already due no later than "now + base" is left
 *   alone, so a burst of resets cannot keep pushing the deadline out.
 * - Stopped indexer: no-op, and never arms a timer that nothing would clear.
 *
 * Cheap and non-throwing by contract — callers invoke it from the tail of a
 * sync and must never fail because of a scheduling hint.
 */
export function resetBodyIndexerBackoff(): void {
  nextDelayMs = baseIntervalMs
  resetRequested = true
  if (!started || !scheduleTick) return
  // A tick is in flight; it re-arms itself when it finishes and will honour
  // resetRequested. Arming here too would leave two live timers.
  if (running) return
  const dueAtIfReset = Date.now() + baseIntervalMs
  if (timer !== null && timerDueAt <= dueAtIfReset) return
  scheduleTick(baseIntervalMs)
}

/** Current delay between ticks in ms (test/diagnostics accessor). */
export function getBodyIndexerDelayMs(): number {
  return nextDelayMs
}

export function startBodyIndexer(opts: BodyIndexerOptions): void {
  if (started) return
  // Larger batch + tighter interval: each fetch is sequential per UID and
  // dominated by IMAP RTT, so we want to push more through per tick.
  // Per-folder error backoff still protects against runaway when something
  // is wrong with a folder.
  const batchSize = opts.batchSize ?? 200
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const idleMaxIntervalMs = Math.max(intervalMs, opts.idleMaxIntervalMs ?? DEFAULT_IDLE_MAX_INTERVAL_MS)
  const retryMaxIntervalMs = Math.min(
    idleMaxIntervalMs,
    Math.max(intervalMs, opts.retryMaxIntervalMs ?? RETRY_MAX_INTERVAL_MS),
  )
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const statsIntervalMs = opts.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS
  // Clamped to a finite integer >= 1: zero would back a folder off before it
  // ever tried, and a non-finite value would make `consecutiveErr >= max`
  // permanently false, i.e. silently disable the backoff altogether.
  const maxFolderRetries = Number.isFinite(opts.maxFolderRetries)
    ? Math.max(1, Math.floor(opts.maxFolderRetries as number))
    : DEFAULT_MAX_FOLDER_RETRIES
  started = true
  const myGeneration = ++generation
  baseIntervalMs = intervalMs
  nextDelayMs = intervalMs
  lastStatsAt = 0

  /** True when this tick must not do IMAP work. Never throws — see `evalPredicate`. */
  function holdOff(): boolean {
    return evalPredicate(opts.isOffline, 'isOffline') || evalPredicate(opts.isPaused, 'isPaused')
  }

  async function tick() {
    if (running) return
    // `running` is claimed before ANY caller-supplied code runs, and everything
    // below is inside try/finally: whatever a predicate or a DB read does, the
    // tick settles and the scheduler re-arms. The hold-off path is fully
    // synchronous, so no reset can observe this transient `running = true`.
    running = true
    const tickStart = Date.now()
    try {
      if (holdOff()) {
        // "Not now", not "no work" — keep the base cadence so indexing resumes
        // as soon as the pause lifts. Only reachable when the caller supplies
        // isOffline/isPaused; see the note on both options.
        nextDelayMs = intervalMs
        return
      }
      // Anything that arrives from here on is news this tick may not see.
      resetRequested = false
      // Start from the backlog, not from the folder list: on a fully indexed
      // mailbox this returns an empty array from a partial index, so the whole
      // "is there anything to do?" question costs one cheap query.
      const folders = sortFoldersByPriority(listFoldersWithPendingBodies())
      let indexed = 0
      // Rows that left the pending set this tick, including bodies stored as
      // '' (no text parts). Used for scheduling — `indexed` keeps its original
      // meaning for the metric, which counts bodies with actual content.
      let processed = 0
      for (const { accountId, folder } of folders) {
        if (holdOff()) break
        await yieldToEventLoop()

        // Skip folders with too many consecutive errors
        if (shouldSkipFolder(accountId, folder)) continue

        const uids = getUidsWithoutBodyText(accountId, folder, batchSize)
        if (uids.length === 0) continue

        // Process UIDs in small parallel groups. Each fetchBody uses the
        // per-account IMAP pool (MAX_CONNECTIONS_PER_ACCOUNT=3); we keep
        // CONCURRENCY=2 so other tasks (header sync, manual open) can still
        // grab a slot without queueing 30s for one. A single transient error
        // is no longer a fatal stop for the folder — we count consecutive
        // failures and only back off when the whole batch is dead.
        const CONCURRENCY = 2
        let consecutiveErr = 0
        let folderErr = false
        // Track success on THIS folder only — clearing the folder's error
        // state must not depend on `indexed` (which accumulates across all
        // folders in the tick), otherwise an earlier successful folder would
        // mask a still-broken one and short-circuit its exponential backoff.
        let folderSuccess = 0
        let folderFailed = 0
        // Open a span around this folder's batch processing. Attributes
        // known upfront (folder_role) go at open; counters (fetched_ok,
        // failed, batch_size_bucket) are set on end because they are only
        // known after the inner loop completes. Telemetry is wrapped in
        // safeStartBatchSpan so a broken pipeline cannot fail the batch.
        const batchSpan = safeStartBatchSpan({
          folder_role: folderRoleFromPath(folder),
        })
        try {
          for (let i = 0; i < uids.length && !folderErr; i += CONCURRENCY) {
            if (holdOff()) break
            const slice = uids.slice(i, i + CONCURRENCY)
            const results = await Promise.allSettled(slice.map(uid => opts.fetchBody(accountId, folder, uid)))
            for (let j = 0; j < results.length; j++) {
              const uid = slice[j]!
              const r = results[j]!
              if (r.status === 'rejected') {
                const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
                log.debug(`fetchBody ${accountId}/${folder}/${uid}: ${reason}`)
                consecutiveErr++
                folderFailed++
                if (consecutiveErr >= maxFolderRetries) {
                  log.warn(`Body indexer skipping ${accountId}/${folder} after ${consecutiveErr} errors (last: ${reason})`)
                  recordFolderError(accountId, folder)
                  folderErr = true
                  break
                }
                continue
              }
              consecutiveErr = 0
              folderSuccess++
              const body = r.value
              if (!body) {
                updateMessageBodyText(accountId, folder, uid, '')
                processed++
                continue
              }
              const text = getSearchableBodyText(body)
              updateMessageBodyText(accountId, folder, uid, text ?? '')
              processed++
              indexed++
            }
          }
        } finally {
          batchSpan.setAttributes({
            batch_size_bucket: bucketBatchSize(uids.length),
            fetched_ok_bucket: bucketCount(folderSuccess),
            failed_bucket: bucketCount(folderFailed),
          })
          batchSpan.end()
        }
        // Only clear backoff if THIS folder fetched something successfully.
        // Empty-body folders (all '') still count — the fetches succeeded.
        if (!folderErr && folderSuccess > 0) clearFolderError(accountId, folder)
      }
      // Adaptive schedule. Progress → base interval. No progress → double the
      // delay, capped by how much we still know about the backlog: an empty
      // backlog may be idle for minutes, a non-empty one is waiting on a
      // per-folder error backoff and should be revisited sooner.
      //
      // `resetRequested` counts as progress: a reset that landed while this
      // tick was running means work appeared after we asked the DB, so this
      // tick's "empty" verdict is stale. Without the flag the delay would
      // double off the reset value (2× base rather than the ceiling — the
      // reset already lowered `nextDelayMs`), which is small but still the
      // wrong direction on the one tick that knows new work exists.
      if (processed > 0 || resetRequested) {
        nextDelayMs = intervalMs
      } else {
        const cap = folders.length > 0 ? retryMaxIntervalMs : idleMaxIntervalMs
        nextDelayMs = Math.min(Math.max(nextDelayMs * 2, intervalMs), cap)
      }

      const tickMs = Date.now() - tickStart
      if (indexed > 0) {
        log.info(`Indexed ${indexed} bodies in ${tickMs}ms`)
      }
      // Always record tick outcome — zero-work ticks matter for analytics
      // (tells us whether the backlog is drained or the indexer is stuck).
      //
      // §2.115: `folders_scanned` now counts folders that still have pending
      // bodies, not every indexable folder. The old number described the cost
      // of the tick (a probe per folder); the new one describes the remaining
      // work, which is what the tick actually walks.
      recordHistogram('body_indexer.tick.duration_ms', tickMs, {
        indexed,
        folders_scanned: folders.length,
      })
      // Stats are a full-corpus aggregation, so they are recomputed when they
      // can have changed (something was indexed) or, for onProgress consumers,
      // at most once per statsIntervalMs — never once per tick.
      const statsDue = opts.onProgress !== undefined && tickStart - lastStatsAt >= statsIntervalMs
      if (indexed > 0 || statsDue) {
        lastStatsAt = tickStart
        // Coverage is reported over ALL indexable accounts, not just those
        // with a backlog — otherwise the denominator would shrink to the
        // accounts that happen to be behind and coverage_pct would be a lie.
        const allAccountIds = [...new Set(listIndexedFolders().map(f => f.accountId))]
        const stats = getSearchIndexStats(allAccountIds)
        if (opts.onProgress) opts.onProgress(stats)
        // Coverage gauge — tells us at-a-glance how much of the corpus is
        // searchable by body text. Account id is non-PII (just an integer).
        if (stats.totalMessages > 0) {
          const pct = Math.round((stats.bodyIndexed / stats.totalMessages) * 100)
          recordGauge('body_indexer.coverage_pct', pct, {
            total_messages: stats.totalMessages,
            indexed_messages: stats.bodyIndexed,
          })
          recordGauge('body_indexer.backlog', stats.totalMessages - stats.bodyIndexed)
        }
      }
    } catch (e) {
      log.error('Body indexer tick error:', e)
      captureOnce(errorKey(e), e, { source: 'bodyIndexer' })
    } finally {
      running = false
    }
  }

  // Self-scheduling timer instead of setInterval: the delay for the next tick
  // is a function of what this tick found, which a fixed interval cannot
  // express. It also removes the pile-up risk of setInterval firing while a
  // slow tick is still awaiting IMAP.
  //
  // Single-owner by construction: every arming path goes through here and
  // clears whatever was armed first, so a reset racing with the tail of a tick
  // can never leave two timers (or an orphan that nothing clears).
  function scheduleNext(delayMs: number): void {
    if (!started || generation !== myGeneration) return
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    timerDueAt = Date.now() + delayMs
    timer = setTimeout(() => {
      timer = null
      timerDueAt = 0
      void tick().finally(() => { scheduleNext(nextDelayMs) })
    }, delayMs)
  }

  scheduleTick = scheduleNext
  scheduleNext(initialDelayMs)
  log.info(
    `Body indexer started (batch=${batchSize}, interval=${intervalMs}ms, idleMax=${idleMaxIntervalMs}ms, maxFolderRetries=${maxFolderRetries})`,
  )
}

export function stopBodyIndexer(): void {
  const wasStarted = started
  started = false
  scheduleTick = null
  resetRequested = false
  timerDueAt = 0
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (wasStarted) log.info('Body indexer stopped')
}

/**
 * Wait for any in-flight tick to complete. Used during shutdown to make sure
 * an awaited IMAP fetch does not race against PRAGMA wal_checkpoint(TRUNCATE).
 *
 * `stopBodyIndexer()` only clears the pending timer; a tick that is already
 * past the `running = true` barrier can still be awaiting fetchBody()
 * (IMAP RTT), and its subsequent `updateMessageBodyText()` write would land
 * AFTER the checkpoint — re-growing the WAL with frames that the truncate
 * just reclaimed. This is the exact failure mode §2.15 targets.
 *
 * Polls `running` flag every 50ms up to `timeoutMs`. Returns true if the
 * indexer idled cleanly before the deadline, false if the timeout hit
 * (caller should log and continue — shutdown must not hang).
 */
export async function waitForIdle(timeoutMs = 3_000): Promise<boolean> {
  const start = Date.now()
  while (running) {
    if (Date.now() - start >= timeoutMs) return false
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  return true
}

/** Get current search index completeness stats. */
export function getIndexStats(accountIds: number[]): SearchIndexStats {
  return getSearchIndexStats(accountIds)
}
