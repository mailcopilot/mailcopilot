// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { isUsableExpansion, useShowFullMessage, type ShowFullMessageTarget } from './useShowFullMessage'
import type { MessageDetails } from '../../packages/net/types'

const mockInvoke = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

/** A promise plus its resolvers, so a test can control exactly when the
 *  in-flight IPC call settles. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const TARGET_A: ShowFullMessageTarget = { accountId: 1, folder: 'INBOX', uid: 100 }
const TARGET_B: ShowFullMessageTarget = { accountId: 1, folder: 'INBOX', uid: 200 }

function detailsFor(uid: number): MessageDetails {
  return { uid, envelope: { subject: `full-${uid}` }, text: `full body ${uid}` }
}

describe('useShowFullMessage', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('starts idle: not loading, and requestFullMessage is a no-op with no target', () => {
    const onDetails = vi.fn()
    const { result } = renderHook(() => useShowFullMessage(null, onDetails))

    expect(result.current.loadingFull).toBe(false)
    act(() => result.current.requestFullMessage())
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('invokes net:messageDetails with { full: true } on the existing channel, and applies the result', async () => {
    const onDetails = vi.fn()
    const { promise, resolve } = deferred<MessageDetails>()
    mockInvoke.mockReturnValueOnce(promise)

    const { result } = renderHook(() => useShowFullMessage(TARGET_A, onDetails))

    act(() => result.current.requestFullMessage())
    expect(result.current.loadingFull).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith(
      'net:messageDetails', TARGET_A.accountId, TARGET_A.folder, TARGET_A.uid, { full: true },
    )
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    await act(async () => { resolve(detailsFor(100)); await promise })

    expect(result.current.loadingFull).toBe(false)
    expect(onDetails).toHaveBeenCalledTimes(1)
    expect(onDetails).toHaveBeenCalledWith(detailsFor(100))
  })

  it('does nothing on a second call while a request is already in flight', () => {
    const onDetails = vi.fn()
    mockInvoke.mockReturnValue(new Promise<MessageDetails>(() => { /* never settles */ }))

    const { result } = renderHook(() => useShowFullMessage(TARGET_A, onDetails))

    act(() => result.current.requestFullMessage())
    act(() => result.current.requestFullMessage())
    act(() => result.current.requestFullMessage())

    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('drops the result if the user switched to a different message before it arrived', async () => {
    const onDetails = vi.fn()
    const { promise, resolve } = deferred<MessageDetails>()
    mockInvoke.mockReturnValueOnce(promise)

    const { result, rerender } = renderHook(
      ({ target }: { target: ShowFullMessageTarget }) => useShowFullMessage(target, onDetails),
      { initialProps: { target: TARGET_A } },
    )

    act(() => result.current.requestFullMessage())
    expect(result.current.loadingFull).toBe(true)

    // The user closes message A and opens message B before the re-parse for A
    // has come back — switching resets the in-flight flag for the new message.
    rerender({ target: TARGET_B })
    expect(result.current.loadingFull).toBe(false)

    await act(async () => { resolve(detailsFor(100)); await promise })

    // The stale result for A must never reach the message B is now looking at.
    expect(onDetails).not.toHaveBeenCalled()
    expect(result.current.loadingFull).toBe(false)
  })

  it('fails silently: an IPC rejection clears loading and never calls onDetails', async () => {
    const onDetails = vi.fn()
    const { promise, reject } = deferred<MessageDetails>()
    mockInvoke.mockReturnValueOnce(promise)

    const { result } = renderHook(() => useShowFullMessage(TARGET_A, onDetails))

    act(() => result.current.requestFullMessage())
    await act(async () => {
      reject(new Error('ipc failed'))
      await promise.catch(() => { /* expected */ })
    })

    expect(result.current.loadingFull).toBe(false)
    expect(onDetails).not.toHaveBeenCalled()

    // The banner must still be requestable again after a failure — a caller
    // is not left permanently stuck in the loading state.
    mockInvoke.mockReturnValueOnce(Promise.resolve(detailsFor(100)))
    await act(async () => { result.current.requestFullMessage() })
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('lets a new request go out for the same message once the previous one settled', async () => {
    const onDetails = vi.fn()
    mockInvoke.mockResolvedValueOnce(detailsFor(100))
    mockInvoke.mockResolvedValueOnce(detailsFor(100))

    const { result } = renderHook(() => useShowFullMessage(TARGET_A, onDetails))

    await act(async () => { result.current.requestFullMessage() })
    expect(onDetails).toHaveBeenCalledTimes(1)

    await act(async () => { result.current.requestFullMessage() })
    expect(mockInvoke).toHaveBeenCalledTimes(2)
    expect(onDetails).toHaveBeenCalledTimes(2)
  })
})

/**
 * §2.145 fix wave 1.1 — a resolved promise is not a successful expansion.
 *
 * The raised-tier read goes through the whole `net:messageDetails` pipeline,
 * which has degraded answers that RESOLVE rather than throw. With the network
 * down and the cached `.eml` evicted, `{ full: true }` comes back as an
 * `offlineFallback` envelope with no body — and installing it replaced a
 * perfectly readable clipped body with a "not available offline" placeholder.
 * The user clicked "show more" and got less.
 */
describe('useShowFullMessage — usable results only', () => {
  beforeEach(() => { mockInvoke.mockReset() })

  it('classifies what may replace what is on screen', () => {
    // Real content — the ordinary success.
    expect(isUsableExpansion({ uid: 1, text: 'body' })).toBe(true)
    expect(isUsableExpansion({ uid: 1, html: '<p>body</p>' })).toBe(true)
    // Bodyless BUT cap-bearing: the pipeline saying something true about the
    // MESSAGE (it is past the hard cap), not about the network.
    expect(isUsableExpansion({
      uid: 1,
      parseCap: { kind: 'hard', rawBytes: 200e6, limitBytes: 100e6 },
    })).toBe(true)

    // The degraded answers, which must not replace a readable body.
    expect(isUsableExpansion({ uid: 1, offlineFallback: true })).toBe(false)
    // offlineFallback wins even when a body came along with it.
    expect(isUsableExpansion({ uid: 1, text: 'stale', offlineFallback: true })).toBe(false)
    expect(isUsableExpansion({ uid: 1 })).toBe(false)
    expect(isUsableExpansion({ uid: 1, envelope: { subject: 'headers only' } })).toBe(false)
    expect(isUsableExpansion(null)).toBe(false)
    expect(isUsableExpansion(undefined)).toBe(false)
  })

  it('keeps the clipped body when the expansion comes back as an offline fallback', async () => {
    const onDetails = vi.fn()
    const { promise, resolve } = deferred<MessageDetails>()
    mockInvoke.mockReturnValueOnce(promise)

    const { result } = renderHook(() => useShowFullMessage(TARGET_A, onDetails))
    act(() => result.current.requestFullMessage())
    expect(result.current.loadingFull).toBe(true)

    await act(async () => {
      resolve({ uid: 100, envelope: { subject: 'full-100' }, offlineFallback: true })
      await promise
    })

    // Nothing installed — the caller keeps rendering the clipped body it has.
    expect(onDetails).not.toHaveBeenCalled()
    // ...and the button is usable again, so a later retry is possible.
    expect(result.current.loadingFull).toBe(false)
  })

  it('keeps the clipped body when the expansion comes back bodyless', async () => {
    const onDetails = vi.fn()
    const { promise, resolve } = deferred<MessageDetails>()
    mockInvoke.mockReturnValueOnce(promise)

    const { result } = renderHook(() => useShowFullMessage(TARGET_A, onDetails))
    act(() => result.current.requestFullMessage())

    await act(async () => {
      resolve({ uid: 100, envelope: { subject: 'full-100' } })
      await promise
    })

    expect(onDetails).not.toHaveBeenCalled()
    expect(result.current.loadingFull).toBe(false)
  })

  it('still installs a hard-cap result, which is bodyless but true about the message', async () => {
    const onDetails = vi.fn()
    const { promise, resolve } = deferred<MessageDetails>()
    mockInvoke.mockReturnValueOnce(promise)

    const { result } = renderHook(() => useShowFullMessage(TARGET_A, onDetails))
    act(() => result.current.requestFullMessage())

    const hardCapped: MessageDetails = {
      uid: 100,
      envelope: { subject: 'enormous' },
      parseCap: { kind: 'hard', rawBytes: 200 * 1024 * 1024, limitBytes: 100 * 1024 * 1024 },
    }
    await act(async () => { resolve(hardCapped); await promise })

    expect(onDetails).toHaveBeenCalledWith(hardCapped)
  })
})

/**
 * §2.145 fix wave 1.1 — the "same message" check, and the limit of what this
 * suite can prove about it.
 *
 * The check now compares the captured key against a ref assigned DURING RENDER
 * (`currentKeyRef`), not against the in-flight bookkeeping that a passive
 * effect clears. The defect it closes is an interleaving: a response settling
 * after the commit that changed the message but BEFORE that effect ran found
 * the old key still in place, matched, and installed message A's body under
 * message B's header.
 *
 * That exact interleaving is NOT reproducible through React Testing Library —
 * `rerender` is wrapped in `act()`, which flushes passive effects before it
 * returns, so a test can never observe the window between commit and effect.
 * Stated here rather than papered over with a test that appears to cover it:
 * the test below proves the OUTCOME (a stale result is dropped), and the fix is
 * correct by construction (a value assigned during render is current the
 * instant the commit lands, so there is no window to hit), but neither is the
 * same as reproducing the race. Closing that properly needs a harness that can
 * schedule a microtask between commit and effect flush.
 */
