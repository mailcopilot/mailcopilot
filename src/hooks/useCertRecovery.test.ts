// @vitest-environment jsdom
/**
 * Unit tests for src/hooks/useCertRecovery.ts (TLS trust rework Phase A3).
 *
 * Coverage:
 *   - subscribes to cert:recoveryRequired / cert:interceptionNotice on mount,
 *     unsubscribes the same instances on unmount (BACKLOG §2.25 leak class)
 *   - malformed payloads are ignored (missing accountId/host/port, non-object)
 *   - single recovery dialog at a time; a second host queues FIFO and is
 *     promoted when the first is resolved
 *   - two events delivered in the SAME React batch both survive (regression:
 *     the pre-reducer implementation let the second setDialog clobber the
 *     first, and main never re-notifies a host stuck in awaiting-user)
 *   - duplicate host (on-screen or queued) is dropped
 *   - trust() with a fingerprint → net:trustCert invoke, dialog closes
 *   - trust() without a fingerprint → tls:getServerCert only DISPLAYS the
 *     certificate; the pin needs a second, deliberate trust() (invariant 5:
 *     what-you-see-is-what-you-pin)
 *   - probe that yields no fingerprint → Trust stays unavailable, dialog stays
 *     open with an inline error
 *   - trust() invoke rejection → inline error, dialog stays open, no global error
 *   - trust() rejection carrying a fail-closed code from main is mapped to its
 *     own inline error; `cert_trust_fingerprint_mismatch` additionally drops the
 *     stale identity and re-reads the endpoint for review, so the user never
 *     deadlocks on the rejected value AND never blind-pins the replacement
 *   - dismiss() → cert:dismiss invoke, dialog closes / queue advances
 *   - dismiss() rejection keeps the request on screen and retryable (main stays
 *     in awaiting-user, so an optimistic close would lose the prompt)
 *   - interception notices dedupe by host, dismiss by host, and have their
 *     untrusted fields bounded/neutralized at ingest
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  sanitizeUntrustedText,
  dismissErrorKey,
  trustErrorKey,
  useCertRecovery,
  type CertRecoveryErrorKey,
  type CertRecoveryRequest,
  type CertRecoveryReviewKey,
} from './useCertRecovery'
// Aliased on purpose: a bare `it` import would shadow vitest's `it`.
import enLocale from '../i18n/locales/en.json'
import ruLocale from '../i18n/locales/ru.json'
import frLocale from '../i18n/locales/fr.json'
import deLocale from '../i18n/locales/de.json'
import esLocale from '../i18n/locales/es.json'
import itLocale from '../i18n/locales/it.json'

// ---------------------------------------------------------------------------
// window.api mock
// ---------------------------------------------------------------------------
const mockOn = vi.fn()
const mockOff = vi.fn()
const mockInvoke = vi.fn()

Object.defineProperty(window, 'api', {
  value: { on: mockOn, off: mockOff, invoke: mockInvoke },
  writable: true,
  configurable: true,
})

// Silence Sentry capture (renderer sentry reads window / env at import).
vi.mock('../sentry', () => ({ captureException: vi.fn() }))

function fire(channel: string, payload: unknown): void {
  const calls = mockOn.mock.calls as Array<[string, (payload: unknown) => void]>
  for (const [ch, fn] of calls) {
    if (ch === channel) fn(payload)
  }
}

/** True when the string still carries a control character or an invisible
 *  formatting one (bidi controls, zero-width, deprecated U+206A–U+206F, tags,
 *  variation selectors…) — the classes useCertRecovery / CertRecoveryDialog
 *  must strip from untrusted server values. The control range is expressed over
 *  code points to avoid a control-char regex; the invisible set comes from the
 *  Unicode properties themselves so the assertion cannot drift from a
 *  hand-maintained list. */
function hasControlOrBidi(value: string): boolean {
  if (/[\p{Default_Ignorable_Code_Point}\p{Cf}]/u.test(value)) return true
  return Array.from(value).some(ch => {
    const cp = ch.codePointAt(0) ?? 0
    return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)
  })
}

const REQ: CertRecoveryRequest = {
  accountId: 1,
  host: 'imap.example.com',
  port: 993,
  issuerCn: 'Kaspersky Personal Root',
  subjectCn: 'imap.example.com',
  fingerprintSha256: 'AA:BB:CC',
  systemOnly: true,
  rawMessage: 'self-signed certificate in certificate chain',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ ok: true })
})
afterEach(() => { cleanup() })

describe('useCertRecovery — subscription lifecycle', () => {
  it('subscribes to both cert channels on mount', () => {
    renderHook(() => useCertRecovery())
    const channels = (mockOn.mock.calls as Array<[string, unknown]>).map(([c]) => c)
    expect(channels).toContain('cert:recoveryRequired')
    expect(channels).toContain('cert:interceptionNotice')
  })

  it('unsubscribes the same listener instances on unmount', () => {
    const { unmount } = renderHook(() => useCertRecovery())
    const recovery = (mockOn.mock.calls as Array<[string, unknown]>)
      .find(([c]) => c === 'cert:recoveryRequired')?.[1]
    unmount()
    const offRecovery = (mockOff.mock.calls as Array<[string, unknown]>)
      .find(([c]) => c === 'cert:recoveryRequired')
    expect(offRecovery?.[1]).toBe(recovery)
  })

  it('re-subscribes only once across re-renders (mount-once)', () => {
    const { rerender } = renderHook(() => useCertRecovery())
    rerender()
    rerender()
    const recoverySubs = (mockOn.mock.calls as Array<[string, unknown]>)
      .filter(([c]) => c === 'cert:recoveryRequired')
    expect(recoverySubs).toHaveLength(1)
  })
})

describe('useCertRecovery — recovery dialog queue', () => {
  it('surfaces the dialog for a valid recovery payload', () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    expect(result.current.dialog?.request.host).toBe('imap.example.com')
    expect(result.current.dialog?.fingerprint).toBe('AA:BB:CC')
  })

  it.each([
    ['non-object', 42],
    ['null', null],
    ['missing accountId', { host: 'h', port: 993 }],
    ['missing host', { accountId: 1, port: 993 }],
    ['empty host', { accountId: 1, host: '', port: 993 }],
    ['missing port', { accountId: 1, host: 'h' }],
  ])('ignores malformed payload (%s)', (_label, payload) => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', payload))
    expect(result.current.dialog).toBeNull()
  })

  it('defaults optional untrusted fields when absent', () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', { accountId: 2, host: 'h2', port: 143 }))
    const d = result.current.dialog
    expect(d?.request.issuerCn).toBe('')
    expect(d?.request.fingerprintSha256).toBe('')
    expect(d?.request.systemOnly).toBe(false)
    expect(d?.request.rawMessage).toBe('')
  })

  it('queues a second host FIFO and promotes it after the first resolves', async () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    act(() => fire('cert:recoveryRequired', { ...REQ, host: 'smtp.example.com', port: 465 }))
    expect(result.current.dialog?.request.host).toBe('imap.example.com')

    await act(async () => { await result.current.dismiss() })
    expect(result.current.dialog?.request.host).toBe('smtp.example.com')

    await act(async () => { await result.current.dismiss() })
    expect(result.current.dialog).toBeNull()
  })

  it('queues two recovery events delivered inside a single React batch', async () => {
    // Regression: with dialog + queue held in two separate useState cells, both
    // handlers in one batch observed `dialog === null` and the second
    // setDialog overwrote the first. The lost host stays `awaiting-user` in
    // main forever, so the user is never prompted for it again this session.
    const { result } = renderHook(() => useCertRecovery())
    act(() => {
      fire('cert:recoveryRequired', REQ)
      fire('cert:recoveryRequired', { ...REQ, host: 'smtp.example.com', port: 465 })
    })
    expect(result.current.dialog?.request.host).toBe('imap.example.com')

    await act(async () => { await result.current.dismiss() })
    expect(result.current.dialog?.request.host).toBe('smtp.example.com')
    expect(result.current.dialog?.request.port).toBe(465)

    await act(async () => { await result.current.dismiss() })
    expect(result.current.dialog).toBeNull()
  })

  it('keeps three same-batch events in FIFO order', async () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => {
      fire('cert:recoveryRequired', REQ)
      fire('cert:recoveryRequired', { ...REQ, host: 'b.example.com' })
      fire('cert:recoveryRequired', { ...REQ, host: 'c.example.com' })
    })
    const seen: Array<string | undefined> = []
    for (let i = 0; i < 3; i++) {
      seen.push(result.current.dialog?.request.host)
      await act(async () => { await result.current.dismiss() })
    }
    expect(seen).toEqual(['imap.example.com', 'b.example.com', 'c.example.com'])
    expect(result.current.dialog).toBeNull()
  })

  it('drops a same-batch duplicate host', () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => {
      fire('cert:recoveryRequired', REQ)
      fire('cert:recoveryRequired', { ...REQ, port: 111 })
    })
    expect(result.current.dialog?.request.port).toBe(993)
  })

  it('drops a duplicate host that is already on screen', () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    act(() => fire('cert:recoveryRequired', { ...REQ, port: 111 }))
    // Still the original, and no second entry promoted after dismiss below.
    expect(result.current.dialog?.request.port).toBe(993)
  })
})

describe('useCertRecovery — trust()', () => {
  it('invokes net:trustCert with the payload fingerprint and closes the dialog', async () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.trust() })

    expect(mockInvoke).toHaveBeenCalledWith('net:trustCert', {
      accountId: 1,
      host: 'imap.example.com',
      port: 993,
      fingerprintSha256: 'AA:BB:CC',
    })
    expect(mockInvoke).not.toHaveBeenCalledWith('tls:getServerCert', expect.anything())
    expect(result.current.dialog).toBeNull()
  })

  it('only displays the probed certificate when the payload has no fingerprint', async () => {
    // What-you-see-is-what-you-pin: the payload carried nothing to confirm, so
    // the first confirm reads the certificate and shows it. Pinning a value the
    // user has never seen would defeat the point of the dialog.
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tls:getServerCert') {
        return Promise.resolve({ fingerprintSha256: 'DD:EE:FF', issuer: 'Probed CA', subject: 'imap.example.com' })
      }
      return Promise.resolve({ ok: true })
    })
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', { ...REQ, fingerprintSha256: '', issuerCn: '', subjectCn: '' }))
    await act(async () => { await result.current.trust() })

    expect(mockInvoke).toHaveBeenCalledWith('tls:getServerCert', { host: 'imap.example.com', port: 993 })
    expect(mockInvoke).not.toHaveBeenCalledWith('net:trustCert', expect.anything())
    expect(result.current.dialog?.fingerprint).toBe('DD:EE:FF')
    expect(result.current.dialog?.issuerCn).toBe('Probed CA')
    expect(result.current.dialog?.subjectCn).toBe('imap.example.com')
    expect(result.current.dialog?.review).toBe('fetched')
    expect(result.current.dialog?.errorKey).toBeNull()
    expect(result.current.dialog?.reprobing).toBe(false)
  })

  it('pins the displayed certificate on the confirm that follows the probe', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tls:getServerCert') return Promise.resolve({ fingerprintSha256: 'DD:EE:FF' })
      return Promise.resolve({ ok: true })
    })
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', { ...REQ, fingerprintSha256: '' }))
    await act(async () => { await result.current.trust() })

    const shown = result.current.dialog?.fingerprint
    mockInvoke.mockClear()
    await act(async () => { await result.current.trust() })

    // Exactly the value that was on screen, with no probe in between.
    expect(mockInvoke.mock.calls.map(([c]) => c)).toEqual(['net:trustCert'])
    expect(mockInvoke).toHaveBeenCalledWith('net:trustCert', expect.objectContaining({ fingerprintSha256: shown }))
    expect(result.current.dialog).toBeNull()
  })

  it('tolerates a probe answer without issuer/subject fields', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tls:getServerCert') return Promise.resolve({ fingerprintSha256: 'DD:EE:FF' })
      return Promise.resolve({ ok: true })
    })
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', { ...REQ, fingerprintSha256: '' }))
    await act(async () => { await result.current.trust() })

    // Stale payload identity must not survive next to a freshly probed
    // fingerprint — the dialog would then describe a mix of two certificates.
    expect(result.current.dialog?.issuerCn).toBe('')
    expect(result.current.dialog?.subjectCn).toBe('')
  })

  it('keeps the dialog open with an inline error when re-probe yields no fingerprint', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tls:getServerCert') return Promise.resolve({ fingerprintSha256: '' })
      return Promise.resolve({ ok: true })
    })
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', { ...REQ, fingerprintSha256: '' }))
    await act(async () => { await result.current.trust() })

    expect(mockInvoke).not.toHaveBeenCalledWith('net:trustCert', expect.anything())
    expect(result.current.dialog).not.toBeNull()
    expect(result.current.dialog?.reprobeFailed).toBe(true)
    expect(result.current.dialog?.errorKey).toBe('reprobeFailed')
  })

  it('surfaces an inline error and keeps the dialog open when net:trustCert rejects', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:trustCert') return Promise.reject(new Error('pin write failed'))
      return Promise.resolve({ ok: true })
    })
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.trust() })

    expect(result.current.dialog).not.toBeNull()
    expect(result.current.dialog?.errorKey).toBe('trustFailed')
    expect(result.current.dialog?.trusting).toBe(false)
  })
})

describe('useCertRecovery — trust() fail-closed codes', () => {
  /** Electron re-wraps a rejected invoke, so the code never arrives alone. */
  const wrapped = (code: string) =>
    new Error(`Error invoking remote method 'net:trustCert': Error: ${code}`)

  /** Reject net:trustCert once, then let every channel succeed again. */
  function rejectTrustOnce(err: unknown): void {
    let rejected = false
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:trustCert' && !rejected) {
        rejected = true
        return Promise.reject(err)
      }
      if (channel === 'tls:getServerCert') {
        return Promise.resolve({ fingerprintSha256: 'NEW:FP', issuer: 'Rotated CA', subject: 'imap.example.com' })
      }
      return Promise.resolve({ ok: true })
    })
  }

  it('shows the re-read certificate after a mismatch instead of pinning it', async () => {
    // The security-critical case: main refused the pin because the server now
    // serves a different certificate. Auto-pinning the re-read one would turn
    // that protective refusal into a one-click blind approval of whatever the
    // server swapped in.
    rejectTrustOnce(wrapped('cert_trust_fingerprint_mismatch'))
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.trust() })

    expect(mockInvoke.mock.calls.map(([c]) => c)).toEqual(['net:trustCert', 'tls:getServerCert'])
    // Pinned nothing: the single net:trustCert call carried the OLD value.
    expect(mockInvoke).toHaveBeenCalledWith('net:trustCert', expect.objectContaining({
      fingerprintSha256: 'AA:BB:CC',
    }))
    expect(mockInvoke).not.toHaveBeenCalledWith('net:trustCert', expect.objectContaining({
      fingerprintSha256: 'NEW:FP',
    }))
    // …and the refreshed identity is now on screen, flagged for review.
    expect(result.current.dialog?.fingerprint).toBe('NEW:FP')
    expect(result.current.dialog?.issuerCn).toBe('Rotated CA')
    expect(result.current.dialog?.subjectCn).toBe('imap.example.com')
    expect(result.current.dialog?.review).toBe('updated')
    expect(result.current.dialog?.reprobeFailed).toBe(false)
    expect(result.current.dialog?.trusting).toBe(false)
  })

  it('pins the re-read certificate only after a separate confirm', async () => {
    rejectTrustOnce(wrapped('cert_trust_fingerprint_mismatch'))
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.trust() })

    const shown = result.current.dialog?.fingerprint
    mockInvoke.mockClear()
    await act(async () => { await result.current.trust() })

    expect(mockInvoke.mock.calls.map(([c]) => c)).toEqual(['net:trustCert'])
    expect(mockInvoke).toHaveBeenCalledWith('net:trustCert', expect.objectContaining({
      fingerprintSha256: shown,
    }))
    expect(result.current.dialog).toBeNull()
  })

  it('disables trusting when the post-mismatch re-read yields no certificate', async () => {
    let rejected = false
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:trustCert' && !rejected) {
        rejected = true
        return Promise.reject(wrapped('cert_trust_fingerprint_mismatch'))
      }
      if (channel === 'tls:getServerCert') return Promise.resolve({ fingerprintSha256: '' })
      return Promise.resolve({ ok: true })
    })
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.trust() })

    // Nothing left to confirm: the stale identity is gone, no new one arrived,
    // and CertRecoveryDialog disables Trust on exactly this state.
    expect(result.current.dialog?.reprobeFailed).toBe(true)
    expect(result.current.dialog?.errorKey).toBe('trustFingerprintMismatch')
    expect(result.current.dialog?.fingerprint).toBe('')
    expect(result.current.dialog?.issuerCn).toBe('')
    expect(result.current.dialog?.subjectCn).toBe('')
    expect(result.current.dialog?.review).toBeNull()

    // A further confirm cannot pin anything either — it can only re-read.
    mockInvoke.mockClear()
    await act(async () => { await result.current.trust() })
    expect(mockInvoke.mock.calls.map(([c]) => c)).toEqual(['tls:getServerCert'])
    expect(mockInvoke).not.toHaveBeenCalledWith('net:trustCert', expect.anything())
  })

  it('propagates a rejected probe after a mismatch as an inline error', async () => {
    let rejected = false
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'net:trustCert' && !rejected) {
        rejected = true
        return Promise.reject(wrapped('cert_trust_fingerprint_mismatch'))
      }
      if (channel === 'tls:getServerCert') return Promise.reject(new Error('ECONNREFUSED'))
      return Promise.resolve({ ok: true })
    })
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.trust() })

    expect(result.current.dialog?.reprobeFailed).toBe(true)
    expect(result.current.dialog?.errorKey).toBe('trustFingerprintMismatch')
    expect(result.current.dialog?.reprobing).toBe(false)
  })

  it('marks the prompt stale when the trust offer is gone and stops confirming', async () => {
    // Expired (dialog older than main's offer window) or already used: every
    // further confirm is refused identically, so the hook must stop trying.
    rejectTrustOnce(wrapped('cert_trust_not_offered'))
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.trust() })

    expect(result.current.dialog?.errorKey).toBe('trustNotOffered')
    expect(result.current.dialog?.stale).toBe(true)
    // Fingerprint kept: nothing about the certificate was wrong, the offer was.
    expect(result.current.dialog?.fingerprint).toBe('AA:BB:CC')

    mockInvoke.mockClear()
    await act(async () => { await result.current.trust() })
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(result.current.dialog?.errorKey).toBe('trustNotOffered')
  })

  it('closes a stale prompt locally instead of invoking cert:dismiss again', async () => {
    rejectTrustOnce(wrapped('cert_trust_not_offered'))
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.trust() })

    mockInvoke.mockClear()
    await act(async () => { await result.current.dismiss() })
    // main is not holding this endpoint any more, so there is nothing to
    // acknowledge — the dialog just goes away.
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(result.current.dialog).toBeNull()
  })

  it('explains a dismiss rejected as not pending and retires the prompt', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'cert:dismiss') {
        return Promise.reject(new Error(
          "Error invoking remote method 'cert:dismiss': Error: cert_dismiss_not_pending",
        ))
      }
      return Promise.resolve({ ok: true })
    })
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.dismiss() })

    expect(result.current.dialog?.errorKey).toBe('dismissNotPending')
    expect(result.current.dialog?.stale).toBe(true)
    expect(result.current.dialog?.dismissing).toBe(false)

    // …and the next Cancel closes it without another doomed round-trip.
    mockInvoke.mockClear()
    await act(async () => { await result.current.dismiss() })
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(result.current.dialog).toBeNull()
  })

  it('keeps a generic dismiss failure retryable against main', async () => {
    // Regression guard: only `cert_dismiss_not_pending` retires the prompt. Any
    // other dismiss failure must still be re-sent, because main is holding the
    // host in awaiting-user and closing locally would burn the prompt.
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'cert:dismiss'
        ? Promise.reject(new Error('broadcast lost'))
        : Promise.resolve({ ok: true }))
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.dismiss() })

    expect(result.current.dialog?.errorKey).toBe('dismissFailed')
    expect(result.current.dialog?.stale).toBe(false)

    mockInvoke.mockClear()
    mockInvoke.mockResolvedValue({ ok: true })
    await act(async () => { await result.current.dismiss() })
    expect(mockInvoke).toHaveBeenCalledWith('cert:dismiss', { host: 'imap.example.com' })
    expect(result.current.dialog).toBeNull()
  })

  it('maps a pin-write failure to its own error and keeps the fingerprint', async () => {
    rejectTrustOnce(wrapped('cert_trust_pin_write_failed'))
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.trust() })

    expect(result.current.dialog?.errorKey).toBe('trustPinWriteFailed')
    // The certificate itself matched — only the write failed, so the retry must
    // reuse the same fingerprint without a re-read, and nothing needs review.
    expect(result.current.dialog?.fingerprint).toBe('AA:BB:CC')
    expect(result.current.dialog?.issuerCn).toBe('Kaspersky Personal Root')
    expect(result.current.dialog?.review).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalledWith('tls:getServerCert', expect.anything())

    mockInvoke.mockClear()
    await act(async () => { await result.current.trust() })
    expect(mockInvoke.mock.calls.map(([c]) => c)).toEqual(['net:trustCert'])
    expect(result.current.dialog).toBeNull()
  })

  it('keeps the generic fallback for an unrecognized rejection', async () => {
    rejectTrustOnce(new Error('EPIPE: socket closed'))
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.trust() })

    expect(result.current.dialog?.errorKey).toBe('trustFailed')
    expect(result.current.dialog?.fingerprint).toBe('AA:BB:CC')
    expect(result.current.dialog?.review).toBeNull()

    mockInvoke.mockClear()
    await act(async () => { await result.current.trust() })
    expect(mockInvoke.mock.calls.map(([c]) => c)).toEqual(['net:trustCert'])
    expect(result.current.dialog).toBeNull()
  })
})

describe('dismissErrorKey', () => {
  it.each([
    ['not-pending code', "Error invoking remote method 'cert:dismiss': Error: cert_dismiss_not_pending", 'dismissNotPending'],
    ['unrelated message', 'broadcast lost', 'dismissFailed'],
    ['empty message', '', 'dismissFailed'],
  ])('maps a rejection with a %s', (_label, message, expected) => {
    expect(dismissErrorKey(new Error(message))).toBe(expected)
  })

  it('falls back per action, not globally', () => {
    // Same unknown reason, different generic message per channel.
    expect(trustErrorKey(new Error('boom'))).toBe('trustFailed')
    expect(dismissErrorKey(new Error('boom'))).toBe('dismissFailed')
  })
})

describe('trustErrorKey', () => {
  it.each([
    ['bare code', 'cert_trust_fingerprint_mismatch', 'trustFingerprintMismatch'],
    ['wrapped code', "Error invoking remote method 'net:trustCert': Error: cert_trust_fingerprint_mismatch", 'trustFingerprintMismatch'],
    ['pin write code', 'Error: cert_trust_pin_write_failed', 'trustPinWriteFailed'],
    ['not-offered code', 'Error: cert_trust_not_offered', 'trustNotOffered'],
    ['unrelated message', 'Account #1 not found', 'trustFailed'],
    ['empty message', '', 'trustFailed'],
  ])('maps an Error with a %s', (_label, message, expected) => {
    expect(trustErrorKey(new Error(message))).toBe(expected)
  })

  it.each([
    ['string rejection', 'cert_trust_pin_write_failed', 'trustPinWriteFailed'],
    ['error-like object', { message: 'Error: cert_trust_fingerprint_mismatch' }, 'trustFingerprintMismatch'],
    ['null', null, 'trustFailed'],
    ['undefined', undefined, 'trustFailed'],
    ['number', 42, 'trustFailed'],
    ['object without message', { code: 1 }, 'trustFailed'],
  ])('handles a non-Error rejection (%s)', (_label, value, expected) => {
    expect(trustErrorKey(value)).toBe(expected)
  })
})

describe('app.certRecovery locale parity', () => {
  const LOCALES = {
    en: enLocale,
    ru: ruLocale,
    fr: frLocale,
    de: deLocale,
    es: esLocale,
    it: itLocale,
  } as const

  /** Compile-time exhaustive over CertRecoveryErrorKey / CertRecoveryReviewKey:
   *  adding a variant to either union without a translation breaks this file. */
  const ERROR_KEYS: Record<CertRecoveryErrorKey, true> = {
    trustFailed: true,
    trustFingerprintMismatch: true,
    trustPinWriteFailed: true,
    trustNotOffered: true,
    reprobeFailed: true,
    dismissFailed: true,
    dismissNotPending: true,
  }
  const REVIEW_KEYS: Record<CertRecoveryReviewKey, true> = {
    fetched: true,
    updated: true,
  }
  /** Strings the dialog renders unconditionally from the new two-step flow. */
  const FLOW_KEYS = ['subjectLabel', 'readCertificate', 'trustingHint'] as const

  function flatten(value: unknown, prefix = ''): string[] {
    if (!value || typeof value !== 'object') return [prefix]
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))
  }

  function certRecovery(locale: unknown): Record<string, unknown> {
    return (locale as { app: { certRecovery: Record<string, unknown> } }).app.certRecovery
  }

  function tlsSection(locale: unknown): Record<string, unknown> {
    return (locale as { account: { tls: Record<string, unknown> } }).account.tls
  }

  it('exposes the same key set in all six locales', () => {
    const reference = flatten(certRecovery(enLocale)).sort()
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(flatten(certRecovery(locale)).sort(), `locale ${code}`).toEqual(reference)
    }
  })

  it('translates every error, review and flow string in every locale', () => {
    const nonEmpty = (value: unknown, label: string) => {
      expect(typeof value, label).toBe('string')
      expect((value as string).length, label).toBeGreaterThan(0)
    }
    for (const [code, locale] of Object.entries(LOCALES)) {
      const block = certRecovery(locale)
      const errors = block.error as Record<string, unknown>
      for (const key of Object.keys(ERROR_KEYS)) nonEmpty(errors[key], `${code}: error.${key}`)
      const review = block.review as Record<string, unknown>
      for (const key of Object.keys(REVIEW_KEYS)) nonEmpty(review[key], `${code}: review.${key}`)
      for (const key of FLOW_KEYS) nonEmpty(block[key], `${code}: ${key}`)
    }
  })

  it('exposes the same account.tls key set in all six locales', () => {
    // The trust-anchor badge and its explanation live here, not under
    // app.certRecovery — same merge-gate rule applies.
    const reference = flatten(tlsSection(enLocale)).sort()
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(flatten(tlsSection(locale)).sort(), `locale ${code}`).toEqual(reference)
    }
  })

  it('translates the trust-anchor badge and its explanations in every locale', () => {
    const keys = ['trustAnchor', 'anchorStored', 'anchorStoredHint', 'fingerprintOnly',
      'fingerprintOnlyHint', 'addPinAnchorWarning'] as const
    for (const [code, locale] of Object.entries(LOCALES)) {
      const tls = tlsSection(locale)
      for (const key of keys) {
        expect(typeof tls[key], `${code}: account.tls.${key}`).toBe('string')
        expect((tls[key] as string).length, `${code}: account.tls.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('does not leak machine-readable codes into user-facing strings', () => {
    for (const [code, locale] of Object.entries(LOCALES)) {
      const text = JSON.stringify(certRecovery(locale))
      expect(text, `locale ${code}`).not.toContain('cert_trust_')
    }
  })
})

describe('useCertRecovery — dismiss()', () => {
  it('invokes cert:dismiss with the host and closes the dialog', async () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.dismiss() })

    expect(mockInvoke).toHaveBeenCalledWith('cert:dismiss', { host: 'imap.example.com' })
    expect(result.current.dialog).toBeNull()
  })

  it('keeps the request recoverable when cert:dismiss rejects', async () => {
    // Main only leaves `awaiting-user` once cert:dismiss is acknowledged. An
    // optimistic close would therefore burn the single prompt this host gets.
    mockInvoke.mockRejectedValue(new Error('broadcast lost'))
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))
    await act(async () => { await result.current.dismiss() })

    await waitFor(() => expect(result.current.dialog?.errorKey).toBe('dismissFailed'))
    expect(result.current.dialog?.request.host).toBe('imap.example.com')
    expect(result.current.dialog?.dismissing).toBe(false)

    // …and the user can retry: a successful dismiss then advances the queue.
    mockInvoke.mockResolvedValue({ ok: true })
    await act(async () => { await result.current.dismiss() })
    expect(result.current.dialog).toBeNull()
  })

  it('does not drop queued hosts when cert:dismiss rejects', async () => {
    mockInvoke.mockRejectedValue(new Error('broadcast lost'))
    const { result } = renderHook(() => useCertRecovery())
    act(() => {
      fire('cert:recoveryRequired', REQ)
      fire('cert:recoveryRequired', { ...REQ, host: 'smtp.example.com' })
    })
    await act(async () => { await result.current.dismiss() })
    expect(result.current.dialog?.request.host).toBe('imap.example.com')

    mockInvoke.mockResolvedValue({ ok: true })
    await act(async () => { await result.current.dismiss() })
    expect(result.current.dialog?.request.host).toBe('smtp.example.com')
  })

  it('ignores a re-entrant dismiss while one is already in flight', async () => {
    let release: (() => void) | null = null
    mockInvoke.mockImplementation(() => new Promise<void>(res => { release = () => res() }))
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:recoveryRequired', REQ))

    let first: Promise<void> | null = null
    let second: Promise<void> | null = null
    await act(async () => {
      first = result.current.dismiss()
      second = result.current.dismiss()
    })
    const dismissCalls = mockInvoke.mock.calls.filter(([c]) => c === 'cert:dismiss')
    expect(dismissCalls).toHaveLength(1)

    await act(async () => {
      release?.()
      await first
      await second
    })
    expect(result.current.dialog).toBeNull()
  })
})

describe('useCertRecovery — interception notices', () => {
  it('adds a notice and dedupes by host', () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:interceptionNotice', { host: 'imap.example.com', issuerCn: 'Kaspersky' }))
    act(() => fire('cert:interceptionNotice', { host: 'imap.example.com', issuerCn: 'Kaspersky' }))
    expect(result.current.notices).toHaveLength(1)
    expect(result.current.notices[0]).toEqual({ host: 'imap.example.com', issuerCn: 'Kaspersky' })
  })

  it('ignores malformed notice payloads', () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:interceptionNotice', { issuerCn: 'x' }))
    act(() => fire('cert:interceptionNotice', null))
    expect(result.current.notices).toHaveLength(0)
  })

  it('dismisses a notice by host', () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:interceptionNotice', { host: 'a', issuerCn: 'i' }))
    act(() => fire('cert:interceptionNotice', { host: 'b', issuerCn: 'j' }))
    act(() => result.current.dismissNotice('a'))
    expect(result.current.notices.map(n => n.host)).toEqual(['b'])
  })

  it('keeps two same-batch notices for different hosts', () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => {
      fire('cert:interceptionNotice', { host: 'a', issuerCn: 'i' })
      fire('cert:interceptionNotice', { host: 'b', issuerCn: 'j' })
    })
    expect(result.current.notices.map(n => n.host)).toEqual(['a', 'b'])
  })

  it('bounds and neutralizes untrusted notice fields at ingest', () => {
    const { result } = renderHook(() => useCertRecovery())
    act(() => fire('cert:interceptionNotice', {
      host: 'imap\u202E.example.com',
      issuerCn: 'Kaspersky\n\u200BRoot ' + 'x'.repeat(400),
    }))
    const n = result.current.notices[0]
    expect(n.host).toBe('imap.example.com')
    expect(hasControlOrBidi(n.issuerCn)).toBe(false)
    expect(Array.from(n.issuerCn).length).toBeLessThanOrEqual(129)
  })
})

describe('sanitizeUntrustedText', () => {
  it('collapses whitespace and strips control + bidi characters', () => {
    const dirty = 'Ka\u0000sper\u202Esky\tRoot\nCA\u200B'
    expect(sanitizeUntrustedText(dirty, 100)).toBe('Kaspersky Root CA')
  })

  it('bounds the length with an ellipsis', () => {
    expect(sanitizeUntrustedText('y'.repeat(50), 10)).toBe('y'.repeat(10) + '…')
  })

  it('truncates on code points, never splitting a surrogate pair', () => {
    const out = sanitizeUntrustedText('😀'.repeat(10), 3)
    expect(out).toBe('😀😀😀…')
    expect([...out].every(c => c.codePointAt(0) !== undefined && !(c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdbff && c.length === 1))).toBe(true)
  })

  it('returns an empty string for a whitespace-only value', () => {
    expect(sanitizeUntrustedText('   \n\t ', 10)).toBe('')
  })

  // The user takes a security decision from what this dialog renders, so an
  // invisible formatting character must never survive into the DOM — it can
  // reorder or hide part of the value being confirmed.
  it.each([
    ['U+206A inhibit symmetric swapping', '\u206A'],
    ['U+206B activate symmetric swapping', '\u206B'],
    ['U+206C inhibit Arabic form shaping', '\u206C'],
    ['U+206D activate Arabic form shaping', '\u206D'],
    ['U+206E national digit shapes', '\u206E'],
    ['U+206F nominal digit shapes', '\u206F'],
  ])('strips the deprecated formatting control %s', (_label, ch) => {
    expect(sanitizeUntrustedText(`Root${ch}CA`, 100)).toBe('RootCA')
  })

  it.each([
    ['soft hyphen', '\u00AD'],
    ['combining grapheme joiner', '\u034F'],
    ['Arabic letter mark', '\u061C'],
    ['Arabic number sign', '\u0600'],
    ['zero-width space', '\u200B'],
    ['zero-width non-joiner', '\u200C'],
    ['zero-width joiner', '\u200D'],
    ['left-to-right mark', '\u200E'],
    ['right-to-left override', '\u202E'],
    ['word joiner', '\u2060'],
    ['invisible times', '\u2062'],
    ['left-to-right isolate', '\u2066'],
    ['pop directional isolate', '\u2069'],
    ['Hangul filler', '\u3164'],
    ['variation selector 16', '\uFE0F'],
    ['byte order mark', '\uFEFF'],
    ['tag latin capital A', '\u{E0041}'],
  ])('strips the invisible formatting character %s', (_label, ch) => {
    expect(sanitizeUntrustedText(`Root${ch}CA`, 100)).toBe('RootCA')
  })

  it.each([
    ['Cyrillic', 'Лаборатория Касперского'],
    ['diacritics', 'Zürich Café Ärger Ĝeorgo'],
    ['CJK', '数字证书 认证中心'],
    ['punctuation and digits', "Let's Encrypt R3 - X1 (2026)"],
    ['Greek', 'Ελληνική Αρχή Πιστοποίησης'],
  ])('leaves legitimate %s text untouched', (_label, value) => {
    expect(sanitizeUntrustedText(value, 100)).toBe(value)
  })

  it('keeps emoji intact while stripping their invisible joiners', () => {
    // ZWJ / variation selectors are invisible formatting: they go, the visible
    // code points stay, and nothing is corrupted into a lone surrogate.
    const out = sanitizeUntrustedText('CA \u{1F468}\u200D\u{1F4BB}\uFE0F', 100)
    expect(out).toBe('CA \u{1F468}\u{1F4BB}')
  })
})
