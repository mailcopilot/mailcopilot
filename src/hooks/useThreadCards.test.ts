// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useThreadCards } from './useThreadCards'
import type { ThreadRow } from '../utils/threading'
import type { MailSummary } from '../../packages/net/types'

function makeMail(uid: number, date: string): MailSummary {
  return {
    accountId: 1,
    folder: 'INBOX',
    uid,
    from: `Sender ${uid}`,
    fromAddr: `sender${uid}@example.com`,
    subject: `Subject ${uid}`,
    date,
    unread: false,
    flagged: false,
  }
}

function makeThread(items: MailSummary[]): ThreadRow {
  const lead = items[0]
  const key = `${lead.accountId}:${lead.folder}:${lead.uid}`
  return { key, lead, items, count: items.length }
}

describe('useThreadCards', () => {
  // ---------------------------------------------------------------------------
  // Null / empty thread
  // ---------------------------------------------------------------------------

  it('returns empty cards for null thread', () => {
    const { result } = renderHook(() => useThreadCards(null, null))
    expect(result.current.cards).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // Single-item thread
  // ---------------------------------------------------------------------------

  it('single-item thread: one card, expanded when it is active', () => {
    const mail = makeMail(1, '2024-01-01T10:00:00Z')
    const thread = makeThread([mail])
    const { result } = renderHook(() => useThreadCards(thread, '1:INBOX:1'))

    expect(result.current.cards).toHaveLength(1)
    expect(result.current.cards[0].isExpanded).toBe(true)
    expect(result.current.cards[0].isLast).toBe(true)
    expect(result.current.cards[0].index).toBe(0)
  })

  it('single-item thread: card is collapsed when activeKey is null', () => {
    const mail = makeMail(1, '2024-01-01T10:00:00Z')
    const thread = makeThread([mail])
    const { result } = renderHook(() => useThreadCards(thread, null))

    expect(result.current.cards[0].isExpanded).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Multi-item thread — expandedSet model: expanded === has key in set
  // ---------------------------------------------------------------------------

  it('only the active card is expanded by default; all others are collapsed', () => {
    const mails = [
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
      makeMail(3, '2024-01-03T10:00:00Z'),
    ]
    const thread = makeThread(mails)
    // Active is uid=2 (middle by date). With newest-top order: [uid=3, uid=2, uid=1]
    const { result } = renderHook(() => useThreadCards(thread, '1:INBOX:2'))

    const cards = result.current.cards
    expect(cards).toHaveLength(3)
    // newest-top: cards[0]=uid3, cards[1]=uid2 (active), cards[2]=uid1
    expect(cards[0].isExpanded).toBe(false) // uid=3
    expect(cards[1].isExpanded).toBe(true)  // uid=2 — active
    expect(cards[2].isExpanded).toBe(false) // uid=1
  })

  it('all cards are collapsed when activeKey matches no card', () => {
    const mails = [
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
    ]
    const thread = makeThread(mails)
    const { result } = renderHook(() => useThreadCards(thread, '1:INBOX:99'))

    expect(result.current.cards[0].isExpanded).toBe(false)
    expect(result.current.cards[1].isExpanded).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Sorting — AC1: newest top (default)
  // ---------------------------------------------------------------------------

  it('AC1: default order newest-top — cards[0].date >= cards[1].date', () => {
    const mails = [
      makeMail(3, '2024-01-03T10:00:00Z'),
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
    ]
    const thread = makeThread(mails)
    const { result } = renderHook(() => useThreadCards(thread, null))

    const cards = result.current.cards
    expect(cards[0].item.uid).toBe(3) // newest
    expect(cards[1].item.uid).toBe(2)
    expect(cards[2].item.uid).toBe(1) // oldest
    // Assert date descending
    expect(new Date(cards[0].item.date).getTime()).toBeGreaterThanOrEqual(
      new Date(cards[1].item.date).getTime(),
    )
  })

  it('AC1: newest-top — active card (newest) is cards[0]', () => {
    const mails = [
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
      makeMail(3, '2024-01-03T10:00:00Z'),
    ]
    const thread = makeThread(mails)
    // Active = newest = uid=3
    const { result } = renderHook(() => useThreadCards(thread, '1:INBOX:3'))

    const cards = result.current.cards
    expect(cards[0].item.uid).toBe(3)
    expect(cards[0].isExpanded).toBe(true)
    expect(cards[0].isLast).toBe(false) // cards[0] is first, not last
    // Last card (oldest) should be collapsed
    expect(cards[cards.length - 1].item.uid).toBe(1)
    expect(cards[cards.length - 1].isExpanded).toBe(false)
  })

  it('AC3: oldest-top order — cards[0] is oldest, cards[n-1] is newest', () => {
    const mails = [
      makeMail(3, '2024-01-03T10:00:00Z'),
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
    ]
    const thread = makeThread(mails)
    const { result } = renderHook(() => useThreadCards(thread, null, 'oldest-top'))

    const cards = result.current.cards
    expect(cards[0].item.uid).toBe(1) // oldest
    expect(cards[1].item.uid).toBe(2)
    expect(cards[2].item.uid).toBe(3) // newest
    expect(new Date(cards[0].item.date).getTime()).toBeLessThanOrEqual(
      new Date(cards[1].item.date).getTime(),
    )
  })

  // ---------------------------------------------------------------------------
  // AC2: toggleCard — click-to-collapse active card
  // ---------------------------------------------------------------------------

  it('AC2: toggleCard collapses an expanded card', () => {
    const mails = [
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
    ]
    const thread = makeThread(mails)
    const { result } = renderHook(() => useThreadCards(thread, '1:INBOX:2'))

    // uid=2 is active → expanded initially (newest-top: cards[0]=uid2)
    expect(result.current.cards[0].isExpanded).toBe(true)
    expect(result.current.cards[0].item.uid).toBe(2)

    // Toggle: expanded active card → collapses
    act(() => {
      result.current.toggleCard('1:INBOX:2')
    })

    expect(result.current.cards[0].isExpanded).toBe(false)
    // expandedKeys should be empty
    expect(result.current.expandedKeys.size).toBe(0)
  })

  it('AC2: toggleCard re-expands a collapsed active card', () => {
    const mails = [
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
    ]
    const thread = makeThread(mails)
    const { result } = renderHook(() => useThreadCards(thread, '1:INBOX:2'))

    // First: collapse it
    act(() => {
      result.current.toggleCard('1:INBOX:2')
    })
    expect(result.current.cards[0].isExpanded).toBe(false)

    // Then: re-expand it
    act(() => {
      result.current.toggleCard('1:INBOX:2')
    })
    expect(result.current.cards[0].isExpanded).toBe(true)
  })

  it('AC2: expandedKeys reflects current expanded state', () => {
    const mails = [
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
    ]
    const thread = makeThread(mails)
    const { result } = renderHook(() => useThreadCards(thread, '1:INBOX:2'))

    // Initially: expandedKeys = {activeKey}
    expect(result.current.expandedKeys.has('1:INBOX:2')).toBe(true)
    expect(result.current.expandedKeys.has('1:INBOX:1')).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Switching active (simulates App.tsx calling openMail on a different card)
  // ---------------------------------------------------------------------------

  it('switching activeKey resets expandedSet to new activeKey', () => {
    const mails = [
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
    ]
    const thread = makeThread(mails)

    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => useThreadCards(thread, key),
      { initialProps: { key: '1:INBOX:2' as string | null } },
    )

    // newest-top: cards[0]=uid2 (active), cards[1]=uid1
    expect(result.current.cards[0].isExpanded).toBe(true)
    expect(result.current.cards[0].item.uid).toBe(2)

    // Switch active to uid=1 (oldest → cards[1] in newest-top order)
    rerender({ key: '1:INBOX:1' })

    expect(result.current.cards[0].isExpanded).toBe(false) // uid=2 now collapsed
    expect(result.current.cards[1].isExpanded).toBe(true)  // uid=1 now expanded
    expect(result.current.expandedKeys.has('1:INBOX:1')).toBe(true)
    expect(result.current.expandedKeys.has('1:INBOX:2')).toBe(false)
  })

  it('switching activeKey resets expandedSet even if toggleCard was used before switch', () => {
    const mails = [
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
    ]
    const thread = makeThread(mails)

    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => useThreadCards(thread, key),
      { initialProps: { key: '1:INBOX:2' as string | null } },
    )

    // Collapse the active card via toggle
    act(() => {
      result.current.toggleCard('1:INBOX:2')
    })
    expect(result.current.expandedKeys.size).toBe(0)

    // Now switch active — expandedSet must reset to new activeKey
    rerender({ key: '1:INBOX:1' })

    expect(result.current.expandedKeys.has('1:INBOX:1')).toBe(true)
    expect(result.current.expandedKeys.size).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // Thread identity change
  // ---------------------------------------------------------------------------

  it('switching to a different thread resets card list and expandedSet', () => {
    const mails1 = [
      makeMail(1, '2024-01-01T10:00:00Z'),
      makeMail(2, '2024-01-02T10:00:00Z'),
    ]
    const thread1 = makeThread(mails1)

    const mails2 = [
      makeMail(10, '2024-02-01T10:00:00Z'),
      makeMail(11, '2024-02-02T10:00:00Z'),
    ]
    const thread2 = makeThread(mails2)

    const { result, rerender } = renderHook(
      ({ thread, key }: { thread: ThreadRow; key: string | null }) =>
        useThreadCards(thread, key),
      { initialProps: { thread: thread1, key: '1:INBOX:2' as string | null } },
    )

    expect(result.current.cards).toHaveLength(2)
    expect(result.current.expandedKeys.has('1:INBOX:2')).toBe(true)

    // Switch to thread2 with new activeKey
    rerender({ thread: thread2, key: '1:INBOX:11' })

    const cards = result.current.cards
    expect(cards).toHaveLength(2)
    // newest-top: cards[0]=uid11, cards[1]=uid10
    expect(cards[0].item.uid).toBe(11)
    expect(cards[0].isExpanded).toBe(true)
    expect(cards[1].item.uid).toBe(10)
    expect(cards[1].isExpanded).toBe(false)
    expect(result.current.expandedKeys.has('1:INBOX:11')).toBe(true)
    expect(result.current.expandedKeys.has('1:INBOX:2')).toBe(false)
  })
})
