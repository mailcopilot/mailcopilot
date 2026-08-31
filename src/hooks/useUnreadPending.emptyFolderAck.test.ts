// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUnreadPending } from './useUnreadPending'
import type { Mailbox } from '../../packages/net/types'

/**
 * Named risk of the "explicit zero for an emptied folder" fix: the manual UI
 * paths already compensate for the frozen badge with an optimistic delta
 * (`bumpFolderUnreadPending(-unread)`). Once the main process starts reporting
 * a real zero for the emptied folder, that delta MUST be discharged by the
 * same `ackMailboxes` call that carries the zero — otherwise the badge, which
 * is `max(0, base + pending)`, simply drifts in the other direction and the
 * next incoming message shows up under-counted.
 *
 * The reconciliation itself is not new (it is the same-sign ack path in
 * `useUnreadPending`), but before the fix it could never fire for an emptied
 * folder: the merged mailbox list kept the stale count, so `serverDelta` was
 * always 0. These tests pin that the zero now reaches it.
 */
const mailbox = (path: string, unread: number): Mailbox =>
  ({ path, name: path, unread } as unknown as Mailbox)

describe('useUnreadPending — emptied folder reaches zero', () => {
  it('discharges the compensating delta when the ack carries an explicit zero', () => {
    const { result } = renderHook(() => useUnreadPending([1]))

    // Baseline from the mailbox list: 7 unread in INBOX.
    act(() => { result.current.ackMailboxes(1, [mailbox('INBOX', 7)]) })
    // Manual bulk action: optimistic clear of all seven.
    act(() => { result.current.bump(1, 'INBOX', -7) })
    expect(result.current.folderUnreadPending['1:INBOX']).toBe(-7)

    // `refreshCachedFolderCounts` merges the reply and re-acks. With the fix
    // the reply names INBOX explicitly at zero, so the merged list carries 0.
    act(() => { result.current.ackMailboxes(1, [mailbox('INBOX', 0)]) })

    expect(result.current.folderUnreadPending['1:INBOX']).toBeUndefined()
    // Badge = max(0, base + pending) = max(0, 0 + 0) = 0.
  })

  it('leaves the delta stranded when the ack repeats the stale count', () => {
    // Pre-fix shape, kept as the contrast case: the emptied folder was absent
    // from the reply, so the merge preserved 7 and the ack saw no change. The
    // badge happened to read 0 (7 + -7), but the delta never retired — that is
    // the "hanging delta" the brief warns about, and it is exactly what the
    // assistant path (which issues no delta at all) turns into a frozen 7.
    const { result } = renderHook(() => useUnreadPending([1]))

    act(() => { result.current.ackMailboxes(1, [mailbox('INBOX', 7)]) })
    act(() => { result.current.bump(1, 'INBOX', -7) })
    act(() => { result.current.ackMailboxes(1, [mailbox('INBOX', 7)]) })

    expect(result.current.folderUnreadPending['1:INBOX']).toBe(-7)
  })

  it('discharges each account independently in a multi-mailbox burst', () => {
    const { result } = renderHook(() => useUnreadPending([1, 2, 3, 4]))

    act(() => {
      for (const id of [1, 2, 3, 4]) result.current.ackMailboxes(id, [mailbox('INBOX', 5)])
      for (const id of [1, 2, 3, 4]) result.current.bump(id, 'INBOX', -5)
    })
    act(() => {
      for (const id of [1, 2, 3, 4]) result.current.ackMailboxes(id, [mailbox('INBOX', 0)])
    })

    for (const id of [1, 2, 3, 4]) {
      expect(result.current.folderUnreadPending[`${id}:INBOX`], `account ${id}`).toBeUndefined()
    }
  })

  it('does not clamp a later increment against the retired delta', () => {
    const { result } = renderHook(() => useUnreadPending([1]))

    act(() => { result.current.ackMailboxes(1, [mailbox('INBOX', 7)]) })
    act(() => { result.current.bump(1, 'INBOX', -7) })
    act(() => { result.current.ackMailboxes(1, [mailbox('INBOX', 0)]) })
    // New mail arrives after the folder was emptied.
    act(() => { result.current.bump(1, 'INBOX', 1) })

    expect(result.current.folderUnreadPending['1:INBOX']).toBe(1)
    // Badge = max(0, 0 + 1) = 1, not 7 - 7 + 1.
  })
})
