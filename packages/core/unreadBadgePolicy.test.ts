import { describe, it, expect } from 'vitest'
import { isFolderCountedInBadges, sumBadgeUnread } from './unreadBadgePolicy'

describe('isFolderCountedInBadges', () => {
  it('counts the inbox by default', () => {
    expect(isFolderCountedInBadges({ role: '\\Inbox' })).toBe(true)
  })

  it('does not count other roles by default', () => {
    for (const role of ['\\Archive', '\\Trash', '\\Junk', '\\Drafts', '\\Sent', null]) {
      expect(isFolderCountedInBadges({ role }), `role ${role}`).toBe(false)
    }
  })

  it('honours an explicit preference in both directions', () => {
    expect(isFolderCountedInBadges({ role: '\\Archive', pref: { includeInBadges: true } })).toBe(true)
    expect(isFolderCountedInBadges({ role: '\\Inbox', pref: { includeInBadges: false } })).toBe(false)
  })

  it('lets a hidden folder override even an explicit inclusion', () => {
    expect(isFolderCountedInBadges({ role: '\\Inbox', pref: { visible: false, includeInBadges: true } })).toBe(false)
  })

  it('treats a missing preference row as visible', () => {
    expect(isFolderCountedInBadges({ role: '\\Inbox', pref: null })).toBe(true)
    expect(isFolderCountedInBadges(null)).toBe(false)
  })

  it('does not read null/undefined includeInBadges as false', () => {
    expect(isFolderCountedInBadges({ role: '\\Inbox', pref: { includeInBadges: null } })).toBe(true)
  })
})

describe('sumBadgeUnread', () => {
  const rows = [
    { accountId: 1, folder: 'INBOX', unread: 3 },
    { accountId: 1, folder: 'Archive', unread: 40 },
    { accountId: 2, folder: 'INBOX', unread: 2 },
  ]

  it('sums only the folders the policy counts, across accounts', () => {
    const total = sumBadgeUnread(rows, (_a, folder) => ({ role: folder === 'INBOX' ? '\\Inbox' : '\\Archive' }))
    expect(total).toBe(5)
  })

  it('includes an opted-in non-inbox folder', () => {
    const total = sumBadgeUnread(rows, (_a, folder) => folder === 'Archive'
      ? { role: '\\Archive', pref: { includeInBadges: true } }
      : { role: '\\Inbox' })
    expect(total).toBe(45)
  })

  it('drops rows with impossible counts', () => {
    const weird = [
      { accountId: 1, folder: 'INBOX', unread: Number.NaN },
      { accountId: 1, folder: 'INBOX2', unread: -5 },
      { accountId: 1, folder: 'INBOX3', unread: 0 },
      { accountId: 1, folder: 'INBOX4', unread: 4 },
    ]
    expect(sumBadgeUnread(weird, () => ({ role: '\\Inbox' }))).toBe(4)
  })

  it('is zero when nothing counts', () => {
    expect(sumBadgeUnread(rows, () => ({ role: '\\Trash' }))).toBe(0)
    expect(sumBadgeUnread([], () => ({ role: '\\Inbox' }))).toBe(0)
  })
})
