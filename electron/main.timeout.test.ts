import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * §2.17 Phase 0 — IMAP fetch timeout behavioural test (AC-8).
 *
 * Narrow-scope isolation test for the Promise.race + AbortController shape
 * used by `fetchMessageDetailsWithTimeout` in `electron/main.ts`. We test
 * the race semantics here rather than importing `main.ts` directly because:
 *   - `main.ts` is a large hotspot (8000+ LoC) with extensive ES-module
 *     side effects (registers IPC handlers, opens DB at module-load time,
 *     wires Sentry sinks). Pulling it into a vitest run would require
 *     mocking dozens of unrelated subsystems.
 *   - The production helper is intentionally local (CLAUDE.md §5 hotspot
 *     policy: new helper logic should live inside the hotspot file as a
 *     local helper, not in a new module).
 *
 * The test mirrors the production race exactly:
 *   1. Start a fake fetchMessageDetails that resolves after a long delay.
 *   2. Race it against a 10s timeout.
 *   3. Assert the race resolves with kind='timeout' before the inner
 *      promise would have settled.
 *   4. Build the same `offlineFallback: true` envelope shape the production
 *      handler returns to the renderer.
 *
 * Any drift between this test's race shape and the production helper is a
 * regression risk — when modifying `fetchMessageDetailsWithTimeout` in
 * main.ts, mirror the change here.
 */

const IMAP_FETCH_TIMEOUT_MS = 10_000

type FetchOutcome<T> = { kind: 'ok'; value: T } | { kind: 'timeout' }

async function raceFetchWithTimeout<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<FetchOutcome<T>> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<FetchOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      try { ac.abort() } catch { /* ignore */ }
      resolve({ kind: 'timeout' })
    }, timeoutMs)
  })
  try {
    const fetchPromise = fetcher(ac.signal).then((value): FetchOutcome<T> => ({ kind: 'ok', value }))
    return await Promise.race([fetchPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type FakeMessageDetails = {
  uid: number
  envelope?: { subject?: string; date?: string }
  flags?: string[]
  offlineFallback?: boolean
}

function buildOfflineFallback(uid: number): FakeMessageDetails {
  return {
    uid,
    envelope: { subject: 'cached', date: '2026-04-25T00:00:00Z' },
    flags: [],
    offlineFallback: true,
  }
}

describe('§2.17 Phase 0 — IMAP fetch timeout fallback (AC-8)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with offlineFallback=true when fetchMessageDetails delays > 10s', async () => {
    vi.useFakeTimers()

    // Slow fetch — would resolve after 30s if uninterrupted.
    const slowFetch = (): Promise<FakeMessageDetails> => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ uid: 42, envelope: { subject: 'fresh' } }), 30_000)
      })
    }

    const start = Date.now()
    const racePromise = raceFetchWithTimeout(slowFetch, IMAP_FETCH_TIMEOUT_MS)
    // Advance past the 10s budget.
    await vi.advanceTimersByTimeAsync(IMAP_FETCH_TIMEOUT_MS + 100)
    const outcome = await racePromise
    const elapsed = Date.now() - start

    // Race must surface timeout, not let the slow fetch through.
    expect(outcome.kind).toBe('timeout')
    // Within 11s budget — fake timers measure deterministic time.
    expect(elapsed).toBeLessThan(11_000)

    // Apply the production fallback shape: timeout → offlineFallback=true.
    const fallback = outcome.kind === 'timeout' ? buildOfflineFallback(42) : null
    expect(fallback).not.toBeNull()
    expect(fallback!.offlineFallback).toBe(true)
    expect(fallback!.uid).toBe(42)
  })

  it('returns the fetched value when fetchMessageDetails completes within the budget', async () => {
    vi.useFakeTimers()

    const fastFetch = (): Promise<FakeMessageDetails> => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ uid: 7, envelope: { subject: 'fast' } }), 50)
      })
    }

    const racePromise = raceFetchWithTimeout(fastFetch, IMAP_FETCH_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(100)
    const outcome = await racePromise

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.value.uid).toBe(7)
      expect(outcome.value.envelope?.subject).toBe('fast')
      expect(outcome.value.offlineFallback).toBeUndefined()
    }
  })

  it('aborts the AbortSignal when the timeout fires', async () => {
    vi.useFakeTimers()

    let observedSignal: AbortSignal | null = null
    const slowFetch = (signal: AbortSignal): Promise<FakeMessageDetails> => {
      observedSignal = signal
      return new Promise((resolve) => {
        setTimeout(() => resolve({ uid: 99 }), 30_000)
      })
    }

    const racePromise = raceFetchWithTimeout(slowFetch, IMAP_FETCH_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(IMAP_FETCH_TIMEOUT_MS + 50)
    await racePromise

    expect(observedSignal).not.toBeNull()
    expect(observedSignal!.aborted).toBe(true)
  })
})

// --- §2.17 Phase 0 — timer lifecycle invariants ----------------------------

describe('§2.17 Phase 0 — fetchMessageDetailsWithTimeout timer cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears the timeout timer via finally when the fetch completes before the deadline', async () => {
    vi.useFakeTimers()

    // Track clearTimeout calls to confirm the finally block runs.
    const clearedTimers: unknown[] = []
    const originalClearTimeout = globalThis.clearTimeout
    globalThis.clearTimeout = (id: unknown) => {
      clearedTimers.push(id)
      return originalClearTimeout(id as ReturnType<typeof setTimeout>)
    }

    const fastFetch = (): Promise<FakeMessageDetails> => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ uid: 5 }), 50)
      })
    }

    try {
      const racePromise = raceFetchWithTimeout(fastFetch, IMAP_FETCH_TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(100)
      const outcome = await racePromise

      expect(outcome.kind).toBe('ok')
      // The finally block must have called clearTimeout at least once,
      // preventing the timeout from firing after the fetch resolved.
      expect(clearedTimers.length).toBeGreaterThanOrEqual(1)
    } finally {
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  it('races multiple concurrent fetches independently (no shared timer state)', async () => {
    vi.useFakeTimers()

    // Two concurrent races — each must be independent.
    const slowFetch = (): Promise<FakeMessageDetails> =>
      new Promise((resolve) => { setTimeout(() => resolve({ uid: 1 }), 30_000) })

    const fastFetch = (): Promise<FakeMessageDetails> =>
      new Promise((resolve) => { setTimeout(() => resolve({ uid: 2 }), 50) })

    const slowRace = raceFetchWithTimeout(slowFetch, IMAP_FETCH_TIMEOUT_MS)
    const fastRace = raceFetchWithTimeout(fastFetch, IMAP_FETCH_TIMEOUT_MS)

    // Advance past the fast fetch but not the slow timeout.
    await vi.advanceTimersByTimeAsync(100)
    const fastOutcome = await fastRace
    expect(fastOutcome.kind).toBe('ok')
    if (fastOutcome.kind === 'ok') {
      expect(fastOutcome.value.uid).toBe(2)
    }

    // Advance past the 10s budget — the slow race must time out independently.
    await vi.advanceTimersByTimeAsync(IMAP_FETCH_TIMEOUT_MS + 100)
    const slowOutcome = await slowRace
    expect(slowOutcome.kind).toBe('timeout')
  })

  it('buildOfflineFallback (test-local mirror) returns offlineFallback=true with the given uid', () => {
    // The production buildOfflineFallback in main.ts takes a nullable
    // getMessageByUid result and returns null when it is absent. This test
    // exercises the test-local mirror (which matches the non-null branch)
    // to confirm the shape the renderer receives.
    const result = buildOfflineFallback(99)
    expect(result.offlineFallback).toBe(true)
    expect(result.uid).toBe(99)
    expect(result.envelope?.subject).toBe('cached')
  })

  it('buildOfflineFallback (test-local mirror) sets flags to empty array', () => {
    const result = buildOfflineFallback(12)
    expect(result.flags).toEqual([])
  })
})

// --- §2.17 Phase 0 — span finalizer idempotency / unexpected-throw guard ---

/**
 * Mirrors the production `makeMessageDetailsFinalizer` factory in
 * `electron/main.ts`. Same reason as the race helper above: pulling
 * main.ts into vitest requires mocking the entire IPC/DB/Sentry surface,
 * and the helper is intentionally hotspot-local. Any drift between this
 * mirror and the production factory is a regression risk — when changing
 * the production factory, mirror the change here.
 */
type CacheHitLevelMirror = 'memory' | 'db' | 'eml' | 'imap' | 'imap_timeout'

interface FakeSpan {
  setAttributesCalls: Array<Record<string, unknown>>
  endCalls: number
  end(): void
  setAttributes(attrs: Record<string, unknown>): void
}

function makeFakeSpan(opts?: { throwOnEnd?: boolean; throwOnSetAttributes?: boolean }): FakeSpan {
  const span: FakeSpan = {
    setAttributesCalls: [],
    endCalls: 0,
    end() {
      this.endCalls += 1
      if (opts?.throwOnEnd) throw new Error('span.end transient failure')
    },
    setAttributes(attrs) {
      this.setAttributesCalls.push(attrs)
      if (opts?.throwOnSetAttributes) throw new Error('span.setAttributes transient failure')
    },
  }
  return span
}

function makeFinalizerMirror(
  span: FakeSpan,
  recordHistogram: (name: string, ms: number, tags: { cache_hit_level: string }) => void,
  t0: number,
): {
  finalize: (level: CacheHitLevelMirror, details: { attachments?: unknown[]; html?: string; text?: string } | null) => void
  ensureClosed: (defaultLevel: CacheHitLevelMirror) => void
} {
  let closed = false
  const finalize = (level: CacheHitLevelMirror, details: { attachments?: unknown[]; html?: string; text?: string } | null) => {
    if (closed) return
    closed = true
    try {
      const wallMs = Date.now() - t0
      const attachmentsCount = details?.attachments?.length ?? 0
      try {
        span.setAttributes({
          cache_hit_level: level,
          attachments_count: attachmentsCount,
        })
      } catch { /* ignore */ }
      try { span.end() } catch { /* ignore */ }
      recordHistogram('net.message_details.wall_ms', wallMs, { cache_hit_level: level })
    } catch { /* never let telemetry break the open path */ }
  }
  const ensureClosed = (defaultLevel: CacheHitLevelMirror): void => {
    if (closed) return
    finalize(defaultLevel, null)
  }
  return { finalize, ensureClosed }
}

describe('§2.17 Phase 0 — span finalizer (Medium 1: span end on error paths)', () => {
  it('finalize() is idempotent: second call is a no-op', () => {
    const span = makeFakeSpan()
    const histCalls: Array<{ name: string; ms: number; tags: { cache_hit_level: string } }> = []
    const recordHistogram = (name: string, ms: number, tags: { cache_hit_level: string }) =>
      histCalls.push({ name, ms, tags })

    const { finalize } = makeFinalizerMirror(span, recordHistogram, Date.now())
    finalize('memory', { attachments: [] })
    finalize('imap', { attachments: [{}, {}] })

    expect(span.endCalls).toBe(1)
    expect(histCalls).toHaveLength(1)
    expect(histCalls[0].tags.cache_hit_level).toBe('memory')
  })

  it('ensureClosed() finalizes with the default level when no branch finalized', () => {
    const span = makeFakeSpan()
    const histCalls: Array<{ tags: { cache_hit_level: string } }> = []
    const recordHistogram = (_name: string, _ms: number, tags: { cache_hit_level: string }) =>
      histCalls.push({ tags })

    const { ensureClosed } = makeFinalizerMirror(span, recordHistogram, Date.now())
    ensureClosed('db')

    expect(span.endCalls).toBe(1)
    expect(histCalls).toHaveLength(1)
    expect(histCalls[0].tags.cache_hit_level).toBe('db')
  })

  it('ensureClosed() is a no-op when finalize() already ran on the happy path', () => {
    const span = makeFakeSpan()
    const histCalls: Array<{ tags: { cache_hit_level: string } }> = []
    const recordHistogram = (_name: string, _ms: number, tags: { cache_hit_level: string }) =>
      histCalls.push({ tags })

    const { finalize, ensureClosed } = makeFinalizerMirror(span, recordHistogram, Date.now())
    finalize('imap', { attachments: [] })
    ensureClosed('db')

    expect(span.endCalls).toBe(1)
    expect(histCalls).toHaveLength(1)
    expect(histCalls[0].tags.cache_hit_level).toBe('imap')
  })

  it('ensureClosed() closes the span when an unexpected throw skipped explicit finalize() (try/finally pattern)', () => {
    const span = makeFakeSpan()
    const histCalls: Array<{ tags: { cache_hit_level: string } }> = []
    const recordHistogram = (_name: string, _ms: number, tags: { cache_hit_level: string }) =>
      histCalls.push({ tags })

    const { finalize, ensureClosed } = makeFinalizerMirror(span, recordHistogram, Date.now())

    // Simulate the IPC handler shape: an inner block throws before its
    // explicit finalize() call, the outer finally runs ensureClosed.
    const innerThrow = (): void => {
      // Imagine parseEmlBuffer or DB write throws here.
      throw new Error('parseEmlBuffer failed')
    }

    expect(() => {
      try {
        innerThrow()
        // Never reached — but kept to mirror the production flow where a
        // matching `finalize(...)` would normally run on the success path.
        finalize('eml', { attachments: [] })
      } finally {
        ensureClosed('db')
      }
    }).toThrow('parseEmlBuffer failed')

    // Span was closed even though no branch ran finalize() explicitly.
    expect(span.endCalls).toBe(1)
    expect(histCalls).toHaveLength(1)
    expect(histCalls[0].tags.cache_hit_level).toBe('db')
  })

  it('finalize() swallows transient throws from span.end / setAttributes (telemetry must not break the open path)', () => {
    const span = makeFakeSpan({ throwOnEnd: true, throwOnSetAttributes: true })
    const recordHistogram = () => {}

    const { finalize } = makeFinalizerMirror(span, recordHistogram, Date.now())
    expect(() => finalize('memory', { attachments: [] })).not.toThrow()
  })
})
