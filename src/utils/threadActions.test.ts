import { describe, it, expect } from 'vitest'
import type { MailSummary } from '../../packages/net/types'
import type { ThreadRow } from './threading'
import { resolveThreadItems, expandBulkToThreads } from './threadActions'

function makeMail(accountId: number, folder: string, uid: number): MailSummary {
  return {
    accountId, folder, uid,
    message_id: `<${uid}@test>`,
    from: 'a@b', to: 'c@d', subject: `Subj ${uid}`,
    date: '2025-01-01T00:00:00Z', unread: false, flagged: false,
    in_reply_to: undefined, references: undefined, snippet: '',
  } as MailSummary
}

function makeRow(lead: MailSummary, items: MailSummary[]): ThreadRow {
  return {
    key: `${lead.accountId}:${lead.folder}:${lead.uid}`,
    lead,
    items,
    count: items.length,
    unreadCount: items.filter(m => m.unread).length,
  }
}

describe('resolveThreadItems', () => {
  const m1 = makeMail(1, 'INBOX', 10)
  const m2 = makeMail(1, 'INBOX', 20)
  const m3 = makeMail(1, 'INBOX', 30)
  const threadRows: ThreadRow[] = [
    makeRow(m1, [m1, m2]),
    makeRow(m3, [m3]),
  ]

  it('returns [m] when groupConversations=false', () => {
    expect(resolveThreadItems(m1, threadRows, false)).toEqual([m1])
  })

  it('returns all thread items when groupConversations=true', () => {
    expect(resolveThreadItems(m1, threadRows, true)).toEqual([m1, m2])
    expect(resolveThreadItems(m2, threadRows, true)).toEqual([m1, m2])
  })

  it('returns a single message for a single-message thread', () => {
    expect(resolveThreadItems(m3, threadRows, true)).toEqual([m3])
  })

  it('returns [m] if the message is not found in any thread', () => {
    const orphan = makeMail(1, 'INBOX', 99)
    expect(resolveThreadItems(orphan, threadRows, true)).toEqual([orphan])
  })
})

describe('expandBulkToThreads', () => {
  const m1 = makeMail(1, 'INBOX', 10)
  const m2 = makeMail(1, 'INBOX', 20)
  const m3 = makeMail(1, 'INBOX', 30)
  const m4 = makeMail(1, 'INBOX', 40)
  const allMails = [m1, m2, m3, m4]
  const threadRows: ThreadRow[] = [
    makeRow(m1, [m1, m2]),
    makeRow(m3, [m3, m4]),
  ]

  it('without groupConversations filters by selectedKeys directly', () => {
    const selected = new Set(['1:INBOX:10', '1:INBOX:30'])
    const result = expandBulkToThreads(selected, allMails, threadRows, false)
    expect(result).toEqual([m1, m3])
  })

  it('with groupConversations expands lead -> all items', () => {
    const selected = new Set(['1:INBOX:10']) // selected the lead of the first thread
    const result = expandBulkToThreads(selected, allMails, threadRows, true)
    expect(result).toEqual([m1, m2])
  })

  it('with groupConversations expands non-lead item -> all items', () => {
    const selected = new Set(['1:INBOX:20']) // selected a non-lead item of the first thread
    const result = expandBulkToThreads(selected, allMails, threadRows, true)
    expect(result).toEqual([m1, m2])
  })

  it('expands multiple selected threads', () => {
    const selected = new Set(['1:INBOX:10', '1:INBOX:30'])
    const result = expandBulkToThreads(selected, allMails, threadRows, true)
    expect(result).toEqual([m1, m2, m3, m4])
  })

  it('does not duplicate messages', () => {
    // Even if the same key appears twice
    const selected = new Set(['1:INBOX:10'])
    const result = expandBulkToThreads(selected, allMails, threadRows, true)
    const uids = result.map(m => m.uid)
    expect(uids).toEqual([10, 20])
    expect(new Set(uids).size).toBe(uids.length)
  })

  it('returns an empty array if nothing is selected', () => {
    const selected = new Set<string>()
    expect(expandBulkToThreads(selected, allMails, threadRows, true)).toEqual([])
    expect(expandBulkToThreads(selected, allMails, threadRows, false)).toEqual([])
  })
})
