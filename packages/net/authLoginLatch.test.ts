import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The latch module itself imports nothing, but this suite pins its refusal
// error against the real `classifyImapError`, which lives in ./imap — and that
// module pulls in better-sqlite3 (native) and the SMTP builder. Same stubs the
// imap suite uses.
vi.mock('../db', () => ({
  upsertMessages: vi.fn(),
  setUnread: vi.fn(),
  deleteMessages: vi.fn(),
  setFlagged: vi.fn(),
  upsertContactsIncoming: vi.fn(),
  removeStaleMessages: vi.fn(),
  getAccountMessageCount: vi.fn().mockReturnValue(0),
  getFolderUids: vi.fn().mockReturnValue([]),
  getFolderFlags: vi.fn().mockReturnValue(new Map()),
  removeStaleMessagesByUids: vi.fn(),
  getMessageByUid: vi.fn().mockReturnValue(undefined),
  setPinned: vi.fn(),
}))
vi.mock('./smtp', () => ({
  buildRawMessage: vi.fn().mockResolvedValue(Buffer.from('raw', 'utf8')),
}))

import {
  IMAP_AUTH_BACKOFF_CODE,
  LOGIN_LATCH_WINDOWS_MS,
  admitLoginAttempt,
  clearLoginLatch,
  imapAuthBackoffError,
  isImapAuthBackoffError,
  noteLatchAuthFailure,
  noteLatchSuccess,
  peekLoginLatchEntry,
  remainingLoginLatchMs,
  __resetLoginLatch,
  __setLoginLatchClock,
} from './authLoginLatch'
import { classifyImapError } from './imap'

let clock = 0

beforeEach(() => {
  clock = 1_000_000
  __setLoginLatchClock(() => clock)
  __resetLoginLatch()
})

afterEach(() => {
  __setLoginLatchClock(null)
  __resetLoginLatch()
})

describe('authLoginLatch — admission', () => {
  it('admits freely while the account has never been rejected', () => {
    for (let i = 0; i < 20; i++) expect(admitLoginAttempt(1, 0)).toBe(true)
    expect(peekLoginLatchEntry(1)).toBeUndefined()
  })

  it('refuses every attempt inside the window after one rejection', () => {
    noteLatchAuthFailure(1, 0)
    for (let i = 0; i < 12; i++) expect(admitLoginAttempt(1, 0)).toBe(false)
  })

  it('admits exactly one probe per window and widens the window on each rejection', () => {
    noteLatchAuthFailure(1, 0)

    // Window 1 — one minute.
    clock += LOGIN_LATCH_WINDOWS_MS[0] - 1
    expect(admitLoginAttempt(1, 0)).toBe(false)
    clock += 1
    expect(admitLoginAttempt(1, 0)).toBe(true)
    // The admitted probe reserved the window: a concurrent caller in the same
    // instant does not also get through.
    expect(admitLoginAttempt(1, 0)).toBe(false)

    noteLatchAuthFailure(1, 0)
    clock += LOGIN_LATCH_WINDOWS_MS[1] - 1
    expect(admitLoginAttempt(1, 0)).toBe(false)
    clock += 1
    expect(admitLoginAttempt(1, 0)).toBe(true)

    noteLatchAuthFailure(1, 0)
    expect(peekLoginLatchEntry(1)?.authFailures).toBe(3)
    clock += LOGIN_LATCH_WINDOWS_MS[2]
    expect(admitLoginAttempt(1, 0)).toBe(true)

    noteLatchAuthFailure(1, 0)
    noteLatchAuthFailure(1, 0)
    // Past the tail of the table the window stays at the cap, it does not grow
    // without bound and does not fall back to the head of the table.
    clock += LOGIN_LATCH_WINDOWS_MS[LOGIN_LATCH_WINDOWS_MS.length - 1] - 1
    expect(admitLoginAttempt(1, 0)).toBe(false)
    clock += 1
    expect(admitLoginAttempt(1, 0)).toBe(true)
  })

  it('caps the window at the one-hour auth backoff', () => {
    expect(LOGIN_LATCH_WINDOWS_MS[LOGIN_LATCH_WINDOWS_MS.length - 1]).toBe(60 * 60_000)
  })
})

describe('authLoginLatch — clearing', () => {
  it('clears on a success for the same incarnation', () => {
    noteLatchAuthFailure(1, 0)
    expect(admitLoginAttempt(1, 0)).toBe(false)
    noteLatchSuccess(1, 0)
    expect(peekLoginLatchEntry(1)).toBeUndefined()
    expect(admitLoginAttempt(1, 0)).toBe(true)
  })

  it('ignores a success stamped with another generation', () => {
    noteLatchAuthFailure(1, 7)
    noteLatchSuccess(1, 6)
    expect(peekLoginLatchEntry(1)?.authFailures).toBe(1)
    expect(admitLoginAttempt(1, 7)).toBe(false)
  })

  it('clears unconditionally when the credentials themselves changed', () => {
    noteLatchAuthFailure(1, 0)
    noteLatchAuthFailure(1, 0)
    clearLoginLatch(1)
    expect(admitLoginAttempt(1, 0)).toBe(true)
    expect(remainingLoginLatchMs(1, 0)).toBe(0)
  })

  it('starts the streak from zero again after a success', () => {
    noteLatchAuthFailure(1, 0)
    noteLatchAuthFailure(1, 0)
    noteLatchSuccess(1, 0)
    noteLatchAuthFailure(1, 0)
    expect(peekLoginLatchEntry(1)?.authFailures).toBe(1)
    clock += LOGIN_LATCH_WINDOWS_MS[0]
    expect(admitLoginAttempt(1, 0)).toBe(true)
  })
})

describe('authLoginLatch — identity is the (id, generation) pair', () => {
  it('does not hold back a new mailbox that inherited the id', () => {
    noteLatchAuthFailure(4, 0)
    expect(admitLoginAttempt(4, 0)).toBe(false)
    // Account deleted, id reissued — the service bumped the generation.
    expect(admitLoginAttempt(4, 1)).toBe(true)
    expect(peekLoginLatchEntry(4)).toBeUndefined()
  })

  it('counts the streak per incarnation rather than per id', () => {
    noteLatchAuthFailure(4, 0)
    noteLatchAuthFailure(4, 0)
    noteLatchAuthFailure(4, 1)
    expect(peekLoginLatchEntry(4)?.authFailures).toBe(1)
    expect(peekLoginLatchEntry(4)?.generation).toBe(1)
  })

  it('keeps accounts isolated from one another', () => {
    noteLatchAuthFailure(1, 0)
    expect(admitLoginAttempt(1, 0)).toBe(false)
    expect(admitLoginAttempt(2, 0)).toBe(true)
    expect(peekLoginLatchEntry(2)).toBeUndefined()
  })

  it('treats a null stamp as an ordinary key, not as a wildcard', () => {
    noteLatchAuthFailure(9, null)
    expect(admitLoginAttempt(9, null)).toBe(false)
    expect(admitLoginAttempt(9, 0)).toBe(true)
  })

  // A verdict that outlived its mailbox must not RELEASE the throttle of the
  // one that inherited the id. The release is indirect and easy to miss: the
  // stale write re-stamps the entry with the departed generation, and the next
  // attempt of the live incarnation then reads a mismatch, drops the entry and
  // connects immediately.
  it('ignores an auth failure stamped with an older generation', () => {
    noteLatchAuthFailure(4, 1)
    const before = peekLoginLatchEntry(4)

    noteLatchAuthFailure(4, 0)

    expect(peekLoginLatchEntry(4)).toEqual(before)
    expect(admitLoginAttempt(4, 1)).toBe(false)
  })

  it('ignores a success stamped with an older generation', () => {
    noteLatchAuthFailure(4, 1)
    const before = peekLoginLatchEntry(4)

    noteLatchSuccess(4, 0)

    expect(peekLoginLatchEntry(4)).toEqual(before)
    expect(admitLoginAttempt(4, 1)).toBe(false)
  })

  it('ignores an unattributable verdict against an attributable entry', () => {
    noteLatchAuthFailure(4, 2)
    const before = peekLoginLatchEntry(4)

    noteLatchAuthFailure(4, null)
    noteLatchSuccess(4, null)

    expect(peekLoginLatchEntry(4)).toEqual(before)
    // …and an unattributable ATTEMPT does not clear it on its way through
    // either, though it is let past rather than stopped for a bookkeeping
    // failure it cannot fix.
    expect(admitLoginAttempt(4, null)).toBe(true)
    expect(peekLoginLatchEntry(4)).toEqual(before)
    expect(admitLoginAttempt(4, 2)).toBe(false)
  })

  it('lets a newer generation supersede an entry that could not be attributed', () => {
    noteLatchAuthFailure(4, null)
    noteLatchAuthFailure(4, 3)
    expect(peekLoginLatchEntry(4)).toMatchObject({ generation: 3, authFailures: 1 })
  })
})

describe('authLoginLatch — the refusal error', () => {
  it('carries the discriminator and is recognised by the predicate', () => {
    const err = imapAuthBackoffError(3, 61_000)
    expect((err as Error & { code?: string }).code).toBe(IMAP_AUTH_BACKOFF_CODE)
    expect(isImapAuthBackoffError(err)).toBe(true)
    expect(isImapAuthBackoffError(new Error('AUTHENTICATIONFAILED'))).toBe(false)
    expect(isImapAuthBackoffError(undefined)).toBe(false)
  })

  it('names nothing but the account id and the remaining wait', () => {
    const err = imapAuthBackoffError(3, 61_000)
    expect(err.message).toContain('#3')
    expect(err.message).toContain('61s')
    expect(err.message).not.toMatch(/@|imap\.|password/i)
  })

  it('is inert for the server-error classifier', () => {
    // Load-bearing: a copy of this error that reaches a classification path
    // must not be counted as a second server rejection — the badge threshold
    // is two, and our own refusal is not evidence about the credentials.
    expect(classifyImapError(imapAuthBackoffError(3, 61_000))).not.toBe('auth')
  })
})
