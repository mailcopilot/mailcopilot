/** Body of `oauth:google:connect`, with every outside effect injected.
 *
 *  Lives here rather than in main.ts so the refusals that protect Google's
 *  lifetime new-user cap (BACKLOG §2.297) can be exercised as real code — a
 *  new mailbox in the official build, a token for another address, a mailbox
 *  removed or replaced while the browser was open — instead of being asserted
 *  as text in a source file. The IPC handler keeps what is not policy: the e2e
 *  guard, argument parsing, the auth-state and latch clearing, the broadcast. */
import type { OAuthConnectStage } from '@mailcopilot/types'
import type { AccountMeta } from '../../packages/net/types'
import {
  mailboxIdentity,
  planGoogleConnect,
  verifyTokenAddress,
  type GoogleConnectRefusal,
} from '../googleConnectPolicy'

export type GoogleTokens = {
  email: string
  displayName: string
  accessToken: string
  expiresAt: number
  refreshToken: string
}

type Endpoint = { host: string; port: number }
type ProbeResult = { ok: boolean; error?: string }

export type GoogleConnectDeps = {
  configured: () => boolean
  newMailboxesAllowed: () => boolean
  getAccountMeta: (id: number) => AccountMeta | undefined
  /** Opens the browser flow; resolves with the tokens or rejects. */
  runOAuthFlow: (loginHint?: string) => Promise<GoogleTokens>
  fetchTokenInfo: (accessToken: string) => Promise<{ scope?: string; error_description?: string }>
  testImap: (cfg: { host: string; port: number; secure: boolean; user: string; accessToken: string }) => Promise<ProbeResult>
  testSmtp: (cfg: { host: string; port: number; secure: boolean; user: string; accessToken: string }) => Promise<ProbeResult>
  /** The input names its mailbox (`imap`), so the caller can queue saves per id.
   *  A saver that queues writes calls `gate` in its own turn with the record the write will overwrite; it throws
   *  to refuse. A saver that does not queue may ignore it: the check before the call already ran. */
  saveAccount: (
    input: { id?: number; imap: { host: string; user: string } } & Record<string, unknown>,
    gate: (stored: AccountMeta | undefined) => void,
  ) => Promise<{ id: number }>
  setRefreshToken: (accountId: number, refreshToken: string) => Promise<void>
  cacheAccessToken: (accountId: number, accessToken: string, expiresAt: number) => void
  emitProgress: (stage: OAuthConnectStage) => void
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }
}

export type GoogleConnectResult =
  | { ok: true; id: number; email: string; tlsCertRequired?: { imap?: Endpoint; smtp?: Endpoint } }
  | { ok: false; refusal: GoogleConnectRefusal }

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout (${ms / 1000}s)`)), ms))])

const isTlsCertError = (msg: string) =>
  /SELF.SIGNED|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED|DEPTH_ZERO|CERT_UNTRUSTED|CERT_REJECTED|CERT_ALTNAME_INVALID|ERR_TLS_CERT/i.test(msg)

export async function connectGoogleAccount(existingId: number | undefined, deps: GoogleConnectDeps): Promise<GoogleConnectResult> {
  const { log } = deps
  if (typeof existingId === 'number' && !deps.getAccountMeta(existingId)) {
    throw new Error(`Account #${existingId} not found`)
  }

  // §2.297 — new mailboxes do not spend Google's lifetime user cap. Refusals
  // are returned, not thrown: the text crosses IPC as plain prose and the
  // renderer needs the verdict to pick a translated message.
  const plannedFor = typeof existingId === 'number' ? deps.getAccountMeta(existingId) : undefined
  const plan = planGoogleConnect({
    configured: deps.configured(),
    newMailboxesAllowed: deps.newMailboxesAllowed(),
    existing: plannedFor,
  })
  if (!plan.ok) {
    log.warn('Google sign-in refused:', plan.refusal)
    return { ok: false, refusal: plan.refusal }
  }

  log.info('Starting OAuth flow...')
  const tokens = await deps.runOAuthFlow(plan.loginHint)
  log.info('OAuth flow completed, got email:', tokens.email)

  // Nothing is saved or written to the secret store for a different account.
  const mismatch = verifyTokenAddress(plan.loginHint, tokens.email)
  if (mismatch) {
    log.warn('Google sign-in refused:', mismatch)
    return { ok: false, refusal: mismatch }
  }
  // The plan was made before up to minutes in the browser. A mailbox removed or
  // replaced meanwhile (ids are reused) must not be resurrected or overwritten
  // by tokens obtained for the old one.
  if (existingId !== undefined && mailboxIdentity(deps.getAccountMeta(existingId)) !== mailboxIdentity(plannedFor)) {
    throw new Error('The mailbox changed during sign-in. Nothing was saved; try again.')
  }

  const imapMeta = { host: 'imap.gmail.com', port: 993, secure: true, user: tokens.email }
  const smtpMeta = { host: 'smtp.gmail.com', port: 465, secure: true, user: tokens.email }

  log.info('Token received, email:', tokens.email)

  // Verify token scopes (diagnostics for Invalid credentials).
  try {
    log.info('Checking tokeninfo...')
    const info = await deps.fetchTokenInfo(tokens.accessToken)
    // Defensive projection: Google's tokeninfo response is typed narrowly above,
    // but the runtime shape is not validated. Log only the two fields we care
    // about so an undocumented field (e.g. an echoed token) can't leak into logs.
    log.info('tokeninfo:', JSON.stringify({ scope: info.scope, error_description: info.error_description }))
    if (info.error_description) {
      throw new Error(`Google access token is invalid: ${info.error_description}`)
    }
    const scopes = (info.scope || '').split(' ')
    if (!scopes.includes('https://mail.google.com/')) {
      throw new Error('Google access token does not contain scope https://mail.google.com/ — add this scope in OAuth consent screen in Google Cloud Console (Scopes section)')
    }
    log.info('Scopes OK')
  } catch (e) {
    if (e instanceof Error && (e.message.includes('scope') || e.message.includes('invalid'))) throw e
    log.warn('Could not verify tokeninfo:', e)
  }

  let tlsCertImap: Endpoint | undefined
  let tlsCertSmtp: Endpoint | undefined

  log.info('Testing IMAP...')
  deps.emitProgress('imap')
  const imapRes = await withTimeout(deps.testImap({ ...imapMeta, accessToken: tokens.accessToken }), 30_000, 'IMAP')
  log.info('IMAP result:', JSON.stringify(imapRes))
  if (!imapRes.ok) {
    if (isTlsCertError(imapRes.error || '')) {
      tlsCertImap = { host: imapMeta.host, port: imapMeta.port }
      log.warn('IMAP TLS cert error (account will be saved, user can accept the certificate):', imapRes.error)
    } else {
      throw new Error(`IMAP: ${imapRes.error || 'error'}\n\nMake sure IMAP is enabled in Gmail (Settings → Forwarding and POP/IMAP → Enable IMAP)`)
    }
  }

  // SMTP test — non-critical. If IMAP passed, the token works and SMTP should too.
  // nodemailer verify() sometimes hangs with OAuth2, so we don't block account creation.
  log.info('Testing SMTP...')
  deps.emitProgress('smtp')
  try {
    let smtpRes = await withTimeout(deps.testSmtp({ ...smtpMeta, accessToken: tokens.accessToken }), 15_000, 'SMTP')
    if (!smtpRes.ok && /timeout|ETIMEDOUT|Connection timeout/i.test(String(smtpRes.error || ''))) {
      log.warn('SMTP 465 timeout, retrying 587 STARTTLS')
      smtpRes = await withTimeout(deps.testSmtp({
        ...smtpMeta,
        port: 587,
        secure: false,
        accessToken: tokens.accessToken,
      }), 15_000, 'SMTP (587)')
      if (smtpRes.ok) {
        smtpMeta.port = 587
        smtpMeta.secure = false
      }
    }
    log.info('SMTP result:', JSON.stringify(smtpRes))
    if (!smtpRes.ok) {
      if (isTlsCertError(smtpRes.error || '')) {
        tlsCertSmtp = { host: smtpMeta.host, port: smtpMeta.port }
        log.warn('SMTP TLS cert error (user can accept the certificate):', smtpRes.error)
      } else {
        log.warn('SMTP test failed (account will be saved):', smtpRes.error)
      }
    }
  } catch (e) {
    log.warn('SMTP test failed with error (account will be saved):', e instanceof Error ? e.message : e)
  }

  const existingMeta = typeof existingId === 'number' ? deps.getAccountMeta(existingId) : undefined
  // Same check as right after the flow, repeated here because the network tests
  // above can take a minute. It is repeated once more as the save's `gate`: the
  // write can wait in the queue of saves of this id, and the record it overwrites
  // is the one read in that turn. The self-build transition path below awaits
  // the token pre-write first, which is the lost-update window `saveAccount`
  // already has.
  const assertMailboxUnchanged = (stored: AccountMeta | undefined): void => {
    if (existingId !== undefined && mailboxIdentity(stored) !== mailboxIdentity(plannedFor)) {
      throw new Error('The mailbox changed during sign-in. Nothing was saved; try again.')
    }
  }
  assertMailboxUnchanged(existingMeta)

  // Ordering constraint (IPC trust gap — see saveAccount guard in
  // packages/net/config.ts): when transitioning an existing non-OAuth
  // account into OAuth, the refresh token MUST already be in keytar
  // before saveAccount runs, otherwise the guard rejects the save. For
  // brand-new accounts, id is allocated by saveAccount itself and no
  // existing record exists (guard is a no-op), so the keytar write
  // happens afterwards.
  const existingIsNonOAuth = !!existingMeta && existingMeta.authType !== 'oauth2'
  if (typeof existingId === 'number' && existingIsNonOAuth) {
    await deps.setRefreshToken(existingId, tokens.refreshToken)
  }

  deps.emitProgress('saving')

  const { id } = await deps.saveAccount({
    id: existingId,
    // A re-authorization must not overwrite a name the user has edited; the
    // profile name fills in only where the record has none.
    //
    // Deliberately `||`, not `??`: the read schema accepts `name: ''` while
    // the write schema requires a non-empty name, so a legacy record with a
    // blank name would otherwise carry that blank through and make the save
    // fail outright (codex-bg-review, 2026-08-02).
    name: existingMeta?.name?.trim() || tokens.displayName || undefined,
    authType: 'oauth2',
    providerId: 'gmail',
    transportType: 'imap-smtp',
    imap: imapMeta,
    smtp: smtpMeta,
    folderRoles: existingMeta?.folderRoles ?? {},
    signature: existingMeta?.signature,
  }, assertMailboxUnchanged)

  // For the new-account path (no existing record) and the re-save-of-
  // OAuth-account path, write the refresh token after saveAccount so we
  // have the final id. If we pre-wrote above for the transition path,
  // this call is a harmless no-op overwrite with the same token.
  await deps.setRefreshToken(id, tokens.refreshToken)
  deps.cacheAccessToken(id, tokens.accessToken, tokens.expiresAt)
  const tlsCertRequired = (tlsCertImap || tlsCertSmtp) ? { imap: tlsCertImap, smtp: tlsCertSmtp } : undefined
  return { ok: true, id, email: tokens.email, tlsCertRequired }
}
