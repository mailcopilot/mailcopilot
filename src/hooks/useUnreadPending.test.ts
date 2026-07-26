// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Mailbox } from '../../packages/types/folder'
import { useUnreadPending } from './useUnreadPending'

/** Minimal Mailbox factory for ackMailboxes (only path + unread matter here). */
function mb(path: string, unread: number): Mailbox {
  return { path, name: path, unread }
}

describe('useUnreadPending — ackMailboxes baseline reconciliation', () => {
  it('seeds a baseline and reconciles pending via server delta (happy path)', () => {
    const { result } = renderHook(() => useUnreadPending())

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
    const { result } = renderHook(() => useUnreadPending())

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
    const { result } = renderHook(() => useUnreadPending())
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 3)]) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBeUndefined()
    // A subsequent same-direction server drop now reconciles against the seed.
    act(() => { result.current.bump(1, 'INBOX', -1) })
    act(() => { result.current.ackMailboxes(1, [mb('INBOX', 2)]) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBeUndefined()
  })
})
