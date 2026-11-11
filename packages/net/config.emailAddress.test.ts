import { describe, expect, it, vi } from 'vitest'

// Same environment stubs as config.test.ts — config.ts pulls in keytar (native),
// electron-store (Electron-only) and the DB module at import time.
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(() => Promise.resolve(null)),
    setPassword: vi.fn(() => Promise.resolve()),
    deletePassword: vi.fn(() => Promise.resolve(true)),
  },
}))

vi.mock('electron-store', () => {
  const storeData = new Map<string, unknown>()
  return {
    default: class MockStore {
      get(key: string) { return storeData.get(key) }
      set(key: string, value: unknown) { storeData.set(key, value) }
      delete(key: string) { storeData.delete(key) }
    },
  }
})

vi.mock('../db', () => ({ deleteAccountData: vi.fn() }))

import { accountSaveSchema, identitySchema, listAccounts, saveAccount } from './config'

/**
 * Regression: a mailbox on an internationalised domain could not be saved.
 *
 * `z.string().email()` in zod 4 validates against an ASCII-only grammar, so
 * `info@xn--80a1acny.xn--p1ai` (a plain punycode `.рф` address, the form the
 * server itself hands us) and `user@почта.рф` (the form a human types) were
 * both rejected by the account and identity write paths. See
 * packages/core/emailAddress.ts for the full account of the defect and for the
 * narrowings that were deliberately kept.
 */
const IDN_ADDRESSES = ['info@xn--80a1acny.xn--p1ai', 'user@почта.рф', 'a=b@example.com']

const baseAccount = {
  providerId: 'generic-imap' as const,
  transportType: 'imap-smtp' as const,
  imap: { host: 'imap.example.com', port: 993, secure: true, user: 'u' },
  smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'u' },
}

describe('account save accepts internationalised addresses', () => {
  it.each(IDN_ADDRESSES)('accountSaveSchema accepts %s', (email) => {
    const parsed = accountSaveSchema.parse({ ...baseAccount, email })
    expect(parsed.email).toBe(email)
  })

  it('accountSaveSchema trims before validating', () => {
    const parsed = accountSaveSchema.parse({ ...baseAccount, email: '  user@почта.рф  ' })
    expect(parsed.email).toBe('user@почта.рф')
  })

  it.each(IDN_ADDRESSES)('accountSaveSchema accepts an identity on %s', (email) => {
    const parsed = accountSaveSchema.parse({
      ...baseAccount,
      identities: [{ displayName: 'Me', email, isDefault: true }],
    })
    expect(parsed.identities?.[0]?.email).toBe(email)
  })

  it.each(IDN_ADDRESSES)('identitySchema accepts %s', (email) => {
    const parsed = identitySchema.parse({ id: 'i1', displayName: 'Me', email, isDefault: true })
    expect(parsed.email).toBe(email)
  })

  // The read side matters on its own: `listAccounts` drops records that fail
  // its schema, so an IDN address that survived the write path would still
  // have vanished on the next read.
  it('survives a save → read round trip', async () => {
    const { id } = await saveAccount({
      email: 'info@xn--80a1acny.xn--p1ai',
      imap: { host: 'imap.example.com', port: 993, secure: true, user: 'u', pass: 'p' },
      smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'u', pass: 'p' },
      identities: [{ displayName: 'Я', email: 'user@почта.рф', isDefault: true }],
    })
    const stored = listAccounts().find(a => a.id === id)
    expect(stored?.email).toBe('info@xn--80a1acny.xn--p1ai')
    expect(stored?.identities?.[0]?.email).toBe('user@почта.рф')
  })
})

describe('the narrowings kept on top of the wider grammar', () => {
  // The stored account/identity address is what builds the From header, so it
  // must stay ONE address and must not be able to carry a header break.
  it.each([
    ['an address list', 'a@x.com,b@y.com'],
    ['group syntax', 'Label:a@x.com'],
    ['angle brackets', '<a@x.com>'],
    ['a CRLF header break', 'a@x.com\r\nBcc: victim@example.com'],
    ['plain junk', 'not-an-address'],
  ])('accountSaveSchema still rejects %s', (_label, email) => {
    expect(() => accountSaveSchema.parse({ ...baseAccount, email })).toThrow()
  })

  it.each([
    ['an address list', 'a@x.com,b@y.com'],
    ['a CRLF header break', 'a@x.com\r\nBcc: victim@example.com'],
  ])('an identity still rejects %s', (_label, email) => {
    expect(() => accountSaveSchema.parse({
      ...baseAccount,
      identities: [{ displayName: 'Me', email, isDefault: true }],
    })).toThrow()
  })
})
