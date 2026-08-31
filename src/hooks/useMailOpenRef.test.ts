// @vitest-environment jsdom
/**
 * Unit tests for src/hooks/useMailOpenRef.ts (§2.99).
 *
 * Coverage:
 *   - subscribes to mail:openRef on mount and unsubscribes the SAME listener
 *     instance on unmount (leak class: a stale listener keeps navigating a
 *     dead component)
 *   - malformed payloads are dropped rather than forwarded, so a bad ref can
 *     never drive navigation with NaN / empty identifiers
 *   - a handler that changes between renders does not resubscribe, and the
 *     newest handler is the one invoked
 *   - a rejecting handler does not escape as an unhandled rejection
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { parseMailOpenRef, useMailOpenRef } from './useMailOpenRef'

const mockOn = vi.fn()
const mockOff = vi.fn()

Object.defineProperty(window, 'api', {
  value: { on: mockOn, off: mockOff, invoke: vi.fn() },
  writable: true,
  configurable: true,
})

function fire(payload: unknown): void {
  const calls = mockOn.mock.calls as Array<[string, (payload: unknown) => void]>
  for (const [ch, fn] of calls) {
    if (ch === 'mail:openRef') fn(payload)
  }
}

beforeEach(() => {
  mockOn.mockClear()
  mockOff.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('parseMailOpenRef', () => {
  it('accepts a well-formed ref', () => {
    expect(parseMailOpenRef({ accountId: 1, folder: 'INBOX', uid: 42 }))
      .toEqual({ accountId: 1, folder: 'INBOX', uid: 42 })
  })

  it('keeps folder names verbatim, including non-ASCII and separators', () => {
    expect(parseMailOpenRef({ accountId: 2, folder: '[Gmail]/Вся почта', uid: 7 }))
      .toEqual({ accountId: 2, folder: '[Gmail]/Вся почта', uid: 7 })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a non-object', 'INBOX'],
    ['an empty object', {}],
    ['a missing folder', { accountId: 1, uid: 42 }],
    ['an empty folder', { accountId: 1, folder: '', uid: 42 }],
    ['a non-string folder', { accountId: 1, folder: 5, uid: 42 }],
    ['a zero accountId', { accountId: 0, folder: 'INBOX', uid: 42 }],
    ['a negative accountId', { accountId: -1, folder: 'INBOX', uid: 42 }],
    ['a NaN accountId', { accountId: Number.NaN, folder: 'INBOX', uid: 42 }],
    ['a fractional accountId', { accountId: 1.5, folder: 'INBOX', uid: 42 }],
    ['a string accountId', { accountId: '1', folder: 'INBOX', uid: 42 }],
    ['a zero uid', { accountId: 1, folder: 'INBOX', uid: 0 }],
    ['a NaN uid', { accountId: 1, folder: 'INBOX', uid: Number.NaN }],
    ['an infinite uid', { accountId: 1, folder: 'INBOX', uid: Number.POSITIVE_INFINITY }],
    ['a string uid', { accountId: 1, folder: 'INBOX', uid: '42' }],
  ])('rejects %s', (_label, payload) => {
    expect(parseMailOpenRef(payload)).toBeNull()
  })
})

describe('useMailOpenRef', () => {
  it('subscribes on mount and unsubscribes the same listener on unmount', () => {
    const { unmount } = renderHook(() => useMailOpenRef(vi.fn()))

    expect(mockOn).toHaveBeenCalledTimes(1)
    expect(mockOn.mock.calls[0][0]).toBe('mail:openRef')

    const listener = mockOn.mock.calls[0][1]
    unmount()

    expect(mockOff).toHaveBeenCalledTimes(1)
    expect(mockOff.mock.calls[0][0]).toBe('mail:openRef')
    // Same instance — an inequality here would leak the subscription.
    expect(mockOff.mock.calls[0][1]).toBe(listener)
  })

  it('forwards a valid ref to the handler', () => {
    const onOpen = vi.fn()
    renderHook(() => useMailOpenRef(onOpen))

    fire({ accountId: 3, folder: 'Archive', uid: 99 })

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith({ accountId: 3, folder: 'Archive', uid: 99 })
  })

  it('drops a malformed ref without calling the handler', () => {
    const onOpen = vi.fn()
    renderHook(() => useMailOpenRef(onOpen))

    fire({ accountId: 'x', folder: 'INBOX', uid: 1 })
    fire(null)
    fire({ accountId: 1, folder: '', uid: 1 })

    expect(onOpen).not.toHaveBeenCalled()
  })

  it('calls the newest handler without resubscribing', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(
      ({ handler }: { handler: () => void }) => useMailOpenRef(handler),
      { initialProps: { handler: first } },
    )

    rerender({ handler: second })
    fire({ accountId: 1, folder: 'INBOX', uid: 5 })

    expect(mockOn).toHaveBeenCalledTimes(1)
    expect(mockOff).not.toHaveBeenCalled()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('swallows a rejecting handler (a deleted message must not crash the window)', async () => {
    const onOpen = vi.fn().mockRejectedValue(new Error('gone'))
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)

    renderHook(() => useMailOpenRef(onOpen))
    fire({ accountId: 1, folder: 'INBOX', uid: 5 })

    await new Promise(resolve => setTimeout(resolve, 0))
    window.removeEventListener('unhandledrejection', unhandled)

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('does nothing when the preload bridge is absent', () => {
    const original = window.api
    Object.defineProperty(window, 'api', { value: undefined, writable: true, configurable: true })

    expect(() => renderHook(() => useMailOpenRef(vi.fn()))).not.toThrow()

    Object.defineProperty(window, 'api', { value: original, writable: true, configurable: true })
  })
})
