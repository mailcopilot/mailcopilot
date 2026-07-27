// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSidebarCompactMode } from './useSidebarCompactMode'

describe('useSidebarCompactMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true when innerHeight is below threshold (720px)', () => {
    Object.defineProperty(window, 'innerHeight', { value: 640, writable: true, configurable: true })
    const { result } = renderHook(() => useSidebarCompactMode())
    expect(result.current).toBe(true)
  })

  it('returns false when innerHeight is at the threshold (720px)', () => {
    Object.defineProperty(window, 'innerHeight', { value: 720, writable: true, configurable: true })
    const { result } = renderHook(() => useSidebarCompactMode())
    expect(result.current).toBe(false)
  })

  it('returns false when innerHeight is above threshold', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, writable: true, configurable: true })
    const { result } = renderHook(() => useSidebarCompactMode())
    expect(result.current).toBe(false)
  })

  it('switches to compact when window is resized below threshold', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, writable: true, configurable: true })
    const { result } = renderHook(() => useSidebarCompactMode())
    expect(result.current).toBe(false)

    act(() => {
      Object.defineProperty(window, 'innerHeight', { value: 600, writable: true, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toBe(true)
  })

  it('switches back to normal when window is resized above threshold', () => {
    Object.defineProperty(window, 'innerHeight', { value: 600, writable: true, configurable: true })
    const { result } = renderHook(() => useSidebarCompactMode())
    expect(result.current).toBe(true)

    act(() => {
      Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true })
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toBe(false)
  })

  it('removes resize listener on unmount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    Object.defineProperty(window, 'innerHeight', { value: 900, writable: true, configurable: true })
    const { unmount } = renderHook(() => useSidebarCompactMode())

    const addedListener = addSpy.mock.calls.find(([event]) => event === 'resize')
    expect(addedListener).toBeDefined()

    unmount()

    const removedListener = removeSpy.mock.calls.find(([event]) => event === 'resize')
    expect(removedListener).toBeDefined()
  })
})
