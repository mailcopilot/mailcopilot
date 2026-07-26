import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Phase A2 — unit tests for the TLS cert-recovery / interception-notice
 * service. Covers:
 *   - per-ENDPOINT storm-guard (single-flight while the probe is in flight or
 *     the dialog awaits the user; duplicate cert errors swallowed; host case
 *     folded; different ports kept independent)
 *   - post-resolution debounce (trust / dismiss → eligible again only after
 *     CERT_REDELIVERY_DEBOUNCE_MS) and idempotent dismiss (renderer retry)
 *   - best-effort enrichment (probe failure → inconclusive payload broadcast)
 *   - transport forwarding: STARTTLS endpoints must be probed as STARTTLS
 *   - conclusiveness: an inconclusive report never claims interception, is
 *     never persisted, and never consumes the account's one-shot check
 *   - zero-recipient broadcasts release the slot instead of pretending the
 *     dialog / banner was shown
 *   - interception notice: one-time per host, persisted for both conclusive
 *     verdicts, NOT persisted on probe failure (retry later)
 *   - error containment: no dependency failure propagates to the caller
 */

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('../logger', () => ({ createLogger: () => logMock }))

const captureExceptionMock = vi.hoisted(() => vi.fn())
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }))

import {
  initCertRecovery,
  CERT_REDELIVERY_DEBOUNCE_MS,
  CERT_INTERCEPTION_RETRY_COOLDOWN_MS,
  CERT_TRUST_OFFER_TTL_MS,
  type CertRecoveryDeps,
  type CertRecoveryService,
} from './certRecovery'
import type { CertErrorPayload } from '../../packages/net/imap'
import type { CertTrustReport } from '../../packages/net/tls'

const REPORT: CertTrustReport = {
  fingerprintSha256: 'AA:BB',
  issuerCn: 'Kaspersky Root CA',
  subjectCn: 'imap.example.com',
  systemOnly: true,
  verdict: 'system-only',
  conclusive: true,
  evidence: 'proven',
}

/** Conclusive, but not every contributing probe identified its certificate.
 *  Showable, never persistable — packages/net `CertTrustReport.evidence`
 *  subscriber contract. */
const PARTIAL: CertTrustReport = { ...REPORT, evidence: 'partial' }

/** A probe that could not produce a trustworthy verdict (transport failure,
 *  rotated certificate, missing CA reference set). */
const INCONCLUSIVE: CertTrustReport = {
  fingerprintSha256: 'AA:BB',
  issuerCn: 'Kaspersky Root CA',
  subjectCn: 'imap.example.com',
  systemOnly: false,
  verdict: 'inconclusive',
  conclusive: false,
  evidence: 'partial',
  inconclusiveReason: 'transport-failed',
}

type HandlerMap = Map<number, (p: CertErrorPayload) => void>

function makeDeps(overrides?: Partial<CertRecoveryDeps>) {
  const handlers: HandlerMap = new Map()
  let clock = 1_000_000
  const persisted: string[][] = []
  let noticeStore: string[] = []
  const deps: CertRecoveryDeps = {
    registerCertErrorHandler: vi.fn((id, h) => { handlers.set(id, h) }),
    unregisterCertErrorHandler: vi.fn((id) => { handlers.delete(id) }),
    verifyCertTrust: vi.fn(async () => REPORT),
    // Default: one live renderer window received the broadcast.
    broadcast: vi.fn(() => 1),
    recordEvent: vi.fn(),
    providerFromHost: vi.fn(() => 'other'),
    getAccountImapEndpoint: vi.fn(async () => ({ host: 'imap.example.com', port: 993, secure: true })),
    loadNoticeShownHosts: vi.fn(() => noticeStore),
    persistNoticeShownHosts: vi.fn((hosts: string[]) => {
      noticeStore = hosts
      persisted.push(hosts)
    }),
    now: () => clock,
    ...overrides,
  }
  return {
    deps,
    handlers,
    persisted,
    advanceClock: (ms: number) => { clock += ms },
    setNoticeStore: (hosts: string[]) => { noticeStore = hosts },
  }
}

function fireCertError(
  svc: CertRecoveryService,
  handlers: HandlerMap,
  accountId = 1,
  payload?: Partial<CertErrorPayload>,
): void {
  svc.ensureAccountRegistered(accountId)
  const handler = handlers.get(accountId)
  expect(handler).toBeDefined()
  handler!({ host: 'imap.example.com', port: 993, rawMessage: 'self-signed certificate', ...payload })
}

/** Let queued microtasks (enrichAndBroadcast) settle. */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('account registration lifecycle', () => {
  it('registers a cert-error handler once per account (idempotent)', () => {
    const { deps } = makeDeps()
    const svc = initCertRecovery(deps)
    svc.ensureAccountRegistered(7)
    svc.ensureAccountRegistered(7)
    svc.ensureAccountRegistered(7)
    expect(deps.registerCertErrorHandler).toHaveBeenCalledTimes(1)
  })

  it('unregisterAccount removes the handler and allows re-registration', () => {
    const { deps } = makeDeps()
    const svc = initCertRecovery(deps)
    svc.ensureAccountRegistered(7)
    svc.unregisterAccount(7)
    expect(deps.unregisterCertErrorHandler).toHaveBeenCalledWith(7)
    svc.ensureAccountRegistered(7)
    expect(deps.registerCertErrorHandler).toHaveBeenCalledTimes(2)
  })

  it('registration failure is contained and reported', () => {
    const { deps } = makeDeps({
      registerCertErrorHandler: vi.fn(() => { throw new Error('boom') }),
    })
    const svc = initCertRecovery(deps)
    expect(() => svc.ensureAccountRegistered(1)).not.toThrow()
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'cert_recovery', step: 'register' }),
    )
  })
})

describe('cert:recoveryRequired storm-guard', () => {
  it('broadcasts an enriched payload on the first cert error', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
    expect(deps.broadcast).toHaveBeenCalledWith('cert:recoveryRequired', {
      accountId: 1,
      host: 'imap.example.com',
      port: 993,
      issuerCn: 'Kaspersky Root CA',
      subjectCn: 'imap.example.com',
      fingerprintSha256: 'AA:BB',
      systemOnly: true,
      rawMessage: 'self-signed certificate',
    })
    expect(deps.recordEvent).toHaveBeenCalledWith('cert.recovery_dialog_shown', { provider: 'other' })
  })

  it('swallows duplicate cert errors for the same host while the dialog is open', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    fireCertError(svc, handlers)
    fireCertError(svc, handlers, 2)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
    expect(deps.verifyCertTrust).toHaveBeenCalledTimes(1)
  })

  it('single-flight: a second cert error during an in-flight probe does not double-broadcast', async () => {
    let resolveProbe!: (r: CertTrustReport) => void
    const { deps, handlers } = makeDeps({
      verifyCertTrust: vi.fn(() => new Promise<CertTrustReport>((r) => { resolveProbe = r })),
    })
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    fireCertError(svc, handlers)
    resolveProbe(REPORT)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
    expect(deps.verifyCertTrust).toHaveBeenCalledTimes(1)
  })

  it('independent hosts get independent broadcasts', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers, 1, { host: 'imap.a.com' })
    fireCertError(svc, handlers, 1, { host: 'imap.b.com' })
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(2)
  })

  it('broadcasts the bare payload when the enrichment probe fails (best-effort)', async () => {
    const { deps, handlers } = makeDeps({
      verifyCertTrust: vi.fn(async () => { throw new Error('ECONNREFUSED') }),
    })
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledWith('cert:recoveryRequired', expect.objectContaining({
      issuerCn: '',
      subjectCn: '',
      fingerprintSha256: '',
      systemOnly: false,
      rawMessage: 'self-signed certificate',
    }))
  })

  it('releases the single-flight slot when broadcast itself throws', async () => {
    const broadcast = vi.fn()
      .mockImplementationOnce(() => { throw new Error('window gone') })
      .mockReturnValue(1)
    const { deps, handlers } = makeDeps({ broadcast })
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'cert_recovery', step: 'broadcast' }),
    )
    // A later cert error may retry the dialog.
    fireCertError(svc, handlers)
    await flush()
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('a throwing recordEvent does not break the broadcast flow', async () => {
    const { deps, handlers } = makeDeps({
      recordEvent: vi.fn(() => { throw new Error('metrics down') }),
    })
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
    // Storm-guard still holds (phase advanced to awaiting-user).
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
  })
})

describe('post-resolution eligibility (trust / dismiss + debounce)', () => {
  it('dismiss closes the dialog slot but suppresses re-broadcast inside the debounce window', async () => {
    const { deps, handlers, advanceClock } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    svc.dismiss('imap.example.com')
    advanceClock(CERT_REDELIVERY_DEBOUNCE_MS - 1)
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
  })

  it('host becomes eligible again after the debounce elapses', async () => {
    const { deps, handlers, advanceClock } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    svc.dismiss('imap.example.com')
    advanceClock(CERT_REDELIVERY_DEBOUNCE_MS)
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(2)
  })

  it('consumeTrustOffer behaves like dismiss for the storm-guard (debounced re-eligibility)', async () => {
    const { deps, handlers, advanceClock } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    svc.consumeTrustOffer(1, 'imap.example.com', 993)
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
    advanceClock(CERT_REDELIVERY_DEBOUNCE_MS)
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(2)
  })
})

describe('interception notice (one-time per host, persisted)', () => {
  it('broadcasts cert:interceptionNotice when systemOnly=true and persists the host', async () => {
    const { deps, persisted } = makeDeps()
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.verifyCertTrust).toHaveBeenCalledWith(
      'imap.example.com', 993, { secure: true, protocol: 'imap' },
    )
    expect(deps.broadcast).toHaveBeenCalledWith('cert:interceptionNotice', {
      host: 'imap.example.com',
      issuerCn: 'Kaspersky Root CA',
    })
    expect(deps.recordEvent).toHaveBeenCalledWith('cert.interception_notice_shown', { provider: 'other' })
    expect(persisted).toEqual([['imap.example.com']])
  })

  it('persists but does NOT broadcast when systemOnly=false', async () => {
    const { deps, persisted } = makeDeps({
      verifyCertTrust: vi.fn(async (): Promise<CertTrustReport> => (
        { ...REPORT, systemOnly: false, verdict: 'bundled-trusted' }
      )),
    })
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.broadcast).not.toHaveBeenCalled()
    expect(deps.recordEvent).not.toHaveBeenCalled()
    expect(persisted).toEqual([['imap.example.com']])
  })

  it('runs at most once per account per session', async () => {
    const { deps } = makeDeps()
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.getAccountImapEndpoint).toHaveBeenCalledTimes(1)
  })

  it('skips the probe entirely when the host is already persisted', async () => {
    const { deps, setNoticeStore } = makeDeps()
    setNoticeStore(['imap.example.com'])
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.verifyCertTrust).not.toHaveBeenCalled()
    expect(deps.broadcast).not.toHaveBeenCalled()
    expect(deps.persistNoticeShownHosts).not.toHaveBeenCalled()
  })

  it('dedups two accounts sharing one host within the session (single probe)', async () => {
    const { deps } = makeDeps()
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    svc.noteSyncSuccess(2)
    await flush()
    expect(deps.verifyCertTrust).toHaveBeenCalledTimes(1)
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
  })

  it('does NOT persist on probe failure so next session retries', async () => {
    const { deps } = makeDeps({
      verifyCertTrust: vi.fn(async () => { throw new Error('ETIMEDOUT') }),
    })
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.broadcast).not.toHaveBeenCalled()
    expect(deps.persistNoticeShownHosts).not.toHaveBeenCalled()
  })

  it('skips silently when the account endpoint cannot be resolved', async () => {
    const { deps } = makeDeps({
      getAccountImapEndpoint: vi.fn(async () => null),
    })
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.verifyCertTrust).not.toHaveBeenCalled()
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('contains endpoint-resolution failures (logged + captured, never thrown)', async () => {
    const { deps } = makeDeps({
      getAccountImapEndpoint: vi.fn(async () => { throw new Error('config store broken') }),
    })
    const svc = initCertRecovery(deps)
    expect(() => svc.noteSyncSuccess(1)).not.toThrow()
    await flush()
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'cert_recovery', step: 'interception_check', accountId: 1 }),
    )
  })

  it('a failing persistence write is contained (notice still delivered)', async () => {
    const { deps } = makeDeps({
      persistNoticeShownHosts: vi.fn(() => { throw new Error('EACCES') }),
    })
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
    expect(captureExceptionMock).not.toHaveBeenCalled()
    expect(logMock.warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Codex fix wave: endpoint-scoped guard, transport forwarding, conclusiveness,
// delivery-aware broadcasts, idempotent resolution.
// ---------------------------------------------------------------------------

describe('storm-guard key is the endpoint, not the bare host', () => {
  it('folds host case: the same endpoint spelled differently broadcasts once', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers, 1, { host: 'imap.example.com' })
    await flush()
    fireCertError(svc, handlers, 1, { host: 'IMAP.Example.COM' })
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(1)
  })

  it('different ports on one host do NOT suppress each other (993 vs 465)', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers, 1, { host: 'mail.example.com', port: 993 })
    await flush()
    fireCertError(svc, handlers, 1, { host: 'mail.example.com', port: 465 })
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(2)
    const ports = (deps.broadcast as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => (c[1] as { port: number }).port)
    expect(ports).toEqual([993, 465])
  })

  it('resolving one endpoint leaves the other host:port still guarded', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers, 1, { host: 'mail.example.com', port: 993 })
    fireCertError(svc, handlers, 1, { host: 'mail.example.com', port: 465 })
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(2)
    // Trust only the IMAP endpoint; the SMTP dialog stays open.
    svc.consumeTrustOffer(1, 'mail.example.com', 993)
    fireCertError(svc, handlers, 1, { host: 'mail.example.com', port: 465 })
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(2)
  })

  it('dismiss without a port resolves every pending endpoint of the host', async () => {
    const { deps, handlers, advanceClock } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers, 1, { host: 'mail.example.com', port: 993 })
    fireCertError(svc, handlers, 1, { host: 'mail.example.com', port: 465 })
    await flush()
    svc.dismiss('mail.example.com')
    advanceClock(CERT_REDELIVERY_DEBOUNCE_MS - 1)
    fireCertError(svc, handlers, 1, { host: 'mail.example.com', port: 993 })
    fireCertError(svc, handlers, 1, { host: 'mail.example.com', port: 465 })
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(2)
  })

  it('a repeated dismiss (renderer retry) is idempotent and does not extend the debounce', async () => {
    const { deps, handlers, advanceClock } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    svc.dismiss('imap.example.com')
    // The renderer retries the dismiss half-way through the quiet period.
    advanceClock(CERT_REDELIVERY_DEBOUNCE_MS / 2)
    expect(svc.dismiss('imap.example.com')).toBe(true)
    expect(svc.dismiss('imap.example.com', 993)).toBe(true)
    // The window still ends relative to the FIRST dismiss.
    advanceClock(CERT_REDELIVERY_DEBOUNCE_MS / 2)
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledTimes(2)
  })

  it('dismiss for an endpoint with no pending dialog is REFUSED (no pre-arming)', () => {
    const { deps } = makeDeps()
    const svc = initCertRecovery(deps)
    // Accepting this would let a renderer mute a warning before it happens.
    expect(svc.dismiss('never-seen.example.com')).toBe(false)
    expect(svc.dismiss('never-seen.example.com', 993)).toBe(false)
    expect(deps.broadcast).not.toHaveBeenCalled()
  })
})

describe('trust offer — the authorization gate for creating a trust anchor', () => {
  it('no offer exists before any dialog was shown', () => {
    const { deps } = makeDeps()
    const svc = initCertRecovery(deps)
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('no-offer')
  })

  it('a delivered dialog authorizes exactly that endpoint and fingerprint', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('ok')
    // Same host, different port — a dialog for 993 must not authorize 465.
    expect(svc.peekTrustOffer(1, 'imap.example.com', 465, 'AA:BB')).toBe('no-offer')
    // Different certificate on the authorized endpoint.
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'CC:DD')).toBe('fingerprint-mismatch')
  })

  it('matches the fingerprint regardless of separator style / case', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'aa-bb')).toBe('ok')
    expect(svc.peekTrustOffer(1, 'IMAP.Example.com', 993, 'aabb')).toBe('ok')
  })

  it('peek does not consume: a failed pin write leaves the dialog answerable', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('ok')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('ok')
  })

  it('one dialog authorizes exactly ONE pin', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    svc.consumeTrustOffer(1, 'imap.example.com', 993)
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('no-offer')
  })

  it('a dismissed dialog can no longer authorize a pin', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(svc.dismiss('imap.example.com')).toBe(true)
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('no-offer')
  })

  it('an in-flight probe is NOT an offer (no dialog has been shown yet)', async () => {
    const { deps, handlers } = makeDeps({
      verifyCertTrust: vi.fn(() => new Promise<CertTrustReport>(() => { /* never settles */ })),
    })
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).not.toHaveBeenCalled()
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('no-offer')
  })

  it('an undelivered dialog (no window) creates no offer', async () => {
    const { deps, handlers } = makeDeps({ broadcast: vi.fn(() => 0) })
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('no-offer')
  })

  it('the offer expires, so a forgotten dialog cannot be redeemed later', async () => {
    const { deps, handlers, advanceClock } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    advanceClock(CERT_TRUST_OFFER_TTL_MS - 1)
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('ok')
    advanceClock(1)
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('no-offer')
  })

  it('an offer for account A is not redeemable by account B on the same host', async () => {
    // Two mailboxes on one provider legitimately share a host; a confirmation
    // for one is not consent for the other.
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers, 7)
    await flush()
    expect(svc.peekTrustOffer(7, 'imap.example.com', 993, 'AA:BB')).toBe('ok')
    expect(svc.peekTrustOffer(8, 'imap.example.com', 993, 'AA:BB')).toBe('no-offer')
  })

  it('another account cannot burn an offer it does not own', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers, 7)
    await flush()
    svc.consumeTrustOffer(8, 'imap.example.com', 993)
    expect(svc.peekTrustOffer(7, 'imap.example.com', 993, 'AA:BB')).toBe('ok')
  })
})

describe('a blank offer authorizes nothing until main itself shows a fingerprint', () => {
  /** The enrichment probe fails — exactly the state a network attacker can
   *  force by dropping the probe, which is why a blank slot must not be a
   *  wildcard. */
  function makeBlankOffer() {
    return makeDeps({ verifyCertTrust: vi.fn(async () => { throw new Error('ECONNREFUSED') }) })
  }

  it('refuses an arbitrary fingerprint while the dialog has nothing to show', async () => {
    const { deps, handlers } = makeBlankOffer()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'ANY:THING')).toBe('no-offer')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('no-offer')
  })

  it('authorizes exactly the fingerprint main served to the dialog', async () => {
    const { deps, handlers } = makeBlankOffer()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    // The renderer re-probes through main (tls:getServerCert).
    svc.noteProbedFingerprint('imap.example.com', 993, 'DD:EE:FF')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'DD:EE:FF')).toBe('ok')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('fingerprint-mismatch')
  })

  it('a probe for an endpoint with no open dialog authorizes nothing', () => {
    const { deps } = makeBlankOffer()
    const svc = initCertRecovery(deps)
    svc.noteProbedFingerprint('imap.example.com', 993, 'DD:EE:FF')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'DD:EE:FF')).toBe('no-offer')
  })

  it('a probe for a DIFFERENT endpoint does not fill this dialog', async () => {
    const { deps, handlers } = makeBlankOffer()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    svc.noteProbedFingerprint('imap.example.com', 465, 'DD:EE:FF')
    svc.noteProbedFingerprint('other.example.com', 993, 'DD:EE:FF')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'DD:EE:FF')).toBe('no-offer')
  })

  it('a probe that yielded no fingerprint leaves the dialog unconfirmable', async () => {
    const { deps, handlers } = makeBlankOffer()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    svc.noteProbedFingerprint('imap.example.com', 993, '')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, '')).toBe('no-offer')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'DD:EE:FF')).toBe('no-offer')
  })

  it('fill-once: a later probe cannot move the target after the user saw a value', async () => {
    const { deps, handlers } = makeBlankOffer()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    svc.noteProbedFingerprint('imap.example.com', 993, 'DD:EE:FF')
    // Attacker rotates the certificate and re-probes through main.
    svc.noteProbedFingerprint('imap.example.com', 993, 'BA:DB:AD')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'BA:DB:AD')).toBe('fingerprint-mismatch')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'DD:EE:FF')).toBe('ok')
  })

  it('a probe cannot overwrite a fingerprint main enriched itself', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    svc.noteProbedFingerprint('imap.example.com', 993, 'BA:DB:AD')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'BA:DB:AD')).toBe('fingerprint-mismatch')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'AA:BB')).toBe('ok')
  })

  it('a probe cannot revive an expired dialog', async () => {
    const { deps, handlers, advanceClock } = makeBlankOffer()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    advanceClock(CERT_TRUST_OFFER_TTL_MS)
    svc.noteProbedFingerprint('imap.example.com', 993, 'DD:EE:FF')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'DD:EE:FF')).toBe('no-offer')
  })

  it('a probe during the in-flight phase authorizes nothing (no dialog yet)', async () => {
    const { deps, handlers } = makeDeps({
      verifyCertTrust: vi.fn(() => new Promise<CertTrustReport>(() => { /* never settles */ })),
    })
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    svc.noteProbedFingerprint('imap.example.com', 993, 'DD:EE:FF')
    expect(svc.peekTrustOffer(1, 'imap.example.com', 993, 'DD:EE:FF')).toBe('no-offer')
  })
})

describe('interception verdict persistence honours evidence strength', () => {
  it('shows the warning for a partial system-only verdict', async () => {
    const { deps } = makeDeps({ verifyCertTrust: vi.fn(async () => PARTIAL) })
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledWith('cert:interceptionNotice', {
      host: 'imap.example.com',
      issuerCn: 'Kaspersky Root CA',
    })
  })

  it('does NOT persist a partial verdict (one won probe race must not silence a host forever)', async () => {
    const { deps } = makeDeps({ verifyCertTrust: vi.fn(async () => PARTIAL) })
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.persistNoticeShownHosts).not.toHaveBeenCalled()
  })

  it('re-checks the host later after a partial verdict', async () => {
    const verifyCertTrust = vi.fn<(h: string, p: number) => Promise<CertTrustReport>>()
      .mockResolvedValueOnce(PARTIAL)
      .mockResolvedValue(REPORT)
    const { deps, advanceClock } = makeDeps({ verifyCertTrust })
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    advanceClock(CERT_INTERCEPTION_RETRY_COOLDOWN_MS)
    svc.noteSyncSuccess(1)
    await flush()
    expect(verifyCertTrust).toHaveBeenCalledTimes(2)
    expect(deps.persistNoticeShownHosts).toHaveBeenCalledWith(['imap.example.com'])
  })

  it('persists a proven non-interception verdict (the ordinary quiet case)', async () => {
    const { deps, persisted } = makeDeps({
      verifyCertTrust: vi.fn(async (): Promise<CertTrustReport> => (
        { ...REPORT, systemOnly: false, verdict: 'bundled-trusted' }
      )),
    })
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.broadcast).not.toHaveBeenCalled()
    expect(persisted).toEqual([['imap.example.com']])
  })
})

describe('probe transport is forwarded (STARTTLS endpoints)', () => {
  it('passes secure/protocol from the cert-error payload to verifyCertTrust', async () => {
    const { deps, handlers } = makeDeps()
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers, 1, { host: 'imap.example.com', port: 143, secure: false, protocol: 'imap' })
    await flush()
    expect(deps.verifyCertTrust).toHaveBeenCalledWith(
      'imap.example.com', 143, { secure: false, protocol: 'imap' },
    )
  })

  it('forwards the account transport for the interception probe (STARTTLS 143)', async () => {
    const { deps } = makeDeps({
      getAccountImapEndpoint: vi.fn(async () => ({ host: 'imap.example.com', port: 143, secure: false })),
    })
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.verifyCertTrust).toHaveBeenCalledWith(
      'imap.example.com', 143, { secure: false, protocol: 'imap' },
    )
  })
})

describe('inconclusive reports are never treated as verdicts', () => {
  it('recovery dialog reports systemOnly=false when the probe is inconclusive', async () => {
    const { deps, handlers } = makeDeps({
      verifyCertTrust: vi.fn(async () => ({ ...INCONCLUSIVE, systemOnly: true })),
    })
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers)
    await flush()
    expect(deps.broadcast).toHaveBeenCalledWith(
      'cert:recoveryRequired',
      expect.objectContaining({ systemOnly: false }),
    )
  })

  it('interception notice is neither broadcast nor persisted on an inconclusive report', async () => {
    const { deps } = makeDeps({
      verifyCertTrust: vi.fn(async () => INCONCLUSIVE),
    })
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.broadcast).not.toHaveBeenCalled()
    expect(deps.persistNoticeShownHosts).not.toHaveBeenCalled()
  })

  it('an inconclusive check does not consume the one-shot: a later sync re-probes', async () => {
    const verifyCertTrust = vi.fn<(h: string, p: number) => Promise<CertTrustReport>>()
      .mockResolvedValueOnce(INCONCLUSIVE)
      .mockResolvedValue(REPORT)
    const { deps, advanceClock } = makeDeps({ verifyCertTrust })
    const svc = initCertRecovery(deps)

    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.broadcast).not.toHaveBeenCalled()

    // Inside the cooldown the check stays parked...
    advanceClock(CERT_INTERCEPTION_RETRY_COOLDOWN_MS - 1)
    svc.noteSyncSuccess(1)
    await flush()
    expect(verifyCertTrust).toHaveBeenCalledTimes(1)

    // ...and runs again once it elapses, now reaching a real verdict.
    advanceClock(1)
    svc.noteSyncSuccess(1)
    await flush()
    expect(verifyCertTrust).toHaveBeenCalledTimes(2)
    expect(deps.broadcast).toHaveBeenCalledWith('cert:interceptionNotice', expect.anything())
    expect(deps.persistNoticeShownHosts).toHaveBeenCalledWith(['imap.example.com'])
  })

  it('a failed probe also leaves the account eligible for a later retry', async () => {
    const verifyCertTrust = vi.fn<(h: string, p: number) => Promise<CertTrustReport>>()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue(REPORT)
    const { deps, advanceClock } = makeDeps({ verifyCertTrust })
    const svc = initCertRecovery(deps)

    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.persistNoticeShownHosts).not.toHaveBeenCalled()

    advanceClock(CERT_INTERCEPTION_RETRY_COOLDOWN_MS)
    svc.noteSyncSuccess(1)
    await flush()
    expect(verifyCertTrust).toHaveBeenCalledTimes(2)
    expect(deps.persistNoticeShownHosts).toHaveBeenCalledWith(['imap.example.com'])
  })
})

describe('broadcasts that reached no window are not counted as shown', () => {
  it('recovery dialog: a zero-recipient broadcast releases the guard slot', async () => {
    const broadcast = vi.fn().mockReturnValueOnce(0).mockReturnValue(1)
    const { deps, handlers } = makeDeps({ broadcast })
    const svc = initCertRecovery(deps)

    fireCertError(svc, handlers)
    await flush()
    expect(broadcast).toHaveBeenCalledTimes(1)
    // No window saw the dialog → no dialog-shown telemetry.
    expect(deps.recordEvent).not.toHaveBeenCalled()

    // The next cert error may retry immediately (no debounce — the user never
    // resolved anything).
    fireCertError(svc, handlers)
    await flush()
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(deps.recordEvent).toHaveBeenCalledWith('cert.recovery_dialog_shown', { provider: 'other' })
  })

  it('interception notice: a zero-recipient broadcast is not persisted and retries later', async () => {
    const broadcast = vi.fn().mockReturnValueOnce(0).mockReturnValue(1)
    const { deps, advanceClock } = makeDeps({ broadcast })
    const svc = initCertRecovery(deps)

    svc.noteSyncSuccess(1)
    await flush()
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(deps.persistNoticeShownHosts).not.toHaveBeenCalled()
    expect(deps.recordEvent).not.toHaveBeenCalled()

    advanceClock(CERT_INTERCEPTION_RETRY_COOLDOWN_MS)
    svc.noteSyncSuccess(1)
    await flush()
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(deps.persistNoticeShownHosts).toHaveBeenCalledWith(['imap.example.com'])
  })
})

describe('persisted-host matching is case-insensitive', () => {
  it('skips the probe when the host is persisted in a different case', async () => {
    const { deps, setNoticeStore } = makeDeps({
      getAccountImapEndpoint: vi.fn(async () => ({ host: 'IMAP.Example.com', port: 993, secure: true })),
    })
    setNoticeStore(['imap.example.com'])
    const svc = initCertRecovery(deps)
    svc.noteSyncSuccess(1)
    await flush()
    expect(deps.verifyCertTrust).not.toHaveBeenCalled()
    expect(deps.persistNoticeShownHosts).not.toHaveBeenCalled()
  })
})

describe('PII discipline in logs', () => {
  it('logs error codes, never raw error messages', async () => {
    const raw = 'certificate rejected for user@secret-corp.example'
    const { deps, handlers } = makeDeps({
      verifyCertTrust: vi.fn(async () => {
        throw Object.assign(new Error(raw), { code: 'ECONNRESET' })
      }),
    })
    const svc = initCertRecovery(deps)
    fireCertError(svc, handlers, 1, { rawMessage: raw })
    await flush()
    for (const call of logMock.warn.mock.calls.concat(logMock.error.mock.calls)) {
      expect(JSON.stringify(call)).not.toContain('user@secret-corp.example')
    }
  })
})
