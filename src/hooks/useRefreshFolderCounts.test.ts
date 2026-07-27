// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRefreshFolderCounts } from './useRefreshFolderCounts'

describe('useRefreshFolderCounts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('(f) debounces background calls per-account — three calls on same id = one run', () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useRefreshFolderCounts(runner, { debounceMs: 500 }))

    act(() => {
      result.current.schedule(1)
      result.current.schedule(1)
      result.current.schedule(1)
    })

    expect(runner).toHaveBeenCalledTimes(0)

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith(1)
  })

  it('(f) two accounts are independent — neither delays the other', () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useRefreshFolderCounts(runner, { debounceMs: 500 }))

    act(() => {
      result.current.schedule(1)
      result.current.schedule(2)
    })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner).toHaveBeenCalledWith(1)
    expect(runner).toHaveBeenCalledWith(2)
  })

  it('(f) scheduling account B does not reset the timer of account A', () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useRefreshFolderCounts(runner, { debounceMs: 500 }))

    act(() => {
      result.current.schedule(1)
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    act(() => {
      result.current.schedule(2)
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    // Account 1's timer must have fired exactly at 500ms from its schedule.
    expect(runner).toHaveBeenCalledWith(1)

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(runner).toHaveBeenCalledWith(2)
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('trailing-edge debounce: schedule twice within window, fires once at the tail', () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const onSuppressed = vi.fn()
    const { result } = renderHook(() =>
      useRefreshFolderCounts(runner, { debounceMs: 500, onSuppressed }),
    )

    act(() => {
      result.current.schedule(1)
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    act(() => {
      result.current.schedule(1)
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })

    // The second schedule extended the window; the timer should NOT have
    // fired yet (only 400ms elapsed since the second call).
    expect(runner).toHaveBeenCalledTimes(0)

    act(() => {
      vi.advanceTimersByTime(100)
    })

    expect(runner).toHaveBeenCalledTimes(1)
    expect(onSuppressed).toHaveBeenCalledTimes(1)
  })

  it('source: user bypasses the debounce and fires immediately', async () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useRefreshFolderCounts(runner, { debounceMs: 500 }))

    await act(async () => {
      result.current.schedule(1, 'user')
    })

    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith(1)
  })

  it('user action cancels a pending background timer for the same account', async () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useRefreshFolderCounts(runner, { debounceMs: 500 }))

    act(() => {
      result.current.schedule(1)
    })
    await act(async () => {
      result.current.schedule(1, 'user')
    })

    expect(runner).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(500)
    })

    // The pending background timer should have been cancelled by the user run.
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('runNow fires immediately and cancels pending timer for that account', async () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useRefreshFolderCounts(runner, { debounceMs: 500 }))

    act(() => {
      result.current.schedule(1)
    })
    await act(async () => {
      await result.current.runNow(1)
    })

    expect(runner).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('cancel() drops a pending timer without firing the runner', () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useRefreshFolderCounts(runner, { debounceMs: 500 }))

    act(() => {
      result.current.schedule(1)
      result.current.cancel(1)
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(runner).not.toHaveBeenCalled()
  })

  it('runner rejection does not break subsequent schedules for the same account', async () => {
    // If the debounced runner rejects internally, the hook swallows it
    // (individual failures are logged by the runner). A next schedule must
    // still be able to fire cleanly.
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useRefreshFolderCounts(runner, { debounceMs: 500 }))

    act(() => {
      result.current.schedule(1)
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
      // Let the rejected promise settle without Vitest surfacing an unhandled rejection.
      await Promise.resolve()
    })

    expect(runner).toHaveBeenCalledTimes(1)

    // Next schedule should still work.
    act(() => {
      result.current.schedule(1)
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('latest runner is invoked when it changes between schedule and fire', async () => {
    // The hook stores runner in a ref so the setTimeout callback always
    // calls the freshest version without re-subscribing timers.
    const first = vi.fn().mockResolvedValue(undefined)
    const second = vi.fn().mockResolvedValue(undefined)

    const { result, rerender } = renderHook(
      ({ runner }: { runner: (id: number) => Promise<void> }) =>
        useRefreshFolderCounts(runner, { debounceMs: 500 }),
      { initialProps: { runner: first } },
    )

    act(() => {
      result.current.schedule(1)
    })

    // Swap runner mid-window.
    rerender({ runner: second })

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith(1)
  })

  it('runNow rejection is observable to caller (not swallowed)', async () => {
    // Unlike the debounced path, runNow returns the promise; a caller that
    // awaits runNow must see the rejection so the UI can surface it.
    const runner = vi.fn().mockRejectedValue(new Error('explicit'))
    const { result } = renderHook(() => useRefreshFolderCounts(runner, { debounceMs: 500 }))

    await expect(result.current.runNow(1)).rejects.toThrow('explicit')
  })

  it('onSuppressed is not invoked when the first schedule fires cleanly', () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const onSuppressed = vi.fn()
    const { result } = renderHook(() =>
      useRefreshFolderCounts(runner, { debounceMs: 500, onSuppressed }),
    )

    act(() => {
      result.current.schedule(1)
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(runner).toHaveBeenCalledTimes(1)
    expect(onSuppressed).not.toHaveBeenCalled()
  })

  it('(g) unmount clears all pending timers', () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const { result, unmount } = renderHook(() =>
      useRefreshFolderCounts(runner, { debounceMs: 500 }),
    )

    act(() => {
      result.current.schedule(1)
      result.current.schedule(2)
    })

    unmount()

    act(() => {
      vi.advanceTimersByTime(1_000)
    })

    expect(runner).not.toHaveBeenCalled()
  })
})
