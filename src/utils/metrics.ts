/**
 * Renderer-side metrics API.
 *
 * Typed over the same metricsSchema.ts registry as the main-process sink.
 * Calls are fire-and-forget via `window.api.recordMetric`; they never throw
 * and never block the UI. Validation + Sentry/log dispatch happens in main.
 *
 * Privacy rules are identical to the main-side module: no content, no
 * addresses, no paths, no subjects. Only structural fields.
 */

import type {
  MetricName,
  MetricNamesOfKind,
  TagValue,
} from '../../electron/metricsSchema'

type TagsInput = Record<string, TagValue>

function send(
  name: string,
  kind: 'event' | 'histogram' | 'gauge',
  value: number | null,
  tags?: TagsInput,
): void {
  try {
    window.api?.recordMetric?.(name, kind, value, tags)
  } catch {
    /* telemetry must never throw */
  }
}

export function recordEvent<N extends MetricNamesOfKind<'event'>>(
  name: N,
  tags?: TagsInput,
): void {
  send(name, 'event', null, tags)
}

export function recordHistogram<N extends MetricNamesOfKind<'histogram'>>(
  name: N,
  valueMs: number,
  tags?: TagsInput,
): void {
  send(name, 'histogram', Math.round(valueMs), tags)
}

export function recordGauge<N extends MetricNamesOfKind<'gauge'>>(
  name: N,
  value: number,
  tags?: TagsInput,
): void {
  send(name, 'gauge', value, tags)
}

// Bucket helpers come from a zero-dep module so renderer bundle stays clean.
export {
  bucketQueryLen,
  bucketResultCount,
  bucketDuration,
  bucketBodySize,
  bucketFolderCount,
  bucketFollowupDays,
  bucketTimeSinceSync,
  bucketSessionLength,
  folderRoleFromPath,
  providerFromHost,
} from '../../electron/metricsBuckets'

export type { MetricName }
