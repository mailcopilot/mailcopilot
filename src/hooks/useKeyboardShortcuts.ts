import { useEffect, useRef } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import type { FolderRoles, MailSummary, MessageDetails } from '../../packages/net/types'
import { firstSelectedRow, leadKeyOfRowContaining, rowContaining, toggleRowSelection, type ThreadRow } from '../utils/threading'
import type { ContextMenuState } from '../components/ContextMenu'
import type { UndoInfo } from './useUndoSystem'

type MailKey = string

function mailKey(m: { accountId: number; folder: string; uid: number }): MailKey {
  return `${m.accountId}:${m.folder}:${m.uid}`
}

export interface UseKeyboardShortcutsParams {
  // State
  active: MailSummary | null
  activeThread: ThreadRow | null
  hasAccount: boolean
  hasMultiSelection: boolean
  hotkeysPreset: 'gmail' | 'outlook'
  selectedKeys: Set<MailKey>
  showCommandPalette: boolean
  sidebarWidth: number
  currentAccountId: number | null
  undoInfoRef: React.MutableRefObject<UndoInfo | null>
  qRef: React.MutableRefObject<string>
  viewMailsRef: React.MutableRefObject<MailSummary[]>
  /** Rows behind `viewMailsRef`. Selection is a ROW property, so keyboard actions
   *  resolve "the message the user means" from the rows, not the lead list. */
  threadRowsRef: React.MutableRefObject<ThreadRow[]>
  selectionAnchorKey: React.MutableRefObject<MailKey | null>
  rolesByAccount: React.MutableRefObject<Map<number, FolderRoles>>
  virtuosoRef: React.RefObject<VirtuosoHandle | null>
  onSearchRef: React.MutableRefObject<(q: string) => Promise<void>>

  // Callbacks
  openMail: (mail: MailSummary) => void
  replyMail: (mail: MailSummary, mode: 'reply' | 'replyAll' | 'forward') => void
  archiveMail: () => void
  deleteMail: () => void
  spamMail: () => void
  bulkArchive: () => void
  bulkDelete: () => void
  bulkSpam: () => void
  handleUndo: () => void
  setSeenForMail: (mail: MailSummary, seen: boolean) => void
  setSeenForMany: (seen: boolean) => void
  setFlaggedForMail: (mail: MailSummary, flagged: boolean) => void
  togglePin: (mail: MailSummary) => void
  focusSearchInput: () => void
  switchFolder: (folder: string) => void
  toggleAiPanel: () => void
  summarizeWithAi: () => void

  // Setters
  setShowCommandPalette: (v: boolean) => void
  setCommandQuery: (v: string) => void
  setActive: (m: MailSummary | null) => void
  setDetails: (d: MessageDetails | null) => void
  setSelectedKeys: React.Dispatch<React.SetStateAction<Set<MailKey>>>
  setFilterMode: (mode: 'all' | 'unread' | 'flagged' | 'attachments') => void
  setShowShortcuts: React.Dispatch<React.SetStateAction<boolean>>
  setQ: (q: string) => void
  setCtxMenu: (state: ContextMenuState | null) => void
  searchDebounceRef: React.MutableRefObject<number | null>
}

/** Extracts the physical key letter from event.code (KeyC -> 'c', KeyA -> 'a').
 *  Allows shortcuts to work regardless of keyboard layout. */
function physicalKeyLetter(code: string): string {
  if (code.length === 4 && code.startsWith('Key')) return code.charAt(3).toLowerCase()
  return ''
}

/** Hook that registers a global keydown handler for keyboard shortcuts */
export function useKeyboardShortcuts(params: UseKeyboardShortcutsParams): void {
  const {
    active, activeThread, hasAccount, hasMultiSelection,
    hotkeysPreset, selectedKeys, showCommandPalette,
    sidebarWidth, currentAccountId,
    undoInfoRef, qRef, viewMailsRef, threadRowsRef, selectionAnchorKey,
    rolesByAccount, virtuosoRef, onSearchRef,
    openMail, replyMail, archiveMail, deleteMail, spamMail,
    bulkArchive, bulkDelete, bulkSpam, handleUndo,
    setSeenForMail, setSeenForMany, setFlaggedForMail, togglePin,
    focusSearchInput, switchFolder, toggleAiPanel, summarizeWithAi,
    setShowCommandPalette, setCommandQuery, setActive, setDetails,
    setSelectedKeys, setFilterMode, setShowShortcuts, setQ, setCtxMenu,
    searchDebounceRef,
  } = params

  const pendingGoRef = useRef(false)
  const pendingGoTimer = useRef<number | null>(null)

  useEffect(() => {
    const isTypingTarget = (tgt: EventTarget | null): boolean => {
      const el = tgt as HTMLElement | null
      if (!el) return false
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true
      return Boolean((el as unknown as { isContentEditable?: boolean }).isContentEditable)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const key = e.key
      // Physical key (by position on QWERTY) — shortcuts work in any keyboard layout.
      const lower = physicalKeyLetter(e.code) || (key.length === 1 ? key.toLowerCase() : key)
      const mod = e.ctrlKey || e.metaKey

      if (mod && !e.altKey && lower === 'k') {
        e.preventDefault()
        setShowCommandPalette(true)
        setCommandQuery('')
        return
      }

      // Ctrl+Shift+A — toggle AI panel
      if (mod && e.shiftKey && lower === 'a') {
        e.preventDefault()
        toggleAiPanel()
        return
      }

      // Ctrl+Shift+S — quick AI summarization of current context
      if (mod && e.shiftKey && lower === 's') {
        e.preventDefault()
        summarizeWithAi()
        return
      }

      // Ctrl+A — select all visible messages
      if (mod && !e.shiftKey && !e.altKey && lower === 'a') {
        if (isTypingTarget(e.target)) return
        const list = viewMailsRef.current
        if (list.length === 0) return
        e.preventDefault()
        setSelectedKeys(new Set(list.map(m => mailKey(m))))
        selectionAnchorKey.current = mailKey(list[0])
        return
      }

      if (showCommandPalette) {
        if (key === 'Escape') {
          e.preventDefault()
          setShowCommandPalette(false)
        }
        return
      }

      if (isTypingTarget(e.target)) return

      // Ctrl-based shortcuts (Gmail/Outlook presets)
      if (mod && !e.altKey) {
        if (hotkeysPreset === 'gmail') {
          if (lower === 'n' && !e.shiftKey) {
            if (!hasAccount) return
            e.preventDefault()
            void window.api.invoke('ui:openCompose')
            return
          }
          if (lower === 'r') {
            if (!active) return
            e.preventDefault()
            void replyMail(active, e.shiftKey ? 'replyAll' : 'reply')
            return
          }
          if (lower === 'f') {
            e.preventDefault()
            if (e.shiftKey) {
              if (!active) return
              void replyMail(active, 'forward')
            } else {
              focusSearchInput()
            }
            return
          }
        } else {
          // outlook
          if (lower === 'n' && !e.shiftKey) {
            if (!hasAccount) return
            e.preventDefault()
            void window.api.invoke('ui:openCompose')
            return
          }
          if (lower === 'r') {
            if (!active) return
            e.preventDefault()
            void replyMail(active, e.shiftKey ? 'replyAll' : 'reply')
            return
          }
          if (lower === 'f' && !e.shiftKey) {
            if (!active) return
            e.preventDefault()
            void replyMail(active, 'forward')
            return
          }
          if (lower === 'e' && !e.shiftKey) {
            e.preventDefault()
            focusSearchInput()
            return
          }
        }

        // Ctrl+P is handled in main process via before-input-event
        // (Chromium intercepts it before JS keydown reaches the renderer).

        // Do not intercept standard Ctrl/Cmd combinations (copy, paste, etc.)
        return
      }

      // Two-key navigation: g -> i/s/d/*
      if (pendingGoRef.current) {
        pendingGoRef.current = false
        if (pendingGoTimer.current) { window.clearTimeout(pendingGoTimer.current); pendingGoTimer.current = null }
        if (lower === 'i') { e.preventDefault(); switchFolder('INBOX'); return }
        const r = rolesByAccount.current.get(currentAccountId ?? -1) ?? {}
        if (lower === 's' && r.sent) { e.preventDefault(); switchFolder(r.sent); return }
        if (lower === 'd' && r.drafts) { e.preventDefault(); switchFolder(r.drafts); return }
        if (key === '*') { e.preventDefault(); setFilterMode('flagged'); return }
        return
      }

      if (lower === 'g') {
        e.preventDefault()
        if (pendingGoTimer.current) window.clearTimeout(pendingGoTimer.current)
        pendingGoRef.current = true
        pendingGoTimer.current = window.setTimeout(() => { pendingGoRef.current = false }, 1500)
        return
      }

      if (key === '?') {
        e.preventDefault()
        setShowShortcuts(prev => !prev)
        return
      }

      if (key === '/') {
        e.preventDefault()
        focusSearchInput()
        return
      }

      if (key === 'Escape') {
        if (hasMultiSelection) {
          const k = active ? mailKey(active) : null
          setSelectedKeys(k ? new Set([k]) : new Set())
          selectionAnchorKey.current = k
          return
        }
        // Esc also clears the search string (useful for from: filter triggered by avatar click).
        if (qRef.current) {
          e.preventDefault()
          if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current)
          setQ('')
          // onSearchRef will be called after re-render with q=''
          searchDebounceRef.current = window.setTimeout(() => { void onSearchRef.current('') }, 0)
        }
        return
      }

      if (key === 'Enter' || lower === 'o') {
        const list = viewMailsRef.current
        if (list.length === 0) return
        e.preventDefault()
        if (active) { void openMail(active); return }
        // No active message but a selection: resolve the selected ROW. Routine —
        // `u` closes the viewer without touching the selection, and what it holds
        // after opening a thread is a mid-thread key, absent from the lead list.
        const picked = firstSelectedRow(threadRowsRef.current, selectedKeys)?.lead ?? list[0]!
        void openMail(picked)
        return
      }

      if (lower === 'j' || lower === 'k' || key === 'ArrowDown' || key === 'ArrowUp') {
        const list = viewMailsRef.current
        if (list.length === 0) return
        const isDown = lower === 'j' || key === 'ArrowDown'
        const activeKey = active ? mailKey(active) : null
        let idx = activeKey ? list.findIndex(m => mailKey(m) === activeKey) : -1
        // If active mail is not the thread lead (selected from thread strip), navigate from the thread row in the list.
        if (idx < 0 && activeThread) idx = list.findIndex(m => mailKey(m) === mailKey(activeThread.lead))
        if (idx < 0) idx = 0
        const next = isDown
          ? Math.min(list.length - 1, idx + 1)
          : Math.max(0, idx - 1)
        if (next === idx) return
        e.preventDefault()
        if (e.shiftKey) {
          // Range selection: anchor is the start, cursor moves with arrow keys.
          if (!selectionAnchorKey.current) {
            selectionAnchorKey.current = activeKey || mailKey(list[next])
          }
          const anchor = selectionAnchorKey.current
          let anchorIdx = list.findIndex(m => mailKey(m) === anchor)
          if (anchorIdx < 0) {
            // Same lazy mapping as the Shift-CLICK path: the anchor is whatever
            // was last selected, routinely a mid-thread message the lead-only
            // `list` does not contain. Without this the range collapsed to the
            // single destination row.
            const anchorLead = leadKeyOfRowContaining(threadRowsRef.current, anchor)
            if (anchorLead !== null) anchorIdx = list.findIndex(m => mailKey(m) === anchorLead)
          }
          const start = Math.min(anchorIdx < 0 ? next : anchorIdx, next)
          const end = Math.max(anchorIdx < 0 ? next : anchorIdx, next)
          setSelectedKeys(new Set(list.slice(start, end + 1).map(m => mailKey(m))))
          setActive(list[next])
        } else {
          void openMail(list[next])
        }
        virtuosoRef.current?.scrollToIndex({ index: next, align: 'center' })
        return
      }

      // Shift+U / Shift+I: read/unread
      if (e.shiftKey && (lower === 'u' || lower === 'i')) {
        if (!active && !hasMultiSelection) return
        e.preventDefault()
        const seen = lower === 'i'
        if (hasMultiSelection) void setSeenForMany(seen)
        else if (active) void setSeenForMail(active, seen)
        return
      }

      // u: back to list (close viewer)
      if (lower === 'u' && !e.shiftKey) {
        if (!active) return
        e.preventDefault()
        setActive(null)
        setDetails(null)
        return
      }

      if (lower === 'c') {
        if (!hasAccount) return
        e.preventDefault()
        void window.api.invoke('ui:openCompose')
        return
      }

      if (lower === 'r') {
        if (!active) return
        e.preventDefault()
        void replyMail(active, 'reply')
        return
      }

      if (lower === 'a') {
        if (!active) return
        e.preventDefault()
        void replyMail(active, 'replyAll')
        return
      }

      if (lower === 'f') {
        if (!active) return
        e.preventDefault()
        void replyMail(active, 'forward')
        return
      }

      if (lower === 's') {
        if (!active) return
        e.preventDefault()
        void setFlaggedForMail(active, !active.flagged)
        return
      }

      if (lower === 'p') {
        if (!active) return
        e.preventDefault()
        void togglePin(active)
        return
      }

      if (lower === 'e') {
        if (!active && !hasMultiSelection) return
        e.preventDefault()
        if (hasMultiSelection) void bulkArchive()
        else void archiveMail()
        return
      }

      if (lower === 'x') {
        const rows = threadRowsRef.current
        // Same rule as Ctrl-click, end to end: `x` toggles the ROW, resolved from
        // the rows themselves. Wrapping the target in a single-message row added
        // its lead key next to a mid-thread key already in the set.
        const row = active
          ? (activeThread ?? rowContaining(rows, active))
          : (firstSelectedRow(rows, selectedKeys) ?? rows[0])
        if (!row) return
        e.preventDefault()
        const next = toggleRowSelection(row, selectedKeys)
        setSelectedKeys(next.keys)
        // Unconditional, exactly like the mouse path: a stale anchor left on a
        // deselected row makes the next Shift-click draw its range from it.
        selectionAnchorKey.current = next.anchorKey
        return
      }

      if (key === '!') {
        if (!active && !hasMultiSelection) return
        e.preventDefault()
        if (hasMultiSelection) void bulkSpam()
        else void spamMail()
        return
      }

      if (lower === 'z') {
        if (!undoInfoRef.current) return
        e.preventDefault()
        handleUndo()
        return
      }

      if (lower === 'v') {
        const rows = threadRowsRef.current
        // Which ROW the user means — scanning the lead list for a key of the set
        // missed a mid-thread selection and offered to move the first row instead.
        const row = active
          ? (activeThread ?? rowContaining(rows, active))
          : (firstSelectedRow(rows, selectedKeys) ?? rows[0])
        if (!row) return
        const target = active ?? row.lead
        e.preventDefault()
        // Selection collapses to this row, keyed on its lead like every other
        // row-level action; the menu still acts on the message in hand.
        const k = mailKey(row.lead)
        setSelectedKeys(new Set([k]))
        selectionAnchorKey.current = k
        // Open the context menu directly in folder selection mode.
        setCtxMenu({ x: Math.max(8, sidebarWidth + 20), y: 120, mail: target, moveOpen: true })
        return
      }

      if (lower === '#') {
        if (!active && !hasMultiSelection) return
        e.preventDefault()
        if (hasMultiSelection) void bulkDelete()
        else void deleteMail()
        return
      }

      if (key === 'Delete' || key === 'Backspace') {
        if (!active && !hasMultiSelection) return
        e.preventDefault()
        if (hasMultiSelection) void bulkDelete()
        else void deleteMail()
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (pendingGoTimer.current) window.clearTimeout(pendingGoTimer.current)
      if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current)
    }
  }, [
    active,
    activeThread,
    archiveMail,
    bulkArchive,
    bulkDelete,
    bulkSpam,
    currentAccountId,
    deleteMail,
    focusSearchInput,
    hasAccount,
    hasMultiSelection,
    handleUndo,
    hotkeysPreset,
    openMail,
    replyMail,
    selectedKeys,
    setFlaggedForMail,
    togglePin,
    setSeenForMail,
    setSeenForMany,
    showCommandPalette,
    sidebarWidth,
    spamMail,
    switchFolder,
    toggleAiPanel,
    summarizeWithAi,
    setShowCommandPalette,
    setCommandQuery,
    setActive,
    setDetails,
    setSelectedKeys,
    setFilterMode,
    setShowShortcuts,
    setQ,
    setCtxMenu,
    qRef,
    viewMailsRef,
    threadRowsRef,
    selectionAnchorKey,
    rolesByAccount,
    searchDebounceRef,
    virtuosoRef,
    onSearchRef,
    undoInfoRef,
  ])
}
