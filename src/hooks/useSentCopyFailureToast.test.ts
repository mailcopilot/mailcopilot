// @vitest-environment jsdom
/**
 * Unit tests for src/hooks/useSentCopyFailureToast.ts
 *
 * Tests cover:
 *   - mail:sentCopyFailed listener registered on mount / unregistered on unmount
 *   - event with folder → state carries the folder path
 *   - event with folder: null / empty / non-string → state carries folder: null
 *   - malformed payloads (missing accountId, non-object, null) are ignored
 *   - dismissSentCopyFailure clears the state; a later event shows it again
 *   - BACKLOG §2.25 regression: subscription is mount-once across re-renders
 *     (preload off() cannot remove contextBridge listeners by identity)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useSentCopyFailureToast } from './useSentCopyFailureToast'

// ---------------------------------------------------------------------------
// window.api mock
// ---------------------------------------------------------------------------
const mockOn = vi.fn()
const mockOff = vi.fn()

Object.defineProperty(window, 'api', {
  value: { on: mockOn, off: mockOff },
  writable: true,
  configurable: true,
})

/** Fire a mail:sentCopyFailed IPC event via every registered listener. */
function fireSentCopyFailed(payload: unknown): void {
  const calls = mockOn.mock.calls as Array<[string, (payload: unknown) => void]>
  for (const [ch, fn] of calls) {
    if (ch === 'mail:sentCopyFailed') fn(payload)
  }
}

describe('useSentCopyFailureToast — subscription lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('registers mail:sentCopyFailed listener on mount', () => {
    renderHook(() => useSentCopyFailureToast())
    const calls = mockOn.mock.calls as Array<[string, unknown]>
    expect(calls.filter(([ch]) => ch === 'mail:sentCopyFailed')).toHaveLength(1)
  })

  it('unregisters the same listener instance on unmount', () => {
    const { unmount } = renderHook(() => useSentCopyFailureToast())
    const registered = (mockOn.mock.calls as Array<[string, unknown]>)
      .find(([ch]) => ch === 'mail:sentCopyFailed')?.[1]
    expect(registered).toBeTypeOf('function')

    unmount()

    const offCall = (mockOff.mock.calls as Array<[string, unknown]>)
      .find(([ch]) => ch === 'mail:sentCopyFailed')
    expect(offCall?.[1]).toBe(registered)
  })

  // BACKLOG §2.25 regression guard: preload off() is an identity-based no-op
  // for contextBridge-proxied listeners, so any re-subscription on re-render
  // would leak a live listener per render. The effect must be mount-once.
  it('subscribes exactly once across many re-renders', () => {
    const { rerender } = renderHook(() => useSentCopyFailureToast())
    for (let i = 0; i < 10; i++) rerender()

    const subs = (mockOn.mock.calls as Array<[string, unknown]>)
      .filter(([ch]) => ch === 'mail:sentCopyFailed')
    expect(subs).toHaveLength(1)
  })

  it('one event produces one state update even after many re-renders (no listener fan-out)', () => {
    const { result, rerender } = renderHook(() => useSentCopyFailureToast())
    for (let i = 0; i < 10; i++) rerender()

    // fireSentCopyFailed invokes EVERY registered listener — with the
    // mount-once fix there is exactly one, so exactly one update lands.
    act(() => { fireSentCopyFailed({ accountId: 1, folder: 'Sent' }) })

    expect(result.current.sentCopyFailure).toEqual({ accountId: 1, folder: 'Sent' })
  })

  it('does not throw when an event is fired after unmount', () => {
    const { unmount } = renderHook(() => useSentCopyFailureToast())
    unmount()
    // Preload off() is a silent no-op in production, so the listener may still
    // fire after unmount — it must not throw.
    expect(() => fireSentCopyFailed({ accountId: 1, folder: 'Sent' })).not.toThrow()
  })
})

describe('useSentCopyFailureToast — payload handling', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('starts with no failure', () => {
    const { result } = renderHook(() => useSentCopyFailureToast())
    expect(result.current.sentCopyFailure).toBeNull()
  })

  it('stores accountId and folder from the event payload', () => {
    const { result } = renderHook(() => useSentCopyFailureToast())

    act(() => { fireSentCopyFailed({ accountId: 7, folder: '[Gmail]/Отправленные' }) })

    expect(result.current.sentCopyFailure).toEqual({ accountId: 7, folder: '[Gmail]/Отправленные' })
  })

  it('normalises folder to null when it is null, empty or not a string', () => {
    const { result } = renderHook(() => useSentCopyFailureToast())

    act(() => { fireSentCopyFailed({ accountId: 1, folder: null }) })
    expect(result.current.sentCopyFailure).toEqual({ accountId: 1, folder: null })

    act(() => { fireSentCopyFailed({ accountId: 2, folder: '' }) })
    expect(result.current.sentCopyFailure).toEqual({ accountId: 2, folder: null })

    act(() => { fireSentCopyFailed({ accountId: 3, folder: 42 }) })
    expect(result.current.sentCopyFailure).toEqual({ accountId: 3, folder: null })
  })

  it('ignores malformed payloads', () => {
    const { result } = renderHook(() => useSentCopyFailureToast())

    act(() => {
      fireSentCopyFailed(null)
      fireSentCopyFailed('not an object')
      fireSentCopyFailed({ folder: 'Sent' }) // missing accountId
      fireSentCopyFailed({ accountId: 'one', folder: 'Sent' }) // non-numeric accountId
    })

    expect(result.current.sentCopyFailure).toBeNull()
  })

  it('latest event wins when several failures arrive', () => {
    const { result } = renderHook(() => useSentCopyFailureToast())

    act(() => {
      fireSentCopyFailed({ accountId: 1, folder: 'Sent' })
      fireSentCopyFailed({ accountId: 2, folder: 'Sent Items' })
    })

    expect(result.current.sentCopyFailure).toEqual({ accountId: 2, folder: 'Sent Items' })
  })
})

describe('useSentCopyFailureToast — dismiss', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { cleanup() })

  it('dismissSentCopyFailure clears the failure', () => {
    const { result } = renderHook(() => useSentCopyFailureToast())

    act(() => { fireSentCopyFailed({ accountId: 1, folder: 'Sent' }) })
    expect(result.current.sentCopyFailure).not.toBeNull()

    act(() => { result.current.dismissSentCopyFailure() })
    expect(result.current.sentCopyFailure).toBeNull()
  })

  it('a new event after dismiss shows the toast again', () => {
    const { result } = renderHook(() => useSentCopyFailureToast())

    act(() => { fireSentCopyFailed({ accountId: 1, folder: 'Sent' }) })
    act(() => { result.current.dismissSentCopyFailure() })
    act(() => { fireSentCopyFailed({ accountId: 1, folder: null }) })

    expect(result.current.sentCopyFailure).toEqual({ accountId: 1, folder: null })
  })
})
