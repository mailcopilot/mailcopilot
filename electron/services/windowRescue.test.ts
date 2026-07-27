import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Rect } from '../windowGeometry'

const {
  screenListeners, mockScreen, powerListeners, mockPowerMonitor,
  mockGetAllWindows, mockRecordEvent, mockCaptureException,
} = vi.hoisted(() => {
  const makeListenerRegistry = () => {
    const listeners = new Map<string, Array<() => void>>()
    return {
      listeners,
      on: vi.fn((event: string, listener: () => void) => {
        const arr = listeners.get(event) ?? []
        arr.push(listener)
        listeners.set(event, arr)
      }),
      removeListener: vi.fn((event: string, listener: () => void) => {
        const arr = listeners.get(event) ?? []
        listeners.set(event, arr.filter((l) => l !== listener))
      }),
    }
  }
  const screenRegistry = makeListenerRegistry()
  const powerRegistry = makeListenerRegistry()
  const mockScreen = {
    on: screenRegistry.on,
    removeListener: screenRegistry.removeListener,
    getAllDisplays: vi.fn<() => Array<{ workArea: Rect }>>(() => []),
  }
  const mockPowerMonitor = {
    on: powerRegistry.on,
    removeListener: powerRegistry.removeListener,
  }
  const mockGetAllWindows = vi.fn<() => unknown[]>(() => [])
  return {
    screenListeners: screenRegistry.listeners,
    mockScreen,
    powerListeners: powerRegistry.listeners,
    mockPowerMonitor,
    mockGetAllWindows,
    mockRecordEvent: vi.fn(),
    mockCaptureException: vi.fn(),
  }
})

vi.mock('electron', () => ({
  screen: mockScreen,
  powerMonitor: mockPowerMonitor,
  BrowserWindow: { getAllWindows: mockGetAllWindows },
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../sentry', () => ({ captureException: mockCaptureException }))
vi.mock('../metrics', () => ({ recordEvent: mockRecordEvent }))

import {
  initWindowRescue,
  disposeWindowRescue,
  SETTLE_MS,
  EPISODE_RESET_MS,
  MAX_INTERACTIVE_DEFERRALS,
  type WindowRescueOptions,
} from './windowRescue'

const FHD: Rect = { x: 0, y: 0, width: 1920, height: 1052 }
const VISIBLE: Rect = { x: 100, y: 100, width: 1200, height: 800 }
const OFF_SCREEN: Rect = { x: 5000, y: 100, width: 1200, height: 800 }

type FakeWin = {
  id: number
  isDestroyed: () => boolean
  isMinimized: () => boolean
  isMaximized: () => boolean
  isFullScreen: () => boolean
  getBounds: () => Rect
  getMinimumSize: () => [number, number]
  setBounds: ReturnType<typeof vi.fn>
}

/** By default setBounds "works": subsequent getBounds returns the applied rect. */
function makeWin(bounds: Rect, overrides: Partial<FakeWin> = {}): FakeWin {
  let current = { ...bounds }
  return {
    id: 1,
    isDestroyed: () => false,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => ({ ...current }),
    getMinimumSize: () => [0, 0],
    setBounds: vi.fn((b: Rect) => { current = { ...b } }),
    ...overrides,
  }
}

function fireDisplayEvent(kind = 'display-metrics-changed'): void {
  for (const l of [...(screenListeners.get(kind) ?? [])]) l()
}

function firePowerResume(): void {
  for (const l of [...(powerListeners.get('resume') ?? [])]) l()
}

function init(opts: WindowRescueOptions = {}): void {
  initWindowRescue(opts)
}

describe('windowRescue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockScreen.getAllDisplays.mockReturnValue([{ workArea: FHD }])
    mockGetAllWindows.mockReturnValue([])
  })

  afterEach(() => {
    disposeWindowRescue()
    vi.useRealTimers()
    vi.clearAllMocks()
    screenListeners.clear()
    powerListeners.clear()
  })

  it('subscribes to display events + power resume on init and unsubscribes on dispose', () => {
    init()
    expect(screenListeners.get('display-added')).toHaveLength(1)
    expect(screenListeners.get('display-removed')).toHaveLength(1)
    expect(screenListeners.get('display-metrics-changed')).toHaveLength(1)
    expect(powerListeners.get('resume')).toHaveLength(1)
    disposeWindowRescue()
    expect(screenListeners.get('display-added')).toHaveLength(0)
    expect(screenListeners.get('display-removed')).toHaveLength(0)
    expect(screenListeners.get('display-metrics-changed')).toHaveLength(0)
    expect(powerListeners.get('resume')).toHaveLength(0)
  })

  it('coalesces an event burst into a single rescue pass after the settle period', () => {
    const w = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([w])
    init()

    fireDisplayEvent('display-removed')
    vi.advanceTimersByTime(300)
    fireDisplayEvent('display-metrics-changed')
    vi.advanceTimersByTime(300)
    fireDisplayEvent('display-added')

    // Not yet: last event restarted the settle timer.
    vi.advanceTimersByTime(SETTLE_MS - 100)
    expect(w.setBounds).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(w.setBounds).toHaveBeenCalledTimes(1)

    // setBounds applied → window visible → verification pass is a no-op.
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(w.setBounds).toHaveBeenCalledTimes(1)
  })

  it('leaves visible windows alone', () => {
    const w = makeWin(VISIBLE)
    mockGetAllWindows.mockReturnValue([w])
    init()
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(w.setBounds).not.toHaveBeenCalled()
  })

  it('never touches maximized, fullscreen, minimized or destroyed windows', () => {
    const wins = [
      makeWin(OFF_SCREEN, { isMaximized: () => true }),
      makeWin(OFF_SCREEN, { isFullScreen: () => true }),
      makeWin(OFF_SCREEN, { isMinimized: () => true }),
      makeWin(OFF_SCREEN, { isDestroyed: () => true }),
    ]
    mockGetAllWindows.mockReturnValue(wins)
    init()
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS * 3)
    for (const w of wins) expect(w.setBounds).not.toHaveBeenCalled()
  })

  it('respects the window minimum size when rescuing', () => {
    const w = makeWin(OFF_SCREEN, { getMinimumSize: () => [900, 600] })
    mockScreen.getAllDisplays.mockReturnValue([{ workArea: { x: 0, y: 0, width: 700, height: 400 } }])
    mockGetAllWindows.mockReturnValue([w])
    init()
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 900, height: 600 })
  })

  it('caps passes, spends exactly one autonomous retry, then stands down until a real trigger', () => {
    // setBounds has no effect — the window stays off-screen (WM fighting
    // back). The total write budget per trouble episode must be bounded:
    // 2 passes + ONE autonomous retry batch of 2 passes = 4, then silence
    // (codex-bg-review HIGH: an unconsumed retry looped forever).
    const w = makeWin(OFF_SCREEN, { setBounds: vi.fn() })
    mockGetAllWindows.mockReturnValue([w])
    init()

    fireDisplayEvent() // t0
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(1) // pass 1

    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(2) // pass 2 → cap, retry armed

    // Capped: no further passes on the settle cadence.
    vi.advanceTimersByTime(SETTLE_MS * 2)
    expect(w.setBounds).toHaveBeenCalledTimes(2)

    // The single autonomous retry fires EPISODE_RESET_MS after the capped
    // pass and re-evaluates with a fresh pass budget...
    vi.advanceTimersByTime(EPISODE_RESET_MS - SETTLE_MS * 2)
    expect(w.setBounds).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(4)

    // ...and once that budget caps out too, the service stands down for
    // good: no more writes no matter how much time passes.
    vi.advanceTimersByTime(EPISODE_RESET_MS * 10)
    expect(w.setBounds).toHaveBeenCalledTimes(4)

    // A real trigger after the episode gap restores the full budget.
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(5)
  })

  it('records telemetry for a rescue pass that moved windows', () => {
    const w = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([w])
    init()
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(mockRecordEvent).toHaveBeenCalledWith('window.rescued', { windows_moved: 1, pass: 1 })
  })

  it('defers passes while an interactive resize is in progress', () => {
    const w = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([w])
    let dragging = true
    init({ isInteractiveOperationActive: () => dragging })

    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(w.setBounds).not.toHaveBeenCalled()

    dragging = false
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(1)
  })

  it('proceeds after the interactive-deferral cap when the flag never clears (rescue-denial guard)', () => {
    // A stuck or maliciously held resizeState must not suppress rescue
    // forever: after MAX_INTERACTIVE_DEFERRALS one-second deferrals the pass
    // runs anyway (a legitimate drag is bounded by the 15s fail-safe).
    // No stopInteractiveOperation callback provided — the optional-callback
    // path must still proceed.
    const w = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([w])
    init({ isInteractiveOperationActive: () => true })

    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS * MAX_INTERACTIVE_DEFERRALS)
    expect(w.setBounds).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(1)
  })

  it('force-stops a stuck interactive operation at the deferral cap before rescuing', () => {
    // The stuck drag's 16ms setBounds interval would otherwise overwrite the
    // rescue placement every frame — the service must kill the competing
    // writer via stopInteractiveOperation exactly once, then rescue.
    const w = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([w])
    let dragging = true
    const stop = vi.fn(() => { dragging = false })
    init({ isInteractiveOperationActive: () => dragging, stopInteractiveOperation: stop })

    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS * MAX_INTERACTIVE_DEFERRALS)
    expect(stop).not.toHaveBeenCalled()
    expect(w.setBounds).not.toHaveBeenCalled()

    vi.advanceTimersByTime(SETTLE_MS)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(w.setBounds).toHaveBeenCalledTimes(1)

    // Flag cleared by the stop callback → subsequent verification pass runs
    // normally (window is visible now, so it is a clean no-op).
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(w.setBounds).toHaveBeenCalledTimes(1)
  })

  it('ignores display events after dispose', () => {
    const w = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([w])
    init()
    disposeWindowRescue()
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(w.setBounds).not.toHaveBeenCalled()
  })

  it('does NOT reset the episode when a display event arrives within EPISODE_RESET_MS of the previous event', () => {
    // Discriminator: a stubborn window (setBounds never fixes it, since this
    // mock's setBounds is a no-op and getBounds keeps returning OFF_SCREEN)
    // hits the pass cap after 2 passes and arms the slow retry. `lastEventAt`
    // is stamped only by onDisplayEvent (actual display-* events), NOT by
    // internal pass re-runs — so the gap that matters is measured from the
    // FIRST fireDisplayEvent call. Firing a second event before that gap
    // exceeds EPISODE_RESET_MS must NOT reset passesInEpisode: the settle
    // pass it schedules should immediately hit the "already capped" branch
    // (no additional setBounds call) rather than treating the window as a
    // fresh, un-capped episode.
    const w = makeWin(OFF_SCREEN, { setBounds: vi.fn() })
    mockGetAllWindows.mockReturnValue([w])
    init()

    fireDisplayEvent() // lastEventAt = t0
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(1) // pass 1

    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(2) // verification pass hits the cap, arms slow retry

    // Fire a second event well within EPISODE_RESET_MS of t0 (total elapsed
    // since t0 so far: 2 * SETTLE_MS). Advancing by a small amount more
    // keeps us comfortably under EPISODE_RESET_MS from t0.
    vi.advanceTimersByTime(500)
    fireDisplayEvent('display-added') // gap from t0 is 2*SETTLE_MS + 500 < EPISODE_RESET_MS
    vi.advanceTimersByTime(SETTLE_MS)
    // Still capped — the event-triggered settle pass must not call
    // setBounds again (passesInEpisode was NOT reset).
    expect(w.setBounds).toHaveBeenCalledTimes(2)
  })

  it('resets the episode when a display event arrives after an EPISODE_RESET_MS gap since the last event', () => {
    // Positive counterpart: same stubborn-window setup, but this time we let
    // more than EPISODE_RESET_MS elapse since the last actual display event
    // (t0) — with no further events in between — before firing a fresh one.
    // Because onDisplayEvent measures the gap against `lastEventAt` (which is
    // NOT touched by internal pass re-runs), this fresh event must reset
    // passesInEpisode to 0, so the settle pass it schedules runs a full
    // evaluation again (a real setBounds call) instead of hitting the
    // capped branch.
    const w = makeWin(OFF_SCREEN, { setBounds: vi.fn() })
    mockGetAllWindows.mockReturnValue([w])
    init()

    fireDisplayEvent() // lastEventAt = t0
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(1) // pass 1
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(2) // verification pass hits the cap, arms slow retry

    // Let more than EPISODE_RESET_MS elapse since t0 with NO further event.
    // 2 * SETTLE_MS has already elapsed since t0 (pass1 + verification
    // pass); advance by just over the remainder so the TOTAL gap since t0
    // exceeds EPISODE_RESET_MS, while still landing before the armed slow
    // retry (scheduled EPISODE_RESET_MS after the cap was hit at t0+2*SETTLE_MS,
    // i.e. at t0+2*SETTLE_MS+EPISODE_RESET_MS) so we isolate the
    // onDisplayEvent gap-reset branch specifically, not scheduleResetRetry.
    vi.advanceTimersByTime(EPISODE_RESET_MS - SETTLE_MS * 2 + 50)
    fireDisplayEvent('display-metrics-changed') // gap from t0 now > EPISODE_RESET_MS
    vi.advanceTimersByTime(SETTLE_MS)
    // Fresh episode: passesInEpisode was reset to 0 by the gap check, so
    // this settle pass runs a full evaluation and calls setBounds again.
    expect(w.setBounds).toHaveBeenCalledTimes(3)
  })

  it('is re-initializable after dispose (idempotent init)', () => {
    init()
    init() // second init is a no-op
    expect(screenListeners.get('display-added')).toHaveLength(1)
    disposeWindowRescue()
    init()
    expect(screenListeners.get('display-added')).toHaveLength(1)
  })

  it('captures pass failures instead of throwing', () => {
    mockScreen.getAllDisplays.mockImplementation(() => { throw new Error('screen gone') })
    init()
    fireDisplayEvent()
    expect(() => vi.advanceTimersByTime(SETTLE_MS)).not.toThrow()
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), { source: 'windowRescue' })
  })

  it('re-checks after a transient failure instead of dropping the rescue opportunity', () => {
    // First pass throws (screen backend hiccup); the pass is inconclusive
    // and a bounded re-check is armed — the off-screen window is rescued on
    // the follow-up pass without any new display event.
    const w = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([w])
    mockScreen.getAllDisplays.mockImplementationOnce(() => { throw new Error('transient') })
    init()
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(1)
  })

  it('re-checks after a transient empty display snapshot instead of treating it as steady state', () => {
    const w = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([w])
    mockScreen.getAllDisplays.mockReturnValueOnce([]) // mid-hotplug snapshot
    init()
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SETTLE_MS) // displays are back → rescue
    expect(w.setBounds).toHaveBeenCalledTimes(1)
  })

  it('continues rescuing remaining windows when one window throws', () => {
    const bad = makeWin(OFF_SCREEN, {
      getBounds: () => { throw new Error('destroyed between getAllWindows and getBounds') },
    })
    const good = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([bad, good])
    init()
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(good.setBounds).toHaveBeenCalledTimes(1)
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), { source: 'windowRescue' })
  })

  it('dispose cancels a pending settle pass', () => {
    const w = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([w])
    init()
    fireDisplayEvent() // settle timer armed
    disposeWindowRescue()
    vi.advanceTimersByTime(SETTLE_MS * 10)
    expect(w.setBounds).not.toHaveBeenCalled()
  })

  it('dispose cancels a pending slow retry', () => {
    const w = makeWin(OFF_SCREEN, { setBounds: vi.fn() }) // stubborn
    mockGetAllWindows.mockReturnValue([w])
    init()
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS * 2) // 2 passes → cap → retry armed
    expect(w.setBounds).toHaveBeenCalledTimes(2)
    disposeWindowRescue()
    vi.advanceTimersByTime(EPISODE_RESET_MS * 2)
    expect(w.setBounds).toHaveBeenCalledTimes(2)
  })

  it('an event while capped replaces the old retry deadline without double-running', () => {
    const w = makeWin(OFF_SCREEN, { setBounds: vi.fn() })
    mockGetAllWindows.mockReturnValue([w])
    init()
    fireDisplayEvent() // t0
    vi.advanceTimersByTime(SETTLE_MS * 2) // passes 1+2 → cap; retry armed for t0+7000
    expect(w.setBounds).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(500)
    fireDisplayEvent() // t0+2500: gap < EPISODE_RESET_MS → budget NOT reset
    vi.advanceTimersByTime(SETTLE_MS) // t0+3500: capped pre-pass, re-arms retry for t0+8500
    expect(w.setBounds).toHaveBeenCalledTimes(2)

    // The old t0+7000 deadline must NOT fire (it was replaced, not duplicated).
    vi.advanceTimersByTime(3500) // → t0+7000
    expect(w.setBounds).toHaveBeenCalledTimes(2)

    // The replacement deadline fires the single autonomous retry.
    vi.advanceTimersByTime(1500) // → t0+8500
    expect(w.setBounds).toHaveBeenCalledTimes(3)
  })

  it('aggregates multiple rescued windows into one telemetry record per pass', () => {
    const w1 = makeWin(OFF_SCREEN)
    const w2 = makeWin({ ...OFF_SCREEN, y: 3000 })
    mockGetAllWindows.mockReturnValue([w1, w2])
    init()
    fireDisplayEvent()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(mockRecordEvent).toHaveBeenCalledTimes(1)
    expect(mockRecordEvent).toHaveBeenCalledWith('window.rescued', { windows_moved: 2, pass: 1 })
  })

  it('treats powerMonitor.resume as a rescue trigger', () => {
    // The WM can rearrange windows during suspend without emitting any
    // display-* event after wake — resume must schedule a pass by itself.
    const w = makeWin(OFF_SCREEN)
    mockGetAllWindows.mockReturnValue([w])
    init()
    firePowerResume()
    vi.advanceTimersByTime(SETTLE_MS)
    expect(w.setBounds).toHaveBeenCalledTimes(1)
  })
})
