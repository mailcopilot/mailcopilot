// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const mockInvoke = vi.fn().mockResolvedValue(false)
const mockOn = vi.fn()
const mockOff = vi.fn()

Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: mockOn, off: mockOff, removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

import { useMaximized } from './useMaximized'

describe('useMaximized', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns false initially', () => {
    const { result } = renderHook(() => useMaximized())
    expect(result.current).toBe(false)
  })

  it('queries initial maximized state on mount', () => {
    renderHook(() => useMaximized())
    expect(mockInvoke).toHaveBeenCalledWith('win:isMaximized')
  })

  it('updates state when initial query returns true', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'win:isMaximized') return Promise.resolve(true)
      return Promise.resolve(undefined)
    })

    const { result } = renderHook(() => useMaximized())

    // Flush the promise from invoke.
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current).toBe(true)
  })

  it('subscribes to win:maximizeChanged on mount', () => {
    renderHook(() => useMaximized())
    expect(mockOn).toHaveBeenCalledWith('win:maximizeChanged', expect.any(Function))
  })

  it('unsubscribes from win:maximizeChanged on unmount', () => {
    const { unmount } = renderHook(() => useMaximized())
    unmount()
    expect(mockOff).toHaveBeenCalledWith('win:maximizeChanged', expect.any(Function))
  })

  it('updates state when maximizeChanged fires with true', async () => {
    const { result } = renderHook(() => useMaximized())

    // Get the handler registered with on().
    const handler = mockOn.mock.calls.find(([ch]) => ch === 'win:maximizeChanged')![1]

    act(() => handler(true))
    expect(result.current).toBe(true)

    act(() => handler(false))
    expect(result.current).toBe(false)
  })

  it('never issues geometry IPC — bounds correction is main-process-owned', () => {
    // Regression lock for the removed win:fitToScreen contour: even with a
    // window that "exceeds" the screen and resize events firing, the hook
    // must not attempt any geometry correction. That responsibility lives
    // exclusively in electron/services/windowRescue.ts (single-writer
    // invariant); the old renderer-side loop caused visible window shaking.
    Object.defineProperty(window, 'outerWidth', { value: 5000, writable: true, configurable: true })
    Object.defineProperty(window, 'outerHeight', { value: 5000, writable: true, configurable: true })
    Object.defineProperty(window.screen, 'availWidth', { value: 1920, writable: true, configurable: true })
    Object.defineProperty(window.screen, 'availHeight', { value: 1080, writable: true, configurable: true })

    renderHook(() => useMaximized())
    act(() => {
      window.dispatchEvent(new Event('resize'))
      vi.advanceTimersByTime(5000)
    })

    const geometryCalls = mockInvoke.mock.calls.filter(([ch]) => ch === 'win:fitToScreen')
    expect(geometryCalls).toHaveLength(0)
  })

  it('does not subscribe to window resize events', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    renderHook(() => useMaximized())
    const resizeSubs = addSpy.mock.calls.filter(([ev]) => ev === 'resize')
    expect(resizeSubs).toHaveLength(0)
    addSpy.mockRestore()
  })
})
