import { useCallback, useRef, useState } from 'react'
import type { FolderPreference, FolderRoles, Mailbox, MailSummary } from '../../packages/net/types'

export type MailboxesAndRoles = { mailboxes: Mailbox[]; detected: FolderRoles; roles: FolderRoles; prefs?: Record<string, FolderPreference> }

/**
 * Hook for instantly updating unread counts and message statuses
 * without waiting for IMAP server confirmation (LIST-STATUS / FETCH flags).
 *
 * Returns:
 * - folderUnreadPending — deltas for displayed folder badges (key: `${accountId}:${folder}`)
 * - bump / record / clear — manage pending state
 * - applyOverrides — apply pending overrides to the message list
 * - reset — reset all pending state (all or for a specific account)
 * - ackMailboxes — acknowledge server counts from the mailbox list
 */
export function useUnreadPending() {
  const [folderUnreadPending, setFolderUnreadPending] = useState<Record<string, number>>({})
  const pendingByKey = useRef(new Map<string, Map<number, boolean>>())
  const serverCounts = useRef<Record<string, number>>({})

  const keyOf = useCallback((accountId: number, folder: string) => `${accountId}:${folder}`, [])

  const bump = useCallback((accountId: number, folder: string, delta: number) => {
    if (!delta) return
    const key = keyOf(accountId, folder)
    setFolderUnreadPending(prev => {
      const next = { ...prev }
      const base = serverCounts.current[key]
      const raw = (next[key] ?? 0) + delta
      // Prevent pending from driving the displayed count below zero.
      const v = typeof base === 'number' ? Math.max(raw, -base) : raw
      if (v === 0) delete next[key]
      else next[key] = v
      return next
    })
  }, [keyOf])

  const record = useCallback((accountId: number, folder: string, uid: number, unread: boolean) => {
    const key = keyOf(accountId, folder)
    const map = pendingByKey.current.get(key) ?? new Map<number, boolean>()
    map.set(uid, unread)
    pendingByKey.current.set(key, map)
  }, [keyOf])

  const clear = useCallback((accountId: number, folder: string, uid: number) => {
    const key = keyOf(accountId, folder)
    const map = pendingByKey.current.get(key)
    if (!map) return
    map.delete(uid)
    if (map.size === 0) pendingByKey.current.delete(key)
  }, [keyOf])

  const applyOverrides = useCallback((accountId: number, folder: string, list: MailSummary[], source: 'remote' | 'cache') => {
    const key = keyOf(accountId, folder)
    const map = pendingByKey.current.get(key)
    if (!map || map.size === 0) return list

    let changed = false
    const next = list.map(m => {
      const desired = map.get(m.uid)
      if (typeof desired !== 'boolean') return m

      // For remote: if the server already returns the desired flag, we can remove the override.
      if (source === 'remote' && m.unread === desired) {
        map.delete(m.uid)
        return m
      }

      if (m.unread !== desired) {
        changed = true
        return { ...m, unread: desired }
      }
      return m
    })

    if (source === 'remote' && map.size === 0) pendingByKey.current.delete(key)
    return changed ? next : list
  }, [keyOf])

  const reset = useCallback((accountId?: number) => {
    if (typeof accountId !== 'number') {
      setFolderUnreadPending({})
      pendingByKey.current.clear()
      serverCounts.current = {}
      return
    }
    const prefix = `${accountId}:`
    setFolderUnreadPending(prev => {
      const next = { ...prev }
      for (const k of Object.keys(next)) {
        if (k.startsWith(prefix)) delete next[k]
      }
      return next
    })
    for (const k of pendingByKey.current.keys()) {
      if (k.startsWith(prefix)) pendingByKey.current.delete(k)
    }
    for (const k of Object.keys(serverCounts.current)) {
      if (k.startsWith(prefix)) delete serverCounts.current[k]
    }
  }, [])

  const ackMailboxes = useCallback((accountId: number, mailboxes: Mailbox[]) => {
    // Compare with new server counts: if the server has caught up with local changes,
    // gradually remove pending to avoid double counting.
    const nextServer: Record<string, number> = {}
    for (const b of mailboxes) {
      if (typeof b.unread === 'number') nextServer[keyOf(accountId, b.path)] = b.unread
    }
    const prevServer = serverCounts.current
    setFolderUnreadPending(prevPending => {
      const nextPending = { ...prevPending }
      for (const [path, newCount] of Object.entries(nextServer)) {
        const oldCount = prevServer[path]
        if (typeof oldCount !== 'number') {
          // First authoritative count for this folder — no prior baseline to
          // diff against. BACKLOG §2.25: if an optimistic `bump` already ran
          // (e.g. mark-read clears a badge) and the very first count to arrive
          // already reflects it, skipping reconciliation here strands that
          // pending delta forever — the badge then desyncs (a later opposite
          // bump cancels the stale delta instead of moving the count). The
          // authoritative count is the source of truth for the badge base, so
          // drop any outstanding pending for this path while seeding the
          // baseline, rather than leaking it.
          if (nextPending[path] !== undefined) delete nextPending[path]
          continue
        }
        const serverDelta = newCount - oldCount
        const pending = nextPending[path] ?? 0
        if (pending === 0 || serverDelta === 0) continue

        // If the server change goes in the same direction as pending,
        // treat it as an acknowledgment (ack) and reduce pending, but no more than its absolute value.
        if (Math.sign(serverDelta) === Math.sign(pending)) {
          const ack = Math.sign(serverDelta) * Math.min(Math.abs(serverDelta), Math.abs(pending))
          const np = pending - ack
          if (np === 0) delete nextPending[path]
          else nextPending[path] = np
        }
      }
      return nextPending
    })
    serverCounts.current = nextServer
  }, [keyOf])

  return { folderUnreadPending, bump, record, clear, applyOverrides, reset, ackMailboxes }
}
