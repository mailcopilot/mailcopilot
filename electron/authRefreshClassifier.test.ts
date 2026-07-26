import { describe, expect, it } from 'vitest'
import { classifyRefreshError, AADSTS_REFRESH_EXPIRED_CODES } from './authRefreshClassifier'

// CM1 contract: the classifier must only bucket AADSTS codes from an
// explicit whitelist as `refresh_token_expired`. A blanket regex on
// /AADSTS\d+/ would over-classify invalid_client / tenant / policy codes
// as "token expired" and corrupt triage dashboards.

describe('classifyRefreshError — AADSTS whitelist + OAuth2 reasons', () => {
  describe('refresh_token_expired bucket', () => {
    it('AADSTS70043 (refresh token expired — inactivity) -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('AADSTS70043: The refresh token has expired'))).toBe('refresh_token_expired')
    })

    it('AADSTS700082 (inactivity expiry) -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('AADSTS700082: The refresh token has expired due to inactivity'))).toBe('refresh_token_expired')
    })

    it('AADSTS700084 (user signed out) -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('AADSTS700084: The refresh token was issued on ...'))).toBe('refresh_token_expired')
    })

    it('AADSTS50076 (MFA / conditional access required) -> refresh_token_expired', () => {
      // Microsoft docs: "Due to a configuration change made by your
      // administrator, or because you moved to a new location, you must
      // use multifactor authentication to access … Retry with a new
      // authorize request." Behavior from the IMAP caller's perspective
      // is identical to refresh_token_expired: interactive re-auth is
      // required to regain access.
      expect(classifyRefreshError(new Error("AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication to access '00000002-0000-0000-c000-000000000000'."))).toBe('refresh_token_expired')
    })

    it('AADSTS50078 (strong auth required) -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('AADSTS50078: User needs to perform strong auth'))).toBe('refresh_token_expired')
    })

    it('AADSTS50005 (user strong auth required) -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('AADSTS50005: User strong auth required'))).toBe('refresh_token_expired')
    })

    it('AADSTS50173 (fresh auth required) -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('AADSTS50173: The provided grant has expired'))).toBe('refresh_token_expired')
    })

    it('AADSTS50144 (password must be changed) -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('AADSTS50144: User password must be reset'))).toBe('refresh_token_expired')
    })

    it('plain invalid_grant (Google / non-AADSTS Microsoft) -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('Token exchange failed: invalid_grant'))).toBe('refresh_token_expired')
    })

    it('invalid_grant embedded in longer message -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('OAuth2 error: error=invalid_grant, description=Bad Request'))).toBe('refresh_token_expired')
    })

    it('verbose "refresh token expired" phrasing without a code -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('Your refresh token has expired. Please re-authenticate.'))).toBe('refresh_token_expired')
    })

    it('verbose "refresh token revoked" -> refresh_token_expired', () => {
      expect(classifyRefreshError(new Error('Refresh token was revoked by the user'))).toBe('refresh_token_expired')
    })
  })

  describe('unknown bucket (non-expiry AADSTS codes must NOT be over-classified)', () => {
    it('AADSTS50011 (invalid reply URL / redirect) -> unknown', () => {
      expect(classifyRefreshError(new Error('AADSTS50011: The reply URL specified does not match'))).toBe('unknown')
    })

    it('AADSTS7000215 (invalid client secret) -> unknown', () => {
      expect(classifyRefreshError(new Error('AADSTS7000215: Invalid client secret is provided'))).toBe('unknown')
    })

    it('AADSTS50020 (user not found in tenant) -> unknown', () => {
      expect(classifyRefreshError(new Error('AADSTS50020: User account does not exist in tenant'))).toBe('unknown')
    })

    it('AADSTS99999 (made-up code) -> unknown', () => {
      expect(classifyRefreshError(new Error('AADSTS99999: totally unknown error'))).toBe('unknown')
    })

    it('generic Azure error without AADSTS prefix -> unknown', () => {
      expect(classifyRefreshError(new Error('Azure returned a 400 Bad Request'))).toBe('unknown')
    })
  })

  describe('network bucket', () => {
    it('ECONNRESET -> network', () => {
      expect(classifyRefreshError(new Error('fetch failed: ECONNRESET'))).toBe('network')
    })

    it('ETIMEDOUT -> network', () => {
      expect(classifyRefreshError(new Error('connect ETIMEDOUT'))).toBe('network')
    })

    it('ENOTFOUND -> network', () => {
      expect(classifyRefreshError(new Error('getaddrinfo ENOTFOUND login.microsoftonline.com'))).toBe('network')
    })

    it('EPIPE -> network', () => {
      expect(classifyRefreshError(new Error('write EPIPE'))).toBe('network')
    })

    it('ECONNABORTED -> network', () => {
      expect(classifyRefreshError(new Error('ECONNABORTED during HTTPS handshake'))).toBe('network')
    })

    it('bare "network" token -> network', () => {
      expect(classifyRefreshError(new Error('network is unreachable'))).toBe('network')
    })

    it('"fetch failed" -> network', () => {
      expect(classifyRefreshError(new Error('fetch failed'))).toBe('network')
    })

    it('network wins over later AADSTS match when both appear', () => {
      // Pathological input: a message containing both a network error and
      // an AADSTS token. Network classification comes first and is the
      // most useful triage signal here — the HTTP call didn't even
      // complete, so any AADSTS code in the text is coincidental.
      expect(classifyRefreshError(new Error('ETIMEDOUT — context included AADSTS70043 from prior log line'))).toBe('network')
    })
  })

  describe('edge cases and PII safety', () => {
    it('non-Error input (string) is coerced and classified', () => {
      expect(classifyRefreshError('invalid_grant')).toBe('refresh_token_expired')
    })

    it('non-Error input (object) is coerced via String()', () => {
      expect(classifyRefreshError({ foo: 'bar' })).toBe('unknown')
    })

    it('empty message -> unknown', () => {
      expect(classifyRefreshError(new Error(''))).toBe('unknown')
    })

    it('null -> unknown', () => {
      expect(classifyRefreshError(null)).toBe('unknown')
    })

    it('undefined -> unknown', () => {
      expect(classifyRefreshError(undefined)).toBe('unknown')
    })

    it('return type is only one of three literals regardless of input', () => {
      // Soft guarantee: the classifier is the sole source of values going
      // into the auth_refresh_failure_reason tag. No code path returns
      // anything else.
      const inputs: unknown[] = [
        new Error('anything'),
        'random string',
        42,
        null,
        undefined,
        { some: 'object' },
        new Error('AADSTS99999: whatever'),
      ]
      const validReasons = new Set(['refresh_token_expired', 'network', 'unknown'])
      for (const input of inputs) {
        expect(validReasons.has(classifyRefreshError(input))).toBe(true)
      }
    })
  })

  describe('whitelist structure', () => {
    it('whitelist is not empty and every entry starts with AADSTS', () => {
      expect(AADSTS_REFRESH_EXPIRED_CODES.length).toBeGreaterThan(0)
      for (const code of AADSTS_REFRESH_EXPIRED_CODES) {
        expect(code).toMatch(/^AADSTS\d{3,6}$/)
      }
    })

    it('every whitelisted code classifies as refresh_token_expired', () => {
      // Contract test: if a code is added to the whitelist, it MUST be
      // matched by the classifier. Guards against typos or regex drift.
      for (const code of AADSTS_REFRESH_EXPIRED_CODES) {
        expect(classifyRefreshError(new Error(`${code}: irrelevant description`))).toBe('refresh_token_expired')
      }
    })
  })
})
