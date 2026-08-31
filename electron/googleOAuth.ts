import http from 'node:http'
import crypto from 'node:crypto'
import { normalizeProviderDisplayName } from '../packages/core/providerDisplayName'

export type GoogleOAuthTokens = {
  email: string
  /** Human display name from the OIDC `name` claim (or the userinfo
   *  fallback). Empty string when the provider returned none — the caller
   *  decides how to fall back, this module never invents a name.
   *
   *  We already request the `profile` scope; before this field existed the
   *  claim was fetched and discarded, so freshly connected accounts had no
   *  name at all and every account picker showed a bare address. */
  displayName: string
  accessToken: string
  /** Epoch ms */
  expiresAt: number
  refreshToken: string
}

/** Coarse progress signal for the connect flow.
 *
 *  `browser` covers the whole out-of-app round trip; `token` fires the
 *  moment the redirect lands, which is what makes the following ~1 minute
 *  of server probing explainable to the user rather than looking hung. */
export type GoogleOAuthStage = 'browser' | 'token'

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function pkcePair(): { verifier: string; challenge: string } {
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

function extractProfileFromIdToken(idToken?: string): { email: string; displayName: string } {
  // The payload is attacker-influenceable (see normalizeProviderDisplayName):
  // read both fields as `unknown` rather than asserting their types, so a
  // non-string claim degrades instead of throwing mid-flow.
  const payload = idToken
    ? decodeJwtPayload<{ email?: unknown; name?: unknown }>(idToken)
    : undefined
  return {
    email: typeof payload?.email === 'string' ? payload.email.trim() : '',
    displayName: normalizeProviderDisplayName(payload?.name) ?? '',
  }
}

export async function runGoogleOAuthFlow(params: {
  clientId: string
  clientSecret?: string
  openExternal: (url: string) => void | Promise<void>
  timeoutMs?: number
  scopes?: string[]
  /** Best-effort progress sink. Never awaited and never allowed to fail the
   *  flow — a broken progress listener must not cost the user their sign-in. */
  onStage?: (stage: GoogleOAuthStage) => void
}): Promise<GoogleOAuthTokens> {
  const { clientId, clientSecret, openExternal } = params
  const emitStage = (stage: GoogleOAuthStage) => {
    try { params.onStage?.(stage) } catch { /* progress is advisory */ }
  }
  const timeoutMs = params.timeoutMs ?? 3 * 60 * 1000
  const scopes = params.scopes ?? ['https://mail.google.com/', 'openid', 'email', 'profile']
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
        if (url.pathname !== '/oauth/callback') {
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
          reject(new Error(errDesc || err))
          return
        }

        const gotState = url.searchParams.get('state') || ''
        const code = url.searchParams.get('code') || ''
        if (!code) throw new Error('Google did not return code')
        if (gotState !== state) throw new Error('Invalid state in OAuth callback')

        const addr = server.address()
        if (!addr || typeof addr === 'string') throw new Error('Could not determine OAuth callback port')

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(oauthHtml(pageMessages.doneTitle, pageMessages.doneText))
        resolve({ code, redirectUri: `http://127.0.0.1:${addr.port}/oauth/callback` })
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

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not start local OAuth server'))
        return
      }
      const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('redirect_uri', redirectUri)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('access_type', 'offline')
      authUrl.searchParams.set('prompt', 'consent')
      authUrl.searchParams.set('include_granted_scopes', 'true')
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('scope', scopes.join(' '))
      emitStage('browser')
      Promise.resolve(openExternal(authUrl.toString()))
        .catch((e) => {
          try { server.close() } catch { /* ignore */ }
          reject(e instanceof Error ? e : new Error(String(e)))
        })
    })

    const timeout = setTimeout(() => {
      try { server.close() } catch { /* ignore */ }
      reject(new Error('OAuth callback timeout'))
    }, timeoutMs)

    server.once('close', () => clearTimeout(timeout))
  })

  // The browser round trip is over — everything past this point happens
  // inside the app while the user waits at the wizard.
  emitStage('token')

  const tokenParams = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  if (clientSecret) tokenParams.set('client_secret', clientSecret)

  const tokenJson = await httpPostFormJson('https://oauth2.googleapis.com/token', tokenParams) as {
    access_token?: string
    expires_in?: number
    refresh_token?: string
    id_token?: string
  }

  const accessToken = (tokenJson.access_token || '').trim()
  const refreshToken = (tokenJson.refresh_token || '').trim()
  const expiresIn = Number(tokenJson.expires_in || 0)
  if (!accessToken) throw new Error('Google did not return access_token')
  if (!refreshToken) throw new Error('Google did not return refresh_token (check access_type=offline and prompt=consent)')

  const expiresAt = Date.now() + Math.max(0, expiresIn) * 1000

  // Usually email is available directly in id_token, but if missing — fallback to userinfo endpoint.
  const fromId = extractProfileFromIdToken(tokenJson.id_token)
  if (fromId.email) {
    return { email: fromId.email, displayName: fromId.displayName, accessToken, expiresAt, refreshToken }
  }

  const userinfoRaw: unknown = await httpGetJson('https://openidconnect.googleapis.com/v1/userinfo', {
    Authorization: `Bearer ${accessToken}`,
  })
  // Narrow the document itself, not just its fields: a successful body of
  // `null` (or a bare string) would otherwise throw on property access before
  // any field guard runs — after the user has already authorized.
  const userinfo: { email?: unknown; name?: unknown } =
    userinfoRaw && typeof userinfoRaw === 'object' ? userinfoRaw as { email?: unknown; name?: unknown } : {}
  const emailFromUserinfo = typeof userinfo.email === 'string' ? userinfo.email.trim() : ''
  if (!emailFromUserinfo) throw new Error('Could not retrieve user email from Google')

  // The id_token may still have carried a name even when it lacked an email;
  // prefer it, then the userinfo document. Same normalization on both paths.
  const displayName = fromId.displayName || (normalizeProviderDisplayName(userinfo.name) ?? '')

  return { email: emailFromUserinfo, displayName, accessToken, expiresAt, refreshToken }
}

export async function refreshGoogleAccessToken(params: { clientId: string; clientSecret?: string; refreshToken: string }): Promise<{ accessToken: string; expiresAt: number }> {
  const { clientId, clientSecret, refreshToken } = params
  const refreshParams = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  if (clientSecret) refreshParams.set('client_secret', clientSecret)

  const json = await httpPostFormJson('https://oauth2.googleapis.com/token', refreshParams) as { access_token?: string; expires_in?: number }

  const accessToken = (json.access_token || '').trim()
  const expiresIn = Number(json.expires_in || 0)
  if (!accessToken) throw new Error('Google did not return access_token on refresh')
  return { accessToken, expiresAt: Date.now() + Math.max(0, expiresIn) * 1000 }
}
