import { describe, expect, it } from 'vitest'
import type { MailSummary } from '@mailcopilot/types'
import { buildThreadRows } from './threading'

function m(partial: Partial<MailSummary> & Pick<MailSummary, 'accountId' | 'folder' | 'uid' | 'from' | 'subject' | 'date' | 'unread' | 'flagged'>): MailSummary {
  return {
    fromAddr: 'a@test',
    ...partial,
  }
}

describe('packages/core/threading', () => {
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
})
