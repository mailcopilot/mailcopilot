import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'

import { runGoogleOAuthFlow, type GoogleOAuthStage } from './googleOAuth'

// Helper: build a mock JWT with the given payload.
function mockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fake-signature`
}

/** Simulate the browser redirect back to the local OAuth server. Real HTTP so
 *  it bypasses the global fetch mock; retries because a busy runner can take
 *  seconds to bind the ephemeral port (same rationale as the Microsoft
 *  counterpart in microsoftOAuth.test.ts). The Google flow binds 127.0.0.1
 *  and its callback path is `/oauth/callback`. */
function simulateCallback(port: string | number, queryString: string): void {
  const MAX_ATTEMPTS = 20
  const BASE_DELAY_MS = 50
  const MAX_DELAY_MS = 1_000
  let attempt = 0
  const tryOnce = (): void => {
    attempt++
    const req = http.request(
      `http://127.0.0.1:${port}/oauth/callback?${queryString}`,
      { method: 'GET', timeout: 2_000 },
      () => { /* 200 means the flow accepted our redirect */ },
    )
    req.on('error', () => {
      if (attempt >= MAX_ATTEMPTS) return
      setTimeout(tryOnce, Math.min(BASE_DELAY_MS * attempt, MAX_DELAY_MS))
    })
    req.end()
  }
  setTimeout(tryOnce, BASE_DELAY_MS)
}

// Same CI escape hatch as microsoftOAuth.test.ts: GitLab's Docker-in-Docker
// runners block the test-side callback from reaching the flow's loopback
// listener. Tests that need no callback stay enabled everywhere.
const IS_CI = process.env.CI === 'true' || process.env.CI === '1'
const describeLocal = IS_CI ? describe.skip : describe

describe('googleOAuth', { timeout: 30_000 }, () => {
  describe('stage reporting (no callback needed)', () => {
    it('reports the browser stage before handing the URL to the browser', async () => {
      const stages: GoogleOAuthStage[] = []
      let stagesAtOpen: GoogleOAuthStage[] = []

      await runGoogleOAuthFlow({
        clientId: 'test-client',
        openExternal: () => { stagesAtOpen = [...stages] },
        onStage: (s) => stages.push(s),
        timeoutMs: 200,
      }).catch(() => { /* expected callback timeout */ })

      // The wizard swaps to the waiting step on click, so the very first
      // stage must already be known by the time the browser opens.
      expect(stagesAtOpen).toEqual(['browser'])
    })

    it('never lets a throwing progress listener break the flow', async () => {
      let opened = false

      await runGoogleOAuthFlow({
        clientId: 'test-client',
        openExternal: () => { opened = true },
        onStage: () => { throw new Error('listener blew up') },
        timeoutMs: 200,
      }).catch((e: unknown) => {
        // Only the callback timeout may surface — never the listener error.
        expect(String(e)).toContain('timeout')
      })

      expect(opened).toBe(true)
    })
  })

  describeLocal('profile extraction', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function runWithCallback(params: { onStage?: (s: GoogleOAuthStage) => void } = {}) {
      return runGoogleOAuthFlow({
        clientId: 'test-client',
        openExternal: (url) => {
          const parsed = new URL(url)
          const redirectUri = parsed.searchParams.get('redirect_uri')!
          const stateParam = parsed.searchParams.get('state')!
          simulateCallback(new URL(redirectUri).port, `code=test-code&state=${stateParam}`)
        },
        timeoutMs: 20_000,
        ...params,
      })
    }

    it('extracts the display name from the id_token name claim', { timeout: 15_000 }, async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'g-access',
          refresh_token: 'g-refresh',
          expires_in: 3600,
          id_token: mockJwt({ email: 'user@gmail.com', name: 'Ada Lovelace' }),
        })),
      })

      const result = await runWithCallback()

      // We request the `profile` scope; before §2.94 the claim was fetched
      // and discarded, leaving every freshly connected account nameless.
      expect(result.email).toBe('user@gmail.com')
      expect(result.displayName).toBe('Ada Lovelace')
    })

    it('yields an empty display name when the provider returned none', { timeout: 15_000 }, async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'g-access',
          refresh_token: 'g-refresh',
          expires_in: 3600,
          id_token: mockJwt({ email: 'user@gmail.com' }),
        })),
      })

      const result = await runWithCallback()

      // Never invent a name here — the caller decides the fallback.
      expect(result.displayName).toBe('')
      expect(result.email).toBe('user@gmail.com')
    })

    it('falls back to the userinfo document when the id_token carries no email', { timeout: 15_000 }, async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            access_token: 'g-access',
            refresh_token: 'g-refresh',
            expires_in: 3600,
            id_token: mockJwt({ sub: 'no-email-here' }),
          })),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            email: 'fallback@gmail.com',
            name: 'Grace Hopper',
          })),
        })

      const result = await runWithCallback()

      expect(result.email).toBe('fallback@gmail.com')
      expect(result.displayName).toBe('Grace Hopper')
    })

    // codex-bg-review Medium #1: the claim is provider-controlled and ends up
    // in the From mailbox, so it goes through normalizeProviderDisplayName.
    it('drops a name claim carrying a header-injection payload', { timeout: 15_000 }, async () => {
      const CRLF = String.fromCharCode(0x0d) + String.fromCharCode(0x0a)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'g-access',
          refresh_token: 'g-refresh',
          expires_in: 3600,
          id_token: mockJwt({ email: 'user@gmail.com', name: `Ada${CRLF}Bcc: attacker@evil.test` }),
        })),
      })

      const result = await runWithCallback()

      expect(result.displayName).toBe('')
      // Sign-in still succeeds — a bad name must never cost the user the account.
      expect(result.email).toBe('user@gmail.com')
    })

    it('survives a non-string name claim instead of throwing after authorization', { timeout: 15_000 }, async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'g-access',
          refresh_token: 'g-refresh',
          expires_in: 3600,
          id_token: mockJwt({ email: 'user@gmail.com', name: 42 }),
        })),
      })

      const result = await runWithCallback()

      expect(result.displayName).toBe('')
      expect(result.email).toBe('user@gmail.com')
    })

    // codex-bg-review (final pass) Low #1: a successful body of `null` used to
    // throw on property access, after the user had already authorized.
    it('degrades instead of throwing when the userinfo document is null', { timeout: 15_000 }, async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            access_token: 'g-access',
            refresh_token: 'g-refresh',
            expires_in: 3600,
            id_token: mockJwt({ sub: 'no-email-here' }),
          })),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('null'),
        })

      // The flow still fails — there is no email to be had — but with the
      // domain error, not a TypeError from reading a property of null.
      await expect(runWithCallback()).rejects.toThrow('Could not retrieve user email from Google')
    })

    it('reports the token stage once the browser round trip is over', { timeout: 15_000 }, async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          access_token: 'g-access',
          refresh_token: 'g-refresh',
          expires_in: 3600,
          id_token: mockJwt({ email: 'user@gmail.com', name: 'Ada Lovelace' }),
        })),
      })

      const stages: GoogleOAuthStage[] = []
      await runWithCallback({ onStage: (s) => stages.push(s) })

      // Order matters: 'token' is what tells the wizard to stop pointing the
      // user at the browser and start explaining the in-app wait.
      expect(stages).toEqual(['browser', 'token'])
    })
  })
})
