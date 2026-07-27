import { useMemo, useState, useEffect, useRef } from 'react'
import type { MailSummary } from '../../packages/net/types'
import type { ThreadRow } from '../utils/threading'

type MailKey = string

function mailKey(m: { accountId: number; folder: string; uid: number }): MailKey {
  return `${m.accountId}:${m.folder}:${m.uid}`
}

export type ConversationOrder = 'newest-top' | 'oldest-top'

export interface ThreadCard {
  item: MailSummary
  key: MailKey
  /** Position in the sorted stack (0 = first in render order) */
  index: number
  isLast: boolean
  /**
   * Whether this card is visually expanded.
   * Controlled by expandedSet: a card is expanded iff its key is in the set.
   * Clicking an expanded+active card collapses it (toggleCard); clicking a
   * collapsed card calls onCardOpen to switch active → hook resets expandedSet.
   */
  isExpanded: boolean
}

export interface UseThreadCardsReturn {
  cards: ThreadCard[]
  /** The set of currently expanded card keys */
  expandedKeys: Set<string>
  /** Toggle expansion of a specific card key (used for click-to-collapse active card) */
  toggleCard: (key: string) => void
}

/**
 * Manages the card list for a thread stack-of-cards view.
 *
 * Expansion model (post-3-pack refactor):
 * - Items are sorted by `order` parameter: 'newest-top' (default) or 'oldest-top'.
 * - `expandedSet` is internal state: initially contains `activeKey` (or empty).
 * - When thread.key changes → expandedSet resets to {activeKey} (or empty).
 * - When activeKey changes (same thread) → expandedSet resets to {activeKey}.
 * - `toggleCard(key)` adds/removes a key from expandedSet (used for collapse of active card).
 * - `isExpanded = expandedKeys.has(card.key)` — expandedSet is the single source of truth.
 *
 * Click scenarios handled in ThreadView:
 *   1. Collapsed non-active → onCardOpen(item) → App switches active → expandedSet resets.
 *   2. Collapsed active → toggleCard(key) → re-expands (expandedSet gets key back).
 *   3. Expanded active → toggleCard(key) → collapses (expandedSet becomes empty).
 *   4. Expanded non-active → impossible in single-active model (activeKey change resets).
 */
export function useThreadCards(
  thread: ThreadRow | null,
  activeKey: string | null,
  order: ConversationOrder = 'newest-top',
): UseThreadCardsReturn {
  const sorted = useMemo<MailSummary[]>(() => {
    if (!thread) return []
    const copy = [...thread.items].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    )
    return order === 'newest-top' ? copy.reverse() : copy
  }, [thread, order])

  // Track thread identity so we can reset expandedSet on thread switch
  const threadKeyRef = useRef<string | null>(null)
  // Track previous activeKey so we can reset expandedSet on active switch
  const prevActiveKeyRef = useRef<string | null>(null)

  const [expandedSet, setExpandedSet] = useState<Set<string>>(
    () => new Set(activeKey ? [activeKey] : []),
  )

  // Reset expandedSet when thread changes or activeKey changes
  useEffect(() => {
    const threadKey = thread?.key ?? null
    const threadChanged = threadKeyRef.current !== threadKey
    const activeChanged = prevActiveKeyRef.current !== activeKey

    if (threadChanged || activeChanged) {
      threadKeyRef.current = threadKey
      prevActiveKeyRef.current = activeKey
      setExpandedSet(new Set(activeKey ? [activeKey] : []))
    }
  }, [thread, activeKey])

  const toggleCard = (key: string) => {
    setExpandedSet(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const cards = useMemo<ThreadCard[]>(() => {
    return sorted.map((item, index) => {
      const key = mailKey(item)
      const isLast = index === sorted.length - 1
      const isExpanded = expandedSet.has(key)
      return { item, key, index, isLast, isExpanded }
    })
  }, [sorted, expandedSet])

  return { cards, expandedKeys: expandedSet, toggleCard }
}
