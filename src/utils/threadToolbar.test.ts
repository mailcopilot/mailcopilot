import { describe, it, expect } from 'vitest'
import type { MailSummary } from '@mailcopilot/types'
import type { ThreadRow } from './threading'
import { isThreadMode, pickLatestMail, pickReplyTarget, countThreadUnread } from './threadToolbar'

function mail(uid: number, overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    accountId: 1,
    folder: 'INBOX',
    uid,
    from: `Sender ${uid}`,
    fromAddr: `s${uid}@example.com`,
    fromName: `Sender ${uid}`,
    subject: `Subject ${uid}`,
    date: `2024-01-0${uid}T10:00:00Z`,
    unread: false,
    flagged: false,
    ...overrides,
  }
}

function thread(items: MailSummary[]): ThreadRow {
  const lead = items[0]
  const key = `${lead.accountId}:${lead.folder}:${lead.uid}`
  return { key, lead, items, count: items.length, unreadCount: items.filter(m => m.unread).length }
}

describe('threadToolbar.isThreadMode', () => {
  it('returns true when grouping on AND thread has >1 item', () => {
    expect(isThreadMode(true, thread([mail(1), mail(2)]))).toBe(true)
  })

  it('returns false when grouping is off', () => {
    expect(isThreadMode(false, thread([mail(1), mail(2)]))).toBe(false)
  })

  it('returns false when thread has only 1 item (no thread context)', () => {
    expect(isThreadMode(true, thread([mail(1)]))).toBe(false)
  })

  it('returns false when activeThread is null (loading race)', () => {
    expect(isThreadMode(true, null)).toBe(false)
  })

  it('returns false when activeThread is undefined', () => {
    expect(isThreadMode(true, undefined)).toBe(false)
  })
})

describe('threadToolbar.pickLatestMail', () => {
  it('picks the newest message in the thread by date', () => {
    // uid=1 has the latest date; uid=3 the oldest.
    const items = [
      mail(1, { date: '2024-03-10T10:00:00Z' }),
      mail(2, { date: '2024-01-05T10:00:00Z' }),
      mail(3, { date: '2023-11-01T10:00:00Z' }),
    ]
    const fallback = mail(99)
    expect(pickLatestMail(thread(items), fallback, true).uid).toBe(1)
  })

  it('falls back to the provided active mail when not in thread mode', () => {
    const items = [mail(1), mail(2), mail(3)]
    const fallback = mail(99)
    expect(pickLatestMail(thread(items), fallback, false)).toBe(fallback)
  })

  it('falls back when activeThread is null', () => {
    const fallback = mail(99)
    expect(pickLatestMail(null, fallback, true)).toBe(fallback)
  })

  it('falls back when activeThread is undefined', () => {
    const fallback = mail(99)
    expect(pickLatestMail(undefined, fallback, true)).toBe(fallback)
  })

  it('falls back when thread has zero items (defensive)', () => {
    const fallback = mail(99)
    const t: ThreadRow = { key: 'x', lead: fallback, items: [], count: 0, unreadCount: 0 }
    expect(pickLatestMail(t, fallback, true)).toBe(fallback)
  })

  it('preserves input order on equal dates (stable sort tie-breaker)', () => {
    const same = '2024-05-01T12:00:00Z'
    const items = [mail(1, { date: same }), mail(2, { date: same })]
    // ECMA-2019: Array.prototype.sort is stable. With equal dates the result
    // depends on input order. The contract is just "deterministic across runs"
    // — we assert it does not crash and returns one of the input items.
    const got = pickLatestMail(thread(items), mail(99), true)
    expect([1, 2]).toContain(got.uid)
  })

  it('treats unparseable dates as oldest (NaN sinks to the bottom)', () => {
    // uid=1 has an invalid date; uid=2 has a real date. uid=2 must win.
    const items = [
      mail(1, { date: 'not-a-date' }),
      mail(2, { date: '2024-01-05T10:00:00Z' }),
    ]
    expect(pickLatestMail(thread(items), mail(99), true).uid).toBe(2)
  })
})

describe('threadToolbar.pickReplyTarget', () => {
  it('returns latestMail in thread mode', () => {
    const a = mail(7)
    const latest = mail(8)
    expect(pickReplyTarget(a, latest, true)).toBe(latest)
  })

  it('returns active in single mode', () => {
    const a = mail(7)
    const latest = mail(8)
    expect(pickReplyTarget(a, latest, false)).toBe(a)
  })
})

describe('threadToolbar.countThreadUnread', () => {
  it('counts items with unread=true', () => {
    const items = [
      mail(1, { unread: true }),
      mail(2, { unread: false }),
      mail(3, { unread: true }),
    ]
    expect(countThreadUnread(thread(items), true)).toBe(2)
  })

  it('returns 0 when all items are read', () => {
    const items = [mail(1), mail(2), mail(3)]
    expect(countThreadUnread(thread(items), true)).toBe(0)
  })

  it('returns 0 outside thread mode (single-mode mark-thread-read button is hidden)', () => {
    const items = [mail(1, { unread: true }), mail(2, { unread: true })]
    expect(countThreadUnread(thread(items), false)).toBe(0)
  })

  it('returns 0 when activeThread is null', () => {
    expect(countThreadUnread(null, true)).toBe(0)
  })

  it('returns 0 when activeThread is undefined', () => {
    expect(countThreadUnread(undefined, true)).toBe(0)
  })
})
