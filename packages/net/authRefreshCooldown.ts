/**
 * Per-account OAuth refresh cooldown.
 *
 * Why this exists: when a refresh token is revoked server-side (user removed
 * consent, account locked, corporate policy), every IMAP op on that account
 * will hit an auth error. Without a cooldown, each op triggers a fresh
 * `/token` call against Azure/Google, which rate-limits on the client_id
 * and can cascade into 429s affecting legitimate sibling accounts that
 * share the client_id.
 *
 * Strategy (per accountId, provider-agnostic):
 * - On handler failure: record `lastFailureAt = now`, increment
 *   `consecutiveFailures`. Subsequent calls within the current cooldown
 *   window are suppressed — the gate returns the original auth error
 *   without calling the handler.
 * - The window grows with `consecutiveFailures`: 60s, 300s, 1800s (capped).
 * - On handler success: clear the entry entirely — the account is healthy
 *   again and the next failure starts from zero.
 *
 * Layer purity: no imports from electron/. Tests live alongside this file
 * so packages/net stays self-contained.
 */

export type CooldownEntry = {
  lastFailureAt: number
  consecutiveFailures: number
}

/** Cooldown windows in ms, indexed by consecutiveFailures (clamped at tail). */
const COOLDOWN_WINDOWS_MS: readonly number[] = [
  60_000,        // 1st failure: 1 min
  5 * 60_000,    // 2nd failure: 5 min
  30 * 60_000,   // 3rd+ failure: 30 min (cap)
]

const state = new Map<number, CooldownEntry>()

/** Test-only: clock injection for deterministic cooldown tests. */
let nowImpl: () => number = () => Date.now()

/** Test-only: override the internal clock. Pass null to reset. */
export function __setAuthRefreshCooldownClock(fn: (() => number) | null): void {
  nowImpl = fn ?? (() => Date.now())
}

/** Test-only: wipe all cooldown state. Call in afterEach. */
export function __resetAuthRefreshCooldown(): void {
  state.clear()
}

/** Returns remaining cooldown ms for the account, or 0 if none active. */
export function remainingCooldownMs(accountId: number): number {
  const entry = state.get(accountId)
  if (!entry) return 0
  const windowMs = windowForFailures(entry.consecutiveFailures)
  const elapsed = nowImpl() - entry.lastFailureAt
  const remaining = windowMs - elapsed
  return remaining > 0 ? remaining : 0
}

/** True iff the account is within an active cooldown window and the handler
 *  MUST be suppressed on the next auth error. */
export function isInCooldown(accountId: number): boolean {
  return remainingCooldownMs(accountId) > 0
}

/** Record a successful refresh — clears the cooldown entirely. */
export function recordRefreshSuccess(accountId: number): void {
  state.delete(accountId)
}

/** Record a refresh failure — increments consecutiveFailures and sets
 *  lastFailureAt. The next call to isInCooldown() will return true until
 *  the window expires. */
export function recordRefreshFailure(accountId: number): void {
  const prev = state.get(accountId)
  state.set(accountId, {
    lastFailureAt: nowImpl(),
    consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
  })
}

/** Test-only / introspection: current snapshot for a given account. */
export function peekCooldownEntry(accountId: number): CooldownEntry | undefined {
  const e = state.get(accountId)
  return e ? { ...e } : undefined
}

function windowForFailures(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0
  const idx = Math.min(consecutiveFailures - 1, COOLDOWN_WINDOWS_MS.length - 1)
  return COOLDOWN_WINDOWS_MS[idx]
}
