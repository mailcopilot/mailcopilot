import { useMemo, useRef, useState } from 'react'
import type { MailSummary } from '../../packages/net/types'
import { buildThreadRows, type ThreadRow } from '../utils/threading'

type MailKey = string

function mailKey(m: { accountId: number; folder: string; uid: number }): MailKey {
  return `${m.accountId}:${m.folder}:${m.uid}`
}

export type FilterMode = 'all' | 'unread' | 'flagged' | 'attachments'
export type SortMode = 'date' | 'from' | 'subject'

export interface UseMailListViewParams {
  mails: MailSummary[]
  active: MailSummary | null
  groupConversations: boolean
  sortMode: SortMode
}

export interface UseMailListViewReturn {
  filterMode: FilterMode
  setFilterMode: React.Dispatch<React.SetStateAction<FilterMode>>
  selectedKeys: Set<MailKey>
  setSelectedKeys: React.Dispatch<React.SetStateAction<Set<MailKey>>>
  selectionAnchorKey: React.MutableRefObject<MailKey | null>
  viewMails: MailSummary[]
  threadRows: ThreadRow[]
  visibleLeadMails: MailSummary[]
  activeThread: ThreadRow | null
  selectedCount: number
  hasMultiSelection: boolean
  viewMailsRef: React.MutableRefObject<MailSummary[]>
}

export function useMailListView({ mails, active, groupConversations, sortMode }: UseMailListViewParams): UseMailListViewReturn {
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [selectedKeys, setSelectedKeys] = useState<Set<MailKey>>(() => new Set())
  const selectionAnchorKey = useRef<MailKey | null>(null)
  const viewMailsRef = useRef<MailSummary[]>([])

  const viewMails = useMemo(() => {
    let list = mails
    if (filterMode === 'unread') list = list.filter(m => m.unread)
    else if (filterMode === 'flagged') list = list.filter(m => m.flagged)
    else if (filterMode === 'attachments') list = list.filter(m => Boolean(m.hasAttachments))

    let sorted: MailSummary[]
    if (sortMode === 'from') sorted = [...list].sort((a, b) => a.from.localeCompare(b.from))
    else if (sortMode === 'subject') sorted = [...list].sort((a, b) => a.subject.localeCompare(b.subject))
    else sorted = list

    // Pinned messages float to the top, preserving relative order within each group.
    const pinned = sorted.filter(m => m.pinned)
    if (pinned.length > 0 && pinned.length < sorted.length) {
      const unpinned = sorted.filter(m => !m.pinned)
      return [...pinned, ...unpinned]
    }
    return sorted
  }, [filterMode, mails, sortMode])

  const threadRows = useMemo<ThreadRow[]>(
    () => groupConversations ? buildThreadRows(viewMails) : viewMails.map(m => ({ key: mailKey(m), lead: m, items: [m], count: 1 })),
    [groupConversations, viewMails],
  )

  const visibleLeadMails = useMemo(() => threadRows.map(row => row.lead), [threadRows])
  viewMailsRef.current = visibleLeadMails

  const activeThread = useMemo(() => {
    if (!active) return null
    const activeK = mailKey(active)
    for (const row of threadRows) {
      if (row.items.some(item => mailKey(item) === activeK)) return row
    }
    return null
  }, [active, threadRows])

  const selectedCount = selectedKeys.size
  const hasMultiSelection = selectedCount > 1

  return {
    filterMode,
    setFilterMode,
    selectedKeys,
    setSelectedKeys,
    selectionAnchorKey,
    viewMails,
    threadRows,
    visibleLeadMails,
    activeThread,
    selectedCount,
    hasMultiSelection,
    viewMailsRef,
  }
}
