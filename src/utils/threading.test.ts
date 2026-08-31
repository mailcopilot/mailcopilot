import { describe, expect, it } from 'vitest'
import type { MailSummary } from '../../packages/net/types'
import { buildThreadRows, pickThreadOpenTarget, singleMessageRow } from './threading'

function m(partial: Partial<MailSummary> & Pick<MailSummary, 'accountId' | 'folder' | 'uid' | 'from' | 'subject' | 'date' | 'unread' | 'flagged'>): MailSummary {
  return {
    fromAddr: 'a@test',
    ...partial,
  }
}

describe('utils/threading', () => {
  it('groups messages by message-id/in-reply-to/references within an account', () => {
    const rows = buildThreadRows([
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 30,
        from: 'Alice',
        subject: 'Re: Hello',
        date: '2026-02-11T10:00:00Z',
        unread: false,
        flagged: false,
        messageId: '<m3@test>',
        inReplyTo: '<m1@test>',
        references: '<m1@test> <m2@test>',
      }),
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 20,
        from: 'Bob',
        subject: 'Hello',
        date: '2026-02-11T09:00:00Z',
        unread: true,
        flagged: false,
        messageId: '<m1@test>',
      }),
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 10,
        from: 'Service',
        subject: 'Independent',
        date: '2026-02-11T08:00:00Z',
        unread: false,
        flagged: false,
      }),
    ])

    expect(rows.length).toBe(2)
    expect(rows[0]?.count).toBe(2)
    expect(rows[0]?.lead.uid).toBe(30)
    expect(rows[1]?.count).toBe(1)
    expect(rows[1]?.lead.uid).toBe(10)
  })

  it('does not merge identical message-ids across different accounts', () => {
    const rows = buildThreadRows([
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 2,
        from: 'A',
        subject: 'One',
        date: '2026-02-11T10:00:00Z',
        unread: false,
        flagged: false,
        messageId: '<same@test>',
      }),
      m({
        accountId: 2,
        folder: 'INBOX',
        uid: 2,
        from: 'B',
        subject: 'Two',
        date: '2026-02-11T09:00:00Z',
        unread: false,
        flagged: false,
        messageId: '<same@test>',
      }),
    ])

    expect(rows.length).toBe(2)
    expect(rows[0]?.count).toBe(1)
    expect(rows[1]?.count).toBe(1)
  })

  // The renderer imports through this re-export, so the row-level unread signal
  // and the click target must arrive here too — App.tsx reads them directly.
  it('re-exports the derived row unread signal and the open target', () => {
    const rows = buildThreadRows([
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 30,
        from: 'Alice',
        subject: 'Re: Hello',
        date: '2026-02-11T10:00:00Z',
        unread: false,
        flagged: false,
        messageId: '<m3@test>',
        inReplyTo: '<m1@test>',
      }),
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 20,
        from: 'Bob',
        subject: 'Hello',
        date: '2026-02-11T09:00:00Z',
        unread: true,
        flagged: false,
        messageId: '<m1@test>',
      }),
    ])

    expect(rows.length).toBe(1)
    expect(rows[0]?.lead.unread).toBe(false)
    expect(rows[0]?.unreadCount).toBe(1)
    expect(pickThreadOpenTarget(rows[0]!).uid).toBe(20)
  })

  it('keeps ungrouped rows single-message (groupConversations = false path)', () => {
    const one = m({
      accountId: 1,
      folder: 'INBOX',
      uid: 5,
      from: 'Solo',
      subject: 'Alone',
      date: '2026-02-11T10:00:00Z',
      unread: true,
      flagged: false,
    })
    const row = singleMessageRow(one)

    expect(row.key).toBe('1:INBOX:5')
    expect(row.count).toBe(1)
    expect(row.items).toEqual([one])
    expect(row.unreadCount).toBe(1)
    expect(pickThreadOpenTarget(row)).toBe(one)
  })
})
