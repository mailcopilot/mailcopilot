/**
 * Per-session feature-reach bitmap.
 *
 * Emitted once in usage.session_summary on before-quit. Updated from a single
 * derivation function keyed by metric name so renderer-sourced events (via
 * IPC bridge) and main-sourced events (direct recordEvent calls in main.ts,
 * ai.ts, bodyIndexer.ts, etc.) stay in lockstep without separate plumbing.
 *
 * Lives in its own module because both main.ts and metrics.ts need to write
 * to it, and keeping it isolated prevents an import cycle.
 */

export const featureReach = {
  search: false,
  compose: false,
  snooze: false,
  read_later: false,
  ai: false,
  rules: false,
  templates: false,
  followup: false,
}

/**
 * Mark the relevant feature bit based on the event name. Safe to call on
 * every emitted metric — unrelated events are no-ops.
 *
 * Only covers features that have telemetry events defined in metricsSchema.ts.
 * Features that don't yet have dedicated events (AI chat, snooze, read_later,
 * rules) are flagged via markFeatureUsed() directly from their IPC handlers.
 */
export function markFeatureReachFromEvent(name: string): void {
  if (name.startsWith('search.')) featureReach.search = true
  else if (name === 'compose.opened' || name.startsWith('send_queue.') || name.startsWith('misdirection.')) featureReach.compose = true
  else if (name === 'template.applied') featureReach.templates = true
  else if (name.startsWith('followup.')) featureReach.followup = true
}

/**
 * Mark a feature as used directly, bypassing the event-name derivation.
 * Used for features whose telemetry events haven't landed yet but whose
 * invocation is observable via an IPC handler or a background task.
 */
export function markFeatureUsed(key: keyof typeof featureReach): void {
  featureReach[key] = true
}

/** Test-only. Reset the bitmap to all false. */
export function resetFeatureReach(): void {
  for (const k of Object.keys(featureReach) as Array<keyof typeof featureReach>) {
    featureReach[k] = false
  }
}
