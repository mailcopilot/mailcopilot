/** Google OAuth client credentials for the Desktop (PKCE) flow.
 *
 *  Resolution order — environment variable first, build-time value second:
 *
 *    1. `MAILCOPILOT_GOOGLE_CLIENT_ID` / `MAILCOPILOT_GOOGLE_CLIENT_SECRET`
 *       from the process environment. This is what development, CI and e2e
 *       use, and it lets a packaged build be pointed at a different client
 *       without rebuilding.
 *    2. Values baked into the main bundle at build time by the `define` block
 *       in `vite.config.ts` (same mechanism as `__SENTRY_DSN__`).
 *
 *  There is deliberately NO literal fallback in the source tree. The
 *  repository is public, and a credential committed to it gets machine-indexed
 *  by secret scanners and auto-revoked by the provider — which breaks Gmail
 *  sign-in for every installed copy at once. For a Desktop OAuth client the
 *  "secret" is not a secret in the RFC 6749 sense (it ships inside every
 *  binary and PKCE is what actually protects the exchange), but keeping it out
 *  of source still matters for exactly that revocation reason.
 *
 *  A build without credentials is a valid, supported configuration: everything
 *  except Gmail OAuth sign-in works, and the sign-in path fails with an
 *  actionable message instead of an opaque `invalid_client` from Google.
 */

/** Build-time injected values. `typeof` guard because the `define`
 *  substitution only happens in the vite main-process bundle — under vitest
 *  these identifiers are simply not declared. */
const BUILT_IN_CLIENT_ID = typeof __GOOGLE_OAUTH_CLIENT_ID__ === 'string' ? __GOOGLE_OAUTH_CLIENT_ID__ : ''
const BUILT_IN_CLIENT_SECRET = typeof __GOOGLE_OAUTH_CLIENT_SECRET__ === 'string' ? __GOOGLE_OAUTH_CLIENT_SECRET__ : ''

export type GoogleOAuthCredentials = {
  clientId: string
  /** Empty for a public (secret-less) client — the token endpoint is then
   *  called with PKCE only. Google's "Desktop app" client type does issue a
   *  secret, so in practice this is set. */
  clientSecret: string
}

/** Shown to the user when a self-built binary carries no Google client.
 *  Kept in English on purpose: it is a build-configuration diagnostic, and
 *  official builds — the only ones normal users run — never reach it. */
export const GOOGLE_OAUTH_UNCONFIGURED_MESSAGE =
  'Google sign-in is unavailable: this build was made without Google OAuth credentials. '
  + 'Create your own OAuth client of type "Desktop app" in Google Cloud Console and supply it via '
  + 'MAILCOPILOT_GOOGLE_CLIENT_ID / MAILCOPILOT_GOOGLE_CLIENT_SECRET — see README.'

/** Pure resolver. Exported for tests; production callers use
 *  {@link getGoogleOAuthCredentials} / {@link requireGoogleOAuthCredentials}. */
export function resolveGoogleOAuthCredentials(source: {
  envClientId?: string
  envClientSecret?: string
  builtInClientId?: string
  builtInClientSecret?: string
}): GoogleOAuthCredentials | null {
  const clientId = (source.envClientId || '').trim() || (source.builtInClientId || '').trim()
  if (!clientId) return null
  const clientSecret = (source.envClientSecret || '').trim() || (source.builtInClientSecret || '').trim()
  return { clientId, clientSecret }
}

/** Resolved credentials, or `null` when this build has none. */
export function getGoogleOAuthCredentials(): GoogleOAuthCredentials | null {
  return resolveGoogleOAuthCredentials({
    envClientId: process.env.MAILCOPILOT_GOOGLE_CLIENT_ID,
    envClientSecret: process.env.MAILCOPILOT_GOOGLE_CLIENT_SECRET,
    builtInClientId: BUILT_IN_CLIENT_ID,
    builtInClientSecret: BUILT_IN_CLIENT_SECRET,
  })
}

/** True when Gmail OAuth sign-in can be attempted at all. */
export function isGoogleOAuthConfigured(): boolean {
  return getGoogleOAuthCredentials() !== null
}

/** Credentials or a user-facing error. Call this at the entry points of the
 *  OAuth flow (interactive authorization, token refresh) — never at module
 *  load, so that a credential-less build still starts and works. */
export function requireGoogleOAuthCredentials(): GoogleOAuthCredentials {
  const creds = getGoogleOAuthCredentials()
  if (!creds) throw new Error(GOOGLE_OAUTH_UNCONFIGURED_MESSAGE)
  return creds
}
