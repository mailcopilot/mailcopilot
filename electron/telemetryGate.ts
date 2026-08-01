// §2.82 — the collection gate.
//
// The consent decision does not only govern TRANSMISSION, it governs
// COLLECTION. Anything we accumulate in memory while the answer is "no" (or
// "not asked yet") is data that a later "yes" would ship retroactively: the
// 10-second aggregate window in metrics.ts, the whole-session feature-reach
// bitmap in featureReach.ts, the session clock behind `app.session_ended`, and
// Sentry's own breadcrumb buffer. Shipping any of it after an opt-in is
// transmission of data collected without consent (ePrivacy art. 5(3)) — the
// user's mental model is "from now on", not "including everything I did while
// I had it off".
//
// So the rule this module enforces is: while collection is off, nothing
// accumulates; and every transition (off→on AND on→off) drops whatever state
// did accumulate and re-origins the session clock.
//
// Deliberately dependency-free. It is imported by metrics.ts, featureReach.ts
// and sentry.ts, all three of which are on each other's import paths; a module
// with zero imports of its own cannot participate in a cycle. Consumers
// register a reset hook instead of this module reaching into them.
//
// Fail-closed default: `false`. The single driver is
// `setSentryUserEnabled()` in electron/sentry.ts, which every site that
// decides "is telemetry allowed" already calls (the boot preflight, the
// settings load, `settings:save`, and the consent screen handler), so the gate
// tracks the consent verdict by construction rather than by remembering to
// wire up a fifth call site.

let _collectionAllowed = false
let _sessionOriginMs = Date.now()
const _resetHooks: Array<() => void> = []

/**
 * Register a callback that drops whatever this module accumulated. Called on
 * EVERY transition of the gate, in registration order. Hooks must not throw;
 * we wrap them anyway (telemetry must never throw).
 */
export function registerTelemetryCollectionResetHook(hook: () => void): void {
  _resetHooks.push(hook)
}

/** May we accumulate and send telemetry right now? */
export function isTelemetryCollectionAllowed(): boolean {
  return _collectionAllowed
}

/**
 * Timestamp the current telemetry session started from.
 *
 * NOT the process start: for a user who consents mid-session, the session
 * length we may report begins at the moment of consent. Reporting the full
 * process uptime would describe a period the user had not agreed to be
 * measured over.
 */
export function telemetryCollectionStartedAtMs(): number {
  return _sessionOriginMs
}

/**
 * Apply the consent verdict. A no-op when the value is unchanged (the boot
 * path calls it twice with the same answer), so a repeated "still allowed"
 * cannot silently reset the session clock.
 */
export function setTelemetryCollectionAllowed(allowed: boolean): void {
  if (allowed === _collectionAllowed) return
  _collectionAllowed = allowed
  // Both directions drop the buffers:
  //   off→on  — nothing collected before the answer may be shipped after it.
  //   on→off  — a withdrawal (GDPR art. 7(3)) must not leave a buffer that a
  //             later re-opt-in would flush.
  _sessionOriginMs = Date.now()
  for (const hook of _resetHooks) {
    try { hook() } catch { /* telemetry must never throw */ }
  }
}

/** Test-only: restore the module to its fail-closed initial state. */
export function __resetTelemetryGateForTest(): void {
  _collectionAllowed = false
  _sessionOriginMs = Date.now()
}

/** Test-only: drop registered hooks (used by suites that re-import consumers). */
export function __clearTelemetryResetHooksForTest(): void {
  _resetHooks.length = 0
}
