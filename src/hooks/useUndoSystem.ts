import { useCallback, useEffect, useRef, useState } from 'react'
import type { MailSummary } from '../../packages/net/types'

export type UndoInfo = {
  accountId: number
  label: string
  messages: MailSummary[]
  folder: string
  targetFolder: string
  unreadDelta: number
}

export type SendUndoInfo = {
  id: string
  accountId: number
  sendAt: string
}

export interface UseUndoSystemParams {
  currentFolder: string
  currentAccountIdRef: React.RefObject<number | null>
  removeManyFromUi: (msgs: MailSummary[]) => void
  bumpFolderUnreadPending: (accountId: number, folder: string, delta: number) => void
  clearPendingUnread: (accountId: number, folder: string, uid: number) => void
  setMails: React.Dispatch<React.SetStateAction<MailSummary[]>>
  setError: (msg: string) => void
  loadOutbox: (accountId: number) => Promise<void>
  t: (key: string, opts?: Record<string, unknown>) => string
  /**
   * §2.7 iter2: external ref owned by the caller (App.tsx) so list-fetch
   * call sites — many of which run earlier in the component tree than this
   * hook is declared — can read the current epoch synchronously without a
   * forward-ref dance. The hook bumps the counter on every transition that
   * affects the pending-move suppression set (`moveWithUndo`, `flushUndo`,
   * `handleUndo`, 5s auto-fire). See UseUndoSystemReturn.getPendingMoveEpoch
   * for the race scenario this guards against.
   */
  pendingMoveEpochRef: React.MutableRefObject<number>
}

export interface UseUndoSystemReturn {
  undoInfo: UndoInfo | null
  undoCountdown: number
  sendUndoInfo: SendUndoInfo | null
  sendUndoCountdown: number
  undoInfoRef: React.RefObject<UndoInfo | null>
  flushUndo: () => void
  moveWithUndo: (accountId: number, msgs: MailSummary[], fromFolder: string, toFolder: string, label: string) => void
  handleUndo: () => void
  handleSendUndo: () => Promise<void>
  clearSendUndo: () => void
  setSendUndoInfo: (info: SendUndoInfo | null) => void
  scheduleSendUndo: (info: SendUndoInfo) => void
  /**
   * §2.7 iter2: monotonic counter that increments on every transition that
   * changes the pending-move suppression set (`moveWithUndo` / `flushUndo` /
   * `handleUndo` / 5s timer fire). Renderer call sites that fetch list data
   * over IPC must capture this value BEFORE the await and re-check AFTER —
   * if it changed, the in-flight response was filtered against a now-stale
   * pending registry on the main side and must be discarded.
   *
   * Without this guard, an in-flight fetch can race with `handleUndo`:
   * 1. moveWithUndo(uid=5) → main filters uid=5 out of any in-flight result.
   * 2. fetch starts (uid=5 already filtered).
   * 3. handleUndo → pendingRemove(uid=5).
   * 4. fetch resolves with uid=5 absent → setMails(list-without-uid=5)
   *    overwrites the just-restored message.
   *
   * The inverse race (move issued while a fetch was already in flight before
   * the filter was applied) is symmetric and equally toxic.
   */
  getPendingMoveEpoch: () => number
}

export function useUndoSystem({
  currentFolder,
  currentAccountIdRef,
  removeManyFromUi,
  bumpFolderUnreadPending,
  clearPendingUnread,
  setMails,
  setError,
  loadOutbox,
  t,
  pendingMoveEpochRef,
}: UseUndoSystemParams): UseUndoSystemReturn {
  const [undoInfo, setUndoInfo] = useState<UndoInfo | null>(null)
  const undoInfoRef = useRef<UndoInfo | null>(null)
  const undoTimerRef = useRef<number | null>(null)
  const [undoCountdown, setUndoCountdown] = useState(0)

  // §2.7 iter2: stable getter for callers that only need to read the current
  // epoch (e.g. tests). The actual ref is owned by the caller — see
  // UseUndoSystemParams.pendingMoveEpochRef.
  const getPendingMoveEpoch = useCallback(() => pendingMoveEpochRef.current, [pendingMoveEpochRef])

  const [sendUndoInfo, setSendUndoInfo] = useState<SendUndoInfo | null>(null)
  const sendUndoInfoRef = useRef<SendUndoInfo | null>(null)
  const sendUndoTimerRef = useRef<number | null>(null)
  const [sendUndoCountdown, setSendUndoCountdown] = useState(0)

  // Sync ref with state for sendUndoInfo
  const setSendUndoInfoWrapper = useCallback((info: SendUndoInfo | null) => {
    sendUndoInfoRef.current = info
    setSendUndoInfo(info)
  }, [])

  const clearSendUndo = useCallback(() => {
    if (sendUndoTimerRef.current) {
      window.clearTimeout(sendUndoTimerRef.current)
      sendUndoTimerRef.current = null
    }
    sendUndoInfoRef.current = null
    setSendUndoInfo(null)
  }, [])

  /** Schedule send-undo with an automatic cleanup timer */
  const scheduleSendUndo = useCallback((info: SendUndoInfo) => {
    clearSendUndo()
    sendUndoInfoRef.current = info
    setSendUndoInfo(info)

    const sendAtMs = new Date(info.sendAt).getTime()
    if (Number.isFinite(sendAtMs)) {
      sendUndoTimerRef.current = window.setTimeout(() => {
        if (sendUndoInfoRef.current?.id !== info.id) return
        clearSendUndo()
      }, Math.max(0, sendAtMs - Date.now()) + 150)
    }
  }, [clearSendUndo])

  const flushUndo = useCallback(() => {
    const info = undoInfoRef.current
    if (!info) return
    if (undoTimerRef.current) { window.clearTimeout(undoTimerRef.current); undoTimerRef.current = null }
    undoInfoRef.current = null
    setUndoInfo(null)
    // §2.7 iter2: pending-move state is about to change (suppression released
    // once net:move settles). Bump epoch so any in-flight list fetch is
    // discarded by the renderer, even though the actual `pendingRemove`
    // happens asynchronously in `.finally` below.
    pendingMoveEpochRef.current++
    const uids = info.messages.map(m => m.uid)
    // §2.7: drop pending-move suppression once the server move is settled.
    // Either way (success or failure) the UIDs in the source folder are no
    // longer "about to disappear" — keeping suppression after `net:move`
    // would just add 10s of latency for no benefit.
    void window.api.invoke('net:move', info.accountId, info.folder, info.targetFolder, uids)
      .catch(() => {})
      .finally(() => {
        void window.api.invoke('net:move:pendingRemove', info.accountId, info.folder, uids).catch(() => {})
      })
    for (const m of info.messages) clearPendingUnread(info.accountId, info.folder, m.uid)
  }, [clearPendingUnread, pendingMoveEpochRef])

  const moveWithUndo = useCallback((accountId: number, msgs: MailSummary[], fromFolder: string, toFolder: string, label: string) => {
    // First flush the previous pending undo (if any)
    flushUndo()

    const uids = msgs.map(m => m.uid)
    const unreadDelta = msgs.filter(m => m.unread).length

    removeManyFromUi(msgs)
    // §2.7 iter2: pending-move set is changing — bump epoch so any in-flight
    // list fetch issued before this call gets discarded by the renderer
    // (it was filtered against the old, smaller pending registry).
    pendingMoveEpochRef.current++
    // §2.7: suppress these UIDs server-side so any concurrent
    // `net:inboxSummaries` / `cache:inboxPage` fetch during the 5s undo
    // window does NOT resurrect the message into the list before the
    // deferred IMAP MOVE actually fires. Auto-expires after 10s in main if
    // the renderer crashes between here and the cleanup paths below.
    void window.api.invoke('net:move:pendingAdd', accountId, fromFolder, uids).catch(() => {})

    if (unreadDelta) {
      bumpFolderUnreadPending(accountId, fromFolder, -unreadDelta)
      bumpFolderUnreadPending(accountId, toFolder, +unreadDelta)
    }

    const info: UndoInfo = { accountId, label, messages: msgs, folder: fromFolder, targetFolder: toFolder, unreadDelta }
    undoInfoRef.current = info
    setUndoInfo(info)

    undoTimerRef.current = window.setTimeout(() => {
      undoTimerRef.current = null
      undoInfoRef.current = null
      setUndoInfo(null)
      // §2.7 iter2: 5s window elapsed — pending-move set is about to shrink
      // when the .finally below calls pendingRemove. Bump epoch now so any
      // fetch in flight against the larger pending set is discarded.
      pendingMoveEpochRef.current++
      void window.api.invoke('net:move', accountId, fromFolder, toFolder, uids)
        .catch(e => { setError(t('app.errors.move', { error: String(e) })) })
        .finally(() => {
          // §2.7: server move settled — drop suppression.
          void window.api.invoke('net:move:pendingRemove', accountId, fromFolder, uids).catch(() => {})
        })
      for (const uid of uids) clearPendingUnread(accountId, fromFolder, uid)
    }, 5000)
  }, [bumpFolderUnreadPending, clearPendingUnread, flushUndo, pendingMoveEpochRef, removeManyFromUi, setError, t])

  const handleUndo = useCallback(() => {
    const info = undoInfoRef.current
    if (!info) return
    if (undoTimerRef.current) { window.clearTimeout(undoTimerRef.current); undoTimerRef.current = null }
    undoInfoRef.current = null
    setUndoInfo(null)

    // §2.7 iter2: pending-move set is shrinking — bump epoch so any in-flight
    // list fetch (which was filtered with the larger pending set, i.e. the
    // restored UIDs are missing from its result) is discarded by the
    // renderer. Without this guard the stale response can overwrite the
    // just-restored row and the message vanishes from the list.
    pendingMoveEpochRef.current++

    // §2.7: user canceled the move — drop suppression immediately so the
    // next fetch can see the UIDs again (and so any in-flight fetch does
    // not leave them filtered).
    const undoUids = info.messages.map(m => m.uid)
    void window.api.invoke('net:move:pendingRemove', info.accountId, info.folder, undoUids).catch(() => {})

    // Restore messages in UI
    setMails(prev => {
      const restored = [...prev, ...info.messages]
      restored.sort((a, b) => b.uid - a.uid)
      return restored
    })
    // Reverse the unread counter adjustments
    if (info.unreadDelta) {
      bumpFolderUnreadPending(info.accountId, info.folder, +info.unreadDelta)
      bumpFolderUnreadPending(info.accountId, info.targetFolder, -info.unreadDelta)
    }
  }, [bumpFolderUnreadPending, pendingMoveEpochRef, setMails])

  const handleSendUndo = useCallback(async () => {
    const info = sendUndoInfoRef.current
    if (!info) return
    clearSendUndo()
    try {
      const canceled = await window.api.invoke('mail:cancelSend', info.id) as { accountId?: unknown; messageData?: unknown }
      const accountId = (canceled && typeof canceled.accountId === 'number') ? canceled.accountId : info.accountId
      if (accountId === currentAccountIdRef.current) {
        await loadOutbox(accountId)
      }
      const messageData = (canceled && typeof canceled.messageData === 'object') ? canceled.messageData : null
      await window.api.invoke('ui:openCompose', accountId, messageData)
    } catch (e) {
      setError(t('app.errors.queue', { error: String(e) }))
    }
  }, [clearSendUndo, currentAccountIdRef, loadOutbox, setError, t])

  // Countdown for the undo bar.
  useEffect(() => {
    if (!undoInfo) { setUndoCountdown(0); return }
    setUndoCountdown(5)
    const interval = window.setInterval(() => {
      setUndoCountdown(prev => {
        if (prev <= 1) { clearInterval(interval); return 0 }
        return prev - 1
      })
    }, 1000)
    return () => window.clearInterval(interval)
  }, [undoInfo])

  useEffect(() => {
    if (!sendUndoInfo) {
      setSendUndoCountdown(0)
      return
    }
    const sendAtMs = new Date(sendUndoInfo.sendAt).getTime()
    if (!Number.isFinite(sendAtMs)) {
      setSendUndoCountdown(0)
      return
    }

    const tick = () => {
      setSendUndoCountdown(Math.max(0, Math.ceil((sendAtMs - Date.now()) / 1000)))
    }
    tick()
    const interval = window.setInterval(tick, 1000)
    return () => window.clearInterval(interval)
  }, [sendUndoInfo])

  // On folder change or unmount — flush pending undo
  useEffect(() => {
    return () => { flushUndo() }
  }, [currentFolder, flushUndo])

  return {
    undoInfo,
    undoCountdown,
    sendUndoInfo,
    sendUndoCountdown,
    undoInfoRef,
    flushUndo,
    moveWithUndo,
    handleUndo,
    handleSendUndo,
    clearSendUndo,
    setSendUndoInfo: setSendUndoInfoWrapper,
    scheduleSendUndo,
    getPendingMoveEpoch,
  }
}
