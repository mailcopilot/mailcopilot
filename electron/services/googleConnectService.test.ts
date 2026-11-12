import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AccountMeta } from '../../packages/net/types'
import { connectGoogleAccount, type GoogleConnectDeps, type GoogleTokens } from './googleConnectService'

/**
 * §2.297 — `connectGoogleAccount` driven as real code with fake dependencies.
 * The refusals protect Google's lifetime new-user cap: the official build must
 * not open the browser, probe a server, or write anything for a new mailbox,
 * and a token for another address or for a mailbox that changed while the
 * browser was open must never reach the account store or the secret store.
 */

const GOOGLE_SCOPE = 'https://mail.google.com/'

const meta = (over: Record<string, unknown> = {}): AccountMeta => ({
  id: 7,
  name: 'Ada',
  colorIndex: 0,
  authType: 'oauth2',
  providerId: 'gmail',
  transportType: 'imap-smtp',
  imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'ada@gmail.com' },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'ada@gmail.com' },
  folderRoles: { inbox: 'INBOX' },
  ...over,
}) as unknown as AccountMeta

const googleMailbox = () => meta()
const passwordMailbox = () => meta({
  authType: 'password',
  providerId: 'generic-imap',
  imap: { host: 'imap.example.com', port: 993, secure: true, user: 'ada@example.com' },
  smtp: { host: 'smtp.example.com', port: 465, secure: true, user: 'ada@example.com' },
})
const outlookMailbox = () => meta({
  providerId: 'outlook',
  imap: { host: 'outlook.office365.com', port: 993, secure: true, user: 'ada@outlook.com' },
  smtp: { host: 'smtp.office365.com', port: 587, secure: false, user: 'ada@outlook.com' },
})

const tokensFor = (email: string): GoogleTokens => ({
  email,
  displayName: 'Ada From Google',
  accessToken: 'at-1',
  expiresAt: 1_900_000_000_000,
  refreshToken: 'rt-1',
})

type Harness = {
  deps: GoogleConnectDeps
  order: string[]
  /** Replace what `getAccountMeta` returns from now on. */
  setStored: (m: AccountMeta | undefined) => void
  fns: {
    runOAuthFlow: ReturnType<typeof vi.fn>
    fetchTokenInfo: ReturnType<typeof vi.fn>
    testImap: ReturnType<typeof vi.fn>
    testSmtp: ReturnType<typeof vi.fn>
    saveAccount: ReturnType<typeof vi.fn>
    setRefreshToken: ReturnType<typeof vi.fn>
    cacheAccessToken: ReturnType<typeof vi.fn>
    emitProgress: ReturnType<typeof vi.fn>
    getAccountMeta: ReturnType<typeof vi.fn>
  }
}

function harness(opts: {
  stored?: AccountMeta
  flowEmail?: string
  newMailboxesAllowed?: boolean
  configured?: boolean
} = {}): Harness {
  let stored = opts.stored
  const order: string[] = []
  const fns = {
    getAccountMeta: vi.fn((id: number) => (stored && stored.id === id ? stored : undefined)),
    runOAuthFlow: vi.fn(async () => { order.push('flow'); return tokensFor(opts.flowEmail ?? 'ada@gmail.com') }),
    fetchTokenInfo: vi.fn(async () => ({ scope: `openid ${GOOGLE_SCOPE}` })),
    testImap: vi.fn(async () => { order.push('imap'); return { ok: true } }),
    testSmtp: vi.fn(async () => { order.push('smtp'); return { ok: true } }),
    saveAccount: vi.fn(async () => { order.push('save'); return { id: 7 } }),
    setRefreshToken: vi.fn(async () => { order.push('setRefreshToken') }),
    cacheAccessToken: vi.fn(() => { order.push('cache') }),
    emitProgress: vi.fn(),
  }
  const deps: GoogleConnectDeps = {
    configured: () => opts.configured ?? true,
    newMailboxesAllowed: () => opts.newMailboxesAllowed ?? false,
    log: { info: vi.fn(), warn: vi.fn() },
    ...fns,
  }
  return { deps, order, setStored: (m) => { stored = m }, fns }
}

/** Nothing that opens a browser, touches the network, or persists may run. */
function expectNothingHappened(h: Harness) {
  expect(h.fns.runOAuthFlow).not.toHaveBeenCalled()
  expect(h.fns.fetchTokenInfo).not.toHaveBeenCalled()
  expect(h.fns.testImap).not.toHaveBeenCalled()
  expect(h.fns.testSmtp).not.toHaveBeenCalled()
  expect(h.fns.saveAccount).not.toHaveBeenCalled()
  expect(h.fns.setRefreshToken).not.toHaveBeenCalled()
  expect(h.fns.cacheAccessToken).not.toHaveBeenCalled()
}

/** The flow ran, but no token or record may have been persisted anywhere. */
function expectNothingPersisted(h: Harness) {
  expect(h.fns.saveAccount).not.toHaveBeenCalled()
  expect(h.fns.setRefreshToken).not.toHaveBeenCalled()
  expect(h.fns.cacheAccessToken).not.toHaveBeenCalled()
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('connectGoogleAccount — official build (new mailboxes closed)', () => {
  it('refuses a new mailbox without opening the browser or writing anything', async () => {
    const h = harness({ newMailboxesAllowed: false })
    await expect(connectGoogleAccount(undefined, h.deps)).resolves.toEqual({ ok: false, refusal: 'new_mailbox_closed' })
    expectNothingHappened(h)
  })

  it('refuses to convert an existing password mailbox', async () => {
    const h = harness({ stored: passwordMailbox() })
    await expect(connectGoogleAccount(7, h.deps)).resolves.toEqual({ ok: false, refusal: 'new_mailbox_closed' })
    expectNothingHappened(h)
  })

  it('refuses to convert an existing Outlook oauth2 mailbox', async () => {
    const h = harness({ stored: outlookMailbox() })
    await expect(connectGoogleAccount(7, h.deps)).resolves.toEqual({ ok: false, refusal: 'new_mailbox_closed' })
    expectNothingHappened(h)
  })

  it('refuses a Google mailbox whose stored address is blank (nothing to compare the token with)', async () => {
    const h = harness({ stored: meta({ imap: { host: 'imap.gmail.com', port: 993, secure: true, user: '  ' } }) })
    await expect(connectGoogleAccount(7, h.deps)).resolves.toEqual({ ok: false, refusal: 'new_mailbox_closed' })
    expectNothingHappened(h)
  })

  it('reconnects an existing Google mailbox, passing its stored address as the login hint', async () => {
    const h = harness({ stored: googleMailbox() })
    const res = await connectGoogleAccount(7, h.deps)
    expect(res).toMatchObject({ ok: true, id: 7, email: 'ada@gmail.com' })
    expect(h.fns.runOAuthFlow).toHaveBeenCalledWith('ada@gmail.com')
    expect(h.fns.saveAccount).toHaveBeenCalledTimes(1)
  })
})

describe('connectGoogleAccount — not configured', () => {
  it.each([
    ['official build, new mailbox', false, undefined],
    ['self-build, new mailbox', true, undefined],
    ['official build, existing Google mailbox', false, googleMailbox],
    ['self-build, existing Google mailbox', true, googleMailbox],
  ])('returns not_configured and does nothing (%s)', async (_n, allowed, mk) => {
    const h = harness({ configured: false, newMailboxesAllowed: allowed, stored: mk?.() })
    await expect(connectGoogleAccount(mk ? 7 : undefined, h.deps)).resolves.toEqual({ ok: false, refusal: 'not_configured' })
    expectNothingHappened(h)
  })
})

describe('connectGoogleAccount — existing id', () => {
  it('rejects with "not found" before anything else when the id does not exist', async () => {
    const h = harness()
    await expect(connectGoogleAccount(99, h.deps)).rejects.toThrow(/not found/)
    expectNothingHappened(h)
  })

  it('rejects an unknown id even when the build would otherwise refuse (the id check comes first)', async () => {
    const h = harness({ newMailboxesAllowed: false })
    await expect(connectGoogleAccount(99, h.deps)).rejects.toThrow('Account #99 not found')
  })
})

describe('connectGoogleAccount — token for another address', () => {
  it('refuses account_mismatch and persists nothing, after hinting the stored address', async () => {
    const h = harness({ stored: googleMailbox(), flowEmail: 'eve@gmail.com' })
    await expect(connectGoogleAccount(7, h.deps)).resolves.toEqual({ ok: false, refusal: 'account_mismatch' })
    expect(h.fns.runOAuthFlow).toHaveBeenCalledWith('ada@gmail.com')
    expectNothingPersisted(h)
    expect(h.fns.fetchTokenInfo).not.toHaveBeenCalled()
    expect(h.fns.testImap).not.toHaveBeenCalled()
  })

  it('refuses an empty address from Google when a hint was sent', async () => {
    const h = harness({ stored: googleMailbox(), flowEmail: '' })
    await expect(connectGoogleAccount(7, h.deps)).resolves.toEqual({ ok: false, refusal: 'account_mismatch' })
    expectNothingPersisted(h)
  })

  it('proceeds when the same address comes back in a different case', async () => {
    const h = harness({ stored: googleMailbox(), flowEmail: ' Ada@GMAIL.com ' })
    const res = await connectGoogleAccount(7, h.deps)
    expect(res.ok).toBe(true)
    expect(h.fns.saveAccount).toHaveBeenCalledTimes(1)
    expect(h.fns.setRefreshToken).toHaveBeenCalledWith(7, 'rt-1')
    expect(h.fns.cacheAccessToken).toHaveBeenCalledWith(7, 'at-1', 1_900_000_000_000)
  })

  it('proceeds for ada.lovelace@gmail.com vs adalovelace@googlemail.com (the same Gmail mailbox)', async () => {
    const stored = meta({
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'ada.lovelace@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'ada.lovelace@gmail.com' },
    })
    const h = harness({ stored, flowEmail: 'adalovelace@googlemail.com' })
    const res = await connectGoogleAccount(7, h.deps)
    expect(res.ok).toBe(true)
    expect(h.fns.setRefreshToken).toHaveBeenCalledWith(7, 'rt-1')
    expect(h.fns.cacheAccessToken).toHaveBeenCalledTimes(1)
  })

  it('refuses a dot-variant on a Workspace domain (there, dots matter)', async () => {
    const stored = meta({
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'ada.lovelace@corp.example' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'ada.lovelace@corp.example' },
    })
    const h = harness({ stored, flowEmail: 'adalovelace@corp.example' })
    await expect(connectGoogleAccount(7, h.deps)).resolves.toEqual({ ok: false, refusal: 'account_mismatch' })
    expectNothingPersisted(h)
  })
})

describe('connectGoogleAccount — mailbox changed while the browser was open', () => {
  const CHANGED = 'The mailbox changed during sign-in'

  it('rejects when the mailbox was removed during the flow', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.runOAuthFlow.mockImplementation(async () => { h.setStored(undefined); return tokensFor('ada@gmail.com') })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(CHANGED)
    expectNothingPersisted(h)
    expect(h.fns.testImap).not.toHaveBeenCalled()
  })

  it('rejects when the mailbox was replaced during the flow (same id, different address)', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.runOAuthFlow.mockImplementation(async () => {
      h.setStored(meta({ imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'eve@gmail.com' } }))
      return tokensFor('ada@gmail.com')
    })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(CHANGED)
    expectNothingPersisted(h)
  })

  it('rejects when the mailbox was replaced during the flow (same id, different authType)', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.runOAuthFlow.mockImplementation(async () => {
      h.setStored(meta({ authType: 'password' }))
      return tokensFor('ada@gmail.com')
    })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(CHANGED)
    expectNothingPersisted(h)
  })

  it('hands the save a gate that refuses a record which changed while the write waited in the queue', async () => {
    const h = harness({ stored: googleMailbox() })
    // A saver that queues writes: another save of the id lands first, then the gate is called on what it left.
    h.fns.saveAccount.mockImplementation(async (_input: unknown, gate: (stored: unknown) => void) => {
      gate(meta({ imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'eve@gmail.com' } }))
      h.order.push('save')
      return { id: 7 }
    })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(CHANGED)
    expect(h.order).not.toContain('save')
    expect(h.fns.setRefreshToken).not.toHaveBeenCalled()
  })

  it('the gate accepts the record the flow planned for', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.saveAccount.mockImplementation(async (_input: unknown, gate: (stored: unknown) => void) => {
      gate(googleMailbox())
      return { id: 7 }
    })
    await expect(connectGoogleAccount(7, h.deps)).resolves.toMatchObject({ ok: true })
  })

  it('rejects when the mailbox is replaced only after the IMAP probe resolved', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testImap.mockImplementation(async () => {
      h.order.push('imap')
      h.setStored(meta({ imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'eve@gmail.com' } }))
      return { ok: true }
    })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(CHANGED)
    expect(h.fns.testImap).toHaveBeenCalledTimes(1)
    expectNothingPersisted(h)
  })

  it('rejects when the mailbox is removed only after the SMTP probe (4th read, right before the write)', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testSmtp.mockImplementation(async () => { h.setStored(undefined); return { ok: true } })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(CHANGED)
    expectNothingPersisted(h)
  })

  it('rejects when only the 4th read of the stored record differs (read-count based change)', async () => {
    const h = harness({ stored: googleMailbox() })
    const original = googleMailbox()
    const replaced = meta({ providerId: 'outlook' })
    let reads = 0
    h.fns.getAccountMeta.mockImplementation(() => (++reads >= 4 ? replaced : original))
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(CHANGED)
    // The probes ran (the change was invisible until after them) but nothing was written.
    expect(h.fns.testImap).toHaveBeenCalledTimes(1)
    expectNothingPersisted(h)
  })

  it('rejects when the record changes at the 3rd read (right after the flow, before any probe)', async () => {
    const h = harness({ stored: googleMailbox() })
    const original = googleMailbox()
    const replaced = meta({ providerId: 'outlook' })
    let reads = 0
    h.fns.getAccountMeta.mockImplementation(() => (++reads >= 3 ? replaced : original))
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(CHANGED)
    expect(h.fns.fetchTokenInfo).not.toHaveBeenCalled()
    expect(h.fns.testImap).not.toHaveBeenCalled()
    expectNothingPersisted(h)
  })

  it('does not flag an unrelated edit (name/colour) made during the sign-in', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.runOAuthFlow.mockImplementation(async () => { h.setStored(meta({ name: 'Renamed', colorIndex: 3 })); return tokensFor('ada@gmail.com') })
    const res = await connectGoogleAccount(7, h.deps)
    expect(res.ok).toBe(true)
    // The edited name survives the re-authorization.
    expect(h.fns.saveAccount.mock.calls[0][0].name).toBe('Renamed')
  })
})

describe('connectGoogleAccount — self-build', () => {
  it('saves a new mailbox as a Google oauth2 account, with no login hint for the flow', async () => {
    const h = harness({ newMailboxesAllowed: true, flowEmail: 'new@gmail.com' })
    h.fns.saveAccount.mockImplementation(async () => { h.order.push('save'); return { id: 12 } })
    const res = await connectGoogleAccount(undefined, h.deps)
    expect(res).toEqual({ ok: true, id: 12, email: 'new@gmail.com', tlsCertRequired: undefined })
    expect(h.fns.runOAuthFlow).toHaveBeenCalledWith(undefined)
    const saved = h.fns.saveAccount.mock.calls[0][0]
    expect(saved).toMatchObject({
      id: undefined,
      name: 'Ada From Google',
      providerId: 'gmail',
      authType: 'oauth2',
      transportType: 'imap-smtp',
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'new@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'new@gmail.com' },
      folderRoles: {},
    })
    // Brand-new account: the secret-store write needs the allocated id.
    expect(h.fns.setRefreshToken).toHaveBeenCalledTimes(1)
    expect(h.fns.setRefreshToken).toHaveBeenCalledWith(12, 'rt-1')
    expect(h.order.indexOf('save')).toBeLessThan(h.order.indexOf('setRefreshToken'))
    expect(h.fns.cacheAccessToken).toHaveBeenCalledWith(12, 'at-1', 1_900_000_000_000)
  })

  it('writes the refresh token BEFORE saveAccount when converting an existing password mailbox', async () => {
    const h = harness({ newMailboxesAllowed: true, stored: passwordMailbox(), flowEmail: 'ada@example.com' })
    await connectGoogleAccount(7, h.deps)
    expect(h.fns.runOAuthFlow).toHaveBeenCalledWith(undefined)
    expect(h.order.filter((s) => s === 'setRefreshToken')).toHaveLength(2)
    const firstWrite = h.order.indexOf('setRefreshToken')
    const save = h.order.indexOf('save')
    const lastWrite = h.order.lastIndexOf('setRefreshToken')
    expect(firstWrite).toBeLessThan(save)
    expect(lastWrite).toBeGreaterThan(save)
    expect(h.fns.setRefreshToken).toHaveBeenNthCalledWith(1, 7, 'rt-1')
    expect(h.fns.saveAccount.mock.calls[0][0]).toMatchObject({ id: 7, authType: 'oauth2', providerId: 'gmail' })
  })

  it('writes the refresh token only after saveAccount for an already-OAuth Google mailbox', async () => {
    const h = harness({ newMailboxesAllowed: true, stored: googleMailbox() })
    await connectGoogleAccount(7, h.deps)
    expect(h.order.filter((s) => s === 'setRefreshToken')).toHaveLength(1)
    expect(h.order.indexOf('setRefreshToken')).toBeGreaterThan(h.order.indexOf('save'))
  })

  it('keeps an edited name, falls back to the Google profile name for a blank one, and carries folder roles and signature', async () => {
    const named = harness({ newMailboxesAllowed: true, stored: meta({ name: '  Work  ', signature: 'sig' }) })
    await connectGoogleAccount(7, named.deps)
    expect(named.fns.saveAccount.mock.calls[0][0]).toMatchObject({ name: 'Work', folderRoles: { inbox: 'INBOX' }, signature: 'sig' })

    const blank = harness({ newMailboxesAllowed: true, stored: meta({ name: '   ' }) })
    await connectGoogleAccount(7, blank.deps)
    expect(blank.fns.saveAccount.mock.calls[0][0].name).toBe('Ada From Google')
  })
})

describe('connectGoogleAccount — probes and tokeninfo', () => {
  it('saves the account and reports the IMAP endpoint when IMAP fails with a TLS certificate error', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testImap.mockResolvedValue({ ok: false, error: 'SELF_SIGNED_CERT_IN_CHAIN' })
    const res = await connectGoogleAccount(7, h.deps)
    expect(res).toMatchObject({ ok: true, id: 7, tlsCertRequired: { imap: { host: 'imap.gmail.com', port: 993 } } })
    expect(h.fns.saveAccount).toHaveBeenCalledTimes(1)
  })

  it('reports no tlsCertRequired.imap when IMAP passes', async () => {
    const h = harness({ stored: googleMailbox() })
    const res = await connectGoogleAccount(7, h.deps)
    expect(res).toMatchObject({ ok: true })
    expect(res.ok && res.tlsCertRequired?.imap).toBeFalsy()
  })

  it('rejects and saves nothing when IMAP fails for a non-certificate reason', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testImap.mockResolvedValue({ ok: false, error: 'Invalid credentials' })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(/IMAP: Invalid credentials/)
    expectNothingPersisted(h)
  })

  it('does not block the save on an SMTP failure', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testSmtp.mockResolvedValue({ ok: false, error: 'Auth failed' })
    const res = await connectGoogleAccount(7, h.deps)
    expect(res.ok).toBe(true)
    expect(h.fns.saveAccount).toHaveBeenCalledTimes(1)
    expect(h.fns.saveAccount.mock.calls[0][0].smtp).toMatchObject({ port: 465, secure: true })
  })

  it('does not block the save when the SMTP probe throws', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testSmtp.mockRejectedValue(new Error('boom'))
    const res = await connectGoogleAccount(7, h.deps)
    expect(res.ok).toBe(true)
    expect(h.fns.saveAccount).toHaveBeenCalledTimes(1)
  })

  it('reports the SMTP endpoint when SMTP fails with a TLS certificate error', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testSmtp.mockResolvedValue({ ok: false, error: 'CERT_HAS_EXPIRED' })
    const res = await connectGoogleAccount(7, h.deps)
    expect(res).toMatchObject({ ok: true, tlsCertRequired: { smtp: { host: 'smtp.gmail.com', port: 465 } } })
  })

  it('retries SMTP on 587 STARTTLS after a timeout on 465 and stores the working endpoint', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testSmtp
      .mockResolvedValueOnce({ ok: false, error: 'Connection timeout' })
      .mockResolvedValueOnce({ ok: true })
    const res = await connectGoogleAccount(7, h.deps)
    expect(res.ok).toBe(true)
    expect(h.fns.testSmtp).toHaveBeenCalledTimes(2)
    expect(h.fns.testSmtp.mock.calls[1][0]).toMatchObject({ port: 587, secure: false })
    expect(h.fns.saveAccount.mock.calls[0][0].smtp).toMatchObject({ port: 587, secure: false })
  })

  it('keeps 465 when the 587 retry also fails', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testSmtp.mockResolvedValue({ ok: false, error: 'ETIMEDOUT' })
    const res = await connectGoogleAccount(7, h.deps)
    expect(res.ok).toBe(true)
    expect(h.fns.testSmtp).toHaveBeenCalledTimes(2)
    expect(h.fns.saveAccount.mock.calls[0][0].smtp).toMatchObject({ port: 465, secure: true })
  })

  it('does not retry SMTP on 587 for a non-timeout failure', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testSmtp.mockResolvedValue({ ok: false, error: '535 bad' })
    await connectGoogleAccount(7, h.deps)
    expect(h.fns.testSmtp).toHaveBeenCalledTimes(1)
  })

  it('rejects before any probe when tokeninfo lacks the mail scope', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.fetchTokenInfo.mockResolvedValue({ scope: 'openid email' })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(/scope/)
    expect(h.fns.testImap).not.toHaveBeenCalled()
    expect(h.fns.testSmtp).not.toHaveBeenCalled()
    expectNothingPersisted(h)
  })

  it.each([
    ['https://mail.google.com/x'],
    ['xhttps://mail.google.com/'],
    ['https://mail.google.com'],
  ])('rejects a granted scope that only contains the mail scope as a substring (%s)', async (lookalike) => {
    const h = harness({ stored: googleMailbox() })
    h.fns.fetchTokenInfo.mockResolvedValue({ scope: `openid ${lookalike}` })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(/scope/)
    expect(h.fns.testImap).not.toHaveBeenCalled()
    expectNothingPersisted(h)
  })

  it('accepts the mail scope anywhere in the granted list', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.fetchTokenInfo.mockResolvedValue({ scope: `${GOOGLE_SCOPE} openid email` })
    await connectGoogleAccount(7, h.deps)
    expect(h.fns.testImap).toHaveBeenCalled()
  })

  it('rejects before any probe when tokeninfo reports the token invalid', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.fetchTokenInfo.mockResolvedValue({ error_description: 'Invalid Value' })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow(/invalid: Invalid Value/)
    expect(h.fns.testImap).not.toHaveBeenCalled()
    expectNothingPersisted(h)
  })

  it('carries on when tokeninfo itself cannot be fetched (diagnostics only)', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.fetchTokenInfo.mockRejectedValue(new Error('offline'))
    const res = await connectGoogleAccount(7, h.deps)
    expect(res.ok).toBe(true)
    expect(h.fns.testImap).toHaveBeenCalledTimes(1)
  })

  it('emits progress stages in order: imap, smtp, saving', async () => {
    const h = harness({ stored: googleMailbox() })
    await connectGoogleAccount(7, h.deps)
    expect(h.fns.emitProgress.mock.calls.map((c) => c[0])).toEqual(['imap', 'smtp', 'saving'])
  })

  it('does not reach the saving stage when IMAP fails', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testImap.mockResolvedValue({ ok: false, error: 'nope' })
    await expect(connectGoogleAccount(7, h.deps)).rejects.toThrow()
    expect(h.fns.emitProgress.mock.calls.map((c) => c[0])).toEqual(['imap'])
  })

  it('times out a hanging IMAP probe after 30 s and saves nothing', async () => {
    const h = harness({ stored: googleMailbox() })
    h.fns.testImap.mockImplementation(() => new Promise(() => { /* never settles */ }))
    const pending = connectGoogleAccount(7, h.deps)
    const assertion = expect(pending).rejects.toThrow(/IMAP timeout \(30s\)/)
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
    expectNothingPersisted(h)
  })
})
