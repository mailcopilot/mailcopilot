import { describe, expect, it, vi } from 'vitest'

/**
 * Unit test for the per-account single-flight dedup pattern used by the
 * `net:mailboxesAndRoles` IPC handler in electron/main.ts.
 *
 * Why the pattern is reproduced inline here instead of imported from main.ts:
 * main.ts is the Electron main-process entry point and pulls in `electron`,
 * `keytar`, `better-sqlite3`, ImapFlow, Sentry, the updater, several hundred
 * IPC registrations, and background-service bootstrap. It cannot be loaded
 * in a plain-Node vitest process without a fake-Electron harness orders of
 * magnitude larger than the dedup logic it would exercise.
 *
 * Instead we encode the same semantic contract (see §1.4 Subtask 3):
 *
 *   1. Two concurrent calls for the SAME accountId share a single underlying
 *      executor invocation.
 *   2. Calls for DIFFERENT accountIds run independently.
 *   3. After the in-flight promise settles (resolve OR reject), a fresh call
 *      triggers a new executor invocation — the map entry is cleaned up via
 *      `.finally()`, not per-branch.
 *   4. A rejection propagates to all awaiters attached to the same run.
 *
 * The factory `createSingleflightForTest` below mirrors the main.ts handler
 * body one-for-one (identical map-set → run → finally cleanup ordering). If
 * the main.ts handler is refactored, this mirror MUST be updated in the same
 * commit — the test's job is to pin the contract, not to test an unrelated
 * re-implementation.
 */

type TestResult = { mailboxes: string[] }

function createSingleflightForTest(executor: (accountId: number) => Promise<TestResult>) {
  const inflight = new Map<number, Promise<TestResult>>()

  function call(accountId: number): Promise<TestResult> {
    const existing = inflight.get(accountId)
    if (existing) return existing

    const run = (async (): Promise<TestResult> => executor(accountId))()

    inflight.set(accountId, run)

    run.finally(() => {
      if (inflight.get(accountId) === run) {
        inflight.delete(accountId)
      }
    }).catch(() => { /* swallow — original rejection propagates via `run` */ })

    return run
  }

  return { call, inflight }
}

describe('mailboxesAndRoles single-flight dedup contract', () => {
  it('coalesces concurrent calls for the same accountId into one executor invocation', async () => {
    let resolveExecutor!: (v: TestResult) => void
    const executor = vi.fn((): Promise<TestResult> => {
      return new Promise<TestResult>(res => { resolveExecutor = res })
    })
    const { call } = createSingleflightForTest(executor)

    const p1 = call(1)
    const p2 = call(1)
    const p3 = call(1)

    expect(executor).toHaveBeenCalledTimes(1)

    resolveExecutor({ mailboxes: ['INBOX'] })
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toEqual({ mailboxes: ['INBOX'] })
    // All awaiters receive the SAME resolved value from the single run.
    expect(r1).toBe(r2)
    expect(r2).toBe(r3)
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('does not serialize different accountIds — each runs independently', async () => {
    const resolvers = new Map<number, (v: TestResult) => void>()
    const executor = vi.fn((accountId: number): Promise<TestResult> => {
      return new Promise<TestResult>(res => { resolvers.set(accountId, res) })
    })
    const { call } = createSingleflightForTest(executor)

    const pA = call(1)
    const pB = call(2)

    // Both execute in parallel.
    expect(executor).toHaveBeenCalledTimes(2)
    expect(resolvers.has(1)).toBe(true)
    expect(resolvers.has(2)).toBe(true)

    resolvers.get(1)!({ mailboxes: ['A-INBOX'] })
    resolvers.get(2)!({ mailboxes: ['B-INBOX'] })

    const [a, b] = await Promise.all([pA, pB])
    expect(a).toEqual({ mailboxes: ['A-INBOX'] })
    expect(b).toEqual({ mailboxes: ['B-INBOX'] })
  })

  it('cleans up inflight entry after resolve — next call triggers fresh executor', async () => {
    const executor = vi.fn(async (): Promise<TestResult> => ({ mailboxes: ['INBOX'] }))
    const { call, inflight } = createSingleflightForTest(executor)

    await call(1)

    // After settle + microtask flush, the map must be empty for this accountId.
    expect(inflight.has(1)).toBe(false)
    expect(executor).toHaveBeenCalledTimes(1)

    await call(1)
    expect(executor).toHaveBeenCalledTimes(2)
    expect(inflight.has(1)).toBe(false)
  })

  it('cleans up inflight entry after reject — no leaked rejected promise', async () => {
    let rejectExecutor!: (e: Error) => void
    let attempts = 0
    const executor = vi.fn((): Promise<TestResult> => {
      attempts++
      if (attempts === 1) {
        return new Promise<TestResult>((_res, rej) => { rejectExecutor = rej })
      }
      return Promise.resolve({ mailboxes: ['INBOX'] })
    })
    const { call, inflight } = createSingleflightForTest(executor)

    const p1 = call(1)
    const p2 = call(1)
    // Both share the same failing run.
    expect(executor).toHaveBeenCalledTimes(1)

    rejectExecutor(new Error('LIST failed'))

    // Both awaiters must see the SAME rejection (no independent retries).
    await expect(p1).rejects.toThrow('LIST failed')
    await expect(p2).rejects.toThrow('LIST failed')

    // After rejection settles, map is clean.
    // Flush microtasks so the .finally cleanup callback runs before we assert.
    await Promise.resolve()
    expect(inflight.has(1)).toBe(false)

    // A fresh call triggers a new executor invocation (not the stale rejection).
    const result = await call(1)
    expect(result).toEqual({ mailboxes: ['INBOX'] })
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('propagates rejection to all concurrent awaiters without starting new runs', async () => {
    let rejectExecutor!: (e: Error) => void
    const executor = vi.fn((): Promise<TestResult> => {
      return new Promise<TestResult>((_res, rej) => { rejectExecutor = rej })
    })
    const { call } = createSingleflightForTest(executor)

    const promises = [call(42), call(42), call(42), call(42)]
    expect(executor).toHaveBeenCalledTimes(1)

    rejectExecutor(new Error('boom'))

    const results = await Promise.allSettled(promises)
    for (const r of results) {
      expect(r.status).toBe('rejected')
      if (r.status === 'rejected') {
        expect((r.reason as Error).message).toBe('boom')
      }
    }
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('keeps map lookup-by-identity guard when the same accountId resolves twice in sequence', async () => {
    // Simulate: call1 kicks off run1, run1 settles, call2 kicks off run2.
    // Cleanup for run1 must NOT delete run2's slot.
    const resolvers: Array<(v: TestResult) => void> = []
    const executor = vi.fn((): Promise<TestResult> => {
      return new Promise<TestResult>(res => { resolvers.push(res) })
    })
    const { call, inflight } = createSingleflightForTest(executor)

    const p1 = call(1)
    resolvers[0]({ mailboxes: ['A'] })
    await p1
    // Run1 cleanup already fired; map is empty.
    expect(inflight.has(1)).toBe(false)

    const p2 = call(1)
    // Run2 is now in the map.
    expect(inflight.has(1)).toBe(true)
    resolvers[1]({ mailboxes: ['B'] })
    const r2 = await p2
    expect(r2).toEqual({ mailboxes: ['B'] })
    expect(inflight.has(1)).toBe(false)
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('surfaces synchronous throws from the executor body as rejections (all awaiters see them)', async () => {
    // Production's `computeMailboxesAndRoles` is declared `async`, so any
    // synchronous throw inside it (before the first `await`) is automatically
    // wrapped in a rejected promise. The factory preserves this invariant by
    // wrapping `executor(accountId)` in an IIFE-async. This test pins that
    // guarantee: if a future refactor drops the async wrapper, sync throws
    // would escape as uncaught exceptions and break the handler contract.
    const executor = vi.fn((): Promise<TestResult> => {
      throw new Error('sync boom')
    })
    const { call, inflight } = createSingleflightForTest(executor)

    const p1 = call(7)
    const p2 = call(7)
    expect(executor).toHaveBeenCalledTimes(1)

    await expect(p1).rejects.toThrow('sync boom')
    await expect(p2).rejects.toThrow('sync boom')

    // Map must be cleaned up even for sync-throw path (funnel-finally covers it).
    await Promise.resolve()
    expect(inflight.has(7)).toBe(false)

    // And a fresh call after sync-throw cleanup kicks off a new invocation.
    const executor2Spy = executor as unknown as ReturnType<typeof vi.fn>
    executor2Spy.mockImplementationOnce(async () => ({ mailboxes: ['RECOVERED'] }))
    const r3 = await call(7)
    expect(r3).toEqual({ mailboxes: ['RECOVERED'] })
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('does not poison sibling awaiters when one awaiter\'s .then handler throws', async () => {
    // The handler shares the promise across N awaiters. If awaiter #3's
    // downstream `.then` throws, awaiters #1, #2, #4, #5 must still receive
    // the original resolved value — an awaiter's local handler error cannot
    // affect siblings or leak into the inflight cleanup path.
    let resolveExecutor!: (v: TestResult) => void
    const executor = vi.fn((): Promise<TestResult> => {
      return new Promise<TestResult>(res => { resolveExecutor = res })
    })
    const { call, inflight } = createSingleflightForTest(executor)

    const p1 = call(9)
    const p2 = call(9)
    // Attach a throwing .then to the third handle — its chained promise will
    // reject, but p1/p2/p4/p5 (which await the shared run directly) must see
    // the original resolved value.
    const p3Chain = call(9).then(() => { throw new Error('handler boom') })
    const p4 = call(9)
    const p5 = call(9)

    expect(executor).toHaveBeenCalledTimes(1)

    resolveExecutor({ mailboxes: ['SHARED'] })

    // Siblings resolve with the shared value.
    await expect(p1).resolves.toEqual({ mailboxes: ['SHARED'] })
    await expect(p2).resolves.toEqual({ mailboxes: ['SHARED'] })
    await expect(p4).resolves.toEqual({ mailboxes: ['SHARED'] })
    await expect(p5).resolves.toEqual({ mailboxes: ['SHARED'] })

    // Only p3's derived chain throws.
    await expect(p3Chain).rejects.toThrow('handler boom')

    // Cleanup still happened on the underlying run.
    await Promise.resolve()
    expect(inflight.has(9)).toBe(false)
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('stays at single invocation under high fan-out (100 concurrent awaiters)', async () => {
    let resolveExecutor!: (v: TestResult) => void
    const executor = vi.fn((): Promise<TestResult> => {
      return new Promise<TestResult>(res => { resolveExecutor = res })
    })
    const { call } = createSingleflightForTest(executor)

    const promises: Array<Promise<TestResult>> = []
    for (let i = 0; i < 100; i++) promises.push(call(123))

    // Only one executor invocation despite 100 callers — this is the actual
    // stampede-prevention property being claimed at the IPC boundary.
    expect(executor).toHaveBeenCalledTimes(1)

    const payload: TestResult = { mailboxes: ['ONE'] }
    resolveExecutor(payload)

    const results = await Promise.all(promises)
    expect(results).toHaveLength(100)
    // Every awaiter observes the SAME reference — shared underlying promise.
    for (const r of results) expect(r).toBe(payload)
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('tolerates late awaiter attachment after the run has already settled (before cleanup runs)', async () => {
    // Edge case: caller obtains a reference to the in-flight promise, the run
    // resolves, the `.finally` cleanup fires on a microtask — but any awaiter
    // that attached `.then` BEFORE cleanup still gets the resolved value
    // correctly. (This is a Promise/spec property, but pinning it here because
    // the contract claim "all awaiters see the same resolution" relies on it.)
    const executor = vi.fn(async (): Promise<TestResult> => ({ mailboxes: ['LATE'] }))
    const { call } = createSingleflightForTest(executor)

    const p1 = call(5)
    // Attach a late .then before awaiting p1 — then await p1, which fires the
    // cleanup; the late attachment must still resolve to the same value.
    const pLate = p1.then(v => v)
    const r1 = await p1
    const rLate = await pLate
    expect(r1).toEqual({ mailboxes: ['LATE'] })
    expect(rLate).toEqual({ mailboxes: ['LATE'] })
    expect(r1).toBe(rLate)
    expect(executor).toHaveBeenCalledTimes(1)
  })
})

describe('mailboxesAndRoles dedup — mirror-test drift tripwire', () => {
  /**
   * Guard against the factory drifting from the production implementation
   * without anyone noticing. We cannot `import` from electron/main.ts (see
   * header comment above), but we CAN read the file as text and assert the
   * key structural tokens of the real handler still match the contract the
   * factory encodes: single `.get` check, `.set` before cleanup registration,
   * identity-guarded `.delete` inside `.finally`.
   *
   * If main.ts is refactored (e.g. someone swaps `.finally` for per-branch
   * cleanup, or drops the identity guard), this tripwire fails loudly — and
   * the test author is forced to either update the factory or justify why
   * the contract has changed.
   */
  it('production handler still contains the key structural tokens the factory mirrors', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, 'main.ts'), 'utf8')

    // Locate the handler region by a distinctive anchor so the tripwire
    // doesn't match the (similar) `inflightSyncs` handler lower in the file.
    const startIdx = src.indexOf("handleIpc('net:mailboxesAndRoles'")
    expect(startIdx).toBeGreaterThan(-1)
    const region = src.slice(startIdx, startIdx + 1500)

    // 1. Map is queried once by accountId at entry.
    expect(region).toMatch(/mailboxesAndRolesInflight\.get\(id\)/)
    // 2. A single `.set(id, run)` registers the run.
    expect(region).toMatch(/mailboxesAndRolesInflight\.set\(id,\s*run\)/)
    // 3. Cleanup is funnel-finally (NOT per-branch try/catch in the handler).
    expect(region).toMatch(/run\.finally\(/)
    // 4. Identity guard is still present — prevents deleting a newer entry.
    expect(region).toMatch(/mailboxesAndRolesInflight\.get\(id\)\s*===\s*run/)
    // 5. Delete is the cleanup action.
    expect(region).toMatch(/mailboxesAndRolesInflight\.delete\(id\)/)
    // 6. The executor is an async function — sync throws become rejections.
    expect(src).toMatch(/async function computeMailboxesAndRoles\(/)
  })
})
