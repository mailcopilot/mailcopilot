import { describe, expect, it } from 'vitest'
import {
  accountSaveChangesLogin,
  type AccountSaveLoginView,
  type StoredAccountLoginView,
} from './accountSaveLoginChange'

const storedEndpoint = { host: 'imap.example.com', port: 993, secure: true, user: 'ivan@example.com' }
const stored: StoredAccountLoginView = { authType: 'password', imap: { ...storedEndpoint } }

/** The payload an unrelated edit (avatar colour, signature) actually sends. */
const cosmeticSave: AccountSaveLoginView = {
  authType: 'password',
  imap: { ...storedEndpoint, pass: undefined },
}

describe('accountSaveChangesLogin', () => {
  // The regression. src/windows/Settings.tsx `saveAvatarSettings` posts the
  // whole account record with `pass: undefined`, and the identities save posts
  // `{...meta.imap}` — `AccountMeta` omits the password by construction. Both
  // used to release the login latch, so choosing an avatar colour on a mailbox
  // with a stale password restarted the login storm the latch exists to stop.
  it('says no to a save that changes nothing about the login', () => {
    expect(accountSaveChangesLogin(cosmeticSave, stored)).toBe(false)
  })

  it('says no when the password field was submitted empty', () => {
    // The account form loads with `pass: ''` and normalises `''` to undefined,
    // so an untouched field means "keep the stored secret" — not "retry now".
    expect(accountSaveChangesLogin({ ...cosmeticSave, imap: { ...storedEndpoint, pass: '' } }, stored))
      .toBe(false)
  })

  it('says yes when a new password was submitted', () => {
    expect(accountSaveChangesLogin({ ...cosmeticSave, imap: { ...storedEndpoint, pass: 'new-secret' } }, stored))
      .toBe(true)
  })

  it('says yes for a brand-new account, which has no stored record to compare', () => {
    expect(accountSaveChangesLogin(cosmeticSave, undefined)).toBe(true)
  })

  it.each([
    ['the host', { host: 'imap2.example.com' }],
    ['the port', { port: 143 }],
    ['the TLS mode', { secure: false }],
    ['the login name', { user: 'ivan' }],
  ])('says yes when %s changed', (_label, patch) => {
    const payload: AccountSaveLoginView = { authType: 'password', imap: { ...storedEndpoint, ...patch } }
    expect(accountSaveChangesLogin(payload, stored)).toBe(true)
  })

  it('says yes when the authentication type changed', () => {
    expect(accountSaveChangesLogin({ ...cosmeticSave, authType: 'oauth2' }, stored)).toBe(true)
  })

  it('treats a missing authType as password on both sides', () => {
    // Legacy records and minimal payloads omit the field; the default must not
    // read as a change, or every such save would clear the latch again.
    expect(accountSaveChangesLogin(
      { imap: { ...storedEndpoint } },
      { imap: { ...storedEndpoint } },
    )).toBe(false)
    expect(accountSaveChangesLogin(
      { authType: 'password', imap: { ...storedEndpoint } },
      { imap: { ...storedEndpoint } },
    )).toBe(false)
  })

  it('ignores an SMTP-only password change', () => {
    // Not modelled at all: an SMTP secret cannot make an IMAP login succeed.
    // When the two genuinely share a password the wizard writes `imap.pass`
    // too, which the first rule above already catches.
    expect(accountSaveChangesLogin(cosmeticSave, stored)).toBe(false)
  })
})
