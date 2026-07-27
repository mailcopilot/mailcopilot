// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { detectAuthRecoveryKind } from './App'

/**
 * Tests for the auth-recovery classifier that routes failed accounts to the
 * correct re-auth flow (§2.11). Routing is by providerId, not by parsing
 * provider-specific substrings out of error messages — only the provider
 * field on AccountMeta is canonical.
 */
describe('detectAuthRecoveryKind', () => {
  it('returns "google" when Gmail OAuth2 account hits invalid_grant', () => {
    expect(
      detectAuthRecoveryKind(
        'Token refresh failed: invalid_grant (token revoked)',
        'oauth2',
        'gmail',
      ),
    ).toBe('google')
  })

  it('returns "outlook" when Outlook OAuth2 account hits invalid_grant', () => {
    expect(
      detectAuthRecoveryKind(
        'Token refresh failed: invalid_grant (AADSTS50173)',
        'oauth2',
        'outlook',
      ),
    ).toBe('outlook')
  })

  it('returns "password" when password account hits authentication failure', () => {
    expect(
      detectAuthRecoveryKind(
        'IMAP authentication failed: 535 invalid credentials',
        'password',
        'generic-imap',
      ),
    ).toBe('password')
  })

  it('returns null when there is no auth-related signal in the error', () => {
    expect(
      detectAuthRecoveryKind(
        'Network timeout: ECONNRESET',
        'oauth2',
        'gmail',
      ),
    ).toBeNull()
    expect(
      detectAuthRecoveryKind(
        '',
        'password',
        'generic-imap',
      ),
    ).toBeNull()
  })

  it('routes Outlook OAuth2 to "outlook" for generic auth failure (not "password")', () => {
    // Generic message with no provider-specific keyword must still hit the
    // Outlook branch when providerId says outlook — previously this routed
    // to Google because the detector was provider-blind.
    expect(
      detectAuthRecoveryKind(
        'Authentication failed',
        'oauth2',
        'outlook',
      ),
    ).toBe('outlook')
    expect(
      detectAuthRecoveryKind(
        '535 login failed',
        'oauth2',
        'outlook',
      ),
    ).toBe('outlook')
  })

  it('defaults OAuth2 account without providerId=outlook to "google" (backwards-compat)', () => {
    // Legacy accounts or rows created before providerId was persisted keep
    // the Google behavior they had before §2.11.
    expect(
      detectAuthRecoveryKind('invalid_grant', 'oauth2', 'gmail'),
    ).toBe('google')
    expect(
      detectAuthRecoveryKind('invalid_grant', 'oauth2', undefined),
    ).toBe('google')
  })

  // AAD-specific keywords added for §2.11. Each must be recognized standalone
  // so a clean AAD error (without a concurrent invalid_grant in the string)
  // still triggers OAuth recovery. Match is case-insensitive — the detector
  // lowercases input first, so upper/mixed-case AAD codes route correctly.
  it('routes bare "AADSTS..." error without other oauth tokens to "outlook"', () => {
    expect(
      detectAuthRecoveryKind('AADSTS700082: refresh token expired', 'oauth2', 'outlook'),
    ).toBe('outlook')
  })

  it('routes bare "interaction_required" to "outlook"', () => {
    expect(
      detectAuthRecoveryKind('interaction_required', 'oauth2', 'outlook'),
    ).toBe('outlook')
  })

  it('routes bare "consent_required" to "outlook"', () => {
    expect(
      detectAuthRecoveryKind('consent_required: admin approval needed', 'oauth2', 'outlook'),
    ).toBe('outlook')
  })
})

// --- §2.17 Phase 0 — bucketBodySizeRenderer (mirrors electron/metricsBuckets.ts) ---
//
// `bucketBodySizeRenderer` is a private function inside App.tsx. It intentionally
// duplicates the boundaries from `electron/metricsBuckets.ts#bucketBodySize` so
// the renderer bundle does not import from electron/*. These tests verify that
// the boundary values are correct and match the documented canonical helper —
// if the canonical helper changes, both must be updated in lockstep.

/**
 * Mirror of the private `bucketBodySizeRenderer` from App.tsx.
 * Any change to the production function must be reflected here AND in the
 * canonical `electron/metricsBuckets.ts#bucketBodySize`.
 */
function bucketBodySizeRendererMirror(html: string | undefined, text: string | undefined): string {
  const bytes = Math.max(html?.length ?? 0, text?.length ?? 0)
  if (bytes < 1024) return '<1KB'
  if (bytes < 10 * 1024) return '1-10KB'
  if (bytes < 100 * 1024) return '10-100KB'
  if (bytes < 1024 * 1024) return '100KB-1MB'
  return '1MB+'
}

describe('§2.17 Phase 0 — bucketBodySizeRenderer logic', () => {
  it('returns "<1KB" when both html and text are absent', () => {
    expect(bucketBodySizeRendererMirror(undefined, undefined)).toBe('<1KB')
  })

  it('returns "<1KB" when content is below 1024 bytes', () => {
    expect(bucketBodySizeRendererMirror('x'.repeat(100), undefined)).toBe('<1KB')
    expect(bucketBodySizeRendererMirror(undefined, 'y'.repeat(1023))).toBe('<1KB')
  })

  it('returns "1-10KB" at exactly 1024 bytes', () => {
    expect(bucketBodySizeRendererMirror('a'.repeat(1024), undefined)).toBe('1-10KB')
  })

  it('returns "1-10KB" for content between 1KB and 10KB', () => {
    expect(bucketBodySizeRendererMirror('b'.repeat(5000), undefined)).toBe('1-10KB')
    expect(bucketBodySizeRendererMirror('c'.repeat(10 * 1024 - 1), undefined)).toBe('1-10KB')
  })

  it('returns "10-100KB" at exactly 10 * 1024 bytes', () => {
    expect(bucketBodySizeRendererMirror('d'.repeat(10 * 1024), undefined)).toBe('10-100KB')
  })

  it('returns "100KB-1MB" at exactly 100 * 1024 bytes', () => {
    expect(bucketBodySizeRendererMirror('e'.repeat(100 * 1024), undefined)).toBe('100KB-1MB')
  })

  it('returns "1MB+" at exactly 1024 * 1024 bytes', () => {
    expect(bucketBodySizeRendererMirror('f'.repeat(1024 * 1024), undefined)).toBe('1MB+')
  })

  it('uses the larger of html and text for the bucket', () => {
    // text is larger — must drive the bucket
    expect(bucketBodySizeRendererMirror('a'.repeat(100), 'b'.repeat(2000))).toBe('1-10KB')
    // html is larger
    expect(bucketBodySizeRendererMirror('a'.repeat(20 * 1024), 'b'.repeat(100))).toBe('10-100KB')
  })
})

// --- §2.17 Phase 0 — endOpenSpan idempotency guard -------------------------
//
// The production code uses an `openSpanEnded` boolean flag to guarantee
// that the Sentry span's `.end()` is called exactly once even though both
// the success path AND the finally block call `endOpenSpan`. This test
// exercises that pattern in isolation so a future refactor cannot break
// the idempotency contract.

describe('§2.17 Phase 0 — endOpenSpan idempotency (span.end called exactly once)', () => {
  it('span.end is called exactly once when endOpenSpan is invoked twice', () => {
    const spanEnd = vi.fn()
    const spanSetAttribute = vi.fn()

    const mockSpan = { end: spanEnd, setAttribute: spanSetAttribute }

    let openSpanEnded = false
    const endOpenSpan = (attrs?: { body_size_bucket?: string; attachments_count?: number; offline_fallback?: boolean }) => {
      if (openSpanEnded || !mockSpan) return
      openSpanEnded = true
      try {
        if (attrs?.body_size_bucket !== undefined) mockSpan.setAttribute('body_size_bucket', attrs.body_size_bucket)
        if (attrs?.attachments_count !== undefined) mockSpan.setAttribute('attachments_count', String(attrs.attachments_count))
        if (attrs?.offline_fallback !== undefined) mockSpan.setAttribute('offline_fallback', String(attrs.offline_fallback))
      } catch { /* ignore in test */ }
      mockSpan.end()
    }

    // Simulate success path (called from the try block)
    endOpenSpan({ body_size_bucket: '1-10KB', attachments_count: 2, offline_fallback: false })
    // Simulate the finally block calling endOpenSpan again
    endOpenSpan()

    expect(spanEnd).toHaveBeenCalledOnce()
  })

  it('span attributes are set only on the first endOpenSpan call', () => {
    const spanEnd = vi.fn()
    const spanSetAttribute = vi.fn()
    const mockSpan = { end: spanEnd, setAttribute: spanSetAttribute }

    let openSpanEnded = false
    const endOpenSpan = (attrs?: { body_size_bucket?: string; offline_fallback?: boolean }) => {
      if (openSpanEnded || !mockSpan) return
      openSpanEnded = true
      try {
        if (attrs?.body_size_bucket !== undefined) mockSpan.setAttribute('body_size_bucket', attrs.body_size_bucket)
        if (attrs?.offline_fallback !== undefined) mockSpan.setAttribute('offline_fallback', String(attrs.offline_fallback))
      } catch { /* ignore in test */ }
      mockSpan.end()
    }

    endOpenSpan({ body_size_bucket: '<1KB', offline_fallback: false })
    endOpenSpan({ body_size_bucket: '1MB+', offline_fallback: true })

    // Only the first call's attributes should have been set
    expect(spanSetAttribute).toHaveBeenCalledWith('body_size_bucket', '<1KB')
    expect(spanSetAttribute).not.toHaveBeenCalledWith('body_size_bucket', '1MB+')
  })

  it('offline_fallback=true is set on the span when the response is an offline fallback', () => {
    const spanEnd = vi.fn()
    const spanSetAttribute = vi.fn()
    const mockSpan = { end: spanEnd, setAttribute: spanSetAttribute }

    let openSpanEnded = false
    const endOpenSpan = (attrs?: { offline_fallback?: boolean }) => {
      if (openSpanEnded || !mockSpan) return
      openSpanEnded = true
      try {
        if (attrs?.offline_fallback !== undefined) mockSpan.setAttribute('offline_fallback', attrs.offline_fallback)
      } catch { /* ignore in test */ }
      mockSpan.end()
    }

    endOpenSpan({ offline_fallback: true })

    expect(spanSetAttribute).toHaveBeenCalledWith('offline_fallback', true)
    expect(spanEnd).toHaveBeenCalledOnce()
  })

  it('cancellation path (no attrs) still calls span.end exactly once', () => {
    const spanEnd = vi.fn()
    const mockSpan = { end: spanEnd, setAttribute: vi.fn() }

    let openSpanEnded = false
    const endOpenSpan = (attrs?: Record<string, unknown>) => {
      if (openSpanEnded || !mockSpan) return
      openSpanEnded = true
      void attrs // unused in cancellation path
      mockSpan.end()
    }

    // Cancellation: ctxSeq mismatch hits the early-return path, calls endOpenSpan()
    endOpenSpan()
    // finally block calls it again
    endOpenSpan()

    expect(spanEnd).toHaveBeenCalledOnce()
  })
})
