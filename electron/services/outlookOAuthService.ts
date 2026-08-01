import { createLogger } from '../logger'
import { captureException } from '../sentry'
import {
  runMicrosoftOAuthFlow,
  refreshMicrosoftAccessToken,
  isMicrosoftOAuthBusy,
  MICROSOFT_GRAPH_SEND_SCOPES,
  MICROSOFT_EXCHANGE_SCOPES,
} from '../microsoftOAuth'
import {
  getOauthRefreshTokenWithSource,
  setOauthRefreshToken,
  getAccountMeta,
  saveAccount,
  testImapConnection,
  testSmtpConnection,
} from '../../packages/net/index'
import { z } from 'zod'

const log = createLogger('OutlookOAuth')

/**
 * §2.82 iter2 — collapse an IMAP/SMTP connection-test failure into a closed set
 * of buckets fit for telemetry.
 *
 * The inputs are `testImapConnection` / `testSmtpConnection` error strings and
 * raw thrown errors, i.e. verbatim server text. Exchange names the mailbox in
 * its authentication failures ("LOGIN failed for ivan@contoso.com"), and the
 * consent screen promises addresses are never sent — so the text may not be
 * forwarded, interpolated into a synthetic message, or attached as context.
 * The return value is always one of six literals.
 *
 * Deliberately local and small: `classifyImapError` in packages/net covers the
 * live-connection error taxonomy but is not re-exported from the package index,
 * and widening that seam for one call site is not worth the coupling.
 */
export function classifyConnectionTestFailure(e: unknown): 'auth' | 'network' | 'timeout' | 'cert' | 'refused' | 'unknown' {
  const raw = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e ?? '')
  const msg = raw.toLowerCase()
  if (!msg) return 'unknown'
  if (/self.signed|unable_to_verify|cert_has_expired|depth_zero|cert_untrusted|cert_rejected|cert_altname_invalid|err_tls_cert/.test(msg)) return 'cert'
  if (/auth|credential|password|login|xoauth|token|unauthorized|aadsts/.test(msg)) return 'auth'
  if (/timeout|timed out|etimedout/.test(msg)) return 'timeout'
  if (/econnrefused|refused/.test(msg)) return 'refused'
  if (/enotfound|eai_again|econnreset|epipe|ehostunreach|enetunreach|network|dns|socket|offline/.test(msg)) return 'network'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

export type OutlookTokenCacheEntry = { accessToken: string; expiresAt: number }

const OUTLOOK_TOKEN_CACHE = new Map<number, OutlookTokenCacheEntry>()
const OUTLOOK_TOKEN_REFRESH_INFLIGHT = new Map<number, Promise<OutlookTokenCacheEntry>>()

// Separate cache for Graph-resource tokens (used for `POST /me/sendMail`).
// Keyed by accountId just like the Exchange cache.
const GRAPH_SEND_TOKEN_CACHE = new Map<number, OutlookTokenCacheEntry>()
const GRAPH_SEND_TOKEN_REFRESH_INFLIGHT = new Map<number, Promise<OutlookTokenCacheEntry>>()

/**
 * Set of accountIds currently inside `connectOutlookAccount` re-auth flow.
 * Checked alongside the keytar-write mutex (below) to decide whether a
 * stale refresh's rotated token should be persisted.
 */
const RECONNECTING_ACCOUNT_IDS = new Set<number>()

/**
 * Per-account keytar write chain. All callers that persist the Outlook
 * refresh_token via keytar — the two background refresh paths plus
 * `connectOutlookAccount` — MUST run their write inside `chainKeytarWrite`
 * so that:
 *
 *   (a) writes are serialized per accountId (no interleaving on D-Bus),
 *   (b) the RECONNECTING_ACCOUNT_IDS check is re-evaluated AT THE MOMENT
 *       the write actually runs, not at guard-check time. This closes
 *       the async-yield race from codex wave-3 (019dbc13): with the
 *       flag check embedded in the chained function body, a stale
 *       refresh that passed its outer guard still sees the flag set
 *       by the time the chain lets it run, and aborts the write.
 *
 * Failures inside the chained function are caught so one failing write
 * doesn't poison the chain for subsequent callers.
 */
const KEYTAR_WRITE_CHAIN = new Map<number, Promise<unknown>>()

function chainKeytarWrite<T>(accountId: number, fn: () => Promise<T>): Promise<T> {
  const prev = KEYTAR_WRITE_CHAIN.get(accountId) ?? Promise.resolve()
  const next = prev.then(() => fn())
  // Store a non-throwing tail so a rejection in our fn doesn't cascade
  // into the next chained caller's prev-await.
  KEYTAR_WRITE_CHAIN.set(accountId, next.catch(() => {}))
  return next
}

export async function getOutlookAccessToken(accountId: number): Promise<string> {
  const cached = OUTLOOK_TOKEN_CACHE.get(accountId)
  // Refresh token early (60 seconds ahead) to avoid race conditions in parallel requests.
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.accessToken

  const inflight = OUTLOOK_TOKEN_REFRESH_INFLIGHT.get(accountId)
  if (inflight) return (await inflight).accessToken

  // Bundled public-client App Registration (PKCE, no secret). Env var
  // override kept for dev/CI running against a different tenant.
  const envClientId = (process.env.MAILCOPILOT_MS_CLIENT_ID || '').trim()
  const MS_CLIENT_ID = envClientId || '5d109662-be45-4c4c-9d40-3a07adec8fb0'
  // Secret only honored when caller explicitly overrode the client_id —
  // pairing a stray secret with the bundled public client produces
  // AADSTS invalid_client from Azure.
  const MS_CLIENT_SECRET = envClientId
    ? ((process.env.MAILCOPILOT_MS_CLIENT_SECRET || '').trim() || undefined)
    : undefined
  if (!MS_CLIENT_ID) throw new Error('MAILCOPILOT_MS_CLIENT_ID is not configured (required for Microsoft OAuth token refresh)')

  // Wrap in a holder so the async IIFE can compare `holder.p` after await
  // without the TS2454 "used before assigned" error that a direct `p` ref
  // inside its own initializer produces.
  const holder: { p?: Promise<OutlookTokenCacheEntry> } = {}
  holder.p = (async () => {
    const found = await getOauthRefreshTokenWithSource('outlook', accountId)
    if (!found) throw new Error(`Microsoft refresh token for account #${accountId} not found (re-authorization required)`)
    const refreshToken = found.token

    // Refresh with Exchange-only scope subset — pre-2.2-E accounts may
    // not have consented to Graph Mail.Send; requesting the full scope
    // list would fail with AADSTS65001 on refresh and break IMAP/sync.
    const result = await refreshMicrosoftAccessToken({
      clientId: MS_CLIENT_ID,
      clientSecret: MS_CLIENT_SECRET,
      refreshToken,
      scopes: MICROSOFT_EXCHANGE_SCOPES,
    })
    // Persist rotated refresh_token via the per-account keytar write chain.
    // All three guards (truthy rotated token + inflight-ownership + not
    // reconnecting) are re-checked INSIDE the chain so concurrent
    // reconnect keytar writes cannot overwrite our decision: the chain
    // serializes, and at the moment our fn runs any earlier reconnect
    // flag-set will be observable. See KEYTAR_WRITE_CHAIN comment.
    if (result.refreshToken) {
      await chainKeytarWrite(accountId, async () => {
        if (
          OUTLOOK_TOKEN_REFRESH_INFLIGHT.get(accountId) === holder.p
          && !RECONNECTING_ACCOUNT_IDS.has(accountId)
        ) {
          await setOauthRefreshToken('outlook', accountId, result.refreshToken!)
        }
      })
    }
    // Guard against stale writes after a reconnect. `connectOutlookAccount`
    // calls `clearOutlookTokenCache` which deletes this accountId from the
    // inflight map; if we're no longer the current inflight promise our
    // token was minted from a pre-reconnect refresh_token (possibly a
    // different identity), so drop it rather than clobber the post-reconnect
    // cache.
    if (OUTLOOK_TOKEN_REFRESH_INFLIGHT.get(accountId) === holder.p) {
      OUTLOOK_TOKEN_CACHE.set(accountId, result)
    }
    return result
  })()
  const p = holder.p
  OUTLOOK_TOKEN_REFRESH_INFLIGHT.set(accountId, p)
  try {
    return (await p).accessToken
  } finally {
    if (OUTLOOK_TOKEN_REFRESH_INFLIGHT.get(accountId) === p) OUTLOOK_TOKEN_REFRESH_INFLIGHT.delete(accountId)
  }
}

export function clearOutlookTokenCache(accountId: number): void {
  OUTLOOK_TOKEN_CACHE.delete(accountId)
  OUTLOOK_TOKEN_REFRESH_INFLIGHT.delete(accountId)
  GRAPH_SEND_TOKEN_CACHE.delete(accountId)
  GRAPH_SEND_TOKEN_REFRESH_INFLIGHT.delete(accountId)
}

/**
 * Returns a Microsoft Graph-resource access token (aud=graph.microsoft.com)
 * with `Mail.Send` scope, used by `POST /me/sendMail`. Uses a SEPARATE
 * cache from `getOutlookAccessToken()` because the Exchange-resource and
 * Graph-resource tokens have different `aud` claims and are not
 * interchangeable.
 */
export async function getOutlookGraphSendAccessToken(accountId: number): Promise<string> {
  const cached = GRAPH_SEND_TOKEN_CACHE.get(accountId)
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.accessToken

  const inflight = GRAPH_SEND_TOKEN_REFRESH_INFLIGHT.get(accountId)
  if (inflight) return (await inflight).accessToken

  const envClientId = (process.env.MAILCOPILOT_MS_CLIENT_ID || '').trim()
  const MS_CLIENT_ID = envClientId || '5d109662-be45-4c4c-9d40-3a07adec8fb0'
  const MS_CLIENT_SECRET = envClientId
    ? ((process.env.MAILCOPILOT_MS_CLIENT_SECRET || '').trim() || undefined)
    : undefined
  if (!MS_CLIENT_ID) throw new Error('MAILCOPILOT_MS_CLIENT_ID is not configured (required for Microsoft Graph send)')

  const holder: { p?: Promise<OutlookTokenCacheEntry> } = {}
  holder.p = (async () => {
    const found = await getOauthRefreshTokenWithSource('outlook', accountId)
    if (!found) throw new Error(`Microsoft refresh token for account #${accountId} not found (re-authorization required)`)

    const result = await refreshMicrosoftAccessToken({
      clientId: MS_CLIENT_ID,
      clientSecret: MS_CLIENT_SECRET,
      refreshToken: found.token,
      scopes: MICROSOFT_GRAPH_SEND_SCOPES,
    })
    // Persist rotated refresh_token (see getOutlookAccessToken comment).
    if (result.refreshToken) {
      await chainKeytarWrite(accountId, async () => {
        if (
          GRAPH_SEND_TOKEN_REFRESH_INFLIGHT.get(accountId) === holder.p
          && !RECONNECTING_ACCOUNT_IDS.has(accountId)
        ) {
          await setOauthRefreshToken('outlook', accountId, result.refreshToken!)
        }
      })
    }
    // Same stale-write guard as getOutlookAccessToken — see comment there.
    if (GRAPH_SEND_TOKEN_REFRESH_INFLIGHT.get(accountId) === holder.p) {
      GRAPH_SEND_TOKEN_CACHE.set(accountId, result)
    }
    return result
  })()
  const p = holder.p
  GRAPH_SEND_TOKEN_REFRESH_INFLIGHT.set(accountId, p)
  try {
    return (await p).accessToken
  } finally {
    if (GRAPH_SEND_TOKEN_REFRESH_INFLIGHT.get(accountId) === p) GRAPH_SEND_TOKEN_REFRESH_INFLIGHT.delete(accountId)
  }
}

/**
 * Force-refresh the Outlook access token while preserving single-flight
 * deduplication. If a refresh is already in-flight, waits for it instead
 * of starting a second one (avoids Microsoft throttling / token revocation
 * from concurrent refreshMicrosoftAccessToken calls). If no refresh is
 * in-flight, clears only the token cache (NOT the inflight map) and
 * delegates to getOutlookAccessToken which will trigger a fresh refresh.
 */
export async function forceRefreshOutlookAccessToken(accountId: number): Promise<string> {
  const inflight = OUTLOOK_TOKEN_REFRESH_INFLIGHT.get(accountId)
  if (inflight) return (await inflight).accessToken
  // Clear only the cached token so getOutlookAccessToken sees it as expired
  // and triggers a refresh. Do NOT clear OUTLOOK_TOKEN_REFRESH_INFLIGHT —
  // that would break single-flight dedupe for concurrent callers.
  OUTLOOK_TOKEN_CACHE.delete(accountId)
  return getOutlookAccessToken(accountId)
}

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

const accountIdSchema = z.number().int().positive()

export interface ConnectOutlookParams {
  existingAccountId: unknown
  openExternal: (url: string) => void
  broadcast: (channel: string, payload: unknown) => void
  isE2E: boolean
}

export async function connectOutlookAccount(params: ConnectOutlookParams): Promise<{
  ok: true
  id: number
  email: string
  tlsCertRequired?: { imap?: { host: string; port: number }; smtp?: { host: string; port: number } }
}> {
  const { existingAccountId, isE2E } = params

  if (isE2E) throw new Error('Microsoft OAuth is not available in e2e mode')

  const envClientId = (process.env.MAILCOPILOT_MS_CLIENT_ID || '').trim()
  const MS_CLIENT_ID = envClientId || '5d109662-be45-4c4c-9d40-3a07adec8fb0'
  const MS_CLIENT_SECRET = envClientId
    ? ((process.env.MAILCOPILOT_MS_CLIENT_SECRET || '').trim() || undefined)
    : undefined
  if (!MS_CLIENT_ID) throw new Error('MAILCOPILOT_MS_CLIENT_ID environment variable is required for Microsoft OAuth')

  const existingId = (existingAccountId === undefined || existingAccountId === null)
    ? undefined
    : accountIdSchema.parse(existingAccountId)

  if (typeof existingId === 'number' && !getAccountMeta(existingId)) {
    throw new Error(`Account #${existingId} not found`)
  }

  if (isMicrosoftOAuthBusy()) throw new Error('Microsoft OAuth is already running in another window')

  // Mark this account as reconnecting BEFORE the long OAuth round-trip.
  // Any in-flight getOutlookAccessToken / getOutlookGraphSendAccessToken
  // refresh that completes during this window must NOT persist its
  // rotated refresh_token — the pre-reconnect refresh_token derived from
  // the pre-reconnect identity would overwrite the fresh one we're about
  // to write. Cleared in finally regardless of success/failure.
  if (typeof existingId === 'number') RECONNECTING_ACCOUNT_IDS.add(existingId)

  try {
    return await doConnectOutlookAccount(params, existingId, MS_CLIENT_ID, MS_CLIENT_SECRET)
  } finally {
    if (typeof existingId === 'number') RECONNECTING_ACCOUNT_IDS.delete(existingId)
  }
}

async function doConnectOutlookAccount(
  params: ConnectOutlookParams,
  existingId: number | undefined,
  MS_CLIENT_ID: string,
  MS_CLIENT_SECRET: string | undefined,
): Promise<{
  ok: true
  id: number
  email: string
  tlsCertRequired?: { imap?: { host: string; port: number }; smtp?: { host: string; port: number } }
}> {
  const { openExternal, broadcast } = params

  log.info('Starting Microsoft OAuth flow...')
  const tokens = await runMicrosoftOAuthFlow({
    clientId: MS_CLIENT_ID,
    clientSecret: MS_CLIENT_SECRET,
    openExternal,
  })
  log.info('Microsoft OAuth flow completed, got email:', tokens.email)

  const imapMeta = {
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    user: tokens.email,
  }
  // Consumer Outlook.com SMTP endpoint (smtp-mail.outlook.com) per Microsoft
  // docs. smtp.office365.com is the M365 business endpoint and fails for
  // personal accounts with 5.7.139. Business mailboxes accept both hosts.
  const smtpMeta = {
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
    user: tokens.email,
  }

  // Test IMAP/SMTP with timeout (30 sec) to avoid hanging indefinitely.
  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (${ms / 1000}s)`)), ms))])

  const isTlsCertError = (msg: string) =>
    /SELF.SIGNED|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED|DEPTH_ZERO|CERT_UNTRUSTED|CERT_REJECTED|CERT_ALTNAME_INVALID|ERR_TLS_CERT/i.test(msg)

  let tlsCertImap: { host: string; port: number } | undefined
  let tlsCertSmtp: { host: string; port: number } | undefined

  log.info('Testing Microsoft IMAP...')
  try {
    const imapRes = await withTimeout(testImapConnection({ ...imapMeta, accessToken: tokens.accessToken }), 30_000, 'IMAP')
    log.info('Microsoft IMAP result:', JSON.stringify(imapRes))
    if (!imapRes.ok) {
      if (isTlsCertError(imapRes.error || '')) {
        tlsCertImap = { host: imapMeta.host, port: imapMeta.port }
        log.warn('Microsoft IMAP TLS cert error (account will be saved, user can accept the certificate):', imapRes.error)
      } else {
        // §2.82 iter2 — `imapRes.error` is verbatim server text. Exchange
        // spells the mailbox out in an authentication failure, so only the
        // bucketed class may leave the process; the full text still goes to the
        // local log and to the renderer-facing error below.
        captureException(
          new Error(`outlook_imap_test_failed: ${classifyConnectionTestFailure(imapRes.error)}`),
          { source: 'MicrosoftOAuth', stage: 'imap_test' },
        )
        throw new Error(`IMAP: ${imapRes.error || 'error'}`)
      }
    }
  } catch (e) {
    if (e instanceof Error && (e.message.startsWith('IMAP:') || e.message.includes('TLS'))) throw e
    log.error('Microsoft IMAP test error:', e instanceof Error ? e.message : e)
    captureException(
      new Error(`outlook_imap_test_threw: ${classifyConnectionTestFailure(e)}`),
      { source: 'MicrosoftOAuth', stage: 'imap_test' },
    )
    throw e
  }

  // SMTP test -- non-critical. If IMAP passed, the token works and SMTP should too.
  log.info('Testing Microsoft SMTP...')
  try {
    const smtpRes = await withTimeout(testSmtpConnection({ ...smtpMeta, accessToken: tokens.accessToken }), 15_000, 'SMTP')
    log.info('Microsoft SMTP result:', JSON.stringify(smtpRes))
    if (!smtpRes.ok) {
      if (isTlsCertError(smtpRes.error || '')) {
        tlsCertSmtp = { host: smtpMeta.host, port: smtpMeta.port }
        log.warn('Microsoft SMTP TLS cert error (user can accept the certificate):', smtpRes.error)
      } else {
        log.warn('Microsoft SMTP test failed (account will be saved):', smtpRes.error)
        captureException(
          new Error(`outlook_smtp_test_failed: ${classifyConnectionTestFailure(smtpRes.error)}`),
          { source: 'MicrosoftOAuth', stage: 'smtp_test' },
        )
      }
    }
  } catch (e) {
    log.warn('Microsoft SMTP test failed with error (account will be saved):', e instanceof Error ? e.message : e)
    captureException(
      new Error(`outlook_smtp_test_threw: ${classifyConnectionTestFailure(e)}`),
      { source: 'MicrosoftOAuth', stage: 'smtp_test' },
    )
  }

  const existingMeta = typeof existingId === 'number' ? getAccountMeta(existingId) : undefined

  // Pre-write refresh token for existing non-OAuth accounts transitioning
  // to OAuth (same ordering constraint as Google flow). Serialized via
  // the per-account keytar chain so any in-flight rotated-refresh write
  // has to complete (and honour the RECONNECTING flag it will observe)
  // before our write lands.
  const existingIsNonOAuth = !!existingMeta && existingMeta.authType !== 'oauth2'
  if (typeof existingId === 'number' && existingIsNonOAuth) {
    await chainKeytarWrite(existingId, () =>
      setOauthRefreshToken('outlook', existingId, tokens.refreshToken),
    )
  }

  const { id } = await saveAccount({
    id: existingId,
    name: existingMeta?.name,
    authType: 'oauth2',
    providerId: 'outlook',
    transportType: 'imap-smtp',
    imap: imapMeta,
    smtp: smtpMeta,
    folderRoles: existingMeta?.folderRoles ?? {},
    signature: existingMeta?.signature,
  })

  // Main refresh-token write — chained per accountId to serialize against
  // any in-flight stale refresh writes. With RECONNECTING_ACCOUNT_IDS
  // still set (cleared in the outer finally), the stale writers will
  // skip when their chained body runs.
  await chainKeytarWrite(id, () =>
    setOauthRefreshToken('outlook', id, tokens.refreshToken),
  )
  // Invalidate any pre-reconnect cached tokens (both Exchange and Graph)
  // before seeding the freshly-obtained one — after a re-auth the cached
  // Graph token would still be bound to the old identity/consent and would
  // keep being returned from `getOutlookGraphSendAccessToken()` until it
  // expired, meaning the next send could authenticate as the pre-reconnect
  // user. Clearing both caches + both inflight maps closes that window.
  clearOutlookTokenCache(id)
  OUTLOOK_TOKEN_CACHE.set(id, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt })
  broadcast('accounts:changed', { kind: 'saved', id })
  const tlsCertRequired = (tlsCertImap || tlsCertSmtp) ? { imap: tlsCertImap, smtp: tlsCertSmtp } : undefined
  return { ok: true as const, id, email: tokens.email, tlsCertRequired }
}
