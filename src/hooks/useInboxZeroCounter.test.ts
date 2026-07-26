// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInboxZeroCounter } from './useInboxZeroCounter'

/**
 * Build a Date at a specific local time (not UTC) so that todayString()
 * (which uses toDateString() in local TZ) gives consistent results
 * regardless of the machine's timezone.
 */
function localDate(year: number, month: number, day: number, hour: number, min: number, sec = 0): Date {
  return new Date(year, month - 1, day, hour, min, sec)
}

describe('useInboxZeroCounter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts at zero', () => {
    const { result } = renderHook(() => useInboxZeroCounter())
    expect(result.current.count).toBe(0)
  })

  it('increments count', () => {
    const { result } = renderHook(() => useInboxZeroCounter())
    act(() => result.current.increment(3))
    expect(result.current.count).toBe(3)
    act(() => result.current.increment(2))
    expect(result.current.count).toBe(5)
  })

  it('increments by 1 when called without argument', () => {
    const { result } = renderHook(() => useInboxZeroCounter())
    act(() => result.current.increment())
    expect(result.current.count).toBe(1)
  })

  it('ignores zero and negative increments', () => {
    const { result } = renderHook(() => useInboxZeroCounter())
    act(() => result.current.increment(5))
    act(() => result.current.increment(0))
    act(() => result.current.increment(-1))
    expect(result.current.count).toBe(5)
  })

  it('resets at midnight via interval check', () => {
    // Use local time (not UTC) so todayString()/toDateString() works correctly in any TZ
    vi.setSystemTime(localDate(2026, 3, 1, 23, 59, 30))

    const { result } = renderHook(() => useInboxZeroCounter())
    act(() => result.current.increment(10))
    expect(result.current.count).toBe(10)

    // Advance past local midnight
    vi.setSystemTime(localDate(2026, 3, 2, 0, 0, 30))
    act(() => { vi.advanceTimersByTime(60_000) })

    expect(result.current.count).toBe(0)
  })

  it('resets count when day changes on increment', () => {
    vi.setSystemTime(localDate(2026, 3, 1, 12, 0))

    const { result } = renderHook(() => useInboxZeroCounter())
    act(() => result.current.increment(5))
    expect(result.current.count).toBe(5)

    // Change day (local)
    vi.setSystemTime(localDate(2026, 3, 2, 12, 0))
    act(() => result.current.increment(2))
    expect(result.current.count).toBe(2)
  })

  it('cleans up interval on unmount', () => {
    const clearSpy = vi.spyOn(window, 'clearInterval')
    const { unmount } = renderHook(() => useInboxZeroCounter())
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
