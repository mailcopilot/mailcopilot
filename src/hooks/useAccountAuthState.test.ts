// @vitest-environment jsdom
/**
 * §2.157 — unit tests for src/hooks/useAccountAuthState.ts.
 *
 * Coverage:
 *   - pulls the snapshot on mount (a window that opened after the flag was
 *     raised must still show it)
 *   - applies `accounts:authStateChanged` broadcasts, including the clearing
 *     one (empty list)
 *   - a snapshot that resolves AFTER a broadcast is discarded (stale-pull race
 *     — otherwise a fixed account gets its badge back)
 *   - a rejected snapshot invoke never breaks the hook
 *   - malformed payloads degrade to "nothing flagged", never throw
 *   - subscribes on mount and unsubscribes the SAME listener instance on
 *     unmount (BACKLOG §2.25 leak class)
 *   - openAccountSettings opens the account editor and does NOT switch the
 *     current account
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { parseAuthStatePayload, useAccountAuthState } from './useAccountAuthState'

const mockOn = vi.fn()
const mockOff = vi.fn()
const mockInvoke = vi.fn()

Object.defineProperty(window, 'api', {
  value: { on: mockOn, off: mockOff, invoke: mockInvoke },
  writable: true,
  configurable: true,
})

vi.mock('../sentry', () => ({ captureException: vi.fn() }))

const mockRecordEvent = vi.hoisted(() => vi.fn())
vi.mock('../utils/metrics', () => ({ recordEvent: mockRecordEvent }))

function fire(channel: string, payload: unknown): void {
  const calls = mockOn.mock.calls as Array<[string, (...args: unknown[]) => void]>
  for (const [ch, fn] of calls) {
    if (ch === channel) fn(payload)
  }
}

/** The hook writes local diagnosis lines through `console.info` (see its
 *  module header). Silenced here for every test — a spy, not a mute, because
 *  the instrumentation tests below assert on what was written. */
let infoSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockOn.mockReset()
  mockOff.mockReset()
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue({ needsReauth: [] })
  mockRecordEvent.mockReset()
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  infoSpy.mockRestore()
})

describe('parseAuthStatePayload', () => {
  it('keeps integer ids only', () => {
    expect(parseAuthStatePayload({ needsReauth: [1, 2] })).toEqual([1, 2])
    expect(parseAuthStatePayload({ needsReauth: [1, '2', null, 3.5, 4] })).toEqual([1, 4])
  })

  it('degrades any unexpected shape to an empty list', () => {
    expect(parseAuthStatePayload(undefined)).toEqual([])
    expect(parseAuthStatePayload(null)).toEqual([])
    expect(parseAuthStatePayload({})).toEqual([])
    expect(parseAuthStatePayload({ needsReauth: 'nope' })).toEqual([])
    expect(parseAuthStatePayload('nope')).toEqual([])
  })
})

describe('useAccountAuthState — state sources', () => {
  it('pulls the current snapshot on mount', async () => {
    mockInvoke.mockResolvedValue({ needsReauth: [3, 7] })
    const { result } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(result.current.needsReauth.size).toBe(2))
    expect(mockInvoke).toHaveBeenCalledWith('accounts:authState')
    expect([...result.current.needsReauth].sort()).toEqual([3, 7])
  })

  it('applies broadcasts, including the clearing one', async () => {
    const { result } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockOn).toHaveBeenCalled())

    act(() => fire('accounts:authStateChanged', { needsReauth: [5] }))
    expect(result.current.needsReauth.has(5)).toBe(true)

    act(() => fire('accounts:authStateChanged', { needsReauth: [] }))
    expect(result.current.needsReauth.size).toBe(0)
  })

  it('discards a snapshot that resolves after a broadcast', async () => {
    let resolveSnapshot: (v: unknown) => void = () => {}
    mockInvoke.mockImplementation(
      () => new Promise((resolve) => { resolveSnapshot = resolve }),
    )
    const { result } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockOn).toHaveBeenCalled())

    // The user fixed the account while the initial pull was still in flight.
    act(() => fire('accounts:authStateChanged', { needsReauth: [] }))
    await act(async () => {
      resolveSnapshot({ needsReauth: [9] })
      await Promise.resolve()
    })

    expect(result.current.needsReauth.size).toBe(0)
  })

  it('survives a rejected snapshot invoke', async () => {
    mockInvoke.mockRejectedValue(new Error('main is busy'))
    const { result } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled())
    expect(result.current.needsReauth.size).toBe(0)

    // A later broadcast still works.
    act(() => fire('accounts:authStateChanged', { needsReauth: [2] }))
    expect(result.current.needsReauth.has(2)).toBe(true)
  })

  it('ignores a malformed broadcast payload without throwing', async () => {
    const { result } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockOn).toHaveBeenCalled())
    act(() => fire('accounts:authStateChanged', { needsReauth: [4] }))
    expect(() => act(() => fire('accounts:authStateChanged', 'garbage'))).not.toThrow()
    expect(result.current.needsReauth.size).toBe(0)
  })
})

/**
 * Field diagnosis instrumentation (incident 2026-08-24), renderer half.
 *
 * Main can prove a payload LEFT; this side proves it ARRIVED, with its size and
 * ids. Those two failures look identical from the user's chair — no badge
 * either way — so the pair of logs tells them apart.
 *
 * Scope boundary, asserted below rather than assumed: the hook stops at the
 * payload. Whether a badge was DISPLAYED is decided one layer above, in App.tsx,
 * against that component's own account state — the hook cannot see it and must
 * not imply it. So these tests check the honest fields (size, ids, parsedAway,
 * discarded) and check that the hook makes no attempt to guess the rest.
 */
describe('useAccountAuthState — diagnosis instrumentation', () => {
  /** Fields of the first line whose message contains `suffix`. */
  function lineFields(suffix: string): Record<string, unknown> | undefined {
    const call = infoSpy.mock.calls.find(c => String(c[0]).includes(suffix))
    return call?.[1] as Record<string, unknown> | undefined
  }

  it('records that a broadcast arrived, with its size and ids', async () => {
    renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockOn).toHaveBeenCalled())
    act(() => fire('accounts:authStateChanged', { needsReauth: [5, 6] }))
    expect(lineFields('broadcast arrived')).toMatchObject({ size: 2, ids: '5,6' })
  })

  it('records how many ids the shape filter dropped, so a malformed payload is not read as "cleared"', async () => {
    renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockOn).toHaveBeenCalled())
    act(() => fire('accounts:authStateChanged', { needsReauth: [5, '6', null] }))
    expect(lineFields('broadcast arrived')).toMatchObject({ size: 1, parsedAway: 2 })
    act(() => fire('accounts:authStateChanged', 'garbage'))
    expect(
      infoSpy.mock.calls
        .filter(c => String(c[0]).includes('broadcast arrived'))
        .map(c => (c[1] as Record<string, unknown>).parsedAway),
    ).toEqual([2, 'unparsable'])
  })

  it('records the snapshot answer and whether it was discarded as stale', async () => {
    mockInvoke.mockResolvedValue({ needsReauth: [9] })
    renderHook(() => useAccountAuthState())
    await waitFor(() => expect(lineFields('snapshot pull answered')).toBeDefined())
    expect(lineFields('snapshot pull answered')).toMatchObject({ size: 1, ids: '9', discarded: false })
  })

  /**
   * The regression this file previously enshrined instead of catching.
   *
   * An earlier version pulled a fresh `accounts:list` on every non-empty
   * payload and logged the intersection as `visible`. The badge is not filtered
   * against that list — it is filtered in App.tsx against App.tsx's own account
   * state, which can lag. So `visible: 1` was logged in exactly the stale-state
   * case where no badge appeared, pointing the next investigation at main.
   * The old test stubbed the same fresh list and so could only ever confirm the
   * helper's arithmetic against itself.
   *
   * Guard against its return: the hook must issue no account-list round trip,
   * and must claim nothing about display.
   */
  it('makes no attempt to guess whether a badge was displayed', async () => {
    renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockOn).toHaveBeenCalled())
    mockInvoke.mockClear()

    act(() => fire('accounts:authStateChanged', { needsReauth: [5, 99] }))
    await waitFor(() => expect(lineFields('broadcast arrived')).toBeDefined())

    // No second round trip: the only channel this hook invokes is the snapshot.
    expect(mockInvoke).not.toHaveBeenCalledWith('accounts:list')
    for (const [channel] of mockInvoke.mock.calls) {
      expect(channel).not.toBe('accounts:list')
    }

    // And no field or message claims the user saw anything. `visible` is named
    // explicitly: it is the word the removed helper used.
    const logged = JSON.stringify(infoSpy.mock.calls).toLowerCase()
    for (const claim of ['visible', 'displayed', 'shown', 'rendered', 'badge', 'filteredout']) {
      expect(logged).not.toContain(claim)
    }
  })

  it('reports the ids honestly — arrival only, whether or not the window knows the account', async () => {
    renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockOn).toHaveBeenCalled())
    // 99 addresses no account this window holds. The hook says so about
    // neither id: it reports what arrived, and stops there.
    act(() => fire('accounts:authStateChanged', { needsReauth: [5, 99] }))
    expect(lineFields('broadcast arrived')).toMatchObject({ size: 2, ids: '5,99' })
  })

  it('never lets diagnosis gate the badge', async () => {
    // console.info itself failing must not cost the user the badge.
    infoSpy.mockImplementation(() => { throw new Error('devtools sink down') })
    const { result } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockOn).toHaveBeenCalled())
    expect(() => act(() => fire('accounts:authStateChanged', { needsReauth: [5] }))).not.toThrow()
    expect(result.current.needsReauth.has(5)).toBe(true)
  })

  it('logs no account field — ids and counters only', async () => {
    mockInvoke.mockResolvedValue({ needsReauth: [5] })
    renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockOn).toHaveBeenCalled())
    act(() => fire('accounts:authStateChanged', { needsReauth: [5] }))
    await waitFor(() => expect(lineFields('broadcast arrived')).toBeDefined())
    const logged = JSON.stringify(infoSpy.mock.calls)
    expect(logged).not.toContain('@')
    expect(logged).not.toContain('example.com')
  })
})

describe('useAccountAuthState — subscription discipline', () => {
  it('unsubscribes the same listener instance on unmount', async () => {
    const { unmount } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockOn).toHaveBeenCalledWith('accounts:authStateChanged', expect.any(Function)))
    const listener = mockOn.mock.calls.find(c => c[0] === 'accounts:authStateChanged')?.[1]
    unmount()
    expect(mockOff).toHaveBeenCalledWith('accounts:authStateChanged', listener)
  })
})

describe('useAccountAuthState — openAccountSettings', () => {
  it('opens the account editor for that id and switches nothing', async () => {
    const { result } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled())
    mockInvoke.mockClear()

    act(() => result.current.openAccountSettings(11))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ui:openAccount', 'edit', 11))
    expect(mockInvoke).not.toHaveBeenCalledWith('accounts:setCurrent', expect.anything())
  })

  it('swallows an invoke rejection', async () => {
    const { result } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled())
    mockInvoke.mockRejectedValue(new Error('window refused'))
    expect(() => act(() => result.current.openAccountSettings(1))).not.toThrow()
  })
})

/**
 * §2.157 telemetry — the middle of the funnel. Recorded here because main
 * serves `ui:openAccount` for the ordinary Settings path too and cannot tell a
 * badge click apart from any other way of opening the same window.
 */
describe('useAccountAuthState — badge-click telemetry', () => {
  it('records one tagless click event per click', async () => {
    const { result } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled())

    act(() => result.current.openAccountSettings(11))
    expect(mockRecordEvent).toHaveBeenCalledTimes(1)
    // No account id, no tags at all — the click count IS the aggregate.
    expect(mockRecordEvent).toHaveBeenCalledWith('account.reauth_badge_clicked')
    expect(JSON.stringify(mockRecordEvent.mock.calls)).not.toContain('11')

    act(() => result.current.openAccountSettings(12))
    expect(mockRecordEvent).toHaveBeenCalledTimes(2)
  })

  it('records nothing until the user actually clicks', async () => {
    renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled())
    act(() => fire('accounts:authStateChanged', { needsReauth: [3] }))
    // Showing the badge is not using it — that is what the main-side
    // account.reauth_flagged event counts.
    expect(mockRecordEvent).not.toHaveBeenCalled()
  })

  it('still opens the editor when the metrics sink throws', async () => {
    mockRecordEvent.mockImplementation(() => {
      throw new Error('metrics bridge down')
    })
    const { result } = renderHook(() => useAccountAuthState())
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled())
    mockInvoke.mockClear()

    expect(() => act(() => result.current.openAccountSettings(7))).not.toThrow()
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ui:openAccount', 'edit', 7))
  })
})
