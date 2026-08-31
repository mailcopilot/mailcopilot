// @vitest-environment jsdom
/**
 * Unit tests for `testConnections()` in src/windows/Account.tsx — the
 * three-branch error message composition (2026-08-27 Windows-stand fixes).
 *
 * Before this fix the error banner was always built from a single line that
 * ran BOTH results through `x.error || t('common.error')`:
 *
 *   setError(t('account.errors.imapSmtp', {
 *     imap: imapRes.error || t('common.error'),
 *     smtp: smtpRes.error || t('common.error'),
 *   }))
 *
 * `imapRes.error` is empty by definition when `imapRes.ok` is true, so a
 * SUCCESSFUL IMAP test rendered as the literal word "error" whenever SMTP
 * failed — measured on a real mailbox: telemetry recorded
 * `onboarding.connection_test_result{kind:'imap',success:true}` while the
 * screen read "IMAP: error, SMTP: Connection timeout".
 *
 * These tests pin the three reachable outcomes once `testConnections()`
 * decides at least one side failed: both failed (still the combined
 * `imapSmtp` message), IMAP-only failed (`imapOnly`, no mention of SMTP at
 * all), and SMTP-only failed (`smtpOnly`, no mention of IMAP at all — this is
 * the exact shape of the reported bug). A revert to the old single-line
 * composition makes the IMAP-only and SMTP-only cases fail: the banner would
 * contain the other, SUCCESSFUL side's name plus the word "error".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

import en from '../i18n/locales/en.json'

function lookup(key: string): string | undefined {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    en,
  ) as string | undefined
}

const stableT = (key: string, vars?: Record<string, unknown>): string => {
  const raw = lookup(key)
  if (raw === undefined) return key
  if (!vars) return raw
  return raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => (
    vars[name] !== undefined ? String(vars[name]) : `{{${name}}}`
  ))
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT }),
}))

vi.mock('../sentry', () => ({ captureException: vi.fn() }))

import Account from './Account'

// ---------------------------------------------------------------------------
// window.api mock
// ---------------------------------------------------------------------------

const editedMeta = {
  id: 7,
  name: 'Work',
  email: 'work@example.com',
  authType: 'password' as const,
  providerId: 'generic-imap' as const,
  transportType: 'imap-smtp' as const,
  imap: { host: 'imap.example.com', port: 993, secure: true, user: 'work@example.com' },
  smtp: { host: 'smtp.example.com', port: 587, secure: true, user: 'work@example.com' },
}

type TestResult = { ok: boolean; error?: string }

let imapResult: TestResult
let smtpResult: TestResult

const mockOn = vi.fn()
const mockOff = vi.fn()
const mockInvoke = vi.fn((channel: string) => {
  if (channel === 'accounts:list') return Promise.resolve([editedMeta])
  if (channel === 'win:isMaximized') return Promise.resolve(false)
  if (channel === 'tls:listPins') return Promise.resolve([])
  if (channel === 'net:testImap') return Promise.resolve(imapResult)
  if (channel === 'net:testSmtp') return Promise.resolve(smtpResult)
  return Promise.resolve(undefined)
})

Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: mockOn, off: mockOff, removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'accounts:list') return Promise.resolve([editedMeta])
    if (channel === 'win:isMaximized') return Promise.resolve(false)
    if (channel === 'tls:listPins') return Promise.resolve([])
    if (channel === 'net:testImap') return Promise.resolve(imapResult)
    if (channel === 'net:testSmtp') return Promise.resolve(smtpResult)
    return Promise.resolve(undefined)
  })
  imapResult = { ok: true }
  smtpResult = { ok: true }
})

afterEach(cleanup)

/** Renders the edit-mode view, fills both passwords, and clicks "Test connection". */
async function renderAndTest() {
  render(React.createElement(Account, { initialMode: 'edit', initialEditId: 7 }))
  await screen.findByDisplayValue('imap.example.com')

  // Edit-mode (two-column) layout gives BOTH the IMAP and SMTP password
  // fields the placeholder `account.fields.password` (unlike the wizard's
  // manual step, which uses `smtpPassword` for the SMTP side) — DOM order
  // (IMAP section first, SMTP section second) is the only way to tell them
  // apart here.
  const passwordInputs = screen.getAllByPlaceholderText(lookup('account.fields.password')!)
  expect(passwordInputs).toHaveLength(2)
  fireEvent.change(passwordInputs[0], { target: { value: 'imap-secret' } })
  fireEvent.change(passwordInputs[1], { target: { value: 'smtp-secret' } })

  fireEvent.click(screen.getByRole('button', { name: lookup('account.actions.test')! }))
}

describe('Account testConnections() — 2026-08-27 error message composition', () => {
  it('names only the failing half when IMAP fails and SMTP succeeds', async () => {
    imapResult = { ok: false, error: 'Invalid credentials' }
    smtpResult = { ok: true }

    await renderAndTest()

    await waitFor(() => {
      expect(screen.getByText('IMAP: Invalid credentials')).toBeInTheDocument()
    })
    // The regression this guards against: the successful SMTP half must not
    // be named at all, and specifically must not surface as "SMTP: error".
    expect(screen.queryByText(/SMTP:/)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/SMTP:\s*error/i)
  })

  it('names only the failing half when SMTP fails and IMAP succeeds (the reported bug)', async () => {
    imapResult = { ok: true }
    smtpResult = { ok: false, error: 'Connection timeout' }

    await renderAndTest()

    await waitFor(() => {
      expect(screen.getByText('SMTP: Connection timeout')).toBeInTheDocument()
    })
    // This is exactly the bug as measured: a successful IMAP test rendered as
    // "IMAP: error" once the old code ran it through `|| t('common.error')`.
    expect(screen.queryByText(/IMAP:/)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/IMAP:\s*error/i)
  })

  it('still composes the combined message when both sides fail', async () => {
    imapResult = { ok: false, error: 'Invalid credentials' }
    smtpResult = { ok: false, error: 'Connection timeout' }

    await renderAndTest()

    await waitFor(() => {
      expect(screen.getByText('IMAP: Invalid credentials, SMTP: Connection timeout')).toBeInTheDocument()
    })
  })

  it('shows the success status and no error banner when both sides pass', async () => {
    imapResult = { ok: true }
    smtpResult = { ok: true }

    await renderAndTest()

    await waitFor(() => {
      expect(screen.getByText(lookup('account.status.ok')!)).toBeInTheDocument()
    })
    expect(screen.queryByText(/IMAP:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/SMTP:/)).not.toBeInTheDocument()
  })
})
