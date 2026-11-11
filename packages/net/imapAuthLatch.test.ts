import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// imap.ts pulls in better-sqlite3 (native) and the SMTP builder — same stubs
// the main imap suite uses.
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

// One counter per mailbox login. Every authenticated connection in this module
// is `new ImapFlow(...)` followed by `connect()`, so counting `connect()` calls
// counts LOGIN commands on the wire.
let logins = 0
let connectBehaviour: () => Promise<void> = () => Promise.reject(authFailure())

function authFailure(): Error {
  // Shape of a real ImapFlow rejection for a wrong password.
  return Object.assign(new Error('Authentication failed (AUTHENTICATIONFAILED)'), {
    authenticationFailed: true,
    responseStatus: 'NO',
    serverResponseCode: 'AUTHENTICATIONFAILED',
  })
}

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockImplementation(() => {
      logins += 1
      return connectBehaviour()
    }),
    logout: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    usable: true,
    on: vi.fn(),
    removeListener: vi.fn(),
    close: vi.fn(),
    noop: vi.fn().mockResolvedValue(undefined),
    mailboxOpen: vi.fn().mockResolvedValue({ exists: 0, highestModseq: null, uidValidity: 1 }),
    fetch: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }),
    }),
    fetchOne: vi.fn().mockResolvedValue(null),
  })),
}))

import {
  clearImapAuthLatch,
  fetchAllFolderHeaders,
  isImapAuthBackoffError,
  registerAccountGenerationProvider,
  registerAuthErrorHandler,
  registerConnectionOutcomeHandler,
  startIdle,
  stopIdle,
  unregisterAccountGenerationProvider,
  unregisterAuthErrorHandler,
  unregisterConnectionOutcomeHandler,
  withImapPriority,
} from './imap'
import type { ImapConnectionOutcome } from './imap'
import {
  LOGIN_LATCH_WINDOWS_MS,
  __resetLoginLatch,
  __setLoginLatchClock,
} from './authLoginLatch'
import { __resetAuthRefreshCooldown } from './authRefreshCooldown'
import type { ImapConfig } from './types'

const cfg: ImapConfig = {
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'user@example.com',
  pass: 'wrong-password',
}

/** The folders a periodic pass walks, in order. */
const FOLDERS = ['INBOX', 'Sent', 'Archive', 'Junk', 'Trash', 'Drafts']

let clock = 0
let generations: Map<number, number | null>
let outcomes: ImapConnectionOutcome[]

/** One folder sync, as the periodic pass issues it. Resolves to the error so
 *  the callers can assert on it without try/catch noise. */
async function syncFolder(accountId: number, folder: string): Promise<unknown> {
  try {
    await fetchAllFolderHeaders(cfg, folder, accountId, () => {})
    return null
  } catch (err) {
    return err
  }
}

beforeEach(() => {
  logins = 0
  clock = 5_000_000
  connectBehaviour = () => Promise.reject(authFailure())
  outcomes = []
  generations = new Map([[1, 0], [2, 0]])
  __setLoginLatchClock(() => clock)
  __resetLoginLatch()
  __resetAuthRefreshCooldown()
  registerAccountGenerationProvider(id => generations.get(id) ?? null)
  registerConnectionOutcomeHandler(o => { outcomes.push(o) })
})

afterEach(() => {
  __setLoginLatchClock(null)
  __resetLoginLatch()
  __resetAuthRefreshCooldown()
  unregisterAccountGenerationProvider()
  unregisterConnectionOutcomeHandler()
  unregisterAuthErrorHandler(1)
  unregisterAuthErrorHandler(2)
})

describe('login storm — the behaviour without a latch', () => {
  it('reproduces one LOGIN per folder when nothing remembers the rejection', async () => {
    // `clearImapAuthLatch` between folders is exactly the pre-fix state: every
    // operation opened its own connection with no memory of the previous
    // refusal. Six folders, six LOGINs — and the periodic pass repeats this
    // every five minutes, which is how one mailbox produced ~50 failed logins
    // an hour for eight days.
    for (const folder of FOLDERS) {
      clearImapAuthLatch(1)
      const err = await syncFolder(1, folder)
      expect(err).toBeInstanceOf(Error)
    }
    expect(logins).toBe(FOLDERS.length)
  })
})

describe('login latch — one attempt per window', () => {
  it('lets the first folder try and refuses the rest of the pass before the socket', async () => {
    const errors: unknown[] = []
    for (const folder of FOLDERS) errors.push(await syncFolder(1, folder))

    expect(logins).toBe(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(isImapAuthBackoffError(errors[0])).toBe(false)
    for (const err of errors.slice(1)) {
      expect(isImapAuthBackoffError(err)).toBe(true)
    }
  })

  it('stays at one LOGIN across repeated passes inside the window', async () => {
    // Four passes over six folders — 24 operations that each used to open a
    // connection — inside the first window.
    for (let pass = 0; pass < 4; pass++) {
      for (const folder of FOLDERS) await syncFolder(1, folder)
      clock += LOGIN_LATCH_WINDOWS_MS[0] / 5
    }
    expect(logins).toBe(1)
  })

  it('admits exactly one probe once the window has elapsed', async () => {
    await syncFolder(1, 'INBOX')
    expect(logins).toBe(1)

    clock += LOGIN_LATCH_WINDOWS_MS[0]
    for (const folder of FOLDERS) await syncFolder(1, folder)
    expect(logins).toBe(2)

    // The second rejection widened the window, so the next pass at the OLD
    // interval gets nothing.
    clock += LOGIN_LATCH_WINDOWS_MS[0]
    for (const folder of FOLDERS) await syncFolder(1, folder)
    expect(logins).toBe(2)
  })

  it('does not report a verdict for a refused operation', async () => {
    // The badge threshold is two consecutive auth verdicts. If our own refusal
    // counted as one, a single failed login would raise "sign in again" —
    // which is precisely what the threshold exists to prevent (§2.165).
    for (const folder of FOLDERS) await syncFolder(1, folder)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ accountId: 1, ok: false })
  })
})

describe('login latch — release', () => {
  it('clears on the first successful probe and stops refusing', async () => {
    for (const folder of FOLDERS) await syncFolder(1, folder)
    expect(logins).toBe(1)

    // The user fixed the password on the server side; our stored copy now works.
    connectBehaviour = () => Promise.resolve()
    clock += LOGIN_LATCH_WINDOWS_MS[0]

    expect(await syncFolder(1, 'INBOX')).toBeNull()
    expect(logins).toBe(2)

    for (const folder of FOLDERS) expect(await syncFolder(1, folder)).toBeNull()
    expect(logins).toBe(2 + FOLDERS.length)
  })

  it('clears when new credentials are saved, without waiting out the window', async () => {
    await syncFolder(1, 'INBOX')
    expect(isImapAuthBackoffError(await syncFolder(1, 'Sent'))).toBe(true)

    connectBehaviour = () => Promise.resolve()
    clearImapAuthLatch(1)

    expect(await syncFolder(1, 'Archive')).toBeNull()
    expect(logins).toBe(2)
  })

  it('admits a user-initiated operation while background work stays held back', async () => {
    await syncFolder(1, 'INBOX')
    expect(logins).toBe(1)

    expect(isImapAuthBackoffError(await syncFolder(1, 'Sent'))).toBe(true)
    expect(logins).toBe(1)

    // A person clicked. The attempt goes out: it is the recovery path after
    // they fix the password, and its rate is bounded by the human.
    const err = await withImapPriority('interactive', () => syncFolder(1, 'Sent'))
    expect(isImapAuthBackoffError(err)).toBe(false)
    expect(logins).toBe(2)
  })
})

describe('login latch — identity', () => {
  it('holds back only the rejected account', async () => {
    await syncFolder(1, 'INBOX')
    expect(isImapAuthBackoffError(await syncFolder(1, 'Sent'))).toBe(true)

    // A second mailbox with working credentials is untouched.
    connectBehaviour = () => Promise.resolve()
    expect(await syncFolder(2, 'INBOX')).toBeNull()
    expect(await syncFolder(2, 'Sent')).toBeNull()
    expect(logins).toBe(3)
  })

  it('does not let a verdict that outlived its mailbox release a live latch', async () => {
    // A connection opened for the OLD mailbox that is still hanging when the
    // account is deleted, its id reissued, and the NEW mailbox latched. When
    // the old attempt finally fails, its verdict carries the old generation and
    // must move nothing: overwriting the entry would re-stamp it with the
    // departed generation, and the new mailbox's next attempt would read a
    // mismatch and connect straight away.
    let rejectStalled: (err: unknown) => void = () => {}
    connectBehaviour = () => new Promise<void>((_resolve, reject) => { rejectStalled = reject })
    const stalled = syncFolder(1, 'INBOX')
    await Promise.resolve()
    expect(logins).toBe(1)

    // Account deleted and recreated under the same id.
    generations.set(1, 1)
    connectBehaviour = () => Promise.reject(authFailure())
    await syncFolder(1, 'INBOX')
    expect(logins).toBe(2)
    expect(isImapAuthBackoffError(await syncFolder(1, 'Sent'))).toBe(true)

    // The old attempt lands now.
    rejectStalled(authFailure())
    await stalled

    expect(isImapAuthBackoffError(await syncFolder(1, 'Sent'))).toBe(true)
    expect(logins).toBe(2)
  })

  it('does not let a stale success release a live latch', async () => {
    let resolveStalled: () => void = () => {}
    connectBehaviour = () => new Promise<void>((resolve) => { resolveStalled = resolve })
    const stalled = syncFolder(1, 'INBOX')
    await Promise.resolve()

    generations.set(1, 1)
    connectBehaviour = () => Promise.reject(authFailure())
    await syncFolder(1, 'INBOX')
    expect(isImapAuthBackoffError(await syncFolder(1, 'Sent'))).toBe(true)

    // The old mailbox's operation succeeds — for a mailbox that no longer
    // holds this id. It must not clear the new mailbox's latch.
    resolveStalled()
    await stalled

    expect(isImapAuthBackoffError(await syncFolder(1, 'Sent'))).toBe(true)
  })

  it('does not hold back a new mailbox that inherited the account id', async () => {
    await syncFolder(1, 'INBOX')
    expect(isImapAuthBackoffError(await syncFolder(1, 'Sent'))).toBe(true)
    expect(logins).toBe(1)

    // Account deleted and a new one created: same id, bumped generation.
    generations.set(1, 1)
    connectBehaviour = () => Promise.resolve()
    expect(await syncFolder(1, 'INBOX')).toBeNull()
    expect(logins).toBe(2)
  })
})

describe('login latch — the IDLE prologue is exempt, not just the interactive tier', () => {
  afterEach(async () => {
    // `connectIdle()` only ever set `idleClient` on a SUCCESSFUL connect, and
    // every case below leaves the mocked connect rejecting — so there is
    // nothing for `stopIdle()` to tear down. Kept anyway as a guard against a
    // future case in this block that succeeds and would otherwise leak an
    // idle loop into the next test file.
    try {
      await Promise.race([stopIdle(), new Promise<void>((resolve) => { setTimeout(resolve, 200) })])
    } catch { /* ignore */ }
  })

  it('still dials out while a background op for the same account is refused', async () => {
    // Arm the latch exactly like the periodic-sync cases above: one real
    // rejection, then the next background attempt is refused before the
    // socket.
    await syncFolder(1, 'INBOX')
    expect(isImapAuthBackoffError(await syncFolder(1, 'Sent'))).toBe(true)
    expect(logins).toBe(1)

    // `startIdle` -> `connectIdle` calls `ImapFlow#connect()` directly; it
    // does not go through `withOutcomeReporting`, so `admitLoginAttempt` is
    // never consulted for it. If that ever changed, this would reject with
    // the synthetic backoff error before touching the socket and `logins`
    // would stay at 1 — instead a real (failing) login goes out.
    const err = await startIdle(1, cfg, 'INBOX', () => {}).catch(e => e)
    expect(isImapAuthBackoffError(err)).toBe(false)
    expect(logins).toBe(2)
  })
})

describe('login latch — OAuth refresh is untouched', () => {
  it('still refreshes the token once for an admitted operation', async () => {
    let refreshed = 0
    const refresh = vi.fn().mockImplementation(async () => {
      refreshed += 1
      connectBehaviour = () => Promise.resolve()
      return 'fresh-token'
    })
    registerAuthErrorHandler(1, refresh)

    const oauthCfg: ImapConfig = { ...cfg, pass: undefined, accessToken: 'stale' }
    await fetchAllFolderHeaders(oauthCfg, 'INBOX', 1, () => {})

    // One refresh, one failed login, one successful retry — and no latch, since
    // the operation the caller saw succeeded.
    expect(refreshed).toBe(1)
    expect(logins).toBe(2)
    expect(outcomes).toEqual([{ accountId: 1, accountGeneration: 0, ok: true }])
  })

  it('does not invoke the refresh handler for a refused operation', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('invalid_grant'))
    registerAuthErrorHandler(1, refresh)

    const oauthCfg: ImapConfig = { ...cfg, pass: undefined, accessToken: 'stale' }
    for (const folder of FOLDERS) {
      try { await fetchAllFolderHeaders(oauthCfg, folder, 1, () => {}) } catch { /* expected */ }
    }

    // The refusal happens before the socket, so it also happens before the
    // token endpoint is touched — one `/token` call for the whole pass.
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(logins).toBe(1)
  })
})
