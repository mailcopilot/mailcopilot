import http from 'node:http'
import crypto from 'node:crypto'
import { createLogger } from './logger'
import { captureException } from './sentry'

const log = createLogger('MicrosoftOAuth')

/**
 * Build a PII-safe summary of an OAuth error message for Sentry reporting.
 *
 * Azure's `error_description` routinely inlines UPN (email-like user
 * identifier) and AADSTS diagnostic dumps. We strip both aggressively and
 * return only the bare AADSTS code or OAuth2 error identifier — enough
 * to triage in dashboards, not enough to re-identify an account.
 *
 * Invariant (CLAUDE.md §8 "PII не уходит"): nothing this function returns
 * may contain an email address or full diagnostic text. Callers pass the
 * result into a NEW Error instance (not the original error object), so
 * the raw message and stack never reach Sentry.
 */
export function summarizeOAuthErrorForSentry(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // AADSTS code is the cleanest signal when present.
  const aadsts = /\bAADSTS\d{3,6}\b/i.exec(raw)
  if (aadsts) return aadsts[0].toUpperCase()
  // OAuth2-spec error identifiers (invalid_grant, invalid_client, etc.)
  // are low-cardinality and contain no PII by construction.
  const oauthErr = /\b(invalid_grant|invalid_client|invalid_request|invalid_scope|unauthorized_client|unsupported_grant_type|access_denied|server_error|temporarily_unavailable)\b/i.exec(raw)
  if (oauthErr) return oauthErr[0].toLowerCase()
  // Fallback: nothing we can classify. Do not forward the raw message.
  return 'oauth_error'
}

export type MicrosoftOAuthTokens = {
  email: string
  accessToken: string
  /** Epoch ms */
  expiresAt: number
  refreshToken: string
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function pkcePair(): { verifier: string; challenge: string } {
  // RFC 7636: verifier length 43..128. 32 bytes => ~43 base64url chars.
  const verifier = base64UrlEncode(crypto.randomBytes(32))
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function decodeJwtPayload<T extends object>(jwt: string): T | undefined {
  const parts = jwt.split('.')
  if (parts.length < 2) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as T
  } catch {
    return undefined
  }
}

async function httpPostFormJson(url: string, body: URLSearchParams): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await res.text()
  let parsed: unknown = undefined
  try { parsed = JSON.parse(text) } catch { parsed = text }
  if (!res.ok) {
    const msg = typeof parsed === 'object' && parsed && 'error_description' in parsed
      ? String((parsed as { error_description?: unknown }).error_description)
      : typeof parsed === 'object' && parsed && 'error' in parsed
        ? String((parsed as { error?: unknown }).error)
        : `HTTP ${res.status}`
    throw new Error(msg)
  }
  return parsed
}

async function httpGetJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers })
  const text = await res.text()
  let parsed: unknown = undefined
  try { parsed = JSON.parse(text) } catch { parsed = text }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parsed
}

function extractEmailFromIdToken(idToken?: string): string {
  const payload = idToken
    ? decodeJwtPayload<{ email?: string; preferred_username?: string }>(idToken)
    : undefined
  return (payload?.email || payload?.preferred_username || '').trim()
}

let microsoftOAuthBusy = false

export function isMicrosoftOAuthBusy(): boolean {
  return microsoftOAuthBusy
}

/**
 * Test-only helper: resets the module-level mutex so a timed-out test
 * does not cascade-fail every following test in the suite with
 * "Microsoft OAuth is already running in another window".
 *
 * Not wired through IPC and not used by production flows — the mutex is
 * reset automatically via try/finally inside runMicrosoftOAuthFlow. CI
 * only hit this because a slow runner pushed test 1 past 5s timeout
 * while the flag was still true.
 */
export function __resetMicrosoftOAuthBusyForTests(): void {
  microsoftOAuthBusy = false
}

// `outlook.office.com` (not `.office365.com`) per Microsoft's 2025-10-17
// IMAP/SMTP OAuth doc and Thunderbird/K-9/Evolution. `.office365.com` breaks
// personal Outlook.com accounts on /common — Microsoft issues a consumer
// token that IMAP host rejects.
//
// Microsoft Graph `Mail.Send` is consented at authorize time so that send
// can go through `POST /me/sendMail` — SMTP AUTH is server-side disabled
// for new (2024+) personal Outlook.com mailboxes with no user-accessible
// toggle (Mozilla SUMO: "For new accounts, SMTP always starts disabled.";
// Microsoft Q&A 5816949: "no user toggle available"). 2023 precedent
// where MS silently re-enabled consumer SMTP suggests this could reverse —
// we still consent SMTP.Send and keep `outlook.office.com` access so if
// SMTP ever works for a given mailbox, nothing needs re-consenting.
// Refresh_token carries every consented scope; at token-refresh time we
// select resource per call (IMAP → outlook.office.com, send → graph).
const MICROSOFT_SCOPES = [
  'offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'https://graph.microsoft.com/Mail.Send',
  'openid',
  'email',
  'profile',
  'User.Read',
]

/** Scopes used when swapping refresh_token for a Graph-resource access
 *  token (needed for `POST /me/sendMail`). Must be a subset of
 *  MICROSOFT_SCOPES that maps to resource `https://graph.microsoft.com`. */
export const MICROSOFT_GRAPH_SEND_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/Mail.Send',
]

/** Scopes used when swapping refresh_token for an Exchange-resource
 *  access token (IMAP/SMTP).
 *
 *  Deliberately omits TWO classes of scope:
 *  - Graph `Mail.Send` — pre-2.2-E accounts never consented to it;
 *    requesting it on refresh would fail with AADSTS65001 and break
 *    IMAP/sync for those accounts.
 *  - `User.Read` — a Graph-resource scope, and Microsoft's `/token`
 *    requires a single resource per request alongside OIDC scopes
 *    (openid/email/profile). Mixing `outlook.office.com/...` with
 *    `User.Read` yields a token with a resource-ambiguous or
 *    Graph-audience aud claim that IMAP XOAUTH2 will reject.
 *    User.Read stays in MICROSOFT_SCOPES (requested at /authorize for
 *    consent), but is never redeemed alongside Exchange scopes at
 *    /token — it's only used by getMicrosoftIdentityAccessToken below
 *    for the rare `id_token` email fallback. */
export const MICROSOFT_EXCHANGE_SCOPES = [
  'offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'openid',
  'email',
  'profile',
]

/** Scopes used when swapping refresh_token for a Graph-resource access
 *  token carrying `User.Read` — needed only for the `id_token` email
 *  fallback path, where we hit `GET https://graph.microsoft.com/v1.0/me`
 *  because neither `email` nor `preferred_username` is present in the
 *  original id_token (rare for consumer MSA, but observed in the wild
 *  per Microsoft docs on optional id_token claims). */
export const MICROSOFT_GRAPH_IDENTITY_SCOPES = [
  'offline_access',
  'User.Read',
]

/** Default loopback port used by production OAuth flow. Registered in Azure
 *  as `http://localhost:53682/callback`. login.live.com (personal MSA
 *  accounts) enforces exact `redirect_uri` match by port — changing this
 *  default breaks production. Tests pass `loopbackPort: 0` to let the OS
 *  pick a free ephemeral port and avoid EADDRINUSE flake under parallel
 *  vitest workers / external processes also using 53682 (e.g. gcloud CLI). */
const DEFAULT_MICROSOFT_OAUTH_LOOPBACK_PORT = 53682

export async function runMicrosoftOAuthFlow(params: {
  clientId: string
  clientSecret?: string
  openExternal: (url: string) => void | Promise<void>
  timeoutMs?: number
  scopes?: string[]
  /** Loopback port to bind the OAuth callback server. Defaults to 53682 to
   *  match the production Azure app registration. Tests pass 0 (ephemeral)
   *  to avoid EADDRINUSE flake. */
  loopbackPort?: number
}): Promise<MicrosoftOAuthTokens> {
  if (microsoftOAuthBusy) throw new Error('Microsoft OAuth is already running in another window')
  microsoftOAuthBusy = true

  try {
    return await doMicrosoftOAuthFlow(params)
  } finally {
    microsoftOAuthBusy = false
  }
}

async function doMicrosoftOAuthFlow(params: {
  clientId: string
  clientSecret?: string
  openExternal: (url: string) => void | Promise<void>
  timeoutMs?: number
  scopes?: string[]
  loopbackPort?: number
}): Promise<MicrosoftOAuthTokens> {
  const { clientId, clientSecret, openExternal } = params
  const timeoutMs = params.timeoutMs ?? 3 * 60 * 1000
  const scopes = params.scopes ?? MICROSOFT_SCOPES
  const loopbackPort = params.loopbackPort ?? DEFAULT_MICROSOFT_OAUTH_LOOPBACK_PORT
  const { verifier, challenge } = pkcePair()
  const state = base64UrlEncode(crypto.randomBytes(16))

  const pageMessages = {
    doneTitle: 'Done',
    doneText: 'You can close this window and return to the app.',
    cancelTitle: 'Authorization canceled',
    cancelText: 'You can close this window.',
  }

  const oauthHtml = (title: string, text: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;background:#f8fafc;color:#0f172a}
.card{max-width:560px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px 22px;box-shadow:0 6px 20px rgba(15,23,42,.08)}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#334155}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${text}</p></div>
<script>
(function(){
  var tryClose = function() {
    try { window.open('', '_self'); window.close(); } catch (_) {}
  };
  tryClose();
  setTimeout(tryClose, 150);
  setTimeout(tryClose, 500);
  setTimeout(tryClose, 1200);
})();
</script></body></html>`

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let shouldClose = false
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Not found')
          return
        }
        // If callback received — close the flow after processing this request.
        shouldClose = true

        const err = url.searchParams.get('error')
        const errDesc = url.searchParams.get('error_description')
        if (err) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(oauthHtml(pageMessages.cancelTitle, pageMessages.cancelText))
          const oauthErr = new Error(errDesc || err)
          log.error('Microsoft OAuth error callback:', err, errDesc)
          captureException(oauthErr, { source: 'MicrosoftOAuth', error_code: err, error_description: errDesc ?? undefined })
          reject(oauthErr)
          return
        }

        const gotState = url.searchParams.get('state') || ''
        const gotCode = url.searchParams.get('code') || ''
        if (!gotCode) {
          const noCodeErr = new Error('Microsoft did not return code')
          log.error('Microsoft OAuth: no code in callback')
          captureException(noCodeErr, { source: 'MicrosoftOAuth' })
          throw noCodeErr
        }
        if (gotState !== state) {
          const stateErr = new Error('Invalid state in OAuth callback')
          log.error('Microsoft OAuth: state mismatch')
          captureException(stateErr, { source: 'MicrosoftOAuth' })
          throw stateErr
        }

        const addr = server.address()
        if (!addr || typeof addr === 'string') throw new Error('Could not determine OAuth callback port')

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(oauthHtml(pageMessages.doneTitle, pageMessages.doneText))
        resolve({ code: gotCode, redirectUri: `http://localhost:${addr.port}/callback` })
      } catch (e) {
        shouldClose = true
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Bad request')
        reject(e instanceof Error ? e : new Error(String(e)))
      } finally {
        if (shouldClose) {
          try { server.close() } catch { /* ignore */ }
        }
      }
    })

    // Fixed port (registered in Azure as http://localhost:53682/callback).
    // Random port works for login.microsoftonline.com (Entra loopback
    // exception) but login.live.com (personal MSA accounts) enforces exact
    // redirect_uri match on port. Fixed port covers both paths.
    //
    // Arm the OAuth-flow timeout BEFORE registering the bind-error handler
    // so both paths can cooperatively clearTimeout — otherwise a bind
    // failure (never opens the server) leaves the timer armed, firing a
    // stale "OAuth callback timeout" Sentry event minutes after the real
    // bind error was surfaced.
    const timeout = setTimeout(() => {
      try { server.close() } catch { /* ignore */ }
      const timeoutErr = new Error('OAuth callback timeout')
      log.error('Microsoft OAuth: callback timeout')
      captureException(timeoutErr, { source: 'MicrosoftOAuth' })
      reject(timeoutErr)
    }, timeoutMs)
    server.once('close', () => clearTimeout(timeout))

    // Bind-failure handling: another process may already hold the loopback
    // port (rare but possible in production — e.g. gcloud CLI also uses
    // 53682 as a conventional OAuth loopback port). Fail fast with a clear
    // message instead of hanging — user needs to close the offender or
    // restart the app. Capture as Sentry: this is a genuine misconfig
    // worth knowing about in the field.
    //
    // The error message intentionally omits the concrete port number when
    // the caller asked for an ephemeral port (0) or any non-default port —
    // tests use ephemeral ports to avoid flake under parallel workers, and
    // we don't want a spurious "53682" in test-only error paths.
    server.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      let msg: string
      if (err.code === 'EADDRINUSE') {
        msg = loopbackPort === DEFAULT_MICROSOFT_OAUTH_LOOPBACK_PORT
          ? `Microsoft OAuth loopback port ${DEFAULT_MICROSOFT_OAUTH_LOOPBACK_PORT} is already in use by another process — close the conflicting application and try again`
          : `Microsoft OAuth loopback port is already in use by another process — close the conflicting application and try again`
      } else {
        msg = `Microsoft OAuth loopback bind failed: ${err.message}`
      }
      log.error(msg)
      captureException(err, { source: 'MicrosoftOAuth', stage: 'bind', code: err.code })
      reject(new Error(msg))
    })
    server.listen(loopbackPort, 'localhost', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not start local OAuth server'))
        return
      }
      const redirectUri = `http://localhost:${address.port}/callback`
      const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('redirect_uri', redirectUri)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('response_mode', 'query')
      authUrl.searchParams.set('prompt', 'consent')
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('scope', scopes.join(' '))
      Promise.resolve(openExternal(authUrl.toString()))
        .catch((e) => {
          try { server.close() } catch { /* ignore */ }
          reject(e instanceof Error ? e : new Error(String(e)))
        })
    })
  })

  log.info('Authorization code received, exchanging for tokens...')

  const tokenParams = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    // Multi-resource consent at /authorize requires an explicit scope at
    // /token so Microsoft knows which resource the returned access_token
    // should be minted for (AADSTS70011 "must include scope input
    // parameter" otherwise, observed 2026-04-23). We pick the Exchange
    // subset — the initial access_token is used right after for IMAP test
    // connect. Graph-resource tokens are obtained on-demand by
    // refreshMicrosoftAccessToken with MICROSOFT_GRAPH_SEND_SCOPES.
    scope: MICROSOFT_EXCHANGE_SCOPES.join(' '),
  })
  if (clientSecret) tokenParams.set('client_secret', clientSecret)

  let tokenJson: {
    access_token?: string
    expires_in?: number
    refresh_token?: string
    id_token?: string
  }
  try {
    tokenJson = await httpPostFormJson(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      tokenParams,
    ) as typeof tokenJson
  } catch (e) {
    log.error('Microsoft OAuth: token exchange failed:', e instanceof Error ? e.message : e)
    captureException(e, { source: 'MicrosoftOAuth' })
    throw e
  }

  const accessToken = (tokenJson.access_token || '').trim()
  const refreshToken = (tokenJson.refresh_token || '').trim()
  const expiresIn = Number(tokenJson.expires_in || 0)
  if (!accessToken) throw new Error('Microsoft did not return access_token')
  if (!refreshToken) throw new Error('Microsoft did not return refresh_token (check offline_access scope)')

  const expiresAt = Date.now() + Math.max(0, expiresIn) * 1000

  // Usually email is available directly in id_token, but if missing — fallback to MS Graph /me.
  const emailFromId = extractEmailFromIdToken(tokenJson.id_token)
  if (emailFromId) return { email: emailFromId, accessToken, expiresAt, refreshToken }

  // Fallback: the initial access_token is Exchange-audience (we asked
  // /token for outlook.office.com scopes to fix AADSTS70011 on multi-
  // resource consent), so Graph /me would reject it. Swap the
  // refresh_token for a Graph-audience User.Read token just for this
  // one identity lookup.
  log.info('Email not found in id_token, falling back to MS Graph /me with a Graph-audience token...')
  try {
    const graphToken = await refreshMicrosoftAccessToken({
      clientId,
      clientSecret,
      refreshToken,
      scopes: MICROSOFT_GRAPH_IDENTITY_SCOPES,
    })
    const profile = await httpGetJson('https://graph.microsoft.com/v1.0/me', {
      Authorization: `Bearer ${graphToken.accessToken}`,
    }) as { mail?: string; userPrincipalName?: string }
    const emailFromGraph = (profile.mail || profile.userPrincipalName || '').trim()
    if (!emailFromGraph) throw new Error('Could not retrieve user email from Microsoft Graph')
    // Return the MOST RECENT refresh_token. The Graph-identity refresh call
    // above may have rotated the refresh_token (Microsoft v2.0 rotation —
    // see 2.2-I). Returning the stale code-exchange `refreshToken` here
    // would cause onboarding to immediately persist a stale token that
    // Microsoft could reject on first use. Wave-2 codex finding (019dbc07).
    const freshestRefreshToken = graphToken.refreshToken ?? refreshToken
    return { email: emailFromGraph, accessToken, expiresAt, refreshToken: freshestRefreshToken }
  } catch (e) {
    log.error('Microsoft OAuth: MS Graph /me failed:', e instanceof Error ? e.message : e)
    captureException(e, { source: 'MicrosoftOAuth' })
    throw e instanceof Error ? e : new Error(String(e))
  }
}

export async function refreshMicrosoftAccessToken(params: {
  clientId: string
  clientSecret?: string
  refreshToken: string
  /** Scope subset to request — REQUIRED. Microsoft /token enforces
   *  single-resource requests plus OIDC scopes; passing the multi-resource
   *  MICROSOFT_SCOPES set would produce AADSTS70011 "scopes are not
   *  compatible" (observed 2026-04-23). Callers MUST pass an explicit
   *  resource-scoped subset:
   *    - MICROSOFT_EXCHANGE_SCOPES → IMAP/SMTP (aud=outlook.office.com).
   *    - MICROSOFT_GRAPH_SEND_SCOPES → POST /me/sendMail (aud=graph).
   *    - MICROSOFT_GRAPH_IDENTITY_SCOPES → GET /me identity fallback.
   *  The scope list must also be a subset of the originally-consented
   *  scopes (MICROSOFT_SCOPES at /authorize); the refresh_token carries
   *  every consented scope. */
  scopes: string[]
}): Promise<{ accessToken: string; expiresAt: number; refreshToken?: string }> {
  const { clientId, clientSecret, refreshToken, scopes } = params
  const refreshParams = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: scopes.join(' '),
  })
  if (clientSecret) refreshParams.set('client_secret', clientSecret)

  let json: { access_token?: string; expires_in?: number; refresh_token?: string }
  try {
    json = await httpPostFormJson(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      refreshParams,
    ) as typeof json
  } catch (e) {
    log.error('Microsoft OAuth: refresh failed:', e instanceof Error ? e.message : e)
    // PII safety (§8): the raw error message contains Azure's
    // `error_description` which often inlines UPN. Forward only a
    // sanitized summary (AADSTS code or OAuth2 error identifier) via a
    // NEW Error — the original `e` (with its message and stack) stays
    // inside this process.
    captureException(
      new Error(`refresh_failed: ${summarizeOAuthErrorForSentry(e)}`),
      { source: 'MicrosoftOAuth', stage: 'refresh' },
    )
    throw e
  }

  const accessToken = (json.access_token || '').trim()
  const expiresIn = Number(json.expires_in || 0)
  if (!accessToken) throw new Error('Microsoft did not return access_token on refresh')
  // Microsoft rotates refresh_tokens on each refresh call (v2.0 docs).
  // Return the new one so callers can persist it via setOauthRefreshToken,
  // matching Microsoft's guidance that old refresh tokens may stop
  // working at any time. Absent from response → keep the existing stored
  // one; the check is caller-side.
  const rotatedRefreshToken = (json.refresh_token || '').trim()
  return {
    accessToken,
    expiresAt: Date.now() + Math.max(0, expiresIn) * 1000,
    ...(rotatedRefreshToken ? { refreshToken: rotatedRefreshToken } : {}),
  }
}
