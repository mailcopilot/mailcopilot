/**
 * Classifier for OAuth token refresh errors.
 *
 * Maps an arbitrary error into a low-cardinality enum for the
 * `imap.auth_refresh_failure.reason` telemetry tag (see
 * electron/metricsSchema.ts). The enum is deliberately small so dashboards
 * can group by it without fragmenting on text variations.
 *
 * Privacy: this function receives arbitrary error objects whose messages
 * can contain provider-supplied diagnostics (including UPN). The return
 * value is ALWAYS one of three stable string literals — never the raw
 * message. Callers must pass only the return value forward to Sentry or
 * telemetry, never the original error. See §8 "PII не уходит".
 *
 * Extracted from electron/main.ts so it can be unit-tested without
 * booting the full Electron main module graph (Sentry init, IPC handler
 * registration, service wiring).
 */

/** AADSTS codes that specifically mean "refresh token is no longer usable
 *  and the user must re-authenticate interactively". Everything else
 *  (invalid client/tenant/app/policy, MFA-in-non-interactive-mode) is
 *  classified as `unknown` so those real config/service faults show up
 *  distinctly in telemetry instead of being absorbed into the
 *  `refresh_token_expired` bucket.
 *
 *  References:
 *  - AADSTS70043 / 700082 / 700084: refresh token expired or user signed
 *    out of session (inactivity, sign-out, compliance).
 *  - AADSTS50076: multi-factor authentication is required to access the
 *    resource. Microsoft documents this as "user must use MFA to access
 *    … Retry with a new authorize request" — from the IMAP caller's
 *    perspective the refresh token alone can no longer produce a usable
 *    access token, so the outcome is identical to refresh_token_expired.
 *  - AADSTS50078 / 50005 / 50173: strong auth / fresh auth required — the
 *    currently held refresh token cannot satisfy the policy, interactive
 *    re-auth is the only recovery path.
 *  - AADSTS50144: password must be changed — same outcome: refresh token
 *    alone cannot recover. */
export const AADSTS_REFRESH_EXPIRED_CODES: readonly string[] = [
  'AADSTS70043',
  'AADSTS700082',
  'AADSTS700084',
  'AADSTS50076',
  'AADSTS50078',
  'AADSTS50005',
  'AADSTS50173',
  'AADSTS50144',
]

export type AuthRefreshFailureReason = 'refresh_token_expired' | 'network' | 'unknown'

/** Classify an OAuth token refresh error into a low-cardinality enum for
 *  metrics. Returns only safe, non-PII values — never raw error messages.
 *
 *  Whitelist approach (not a generic regex on `AADSTS\d+`): Azure returns
 *  AADSTS codes for many unrelated conditions (invalid_client, tenant
 *  mismatch, policy denials, etc.). Lumping all of them into
 *  `refresh_token_expired` would hide real config/service faults behind
 *  the expiry bucket and corrupt telemetry dashboards. */
export function classifyRefreshError(err: unknown): AuthRefreshFailureReason {
  const msg = err instanceof Error ? err.message : String(err)

  // Network errors are the cheapest to rule out first — they never carry
  // AADSTS or invalid_grant markers so there's no ambiguity.
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|ECONNABORTED|network|fetch failed/i.test(msg)) {
    return 'network'
  }

  // OAuth2-spec invalid_grant covers both the Google path (always) and
  // the Microsoft non-AADSTS path (rare — Azure normally attaches an
  // AADSTS code, but invalid_grant alone is valid too).
  if (/\binvalid_grant\b/i.test(msg)) return 'refresh_token_expired'

  // Explicit AADSTS whitelist — only codes that unambiguously mean
  // "interactive re-auth required" classify as refresh_token_expired.
  for (const code of AADSTS_REFRESH_EXPIRED_CODES) {
    // Word-boundary match on the exact code token. A simple substring
    // test would false-positive AADSTS700084 when looking for
    // AADSTS70008 — exact token match avoids that.
    const re = new RegExp(`\\b${code}\\b`, 'i')
    if (re.test(msg)) return 'refresh_token_expired'
  }

  // Verbose "refresh token expired/revoked" phrasings that some providers
  // emit without a machine code at all.
  if (/refresh.?token.*(?:expired|revoked|invalid)/i.test(msg)) return 'refresh_token_expired'

  return 'unknown'
}
