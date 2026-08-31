/**
 * Minimal telemetry seam for packages/db.
 *
 * Why a seam and not a direct import from `electron/metrics`:
 * - packages/db is layer-pure: it must not pull Sentry / electron-log /
 *   electron-store into its import graph. Tests in packages/db (and any
 *   future worker or CLI consumer) instantiate this module without an
 *   Electron runtime, so the default sink has to be zero-dep.
 * - The main process wires a real sink at startup via setDbTelemetrySink(),
 *   passing in `startMetricSpan` from electron/metrics.ts. Until it does, the
 *   default SPAN sink buffers (bounded) rather than discards — but ONLY while
 *   the injected consent gate says collection is allowed. Closed gate, or no
 *   gate at all, means nothing is retained. See `mayCollect` below.
 * - Error reports raised before a reporter exists are NOT retained; they are
 *   dropped on the spot. See reportDbError for why that is the honest shape.
 *
 * Contract for callers inside packages/db:
 * - Use withDbSpan(name, attrs, fn). It never throws from the telemetry
 *   path: if the sink, span.end(), or setAttribute throws, we swallow it
 *   and still run fn(). Telemetry must be strictly fire-and-forget and
 *   MUST NOT turn a successful DB operation into a failure.
 * - Attributes are expected to be pre-bucketed by the caller via the
 *   shared helpers in electron/metricsBuckets.ts (which is pure and safe
 *   to import from packages/*). This module does not format values.
 *
 * Mirrors packages/net/telemetry.ts intentionally — same shape, same
 * invariants, same test surface. Keep the two modules structurally
 * similar so a change to the seam contract can be mirrored mechanically.
 */

export type DbSpanAttributeValue = string | number | boolean | undefined

export type DbSpanAttributes = Record<string, DbSpanAttributeValue>

/** Minimal structural shape of the span object we need. Matches Sentry's
 *  startInactiveSpan return plus an optional setAttribute, which is what
 *  `startMetricSpan` hands back today. We only rely on `end()`. */
export interface DbSpanHandle {
  end(): void
  setAttribute?(key: string, value: DbSpanAttributeValue): void
  setAttributes?(attrs: DbSpanAttributes): void
}

export type DbSpanStarter = (
  name: string,
  attributes: DbSpanAttributes,
) => DbSpanHandle

const NOOP_SPAN: DbSpanHandle = {
  end() { /* noop */ },
}

/**
 * Consent gate (§2.82) — INJECTED, never imported: the gate lives in
 * electron/telemetryGate.ts and packages/db must not look at electron.
 *
 * Closed by default, and "no gate installed" IS closed. docs/docs/privacy/
 * telemetry.md promises that nothing is COLLECTED before the user answers —
 * "MailCopilot does not quietly accumulate a backlog and flush it once you
 * allow it" — which is exactly what a buffer that fills while the answer is
 * pending and replays on sink installation would be.
 *
 * Consequence, stated rather than hidden: main.ts installs the gate only
 * AFTER its hoisted imports finish, and packages/db migrates DURING them, so
 * at cold start there is no gate, the span buffer stays empty, and anything
 * an import-time migration would have reported is lost for every user —
 * consenting or not. That is the promise ("whatever happened before you
 * answered is simply gone"), not an accident; capturing cold start honestly
 * needs the two-stage bootstrap main.ts already names, not a wider buffer.
 */
export type DbTelemetryCollectionGate = () => boolean
let collectionGate: DbTelemetryCollectionGate | null = null

function mayCollect(): boolean {
  if (!collectionGate) return false
  try { return collectionGate() === true } catch { return false }
}

/** Install the consent gate. Passing null returns to the fail-closed default. */
export function setDbTelemetryCollectionGate(gate: DbTelemetryCollectionGate | null): void {
  collectionGate = gate
  if (!mayCollect()) resetDbTelemetryBuffer()
}

/**
 * Drop everything retained so far. Wired to the gate's transition hook in
 * main.ts: BOTH directions must leave nothing behind — off→on may not ship
 * what predates the answer, on→off may not leave a backlog for a later
 * re-opt-in to flush.
 *
 * Singular because the span buffer is the only thing this seam retains;
 * error reports are dropped rather than held (see reportDbError).
 */
export function resetDbTelemetryBuffer(): void {
  spanBuffer.length = 0
}

/**
 * Bounded ring buffer for spans recorded BEFORE a real sink is installed.
 *
 * Why this exists:
 *   packages/db/index.ts opens SQLite and runs schema migrations at ES
 *   module *import* time. Static imports are hoisted, so by the time
 *   electron/main.ts gets to its imperative `setDbTelemetrySink(...)` call,
 *   the cold-start migration round and the very first DB ops have already
 *   run through the default sink. A pure no-op default would silently drop
 *   that telemetry on every cold start (and forever on the first run after
 *   install, when migrations are heaviest).
 *
 * What we record:
 *   Completed spans only — `(name, attributes, startMs, endMs, finalAttrs)`.
 *   We do not buffer "open" spans because there is nothing to do with one
 *   whose `end()` has not been called yet.
 *
 * Consent:
 *   Nothing is retained unless the injected gate above allows collection —
 *   see `mayCollect`. With today's bootstrap ordering that means the
 *   cold-start capture described here does not actually happen; the buffer
 *   only carries spans recorded between the gate being armed and the sink
 *   being installed.
 *
 * Capacity:
 *   Bounded at BUFFER_CAP. If the buffer fills before a real sink is
 *   installed (e.g. someone wires the seam without installing a sink at
 *   all, or installs it very late), oldest entries are dropped silently.
 *   The cap protects against unbounded growth — telemetry MUST NOT leak
 *   memory.
 *
 * Replay timing caveat:
 *   Sentry spans take their start timestamp from when the starter is
 *   invoked. Replaying buffered spans against the real sink at drain time
 *   means the resulting Sentry spans have wall-clock timestamps from the
 *   drain moment, not from when the original DB op ran. We accept that
 *   tradeoff: the alternative (no telemetry at all for cold start) is
 *   worse for the operational question this seam is meant to answer
 *   (which DB ops are slow / failing). Original durations are preserved
 *   in the attributes via `buffered_duration_ms` and `buffered=true` so
 *   downstream queries can distinguish replayed spans from live ones.
 */
const BUFFER_CAP = 256

interface BufferedSpan {
  name: string
  attrs: DbSpanAttributes
  startMs: number
  endMs: number
  extras: DbSpanAttributes | null
}

const spanBuffer: BufferedSpan[] = []

function pushBuffered(entry: BufferedSpan): void {
  if (!mayCollect()) return
  if (spanBuffer.length >= BUFFER_CAP) {
    spanBuffer.shift()
  }
  spanBuffer.push(entry)
}

function nowMs(): number {
  try { return Date.now() } catch { return 0 }
}

function bufferingStarter(name: string, attrs: DbSpanAttributes): DbSpanHandle {
  const startMs = nowMs()
  let ended = false
  let extras: DbSpanAttributes | null = null
  return {
    end() {
      if (ended) return
      ended = true
      pushBuffered({ name, attrs, startMs, endMs: nowMs(), extras })
    },
    setAttribute(key, value) {
      if (value === undefined) return
      if (!extras) extras = {}
      extras[key] = value
    },
    setAttributes(next) {
      if (!next) return
      if (!extras) extras = {}
      for (const [k, v] of Object.entries(next)) {
        if (v !== undefined) extras[k] = v
      }
    },
  }
}

let spanStarter: DbSpanStarter = bufferingStarter

export type DbErrorReporter = (
  source: string,
  err: unknown,
  context?: DbSpanAttributes,
) => void

const defaultErrorReporter: DbErrorReporter = () => { /* noop */ }
let errorReporter: DbErrorReporter = defaultErrorReporter

/**
 * Typed discrete-event reporter for packages/db. Mirrors reportNetEvent
 * from packages/net so low-cardinality counters like `db.mass_delete_messages`
 * can be emitted from layer-pure db code without importing electron/metrics.
 *
 * The reporter is wired from electron/main.ts via `setDbEventReporter` —
 * main.ts maps the name to `recordEvent(...)`. Default is a silent no-op,
 * which keeps tests and cold-start safe. Like the rest of this seam, failures
 * in the reporter are swallowed and MUST NOT propagate into DB operations.
 */
export type DbEventTagValue = string | number | boolean | undefined
export type DbEventReporter = (
  name: string,
  tags: Record<string, DbEventTagValue>,
) => void

const defaultEventReporter: DbEventReporter = () => { /* noop */ }
let eventReporter: DbEventReporter = defaultEventReporter

/**
 * Wire the real span starter from the main process. Call this once during
 * electron/main.ts bootstrap. Passing `null` resets back to the buffering
 * default sink (used by tests that want to assert the uninstrumented
 * path; pass `() => ({ end() {} })` for a true no-op).
 *
 * On install, any spans that were buffered before the sink was wired are
 * drained into the new starter on a best-effort basis. A throwing replay
 * MUST NOT propagate into the caller — drain is fire-and-forget like the
 * rest of this seam. Buffer is cleared regardless of replay success so
 * the second install (e.g. test reset) starts fresh.
 */
export function setDbTelemetrySink(starter: DbSpanStarter | null): void {
  spanStarter = starter ?? bufferingStarter
  if (starter && spanBuffer.length > 0) {
    drainBufferTo(starter)
  }
}

function drainBufferTo(starter: DbSpanStarter): void {
  // Snapshot + clear FIRST so that a re-entrant call (real sink synchronously
  // calling back into withDbSpan) cannot double-drain the same entries.
  const snapshot = spanBuffer.splice(0, spanBuffer.length)
  for (const entry of snapshot) {
    try {
      const replayAttrs: DbSpanAttributes = {
        ...entry.attrs,
        buffered: true,
        buffered_duration_ms: Math.max(0, entry.endMs - entry.startMs),
      }
      const handle = starter(entry.name, replayAttrs)
      if (!handle || typeof handle.end !== 'function') continue
      if (entry.extras) {
        try {
          if (typeof handle.setAttributes === 'function') {
            handle.setAttributes(entry.extras)
          } else if (typeof handle.setAttribute === 'function') {
            for (const [k, v] of Object.entries(entry.extras)) {
              if (v !== undefined) handle.setAttribute(k, v)
            }
          }
        } catch { /* telemetry must not throw */ }
      }
      try { handle.end() } catch { /* telemetry must not throw */ }
    } catch {
      // A broken replay must not break sink installation or DB operations.
    }
  }
}

/** Test-only: peek the buffer length. */
export function __getDbTelemetryBufferSizeForTest(): number {
  return spanBuffer.length
}

/**
 * Wire an error reporter (typically electron/sentry.ts captureException).
 * Called by withDbSpan on fn() throws with a stable `source` tag like
 * 'db.upsert_messages'. Passing null returns to the silent default.
 *
 * There is nothing to replay on installation: reports raised before this
 * runs were dropped, not held — see reportDbError.
 */
export function setDbErrorReporter(reporter: DbErrorReporter | null): void {
  errorReporter = reporter ?? defaultErrorReporter
}

function safeReport(source: string, err: unknown, context?: DbSpanAttributes): void {
  // Before installation `errorReporter` is the no-op default, so this is the
  // silent drop described on reportDbError — deliberate, not an oversight.
  try { errorReporter(source, err, context) } catch { /* telemetry must not throw */ }
}

function safeReportEvent(name: string, tags: Record<string, DbEventTagValue>): void {
  try { eventReporter(name, tags) } catch { /* telemetry must not throw */ }
}

/**
 * Public helper for reporting a DB-layer defect that does NOT throw — the
 * caller handled it (skipped a row, purged a row) and continues, but the
 * occurrence still has to reach Sentry or it stays invisible forever.
 *
 * `withDbSpan` already reports throws; this is the seam for the swallowed
 * ones. Same fire-and-forget contract: never throws.
 *
 * Before main.ts installs a reporter this call DOES NOTHING AT ALL — the
 * report is dropped on the spot, nothing is held for later replay. That is
 * the promise on docs/docs/privacy/telemetry.md ("whatever happened before
 * you answered is simply gone"), and a buffer here would have been dead
 * telemetry: the reports worth catching are raised at import time, the
 * consent gate is only armed by a later statement in main.ts, and retention
 * without an open gate is exactly what §2.82 forbids — so such a buffer
 * could never hold anything, for a consenting user either. Reaching
 * import-time failures needs the two-stage bootstrap (§ backlog).
 *
 * Context discipline is the CALLER's: only aggregates (counters, buckets)
 * belong here. Subjects, addresses, folder names and server text must not
 * be passed in — see CLAUDE.md §8 "PII не уходит".
 */
export function reportDbError(source: string, err: unknown, context?: DbSpanAttributes): void {
  safeReport(source, err, context)
}

/** Public helper for discrete, low-cardinality events emitted from packages/db
 *  (e.g. db.mass_delete_messages). Safe to call with no sink installed — the
 *  default reporter is a silent no-op. */
export function reportDbEvent(name: string, tags: Record<string, DbEventTagValue>): void {
  safeReportEvent(name, tags)
}

/**
 * Wire the typed-event reporter. Called once from electron/main.ts bootstrap
 * with a function that maps (name, tags) onto the typed `recordEvent(...)`.
 * Passing null resets to the silent default reporter.
 */
export function setDbEventReporter(reporter: DbEventReporter | null): void {
  eventReporter = reporter ?? defaultEventReporter
}

function safeStart(name: string, attributes: DbSpanAttributes): DbSpanHandle {
  try {
    const handle = spanStarter(name, attributes)
    if (handle && typeof handle.end === 'function') return handle
    return NOOP_SPAN
  } catch {
    // A broken telemetry pipeline must never propagate into DB operations.
    return NOOP_SPAN
  }
}

function safeEnd(handle: DbSpanHandle): void {
  try { handle.end() } catch { /* telemetry must not throw */ }
}

function safeSetAttributes(handle: DbSpanHandle, attrs: DbSpanAttributes): void {
  if (!attrs) return
  try {
    if (typeof handle.setAttributes === 'function') {
      handle.setAttributes(attrs)
      return
    }
    if (typeof handle.setAttribute === 'function') {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined) handle.setAttribute(k, v)
      }
    }
  } catch { /* telemetry must not throw */ }
}

/**
 * Run a synchronous `fn` inside a DB-layer span. Guarantees:
 *  - fn() is invoked exactly once, even if span creation throws.
 *  - span.end() is called on both success and throw paths.
 *  - Errors from fn() propagate unchanged to the caller.
 *  - Errors from telemetry itself are swallowed.
 *
 * Synchronous-only on purpose: the three batch hot-paths in packages/db
 * (upsert_messages, reconcile_uids, search_messages) run inside
 * better-sqlite3 transactions which are strictly synchronous. Wrapping
 * them in an async span would subtly change error ordering.
 *
 * The `finalize` callback, when provided, lets the caller attach extra
 * attributes discovered during fn() (row counts, result counts) before
 * end(). Its return value is merged into the span; failures inside
 * finalize are isolated from fn()'s return value.
 */
export function withDbSpan<T>(
  name: string,
  attributes: DbSpanAttributes,
  fn: () => T,
  finalize?: (result: { ok: true; value: T } | { ok: false; error: unknown }) => DbSpanAttributes | void,
): T {
  const handle = safeStart(name, attributes)
  try {
    const value = fn()
    if (finalize) {
      try {
        const extra = finalize({ ok: true, value })
        if (extra) safeSetAttributes(handle, extra)
      } catch { /* telemetry must not throw */ }
    }
    return value
  } catch (err) {
    if (finalize) {
      try {
        const extra = finalize({ ok: false, error: err })
        if (extra) safeSetAttributes(handle, extra)
      } catch { /* telemetry must not throw */ }
    }
    safeReport(name, err, attributes)
    throw err
  } finally {
    safeEnd(handle)
  }
}

/** Synchronous-friendly helper that returns the handle directly, for rare
 *  cases where the caller needs to set attributes across non-trivial control
 *  flow. The returned object is always safe to call, even when no sink is
 *  installed. */
export function startDbSpan(name: string, attributes: DbSpanAttributes): DbSpanHandle {
  const handle = safeStart(name, attributes)
  return {
    end: () => safeEnd(handle),
    setAttribute: (k, v) => {
      try { handle.setAttribute?.(k, v) } catch { /* ignore */ }
    },
    setAttributes: (attrs) => safeSetAttributes(handle, attrs),
  }
}

/** Test-only: snapshot the current sink so tests can swap and restore. */
export function __getDbTelemetrySinkForTest(): DbSpanStarter {
  return spanStarter
}
