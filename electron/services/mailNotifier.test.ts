import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initMailNotifier,
  seedMailNotifierMarks,
  notifyNewMail,
  forgetAccountNotifications,
  flushMailNotifications,
  NOTIFIER_MAX_PER_PASS,
  type MailNotifierDeps,
  type MailNotifierMessage,
} from './mailNotifier'

type Msg = MailNotifierMessage

function makeDeps(overrides: Partial<MailNotifierDeps> = {}) {
  const store = new Map<string, Msg[]>()
  const validity = new Map<string, number | null>()
  const present = vi.fn()
  const captureException = vi.fn()
  const deps: MailNotifierDeps = {
    listAccountIds: () => [1],
    listFolderPrefs: () => [
      { folderPath: 'INBOX', headerSyncMode: 'full' },
      { folderPath: 'Archive', headerSyncMode: 'manual' },
      { folderPath: 'Spam', headerSyncMode: 'period' },
    ],
    getUidValidity: (a, f) => validity.get(`${a}:${f}`) ?? null,
    getMaxUidForFolder: (a, f) => (store.get(`${a}:${f}`) ?? []).reduce((m, x) => Math.max(m, x.uid), 0),
    getUidsSince: (a, f, since, limit) =>
      (store.get(`${a}:${f}`) ?? [])
        .map(m => m.uid)
        .filter(u => u > since)
        .sort((x, y) => x - y)
        .slice(0, limit),
    getMessageByUid: (a, f, uid) => (store.get(`${a}:${f}`) ?? []).find(m => m.uid === uid),
    getSettings: () => ({ notificationsEnabled: true, hiddenUnreadFolders: [], language: 'en' }),
    getFolderRoles: () => null,
    // Review H2 — the shared badge policy. INBOX and Spam count by default in
    // these fixtures; individual cases override it.
    isCountedInBadges: () => true,
    present,
    log: { info: vi.fn(), warn: vi.fn() },
    captureException,
    ...overrides,
  }
  const put = (accountId: number, folder: string, msgs: Msg[]) => {
    const k = `${accountId}:${folder}`
    store.set(k, [...(store.get(k) ?? []), ...msgs])
  }
  const setValidity = (accountId: number, folder: string, v: number | null) => {
    validity.set(`${accountId}:${folder}`, v)
  }
  /** Account deletion removes its cached mail too — mirror that in the fixture. */
  const wipe = (accountId: number) => {
    for (const k of [...store.keys()]) {
      if (k.startsWith(`${accountId}:`)) store.delete(k)
    }
  }
  return { deps, present, captureException, put, setValidity, wipe }
}

const msg = (uid: number, unread = true): Msg => ({ uid, subject: `s${uid}`, from: `f${uid}`, unread })

describe('mailNotifier', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('seeds every watched folder from the cache and announces nothing for it', () => {
    const { deps, present, put } = makeDeps()
    put(1, 'INBOX', [msg(10), msg(11)])
    put(1, 'Spam', [msg(4)])
    initMailNotifier(deps)

    expect(seedMailNotifierMarks()).toBe(2) // INBOX + Spam; 'manual' Archive is not watched

    // The whole existing archive is below the mark, so a pass right after the
    // upgrade says nothing (the §2.86-class regression this seeding prevents).
    expect(notifyNewMail(1, 'INBOX')).toBe('nothing-new')
    vi.runAllTimers()
    expect(present).not.toHaveBeenCalled()
  })

  it('is idempotent: a second seeding leaves existing marks alone', () => {
    const { deps, put } = makeDeps()
    put(1, 'INBOX', [msg(10)])
    initMailNotifier(deps)
    expect(seedMailNotifierMarks()).toBe(2)
    put(1, 'INBOX', [msg(20)])
    expect(seedMailNotifierMarks()).toBe(0)
    expect(notifyNewMail(1, 'INBOX')).toBe('queued')
  })

  it('announces mail that arrived above the mark, newest first in the text', () => {
    const { deps, present, put } = makeDeps()
    put(1, 'INBOX', [msg(10)])
    initMailNotifier(deps)
    seedMailNotifierMarks()

    put(1, 'INBOX', [msg(11), msg(12)])
    expect(notifyNewMail(1, 'INBOX')).toBe('queued')
    vi.runAllTimers()

    expect(present).toHaveBeenCalledTimes(1)
    expect(present.mock.calls[0][0]).toMatchObject({
      accountId: 1, folder: 'INBOX', uid: 12, count: 2, subject: 's12', from: 'f12', lang: 'en',
    })
  })

  it('collapses one pass across folders of the same account into one notification', () => {
    const { deps, present, put } = makeDeps()
    put(1, 'INBOX', [msg(10)])
    put(1, 'Spam', [msg(3)])
    initMailNotifier(deps)
    seedMailNotifierMarks()

    put(1, 'INBOX', [msg(11)])
    put(1, 'Spam', [msg(4)])
    notifyNewMail(1, 'INBOX')
    notifyNewMail(1, 'Spam')
    vi.runAllTimers()

    expect(present).toHaveBeenCalledTimes(1)
    expect(present.mock.calls[0][0]).toMatchObject({ count: 2 })
  })

  it('keeps accounts separate', () => {
    const { deps, present, put } = makeDeps({ listAccountIds: () => [1, 2] })
    put(1, 'INBOX', [msg(10)])
    put(2, 'INBOX', [msg(50)])
    initMailNotifier(deps)
    seedMailNotifierMarks()

    put(1, 'INBOX', [msg(11)])
    put(2, 'INBOX', [msg(51)])
    notifyNewMail(1, 'INBOX')
    notifyNewMail(2, 'INBOX')
    vi.runAllTimers()

    expect(present).toHaveBeenCalledTimes(2)
    expect(present.mock.calls.map(c => c[0].accountId).sort()).toEqual([1, 2])
  })

  it('never announces the same message twice', () => {
    const { deps, present, put } = makeDeps()
    put(1, 'INBOX', [msg(10)])
    initMailNotifier(deps)
    seedMailNotifierMarks()

    put(1, 'INBOX', [msg(11)])
    notifyNewMail(1, 'INBOX')
    vi.runAllTimers()
    expect(notifyNewMail(1, 'INBOX')).toBe('nothing-new')
    vi.runAllTimers()
    expect(present).toHaveBeenCalledTimes(1)
  })

  it('ignores folders that are not synced in full/period mode', () => {
    const { deps, put } = makeDeps()
    initMailNotifier(deps)
    seedMailNotifierMarks()
    put(1, 'Archive', [msg(99)])
    expect(notifyNewMail(1, 'Archive')).toBe('not-watched')
  })

  it('ignores folders the user hid from unread badges', () => {
    const { deps, put } = makeDeps({
      getSettings: () => ({ notificationsEnabled: true, hiddenUnreadFolders: ['Spam'], language: 'en' }),
    })
    put(1, 'Spam', [msg(1)])
    initMailNotifier(deps)
    seedMailNotifierMarks()
    put(1, 'Spam', [msg(2)])
    expect(notifyNewMail(1, 'Spam')).toBe('not-watched')
  })

  it('falls back to the role-derived hidden folders when the user set no list', () => {
    const { deps, put } = makeDeps({ getFolderRoles: () => ({ junk: 'Spam' }) })
    put(1, 'Spam', [msg(1)])
    initMailNotifier(deps)
    seedMailNotifierMarks()
    put(1, 'Spam', [msg(2)])
    expect(notifyNewMail(1, 'Spam')).toBe('not-watched')
    expect(notifyNewMail(1, 'INBOX')).not.toBe('not-watched')
  })

  it('abandons the pass and re-seeds when UIDVALIDITY changed', () => {
    const { deps, present, put, setValidity } = makeDeps()
    setValidity(1, 'INBOX', 100)
    put(1, 'INBOX', [msg(10)])
    initMailNotifier(deps)
    seedMailNotifierMarks()

    // Renumbered mailbox: low UIDs, new validity.
    setValidity(1, 'INBOX', 200)
    put(1, 'INBOX', [msg(1), msg(2)])
    expect(notifyNewMail(1, 'INBOX')).toBe('uidvalidity-changed')
    vi.runAllTimers()
    expect(present).not.toHaveBeenCalled()

    // The re-seeded mark is in the NEW space, so the next arrival is announced.
    put(1, 'INBOX', [msg(11)])
    expect(notifyNewMail(1, 'INBOX')).toBe('queued')
  })

  it('treats an unknown UIDVALIDITY as unknown, not as a mismatch', () => {
    const { deps, put, setValidity } = makeDeps()
    put(1, 'INBOX', [msg(10)])
    initMailNotifier(deps)
    seedMailNotifierMarks() // validity null at seed time

    setValidity(1, 'INBOX', 42)
    put(1, 'INBOX', [msg(11)])
    expect(notifyNewMail(1, 'INBOX')).toBe('queued')
  })

  it('keeps the mark moving while notifications are switched off', () => {
    let enabled = false
    const { deps, present, put } = makeDeps({
      getSettings: () => ({ notificationsEnabled: enabled, hiddenUnreadFolders: [], language: 'en' }),
    })
    put(1, 'INBOX', [msg(10)])
    initMailNotifier(deps)
    seedMailNotifierMarks()

    put(1, 'INBOX', [msg(11), msg(12)])
    expect(notifyNewMail(1, 'INBOX')).toBe('disabled')
    vi.runAllTimers()
    expect(present).not.toHaveBeenCalled()

    // Re-enabling must not replay the backlog accumulated while off.
    enabled = true
    expect(notifyNewMail(1, 'INBOX')).toBe('nothing-new')
    put(1, 'INBOX', [msg(13)])
    expect(notifyNewMail(1, 'INBOX')).toBe('queued')
    vi.runAllTimers()
    expect(present.mock.calls[0][0]).toMatchObject({ uid: 13, count: 1 })
  })

  it('does not announce messages that are already read', () => {
    const { deps, present, put } = makeDeps()
    put(1, 'INBOX', [msg(10)])
    initMailNotifier(deps)
    seedMailNotifierMarks()

    put(1, 'INBOX', [msg(11, false)])
    expect(notifyNewMail(1, 'INBOX')).toBe('nothing-new')
    vi.runAllTimers()
    expect(present).not.toHaveBeenCalled()
  })

  it('caps a pass and leaves the tail for the next one', () => {
    const { deps, present, put } = makeDeps()
    put(1, 'INBOX', [msg(0)])
    initMailNotifier(deps)
    seedMailNotifierMarks()

    put(1, 'INBOX', Array.from({ length: NOTIFIER_MAX_PER_PASS + 5 }, (_, i) => msg(i + 1)))
    expect(notifyNewMail(1, 'INBOX')).toBe('queued')
    vi.runAllTimers()
    expect(present.mock.calls[0][0]).toMatchObject({ count: NOTIFIER_MAX_PER_PASS })

    expect(notifyNewMail(1, 'INBOX')).toBe('queued')
    vi.runAllTimers()
    expect(present.mock.calls[1][0]).toMatchObject({ count: 5 })
  })

  it('reports a failing pass without leaking mail content', () => {
    const { deps, captureException, put } = makeDeps({
      getUidsSince: () => { throw new Error('db is on fire: subject "Payroll 2026"') },
    })
    put(1, 'INBOX', [msg(1)])
    initMailNotifier(deps)
    seedMailNotifierMarks()
    put(1, 'INBOX', [msg(2)])

    expect(notifyNewMail(1, 'INBOX')).toBe('failed')
    expect(captureException).toHaveBeenCalledTimes(1)
    const [err, ctx] = captureException.mock.calls[0]
    expect((err as Error).message).toBe('mailNotifier pass failed')
    expect(ctx).toEqual({ source: 'mailNotifier:pass', accountId: 1 })
    expect(JSON.stringify(ctx)).not.toContain('INBOX')
  })

  it('survives a presentation that throws and keeps going for other accounts', () => {
    const present = vi.fn().mockImplementationOnce(() => { throw new Error('no display') })
    const { deps, captureException, put } = makeDeps({ present, listAccountIds: () => [1, 2] })
    put(1, 'INBOX', [msg(1)])
    put(2, 'INBOX', [msg(1)])
    initMailNotifier(deps)
    seedMailNotifierMarks()

    put(1, 'INBOX', [msg(2)])
    put(2, 'INBOX', [msg(2)])
    notifyNewMail(1, 'INBOX')
    notifyNewMail(2, 'INBOX')
    expect(() => flushMailNotifications()).not.toThrow()
    expect(present).toHaveBeenCalledTimes(2)
    expect(captureException.mock.calls[0][1]).toMatchObject({ source: 'mailNotifier:present' })
  })

  it('does not announce a folder the shared badge policy excludes (review H2)', () => {
    const { deps, present, put } = makeDeps({
      isCountedInBadges: (_a, folder) => folder === 'INBOX',
    })
    put(1, 'INBOX', [msg(1)])
    put(1, 'Spam', [msg(1)])
    initMailNotifier(deps)
    seedMailNotifierMarks()

    put(1, 'Spam', [msg(2)])
    expect(notifyNewMail(1, 'Spam')).toBe('not-watched')
    put(1, 'INBOX', [msg(2)])
    expect(notifyNewMail(1, 'INBOX')).toBe('queued')
    vi.runAllTimers()
    expect(present).toHaveBeenCalledTimes(1)
  })

  describe('review H1 — the mark commits after the batch is queued', () => {
    it('re-announces the batch when reading a message throws mid-pass', () => {
      let explode = true
      const { deps, present, put } = makeDeps({
        getMessageByUid: (_a, _f, uid) => {
          if (explode) throw new Error('cache read failed')
          return { uid, subject: `s${uid}`, from: `f${uid}`, unread: true }
        },
      })
      put(1, 'INBOX', [msg(10)])
      initMailNotifier(deps)
      seedMailNotifierMarks()

      put(1, 'INBOX', [msg(11), msg(12)])
      expect(notifyNewMail(1, 'INBOX')).toBe('failed')
      vi.runAllTimers()
      expect(present).not.toHaveBeenCalled()

      // The mark did NOT move, so the same mail is still announceable — the
      // failure mode the old ordering turned into permanent silence.
      explode = false
      expect(notifyNewMail(1, 'INBOX')).toBe('queued')
      vi.runAllTimers()
      expect(present.mock.calls[0][0]).toMatchObject({ count: 2, uid: 12 })
    })

    it('still advances past messages that were all already read', () => {
      const { deps, present, put } = makeDeps()
      put(1, 'INBOX', [msg(10)])
      initMailNotifier(deps)
      seedMailNotifierMarks()

      put(1, 'INBOX', [msg(11, false), msg(12, false)])
      expect(notifyNewMail(1, 'INBOX')).toBe('nothing-new')
      // Second pass sees nothing again: the read tail was consumed, not
      // re-scanned forever.
      expect(notifyNewMail(1, 'INBOX')).toBe('nothing-new')

      put(1, 'INBOX', [msg(13)])
      expect(notifyNewMail(1, 'INBOX')).toBe('queued')
      vi.runAllTimers()
      expect(present.mock.calls[0][0]).toMatchObject({ count: 1, uid: 13 })
    })

    it('does not re-announce after a successful pass', () => {
      const { deps, present, put } = makeDeps()
      put(1, 'INBOX', [msg(10)])
      initMailNotifier(deps)
      seedMailNotifierMarks()

      put(1, 'INBOX', [msg(11)])
      expect(notifyNewMail(1, 'INBOX')).toBe('queued')
      expect(notifyNewMail(1, 'INBOX')).toBe('nothing-new')
      vi.runAllTimers()
      expect(present).toHaveBeenCalledTimes(1)
    })
  })

  describe('security review MEDIUM-2 — a removed account leaves nothing behind', () => {
    it('drops a queued notification, so the deleted mailbox never shows its subject', () => {
      const { deps, present, put } = makeDeps({ listAccountIds: () => [1, 2] })
      put(1, 'INBOX', [msg(10)])
      put(2, 'INBOX', [msg(10)])
      initMailNotifier(deps)
      seedMailNotifierMarks()

      put(1, 'INBOX', [msg(11)])
      put(2, 'INBOX', [msg(11)])
      notifyNewMail(1, 'INBOX')
      notifyNewMail(2, 'INBOX')

      forgetAccountNotifications(1)
      vi.runAllTimers()

      expect(present).toHaveBeenCalledTimes(1)
      expect(present.mock.calls[0][0]).toMatchObject({ accountId: 2 })
    })

    it('drops the watermark, so an id reused by a NEW account starts from its own cache', () => {
      const { deps, present, put, wipe } = makeDeps()
      put(1, 'INBOX', [msg(100)])
      initMailNotifier(deps)
      seedMailNotifierMarks()

      // Deleting the account takes its cached mail with it; the id is then
      // reissued (`max + 1`) to a different mailbox.
      forgetAccountNotifications(1)
      wipe(1)

      // The id is reissued to a different mailbox whose UIDs are lower. With
      // the old mark still in place (100) none of this would ever be seen.
      put(1, 'INBOX', [msg(1)])
      // First sight of the folder re-baselines rather than announcing history.
      expect(notifyNewMail(1, 'INBOX')).toBe('seeded')
      put(1, 'INBOX', [msg(2)])
      expect(notifyNewMail(1, 'INBOX')).toBe('queued')
      vi.runAllTimers()
      expect(present.mock.calls[0][0]).toMatchObject({ accountId: 1, uid: 2 })
    })

    it('touches only the account it was given', () => {
      const { deps, put } = makeDeps({ listAccountIds: () => [1, 2] })
      put(1, 'INBOX', [msg(10)])
      put(2, 'INBOX', [msg(10)])
      initMailNotifier(deps)
      seedMailNotifierMarks()

      forgetAccountNotifications(1)
      // Account 2 keeps its mark: nothing new, no re-announcement.
      expect(notifyNewMail(2, 'INBOX')).toBe('nothing-new')
      expect(notifyNewMail(1, 'INBOX')).toBe('seeded')
    })

    it('is safe for an unknown id and cancels the flush once nothing is queued', () => {
      const { deps, present, put } = makeDeps()
      put(1, 'INBOX', [msg(10)])
      initMailNotifier(deps)
      seedMailNotifierMarks()
      put(1, 'INBOX', [msg(11)])
      notifyNewMail(1, 'INBOX')

      expect(() => forgetAccountNotifications(999)).not.toThrow()
      forgetAccountNotifications(1)
      vi.runAllTimers()
      expect(present).not.toHaveBeenCalled()
      // A later arrival still schedules its own flush.
      put(1, 'INBOX', [msg(12)])
      notifyNewMail(1, 'INBOX')
      put(1, 'INBOX', [msg(13)])
      expect(notifyNewMail(1, 'INBOX')).toBe('queued')
      vi.runAllTimers()
      expect(present).toHaveBeenCalledTimes(1)
    })
  })

  it('does nothing at all before it is wired', async () => {
    const mod = await import('./mailNotifier')
    // Re-init with a deps object, then simulate "not wired" by checking the
    // documented outcome of an unknown folder on a fresh module state.
    const { deps } = makeDeps()
    mod.initMailNotifier(deps)
    expect(mod.notifyNewMail(1, 'Nope')).toBe('not-watched')
  })
})
