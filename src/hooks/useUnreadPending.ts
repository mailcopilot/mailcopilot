import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FolderPreference, FolderRoles, Mailbox, MailSummary } from '../../packages/net/types'

export type MailboxesAndRoles = { mailboxes: Mailbox[]; detected: FolderRoles; roles: FolderRoles; prefs?: Record<string, FolderPreference> }

/** Every store here is keyed `${accountId}:${folder}`; folder paths may contain ':', the id never does. */
function accountIdOfKey(key: string): number {
  const i = key.indexOf(':')
  return i < 0 ? Number.NaN : Number(key.slice(0, i))
}

/**
 * Hook for instantly updating unread counts and message statuses
 * without waiting for IMAP server confirmation (LIST-STATUS / FETCH flags).
 *
 * `accountIds` is the set of accounts that currently exist — the same list the
 * app already renders, not a bookkeeping call. It is a REQUIRED argument on
 * purpose: every store below is keyed by account, so the hook must be able to
 * answer "does this account still exist?" itself. Two earlier shapes of this
 * code got that wrong in opposite directions — replacing the whole baseline map
 * on every ack erased live accounts' baselines (stuck badge), and merging it
 * kept the keys of deleted accounts forever, because the only cleanup was a
 * `reset()` call the caller was free to forget (and did: deleting the LAST
 * account returns early in App.tsx before reaching it, and an in-flight
 * `net:mailboxesAndRoles` can answer after the deletion). Deriving the boundary
 * from the account list removes the chance to forget: keys outside the live set
 * are neither kept nor accepted.
 *
 * Pass a referentially stable array (state, or `useMemo`) — an inline literal
 * only costs an extra idempotent prune per render.
 *
 * Returns:
 * - folderUnreadPending — deltas for displayed folder badges (key: `${accountId}:${folder}`)
 * - bump / record / clear — manage pending state
 * - applyOverrides — apply pending overrides to the message list
 * - reset — reset all pending state (all or for a specific account)
 * - ackMailboxes — acknowledge server counts from the mailbox list
 */
export function useUnreadPending(accountIds: readonly number[]) {
  const [folderUnreadPending, setFolderUnreadPending] = useState<Record<string, number>>({})
  const pendingByKey = useRef(new Map<string, Map<number, boolean>>())
  const serverCounts = useRef<Record<string, number>>({})

  const liveAccountIds = useMemo(() => new Set(accountIds), [accountIds])
  // Read by the writers below, which run from async IPC callbacks and therefore
  // must see the set as of the latest render, not the one their closure captured.
  const liveRef = useRef(liveAccountIds)
  liveRef.current = liveAccountIds
  const isLive = useCallback((accountId: number) => liveRef.current.has(accountId), [])

  const keyOf = useCallback((accountId: number, folder: string) => `${accountId}:${folder}`, [])

  /**
   * Single per-account eraser, shared by `reset(accountId)` and the prune below,
   * so the "which keys belong to this account" rule has exactly one definition.
   */
  const dropAccounts = useCallback((shouldDrop: (accountId: number) => boolean) => {
    setFolderUnreadPending(prev => {
      let changed = false
      const next = { ...prev }
      for (const k of Object.keys(next)) {
        if (shouldDrop(accountIdOfKey(k))) {
          delete next[k]
          changed = true
        }
      }
      return changed ? next : prev
    })
    for (const k of [...pendingByKey.current.keys()]) {
      if (shouldDrop(accountIdOfKey(k))) pendingByKey.current.delete(k)
    }
    for (const k of Object.keys(serverCounts.current)) {
      if (shouldDrop(accountIdOfKey(k))) delete serverCounts.current[k]
    }
  }, [])

  // The account set is the boundary of every store here: once an account is
  // gone from it, its keys go with it. Idempotent, so a caller passing a fresh
  // array each render is harmless.
  useEffect(() => {
    dropAccounts(id => !liveAccountIds.has(id))
  }, [liveAccountIds, dropAccounts])

  const bump = useCallback((accountId: number, folder: string, delta: number) => {
    if (!delta) return
    if (!isLive(accountId)) return
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
  }, [isLive, keyOf])

  const record = useCallback((accountId: number, folder: string, uid: number, unread: boolean) => {
    if (!isLive(accountId)) return
    const key = keyOf(accountId, folder)
    const map = pendingByKey.current.get(key) ?? new Map<number, boolean>()
    map.set(uid, unread)
    pendingByKey.current.set(key, map)
  }, [isLive, keyOf])

  // Not gated on the live set: `clear` only removes state, so refusing it could
  // never shrink the map, only leave something behind.
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
    dropAccounts(id => id === accountId)
  }, [dropAccounts])

  const ackMailboxes = useCallback((accountId: number, mailboxes: Mailbox[]) => {
    // An answer about an account that no longer exists is not an answer about
    // anything we may hold: an in-flight `net:mailboxesAndRoles` outlives the
    // deletion, and accepting it here would re-seed the keys the prune above
    // just dropped.
    if (!isLive(accountId)) return

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

    // The baseline map is keyed `${accountId}:${folder}` and spans EVERY
    // account, but one ack speaks for ONE account. Replacing the whole map
    // with `nextServer` therefore erased the baselines of every other account
    // — and the erasure is not cosmetic, it is the precondition of a stuck
    // badge: with no baseline the next ack for that account takes the
    // no-baseline branch above and DROPS the optimistic delta, so a count that
    // has not yet caught up with a just-issued `net:setSeen` republishes the
    // old badge with nothing left to correct it (measured at boot: ack(1) →
    // ack(1) → ack(2) left account 1 with no baseline before the user's first
    // click). Merge instead: keys of this account are replaced wholesale (a
    // folder the server stopped reporting must lose its baseline), keys of
    // LIVE other accounts are carried through untouched — the same per-account
    // scoping `reset(accountId)` above already applies. Carrying only live
    // accounts keeps the merge self-bounding, so the map never depends on the
    // prune effect having run first.
    const prefix = `${accountId}:`
    const merged: Record<string, number> = {}
    for (const [k, v] of Object.entries(prevServer)) {
      if (k.startsWith(prefix)) continue
      if (!isLive(accountIdOfKey(k))) continue
      merged[k] = v
    }
    Object.assign(merged, nextServer)
    serverCounts.current = merged
  }, [isLive, keyOf])

  return { folderUnreadPending, bump, record, clear, applyOverrides, reset, ackMailboxes }
}
