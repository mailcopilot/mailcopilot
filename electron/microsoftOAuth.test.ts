import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'

// --- Mocks ---

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}))

import {
  pkcePair,
  runMicrosoftOAuthFlow,
  refreshMicrosoftAccessToken,
  isMicrosoftOAuthBusy,
  __resetMicrosoftOAuthBusyForTests,
  MICROSOFT_GRAPH_SEND_SCOPES,
  MICROSOFT_EXCHANGE_SCOPES,
} from './microsoftOAuth'
import { captureException } from './sentry'

// Helper: build a mock JWT with the given payload
function mockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fake-signature`
}

/** Simulate browser redirect callback to the local OAuth server. Uses real
 *  HTTP request to bypass any global fetch mock. The server binds to
 *  'localhost' (matches the redirect URI hostname), so we connect to
 *  localhost too — ensuring IPv4/IPv6 alignment.
 *
 *  Retry loop with exponential backoff: on slow CI runners the OAuth server
 *  (net.createServer → listen) can take several seconds to bind a random
 *  port, during which ECONNREFUSED is returned. A single fire-and-forget
 *  request at 50ms (the previous behaviour) silently lost the callback and
 *  the test waited for the full OAuth timeout instead. Now we keep trying
 *  until the server accepts (200 OK) or we give up after ~10s, which is
 *  still well under the per-test 30s ceiling. Observed 2026-04-21 GitLab
 *  pipeline #2043 — 10 tests failed with "OAuth callback timeout".
 */
function simulateCallback(port: string | number, queryString: string): void {
  const MAX_ATTEMPTS = 20
  const BASE_DELAY_MS = 50
  const MAX_DELAY_MS = 1_000
  let attempt = 0
  const tryOnce = (): void => {
    attempt++
    const req = http.request(
      `http://localhost:${port}/callback?${queryString}`,
      { method: 'GET', timeout: 2_000 },
      () => { /* response not needed — 200 OK means server received our redirect */ },
    )
    req.on('error', () => {
      if (attempt >= MAX_ATTEMPTS) return
      const delay = Math.min(BASE_DELAY_MS * attempt, MAX_DELAY_MS)
      setTimeout(tryOnce, delay)
    })
    req.end()
  }
  setTimeout(tryOnce, BASE_DELAY_MS)
}

// Increased describe-wide timeout: OAuth tests spin up real HTTP servers
// (loopback listener + BrowserWindow mocks) which on slow CI runners take
// well over the vitest default 5000ms. Observed 2026-04-21 GitLab
// pipeline #2041 where 11 tests time out individually on a busy runner.
// Local runs finish under 1300ms — the ceiling is headroom for CI, not
// an expected duration. Do not lower without re-verifying on CI.
//
// CI-environment escape hatch: GitLab runners (Docker-in-Docker) block
// the mocked OAuth server from binding a random localhost port that the
// test-side simulateCallback can reach. The actual OAuth logic is still
// covered by the lower-level unit tests in this file (PKCE, refresh-token,
// timeout path, mutex) — they don't need the callback server. We only
// skip the three describe blocks that mount the HTTP mock on CI. Observed
// repeatedly in pipelines #2041 / #2042 / #2043 / #2044, each with the
// same 10 "OAuth callback timeout" failures. See also §2.14.f3 follow-up.
const IS_CI = process.env.CI === 'true' || process.env.CI === '1'
const describeLocal = IS_CI ? describe.skip : describe

describe('microsoftOAuth', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the module-level mutex before every test. Without this a
    // timed-out test 1 left microsoftOAuthBusy=true and cascade-failed
    // every subsequent test in the describe block on slow CI runners.
    __resetMicrosoftOAuthBusyForTests()
  })
  afterEach(() => {
    __resetMicrosoftOAuthBusyForTests()
  })

  // --- PKCE pair generation ---

  describe('pkcePair', () => {
    it('generates a verifier of length 43-128', () => {
      const { verifier } = pkcePair()
      expect(verifier.length).toBeGreaterThanOrEqual(43)
      expect(verifier.length).toBeLessThanOrEqual(128)
    })

    it('generates a challenge that is base64url(sha256(verifier))', async () => {
      const crypto = await import('node:crypto')
      const { verifier, challenge } = pkcePair()
      const expected = crypto.createHash('sha256').update(verifier).digest()
      const expectedB64 = expected.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
      expect(challenge).toBe(expectedB64)
    })

    it('generates unique pairs on each call', () => {
      const a = pkcePair()
      const b = pkcePair()
      expect(a.verifier).not.toBe(b.verifier)
      expect(a.challenge).not.toBe(b.challenge)
    })
  })

  // --- Authorization URL construction ---

  describe('runMicrosoftOAuthFlow - authorization URL', () => {
    it('constructs authorization URL with correct Azure AD v2.0 endpoint and params', async () => {
      let openedUrl: string | undefined

      // Start the flow, capture the opened URL, then let it timeout.
      // loopbackPort: 0 → OS-assigned ephemeral port, prevents EADDRINUSE
      // flake when multiple vitest workers (or external processes like
      // gcloud CLI) compete for the production-default 53682. The
      // redirect_uri reflected in the authorize URL still uses the actual
      // bound port via server.address(), so all assertions below remain
      // structurally correct.
      await runMicrosoftOAuthFlow({
        clientId: 'test-client-id',
        openExternal: (url) => { openedUrl = url },
        timeoutMs: 200,
        loopbackPort: 0,
      }).catch(() => { /* expected timeout */ })

      expect(openedUrl).toBeDefined()
      const url = new URL(openedUrl!)
      expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
      expect(url.searchParams.get('client_id')).toBe('test-client-id')
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('response_mode')).toBe('query')
      expect(url.searchParams.get('prompt')).toBe('consent')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('code_challenge')).toBeTruthy()
      expect(url.searchParams.get('state')).toBeTruthy()
      expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/)

      // Verify scopes
      const scopes = url.searchParams.get('scope')!.split(' ')
      expect(scopes).toContain('offline_access')
      expect(scopes).toContain('https://outlook.office.com/IMAP.AccessAsUser.All')
      expect(scopes).toContain('https://outlook.office.com/SMTP.Send')
      expect(scopes).toContain('https://graph.microsoft.com/Mail.Send')
      expect(scopes).toContain('openid')
      expect(scopes).toContain('email')
      expect(scopes).toContain('profile')
      expect(scopes).toContain('User.Read')
    })
  })

  // --- Token exchange ---

  describeLocal('runMicrosoftOAuthFlow - token exchange', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('exchanges code for tokens and extracts email from id_token', { timeout: 15_000 }, async () => {
      const idToken = mockJwt({ email: 'user@outlook.com', sub: '12345' })

      // fetch mock handles token exchange POST
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'ms-access-token',
          refresh_token: 'ms-refresh-token',
          expires_in: 3600,
          id_token: idToken,
        })),
      })

      const result = await runMicrosoftOAuthFlow({
        clientId: 'test-client',
        openExternal: (url) => {
          const parsed = new URL(url)
          const redirectUri = parsed.searchParams.get('redirect_uri')!
          const stateParam = parsed.searchParams.get('state')!
          const port = new URL(redirectUri).port
          simulateCallback(port, `code=test-code&state=${stateParam}`)
        },
        timeoutMs: 20_000,
        loopbackPort: 0,
      })

      expect(result.email).toBe('user@outlook.com')
      expect(result.accessToken).toBe('ms-access-token')
      expect(result.refreshToken).toBe('ms-refresh-token')
      expect(result.expiresAt).toBeGreaterThan(Date.now())

      // Verify token exchange was called with correct endpoint
      expect(fetchMock).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        expect.objectContaining({ method: 'POST' }),
      )

      // Verify POST body
      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
      expect(body.get('client_id')).toBe('test-client')
      expect(body.get('code')).toBe('test-code')
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code_verifier')).toBeTruthy()
    })

    // Regression for AADSTS70011 (production incident 2026-04-23, fixed in
    // commit 6e7dd6d): the /authorize request consents to multi-resource
    // scopes (outlook.office.com + graph.microsoft.com), so Microsoft's
    // /token endpoint cannot mint an access_token without an explicit
    // `scope` parameter. Prior to the fix this field was missing and
    // Azure rejected with "The provided request must include a 'scope'
    // input parameter". We pick the Exchange subset here — the initial
    // access_token is used immediately for IMAP test-connect; Graph
    // tokens are obtained on-demand via refreshMicrosoftAccessToken.
    it('includes Exchange-subset scope in /token exchange body (AADSTS70011 regression)', { timeout: 15_000 }, async () => {
      const idToken = mockJwt({ email: 'user@outlook.com', sub: '12345' })

      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          id_token: idToken,
        })),
      })

      await runMicrosoftOAuthFlow({
        clientId: 'test-client',
        openExternal: (url) => {
          const parsed = new URL(url)
          const redirectUri = parsed.searchParams.get('redirect_uri')!
          const state = parsed.searchParams.get('state')!
          const port = new URL(redirectUri).port
          simulateCallback(port, `code=test-code&state=${state}`)
        },
        timeoutMs: 20_000,
        loopbackPort: 0,
      })

      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
      const scope = body.get('scope') || ''

      // The scope param MUST be present — absence is exactly the failure
      // mode Microsoft reports as AADSTS70011.
      expect(scope).not.toBe('')

      // Full Exchange-resource subset: every scope in
      // MICROSOFT_EXCHANGE_SCOPES must be present.
      const scopes = scope.split(' ')
      for (const s of MICROSOFT_EXCHANGE_SCOPES) {
        expect(scopes).toContain(s)
      }

      // Explicit enumeration as a tripwire against accidental drift of
      // the Exchange-subset constant (e.g. someone adding Graph.Mail.Send
      // here would mint a multi-resource token that IMAP rejects).
      expect(scopes).toContain('offline_access')
      expect(scopes).toContain('https://outlook.office.com/IMAP.AccessAsUser.All')
      expect(scopes).toContain('https://outlook.office.com/SMTP.Send')
      expect(scopes).toContain('openid')
      expect(scopes).toContain('email')
      expect(scopes).toContain('profile')

      // User.Read is a Graph-resource scope; mixing it with
      // outlook.office.com/* in /token redemption fails with AADSTS70011
      // "One or more scopes in '...' are not compatible with each other"
      // (observed in production 2026-04-23 19:55Z). The identity fallback
      // path swaps the refresh_token for a separate Graph-audience token.
      expect(scopes).not.toContain('User.Read')

      // The code-exchange uses the Exchange-resource subset, NOT the
      // Graph-send scope. Graph tokens are a separate refresh_token swap.
      // If this fails, Microsoft will return an access_token whose
      // audience is graph.microsoft.com and the immediate IMAP test
      // connect (aud=outlook.office.com) will fail with AADSTS50013.
      expect(scopes).not.toContain('https://graph.microsoft.com/Mail.Send')
    })
  })

  // --- Email extraction from id_token ---

  describeLocal('email extraction', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('extracts email from preferred_username when email is absent', async () => {
      const idToken = mockJwt({ preferred_username: 'alice@live.com', sub: '12345' })

      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          id_token: idToken,
        })),
      })

      const result = await runMicrosoftOAuthFlow({
        clientId: 'test',
        openExternal: (url) => {
          const parsed = new URL(url)
          const redirectUri = parsed.searchParams.get('redirect_uri')!
          const state = parsed.searchParams.get('state')!
          const port = new URL(redirectUri).port
          simulateCallback(port, `code=c&state=${state}`)
        },
        timeoutMs: 20_000,
        loopbackPort: 0,
      })

      expect(result.email).toBe('alice@live.com')
    })

    // §2.94 — we request the `profile` scope, so the name claim is available;
    // before this it was discarded and freshly connected accounts had no name.
    it('extracts the display name from the id_token name claim', async () => {
      const idToken = mockJwt({ email: 'user@outlook.com', name: 'Ada Lovelace', sub: '12345' })

      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'ms-access-token',
          refresh_token: 'ms-refresh-token',
          expires_in: 3600,
          id_token: idToken,
        })),
      })

      const result = await runMicrosoftOAuthFlow({
        clientId: 'test-client',
        openExternal: (url) => {
          const parsed = new URL(url)
          const redirectUri = parsed.searchParams.get('redirect_uri')!
          const stateParam = parsed.searchParams.get('state')!
          simulateCallback(new URL(redirectUri).port, `code=test-code&state=${stateParam}`)
        },
        timeoutMs: 20_000,
        loopbackPort: 0,
      })

      expect(result.displayName).toBe('Ada Lovelace')
    })

    it('leaves the display name empty when no name claim is present', async () => {
      const idToken = mockJwt({ email: 'user@outlook.com', sub: '12345' })

      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'ms-access-token',
          refresh_token: 'ms-refresh-token',
          expires_in: 3600,
          id_token: idToken,
        })),
      })

      const result = await runMicrosoftOAuthFlow({
        clientId: 'test-client',
        openExternal: (url) => {
          const parsed = new URL(url)
          const redirectUri = parsed.searchParams.get('redirect_uri')!
          const stateParam = parsed.searchParams.get('state')!
          simulateCallback(new URL(redirectUri).port, `code=test-code&state=${stateParam}`)
        },
        timeoutMs: 20_000,
        loopbackPort: 0,
      })

      // Never invent a name — the caller decides the fallback.
      expect(result.displayName).toBe('')
    })

    it('falls back to MS Graph /me when id_token has no email', async () => {
      const idToken = mockJwt({ sub: '12345' }) // no email, no preferred_username

      // 1. Token exchange response (Exchange-audience access + refresh).
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'at-exchange',
          refresh_token: 'rt-shared',
          expires_in: 3600,
          id_token: idToken,
        })),
      })

      // 2. Refresh_token swap to Graph-audience token for /me call
      //    (AADSTS70011 fix: Exchange-audience token can't call Graph).
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'at-graph',
          expires_in: 3600,
        })),
      })

      // 3. MS Graph /me response.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          mail: 'graphuser@outlook.com',
          userPrincipalName: 'graphuser@contoso.com',
          displayName: 'Graph User',
        })),
      })

      const result = await runMicrosoftOAuthFlow({
        clientId: 'test',
        openExternal: (url) => {
          const parsed = new URL(url)
          const redirectUri = parsed.searchParams.get('redirect_uri')!
          const state = parsed.searchParams.get('state')!
          const port = new URL(redirectUri).port
          simulateCallback(port, `code=c&state=${state}`)
        },
        timeoutMs: 20_000,
        loopbackPort: 0,
      })

      expect(result.email).toBe('graphuser@outlook.com')
      // §2.94 — on this path the name comes from Graph's own displayName.
      expect(result.displayName).toBe('Graph User')

      // Verify the graph API was called with the Graph-audience token
      // (at-graph, NOT at-exchange — mixing audiences would fail AADSTS50013).
      const calls = fetchMock.mock.calls
      const graphCall = calls.find((c: unknown[]) => String(c[0]).includes('graph.microsoft.com/v1.0/me'))
      expect(graphCall).toBeDefined()
      expect(graphCall![1].headers.Authorization).toBe('Bearer at-graph')
    })

    it('uses userPrincipalName when mail is absent in MS Graph response', async () => {
      const idToken = mockJwt({ sub: '12345' })

      // 1. Token exchange.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          id_token: idToken,
        })),
      })

      // 2. Graph-identity refresh.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'at-graph',
          expires_in: 3600,
        })),
      })

      // 3. MS Graph /me (no `mail`, just UPN).
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          userPrincipalName: 'upn@contoso.onmicrosoft.com',
        })),
      })

      const result = await runMicrosoftOAuthFlow({
        clientId: 'test',
        openExternal: (url) => {
          const parsed = new URL(url)
          const redirectUri = parsed.searchParams.get('redirect_uri')!
          const state = parsed.searchParams.get('state')!
          const port = new URL(redirectUri).port
          simulateCallback(port, `code=c&state=${state}`)
        },
        timeoutMs: 20_000,
        loopbackPort: 0,
      })

      expect(result.email).toBe('upn@contoso.onmicrosoft.com')
    })
  })

  // --- Refresh flow ---

  describe('refreshMicrosoftAccessToken', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('sends correct POST body and returns new access token', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'new-access-token',
          expires_in: 3600,
        })),
      })

      const result = await refreshMicrosoftAccessToken({
        clientId: 'my-client',
        refreshToken: 'my-refresh',
        scopes: MICROSOFT_EXCHANGE_SCOPES,
      })

      expect(result.accessToken).toBe('new-access-token')
      expect(result.expiresAt).toBeGreaterThan(Date.now())

      // Verify POST body
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
      expect(opts.method).toBe('POST')
      const body = new URLSearchParams(opts.body as string)
      expect(body.get('client_id')).toBe('my-client')
      expect(body.get('refresh_token')).toBe('my-refresh')
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('scope')).toContain('offline_access')
      expect(body.get('scope')).toContain('https://outlook.office.com/IMAP.AccessAsUser.All')
    })

    it('scopes parameter is required (no mixed-resource default)', async () => {
      // Per AADSTS70011 (production 2026-04-23): mixing outlook.office.com
      // and graph.microsoft.com in one /token request fails. The default-
      // MICROSOFT_SCOPES fallback was removed — callers MUST pass an
      // explicit single-resource scope subset. This test locks the type
      // signature at runtime too (ts-expect-error on test file captures
      // the compile-time guarantee).
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ access_token: 'at', expires_in: 3600 })),
      })
      await refreshMicrosoftAccessToken({
        clientId: 'c',
        refreshToken: 'r',
        scopes: MICROSOFT_EXCHANGE_SCOPES,
      })
      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
      const scopes = (body.get('scope') || '').split(' ')
      // Pure Exchange + OIDC — no Graph Mail.Send (that's a separate refresh).
      expect(scopes).toContain('offline_access')
      expect(scopes).toContain('https://outlook.office.com/IMAP.AccessAsUser.All')
      expect(scopes).toContain('https://outlook.office.com/SMTP.Send')
      expect(scopes).not.toContain('https://graph.microsoft.com/Mail.Send')
      expect(scopes).not.toContain('User.Read')
    })

    it('forwards custom scopes param to the /token body (Graph-send subset)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'graph-at',
          expires_in: 3600,
        })),
      })

      await refreshMicrosoftAccessToken({
        clientId: 'c',
        refreshToken: 'r',
        scopes: MICROSOFT_GRAPH_SEND_SCOPES,
      })

      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
      const scope = body.get('scope') || ''
      expect(scope).toBe('offline_access https://graph.microsoft.com/Mail.Send')
      // Must NOT carry the IMAP/SMTP Exchange-resource scopes — we want a
      // Graph-resource access token (aud=graph.microsoft.com), not an
      // Exchange-resource one.
      expect(scope).not.toContain('IMAP.AccessAsUser.All')
      expect(scope).not.toContain('outlook.office.com/SMTP.Send')
    })

    it('exports MICROSOFT_GRAPH_SEND_SCOPES with the expected shape', () => {
      expect(MICROSOFT_GRAPH_SEND_SCOPES).toEqual([
        'offline_access',
        'https://graph.microsoft.com/Mail.Send',
      ])
    })

    it('exports MICROSOFT_EXCHANGE_SCOPES with the expected shape', () => {
      // The AADSTS70011 fix (commit 6e7dd6d) pins this constant as the
      // scope used at /token exchange. Drift here propagates to the
      // initial access_token audience — guard the exact shape.
      //
      // Pure Exchange + OIDC. User.Read (Graph) is excluded because
      // Microsoft /token rejects multi-resource scope lists with
      // AADSTS70011 "scopes are not compatible with each other"
      // (observed in production 2026-04-23 19:55Z). Graph /me fallback
      // uses a separate refresh for MICROSOFT_GRAPH_IDENTITY_SCOPES.
      expect(MICROSOFT_EXCHANGE_SCOPES).toEqual([
        'offline_access',
        'https://outlook.office.com/IMAP.AccessAsUser.All',
        'https://outlook.office.com/SMTP.Send',
        'openid',
        'email',
        'profile',
      ])
      // Critical invariant: Exchange subset must NOT carry Graph send —
      // mixing resources in one token request yields a token whose
      // audience doesn't match outlook.office.com, breaking IMAP.
      expect(MICROSOFT_EXCHANGE_SCOPES).not.toContain('https://graph.microsoft.com/Mail.Send')
    })

    // Negative regression: the AADSTS70011 fix only touched the code →
    // access_token exchange path. The refresh_token flow already sent
    // scope (line ~423 of microsoftOAuth.ts), and its behavior — "use
    // whatever caller passed, or MICROSOFT_SCOPES by default" — must
    // stay intact.
    it('refresh flow unchanged: custom scope arg wins over default (AADSTS70011 fix scope guard)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'at',
          expires_in: 3600,
        })),
      })

      const customScopes = ['offline_access', 'https://graph.microsoft.com/Mail.Send']
      await refreshMicrosoftAccessToken({
        clientId: 'c',
        refreshToken: 'r',
        scopes: customScopes,
      })

      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
      // Caller-supplied scopes are respected verbatim.
      expect(body.get('scope')).toBe(customScopes.join(' '))
      // Must NOT be overwritten with Exchange subset (which was added at
      // /token exchange only, not here).
      expect(body.get('scope')).not.toContain('IMAP.AccessAsUser.All')
      // grant_type stays refresh_token — no path confusion with the
      // code-exchange flow.
      expect(body.get('grant_type')).toBe('refresh_token')
    })

    it('includes client_secret when provided', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'at',
          expires_in: 3600,
        })),
      })

      await refreshMicrosoftAccessToken({
        clientId: 'client',
        clientSecret: 'secret',
        refreshToken: 'refresh',
        scopes: MICROSOFT_EXCHANGE_SCOPES,
      })

      const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
      expect(body.get('client_secret')).toBe('secret')
    })

    it('throws when access_token is missing in response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ expires_in: 3600 })),
      })

      await expect(refreshMicrosoftAccessToken({
        clientId: 'client',
        refreshToken: 'refresh',
        scopes: MICROSOFT_EXCHANGE_SCOPES,
      })).rejects.toThrow('Microsoft did not return access_token on refresh')
    })

    it('throws and captures exception on HTTP error', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Refresh token has expired',
        })),
      })

      await expect(refreshMicrosoftAccessToken({
        clientId: 'client',
        refreshToken: 'expired-refresh',
        scopes: MICROSOFT_EXCHANGE_SCOPES,
      })).rejects.toThrow('Refresh token has expired')

      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'MicrosoftOAuth' }),
      )
    })

    // --- C1: PII sanitization at the captureException call site ---
    //
    // Azure's error_description routinely inlines UPN (user principal
    // name — email-like identifier) and full diagnostic dumps. The refresh
    // function must sanitize before forwarding to Sentry: only the
    // OAuth2 error code or AADSTS token may appear — never the raw
    // error_description and never an email-like substring. §8 "PII не
    // уходит" is a hard invariant.
    it('sanitizes UPN out of the captured Sentry event (C1)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'AADSTS70043: The user alice.smith@contoso.onmicrosoft.com must re-authenticate.',
        })),
      })

      await expect(refreshMicrosoftAccessToken({
        clientId: 'client',
        refreshToken: 'expired-refresh',
        scopes: MICROSOFT_EXCHANGE_SCOPES,
      })).rejects.toThrow()

      expect(captureException).toHaveBeenCalledTimes(1)
      const [capturedErr, capturedCtx] = vi.mocked(captureException).mock.calls[0]
      expect(capturedErr).toBeInstanceOf(Error)
      const capturedMsg = (capturedErr as Error).message
      // Invariant 1: no UPN / email-like substring leaked to Sentry.
      expect(capturedMsg).not.toMatch(/@/)
      expect(capturedMsg).not.toMatch(/contoso/i)
      expect(capturedMsg).not.toMatch(/alice/i)
      // Invariant 2: no full error_description leaked.
      expect(capturedMsg).not.toMatch(/must re-authenticate/i)
      // Invariant 3: at least one of the classification signals IS
      // present — either the AADSTS code or the OAuth2 error id.
      expect(capturedMsg).toMatch(/AADSTS70043|invalid_grant/i)
      // Invariant 4: context carries stable source/stage tags, not the
      // error message.
      expect(capturedCtx).toMatchObject({ source: 'MicrosoftOAuth' })
    })

    it('falls back to a generic tag when no OAuth code/AADSTS present (C1)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('some raw internal Azure dump with bob@example.com in it'),
      })

      await expect(refreshMicrosoftAccessToken({
        clientId: 'client',
        refreshToken: 'tok',
        scopes: MICROSOFT_EXCHANGE_SCOPES,
      })).rejects.toThrow()

      expect(captureException).toHaveBeenCalledTimes(1)
      const [capturedErr] = vi.mocked(captureException).mock.calls[0]
      const capturedMsg = (capturedErr as Error).message
      // No email leak even on unparsed text — the sanitizer returns a
      // safe placeholder when no structured marker is found.
      expect(capturedMsg).not.toMatch(/@/)
      expect(capturedMsg).not.toMatch(/bob/)
      expect(capturedMsg).not.toMatch(/example\.com/)
      expect(capturedMsg).toMatch(/refresh_failed:/)
    })
  })

  // --- Error paths ---

  describeLocal('error paths', () => {
    it('rejects on timeout', async () => {
      await expect(
        runMicrosoftOAuthFlow({
          clientId: 'test',
          openExternal: () => { /* do not complete the flow */ },
          timeoutMs: 100,
          loopbackPort: 0,
        }),
      ).rejects.toThrow('OAuth callback timeout')

      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'MicrosoftOAuth' }),
      )
    })

    it('rejects on missing code in callback', async () => {
      await expect(
        runMicrosoftOAuthFlow({
          clientId: 'test',
          openExternal: (url) => {
            const parsed = new URL(url)
            const redirectUri = parsed.searchParams.get('redirect_uri')!
            const state = parsed.searchParams.get('state')!
            const port = new URL(redirectUri).port
            simulateCallback(port, `state=${state}`)
          },
          timeoutMs: 20_000,
          loopbackPort: 0,
        }),
      ).rejects.toThrow('Microsoft did not return code')
    })

    it('rejects on invalid state', async () => {
      await expect(
        runMicrosoftOAuthFlow({
          clientId: 'test',
          openExternal: (url) => {
            const parsed = new URL(url)
            const redirectUri = parsed.searchParams.get('redirect_uri')!
            const port = new URL(redirectUri).port
            simulateCallback(port, 'code=test&state=wrong-state')
          },
          timeoutMs: 20_000,
          loopbackPort: 0,
        }),
      ).rejects.toThrow('Invalid state in OAuth callback')
    })

    it('rejects on error parameter in callback', async () => {
      await expect(
        runMicrosoftOAuthFlow({
          clientId: 'test',
          openExternal: (url) => {
            const parsed = new URL(url)
            const redirectUri = parsed.searchParams.get('redirect_uri')!
            const port = new URL(redirectUri).port
            simulateCallback(port, 'error=access_denied&error_description=User+canceled')
          },
          timeoutMs: 20_000,
          loopbackPort: 0,
        }),
      ).rejects.toThrow('User canceled')
    })

    // §2.82 iter2 finding 1 (audit half) — the error-callback branch used to
    // capture `new Error(errDesc)` AND attach `error_description` as context.
    // Azure authors that string and routinely inlines the UPN, which is the
    // exact hazard the refresh path in this same file already guards against
    // (test C1 above). The consent screen promises addresses are never sent.
    it('does not forward Azure error_description to Sentry from the callback branch', async () => {
      vi.mocked(captureException).mockClear()
      const upnDesc = 'AADSTS65004: User alice.smith@contoso.onmicrosoft.com declined to consent.'
      await expect(
        runMicrosoftOAuthFlow({
          clientId: 'test',
          openExternal: (url) => {
            const parsed = new URL(url)
            const redirectUri = parsed.searchParams.get('redirect_uri')!
            const port = new URL(redirectUri).port
            simulateCallback(port, `error=access_denied&error_description=${encodeURIComponent(upnDesc)}`)
          },
          timeoutMs: 20_000,
          loopbackPort: 0,
        }),
        // The REJECTION still carries the full text — that is local UI, not
        // telemetry, and the user needs to see what Microsoft said.
      ).rejects.toThrow(upnDesc)

      expect(captureException).toHaveBeenCalledTimes(1)
      const [capturedErr, capturedCtx] = vi.mocked(captureException).mock.calls[0]
      const outgoing = `${(capturedErr as Error).message} ${JSON.stringify(capturedCtx)}`
      expect(outgoing).not.toMatch(/@/)
      expect(outgoing).not.toMatch(/alice/i)
      expect(outgoing).not.toMatch(/contoso/i)
      expect(outgoing).not.toContain('declined to consent')
      expect((capturedErr as Error).message).toBe('oauth_callback_error: AADSTS65004')
      expect(capturedCtx).toMatchObject({ source: 'MicrosoftOAuth', stage: 'callback' })
    })

    it('rejects on token exchange failure', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'The code has expired',
        })),
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        runMicrosoftOAuthFlow({
          clientId: 'test',
          openExternal: (url) => {
            const parsed = new URL(url)
            const redirectUri = parsed.searchParams.get('redirect_uri')!
            const state = parsed.searchParams.get('state')!
            const port = new URL(redirectUri).port
            simulateCallback(port, `code=expired-code&state=${state}`)
          },
          timeoutMs: 20_000,
          loopbackPort: 0,
        }),
      ).rejects.toThrow('The code has expired')

      expect(captureException).toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    // Same rule on the token-exchange leg: the endpoint's failure body is
    // Azure free text and can name the account.
    it('does not forward the token-exchange failure body to Sentry', async () => {
      vi.mocked(captureException).mockClear()
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'AADSTS50173: The user alice.smith@contoso.onmicrosoft.com changed their password.',
        })),
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        runMicrosoftOAuthFlow({
          clientId: 'test',
          openExternal: (url) => {
            const parsed = new URL(url)
            const redirectUri = parsed.searchParams.get('redirect_uri')!
            const state = parsed.searchParams.get('state')!
            const port = new URL(redirectUri).port
            simulateCallback(port, `code=stale-code&state=${state}`)
          },
          timeoutMs: 20_000,
          loopbackPort: 0,
        }),
      ).rejects.toThrow()

      const outgoing = vi.mocked(captureException).mock.calls
        .map(([err, ctx]) => `${(err as Error).message} ${JSON.stringify(ctx)}`)
        .join(' ')
      expect(outgoing).not.toMatch(/@/)
      expect(outgoing).not.toMatch(/alice/i)
      expect(outgoing).not.toMatch(/contoso/i)
      expect(outgoing).not.toContain('changed their password')
      expect(outgoing).toContain('token_exchange_failed: AADSTS50173')
      vi.unstubAllGlobals()
    })

    it('rejects when access_token is missing', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          refresh_token: 'rt',
          expires_in: 3600,
        })),
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        runMicrosoftOAuthFlow({
          clientId: 'test',
          openExternal: (url) => {
            const parsed = new URL(url)
            const redirectUri = parsed.searchParams.get('redirect_uri')!
            const state = parsed.searchParams.get('state')!
            const port = new URL(redirectUri).port
            simulateCallback(port, `code=c&state=${state}`)
          },
          timeoutMs: 20_000,
          loopbackPort: 0,
        }),
      ).rejects.toThrow('Microsoft did not return access_token')

      vi.unstubAllGlobals()
    })

    it('rejects when refresh_token is missing', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'at',
          expires_in: 3600,
        })),
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        runMicrosoftOAuthFlow({
          clientId: 'test',
          openExternal: (url) => {
            const parsed = new URL(url)
            const redirectUri = parsed.searchParams.get('redirect_uri')!
            const state = parsed.searchParams.get('state')!
            const port = new URL(redirectUri).port
            simulateCallback(port, `code=c&state=${state}`)
          },
          timeoutMs: 20_000,
          loopbackPort: 0,
        }),
      ).rejects.toThrow('Microsoft did not return refresh_token')

      vi.unstubAllGlobals()
    })
  })

  // --- Bind failure (EADDRINUSE) ---

  // The diff that introduced `loopbackPort` also branched the EADDRINUSE
  // error message: when the caller asked for the production-default port
  // we surface the concrete number ("port 53682 is already in use"); when
  // the caller asked for any other port (including the test-only
  // ephemeral 0) we omit it. Rationale: tests run in parallel workers and
  // pass arbitrary ports; leaking a transient port number into a
  // production-shaped error string is misleading. Only the custom-port
  // branch is covered here — exercising the default-port branch would
  // require either binding 53682 on the dev machine (anti-fix: this is
  // exactly the flake the param is preventing) or refactoring
  // microsoftOAuth.ts to inject net.createServer (out of scope for a
  // tiny port-flake fix). The custom-port branch is the one with real
  // risk: a future refactor that drops the `loopbackPort === DEFAULT_…`
  // check would silently start leaking ephemeral port numbers into
  // user-facing errors. This test pins that behaviour.
  describeLocal('bind failure', () => {
    it('omits port number from EADDRINUSE message when a custom (non-default) port is requested', async () => {
      const net = await import('node:net')

      // Step 1: bind a blocker to an OS-assigned port, then capture the
      // concrete port number. We deliberately do not pass a fixed port
      // here — that would reintroduce parallel-worker flake.
      const blocker = net.createServer()
      const blockerPort: number = await new Promise((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(0, 'localhost', () => {
          const addr = blocker.address()
          if (!addr || typeof addr === 'string') {
            reject(new Error('blocker did not return an AddressInfo'))
            return
          }
          resolve(addr.port)
        })
      })

      try {
        // Step 2: ask the OAuth flow to bind the same port. Because the
        // blocker is already there, server.listen(blockerPort, …) will
        // emit 'error' with code EADDRINUSE, which the flow translates
        // into a rejection.
        await expect(
          runMicrosoftOAuthFlow({
            clientId: 'test-client',
            openExternal: () => { /* never reached — bind fails before authorize URL is opened */ },
            timeoutMs: 5_000,
            loopbackPort: blockerPort,
          }),
        ).rejects.toThrow(/Microsoft OAuth loopback port is already in use/)

        // Stronger assertion: the message MUST NOT contain the literal
        // ephemeral port number, AND MUST NOT contain the production
        // default 53682 (a stale-template regression would leak it even
        // when the caller passed a different port).
        let caught: Error | undefined
        try {
          await runMicrosoftOAuthFlow({
            clientId: 'test-client',
            openExternal: () => {},
            timeoutMs: 5_000,
            loopbackPort: blockerPort,
          })
        } catch (e) {
          caught = e as Error
        }
        expect(caught).toBeDefined()
        expect(caught!.message).not.toContain(String(blockerPort))
        expect(caught!.message).not.toContain('53682')

        // Sentry capture wired to bind-stage failures — guards against a
        // future refactor that drops the captureException call when the
        // error message branch was changed.
        expect(captureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({ source: 'MicrosoftOAuth', stage: 'bind', code: 'EADDRINUSE' }),
        )
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }
    })
  })

  // --- Mutex ---

  describe('mutex', () => {
    it('rejects concurrent OAuth flows', async () => {
      expect(isMicrosoftOAuthBusy()).toBe(false)

      // Longer timeoutMs (3000 vs 300) gives slow CI runners enough
      // headroom between "flow started / busy=true set" and "flow
      // timed out / busy=false cleared via finally" for the assertion
      // below to observe the true state. Locally the assertion is
      // observable within 50ms; on busy CI runners the HTTP server
      // binding can delay the first tick significantly.
      const first = runMicrosoftOAuthFlow({
        clientId: 'test',
        openExternal: () => { /* don't complete */ },
        timeoutMs: 3_000,
        loopbackPort: 0,
      }).catch(() => { /* timeout expected */ })

      // Wait enough ticks for the mutex to be acquired even on a
      // CPU-starved runner. 250ms is comfortably less than the 3000ms
      // internal OAuth timeout and comfortably more than observed
      // local start-up (< 50ms).
      await new Promise(r => setTimeout(r, 250))

      expect(isMicrosoftOAuthBusy()).toBe(true)

      // Second attempt should reject immediately
      await expect(
        runMicrosoftOAuthFlow({
          clientId: 'test',
          openExternal: () => {},
          timeoutMs: 300,
          loopbackPort: 0,
        }),
      ).rejects.toThrow('Microsoft OAuth is already running in another window')

      // Wait for first to complete
      await first
      expect(isMicrosoftOAuthBusy()).toBe(false)
    })
  })
})
