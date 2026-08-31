// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMailListView } from './useMailListView'
import type { MailSummary } from '../../packages/net/types'

function makeMail(overrides: Partial<MailSummary> & { uid: number; accountId?: number }): MailSummary {
  return {
    accountId: overrides.accountId ?? 1,
    folder: 'INBOX',
    uid: overrides.uid,
    subject: overrides.subject ?? `Subject ${overrides.uid}`,
    from: overrides.from ?? `user${overrides.uid}@test`,
    fromAddr: overrides.from ?? `user${overrides.uid}@test`,
    date: overrides.date ?? '2026-01-01T00:00:00Z',
    unread: overrides.unread ?? false,
    flagged: overrides.flagged ?? false,
    hasAttachments: overrides.hasAttachments ?? false,
  }
}

describe('useMailListView', () => {
  const mails = [
    makeMail({ uid: 3, from: 'bob@test', subject: 'Beta', unread: true, flagged: true, hasAttachments: true }),
    makeMail({ uid: 2, from: 'alice@test', subject: 'Alpha', unread: false, flagged: false }),
    makeMail({ uid: 1, from: 'carol@test', subject: 'Gamma', unread: true, flagged: false }),
  ]

  it('returns all messages without filtering by default', () => {
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'date' }))
    expect(result.current.viewMails).toHaveLength(3)
    expect(result.current.filterMode).toBe('all')
  })

  it('filterMode=unread filters only unread messages', () => {
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'date' }))
    act(() => result.current.setFilterMode('unread'))
    expect(result.current.viewMails).toHaveLength(2)
    expect(result.current.viewMails.every(m => m.unread)).toBe(true)
  })

  it('filterMode=flagged filters flagged messages', () => {
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'date' }))
    act(() => result.current.setFilterMode('flagged'))
    expect(result.current.viewMails).toHaveLength(1)
    expect(result.current.viewMails[0].uid).toBe(3)
  })

  it('filterMode=attachments filters messages with attachments', () => {
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'date' }))
    act(() => result.current.setFilterMode('attachments'))
    expect(result.current.viewMails).toHaveLength(1)
    expect(result.current.viewMails[0].uid).toBe(3)
  })

  it('sortMode=from sorts by sender', () => {
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'from' }))
    const froms = result.current.viewMails.map(m => m.from)
    expect(froms).toEqual(['alice@test', 'bob@test', 'carol@test'])
  })

  it('sortMode=subject sorts by subject', () => {
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'subject' }))
    const subjects = result.current.viewMails.map(m => m.subject)
    expect(subjects).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('threadRows without grouping creates one row per message', () => {
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'date' }))
    expect(result.current.threadRows).toHaveLength(3)
    expect(result.current.threadRows[0].count).toBe(1)
  })

  it('threadRows without grouping derives unreadCount from each message, not a stub', () => {
    // groupConversations=false must stay behaviourally identical to the
    // pre-thread-row path: one row per message, bold iff that single message is
    // unread. (Not byte-identical — the row object gained `unreadCount`.)
    // This pins the ungrouped path to `singleMessageRow` rather than a literal
    // row builder that could omit or hardcode `unreadCount`.
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'date' }))
    const byUid = new Map(result.current.threadRows.map(row => [row.lead.uid, row]))

    expect(byUid.get(3)?.unreadCount).toBe(1) // unread: true
    expect(byUid.get(2)?.unreadCount).toBe(0) // unread: false
    expect(byUid.get(1)?.unreadCount).toBe(1) // unread: true
  })

  it('activeThread finds the thread containing the active message', () => {
    const activeMail = mails[1]
    const { result } = renderHook(() => useMailListView({ mails, active: activeMail, groupConversations: false, sortMode: 'date' }))
    expect(result.current.activeThread).not.toBeNull()
    expect(result.current.activeThread!.lead.uid).toBe(activeMail.uid)
  })

  it('activeThread is null when active is null', () => {
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'date' }))
    expect(result.current.activeThread).toBeNull()
  })

  it('selectedCount and hasMultiSelection are computed correctly', () => {
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'date' }))
    expect(result.current.selectedCount).toBe(0)
    expect(result.current.hasMultiSelection).toBe(false)

    act(() => {
      result.current.setSelectedKeys(new Set(['1:INBOX:1', '1:INBOX:2']))
    })
    expect(result.current.selectedCount).toBe(2)
    expect(result.current.hasMultiSelection).toBe(true)
  })

  it('selectedCount collapses when rows merge under a live selection', () => {
    // `groupConversations` is a live setting (App subscribes to it), so two
    // separately selected messages become ONE row without the selection being
    // touched. `selectedKeys.size` would keep saying two, and the bulk panel,
    // the context menu branch and the AI context would all act on a count the
    // user cannot see on screen.
    const threaded: MailSummary[] = [
      { ...makeMail({ uid: 30, subject: 'Re: Hello' }), messageId: '<m3@test>', inReplyTo: '<m1@test>' },
      { ...makeMail({ uid: 20, subject: 'Hello' }), messageId: '<m1@test>' },
    ]
    const { result, rerender } = renderHook(
      ({ group }: { group: boolean }) => useMailListView({ mails: threaded, active: null, groupConversations: group, sortMode: 'date' }),
      { initialProps: { group: false } },
    )

    act(() => { result.current.setSelectedKeys(new Set(['1:INBOX:30', '1:INBOX:20'])) })
    expect(result.current.selectedCount).toBe(2)
    expect(result.current.hasMultiSelection).toBe(true)

    rerender({ group: true })

    expect(result.current.threadRows).toHaveLength(1)
    expect(result.current.selectedCount).toBe(1)
    expect(result.current.hasMultiSelection).toBe(false)
  })

  it('visibleLeadMails contains lead messages from threadRows', () => {
    const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'date' }))
    expect(result.current.visibleLeadMails).toHaveLength(3)
    expect(result.current.visibleLeadMails.map(m => m.uid)).toEqual([3, 2, 1])
  })

  describe('pinned sorting', () => {
    function pin(m: MailSummary): MailSummary { return { ...m, pinned: true } }

    const pinnedMails = [
      makeMail({ uid: 4, date: '2026-01-04T00:00:00Z' }),
      pin(makeMail({ uid: 3, date: '2026-01-03T00:00:00Z' })),
      makeMail({ uid: 2, date: '2026-01-02T00:00:00Z' }),
      pin(makeMail({ uid: 1, date: '2026-01-01T00:00:00Z' })),
    ]

    it('pinned messages float to the top', () => {
      const { result } = renderHook(() => useMailListView({ mails: pinnedMails, active: null, groupConversations: false, sortMode: 'date' }))
      const uids = result.current.viewMails.map(m => m.uid)
      // Pinned first (uid 3, 1), then unpinned (uid 4, 2) — preserving original order within each group
      expect(uids).toEqual([3, 1, 4, 2])
    })

    it('pinned sorting works with sortMode=from', () => {
      const sorted = [
        pin(makeMail({ uid: 1, from: 'alice@test' })),
        makeMail({ uid: 2, from: 'bob@test' }),
        pin(makeMail({ uid: 3, from: 'carol@test' })),
        makeMail({ uid: 4, from: 'dave@test' }),
      ]
      const { result } = renderHook(() => useMailListView({ mails: sorted, active: null, groupConversations: false, sortMode: 'from' }))
      const uids = result.current.viewMails.map(m => m.uid)
      // After from-sort: alice(1,pinned), bob(2), carol(3,pinned), dave(4)
      // Pinned first: alice(1), carol(3), then bob(2), dave(4)
      expect(uids).toEqual([1, 3, 2, 4])
    })

    it('no reordering when all messages are pinned', () => {
      const allPinned = [
        pin(makeMail({ uid: 2, date: '2026-01-02T00:00:00Z' })),
        pin(makeMail({ uid: 1, date: '2026-01-01T00:00:00Z' })),
      ]
      const { result } = renderHook(() => useMailListView({ mails: allPinned, active: null, groupConversations: false, sortMode: 'date' }))
      expect(result.current.viewMails.map(m => m.uid)).toEqual([2, 1])
    })

    it('no reordering when no messages are pinned', () => {
      const { result } = renderHook(() => useMailListView({ mails, active: null, groupConversations: false, sortMode: 'date' }))
      expect(result.current.viewMails.map(m => m.uid)).toEqual([3, 2, 1])
    })
  })
})
