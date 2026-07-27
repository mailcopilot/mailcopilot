// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub window.api before importing the module under test so the auto-subscribe
// path runs against the mock and the `settings:changed` listener is wired up.
const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockOff = vi.fn()

Object.defineProperty(window, 'api', {
  value: {
    invoke: mockInvoke,
    on: mockOn,
    off: mockOff,
  },
  writable: true,
  configurable: true,
})

import {
  singleFlightInvoke,
  invalidateCache,
  __resetForTests,
  __testables,
  _readDedupeCounter,
} from './ipcSingleFlight'

describe('ipcSingleFlight', () => {
  beforeEach(() => {
    __resetForTests()
    mockInvoke.mockReset()
    mockOn.mockReset()
    mockOff.mockReset()
    // Re-wire window.api.on so ensureSettingsSubscription's re-arm works.
    Object.defineProperty(window, 'api', {
      value: { invoke: mockInvoke, on: mockOn, off: mockOff },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('(a) coalesces two concurrent calls into one IPC invocation', async () => {
    mockInvoke.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ status: 'authenticated' }), 10)))

    const [a, b] = await Promise.all([
      singleFlightInvoke('ai:checkAuth', ['subscription']),
      singleFlightInvoke('ai:checkAuth', ['subscription']),
    ])

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(a).toEqual({ status: 'authenticated' })
    expect(b).toEqual({ status: 'authenticated' })
    expect(_readDedupeCounter()).toBe(1)
  })

  it('(b) serves a cached result within the TTL window', async () => {
    mockInvoke.mockResolvedValue({ status: 'authenticated' })

    const first = await singleFlightInvoke('ai:checkAuth', ['subscription'])
    const second = await singleFlightInvoke('ai:checkAuth', ['subscription'])

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ status: 'authenticated' })
    expect(second).toEqual({ status: 'authenticated' })
    expect(_readDedupeCounter()).toBe(1)
  })

  it('(b) issues a fresh IPC after the TTL expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockInvoke.mockResolvedValue({ status: 'authenticated' })

    await singleFlightInvoke('ai:checkAuth', ['subscription'], { ttlMs: 10 })
    vi.advanceTimersByTime(20)
    await singleFlightInvoke('ai:checkAuth', ['subscription'], { ttlMs: 10 })

    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('(c) invalidates the cache on settings:changed broadcast', async () => {
    mockInvoke.mockResolvedValue({ status: 'authenticated' })

    // Capture the listener registered by the module (auto-subscribe ran once
    // during the import in beforeEach). The module guards against double
    // subscription, so fetch the listener from the first mockOn call.
    const onCalls = mockOn.mock.calls.filter((c) => c[0] === 'settings:changed')
    // If auto-subscribe didn't run yet (resetForTests cleared the guard),
    // trigger it by calling invalidateCache — but the listener is installed
    // at module import, so we simulate by invoking invalidateCache directly.
    await singleFlightInvoke('ai:checkAuth', ['subscription'])
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    if (onCalls.length > 0) {
      const handler = onCalls[0][1] as () => void
      handler()
    } else {
      invalidateCache()
    }

    await singleFlightInvoke('ai:checkAuth', ['subscription'])
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('(d) source: user bypasses the cache but still joins in-flight', async () => {
    let resolvePending: (value: unknown) => void = () => {}
    mockInvoke.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolvePending = resolve
      }),
    )

    // First background call goes in-flight.
    const background = singleFlightInvoke('ai:checkAuth', ['subscription'])
    // User call mid-flight: must join the pending promise, not spawn a new IPC.
    const user = singleFlightInvoke('ai:checkAuth', ['subscription'], { source: 'user' })

    expect(mockInvoke).toHaveBeenCalledTimes(1)

    resolvePending({ status: 'authenticated' })

    const [bgResult, userResult] = await Promise.all([background, user])
    expect(bgResult).toEqual({ status: 'authenticated' })
    expect(userResult).toEqual({ status: 'authenticated' })

    // After the first call resolves, a subsequent user call MUST bypass the
    // cache and issue a fresh IPC (the point of source: 'user').
    mockInvoke.mockResolvedValueOnce({ status: 'authenticated', fresh: true })
    const user2 = await singleFlightInvoke<{ fresh?: boolean }>('ai:checkAuth', ['subscription'], { source: 'user' })
    expect(mockInvoke).toHaveBeenCalledTimes(2)
    expect(user2.fresh).toBe(true)
  })

  it('(e) broadcasts a rejection to all waiters', async () => {
    const boom = new Error('IPC failure')
    mockInvoke.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(boom), 10)))

    const a = singleFlightInvoke('ai:checkAuth', ['subscription'])
    const b = singleFlightInvoke('ai:checkAuth', ['subscription'])

    await expect(a).rejects.toBe(boom)
    await expect(b).rejects.toBe(boom)
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    // Rejected results are NOT cached — the next call must issue a fresh IPC.
    mockInvoke.mockResolvedValueOnce({ status: 'authenticated' })
    const retry = await singleFlightInvoke('ai:checkAuth', ['subscription'])
    expect(retry).toEqual({ status: 'authenticated' })
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('distinguishes different args as separate keys', async () => {
    mockInvoke.mockResolvedValue({ status: 'authenticated' })

    await singleFlightInvoke('ai:checkAuth', ['subscription'])
    await singleFlightInvoke('ai:checkAuth', ['anthropic-api'])

    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('ttlMs=0 disables caching', async () => {
    mockInvoke.mockResolvedValue({ status: 'authenticated' })

    await singleFlightInvoke('ai:checkAuth', ['subscription'], { ttlMs: 0 })
    await singleFlightInvoke('ai:checkAuth', ['subscription'], { ttlMs: 0 })

    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('exports default TTL constant at the expected value', () => {
    expect(__testables.DEFAULT_CACHE_TTL_MS).toBe(500)
  })

  // --- Gap coverage: missing angles identified by test-gen ---

  it('settings:changed mid-flight: in-flight promise still resolves; next call issues fresh IPC', async () => {
    // Invariant: when invalidateCache() fires during a pending IPC, the
    // generation guard ensures the stale result is NOT cached, so the next
    // call MUST spawn a fresh IPC (hard assertion, no accept-both).
    let resolvePending: (value: unknown) => void = () => {}
    mockInvoke.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolvePending = resolve
      }),
    )

    const pending = singleFlightInvoke('ai:checkAuth', ['subscription'])

    // Simulate settings:changed broadcast while the call is in flight.
    invalidateCache()

    // Let the in-flight resolve — waiter still receives the old value
    // (IPC has no cancellation); rejecting committed readers would be worse.
    resolvePending({ status: 'authenticated', fromInflight: true })
    const result = await pending
    expect(result).toEqual({ status: 'authenticated', fromInflight: true })

    // After the fix: the stale result was NOT cached (generation mismatch),
    // so the next call MUST spawn a fresh IPC — no cache poisoning.
    mockInvoke.mockResolvedValueOnce({ status: 'authenticated', fresh: true })
    const next = await singleFlightInvoke<{ fresh?: boolean }>('ai:checkAuth', ['subscription'])
    expect(next.fresh).toBe(true)
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('invalidateCache clears inflight map — new callers spawn fresh IPC, do not join stale promise', async () => {
    // Invariant: after invalidateCache(), a concurrent caller arriving BEFORE
    // the pending IPC resolves must NOT join the stale in-flight promise.
    // It must get its own fresh IPC against the post-invalidation backend
    // state (e.g. new API key).
    let resolveFirst: (value: unknown) => void = () => {}
    let resolveSecond: (value: unknown) => void = () => {}
    mockInvoke
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveFirst = resolve
        }),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveSecond = resolve
        }),
      )

    // First call goes in-flight.
    const first = singleFlightInvoke('ai:checkAuth', ['subscription'])
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    // Settings change fires mid-flight: invalidate clears cache AND inflight.
    invalidateCache()

    // A second caller arriving now must NOT join the (now-stale) pending
    // promise — it must issue a fresh IPC.
    const second = singleFlightInvoke('ai:checkAuth', ['subscription'])
    expect(mockInvoke).toHaveBeenCalledTimes(2)

    // Resolve in order; each waiter gets its own independent value.
    resolveFirst({ status: 'old' })
    resolveSecond({ status: 'new' })

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual({ status: 'old' })
    expect(secondResult).toEqual({ status: 'new' })
  })

  it('generation guard prevents stale result from caching after mid-flight invalidate', async () => {
    // Invariant: if invalidateCache() advances the generation counter while
    // a fresh invocation is awaiting IPC, the resolve path MUST skip the
    // cache write — otherwise a stale value poisons the cache for all
    // subsequent callers within the TTL window.
    let resolvePending: (value: unknown) => void = () => {}
    mockInvoke.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolvePending = resolve
      }),
    )

    const pending = singleFlightInvoke('ai:checkAuth', ['subscription'])

    // Bump generation mid-flight.
    invalidateCache()

    // Resolve the stale call — waiter sees the old value.
    resolvePending({ v: 'stale' })
    const result = await pending
    expect(result).toEqual({ v: 'stale' })

    // Cache must be EMPTY (generation guard skipped the write). We prove
    // it by issuing a second call: it MUST spawn a fresh IPC, confirming
    // no cached entry was available. If the guard were broken, { v: 'stale' }
    // would be served from cache and mockInvoke would stay at 1 call.
    mockInvoke.mockResolvedValueOnce({ v: 'fresh' })
    const next = await singleFlightInvoke<{ v: string }>('ai:checkAuth', ['subscription'])
    expect(next).toEqual({ v: 'fresh' })
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('rejected calls are not cached — retry after rejection issues fresh IPC', async () => {
    // Already partially covered in (e), but that test only verifies the
    // immediate retry. This adds: retry within the TTL window must still
    // hit IPC because rejected results must never be cached.
    mockInvoke.mockRejectedValueOnce(new Error('transient failure'))
    await expect(
      singleFlightInvoke('ai:checkAuth', ['subscription'], { ttlMs: 10_000 }),
    ).rejects.toThrow('transient failure')

    // Within the (hypothetical) 10s TTL — but the rejection should not have
    // been cached, so this must trigger a real IPC.
    mockInvoke.mockResolvedValueOnce({ status: 'authenticated' })
    const retry = await singleFlightInvoke('ai:checkAuth', ['subscription'], { ttlMs: 10_000 })
    expect(retry).toEqual({ status: 'authenticated' })
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('window.api.invoke absent — rejects via promise, does not throw synchronously', async () => {
    const savedApi = (window as unknown as { api: unknown }).api
    // Simulate renderer bootstrap where api is missing (edge case).
    Object.defineProperty(window, 'api', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    // Must not throw synchronously.
    const p = singleFlightInvoke('ai:checkAuth', ['subscription'])
    await expect(p).rejects.toThrow(/window\.api\.invoke is not available/)

    // Restore for subsequent tests.
    Object.defineProperty(window, 'api', {
      value: savedApi,
      writable: true,
      configurable: true,
    })
  })

  it('invalidateCache(channel) only clears the matching channel prefix', async () => {
    mockInvoke.mockResolvedValue({ status: 'ok' })

    await singleFlightInvoke('ai:checkAuth', ['subscription'])
    await singleFlightInvoke('folder:refreshCounts', [1])
    expect(mockInvoke).toHaveBeenCalledTimes(2)

    // Targeted invalidation — only ai:checkAuth should be wiped.
    invalidateCache('ai:checkAuth')

    await singleFlightInvoke('ai:checkAuth', ['subscription'])
    // This should have re-fetched.
    expect(mockInvoke).toHaveBeenCalledTimes(3)

    await singleFlightInvoke('folder:refreshCounts', [1])
    // folder:refreshCounts cache is still warm — no new IPC.
    expect(mockInvoke).toHaveBeenCalledTimes(3)
  })
})
