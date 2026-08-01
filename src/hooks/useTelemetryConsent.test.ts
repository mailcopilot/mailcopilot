// @vitest-environment jsdom
/**
 * Unit tests for src/hooks/useTelemetryConsent.ts (§2.82).
 *
 * Coverage:
 *   - `needed: true` → phase `required` (the gate that keeps <App/> unmounted,
 *     AC2/AC4); `needed: false` → `resolved`
 *   - disabled (child window) → `resolved` with no IPC at all
 *   - AC12: a throwing / missing / malformed `telemetry:consentState` resolves
 *     the gate instead of blocking the app, and a wedged main process is
 *     released by the timeout
 *   - AC5: Escape and `decide(false)` produce the byte-identical payload
 *     `{ granted: false }`, and the Escape binding only exists while the screen
 *     is up
 *   - the renderer sends `granted` and nothing else (main stamps version/at)
 *   - re-entrancy: a second click while the first is in flight is dropped
 *   - a failing `telemetry:setConsent` still releases the gate (fail-open UI,
 *     fail-closed sending — no record means the screen asks again next start)
 *   - useTelemetryConsentNeeded re-reads on settings:changed and unsubscribes
 *     the same listener instance on unmount (BACKLOG §2.25 leak class)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  CONSENT_STATE_TIMEOUT_MS,
  parseConsentNeeded,
  useTelemetryConsent,
  useTelemetryConsentNeeded,
} from './useTelemetryConsent'

const mockOn = vi.fn()
const mockOff = vi.fn()
const mockInvoke = vi.fn()

Object.defineProperty(window, 'api', {
  value: { on: mockOn, off: mockOff, invoke: mockInvoke },
  writable: true,
  configurable: true,
})

const captureException = vi.fn()
vi.mock('../sentry', () => ({ captureException: (...args: unknown[]) => captureException(...args) }))

/** Replay a broadcast to every listener registered for `channel`. */
function fire(channel: string): void {
  const calls = mockOn.mock.calls as Array<[string, (payload: unknown) => void]>
  for (const [ch, fn] of calls) {
    if (ch === channel) fn(undefined)
  }
}

/** Default: nothing to ask, every other invoke resolves. */
function stateReply(needed: boolean) {
  return (channel: string) => {
    if (channel === 'telemetry:consentState') return Promise.resolve({ needed, version: 1 })
    return Promise.resolve({ ok: true, granted: true })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockImplementation(stateReply(false))
})
afterEach(() => { cleanup() })

describe('parseConsentNeeded', () => {
  it('reads needed: true only from a well-formed reply', () => {
    expect(parseConsentNeeded({ needed: true, version: 1 })).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'needed'],
    ['a number', 7],
    ['an object without needed', { version: 1 }],
    ['needed as a truthy string', { needed: 'true' }],
    ['needed as 1', { needed: 1 }],
  ])('reads %s as "do not ask"', (_label, payload) => {
    expect(parseConsentNeeded(payload)).toBe(false)
  })
})

describe('useTelemetryConsent — gate', () => {
  it('shows the screen when main reports needed: true', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))
    expect(mockInvoke).toHaveBeenCalledWith('telemetry:consentState')
  })

  it('resolves without a screen when a decision is already on record', async () => {
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
  })

  it('starts in checking so <App/> is never mounted behind the screen', () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent())
    expect(result.current.phase).toBe('checking')
  })

  it('never queries in a child window and resolves immediately (enabled: false)', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent({ enabled: false }))
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  // AC12 — the UI fails open; telemetry stays off because main never wrote a record.
  it('resolves the gate when the state query rejects', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'telemetry:consentState'
        ? Promise.reject(new Error('settings:get exploded'))
        : Promise.resolve({ ok: true }))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'useTelemetryConsent.consentState' }),
    )
  })

  it('resolves the gate when the preload bridge is missing entirely', async () => {
    const api = window.api
    Object.defineProperty(window, 'api', { value: undefined, writable: true, configurable: true })
    try {
      const { result } = renderHook(() => useTelemetryConsent())
      await waitFor(() => expect(result.current.phase).toBe('resolved'))
    } finally {
      Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true })
    }
  })

  it('resolves the gate when main never answers (timeout, not a permanent blank window)', async () => {
    vi.useFakeTimers()
    try {
      mockInvoke.mockImplementation(() => new Promise(() => { /* never settles */ }))
      const { result } = renderHook(() => useTelemetryConsent())
      expect(result.current.phase).toBe('checking')
      await act(async () => { await vi.advanceTimersByTimeAsync(CONSENT_STATE_TIMEOUT_MS + 1) })
      expect(result.current.phase).toBe('resolved')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useTelemetryConsent — decide', () => {
  it('sends exactly { granted } — main stamps the version and timestamp', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))

    act(() => { result.current.decide(true) })
    await waitFor(() => expect(result.current.phase).toBe('resolved'))

    const call = mockInvoke.mock.calls.find(([c]) => c === 'telemetry:setConsent')
    expect(call?.[1]).toEqual({ granted: true })
    expect(Object.keys(call?.[1] as object)).toEqual(['granted'])
  })

  // AC5 — refusing by keyboard and refusing by button must be one code path.
  it('Escape produces the same payload as the "don\'t allow" button', async () => {
    mockInvoke.mockImplementation(stateReply(true))

    const first = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(first.result.current.phase).toBe('required'))
    act(() => { first.result.current.decide(false) })
    await waitFor(() => expect(first.result.current.phase).toBe('resolved'))
    const byButton = mockInvoke.mock.calls.filter(([c]) => c === 'telemetry:setConsent')
    first.unmount()

    mockInvoke.mockClear()
    mockInvoke.mockImplementation(stateReply(true))
    const second = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(second.result.current.phase).toBe('required'))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    await waitFor(() => expect(second.result.current.phase).toBe('resolved'))
    const byEscape = mockInvoke.mock.calls.filter(([c]) => c === 'telemetry:setConsent')

    expect(byEscape).toEqual(byButton)
    expect(byEscape[0]?.[1]).toEqual({ granted: false })
  })

  it('ignores Escape once the decision is made (no listener left behind)', async () => {
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(mockInvoke.mock.calls.some(([c]) => c === 'telemetry:setConsent')).toBe(false)
  })

  it('ignores other keys while the screen is up', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    })
    expect(mockInvoke.mock.calls.some(([c]) => c === 'telemetry:setConsent')).toBe(false)
    expect(result.current.phase).toBe('required')
  })

  it('drops a second answer while the first is in flight', async () => {
    let release: ((value: unknown) => void) | undefined
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'telemetry:consentState') return Promise.resolve({ needed: true, version: 1 })
      return new Promise(resolve => { release = resolve })
    })
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))

    act(() => { result.current.decide(false) })
    act(() => { result.current.decide(true) })
    await waitFor(() => expect(result.current.submitting).toBe(true))

    const sends = mockInvoke.mock.calls.filter(([c]) => c === 'telemetry:setConsent')
    expect(sends).toHaveLength(1)
    expect(sends[0][1]).toEqual({ granted: false })

    await act(async () => { release?.({ ok: true, granted: false }) })
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
  })

  it('releases the gate when the write fails — the app is never held hostage', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'telemetry:consentState'
        ? Promise.resolve({ needed: true, version: 1 })
        : Promise.reject(new Error('save_failed')))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))

    act(() => { result.current.decide(false) })
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
    expect(result.current.submitting).toBe(false)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'useTelemetryConsent.setConsent' }),
    )
  })
})

describe('useTelemetryConsentNeeded — Settings → About', () => {
  it('reports whether the About switch is currently clamped', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsentNeeded())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('re-reads after settings:changed so an answer elsewhere is picked up', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsentNeeded())
    await waitFor(() => expect(result.current).toBe(true))

    mockInvoke.mockImplementation(stateReply(false))
    await act(async () => { fire('settings:changed') })
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('unsubscribes the same listener instance on unmount', () => {
    const { unmount } = renderHook(() => useTelemetryConsentNeeded())
    const registered = (mockOn.mock.calls as Array<[string, unknown]>)
      .find(([c]) => c === 'settings:changed')?.[1]
    unmount()
    const removed = (mockOff.mock.calls as Array<[string, unknown]>)
      .find(([c]) => c === 'settings:changed')?.[1]
    expect(registered).toBeTypeOf('function')
    expect(removed).toBe(registered)
  })

  it('stays false when the query fails (no scary hint on a broken IPC)', async () => {
    mockInvoke.mockImplementation(() => Promise.reject(new Error('nope')))
    const { result } = renderHook(() => useTelemetryConsentNeeded())
    await waitFor(() => expect(captureException).toHaveBeenCalled())
    expect(result.current).toBe(false)
  })
})
