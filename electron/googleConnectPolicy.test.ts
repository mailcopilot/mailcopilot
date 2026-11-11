import { describe, it, expect, vi } from 'vitest'
import {
  canonicalGoogleAddress,
  isGoogleSignInMailbox,
  mailboxIdentity,
  planGoogleConnect,
  refuseOAuthIdentityRewrite,
  saveAccountGuarded,
  verifyTokenAddress,
} from './googleConnectPolicy'

const imap = (user: string) => ({ host: 'imap.gmail.com', port: 993, secure: true, user })

const googleMailbox = { authType: 'oauth2' as const, providerId: 'gmail' as const, imap: imap('  Ada@Gmail.com ') }
const passwordMailbox = { authType: 'password' as const, providerId: 'generic-imap' as const, imap: imap('ada@example.com') }
const gmailPasswordMailbox = { authType: 'password' as const, providerId: 'gmail' as const, imap: imap('ada@gmail.com') }
const outlookMailbox = { authType: 'oauth2' as const, providerId: 'outlook' as const, imap: imap('ada@outlook.com') }

describe('isGoogleSignInMailbox', () => {
  it('is true only for an oauth2 mailbox with the gmail provider', () => {
    expect(isGoogleSignInMailbox(googleMailbox)).toBe(true)
    expect(isGoogleSignInMailbox(passwordMailbox)).toBe(false)
    expect(isGoogleSignInMailbox(gmailPasswordMailbox)).toBe(false)
    expect(isGoogleSignInMailbox(outlookMailbox)).toBe(false)
    expect(isGoogleSignInMailbox(undefined)).toBe(false)
  })
})

describe('planGoogleConnect', () => {
  it('refuses with not_configured when the build has no Google client, even for an existing Google mailbox', () => {
    expect(planGoogleConnect({ configured: false, newMailboxesAllowed: true, existing: googleMailbox }))
      .toEqual({ ok: false, refusal: 'not_configured' })
    expect(planGoogleConnect({ configured: false, newMailboxesAllowed: false, existing: googleMailbox }))
      .toEqual({ ok: false, refusal: 'not_configured' })
    expect(planGoogleConnect({ configured: false, newMailboxesAllowed: true }))
      .toEqual({ ok: false, refusal: 'not_configured' })
  })

  it('lets an existing Google mailbox reconnect with a trimmed login hint when new mailboxes are closed', () => {
    expect(planGoogleConnect({ configured: true, newMailboxesAllowed: false, existing: googleMailbox }))
      .toEqual({ ok: true, loginHint: 'Ada@Gmail.com' })
  })

  it('also hints the address on reconnect when new mailboxes are allowed', () => {
    expect(planGoogleConnect({ configured: true, newMailboxesAllowed: true, existing: googleMailbox }))
      .toEqual({ ok: true, loginHint: 'Ada@Gmail.com' })
  })

  it.each(['', '   ', '\t\n'])(
    'refuses a Google mailbox whose stored address is blank (%j) when new mailboxes are closed',
    (blank) => {
      // Nothing to compare the token against: accepting would take any Google account.
      expect(planGoogleConnect({
        configured: true,
        newMailboxesAllowed: false,
        existing: { ...googleMailbox, imap: imap(blank) },
      })).toEqual({ ok: false, refusal: 'new_mailbox_closed' })
    },
  )

  it('allows a Google mailbox with a blank stored address without a hint when new mailboxes are allowed', () => {
    expect(planGoogleConnect({
      configured: true,
      newMailboxesAllowed: true,
      existing: { ...googleMailbox, imap: imap('   ') },
    })).toEqual({ ok: true })
  })

  it('refuses a new mailbox (no existing account) when new mailboxes are closed', () => {
    expect(planGoogleConnect({ configured: true, newMailboxesAllowed: false }))
      .toEqual({ ok: false, refusal: 'new_mailbox_closed' })
  })

  it('refuses to convert an existing password mailbox when new mailboxes are closed', () => {
    expect(planGoogleConnect({ configured: true, newMailboxesAllowed: false, existing: passwordMailbox }))
      .toEqual({ ok: false, refusal: 'new_mailbox_closed' })
    expect(planGoogleConnect({ configured: true, newMailboxesAllowed: false, existing: gmailPasswordMailbox }))
      .toEqual({ ok: false, refusal: 'new_mailbox_closed' })
  })

  it('refuses an Outlook oauth mailbox when new mailboxes are closed', () => {
    expect(planGoogleConnect({ configured: true, newMailboxesAllowed: false, existing: outlookMailbox }))
      .toEqual({ ok: false, refusal: 'new_mailbox_closed' })
  })

  it('allows a new mailbox without any hint when new mailboxes are allowed', () => {
    expect(planGoogleConnect({ configured: true, newMailboxesAllowed: true })).toEqual({ ok: true })
  })

  it('allows converting a password mailbox without a hint when new mailboxes are allowed', () => {
    expect(planGoogleConnect({ configured: true, newMailboxesAllowed: true, existing: passwordMailbox }))
      .toEqual({ ok: true })
  })
})

describe('canonicalGoogleAddress', () => {
  it.each([
    ['ada.lovelace@gmail.com', 'adalovelace@gmail.com'],
    ['adalovelace@googlemail.com', 'adalovelace@gmail.com'],
    ['a.d.a@googlemail.com', 'ada@gmail.com'],
    ['  Ada.Lovelace@GMAIL.com ', 'adalovelace@gmail.com'],
    ['ADA@GoogleMail.COM', 'ada@gmail.com'],
  ])('folds the consumer Gmail spelling %j to %j', (input, expected) => {
    expect(canonicalGoogleAddress(input)).toBe(expected)
  })

  it('keeps dots and the domain on a Workspace domain (only lower-cased and trimmed)', () => {
    expect(canonicalGoogleAddress('ada.lovelace@corp.example')).toBe('ada.lovelace@corp.example')
    expect(canonicalGoogleAddress(' Ada.Lovelace@Corp.Example ')).toBe('ada.lovelace@corp.example')
    expect(canonicalGoogleAddress('ada.lovelace@corp.example'))
      .not.toBe(canonicalGoogleAddress('adalovelace@corp.example'))
  })

  it('does not fold look-alike domains (suffix/prefix of gmail.com)', () => {
    expect(canonicalGoogleAddress('a.b@notgmail.com')).toBe('a.b@notgmail.com')
    expect(canonicalGoogleAddress('a.b@gmail.com.evil.example')).toBe('a.b@gmail.com.evil.example')
    expect(canonicalGoogleAddress('a.b@mail.googlemail.com')).toBe('a.b@mail.googlemail.com')
  })

  it('does not fold a "+tag" suffix', () => {
    expect(canonicalGoogleAddress('ada+news@gmail.com')).toBe('ada+news@gmail.com')
  })

  it('lower-cases and trims a string without "@" and leaves it otherwise untouched', () => {
    expect(canonicalGoogleAddress('  Not.An.Address ')).toBe('not.an.address')
    expect(canonicalGoogleAddress('')).toBe('')
  })

  it('leaves a string that starts with "@" (empty local part) unfolded', () => {
    expect(canonicalGoogleAddress('@googlemail.com')).toBe('@googlemail.com')
  })
})

describe('verifyTokenAddress', () => {
  it('accepts the same address regardless of case and surrounding whitespace', () => {
    expect(verifyTokenAddress('Ada@Gmail.com', ' ada@gmail.COM ')).toBeNull()
  })

  it('refuses a different address', () => {
    expect(verifyTokenAddress('ada@gmail.com', 'eve@gmail.com')).toBe('account_mismatch')
  })

  it('refuses an empty address from Google when a hint was sent (fail closed)', () => {
    expect(verifyTokenAddress('ada@gmail.com', '')).toBe('account_mismatch')
    expect(verifyTokenAddress('ada@gmail.com', '   ')).toBe('account_mismatch')
  })

  it('accepts the same consumer mailbox spelled with dots and googlemail.com', () => {
    expect(verifyTokenAddress('ada.lovelace@gmail.com', 'adalovelace@googlemail.com')).toBeNull()
    expect(verifyTokenAddress('adalovelace@googlemail.com', 'Ada.Lovelace@gmail.com')).toBeNull()
  })

  it('refuses a dot-variant on a Workspace domain (different mailboxes there)', () => {
    expect(verifyTokenAddress('ada.lovelace@corp.example', 'adalovelace@corp.example')).toBe('account_mismatch')
  })

  it('refuses a gmail.com address against a Workspace hint with the same local part', () => {
    expect(verifyTokenAddress('ada@corp.example', 'ada@gmail.com')).toBe('account_mismatch')
  })

  it('does not compare anything when there was no hint', () => {
    expect(verifyTokenAddress(undefined, 'anyone@gmail.com')).toBeNull()
    expect(verifyTokenAddress(undefined, '')).toBeNull()
  })
})

describe('mailboxIdentity', () => {
  it('is the empty string when there is no mailbox', () => {
    expect(mailboxIdentity(undefined)).toBe('')
  })

  it('joins auth type, provider and stored login', () => {
    expect(mailboxIdentity(googleMailbox)).toBe('oauth2|gmail|  Ada@Gmail.com ')
    expect(mailboxIdentity(passwordMailbox)).toBe('password|generic-imap|ada@example.com')
  })

  it('differs when any of the three parts changes (a replaced mailbox reusing the id)', () => {
    const base = mailboxIdentity(googleMailbox)
    expect(mailboxIdentity({ ...googleMailbox, imap: imap('eve@gmail.com') })).not.toBe(base)
    expect(mailboxIdentity({ ...googleMailbox, providerId: 'outlook' })).not.toBe(base)
    expect(mailboxIdentity({ ...googleMailbox, authType: 'password' })).not.toBe(base)
    expect(mailboxIdentity(googleMailbox)).toBe(base)
  })

  it('differs between a removed mailbox and an existing one', () => {
    expect(mailboxIdentity(undefined)).not.toBe(mailboxIdentity(googleMailbox))
  })
})

describe('refuseOAuthIdentityRewrite', () => {
  const login = (user: string) => ({ user })
  const storedGoogle = { ...googleMailbox, imap: imap('ada@gmail.com'), smtp: login('ada@gmail.com') }
  const storedPassword = { ...passwordMailbox, smtp: login('ada@example.com') }

  describe('no stored mailbox (create)', () => {
    it('refuses to mint an oauth2 mailbox', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', imap: login('eve@gmail.com'), smtp: login('eve@gmail.com') },
        undefined,
      )).toEqual(expect.any(String))
    })

    it('refuses to mint an oauth2 mailbox that names the gmail provider', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', providerId: 'gmail', imap: login('eve@gmail.com'), smtp: login('eve@gmail.com') },
        undefined,
      )).toEqual(expect.any(String))
    })

    it('does not refuse creating a NEW oauth2 record with the outlook provider (not Google; §2.297 leaves Outlook alone)', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', providerId: 'outlook', imap: login('ada@outlook.com'), smtp: login('ada@outlook.com') },
        undefined,
      )).toBeNull()
    })

    it.each([['password'], [undefined]])('allows creating a mailbox with authType %s', (authType) => {
      expect(refuseOAuthIdentityRewrite(
        { authType, imap: login('ada@example.com'), smtp: login('ada@example.com') },
        undefined,
      )).toBeNull()
    })
  })

  describe('stored oauth2 mailbox', () => {
    it('refuses a changed IMAP user', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', imap: login('eve@gmail.com'), smtp: login('ada@gmail.com') },
        storedGoogle,
      )).toEqual(expect.any(String))
    })

    it('refuses a changed SMTP user', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', imap: login('ada@gmail.com'), smtp: login('eve@gmail.com') },
        storedGoogle,
      )).toEqual(expect.any(String))
    })

    it('refuses a changed user even when the payload claims a password mailbox', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'password', imap: login('eve@gmail.com'), smtp: login('eve@gmail.com') },
        storedGoogle,
      )).toEqual(expect.any(String))
    })

    it('refuses a case-only change (the comparison is exact, like the stored record)', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', imap: login('Ada@gmail.com'), smtp: login('ada@gmail.com') },
        storedGoogle,
      )).toEqual(expect.any(String))
    })

    it('allows a save that leaves both users unchanged (avatar, signature, name)', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', imap: login('ada@gmail.com'), smtp: login('ada@gmail.com') },
        storedGoogle,
      )).toBeNull()
    })

    it('leaves an Outlook oauth2 mailbox alone: its user fields stay editable (shared mailboxes)', () => {
      const storedOutlook = { ...outlookMailbox, smtp: login('ada@outlook.com') }
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', providerId: 'outlook', imap: login('shared@outlook.com'), smtp: login('shared@outlook.com') },
        storedOutlook,
      )).toBeNull()
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', imap: login('eve@outlook.com'), smtp: login('ada@outlook.com') },
        storedOutlook,
      )).toBeNull()
    })

    it('still refuses a changed user on a stored Google mailbox (IMAP and SMTP independently)', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', providerId: 'gmail', imap: login('eve@gmail.com'), smtp: login('ada@gmail.com') },
        storedGoogle,
      )).toEqual(expect.any(String))
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', providerId: 'gmail', imap: login('ada@gmail.com'), smtp: login('eve@gmail.com') },
        storedGoogle,
      )).toEqual(expect.any(String))
    })
  })

  describe('stored password mailbox', () => {
    it('allows any change of users when the payload stays a password one', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'password', imap: login('new@example.com'), smtp: login('other@example.com') },
        storedPassword,
      )).toBeNull()
    })

    it('allows a payload without authType (any user change)', () => {
      expect(refuseOAuthIdentityRewrite(
        { imap: login('new@example.com'), smtp: login('other@example.com') },
        storedPassword,
      )).toBeNull()
    })

    it('refuses a stored password record being saved as oauth2 when the provider is omitted and the record is Gmail', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', imap: login('ada@gmail.com'), smtp: login('ada@gmail.com') },
        { ...gmailPasswordMailbox, smtp: login('ada@gmail.com') },
      )).toEqual(expect.any(String))
    })

    it('refuses a password record being saved as oauth2 with an explicit gmail provider', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', providerId: 'gmail', imap: login('ada@example.com'), smtp: login('ada@example.com') },
        storedPassword,
      )).toEqual(expect.any(String))
    })

    it('does not refuse a password record being saved as oauth2 with the outlook provider (the Microsoft flow converts such records)', () => {
      expect(refuseOAuthIdentityRewrite(
        { authType: 'oauth2', providerId: 'outlook', imap: login('ada@example.com'), smtp: login('ada@example.com') },
        storedPassword,
      )).toBeNull()
    })
  })

  describe('stored oauth2 mailbox: provider', () => {
    const storedOutlook = { ...outlookMailbox, smtp: login('ada@outlook.com') }
    const same = (user: string) => ({ imap: login(user), smtp: login(user) })

    it.each([
      ['gmail stored, outlook incoming', storedGoogle, 'outlook', 'ada@gmail.com'],
      ['outlook stored, gmail incoming', storedOutlook, 'gmail', 'ada@outlook.com'],
      ['gmail stored, generic-imap incoming', storedGoogle, 'generic-imap', 'ada@gmail.com'],
    ])('refuses a provider change to or from gmail (%s) even with unchanged users', (_name, stored, providerId, user) => {
      expect(refuseOAuthIdentityRewrite({ authType: 'oauth2', providerId, ...same(user) }, stored))
        .toEqual(expect.any(String))
    })

    it('allows a provider change between two non-Google providers on a stored oauth2 record', () => {
      expect(refuseOAuthIdentityRewrite({ authType: 'oauth2', providerId: 'generic-imap', ...same('ada@outlook.com') }, storedOutlook))
        .toBeNull()
    })

    it('refuses a provider change away from gmail when the payload claims a password mailbox', () => {
      expect(refuseOAuthIdentityRewrite({ authType: 'password', providerId: 'outlook', ...same('ada@gmail.com') }, storedGoogle))
        .toEqual(expect.any(String))
    })

    it('allows the same providerId with unchanged users and authType oauth2', () => {
      expect(refuseOAuthIdentityRewrite({ authType: 'oauth2', providerId: 'gmail', ...same('ada@gmail.com') }, storedGoogle))
        .toBeNull()
      expect(refuseOAuthIdentityRewrite({ authType: 'oauth2', providerId: 'outlook', ...same('ada@outlook.com') }, storedOutlook))
        .toBeNull()
    })

    it('allows an undefined providerId (the edit form does not send one)', () => {
      expect(refuseOAuthIdentityRewrite({ authType: 'oauth2', ...same('ada@gmail.com') }, storedGoogle)).toBeNull()
      expect(refuseOAuthIdentityRewrite({ ...same('ada@gmail.com') }, storedGoogle)).toBeNull()
    })

    it('still refuses a changed user when the providerId is the same', () => {
      expect(refuseOAuthIdentityRewrite({ authType: 'oauth2', providerId: 'gmail', ...same('eve@gmail.com') }, storedGoogle))
        .toEqual(expect.any(String))
    })
  })
})

describe('saveAccountGuarded', () => {
  const login = (user: string) => ({ user })
  const storedGoogle = { ...googleMailbox, imap: imap('ada@gmail.com'), smtp: login('ada@gmail.com') }
  const payload = (over: Record<string, unknown> = {}) => ({
    id: 7,
    authType: 'oauth2' as string | undefined,
    providerId: 'gmail' as string | undefined,
    imap: login('ada@gmail.com'),
    smtp: login('ada@gmail.com'),
    ...over,
  })

  function setup(stored: typeof storedGoogle | undefined) {
    const order: string[] = []
    const getAccountMeta = vi.fn(() => { order.push('read'); return stored })
    const saveAccount = vi.fn(async () => { order.push('save'); return { id: 7 } })
    return { order, getAccountMeta, saveAccount }
  }

  it('throws the refusal and never calls saveAccount when the address of a Google mailbox is edited', async () => {
    const d = setup(storedGoogle)
    await expect(saveAccountGuarded(payload({ imap: login('eve@gmail.com') }), d))
      .rejects.toThrow('cannot be edited')
    expect(d.saveAccount).not.toHaveBeenCalled()
  })

  it('refuses minting an oauth2 Google record from nothing (no id) without reading or saving', async () => {
    const d = setup(undefined)
    await expect(saveAccountGuarded(payload({ id: undefined }), d)).rejects.toThrow('can only be created by its sign-in flow')
    expect(d.getAccountMeta).not.toHaveBeenCalled()
    expect(d.saveAccount).not.toHaveBeenCalled()
  })

  it('refuses turning a stored password record into a Google one (explicit gmail provider)', async () => {
    const d = setup({ ...passwordMailbox, smtp: login('ada@example.com') } as unknown as typeof storedGoogle)
    await expect(saveAccountGuarded(payload({ imap: login('ada@example.com'), smtp: login('ada@example.com') }), d)).rejects.toThrow()
    expect(d.saveAccount).not.toHaveBeenCalled()
  })

  it('returns the new id and the stored record as it was BEFORE the save, reading it first', async () => {
    const d = setup(storedGoogle)
    const res = await saveAccountGuarded(payload({ signature: 'new' }), d)
    expect(res).toEqual({ id: 7, previous: storedGoogle })
    expect(d.getAccountMeta).toHaveBeenCalledWith(7)
    expect(d.order).toEqual(['read', 'save'])
    expect(d.saveAccount).toHaveBeenCalledTimes(1)
  })

  it('lets an avatar/signature save with unchanged users on a stored Google record through', async () => {
    const d = setup(storedGoogle)
    const input = payload({ avatarColor: 3, signature: 'Best, Ada' })
    await expect(saveAccountGuarded(input, d)).resolves.toMatchObject({ id: 7 })
    expect(d.saveAccount).toHaveBeenCalledWith(input, expect.any(Function))
  })

  it('does not read the store for a create (no id) and returns previous undefined', async () => {
    const d = setup(undefined)
    const res = await saveAccountGuarded(payload({ id: undefined, authType: 'password', providerId: undefined, imap: login('a@example.com'), smtp: login('a@example.com') }), d)
    expect(res).toEqual({ id: 7, previous: undefined })
    expect(d.getAccountMeta).not.toHaveBeenCalled()
  })

  it('passes an edit of an Outlook oauth2 mailbox through', async () => {
    const stored = { ...outlookMailbox, smtp: login('ada@outlook.com') } as unknown as typeof storedGoogle
    const d = setup(stored)
    await expect(saveAccountGuarded(
      payload({ providerId: 'outlook', imap: login('shared@outlook.com'), smtp: login('shared@outlook.com') }),
      d,
    )).resolves.toMatchObject({ id: 7, previous: stored })
    expect(d.saveAccount).toHaveBeenCalledTimes(1)
  })

  it('hands the saver a gate that applies the same refusal to the record the saver reads in its own turn', async () => {
    const d = setup(storedGoogle)
    let gate: ((stored: typeof storedGoogle | undefined) => void) | undefined
    d.saveAccount.mockImplementationOnce((async (_input: unknown, g: typeof gate) => { gate = g; return { id: 7 } }) as never)
    await saveAccountGuarded(payload({ signature: 'new' }), d as never)
    expect(() => gate!(storedGoogle)).not.toThrow()
    expect(() => gate!({ ...storedGoogle, imap: imap('someone-else@gmail.com') })).toThrow('cannot be edited')
    // A record that vanished while the save waited: the payload would now mint a Google record, which is refused.
    expect(() => gate!(undefined)).toThrow('can only be created by its sign-in flow')
  })

  it('returns as `previous` the record the gate saw, not the one read before the queue', async () => {
    const d = setup({ ...passwordMailbox, smtp: login('ada@example.com') } as unknown as typeof storedGoogle)
    d.saveAccount.mockImplementationOnce((async (_input: unknown, gate: (s: typeof storedGoogle) => void) => { gate(storedGoogle); return { id: 7 } }) as never)
    const res = await saveAccountGuarded(payload({ authType: undefined, providerId: undefined, imap: login('ada@gmail.com'), smtp: login('ada@gmail.com') }), d as never)
    expect(res.previous).toBe(storedGoogle)
  })

  it('a saver that never calls the gate keeps the check made before it (the guard does not depend on the gate)', async () => {
    const d = setup(storedGoogle)
    await expect(saveAccountGuarded(payload({ imap: login('eve@gmail.com') }), d)).rejects.toThrow('cannot be edited')
    expect(d.saveAccount).not.toHaveBeenCalled()
  })

  it('propagates a saveAccount failure and does not swallow it', async () => {
    const d = setup(storedGoogle)
    d.saveAccount.mockRejectedValueOnce(new Error('disk full'))
    await expect(saveAccountGuarded(payload(), d)).rejects.toThrow('disk full')
  })
})
