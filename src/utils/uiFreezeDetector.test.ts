// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockInvoke = vi.fn().mockResolvedValue(undefined)
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

import { startUiFreezeDetector, stopUiFreezeDetector } from './uiFreezeDetector'

describe('uiFreezeDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    // Reset module state by stopping any previous detector.
    stopUiFreezeDetector()

    // Default to visible state.
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    stopUiFreezeDetector()
    vi.useRealTimers()
  })

  it('sends a startup ping on start', () => {
    startUiFreezeDetector()
    expect(mockInvoke).toHaveBeenCalledWith(
      'log:uiFreeze',
      expect.objectContaining({ lagMs: 0, deltaMs: 0, startup: true }),
    )
  })

  it('is idempotent — second call does not send another startup ping', () => {
    startUiFreezeDetector()
    const callCount = mockInvoke.mock.calls.length
    startUiFreezeDetector()
    expect(mockInvoke.mock.calls.length).toBe(callCount)
  })

  it('does not report freeze when timer fires on time', () => {
    startUiFreezeDetector()
    mockInvoke.mockClear()

    // Advance exactly 100ms (TICK_MS) — no lag.
    vi.advanceTimersByTime(100)
    // No freeze report expected — only the scheduled tick.
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('reports a freeze when the event loop is blocked longer than threshold', () => {
    // Manually control performance.now() to simulate a stalled event loop.
    let fakeNow = 1000
    const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow)

    startUiFreezeDetector()
    mockInvoke.mockClear()

    // First tick fires after 100ms — simulate 400ms wall-clock jump.
    fakeNow = 1400
    vi.advanceTimersByTime(100)

    const freezeCalls = mockInvoke.mock.calls.filter(
      ([ch, info]) => ch === 'log:uiFreeze' && !info.startup,
    )
    expect(freezeCalls.length).toBeGreaterThanOrEqual(1)
    const [, info] = freezeCalls[0]
    expect(info.lagMs).toBeGreaterThanOrEqual(200)

    perfSpy.mockRestore()
  })

  it('does not report freeze when document is hidden', () => {
    startUiFreezeDetector()
    mockInvoke.mockClear()

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    })

    // Large time jump while hidden — should be ignored.
    vi.advanceTimersByTime(5000)

    const freezeCalls = mockInvoke.mock.calls.filter(
      ([ch, info]) => ch === 'log:uiFreeze' && !info.startup,
    )
    expect(freezeCalls).toHaveLength(0)
  })

  it('stopUiFreezeDetector clears the timer', () => {
    startUiFreezeDetector()
    mockInvoke.mockClear()

    stopUiFreezeDetector()
    vi.advanceTimersByTime(10000)

    // No further calls after stop.
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('can be restarted after stop', () => {
    startUiFreezeDetector()
    stopUiFreezeDetector()
    mockInvoke.mockClear()

    startUiFreezeDetector()
    // Should send a new startup ping.
    expect(mockInvoke).toHaveBeenCalledWith(
      'log:uiFreeze',
      expect.objectContaining({ startup: true }),
    )
  })

  it('does not throw when window.api is undefined', () => {
    const savedApi = window.api
    Object.defineProperty(window, 'api', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    // Should not throw.
    stopUiFreezeDetector()
    expect(() => startUiFreezeDetector()).not.toThrow()

    // Restore for other tests.
    Object.defineProperty(window, 'api', {
      value: savedApi,
      writable: true,
      configurable: true,
    })
    stopUiFreezeDetector()
  })
})
