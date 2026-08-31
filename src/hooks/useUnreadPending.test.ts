// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Mailbox } from '../../packages/types/folder'
import type { MailSummary } from '../../packages/types/mail'
import { useUnreadPending } from './useUnreadPending'

/** Minimal Mailbox factory for ackMailboxes (only path + unread matter here). */
function mb(path: string, unread: number): Mailbox {
  return { path, name: path, unread }
}

/**
 * Referentially stable live-account set for the tests that never change it.
 * The hook prunes on identity change, so an inline literal would re-run the
 * (idempotent) prune every render — harmless, but noisier to reason about.
 */
const LIVE = [1, 2]

/** Minimal MailSummary factory for applyOverrides (only uid + unread matter here). */
function msg(uid: number, unread: boolean): MailSummary {
  return { accountId: 1, folder: 'INBOX', uid, from: 'a@b.test', subject: 's', date: '2026-01-01', unread, flagged: false }
}

describe('useUnreadPending — ackMailboxes baseline reconciliation', () => {
  it('seeds a baseline and reconciles pending via server delta (happy path)', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))

    // Server baseline established first (pending still empty → no-op ack).
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 1)]) })
    // Optimistic mark-read.
    act(() => { result.current.bump(1, 'INBOX', -1) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(-1)

    // Server catches up (1 → 0): delta -1 matches pending -1 → acked away.
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 0)]) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBeUndefined()

    // Re-mark unread: pending becomes +1 over the new base of 0.
    act(() => { result.current.bump(1, 'INBOX', 1) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(1)
  })

  // BACKLOG §2.25 regression: the failing ordering is when the FIRST authoritative
  // count for a folder arrives only AFTER an optimistic bump and already reflects
  // it (no prior baseline to diff against). Before the fix, ackMailboxes skipped
  // reconciliation in that case and the stale pending leaked forever, so a later
  // opposite bump cancelled it instead of moving the badge.
  it('clears a stranded pending when the first authoritative count arrives without a baseline', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))

    // Optimistic mark-read BEFORE any server baseline exists.
    act(() => { result.current.bump(1, 'INBOX', -1) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(-1)

    // First authoritative count (cache already reflects the read: unread=0),
    // no prior baseline. The stale pending must be dropped, not left to leak.
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 0)]) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBeUndefined()

    // Now marking unread must move the badge to 1 (base 0 + pending 1),
    // not be swallowed by a stranded -1.
    act(() => { result.current.bump(1, 'INBOX', 1) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(1)
  })

  it('first ack with empty pending only seeds the baseline (no spurious change)', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 3)]) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBeUndefined()
    // A subsequent same-direction server drop now reconciles against the seed.
    act(() => { result.current.bump(1, 'INBOX', -1) })
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 2)]) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBeUndefined()
  })

  // One ack speaks for ONE account, but the baseline map spans all of them.
  // Replacing it wholesale erased every other account's baseline, which is the
  // precondition for the stuck-badge failure below: boot acks account 1, then
  // account 2, and from then on account 1 has no baseline at all.
  it('an ack for one account leaves the baselines of other accounts intact', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))

    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 1)]) })
    act(() => { result.current.ackMailboxes(2, [mb('INBOX', 4)]) })

    // Account 1 still has a baseline of 1, so an over-decrement is clamped to
    // it instead of running unbounded (only reachable if the baseline is there).
    act(() => { result.current.bump(1, 'INBOX', -5) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(-1)
  })

  // The failure this reproduces: open the only unread email (optimistic -1),
  // then a folder-count refresh for the SAME account lands with a count that
  // has not yet caught up with the just-issued `net:setSeen`. With a baseline
  // present that ack is a no-op (server delta 0) and the badge stays cleared.
  // Without one it took the no-baseline branch, dropped the delta, and the
  // badge re-displayed the stale count with nothing scheduled to correct it —
  // observed as `folder-badge-INBOX` stuck at "1" for the full timeout.
  it('keeps the optimistic delta when a second account was acked in between', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))

    // Boot: both accounts report their counts.
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 1)]) })
    act(() => { result.current.ackMailboxes(2, [mb('INBOX', 1)]) })

    // User opens the unread email in account 1.
    act(() => { result.current.bump(1, 'INBOX', -1) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(-1)

    // An in-flight refresh for account 1 answers with the pre-read count.
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 1)]) })

    // Badge base 1 + pending -1 = 0 — the badge stays cleared.
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(-1)

    // And once the count does catch up, the delta is consumed, not doubled.
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 0)]) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBeUndefined()
  })

  // The per-account replacement must still be wholesale WITHIN the account:
  // a folder the server stopped reporting loses its baseline.
  it('drops the baseline of a folder the account no longer reports', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))

    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 1), mb('Junk', 2)]) })
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 1)]) })

    // Junk has no baseline anymore, so its pending is unclamped.
    act(() => { result.current.bump(1, 'Junk', -5) })
    expect(result.current.folderUnreadPending['1:Junk']).toBe(-5)
  })
})

// §2.99 test-gen gap-fill: `applyOverrides` had NO direct coverage before this
// file, even though it is the exact function behind App.tsx's three bare
// `applyUnreadOverrides(accountId, folder, raw, 'remote')` calls (result
// intentionally unused — see the comments at those call sites). Those calls
// exist ONLY for the pruning side effect asserted below: without them, an
// override recorded by an optimistic mark-read/unread would never be
// reconciled against a fresh 'remote' list and would leak in `pendingByKey`
// forever, silently overriding the server's own flag on every future render
// of that message — the exact "desync the folder badges" failure the source
// comments describe.
describe('useUnreadPending — applyOverrides reconciliation (the pruning side effect App.tsx relies on)', () => {
  it('patches a message flag from a recorded override that disagrees with the source list', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))
    act(() => { result.current.record(1, 'INBOX', 5, false) }) // optimistic mark-read

    const patched = result.current.applyOverrides(1, 'INBOX', [msg(5, true)], 'cache')
    expect(patched[0].unread).toBe(false)
  })

  // THE call App.tsx makes and discards the result of: a 'remote' list that
  // already agrees with the override PRUNES it, so the pending map does not
  // outlive the server catching up. Removing the three bare call sites in
  // App.tsx (item 4 of the gap analysis) means this branch of the real
  // production code simply never runs for those refresh paths again.
  it('prunes an override once a REMOTE list already agrees with it', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))
    act(() => { result.current.record(1, 'INBOX', 5, false) })

    // Server has caught up: uid 5 now arrives unread=false, same as desired.
    result.current.applyOverrides(1, 'INBOX', [msg(5, false)], 'remote')

    // The override is gone — a later list where the server flips uid 5 back
    // to unread=true is no longer overridden (proves the map entry, not just
    // this call's list, was pruned).
    const after = result.current.applyOverrides(1, 'INBOX', [msg(5, true)], 'cache')
    expect(after[0].unread).toBe(true)
  })

  it('does NOT prune on a cache-sourced list, even when it already agrees', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))
    act(() => { result.current.record(1, 'INBOX', 5, false) })

    // 'cache' agreeing must not clear the override — only an authoritative
    // 'remote' read is allowed to retire a pending override.
    result.current.applyOverrides(1, 'INBOX', [msg(5, false)], 'cache')

    const after = result.current.applyOverrides(1, 'INBOX', [msg(5, true)], 'cache')
    expect(after[0].unread).toBe(false)
  })

  it('returns the exact same list reference when there is nothing pending for the key', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))
    const list = [msg(1, true), msg(2, false)]
    expect(result.current.applyOverrides(1, 'INBOX', list, 'remote')).toBe(list)
  })

  it('returns the exact same list reference when a pending override already matches every row', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))
    act(() => { result.current.record(1, 'INBOX', 5, false) })
    const list = [msg(5, false)]
    // 'cache' so the override survives the call (isolates "no patch needed"
    // from "override was pruned").
    expect(result.current.applyOverrides(1, 'INBOX', list, 'cache')).toBe(list)
  })

  it('keeps overrides scoped to their own (accountId, folder) key', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))
    act(() => { result.current.record(1, 'INBOX', 5, false) })
    // Same uid, different folder — must not be affected by the INBOX override.
    const other = result.current.applyOverrides(1, 'Archive', [msg(5, true)], 'cache')
    expect(other[0].unread).toBe(true)
  })
})

// The stores here are keyed `${accountId}:${folder}` and outlive any single
// account, so the set of accounts that still exist has to be part of the hook,
// not a cleanup call at the deletion sites. Two things made that necessary:
// deleting the LAST account returns early in App.tsx before it reaches
// `resetLocalPending()`, and an in-flight `net:mailboxesAndRoles` can answer
// after its account is gone — after which every later ack for a live account
// carried the dead keys forward, unbounded across add/remove cycles.
describe('useUnreadPending — the live account set bounds the state', () => {
  it('drops the state of an account that left the live set', () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useUnreadPending(ids),
      { initialProps: { ids: [1, 2] as number[] } },
    )

    act(() => { result.current.ackMailboxes(2, [mb('INBOX', 3)]) })

    // Account 2 is deleted, then an account reusing id 2 is added later.
    rerender({ ids: [1] })
    rerender({ ids: [1, 2] })

    // A stale baseline of 3 would clamp this to -3; there must be none.
    act(() => { result.current.bump(2, 'INBOX', -5) })
    expect(result.current.folderUnreadPending['2:INBOX']).toBe(-5)
  })

  it('drops the state of every account when the last one is deleted', () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useUnreadPending(ids),
      { initialProps: { ids: [1] as number[] } },
    )

    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 3)]) })
    act(() => { result.current.bump(1, 'INBOX', -1) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(-1)

    // App.tsx returns early on an empty account list — the pending badge delta
    // and the baseline must go anyway.
    rerender({ ids: [] })
    expect(result.current.folderUnreadPending['1:INBOX']).toBeUndefined()

    rerender({ ids: [1] })
    act(() => { result.current.bump(1, 'INBOX', -5) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(-5)
  })

  it('ignores a late ack for an account that is no longer here', () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useUnreadPending(ids),
      { initialProps: { ids: [1, 2] as number[] } },
    )

    rerender({ ids: [1] })
    // The `net:mailboxesAndRoles` request that was in flight when account 2 was
    // deleted answers now: it must not seed anything.
    act(() => { result.current.ackMailboxes(2, [mb('INBOX', 2)]) })

    rerender({ ids: [1, 2] })
    // A leaked baseline of 2 would clamp this to -2.
    act(() => { result.current.bump(2, 'INBOX', -5) })
    expect(result.current.folderUnreadPending['2:INBOX']).toBe(-5)
  })

  it('keeps a live account untouched while another account is removed', () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useUnreadPending(ids),
      { initialProps: { ids: [1, 2] as number[] } },
    )

    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 1)]) })
    act(() => { result.current.ackMailboxes(2, [mb('INBOX', 4)]) })

    rerender({ ids: [1] })

    // Account 1 still has its baseline of 1, so the over-decrement is clamped.
    act(() => { result.current.bump(1, 'INBOX', -5) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(-1)
  })

  it('scopes reset(1) to account 1 and not to account 11', () => {
    const ids = [1, 11]
    const { result } = renderHook(() => useUnreadPending(ids))

    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 5)]) })
    act(() => { result.current.ackMailboxes(11, [mb('INBOX', 5)]) })
    act(() => {
      result.current.bump(1, 'INBOX', -1)
      result.current.bump(11, 'INBOX', -1)
    })

    act(() => { result.current.reset(1) })

    expect(result.current.folderUnreadPending['1:INBOX']).toBeUndefined()
    expect(result.current.folderUnreadPending['11:INBOX']).toBe(-1)

    // Account 11 kept its baseline too — the clamp still applies.
    act(() => { result.current.bump(11, 'INBOX', -9) })
    expect(result.current.folderUnreadPending['11:INBOX']).toBe(-5)
  })

  it('refuses optimistic writes for an account that is not in the live set', () => {
    const { result } = renderHook(() => useUnreadPending(LIVE))

    act(() => { result.current.bump(99, 'INBOX', 1) })
    expect(result.current.folderUnreadPending['99:INBOX']).toBeUndefined()

    act(() => { result.current.record(99, 'INBOX', 5, false) })
    const list = [msg(5, true)]
    expect(result.current.applyOverrides(99, 'INBOX', list, 'cache')).toBe(list)
  })
})
