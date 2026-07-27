import { describe, expect, it, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../packages/net/index', () => ({
  getOauthRefreshTokenWithSource: vi.fn(),
  setOauthRefreshToken: vi.fn().mockResolvedValue(undefined),
  getAccountMeta: vi.fn(),
  saveAccount: vi.fn().mockResolvedValue({ id: 42 }),
  testImapConnection: vi.fn().mockResolvedValue({ ok: true }),
  testSmtpConnection: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../microsoftOAuth', () => ({
  runMicrosoftOAuthFlow: vi.fn().mockResolvedValue({
    email: 'user@outlook.com',
    accessToken: 'at-fresh',
    expiresAt: Date.now() + 3600_000,
    refreshToken: 'rt-fresh',
  }),
  refreshMicrosoftAccessToken: vi.fn().mockResolvedValue({
    accessToken: 'at-refreshed',
    expiresAt: Date.now() + 3600_000,
  }),
  isMicrosoftOAuthBusy: vi.fn().mockReturnValue(false),
  // Re-exported by outlookOAuthService for Graph-send token refresh.
  MICROSOFT_GRAPH_SEND_SCOPES: ['offline_access', 'https://graph.microsoft.com/Mail.Send'],
  MICROSOFT_EXCHANGE_SCOPES: [
    'offline_access',
    'https://outlook.office.com/IMAP.AccessAsUser.All',
    'https://outlook.office.com/SMTP.Send',
    'openid',
    'email',
    'profile',
    // User.Read intentionally excluded — it's a Graph-resource scope and
    // would cause AADSTS70011 when mixed with outlook.office.com scopes
    // in /token (production incident 2026-04-23). See microsoftOAuth.ts.
  ],
}))

const captureExceptionMock = vi.fn()
vi.mock('../sentry', () => ({
  captureException: (err: unknown, ctx: unknown) => captureExceptionMock(err, ctx),
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Import SUT + mocked modules
// ---------------------------------------------------------------------------

import {
  getOutlookAccessToken,
  getOutlookGraphSendAccessToken,
  clearOutlookTokenCache,
  forceRefreshOutlookAccessToken,
  connectOutlookAccount,
} from './outlookOAuthService'
import { getOauthRefreshTokenWithSource } from '../../packages/net/index'
import { refreshMicrosoftAccessToken, runMicrosoftOAuthFlow, isMicrosoftOAuthBusy } from '../microsoftOAuth'
import { getAccountMeta, saveAccount, testImapConnection, testSmtpConnection } from '../../packages/net/index'

const mockGetOauthRefreshTokenWithSource = vi.mocked(getOauthRefreshTokenWithSource)
const mockRefreshMicrosoftAccessToken = vi.mocked(refreshMicrosoftAccessToken)
const mockRunMicrosoftOAuthFlow = vi.mocked(runMicrosoftOAuthFlow)
const mockIsMicrosoftOAuthBusy = vi.mocked(isMicrosoftOAuthBusy)
const mockGetAccountMeta = vi.mocked(getAccountMeta)
const mockSaveAccount = vi.mocked(saveAccount)
const mockTestImapConnection = vi.mocked(testImapConnection)
const mockTestSmtpConnection = vi.mocked(testSmtpConnection)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = process.env

beforeEach(() => {
  vi.clearAllMocks()
  clearOutlookTokenCache(1)
  clearOutlookTokenCache(2)
  clearOutlookTokenCache(42)
  process.env = { ...ORIGINAL_ENV, MAILCOPILOT_MS_CLIENT_ID: 'test-client-id' }
  mockGetOauthRefreshTokenWithSource.mockResolvedValue({ token: 'rt-stored', source: 'legacy' })
  mockRefreshMicrosoftAccessToken.mockResolvedValue({ accessToken: 'at-refreshed', expiresAt: Date.now() + 3600_000 })
  mockRunMicrosoftOAuthFlow.mockResolvedValue({
    email: 'user@outlook.com',
    accessToken: 'at-fresh',
    expiresAt: Date.now() + 3600_000,
    refreshToken: 'rt-fresh',
  })
  mockIsMicrosoftOAuthBusy.mockReturnValue(false)
  mockGetAccountMeta.mockReturnValue(undefined)
  mockSaveAccount.mockResolvedValue({ id: 42 })
  mockTestImapConnection.mockResolvedValue({ ok: true })
  mockTestSmtpConnection.mockResolvedValue({ ok: true })
})

// ---------------------------------------------------------------------------
// getOutlookAccessToken
// ---------------------------------------------------------------------------

describe('getOutlookAccessToken', () => {
  it('returns cached token when still valid', async () => {
    // Prime the cache by calling once
    const token1 = await getOutlookAccessToken(1)
    expect(token1).toBe('at-refreshed')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)

    // Second call returns cached without refresh
    const token2 = await getOutlookAccessToken(1)
    expect(token2).toBe('at-refreshed')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)
  })

  it('triggers refresh when cached token is expired', async () => {
    // Prime cache with an already-expired entry
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-expired', expiresAt: Date.now() - 1000 })
    await getOutlookAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)

    // Next call sees expired cache and refreshes again
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-new', expiresAt: Date.now() + 3600_000 })
    const token = await getOutlookAccessToken(1)
    expect(token).toBe('at-new')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)
  })

  it('triggers refresh when cached token expires within 60 seconds', async () => {
    // Prime cache with a token expiring in 30s (within the 60s margin)
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-soon', expiresAt: Date.now() + 30_000 })
    await getOutlookAccessToken(1)

    // Should trigger a new refresh
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-renewed', expiresAt: Date.now() + 3600_000 })
    const token = await getOutlookAccessToken(1)
    expect(token).toBe('at-renewed')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent refresh requests', async () => {
    // Slow refresh
    let resolveRefresh!: (v: { accessToken: string; expiresAt: number }) => void
    mockRefreshMicrosoftAccessToken.mockReturnValueOnce(
      new Promise(r => { resolveRefresh = r }),
    )

    const p1 = getOutlookAccessToken(1)
    const p2 = getOutlookAccessToken(1)

    resolveRefresh({ accessToken: 'at-dedup', expiresAt: Date.now() + 3600_000 })

    const [t1, t2] = await Promise.all([p1, p2])
    expect(t1).toBe('at-dedup')
    expect(t2).toBe('at-dedup')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)
  })

  it('falls back to bundled client_id when MAILCOPILOT_MS_CLIENT_ID is unset', async () => {
    delete process.env.MAILCOPILOT_MS_CLIENT_ID
    await getOutlookAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: '5d109662-be45-4c4c-9d40-3a07adec8fb0' }),
    )
  })

  it('refreshes with Exchange-only scope subset (pre-2.2-E backward compat)', async () => {
    // Pre-2.2-E accounts consented without Graph Mail.Send. Refresh for
    // IMAP/SMTP must request only outlook.office.com scopes to avoid
    // AADSTS65001 "User has not consented" on those accounts.
    await getOutlookAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: [
          'offline_access',
          'https://outlook.office.com/IMAP.AccessAsUser.All',
          'https://outlook.office.com/SMTP.Send',
          'openid',
          'email',
          'profile',
        ],
      }),
    )
    // Graph Mail.Send must NOT be in the Exchange refresh request.
    // Neither may User.Read — it's a Graph-resource scope and Microsoft
    // /token rejects multi-resource scope lists with AADSTS70011.
    const callArg = mockRefreshMicrosoftAccessToken.mock.calls[0][0]
    expect(callArg.scopes).not.toContain('https://graph.microsoft.com/Mail.Send')
    expect(callArg.scopes).not.toContain('User.Read')
  })

  it('throws when refresh token is not found', async () => {
    mockGetOauthRefreshTokenWithSource.mockResolvedValueOnce(null)
    await expect(getOutlookAccessToken(1)).rejects.toThrow('refresh token for account #1 not found')
  })

  it('cleans up inflight map when refresh rejects', async () => {
    mockRefreshMicrosoftAccessToken.mockRejectedValueOnce(new Error('network failure'))
    await expect(getOutlookAccessToken(1)).rejects.toThrow('network failure')

    // After rejection, a new call should attempt refresh again (inflight was cleaned)
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-retry', expiresAt: Date.now() + 3600_000 })
    const token = await getOutlookAccessToken(1)
    expect(token).toBe('at-retry')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)
  })

  it('passes clientSecret as undefined when env var is empty', async () => {
    process.env.MAILCOPILOT_MS_CLIENT_SECRET = ''
    await getOutlookAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: undefined }),
    )
  })

  it('passes clientSecret when env var is set', async () => {
    process.env.MAILCOPILOT_MS_CLIENT_SECRET = 'my-secret'
    await getOutlookAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: 'my-secret' }),
    )
  })

  it('persists rotated refresh_token from Exchange refresh response (2.2-I)', async () => {
    const { setOauthRefreshToken } = await import('../../packages/net/index')
    const mockSetToken = vi.mocked(setOauthRefreshToken)
    mockSetToken.mockClear()

    // Microsoft rotates refresh_tokens — response includes `refresh_token`
    // alongside `access_token`. Our code must persist it; old token may
    // stop working at any time.
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'at-rotated',
      expiresAt: Date.now() + 3600_000,
      refreshToken: 'rt-rotated-new',
    })
    await getOutlookAccessToken(1)
    expect(mockSetToken).toHaveBeenCalledWith('outlook', 1, 'rt-rotated-new')
  })

  it('does NOT overwrite refresh_token when Microsoft did not rotate it', async () => {
    const { setOauthRefreshToken } = await import('../../packages/net/index')
    const mockSetToken = vi.mocked(setOauthRefreshToken)
    mockSetToken.mockClear()

    // Response without refresh_token (legitimate — Microsoft rotates
    // "sometimes"). Our code must NOT call setOauthRefreshToken with
    // undefined / empty string, which would wipe the keytar entry.
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'at-no-rotation',
      expiresAt: Date.now() + 3600_000,
      // no refreshToken field
    })
    await getOutlookAccessToken(1)
    expect(mockSetToken).not.toHaveBeenCalled()
  })

  it('isolates cache per accountId', async () => {
    // Prime cache for account 1
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-acct1', expiresAt: Date.now() + 3600_000 })
    const t1 = await getOutlookAccessToken(1)
    expect(t1).toBe('at-acct1')

    // Account 2 has no cache -- triggers its own refresh
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-acct2', expiresAt: Date.now() + 3600_000 })
    const t2 = await getOutlookAccessToken(2)
    expect(t2).toBe('at-acct2')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)

    // Account 1 still returns its cached value
    const t1Again = await getOutlookAccessToken(1)
    expect(t1Again).toBe('at-acct1')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// clearOutlookTokenCache
// ---------------------------------------------------------------------------

describe('clearOutlookTokenCache', () => {
  it('removes cached entry so next call refreshes', async () => {
    await getOutlookAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)

    clearOutlookTokenCache(1)

    await getOutlookAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)
  })

  it('is safe to call on an accountId that was never cached', () => {
    // Should not throw
    expect(() => clearOutlookTokenCache(9999)).not.toThrow()
  })

  it('clears both the Exchange-resource and Graph-resource caches', async () => {
    // Prime both caches for account 1
    mockRefreshMicrosoftAccessToken
      .mockResolvedValueOnce({ accessToken: 'at-exchange', expiresAt: Date.now() + 3600_000 })
      .mockResolvedValueOnce({ accessToken: 'at-graph', expiresAt: Date.now() + 3600_000 })
    await getOutlookAccessToken(1)
    await getOutlookGraphSendAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)

    // Both should be served from cache without another refresh
    await getOutlookAccessToken(1)
    await getOutlookGraphSendAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)

    clearOutlookTokenCache(1)

    // Now BOTH caches must be gone — each call triggers a fresh refresh
    mockRefreshMicrosoftAccessToken
      .mockResolvedValueOnce({ accessToken: 'at-exchange-2', expiresAt: Date.now() + 3600_000 })
      .mockResolvedValueOnce({ accessToken: 'at-graph-2', expiresAt: Date.now() + 3600_000 })
    await getOutlookAccessToken(1)
    await getOutlookGraphSendAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(4)
  })
})

// ---------------------------------------------------------------------------
// getOutlookGraphSendAccessToken
// ---------------------------------------------------------------------------

describe('getOutlookGraphSendAccessToken', () => {
  it('returns cached token when still valid (no refresh)', async () => {
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'graph-at-1',
      expiresAt: Date.now() + 3600_000,
    })

    const t1 = await getOutlookGraphSendAccessToken(1)
    expect(t1).toBe('graph-at-1')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)

    const t2 = await getOutlookGraphSendAccessToken(1)
    expect(t2).toBe('graph-at-1')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)
  })

  it('triggers refresh when cached token expires within 60 seconds', async () => {
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'graph-at-soon',
      expiresAt: Date.now() + 30_000,
    })
    await getOutlookGraphSendAccessToken(1)

    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'graph-at-renewed',
      expiresAt: Date.now() + 3600_000,
    })
    const token = await getOutlookGraphSendAccessToken(1)
    expect(token).toBe('graph-at-renewed')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)
  })

  it('refreshes with MICROSOFT_GRAPH_SEND_SCOPES (not default Exchange scopes)', async () => {
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'graph-at',
      expiresAt: Date.now() + 3600_000,
    })

    await getOutlookGraphSendAccessToken(1)

    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshToken: 'rt-stored',
        scopes: ['offline_access', 'https://graph.microsoft.com/Mail.Send'],
      }),
    )
  })

  it('isolates Graph cache per accountId', async () => {
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'graph-acct1',
      expiresAt: Date.now() + 3600_000,
    })
    const t1 = await getOutlookGraphSendAccessToken(1)
    expect(t1).toBe('graph-acct1')

    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'graph-acct2',
      expiresAt: Date.now() + 3600_000,
    })
    const t2 = await getOutlookGraphSendAccessToken(2)
    expect(t2).toBe('graph-acct2')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)

    // Account 1 served from its own cache
    const t1Again = await getOutlookGraphSendAccessToken(1)
    expect(t1Again).toBe('graph-acct1')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent refresh requests (single-flight)', async () => {
    let resolveRefresh!: (v: { accessToken: string; expiresAt: number }) => void
    mockRefreshMicrosoftAccessToken.mockReturnValueOnce(
      new Promise(r => { resolveRefresh = r }),
    )

    const p1 = getOutlookGraphSendAccessToken(1)
    const p2 = getOutlookGraphSendAccessToken(1)

    resolveRefresh({ accessToken: 'graph-dedup', expiresAt: Date.now() + 3600_000 })

    const [t1, t2] = await Promise.all([p1, p2])
    expect(t1).toBe('graph-dedup')
    expect(t2).toBe('graph-dedup')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)
  })

  it('falls back to bundled client_id when MAILCOPILOT_MS_CLIENT_ID is unset', async () => {
    delete process.env.MAILCOPILOT_MS_CLIENT_ID
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'graph-at',
      expiresAt: Date.now() + 3600_000,
    })

    await getOutlookGraphSendAccessToken(1)

    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: '5d109662-be45-4c4c-9d40-3a07adec8fb0',
      }),
    )
  })

  it('passes clientSecret=undefined when using bundled client_id', async () => {
    delete process.env.MAILCOPILOT_MS_CLIENT_ID
    // Even if the secret env var is set, it must be ignored when bundled
    // client_id is in use (AADSTS invalid_client otherwise).
    process.env.MAILCOPILOT_MS_CLIENT_SECRET = 'stray-secret'
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'graph-at',
      expiresAt: Date.now() + 3600_000,
    })

    await getOutlookGraphSendAccessToken(1)

    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: undefined }),
    )
  })

  it('isolated from getOutlookAccessToken cache (Graph aud != Exchange aud)', async () => {
    // Prime Exchange cache
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'exchange-tok',
      expiresAt: Date.now() + 3600_000,
    })
    const exchange = await getOutlookAccessToken(1)
    expect(exchange).toBe('exchange-tok')

    // Graph must NOT hit the Exchange cache — it must run its own refresh
    // call (different `scopes`, different `aud` claim).
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'graph-tok',
      expiresAt: Date.now() + 3600_000,
    })
    const graph = await getOutlookGraphSendAccessToken(1)
    expect(graph).toBe('graph-tok')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)

    // And vice-versa: second Exchange call still hits the first cached value
    const exchangeAgain = await getOutlookAccessToken(1)
    expect(exchangeAgain).toBe('exchange-tok')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)
  })

  it('throws when refresh token is not found', async () => {
    mockGetOauthRefreshTokenWithSource.mockResolvedValueOnce(null)
    await expect(getOutlookGraphSendAccessToken(1)).rejects.toThrow(
      'refresh token for account #1 not found',
    )
  })

  it('cleans up inflight map when refresh rejects', async () => {
    mockRefreshMicrosoftAccessToken.mockRejectedValueOnce(new Error('network failure'))
    await expect(getOutlookGraphSendAccessToken(1)).rejects.toThrow('network failure')

    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({
      accessToken: 'graph-retry',
      expiresAt: Date.now() + 3600_000,
    })
    const token = await getOutlookGraphSendAccessToken(1)
    expect(token).toBe('graph-retry')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// forceRefreshOutlookAccessToken
// ---------------------------------------------------------------------------

describe('forceRefreshOutlookAccessToken', () => {
  it('returns a fresh token (triggers refresh even when cache is valid)', async () => {
    // Prime cache with a valid token
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-cached', expiresAt: Date.now() + 3600_000 })
    await getOutlookAccessToken(1)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)

    // Force refresh should trigger a NEW refresh even though cache is valid
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-force-fresh', expiresAt: Date.now() + 3600_000 })
    const token = await forceRefreshOutlookAccessToken(1)
    expect(token).toBe('at-force-fresh')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(2)
  })

  it('concurrent forceRefresh calls produce only one refreshMicrosoftAccessToken call', async () => {
    // Use a slow refresh to ensure both calls overlap
    let resolveRefresh!: (v: { accessToken: string; expiresAt: number }) => void
    mockRefreshMicrosoftAccessToken.mockReturnValueOnce(
      new Promise(r => { resolveRefresh = r }),
    )

    const p1 = forceRefreshOutlookAccessToken(1)
    const p2 = forceRefreshOutlookAccessToken(1)

    resolveRefresh({ accessToken: 'at-single-flight', expiresAt: Date.now() + 3600_000 })

    const [t1, t2] = await Promise.all([p1, p2])
    expect(t1).toBe('at-single-flight')
    expect(t2).toBe('at-single-flight')
    // Critical assertion: only ONE refresh call, not two
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)
  })

  it('waits for existing inflight refresh instead of starting a new one', async () => {
    // Start a normal getOutlookAccessToken that will be slow
    let resolveRefresh!: (v: { accessToken: string; expiresAt: number }) => void
    mockRefreshMicrosoftAccessToken.mockReturnValueOnce(
      new Promise(r => { resolveRefresh = r }),
    )

    const p1 = getOutlookAccessToken(1) // starts inflight
    const p2 = forceRefreshOutlookAccessToken(1) // should piggyback

    resolveRefresh({ accessToken: 'at-inflight', expiresAt: Date.now() + 3600_000 })

    const [t1, t2] = await Promise.all([p1, p2])
    expect(t1).toBe('at-inflight')
    expect(t2).toBe('at-inflight')
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)
  })

  it('is safe to call on an accountId that was never cached', async () => {
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-new', expiresAt: Date.now() + 3600_000 })
    const token = await forceRefreshOutlookAccessToken(999)
    expect(token).toBe('at-new')
  })
})

// ---------------------------------------------------------------------------
// connectOutlookAccount
// ---------------------------------------------------------------------------

const defaultParams = () => ({
  existingAccountId: undefined,
  openExternal: vi.fn(),
  broadcast: vi.fn(),
  isE2E: false,
})

describe('connectOutlookAccount', () => {
  it('runs the full connect flow and returns account data', async () => {
    const params = defaultParams()
    const result = await connectOutlookAccount(params)

    expect(result.ok).toBe(true)
    expect(result.id).toBe(42)
    expect(result.email).toBe('user@outlook.com')
    expect(mockRunMicrosoftOAuthFlow).toHaveBeenCalledTimes(1)
    expect(mockTestImapConnection).toHaveBeenCalledTimes(1)
    expect(mockTestSmtpConnection).toHaveBeenCalledTimes(1)
    expect(mockSaveAccount).toHaveBeenCalledTimes(1)
    expect(params.broadcast).toHaveBeenCalledWith('accounts:changed', { kind: 'saved', id: 42 })
  })

  it('throws in e2e mode', async () => {
    const params = { ...defaultParams(), isE2E: true }
    await expect(connectOutlookAccount(params)).rejects.toThrow('not available in e2e mode')
  })

  it('falls back to bundled client_id when MAILCOPILOT_MS_CLIENT_ID is unset', async () => {
    delete process.env.MAILCOPILOT_MS_CLIENT_ID
    await connectOutlookAccount(defaultParams())
    expect(mockRunMicrosoftOAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: '5d109662-be45-4c4c-9d40-3a07adec8fb0' }),
    )
  })

  it('throws when existing account is not found', async () => {
    mockGetAccountMeta.mockReturnValue(undefined)
    const params = { ...defaultParams(), existingAccountId: 999 }
    await expect(connectOutlookAccount(params)).rejects.toThrow('Account #999 not found')
  })

  it('throws when Microsoft OAuth is already busy', async () => {
    mockIsMicrosoftOAuthBusy.mockReturnValue(true)
    await expect(connectOutlookAccount(defaultParams())).rejects.toThrow('already running in another window')
  })

  it('passes openExternal to runMicrosoftOAuthFlow', async () => {
    const params = defaultParams()
    await connectOutlookAccount(params)
    expect(mockRunMicrosoftOAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ openExternal: params.openExternal }),
    )
  })

  it('saves account with oauth2 auth type and outlook provider', async () => {
    await connectOutlookAccount(defaultParams())
    expect(mockSaveAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'oauth2',
        providerId: 'outlook',
        transportType: 'imap-smtp',
        imap: expect.objectContaining({ host: 'outlook.office365.com', port: 993 }),
        smtp: expect.objectContaining({ host: 'smtp-mail.outlook.com', port: 587 }),
      }),
    )
  })

  it('does not let in-flight Graph-send refresh overwrite post-reconnect cache', async () => {
    mockGetAccountMeta.mockReturnValue({
      id: 42,
      name: 'My Account',
      authType: 'oauth2',
      providerId: 'outlook',
      transportType: 'imap-smtp',
      imap: { host: 'outlook.office365.com', port: 993, secure: true, user: 'old@outlook.com' },
      smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, user: 'old@outlook.com' },
      folderRoles: {},
    } as ReturnType<typeof getAccountMeta>)

    // Start a Graph-send refresh that will not resolve until we let it —
    // simulates a pre-reconnect refresh already in flight when user clicks
    // re-auth.
    let resolveStaleRefresh!: (v: { accessToken: string; expiresAt: number }) => void
    mockRefreshMicrosoftAccessToken.mockReturnValueOnce(
      new Promise(r => { resolveStaleRefresh = r }),
    )
    const stalePending = getOutlookGraphSendAccessToken(42)

    // Reconnect happens while the stale refresh is still pending.
    await connectOutlookAccount({ ...defaultParams(), existingAccountId: 42 })

    // Stale refresh resolves AFTER reconnect with a pre-reconnect-bound token.
    resolveStaleRefresh({ accessToken: 'at-stale-pre-reconnect', expiresAt: Date.now() + 3600_000 })
    // Give microtasks a turn so the stale .then() runs.
    await stalePending.catch(() => { /* stale promise still resolves for caller */ })

    // Next call must NOT get the stale token from cache — the guard inside
    // the IIFE should have refused to write it. Instead it fetches fresh.
    mockRefreshMicrosoftAccessToken.mockResolvedValueOnce({ accessToken: 'at-post-reconnect', expiresAt: Date.now() + 3600_000 })
    const freshToken = await getOutlookGraphSendAccessToken(42)
    expect(freshToken).toBe('at-post-reconnect')
  })

  it('invalidates Graph send token cache on reconnect (prevents stale identity)', async () => {
    mockGetAccountMeta.mockReturnValue({
      id: 42,
      name: 'My Account',
      authType: 'oauth2',
      providerId: 'outlook',
      transportType: 'imap-smtp',
      imap: { host: 'outlook.office365.com', port: 993, secure: true, user: 'old@outlook.com' },
      smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, user: 'old@outlook.com' },
      folderRoles: {},
    } as ReturnType<typeof getAccountMeta>)

    // Prime Graph send cache with a pre-reconnect token (simulates a prior
    // `getOutlookGraphSendAccessToken` call that populated the cache).
    await getOutlookGraphSendAccessToken(42)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)

    // Reconnect the account. After reconnect a fresh call to
    // getOutlookGraphSendAccessToken must NOT return the pre-reconnect
    // cached token — it should force a new refresh against the just-saved
    // refresh_token.
    await connectOutlookAccount({ ...defaultParams(), existingAccountId: 42 })
    mockRefreshMicrosoftAccessToken.mockClear()
    await getOutlookGraphSendAccessToken(42)
    expect(mockRefreshMicrosoftAccessToken).toHaveBeenCalledTimes(1)
  })

  it('preserves existing account metadata when reconnecting', async () => {
    mockGetAccountMeta.mockReturnValue({
      id: 10,
      name: 'My Account',
      authType: 'oauth2',
      providerId: 'outlook',
      transportType: 'imap-smtp',
      imap: { host: 'outlook.office365.com', port: 993, secure: true, user: 'old@outlook.com' },
      smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, user: 'old@outlook.com' },
      folderRoles: { inbox: 'INBOX', sent: 'Sent' },
      signature: '<p>Sig</p>',
      identities: [{
        id: 'test-identity-10',
        displayName: 'My Account',
        email: 'old@outlook.com',
        signature: '<p>Sig</p>',
        isDefault: true,
      }],
    } as ReturnType<typeof getAccountMeta>)

    const params = { ...defaultParams(), existingAccountId: 10 }
    await connectOutlookAccount(params)

    expect(mockSaveAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 10,
        name: 'My Account',
        folderRoles: { inbox: 'INBOX', sent: 'Sent' },
        signature: '<p>Sig</p>',
      }),
    )
  })

  it('pre-writes refresh token for non-OAuth existing accounts', async () => {
    const { setOauthRefreshToken } = await import('../../packages/net/index')
    const mockSetToken = vi.mocked(setOauthRefreshToken)
    mockGetAccountMeta.mockReturnValue({
      id: 10,
      name: 'Legacy Account',
      authType: 'password',
      providerId: 'generic-imap',
      transportType: 'imap-smtp',
      imap: { host: 'imap.example.com', port: 993, secure: true, user: 'legacy@example.com' },
      smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'legacy@example.com' },
      folderRoles: {},
    } as ReturnType<typeof getAccountMeta>)

    const params = { ...defaultParams(), existingAccountId: 10 }
    await connectOutlookAccount(params)

    // First call is the pre-write for the transition, second is the final save
    expect(mockSetToken).toHaveBeenCalledTimes(2)
    expect(mockSetToken).toHaveBeenCalledWith('outlook', 10, 'rt-fresh')
  })

  it('reports TLS cert error as tlsCertRequired without throwing', async () => {
    mockTestImapConnection.mockResolvedValue({ ok: false, error: 'SELF_SIGNED_CERT_IN_CHAIN' })
    mockTestSmtpConnection.mockResolvedValue({ ok: false, error: 'DEPTH_ZERO_SELF_SIGNED_CERT' })

    const result = await connectOutlookAccount(defaultParams())

    expect(result.ok).toBe(true)
    expect(result.tlsCertRequired).toEqual({
      imap: { host: 'outlook.office365.com', port: 993 },
      smtp: { host: 'smtp-mail.outlook.com', port: 587 },
    })
  })

  it('throws on IMAP non-TLS error', async () => {
    mockTestImapConnection.mockResolvedValue({ ok: false, error: 'Authentication failed' })
    await expect(connectOutlookAccount(defaultParams())).rejects.toThrow('IMAP: Authentication failed')
    expect(captureExceptionMock).toHaveBeenCalled()
  })

  it('does not throw on SMTP non-TLS error (account is saved)', async () => {
    mockTestSmtpConnection.mockResolvedValue({ ok: false, error: 'SMTP auth failed' })
    const result = await connectOutlookAccount(defaultParams())
    expect(result.ok).toBe(true)
    expect(captureExceptionMock).toHaveBeenCalled()
  })

  it('validates existingAccountId with zod (rejects non-positive)', async () => {
    const params = { ...defaultParams(), existingAccountId: -1 }
    await expect(connectOutlookAccount(params)).rejects.toThrow()
  })

  it('validates existingAccountId with zod (rejects zero)', async () => {
    const params = { ...defaultParams(), existingAccountId: 0 }
    await expect(connectOutlookAccount(params)).rejects.toThrow()
  })

  it('validates existingAccountId with zod (rejects non-integer)', async () => {
    const params = { ...defaultParams(), existingAccountId: 1.5 }
    await expect(connectOutlookAccount(params)).rejects.toThrow()
  })

  it('treats null existingAccountId as undefined (new account)', async () => {
    const params = { ...defaultParams(), existingAccountId: null }
    const result = await connectOutlookAccount(params)
    expect(result.ok).toBe(true)
    // Should not call getAccountMeta for validation
    expect(mockGetAccountMeta).not.toHaveBeenCalled()
    expect(mockSaveAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: undefined }),
    )
  })

  it('does not include tlsCertRequired when both IMAP and SMTP pass', async () => {
    const result = await connectOutlookAccount(defaultParams())
    expect(result.tlsCertRequired).toBeUndefined()
  })

  it('includes only IMAP in tlsCertRequired when only IMAP has TLS cert error', async () => {
    mockTestImapConnection.mockResolvedValue({ ok: false, error: 'SELF_SIGNED_CERT_IN_CHAIN' })
    mockTestSmtpConnection.mockResolvedValue({ ok: true })

    const result = await connectOutlookAccount(defaultParams())
    expect(result.tlsCertRequired).toEqual({
      imap: { host: 'outlook.office365.com', port: 993 },
      smtp: undefined,
    })
  })

  it('throws on IMAP timeout', async () => {
    mockTestImapConnection.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 60_000)),
    )
    // The withTimeout helper wraps IMAP with 30s timeout
    await expect(connectOutlookAccount(defaultParams())).rejects.toThrow('IMAP timeout (30s)')
  }, 35_000)

  it('saves account even when SMTP throws an exception', async () => {
    mockTestSmtpConnection.mockRejectedValue(new Error('SMTP connection refused'))
    const result = await connectOutlookAccount(defaultParams())
    expect(result.ok).toBe(true)
    expect(result.id).toBe(42)
    expect(mockSaveAccount).toHaveBeenCalledTimes(1)
    expect(captureExceptionMock).toHaveBeenCalled()
  })

  it('rethrows unexpected IMAP exception (not TLS, not IMAP: prefix)', async () => {
    mockTestImapConnection.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(connectOutlookAccount(defaultParams())).rejects.toThrow('ECONNREFUSED')
    expect(captureExceptionMock).toHaveBeenCalled()
  })

  it('passes clientSecret to runMicrosoftOAuthFlow when env var is set', async () => {
    process.env.MAILCOPILOT_MS_CLIENT_SECRET = 'secret-val'
    await connectOutlookAccount(defaultParams())
    expect(mockRunMicrosoftOAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: 'secret-val' }),
    )
  })

  it('passes clientSecret as undefined when env var is empty', async () => {
    process.env.MAILCOPILOT_MS_CLIENT_SECRET = '  '
    await connectOutlookAccount(defaultParams())
    expect(mockRunMicrosoftOAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: undefined }),
    )
  })

  it('stores access token in cache after successful connect', async () => {
    await connectOutlookAccount(defaultParams())

    // The token should now be cached for account 42, so a subsequent
    // getOutlookAccessToken should return 'at-fresh' without refreshing
    const token = await getOutlookAccessToken(42)
    expect(token).toBe('at-fresh')
    // refreshMicrosoftAccessToken should NOT have been called (cache hit)
    expect(mockRefreshMicrosoftAccessToken).not.toHaveBeenCalled()
  })

  it('calls setOauthRefreshToken exactly once for new accounts (no pre-write)', async () => {
    const { setOauthRefreshToken } = await import('../../packages/net/index')
    const mockSetToken = vi.mocked(setOauthRefreshToken)

    await connectOutlookAccount(defaultParams())

    // Only the post-save call, not a pre-write
    expect(mockSetToken).toHaveBeenCalledTimes(1)
    expect(mockSetToken).toHaveBeenCalledWith('outlook', 42, 'rt-fresh')
  })

  it('does not pre-write refresh token for existing OAuth accounts', async () => {
    const { setOauthRefreshToken } = await import('../../packages/net/index')
    const mockSetToken = vi.mocked(setOauthRefreshToken)
    mockGetAccountMeta.mockReturnValue({
      id: 10,
      name: 'OAuth Account',
      authType: 'oauth2',
      providerId: 'outlook',
      transportType: 'imap-smtp',
      imap: { host: 'outlook.office365.com', port: 993, secure: true, user: 'user@outlook.com' },
      smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, user: 'user@outlook.com' },
      folderRoles: {},
    } as ReturnType<typeof getAccountMeta>)

    const params = { ...defaultParams(), existingAccountId: 10 }
    await connectOutlookAccount(params)

    // Only the post-save call (existing account is already OAuth, no pre-write needed)
    expect(mockSetToken).toHaveBeenCalledTimes(1)
    expect(mockSetToken).toHaveBeenCalledWith('outlook', 42, 'rt-fresh')
  })

  it('uses IMAP result error message in thrown error', async () => {
    mockTestImapConnection.mockResolvedValue({ ok: false, error: '' })
    await expect(connectOutlookAccount(defaultParams())).rejects.toThrow('IMAP: error')
  })
})
