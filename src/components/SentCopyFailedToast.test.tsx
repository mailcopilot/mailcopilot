// @vitest-environment jsdom
/**
 * Component tests for src/components/SentCopyFailedToast.tsx
 *
 * Tests cover:
 *   - renders nothing until a mail:sentCopyFailed event arrives
 *   - generic message when folder is null
 *   - folder-specific message when folder is present (no message content shown)
 *   - Dismiss button hides the toast
 *   - no Retry button (§2.23 PR2 scope guard)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import SentCopyFailedToast from './SentCopyFailedToast'

// ---------------------------------------------------------------------------
// i18n mock
// ---------------------------------------------------------------------------
const i18nMap: Record<string, string> = {
  'app.sentCopyFailed.message': 'Message delivered, but saving a copy to the Sent folder failed.',
  'app.sentCopyFailed.messageWithFolder': 'Message delivered, but saving a copy to "{{folder}}" failed.',
  'app.sentCopyFailed.dismiss': 'Dismiss',
}
const stableT = (key: string, opts?: Record<string, unknown>): string => {
  const val = i18nMap[key] ?? key
  if (!opts) return val
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => (opts[k] !== undefined ? String(opts[k]) : `{{${k}}}`))
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT }),
}))

// ---------------------------------------------------------------------------
// window.api mock
// ---------------------------------------------------------------------------
const mockOn = vi.fn()
const mockOff = vi.fn()

Object.defineProperty(window, 'api', {
  value: { on: mockOn, off: mockOff },
  writable: true,
  configurable: true,
})

function fireSentCopyFailed(payload: unknown): void {
  const calls = mockOn.mock.calls as Array<[string, (payload: unknown) => void]>
  for (const [ch, fn] of calls) {
    if (ch === 'mail:sentCopyFailed') fn(payload)
  }
}

describe('SentCopyFailedToast', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('renders nothing before any event', () => {
    render(<SentCopyFailedToast />)
    expect(screen.queryByTestId('sent-copy-failed-toast')).toBeNull()
  })

  it('shows the generic message when folder is null', () => {
    render(<SentCopyFailedToast />)

    act(() => { fireSentCopyFailed({ accountId: 1, folder: null }) })

    const toast = screen.getByTestId('sent-copy-failed-toast')
    expect(toast.textContent).toContain('saving a copy to the Sent folder failed')
  })

  it('shows the folder-specific message when folder is present', () => {
    render(<SentCopyFailedToast />)

    act(() => { fireSentCopyFailed({ accountId: 1, folder: '[Gmail]/Sent Mail' }) })

    const toast = screen.getByTestId('sent-copy-failed-toast')
    expect(toast.textContent).toContain('"[Gmail]/Sent Mail"')
  })

  it('hides the toast when Dismiss is clicked', () => {
    render(<SentCopyFailedToast />)

    act(() => { fireSentCopyFailed({ accountId: 1, folder: 'Sent' }) })
    expect(screen.getByTestId('sent-copy-failed-toast')).toBeTruthy()

    fireEvent.click(screen.getByTestId('sent-copy-failed-dismiss'))
    expect(screen.queryByTestId('sent-copy-failed-toast')).toBeNull()
  })

  it('offers only Dismiss — no Retry action (§2.23 PR2 scope)', () => {
    render(<SentCopyFailedToast />)

    act(() => { fireSentCopyFailed({ accountId: 1, folder: 'Sent' }) })

    const toast = screen.getByTestId('sent-copy-failed-toast')
    expect(toast.querySelectorAll('button')).toHaveLength(1)
  })

  it('carries role="status" for ARIA live region (non-modal toast)', () => {
    render(<SentCopyFailedToast />)

    act(() => { fireSentCopyFailed({ accountId: 1, folder: null }) })

    const toast = screen.getByTestId('sent-copy-failed-toast')
    expect(toast.getAttribute('role')).toBe('status')
  })
})
