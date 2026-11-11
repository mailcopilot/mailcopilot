import { describe, it, expect, vi } from 'vitest'
import { googleRefusalMessage } from './googleRefusal'

/** Echoes the key and the interpolation values so the assertions can see both. */
const t = vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key))

describe('googleRefusalMessage (§2.297)', () => {
  it.each([
    ['new_mailbox_closed', 'account.errors.googleNewMailboxClosed'],
    ['not_configured', 'account.errors.googleNotConfigured'],
  ])('maps the %s verdict to %s without interpolation', (verdict, key) => {
    t.mockClear()
    expect(googleRefusalMessage(verdict, 'ada@gmail.com', t)).toBe(key)
    expect(t).toHaveBeenCalledTimes(1)
    expect(t).toHaveBeenCalledWith(key)
  })

  it('maps account_mismatch to its key and passes the mailbox address as {email}', () => {
    t.mockClear()
    const text = googleRefusalMessage('account_mismatch', 'ada@gmail.com', t)
    expect(t).toHaveBeenCalledWith('account.errors.googleAccountMismatch', { email: 'ada@gmail.com' })
    expect(text).toBe('account.errors.googleAccountMismatch|{"email":"ada@gmail.com"}')
  })

  it.each([
    ['an unknown verdict string', 'something_new'],
    ['undefined', undefined],
    ['null', null],
    ['a non-string', 42],
    ['an object', { refusal: 'account_mismatch' }],
    ['a differently-cased verdict', 'ACCOUNT_MISMATCH'],
  ])('falls back to the generic Google failure for %s', (_label, value) => {
    expect(googleRefusalMessage(value, 'ada@gmail.com', t)).toBe('account.errors.googleOAuthFailed')
  })

  it('does not interpolate the address into the generic failure', () => {
    t.mockClear()
    googleRefusalMessage('nope', 'ada@gmail.com', t)
    expect(t).toHaveBeenCalledWith('account.errors.googleOAuthFailed')
  })
})
