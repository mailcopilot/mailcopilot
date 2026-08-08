/**
 * Metrics pipeline for product analytics & performance monitoring.
 *
 * Routes every event through two sinks:
 *   - Sentry structured logs (`sentryLogger.info`) — prod dashboards + alerts
 *   - electron-log file sink (`createLogger('Metrics')`) — always-on locally
 *     so metrics are visible in main.log even when Sentry is disabled.
 *
 * Typed over the registry in metricsSchema.ts: the metric name, its kind
 * (event / histogram / gauge), and the set of allowed tag keys are all
 * enforced at compile time. Adding an event without registering it first
 * is a TypeScript error; doing the same in a runtime string would be caught
 * by scripts/check-telemetry-schema.mjs in CI.
 *
 * Consent (§2.82): every sink and every buffer in this module is gated on
 * `isTelemetryCollectionAllowed()` from electron/telemetryGate.ts. The gate
 * stops COLLECTION, not just transmission — aggregate buckets are never opened
 * while it is off, and a consent transition drops the ones that exist. The
 * local electron-log line is the one thing that keeps flowing: it never leaves
 * the machine.
 *
 * Privacy rules — if you break these, it's a security bug:
 *   - NEVER emit query text, email addresses, folder paths, subjects, UIDs,
 *     or any content. Only structural fields.
 *   - Account identity, if needed, must be an integer id — never the email.
 *   - Install identity is a hashed UUID; keep the `install_id_hash` TAG on the
 *     session events only. It is NOT an unlinkability guarantee — the same
 *     hash is the Sentry `user.id` and therefore rides on everything (see
 *     electron/installId.ts).
 */

import { sentryLogger, startInactiveSpan } from './sentry'
import { createLogger } from './logger'
import {
  METRIC_EVENTS,
  METRIC_SPAN_OP,
  type MetricName,
  type MetricNamesOfKind,
  type MetricSpanName,
  type TagValue,
} from './metricsSchema'
import { markFeatureReachFromEvent } from './featureReach'
import { isTelemetryCollectionAllowed, registerTelemetryCollectionResetHook } from './telemetryGate'

const logMetrics = createLogger('Metrics')

/**
 * §2.82 — the Sentry sink is consent-gated at the source.
 *
 * The local electron-log line is NOT gated: it never leaves the machine (and
 * in packaged builds it is written only when the user turned debug logging on
 * themselves), and losing it would take local diagnosability away from exactly
 * the users who declined telemetry. What the gate stops is the transmitting
 * sink and, more importantly, everything that ACCUMULATES for later
 * transmission — see telemetryGate.ts.
 */
function emit(name: string, payload: Record<string, string | number | boolean>, localLine: string): void {
  if (isTelemetryCollectionAllowed()) {
    try { sentryLogger.info(name, payload) } catch { /* Sentry not ready */ }
  }
  try { logMetrics.info(localLine, Object.keys(payload).length > 0 ? payload : '') } catch { /* ignore */ }
}

type TagsInput = Record<string, TagValue>

function cleanTags(tags?: TagsInput): Record<string, string | number | boolean> {
  if (!tags) return {}
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(tags)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

function definitionFor(name: MetricName) {
  return METRIC_EVENTS[name]
}

// --- Aggregator -------------------------------------------------------------
//
// High-volume histogram events (ipc.slow_ms, ui.freeze.*) can fire dozens
// of times per minute during a rough session. Instead of pushing each
// sample as a separate Sentry log, buffer them in a 10s window keyed by
// (name + serialized tags) and emit one summary record with count / sum /
// min / max / p50 / p95 per window. Counter-style `event` kinds increment a
// simple count; `gauge` is never buffered (they're inherently snapshots).

const AGGREGATE_WINDOW_MS = 10_000

type Bucket = {
  kind: 'histogram' | 'event'
  samples: number[]
  count: number
  sum: number
  min: number
  max: number
  tags: Record<string, string | number | boolean>
  name: MetricName
}

const aggregateBuckets = new Map<string, Bucket>()
let aggregateTimer: ReturnType<typeof setInterval> | null = null

function bucketKey(name: string, tags: Record<string, string | number | boolean>): string {
  const entries = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b))
  return name + '\x00' + entries.map(([k, v]) => `${k}=${v}`).join('|')
}

function ensureAggregator() {
  if (aggregateTimer) return
  aggregateTimer = setInterval(flushAggregator, AGGREGATE_WINDOW_MS)
  aggregateTimer.unref?.()
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]!
}

export function flushAggregator(): void {
  if (aggregateBuckets.size === 0) return
  // Defensive outer try/catch — if anything in the logger/Sentry sink
  // throws mid-flush, we still want to drop the buffer and return so the
  // 10s interval stays healthy. Telemetry must never poison itself.
  try {
    for (const bucket of aggregateBuckets.values()) {
      if (bucket.kind === 'histogram') {
        const sorted = bucket.samples.slice().sort((a, b) => a - b)
        const summary = {
          ...bucket.tags,
          count: bucket.count,
          sum_ms: Math.round(bucket.sum),
          min_ms: Math.round(bucket.min),
          max_ms: Math.round(bucket.max),
          p50_ms: Math.round(percentile(sorted, 50)),
          p95_ms: Math.round(percentile(sorted, 95)),
          aggregated: true,
        }
        emit(bucket.name, summary, `${bucket.name} agg ${bucket.count}×`)
      } else {
        const summary = { ...bucket.tags, count: bucket.count, aggregated: true }
        emit(bucket.name, summary, `${bucket.name} agg ${bucket.count}×`)
      }
    }
  } catch {
    /* never let telemetry kill itself */
  } finally {
    aggregateBuckets.clear()
  }
}

function pushToAggregate(
  name: MetricName,
  kind: 'histogram' | 'event',
  value: number,
  cleanedTags: Record<string, string | number | boolean>,
): void {
  ensureAggregator()
  const key = bucketKey(name, cleanedTags)
  let bucket = aggregateBuckets.get(key)
  if (!bucket) {
    bucket = {
      kind,
      samples: [],
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: 0,
      tags: cleanedTags,
      name,
    }
    aggregateBuckets.set(key, bucket)
  }
  bucket.count++
  if (kind === 'histogram') {
    bucket.samples.push(value)
    bucket.sum += value
    if (value < bucket.min) bucket.min = value
    if (value > bucket.max) bucket.max = value
  }
}

// §2.82 — a consent transition drops the aggregate window without flushing it.
// Buckets opened before the answer describe a period the user had not agreed
// to; flushing them on opt-in would be exactly the retroactive transmission
// the consent screen exists to prevent. Symmetric on opt-out.
registerTelemetryCollectionResetHook(() => { aggregateBuckets.clear() })

/** Stop the aggregator and clear buffers. Test-only. */
export function resetAggregator(): void {
  if (aggregateTimer) {
    clearInterval(aggregateTimer)
    aggregateTimer = null
  }
  aggregateBuckets.clear()
}

// --- Public API -------------------------------------------------------------

/**
 * Record a discrete event (counter-like). Fire-and-forget.
 * Typed over METRIC_EVENTS — the name must exist there with kind='event'.
 */
export function recordEvent<N extends MetricNamesOfKind<'event'>>(
  name: N,
  tags?: TagsInput,
): void {
  // Outer try/catch guarantees that a broken telemetry pipeline cannot
  // propagate back into the call site. Telemetry is strictly best-effort
  // and must never delay, block, or crash the user-visible code path.
  try {
    markFeatureReachFromEvent(name)
    const clean = cleanTags(tags)
    const def = definitionFor(name) as { aggregate?: boolean }
    if (def.aggregate) {
      // Buffering is itself a consent-bearing act (see telemetryGate.ts):
      // a bucket opened now would be flushed — and sent — later.
      if (!isTelemetryCollectionAllowed()) return
      pushToAggregate(name, 'event', 0, clean)
      return
    }
    emit(name, clean, name)
  } catch { /* never let telemetry break the caller */ }
}

/**
 * Record a duration histogram sample. Fire-and-forget.
 * Typed over METRIC_EVENTS — the name must exist there with kind='histogram'.
 */
export function recordHistogram<N extends MetricNamesOfKind<'histogram'>>(
  name: N,
  valueMs: number,
  tags?: TagsInput,
): void {
  try {
    markFeatureReachFromEvent(name)
    const clean = cleanTags(tags)
    const def = definitionFor(name) as { aggregate?: boolean }
    const rounded = Math.round(valueMs)
    if (def.aggregate) {
      // Same reasoning as recordEvent: no pre-consent buffering.
      if (!isTelemetryCollectionAllowed()) return
      pushToAggregate(name, 'histogram', rounded, clean)
      return
    }
    emit(name, { ...clean, value_ms: rounded }, `${name} ${rounded}ms`)
  } catch { /* never let telemetry break the caller */ }
}

/**
 * Record a gauge-style value. Fire-and-forget. Never aggregated — gauges are
 * inherently snapshots and should be emitted at a sensible cadence by the
 * caller (e.g. once per tick for body_indexer.coverage_pct).
 */
export function recordGauge<N extends MetricNamesOfKind<'gauge'>>(
  name: N,
  value: number,
  tags?: TagsInput,
): void {
  try {
    const clean = cleanTags(tags)
    emit(name, { ...clean, value }, `${name} = ${value}`)
  } catch { /* never let telemetry break the caller */ }
}

/**
 * Metric spans are intentionally named and detached root transactions.
 *
 * `op` is looked up from METRIC_SPAN_OP so every metric span has a stable
 * Sentry operation key for grouping/querying. This is a shape invariant, not
 * a proven delivery fix: with a valid DSN, @sentry/node v10.38 emits a
 * transaction envelope for `startInactiveSpan({ name })` even when `op` is
 * omitted.
 *
 * `parentSpan: null` is the one sampling guard we keep. It detaches metric
 * spans from any ambient Sentry/OTel context, so a foreground trace with
 * `parentSampled=true/false` cannot force metric spans to 100% or 0%;
 * they make their own decision through `tracesSampleRate` in sentry.ts.
 *
 * --- The two-function split ---
 *
 * Callers come in two flavours, with different type guarantees:
 *
 *   1. Direct callsites inside electron/services/* know the span name
 *      they want at compile time (`imap.idle`, `body_indexer.batch`, ...).
 *      For these we expose `startMetricSpan(name: MetricSpanName, ...)` —
 *      a strict, single-signature API. A typo like 'imap.synk' fails
 *      the build because the literal is not assignable to MetricSpanName.
 *      This is the API every direct caller MUST use; no `string` overload
 *      exists here, so TypeScript cannot silently accept an unknown name.
 *
 *   2. Runtime bridges from packages/net and packages/db forward the
   *      span name as a plain `string` — the packages telemetry seam
 *      is layer-pure and cannot statically reference MetricSpanName
 *      (packages/net must not import from electron/*). For these we
 *      expose a DIFFERENT entry point, `startMetricSpanDynamic`, which
 *      takes `string` and falls back to `op = name` when the name is not
 *      in METRIC_SPAN_OP. Keeping this on a separate name preserves the
 *      compile-time safety of the typed API: a typo in a direct caller
 *      never silently takes the string path.
 *
 * Only two wiring lines in electron/main.ts (setNetTelemetrySink and
 * setDbTelemetrySink) may call startMetricSpanDynamic. Everyone else —
 * including anything added to electron/services/* — uses the typed
 * startMetricSpan.
 */
export function startMetricSpan(
  name: MetricSpanName,
  attributes?: TagsInput,
): ReturnType<typeof startInactiveSpan> {
  // Typed path: METRIC_SPAN_OP is asserted complete against MetricSpanName
  // by metricsSchema.test.ts, so the lookup is guaranteed to produce a
  // non-empty string.
  const op = METRIC_SPAN_OP[name]
  return openMetricSpan(name, op, attributes)
}

/**
 * Runtime-bridge entry point for main.ts's setNetTelemetrySink /
 * setDbTelemetrySink wiring. Accepts an untyped `string` because the seam
 * in packages/net and packages/db is layer-pure and cannot reference
 * MetricSpanName. Falls back to `op = name` if the name is not registered
 * in METRIC_SPAN_OP, so an unregistered bridged name still ships with a
 * non-empty `op`. Deliberately separate from `startMetricSpan` so direct callers
 * cannot accidentally use the loose string path and lose compile-time
 * safety on span names.
 */
export function startMetricSpanDynamic(
  name: string,
  attributes?: TagsInput,
): ReturnType<typeof startInactiveSpan> {
  const op = (METRIC_SPAN_OP as Record<string, string>)[name] ?? name
  return openMetricSpan(name, op, attributes)
}

/**
 * A span handle that records nothing, with the same structural shape the real
 * SDK returns. Callers (bodyIndexer / offlineReplay / searchWorkerClient) only
 * rely on end() + setAttributes() + setAttribute() + setStatus().
 */
function noopSpan(): ReturnType<typeof startInactiveSpan> {
  return {
    end() { /* noop */ },
    setAttributes() { /* noop */ },
    setAttribute() { /* noop */ },
    setStatus() { /* noop */ },
  } as unknown as ReturnType<typeof startInactiveSpan>
}

/**
 * Shared implementation for the two public entry points. Keeps the
 * fail-safe boundary and the `parentSpan: null` sampling guard in one place.
 */
function openMetricSpan(
  name: string,
  op: string,
  attributes?: TagsInput,
): ReturnType<typeof startInactiveSpan> {
  // §2.82 — a span is an open recording window: it is created now and
  // submitted on end(), which may land after a consent flip. Do not open one
  // at all while collection is off.
  if (!isTelemetryCollectionAllowed()) return noopSpan()
  // Fail-safe boundary: @sentry/node has in the past thrown from inside
  // startInactiveSpan under niche transport/initialization states, and
  // several direct callers (bodyIndexer, searchWorkerClient, offlineReplay)
  // wrap this in their own try/catch already — but a throw here would
  // still bubble past the packages/net and packages/db bridges in main.ts
  // (which assume a silent default sink). Catching at the wrapper level
  // preserves the "telemetry must never throw" invariant uniformly.
  try {
    return startInactiveSpan({
      name,
      op,
      attributes: cleanTags(attributes),
      // Detach from any active trace so metric spans keep the global
      // tracesSampleRate policy instead of inheriting a parent decision.
      parentSpan: null,
    })
  } catch {
    // Degrade to a no-op span handle rather than propagating.
    return noopSpan()
  }
}

// Bucket helpers live in a zero-dep module so they can be shared with the
// renderer bundle without pulling electron-log / Sentry / electron-store.
export {
  bucketQueryLen,
  bucketResultCount,
  bucketDuration,
  bucketBodySize,
  bucketFreedBytes,
  bucketFolderCount,
  bucketFollowupDays,
  bucketTimeSinceSync,
  bucketSessionLength,
  bucketIdleDuration,
  bucketFetchedHeaders,
  bucketBatchSize,
  bucketCount,
  folderRoleFromPath,
  providerFromHost,
  type FolderRole,
  type ProviderTag,
} from './metricsBuckets'
