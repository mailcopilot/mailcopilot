// @vitest-environment jsdom
/**
 * §2.157 — unit tests for src/components/AccountAuthBadge.tsx.
 *
 * The component is presentational: coverage is what it renders for a given
 * account and how it wires its single callback. It is deliberately not a
 * modal, so there is nothing to dismiss and no focus trap to assert.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Stable i18n mock — key + interpolated params, so both are assertable.
const stableT = (key: string, opts?: Record<string, unknown>): string => {
  if (opts && Object.keys(opts).length > 0) {
    const parts = Object.entries(opts).map(([k, v]) => `${k}=${String(v)}`).join(',')
    return `${key}(${parts})`
  }
  return key
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: stableT }) }))

import AccountAuthBadge from './AccountAuthBadge'

afterEach(() => {
  cleanup()
})

describe('AccountAuthBadge', () => {
  it('names the account in the message', () => {
    render(<AccountAuthBadge accountId={4} accountLabel="work@example.com" onFix={vi.fn()} />)
    expect(screen.getByTestId('account-auth-badge-4')).toHaveTextContent(
      'app.accountAuth.message(account=work@example.com)',
    )
  })

  it('falls back to the account-less wording when the label is blank', () => {
    render(<AccountAuthBadge accountId={4} accountLabel="   " onFix={vi.fn()} />)
    expect(screen.getByTestId('account-auth-badge-4')).toHaveTextContent(
      'app.accountAuth.messageNoAccount',
    )
  })

  it('bounds a pathological label so the action stays reachable', () => {
    render(<AccountAuthBadge accountId={1} accountLabel={'x'.repeat(500)} onFix={vi.fn()} />)
    const text = screen.getByTestId('account-auth-badge-1').textContent ?? ''
    expect(text).not.toContain('x'.repeat(200))
    expect(screen.getByTestId('account-auth-fix-1')).toBeInTheDocument()
  })

  it('renders the label as text, never as markup', () => {
    render(
      <AccountAuthBadge accountId={2} accountLabel="<img src=x onerror=alert(1)>" onFix={vi.fn()} />,
    )
    const badge = screen.getByTestId('account-auth-badge-2')
    expect(badge.querySelector('img')).toBeNull()
    expect(badge.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('passes the account id back on click', () => {
    const onFix = vi.fn()
    render(<AccountAuthBadge accountId={12} accountLabel="a@b.c" onFix={onFix} />)
    fireEvent.click(screen.getByTestId('account-auth-fix-12'))
    expect(onFix).toHaveBeenCalledWith(12)
  })

  it('is announced politely rather than as an alert (the failure is not urgent)', () => {
    render(<AccountAuthBadge accountId={3} accountLabel="a@b.c" onFix={vi.fn()} />)
    expect(screen.getByTestId('account-auth-badge-3')).toHaveAttribute('role', 'status')
  })
})
