// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeyedDebounce } from './useKeyedDebounce'

/**
 * Defect: `mail:exists` events arriving in one tick about DIFFERENT mailboxes
 * were coalesced by a single shared timer, so only the last event survived and
 * every other mailbox kept a stale unread badge. The fix is one timer per key.
 */
describe('useKeyedDebounce', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('runs each key exactly once after the quiet window', () => {
    const { result } = renderHook(() => useKeyedDebounce(600))
    const ran: string[] = []

    // A burst about four mailboxes in a single tick — the shape emitted by
    // mailActionCallback when the assistant acts across accounts.
    act(() => {
      for (const key of ['1:INBOX', '2:INBOX', '3:INBOX', '4:INBOX']) {
        result.current.schedule(key, () => ran.push(key))
      }
    })
    expect(ran).toEqual([])

    act(() => { vi.advanceTimersByTime(600) })
    expect(ran.sort()).toEqual(['1:INBOX', '2:INBOX', '3:INBOX', '4:INBOX'])
  })

  it('coalesces repeats of the SAME key to the last callback', () => {
    const { result } = renderHook(() => useKeyedDebounce(600))
    const ran: string[] = []

    act(() => {
      result.current.schedule('1:INBOX', () => ran.push('first'))
      result.current.schedule('1:INBOX', () => ran.push('second'))
    })
    act(() => { vi.advanceTimersByTime(600) })
    expect(ran).toEqual(['second'])
  })

  it('does not let one key extend another key timer', () => {
    const { result } = renderHook(() => useKeyedDebounce(600))
    const ran: string[] = []

    act(() => { result.current.schedule('a', () => ran.push('a')) })
    act(() => { vi.advanceTimersByTime(400) })
    // A late event about a different subject must not postpone 'a'.
    act(() => { result.current.schedule('b', () => ran.push('b')) })
    act(() => { vi.advanceTimersByTime(200) })
    expect(ran).toEqual(['a'])
    act(() => { vi.advanceTimersByTime(400) })
    expect(ran).toEqual(['a', 'b'])
  })

  it('lets a callback re-schedule its own key', () => {
    const { result } = renderHook(() => useKeyedDebounce(600))
    let runs = 0
    const again = () => {
      runs += 1
      if (runs === 1) result.current.schedule('a', again)
    }

    act(() => { result.current.schedule('a', again) })
    act(() => { vi.advanceTimersByTime(600) })
    expect(runs).toBe(1)
    act(() => { vi.advanceTimersByTime(600) })
    expect(runs).toBe(2)
  })

  it('cancel drops only the named key', () => {
    const { result } = renderHook(() => useKeyedDebounce(600))
    const ran: string[] = []

    act(() => {
      result.current.schedule('a', () => ran.push('a'))
      result.current.schedule('b', () => ran.push('b'))
      result.current.cancel('a')
    })
    act(() => { vi.advanceTimersByTime(600) })
    expect(ran).toEqual(['b'])
  })

  it('clearAll drops every pending key', () => {
    const { result } = renderHook(() => useKeyedDebounce(600))
    const ran: string[] = []

    act(() => {
      result.current.schedule('a', () => ran.push('a'))
      result.current.schedule('b', () => ran.push('b'))
      result.current.clearAll()
    })
    act(() => { vi.advanceTimersByTime(600) })
    expect(ran).toEqual([])
  })

  it('clears pending timers on unmount', () => {
    const { result, unmount } = renderHook(() => useKeyedDebounce(600))
    const ran: string[] = []
    act(() => { result.current.schedule('a', () => ran.push('a')) })
    unmount()
    act(() => { vi.advanceTimersByTime(600) })
    expect(ran).toEqual([])
  })

  it('returns a referentially stable api across renders', () => {
    // Consumers list the api in effect dependency arrays; a fresh object each
    // render would re-run those effects and their cleanup (clearAll), which
    // would cancel pending timers on every render and restore the very
    // burst-collapsing behaviour this hook removes.
    const { result, rerender } = renderHook(() => useKeyedDebounce(600))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
