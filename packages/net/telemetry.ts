/**
 * Minimal telemetry seam for packages/net.
 *
 * Why a seam and not a direct import from `electron/metrics`:
 * - packages/net is layer-pure: it must not pull Sentry / electron-log /
 *   electron-store into its import graph. Tests in packages/net (and any
 *   future worker or CLI consumer) instantiate this module without an
 *   Electron runtime, so the default sink has to be a zero-dep no-op.
 * - The main process wires a real sink at startup via setNetTelemetrySink(),
 *   passing in `startMetricSpan` from electron/metrics.ts. When no sink is
 *   installed (tests, first moments of boot) we return a no-op handle.
 *
 * Contract for callers inside packages/net:
 * - Use withNetSpan(name, attrs, fn). It never throws from the telemetry
 *   path: if the sink, span.end(), or setAttribute throws, we swallow it
 *   and still run/await fn(). Telemetry must be strictly fire-and-forget
 *   and MUST NOT turn a successful IMAP sync or SMTP send into a failure.
 * - Attributes are expected to be pre-bucketed by the caller via
 *   metricsBuckets helpers — this module does not format values.
 */

export type NetSpanAttributeValue = string | number | boolean | undefined

export type NetSpanAttributes = Record<string, NetSpanAttributeValue>

/** Minimal structural shape of the span object we need. Matches Sentry's
 *  startInactiveSpan return plus an optional setAttribute, which is what
 *  `startMetricSpan` hands back today. We only rely on `end()`. */
export interface NetSpanHandle {
  end(): void
  setAttribute?(key: string, value: NetSpanAttributeValue): void
  setAttributes?(attrs: NetSpanAttributes): void
}

export type NetSpanStarter = (
  name: string,
  attributes: NetSpanAttributes,
) => NetSpanHandle

const NOOP_SPAN: NetSpanHandle = {
  end() { /* noop */ },
}

function defaultStarter(): NetSpanHandle {
  return NOOP_SPAN
}

let spanStarter: NetSpanStarter = defaultStarter

export type NetErrorReporter = (
  source: string,
  err: unknown,
  context?: NetSpanAttributes,
) => void

const defaultErrorReporter: NetErrorReporter = () => { /* noop */ }
let errorReporter: NetErrorReporter = defaultErrorReporter

/**
 * Discrete event reporter: a separate sink for typed, non-span events
 * emitted from packages/net (e.g. auth refresh cooldown suppressions).
 * Mirrors the telemetry/error seam pattern: default is a no-op, main.ts
 * wires the real recordEvent implementation at boot.
 *
 * The `tags` value space is deliberately narrow — strings/numbers/booleans
 * only — and validated against metricsSchema.ts by the main-side wrapper.
 */
export type NetEventTagValue = string | number | boolean
export type NetEventReporter = (
  name: string,
  tags: Record<string, NetEventTagValue>,
) => void

const defaultEventReporter: NetEventReporter = () => { /* noop */ }
let eventReporter: NetEventReporter = defaultEventReporter

/**
 * Wire the real span starter from the main process. Call this once during
 * electron/main.ts bootstrap. Passing `null` resets back to the no-op sink
 * (used by tests that want to assert the uninstrumented path).
 */
export function setNetTelemetrySink(starter: NetSpanStarter | null): void {
  spanStarter = starter ?? defaultStarter
}

/**
 * Wire an error reporter (typically electron/sentry.ts captureException).
 * Called by withNetSpan on fn() rejections with a stable `source` tag like
 * 'imap.sync' or 'smtp.send'. Passing null resets to the no-op reporter.
 */
export function setNetErrorReporter(reporter: NetErrorReporter | null): void {
  errorReporter = reporter ?? defaultErrorReporter
}

/** Wire the real event reporter (typically a thin adapter over
 *  electron/metrics.ts recordEvent). Passing null restores the no-op sink. */
export function setNetEventReporter(reporter: NetEventReporter | null): void {
  eventReporter = reporter ?? defaultEventReporter
}

function safeReport(source: string, err: unknown, context?: NetSpanAttributes): void {
  try { errorReporter(source, err, context) } catch { /* telemetry must not throw */ }
}

function safeReportEvent(name: string, tags: Record<string, NetEventTagValue>): void {
  try { eventReporter(name, tags) } catch { /* telemetry must not throw */ }
}

/** Public helper so imperative code (the IDLE loop) can report expected
 *  failure modes without wrapping the whole lifecycle in withNetSpan. Safe
 *  to call with no sink installed. */
export function reportNetError(source: string, err: unknown, context?: NetSpanAttributes): void {
  safeReport(source, err, context)
}

/** Public helper for typed, low-cardinality discrete events emitted from
 *  packages/net (e.g. auth refresh cooldown suppression). Safe to call
 *  with no sink installed — the default reporter is a silent no-op. */
export function reportNetEvent(name: string, tags: Record<string, NetEventTagValue>): void {
  safeReportEvent(name, tags)
}

function safeStart(name: string, attributes: NetSpanAttributes): NetSpanHandle {
  try {
    const handle = spanStarter(name, attributes)
    if (handle && typeof handle.end === 'function') return handle
    return NOOP_SPAN
  } catch {
    // A broken telemetry pipeline must never propagate into mail-sync or
    // SMTP send. Degrade silently to the no-op handle.
    return NOOP_SPAN
  }
}

function safeEnd(handle: NetSpanHandle): void {
  try { handle.end() } catch { /* telemetry must not throw */ }
}

function safeSetAttributes(handle: NetSpanHandle, attrs: NetSpanAttributes): void {
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
 * Run `fn` inside a network-layer span. Guarantees:
 *  - fn() is invoked exactly once, even if span creation throws.
 *  - span.end() is called on both success and error paths.
 *  - Errors from fn() propagate unchanged to the caller.
 *  - Errors from telemetry itself are swallowed.
 *
 * The `finalize` callback, when provided, lets the caller attach extra
 * attributes discovered during fn() (counts, exit reason) before end().
 * Its return value is merged into the span; failures inside finalize are
 * isolated from fn()'s return value.
 */
export async function withNetSpan<T>(
  name: string,
  attributes: NetSpanAttributes,
  fn: () => Promise<T>,
  finalize?: (result: { ok: true; value: T } | { ok: false; error: unknown }) => NetSpanAttributes | void,
): Promise<T> {
  const handle = safeStart(name, attributes)
  try {
    const value = await fn()
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

/** Synchronous-friendly helper for the imperative IDLE loop.
 *  Returns the handle so the caller can set attributes across a long-lived
 *  IDLE cycle and end() it at exit. The returned object is always safe to
 *  call, even when no sink is installed. */
export function startNetSpan(name: string, attributes: NetSpanAttributes): NetSpanHandle {
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
export function __getNetTelemetrySinkForTest(): NetSpanStarter {
  return spanStarter
}
