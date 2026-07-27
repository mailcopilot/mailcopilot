// @vitest-environment jsdom
/**
 * Unit tests for src/components/CertRecoveryDialog.tsx (TLS trust rework A3).
 *
 * The component is presentational: coverage focuses on what it renders from a
 * given CertRecoveryDialogState and how it wires its two callbacks. Every
 * server-supplied field is rendered as a text node (no HTML injection).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import type { CertRecoveryDialogState } from '../hooks/useCertRecovery'

// Stable i18n mock — key + interpolated params so we can assert on both.
const stableT = (key: string, opts?: Record<string, unknown>): string => {
  if (opts && Object.keys(opts).length > 0) {
    const parts = Object.entries(opts).map(([k, v]) => `${k}=${String(v)}`).join(',')
    return `${key}(${parts})`
  }
  return key
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: stableT }) }))
vi.mock('../sentry', () => ({ captureException: vi.fn() }))

// jsdom ships no Clipboard API — install a controllable stub.
const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText },
  writable: true,
  configurable: true,
})

import CertRecoveryDialog from './CertRecoveryDialog'

/** True when the string still carries a control character or an invisible
 *  formatting one (bidi controls, zero-width, deprecated U+206A–U+206F, tags,
 *  variation selectors…). Invisible set taken from the Unicode properties so
 *  the assertion cannot drift from a hand-maintained range list. */
function hasControlOrBidi(value: string): boolean {
  if (/[\p{Default_Ignorable_Code_Point}\p{Cf}]/u.test(value)) return true
  return Array.from(value).some(ch => {
    const cp = ch.codePointAt(0) ?? 0
    return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)
  })
}

function baseState(overrides: Partial<CertRecoveryDialogState> = {}): CertRecoveryDialogState {
  return {
    request: {
      accountId: 1,
      host: 'imap.example.com',
      port: 993,
      issuerCn: 'Kaspersky Personal Root',
      subjectCn: 'imap.example.com',
      fingerprintSha256: 'AA:BB:CC:DD',
      systemOnly: true,
      rawMessage: 'self-signed certificate in certificate chain',
    },
    // The on-screen certificate — what the primary button will pin. Starts out
    // equal to the payload and is replaced wholesale by a probe result.
    fingerprint: 'AA:BB:CC:DD',
    issuerCn: 'Kaspersky Personal Root',
    subjectCn: '',
    review: null,
    trusting: false,
    reprobing: false,
    dismissing: false,
    reprobeFailed: false,
    stale: false,
    errorKey: null,
    ...overrides,
  }
}

/** A realistic normalized SHA-256 leaf fingerprint (32 colon-separated bytes). */
const FULL_FINGERPRINT = Array.from({ length: 32 }, (_, i) =>
  i.toString(16).toUpperCase().padStart(2, '0')).join(':')

function renderDialog(state: CertRecoveryDialogState, over: Partial<React.ComponentProps<typeof CertRecoveryDialog>> = {}) {
  const props: React.ComponentProps<typeof CertRecoveryDialog> = {
    state,
    onTrust: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  }
  return { ...render(React.createElement(CertRecoveryDialog, props)), props }
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup() })

describe('CertRecoveryDialog — rendering', () => {
  it('renders host:port from the request and the on-screen certificate identity', () => {
    renderDialog(baseState())
    expect(screen.getByTestId('cert-recovery-host')).toHaveTextContent('imap.example.com:993')
    expect(screen.getByTestId('cert-recovery-issuer')).toHaveTextContent('Kaspersky Personal Root')
    expect(screen.getByTestId('cert-recovery-fingerprint')).toHaveTextContent('AA:BB:CC:DD')
  })

  it('renders the certificate on screen, not the one from the original payload', () => {
    // After a re-read the state fields diverge from `request`; the dialog must
    // describe what will actually be pinned.
    renderDialog(baseState({
      fingerprint: 'NEW:FP',
      issuerCn: 'Rotated CA',
      subjectCn: 'mail.example.com',
      review: 'updated',
    }))
    expect(screen.getByTestId('cert-recovery-fingerprint')).toHaveTextContent('NEW:FP')
    expect(screen.getByTestId('cert-recovery-issuer')).toHaveTextContent('Rotated CA')
    expect(screen.getByTestId('cert-recovery-subject')).toHaveTextContent('mail.example.com')
    expect(screen.queryByTestId('cert-recovery-issuer')).not.toHaveTextContent('Kaspersky')
  })

  it.each([
    ['fetched'],
    ['updated'],
  ] as const)('explains why the %s certificate needs a look before confirming', review => {
    renderDialog(baseState({ review }))
    expect(screen.getByTestId('cert-recovery-review'))
      .toHaveTextContent(`app.certRecovery.review.${review}`)
  })

  it('omits the review block for the certificate the prompt originally described', () => {
    renderDialog(baseState())
    expect(screen.queryByTestId('cert-recovery-review')).not.toBeInTheDocument()
  })

  it('hides the subject row when no subject is known', () => {
    renderDialog(baseState())
    expect(screen.queryByTestId('cert-recovery-subject')).not.toBeInTheDocument()
  })

  it('falls back to an "unknown" label when issuer is empty', () => {
    renderDialog(baseState({ issuerCn: '' }))
    expect(screen.getByTestId('cert-recovery-issuer')).toHaveTextContent('app.certRecovery.issuerUnknown')
  })

  it('falls back to an "unknown" fingerprint label when empty', () => {
    renderDialog(baseState({ fingerprint: '' }))
    expect(screen.getByTestId('cert-recovery-fingerprint')).toHaveTextContent('app.certRecovery.fingerprintUnknown')
  })

  it('shows the interception block only when systemOnly is true', () => {
    renderDialog(baseState())
    expect(screen.getByTestId('cert-recovery-interception')).toHaveTextContent(
      'app.certRecovery.interception(issuer=Kaspersky Personal Root)',
    )
    cleanup()
    renderDialog(baseState({ request: { ...baseState().request, systemOnly: false } }))
    expect(screen.queryByTestId('cert-recovery-interception')).not.toBeInTheDocument()
  })

  it('truncates an overly long raw message', () => {
    const long = 'x'.repeat(600)
    renderDialog(baseState({ request: { ...baseState().request, rawMessage: long } }))
    const raw = screen.getByTestId('cert-recovery-raw').textContent ?? ''
    expect(raw.length).toBeLessThanOrEqual(501)
    expect(raw.endsWith('…')).toBe(true)
  })

  it('omits the raw-message block when the message is empty', () => {
    renderDialog(baseState({ request: { ...baseState().request, rawMessage: '' } }))
    expect(screen.queryByTestId('cert-recovery-raw')).not.toBeInTheDocument()
  })

  it('renders untrusted server strings as text, not HTML', () => {
    const inj = '<img src=x onerror=alert(1)>'
    renderDialog(baseState({ issuerCn: inj }))
    const issuer = screen.getByTestId('cert-recovery-issuer')
    // The string is present as text; no <img> element was created from it.
    expect(issuer).toHaveTextContent(inj)
    expect(issuer.querySelector('img')).toBeNull()
  })

  it('renders an inline error when errorKey is set', () => {
    renderDialog(baseState({ errorKey: 'trustFailed' }))
    expect(screen.getByTestId('cert-recovery-error')).toHaveTextContent('app.certRecovery.error.trustFailed')
  })

  it.each([
    ['trustFingerprintMismatch'],
    ['trustPinWriteFailed'],
    ['reprobeFailed'],
  ] as const)('renders the %s fail-closed error inline', errorKey => {
    renderDialog(baseState({ errorKey }))
    expect(screen.getByTestId('cert-recovery-error'))
      .toHaveTextContent(`app.certRecovery.error.${errorKey}`)
    // Fail-closed rejections keep the prompt on screen so the user can retry.
    expect(screen.getByTestId('cert-recovery-dialog')).toBeInTheDocument()
  })

  it('labels the primary action as a read while there is nothing on screen to pin', () => {
    renderDialog(baseState({ fingerprint: '', reprobeFailed: false }))
    const trust = screen.getByTestId('cert-recovery-trust')
    expect(trust).toBeEnabled()
    // Honest label: this click cannot pin anything, it fetches the certificate.
    expect(trust).toHaveTextContent('app.certRecovery.readCertificate')
    expect(screen.getByTestId('cert-recovery-fingerprint'))
      .toHaveTextContent('app.certRecovery.fingerprintUnknown')
  })

  it('labels the primary action as trust once a certificate is on screen', () => {
    renderDialog(baseState({ review: 'updated' }))
    expect(screen.getByTestId('cert-recovery-trust')).toHaveTextContent('app.certRecovery.trust')
  })

  it.each([
    ['reprobeFailed'],
    ['trustFingerprintMismatch'],
  ] as const)('disables Trust with the %s explanation when the read failed', errorKey => {
    renderDialog(baseState({ fingerprint: '', reprobeFailed: true, errorKey }))
    expect(screen.getByTestId('cert-recovery-trust')).toBeDisabled()
    expect(screen.getByTestId('cert-recovery-error'))
      .toHaveTextContent(`app.certRecovery.error.${errorKey}`)
  })

  it.each([
    ['trustNotOffered'],
    ['dismissNotPending'],
  ] as const)('renders the %s explanation for a prompt main has retired', errorKey => {
    renderDialog(baseState({ errorKey, stale: true }))
    expect(screen.getByTestId('cert-recovery-error'))
      .toHaveTextContent(`app.certRecovery.error.${errorKey}`)
  })

  it('renders the dismiss-failure error so the prompt can be retried', () => {
    renderDialog(baseState({ errorKey: 'dismissFailed' }))
    expect(screen.getByTestId('cert-recovery-error')).toHaveTextContent('app.certRecovery.error.dismissFailed')
    expect(screen.getByTestId('cert-recovery-dialog')).toBeInTheDocument()
  })
})

describe('CertRecoveryDialog — untrusted field hardening', () => {
  it('bounds and neutralizes untrusted identity fields', () => {
    const state = baseState({
      request: {
        ...baseState().request,
        // Oversized values plus newline / bidi-override / zero-width controls.
        host: 'h'.repeat(400) + '\u202E.evil.example',
        rawMessage: 'line one\nline two\u202Especial' + 'z'.repeat(900),
      },
      issuerCn: 'Ka\u0000spersky\u202E Root\nCA\u200B' + 'y'.repeat(400),
      subjectCn: 'imap\u202E.evil.example' + 'w'.repeat(400),
      fingerprint: 'AA\u202E:BB\u200B:CC',
    })
    renderDialog(state)

    const ids = [
      'cert-recovery-host',
      'cert-recovery-issuer',
      'cert-recovery-subject',
      'cert-recovery-fingerprint',
      'cert-recovery-raw',
    ]
    for (const id of ids) {
      const el = screen.getByTestId(id)
      const text = el.textContent ?? ''
      // No control, bidi or zero-width characters survive into the DOM.
      expect(hasControlOrBidi(text)).toBe(false)
      // Layout attributes stay pinned regardless of the value.
      expect(el.getAttribute('dir')).toBe('ltr')
    }

    // Each field is bounded: host 255, issuer 128, raw message 500 (+ ellipsis).
    expect(Array.from(screen.getByTestId('cert-recovery-host').textContent ?? '').length)
      .toBeLessThanOrEqual(255 + 1 + ':993'.length)
    expect(Array.from(screen.getByTestId('cert-recovery-issuer').textContent ?? '').length)
      .toBeLessThanOrEqual(129)
    expect(Array.from(screen.getByTestId('cert-recovery-raw').textContent ?? '').length)
      .toBeLessThanOrEqual(501)
    // The bidi override never reaches the fingerprint node.
    expect(screen.getByTestId('cert-recovery-fingerprint')).toHaveTextContent('AA:BB:CC')
  })

  it('strips deprecated and zero-width formatting from the identity fields', () => {
    // Same class as the bidi override above: invisible formatting characters
    // let the server change what the user reads while deciding to trust.
    renderDialog(baseState({
      issuerCn: 'Root\u206ACA\u206F Ltd',
      subjectCn: 'imap\u2060.example\u00AD.com',
      fingerprint: 'AA\u200D:BB\uFE0F:CC',
    }))
    expect(screen.getByTestId('cert-recovery-issuer')).toHaveTextContent('RootCA Ltd')
    expect(screen.getByTestId('cert-recovery-subject')).toHaveTextContent('imap.example.com')
    expect(screen.getByTestId('cert-recovery-fingerprint')).toHaveTextContent('AA:BB:CC')
    for (const id of ['cert-recovery-issuer', 'cert-recovery-subject', 'cert-recovery-fingerprint']) {
      expect(hasControlOrBidi(screen.getByTestId(id).textContent ?? '')).toBe(false)
    }
  })

  it('leaves a legitimate non-Latin issuer readable', () => {
    renderDialog(baseState({ issuerCn: 'Лаборатория Касперского', subjectCn: '数字证书 认证中心' }))
    expect(screen.getByTestId('cert-recovery-issuer')).toHaveTextContent('Лаборатория Касперского')
    expect(screen.getByTestId('cert-recovery-subject')).toHaveTextContent('数字证书 认证中心')
  })

  it('keeps the interception warning bidi-isolated with a hostile issuer', () => {
    const state = baseState({
      request: { ...baseState().request, systemOnly: true },
      issuerCn: 'Evil\u202E Root',
    })
    renderDialog(state)
    const warning = screen.getByTestId('cert-recovery-interception').querySelector('li')
    expect(warning?.getAttribute('dir')).toBe('ltr')
    expect(warning?.textContent ?? '').not.toMatch(/\u202E/)
  })

  it('renders the fingerprint full-width, LTR and monospaced', () => {
    renderDialog(baseState({ fingerprint: FULL_FINGERPRINT }))
    const el = screen.getByTestId('cert-recovery-fingerprint')
    // Full value, not abbreviated — the user compares it out of band.
    expect(el.textContent).toBe(FULL_FINGERPRINT)
    expect(el.getAttribute('dir')).toBe('ltr')
    expect(el.style.unicodeBidi).toBe('isolate')
    expect(el.style.fontFamily).toContain('monospace')
  })

  it('copies the fingerprint verbatim and confirms the copy', async () => {
    renderDialog(baseState({ fingerprint: FULL_FINGERPRINT }))
    const copy = screen.getByTestId('cert-recovery-copy')
    expect(copy).toHaveAttribute('aria-label', 'app.certRecovery.copyFingerprint')

    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledWith(FULL_FINGERPRINT)
    await waitFor(() => expect(screen.getByTestId('cert-recovery-copy'))
      .toHaveTextContent('app.certRecovery.copied'))
  })

  it('hides the copy action when the fingerprint is unknown', () => {
    renderDialog(baseState({ fingerprint: '' }))
    expect(screen.queryByTestId('cert-recovery-copy')).not.toBeInTheDocument()
  })

  it('does not claim a copy when the clipboard write rejects', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    renderDialog(baseState({ fingerprint: FULL_FINGERPRINT }))
    fireEvent.click(screen.getByTestId('cert-recovery-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    // Exact match: 'app.certRecovery.copy' is a substring of '…copied'.
    expect(screen.getByTestId('cert-recovery-copy').textContent?.trim()).toBe('app.certRecovery.copy')
  })

  it('does not throw when the clipboard API is unavailable', () => {
    const original = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { value: undefined, writable: true, configurable: true })
    try {
      renderDialog(baseState({ fingerprint: FULL_FINGERPRINT }))
      expect(() => fireEvent.click(screen.getByTestId('cert-recovery-copy'))).not.toThrow()
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: original, writable: true, configurable: true })
    }
  })
})

describe('CertRecoveryDialog — actions', () => {
  it('calls onTrust when the primary button is clicked', () => {
    const { props } = renderDialog(baseState())
    fireEvent.click(screen.getByTestId('cert-recovery-trust'))
    expect(props.onTrust).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when Cancel is clicked', () => {
    const { props } = renderDialog(baseState())
    fireEvent.click(screen.getByTestId('cert-recovery-cancel'))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('disables both buttons while trusting is in flight', () => {
    renderDialog(baseState({ trusting: true }))
    expect(screen.getByTestId('cert-recovery-trust')).toBeDisabled()
    expect(screen.getByTestId('cert-recovery-cancel')).toBeDisabled()
  })

  it('disables both buttons while re-probing', () => {
    renderDialog(baseState({ reprobing: true }))
    expect(screen.getByTestId('cert-recovery-trust')).toBeDisabled()
    expect(screen.getByTestId('cert-recovery-cancel')).toBeDisabled()
  })

  it('disables Trust when no fingerprint and a re-probe already failed', () => {
    renderDialog(baseState({ fingerprint: '', reprobeFailed: true, errorKey: 'reprobeFailed' }))
    expect(screen.getByTestId('cert-recovery-trust')).toBeDisabled()
  })

  it('shows the trusting label while trust is in flight', () => {
    renderDialog(baseState({ trusting: true }))
    expect(screen.getByTestId('cert-recovery-trust')).toHaveTextContent('app.certRecovery.trusting')
  })

  it('explains the wait while trust is in flight (main re-probes for up to ~12s)', () => {
    renderDialog(baseState({ trusting: true }))
    const hint = screen.getByTestId('cert-recovery-trusting-hint')
    expect(hint).toHaveTextContent('app.certRecovery.trustingHint')
    expect(hint).toHaveAttribute('role', 'status')
  })

  it('hides the wait hint when no trust is in flight', () => {
    renderDialog(baseState())
    expect(screen.queryByTestId('cert-recovery-trusting-hint')).not.toBeInTheDocument()
    cleanup()
    renderDialog(baseState({ reprobing: true }))
    expect(screen.queryByTestId('cert-recovery-trusting-hint')).not.toBeInTheDocument()
  })

  it('shows the re-probing label while re-probing', () => {
    renderDialog(baseState({ reprobing: true }))
    expect(screen.getByTestId('cert-recovery-trust')).toHaveTextContent('app.certRecovery.reprobing')
  })

  it('disables Trust once main has retired the prompt, but keeps Cancel usable', () => {
    // The offer is gone on main's side: another confirm can only be refused
    // again, while closing the leftover dialog must stay possible.
    renderDialog(baseState({ stale: true, errorKey: 'trustNotOffered' }))
    expect(screen.getByTestId('cert-recovery-trust')).toBeDisabled()
    expect(screen.getByTestId('cert-recovery-cancel')).toBeEnabled()
  })

  it('does not offer to read the certificate on a retired prompt', () => {
    // Without the stale guard a fingerprint-less retired prompt would still
    // advertise the read action, which main would refuse anyway.
    renderDialog(baseState({ stale: true, fingerprint: '', errorKey: 'trustNotOffered' }))
    const trust = screen.getByTestId('cert-recovery-trust')
    expect(trust).toBeDisabled()
    expect(trust).toHaveTextContent('app.certRecovery.trust')
  })

  it('disables both buttons and labels Cancel while a dismiss is in flight', () => {
    renderDialog(baseState({ dismissing: true }))
    expect(screen.getByTestId('cert-recovery-trust')).toBeDisabled()
    expect(screen.getByTestId('cert-recovery-cancel')).toBeDisabled()
    expect(screen.getByTestId('cert-recovery-cancel')).toHaveTextContent('app.certRecovery.dismissing')
  })
})
