import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

/**
 * §2.24 PR1 — per-account periodic-sync isolation test.
 *
 * Narrow-scope isolation test for the Promise.allSettled + per-account
 * soft-timeout-budget + per-account in-flight-guard shape used by
 * `runPeriodicSync` / `runOneAccountPeriodicSync` / `syncOneAccountFolders`
 * in `electron/main.ts`. We mirror the production race/guard shape here
 * rather than importing `main.ts` directly because:
 *   - `main.ts` is a large hotspot (9000+ LoC) with extensive ES-module
 *     side effects (registers IPC handlers, opens DB at module-load time,
 *     wires Sentry sinks). Pulling it into a vitest run would require
 *     mocking dozens of unrelated subsystems.
 *   - The production logic is intentionally hotspot-local (CLAUDE.md §5
 *     hotspot policy: new helper logic should live inside the hotspot file
 *     as a local helper, not in a new module).
 *
 * Any drift between this mirror and the production helpers is a regression
 * risk — when modifying the periodic-sync orchestration in main.ts, mirror
 * the change here.
 *
 * Root incident (2026-05-13): one throttled account (IMAP greeting never
 * arrives, each folder times out 16-121s) blocked periodic sync for the
 * other 5 healthy accounts for ~50 min, because the old global
 * `periodicSyncRunning` boolean no-op'd every timer tick until the whole
 * sequential loop finished. The mirror below proves the new shape:
 *   - accounts run concurrently (Promise.allSettled),
 *   - a per-account SOFT timeout budget flips `timedOut` flag only (does not
 *     abort in-flight folder fetch), holding the slot until real work drains,
 *   - healthy accounts complete without waiting on the stuck one.
 *
 * Mirror boundary (updated to match post-HIGH-1 production shape):
 *   - `replay(aid)` → `replayOfflineOps(aid, ...)` call inside
 *     `syncOneAccountFolders`. Error is caught and logged; sync continues.
 *   - `foldersFor(aid)` → `listFolderPrefs(aid)` + filter + map inside
 *     `syncOneAccountFolders`. Empty list → early return.
 *   - `fetchFolder(aid, folder)` → `fetchAllFolderHeaders(...)` inside the
 *     folder loop.
 *   - `capture(call)` → `captureException(...)` call after budget overrun.
 *   - `warn(msg)` → `logPeriodic.warn(...)`.
 */

const ACCOUNT_BUDGET_MS = 8 * 60_000

/** Mirror of the production per-account in-flight guard. */
const periodicSyncInFlight = new Set<number>()

interface CaptureCall {
  message: string
  context: { source: string; accountId: number; elapsedMs: number }
}

interface MirrorDeps {
  /** Mirrors `replayOfflineOps(aid, ...)` — called before folder loop. */
  replay: (aid: number) => Promise<void>
  /** Mirrors `listFolderPrefs(aid).filter(...).map(p => p.folderPath)`. */
  foldersFor: (aid: number) => string[]
  /** Mirrors `fetchAllFolderHeaders(...)` call inside the folder loop. */
  fetchFolder: (aid: number, folder: string) => Promise<void>
  /** Mirrors `captureException(...)` for budget overruns and outer rejections. */
  capture: (call: CaptureCall) => void
  /** Mirrors `logPeriodic.warn(...)`. */
  warn: (msg: string) => void
  budgetMs: number
}

/**
 * Mirror of `syncOneAccountFolders`:
 *   1. Replay offline ops (error swallowed, sync continues).
 *   2. Get folder list — if empty, return early.
 *   3. Iterate folders sequentially; check `isTimedOut()` before each.
 *   4. Per-folder errors are caught and logged (swallowed in mirror).
 */
async function syncOneAccountFolders(
  aid: number,
  isTimedOut: () => boolean,
  deps: MirrorDeps,
): Promise<void> {
  // Step 1: replay offline ops — error swallowed, sync continues.
  try {
    await deps.replay(aid)
  } catch {
    /* replay failure is logged in production and does not abort folder sync */
  }

  // Step 2: resolve folder list.
  const folders = deps.foldersFor(aid)
  if (folders.length === 0) return

  // Step 3: sequential folder sync with timedOut guard between folders.
  for (const folder of folders) {
    if (isTimedOut()) break
    try {
      await deps.fetchFolder(aid, folder)
    } catch {
      /* per-folder failure is logged in production, swallowed here */
    }
  }
}

/**
 * Mirror of `runOneAccountPeriodicSync`:
 *   - Adds `aid` to `periodicSyncInFlight`.
 *   - Starts a SOFT budget timer (flips `timedOut` flag only — does NOT abort
 *     in-flight folder fetch and does NOT race against `syncOneAccountFolders`).
 *   - Always `await`s the real work to natural completion.
 *   - If budget was exceeded: `warn()` + `capture()` after settlement.
 *   - `periodicSyncInFlight.delete(aid)` in `finally` — always runs after real
 *     work settles, never before.
 */
async function runOneAccountPeriodicSync(aid: number, deps: MirrorDeps): Promise<void> {
  periodicSyncInFlight.add(aid)
  const startedAt = Date.now()
  let timedOut = false
  let budgetTimer: ReturnType<typeof setTimeout> | null = null
  try {
    budgetTimer = setTimeout(() => {
      timedOut = true
    }, deps.budgetMs)
    // Always await real work — no Promise.race. Budget timer only flips timedOut.
    await syncOneAccountFolders(aid, () => timedOut, deps)
    const elapsedMs = Date.now() - startedAt
    if (timedOut) {
      deps.warn(`account #${aid} exceeded soft budget after ${elapsedMs}ms`)
      deps.capture({
        message: 'periodicSync account soft-budget overrun',
        context: {
          source: 'periodicSync:accountTimeout',
          accountId: aid,
          elapsedMs,
        },
      })
    }
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer)
    periodicSyncInFlight.delete(aid)
  }
}

/**
 * Mirror of `runPeriodicSync`:
 *   - Filters out already-in-flight accounts.
 *   - Runs remaining accounts concurrently via Promise.allSettled.
 *   - After settlement: logs + captures each rejected result with correct
 *     accountId (index-correlated with `toStart`).
 */
async function runPeriodicSync(
  accountIds: number[],
  deps: MirrorDeps,
): Promise<void> {
  const toStart = accountIds.filter(aid => !periodicSyncInFlight.has(aid))
  if (toStart.length === 0) return
  const results = await Promise.allSettled(
    toStart.map(aid => runOneAccountPeriodicSync(aid, deps)),
  )
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const accountId = toStart[i]
      deps.warn(`account #${accountId} rejected: ${String(result.reason)}`)
      deps.capture({
        message: String(result.reason?.message ?? result.reason),
        context: {
          source: 'periodicSync:accountFailed',
          accountId,
          elapsedMs: 0,
        },
      })
    }
  })
}

/**
 * Mirror of `waitForPeriodicSyncIdle` from `electron/main.ts`.
 * Polls `periodicSyncInFlight.size` every 50ms up to `timeoutMs`.
 * Returns true when the set drains to 0 within the budget, false otherwise.
 */
async function waitForPeriodicSyncIdle(timeoutMs = 3_000): Promise<boolean> {
  const start = Date.now()
  while (periodicSyncInFlight.size > 0) {
    if (Date.now() - start >= timeoutMs) return false
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  return true
}

// ---------------------------------------------------------------------------
// Helper: build a MirrorDeps with sensible defaults, overridable per-test.
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<MirrorDeps> = {}): MirrorDeps {
  return {
    replay: vi.fn().mockResolvedValue(undefined),
    foldersFor: vi.fn().mockReturnValue(['INBOX', 'Sent']),
    fetchFolder: vi.fn().mockResolvedValue(undefined),
    capture: vi.fn(),
    warn: vi.fn(),
    budgetMs: ACCOUNT_BUDGET_MS,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe('§2.24 PR1 — per-account periodic sync isolation', () => {
  beforeEach(() => {
    periodicSyncInFlight.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    periodicSyncInFlight.clear()
  })

  it('healthy accounts #2-#6 finish without waiting on a hung account #1', async () => {
    vi.useFakeTimers()

    const ACCOUNTS = [1, 2, 3, 4, 5, 6]
    const FOLDERS = ['INBOX', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash']
    const completed = new Set<number>()
    const captures: CaptureCall[] = []

    const fetchFolder = (aid: number): Promise<void> => {
      if (aid === 1) {
        // Account #1: every folder hangs far longer than the per-account
        // budget — simulates DPI throttling where the IMAP greeting never
        // arrives. A single hung folder already overruns the 8-min budget.
        return new Promise<void>((resolve) => {
          setTimeout(resolve, 20 * 60_000)
        })
      }
      // Healthy accounts: each folder completes fast.
      return new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      })
    }

    const deps = makeDeps({
      foldersFor: () => FOLDERS,
      fetchFolder: (aid) => {
        const p = fetchFolder(aid)
        if (aid !== 1) p.then(() => completed.add(aid))
        return p
      },
      capture: (call) => captures.push(call),
    })

    const runPromise = runPeriodicSync(ACCOUNTS, deps)

    // Advance enough for healthy accounts: 6 folders × 50ms = 300ms.
    await vi.advanceTimersByTimeAsync(1_000)

    // At this point the 5 healthy accounts must already be done — their
    // slots released — while account #1 is still in flight (hung).
    expect(periodicSyncInFlight.has(1)).toBe(true)
    for (const aid of [2, 3, 4, 5, 6]) {
      expect(periodicSyncInFlight.has(aid)).toBe(false)
    }

    // No timeout captured yet — budget not reached.
    expect(captures).toHaveLength(0)

    // Advance past the 8-min per-account budget for account #1 AND past the
    // hung folder fetch (20 min). The soft-budget fires at 8 min, timedOut
    // flips, but folder A is still awaited — the slot is held until it
    // settles at 20 min.
    await vi.advanceTimersByTimeAsync(ACCOUNT_BUDGET_MS + 1_000)
    // Folder A (20min) is still pending — advance further.
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    await runPromise

    // Account #1 hit its timeout budget and released its slot.
    expect(periodicSyncInFlight.has(1)).toBe(false)
    expect(periodicSyncInFlight.size).toBe(0)

    // Healthy accounts completed independently of #1.
    expect(completed).toEqual(new Set([2, 3, 4, 5, 6]))

    // Exactly one timeout captured, for account #1, with correct source.
    expect(captures).toHaveLength(1)
    expect(captures[0].context.source).toBe('periodicSync:accountTimeout')
    expect(captures[0].context.accountId).toBe(1)
    expect(captures[0].context.elapsedMs).toBeGreaterThanOrEqual(ACCOUNT_BUDGET_MS)
  })

  it('all-healthy: every account completes, no timeout captured, set drains to empty', async () => {
    vi.useFakeTimers()

    const deps = makeDeps({
      foldersFor: () => ['INBOX', 'Sent'],
      fetchFolder: () => new Promise<void>(resolve => { setTimeout(resolve, 100) }),
    })

    const runPromise = runPeriodicSync([10, 20, 30], deps)

    await vi.advanceTimersByTimeAsync(1_000)
    await runPromise

    expect((deps.capture as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    expect(periodicSyncInFlight.size).toBe(0)
  })

  it('single-account: no regression — completes and releases its slot', async () => {
    vi.useFakeTimers()

    const deps = makeDeps({
      foldersFor: () => ['INBOX'],
      fetchFolder: () => new Promise<void>(resolve => { setTimeout(resolve, 80) }),
    })

    const runPromise = runPeriodicSync([42], deps)

    await vi.advanceTimersByTimeAsync(500)
    await runPromise

    expect((deps.capture as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    expect(periodicSyncInFlight.has(42)).toBe(false)
  })

  it('in-flight guard: a timer tick skips accounts already mid-pass, starts only free ones', async () => {
    vi.useFakeTimers()

    const started: number[] = []

    const deps = makeDeps({
      foldersFor: () => ['INBOX'],
      fetchFolder: (aid) => {
        started.push(aid)
        return new Promise<void>(resolve => { setTimeout(resolve, 200) })
      },
    })

    // First tick: accounts 1 and 2 start.
    const firstTick = runPeriodicSync([1, 2], deps)

    // While both are mid-pass, a second tick fires for accounts 1, 2, 3.
    // Accounts 1 and 2 are in flight → skipped; only 3 is started.
    await vi.advanceTimersByTimeAsync(50)
    expect(periodicSyncInFlight.has(1)).toBe(true)
    expect(periodicSyncInFlight.has(2)).toBe(true)

    const secondTick = runPeriodicSync([1, 2, 3], deps)

    await vi.advanceTimersByTimeAsync(500)
    await Promise.all([firstTick, secondTick])

    // Account 3 was started exactly once by the second tick; accounts 1
    // and 2 each started exactly once (the second tick skipped them).
    expect(started.filter(a => a === 1)).toHaveLength(1)
    expect(started.filter(a => a === 2)).toHaveLength(1)
    expect(started.filter(a => a === 3)).toHaveLength(1)
    expect(periodicSyncInFlight.size).toBe(0)
  })

  it('timed-out account stops starting NEW folders but the in-progress folder is left to drain', async () => {
    vi.useFakeTimers()

    const fetchStarted: string[] = []
    // 3 folders. The first folder fetch outlasts the whole short budget,
    // so the budget timer fires while folder A is still mid-fetch:
    // timedOut flips true, A is left to drain, B and C never start.
    const SHORT_BUDGET = 300

    const deps = makeDeps({
      foldersFor: () => ['A', 'B', 'C'],
      fetchFolder: (_aid, folder) => {
        fetchStarted.push(folder)
        return new Promise<void>(resolve => { setTimeout(resolve, 1_000) })
      },
      budgetMs: SHORT_BUDGET,
    })

    const runPromise = runPeriodicSync([7], deps)

    // Folder A starts immediately. Budget (300ms) elapses while A (1000ms)
    // is mid-fetch → timedOut=true. A is left to drain; B/C never start.
    await vi.advanceTimersByTimeAsync(2_000)
    await runPromise

    expect(fetchStarted).toEqual(['A'])
    expect((deps.capture as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect((deps.capture as ReturnType<typeof vi.fn>).mock.calls[0][0].context.accountId).toBe(7)
    expect(periodicSyncInFlight.size).toBe(0)
  })

  it('empty account list: runPeriodicSync is a no-op, set stays empty', async () => {
    const deps = makeDeps()

    await runPeriodicSync([], deps)

    expect((deps.fetchFolder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    expect((deps.capture as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    expect(periodicSyncInFlight.size).toBe(0)
  })

  it('finally always removes aid from set even when fetchFolder throws (no timeout)', async () => {
    // This test exercises the throw-path through runOneAccountPeriodicSync.
    // Per-folder errors are caught inside syncOneAccountFolders (try/catch
    // around fetchFolder). The slot must still drain via finally.
    vi.useFakeTimers()

    const deps = makeDeps({
      foldersFor: () => ['INBOX', 'Sent'],
      fetchFolder: () => Promise.reject(new Error('IMAP connection refused')),
    })

    await runPeriodicSync([55], deps)

    // No timeout was captured — the error was swallowed inside
    // syncOneAccountFolders, not by the timeout budget.
    expect((deps.capture as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    // The in-flight set must be drained regardless.
    expect(periodicSyncInFlight.has(55)).toBe(false)
    expect(periodicSyncInFlight.size).toBe(0)
  })

  it('Promise.allSettled: one account throwing does not prevent other accounts from completing', async () => {
    // Verifies that a non-timeout failure path in one account slot does not
    // affect sibling accounts. The per-folder catch inside syncOneAccountFolders
    // means individual folder errors are swallowed; this test uses a clean
    // scenario where all folders resolve/reject on their own to show isolation.
    vi.useFakeTimers()

    const completed = new Set<number>()

    const deps = makeDeps({
      foldersFor: () => ['INBOX', 'Sent'],
      fetchFolder: (aid, folder) => {
        if (aid === 100) {
          // Account 100: first folder resolves, second throws (simulates mid-sync
          // IMAP drop that would surface as an uncaught error inside the folder
          // loop in a less-defensive implementation).
          return folder === 'INBOX'
            ? new Promise<void>(resolve => { setTimeout(resolve, 50) })
            : Promise.reject(new Error('IMAP socket closed'))
        }
        // Healthy account completes normally.
        return new Promise<void>(resolve => {
          setTimeout(() => {
            completed.add(aid)
            resolve()
          }, 100)
        })
      },
    })

    const runPromise = runPeriodicSync([100, 200], deps)

    await vi.advanceTimersByTimeAsync(500)
    await runPromise

    // Account 200 completed independently.
    expect(completed.has(200)).toBe(true)
    // No timeout captured for either account.
    expect((deps.capture as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    // Both slots released.
    expect(periodicSyncInFlight.size).toBe(0)
  })

  // -------------------------------------------------------------------------
  // HIGH test-gap (codex §2.24 wave-2):
  // "timeout fires, underlying fetch still unresolved, second timer tick
  // starts same account again — main regression risk."
  // After HIGH-1 fix: slot is held until real work settles, second tick cannot
  // restart the account while its slot is occupied.
  // -------------------------------------------------------------------------

  it('HIGH-1: timed-out account keeps its in-flight slot until underlying sync settles; second tick does not restart it', async () => {
    vi.useFakeTimers()

    const SHORT_BUDGET = 200 // ms — fires while folder A is still in flight
    const fetchCallsForAid1: string[] = []

    const deps = makeDeps({
      foldersFor: () => ['A'],
      fetchFolder: (aid, folder) => {
        if (aid === 1) {
          fetchCallsForAid1.push(folder)
          // Folder A takes 1000ms — far longer than the 200ms budget.
          return new Promise<void>(resolve => { setTimeout(resolve, 1_000) })
        }
        return Promise.resolve()
      },
      budgetMs: SHORT_BUDGET,
    })

    // First tick: account #1 starts its folder sync.
    const firstTick = runPeriodicSync([1], deps)

    // Budget fires at 200ms — timedOut flips, but folder A is still in flight.
    await vi.advanceTimersByTimeAsync(SHORT_BUDGET + 10)

    // Slot is still occupied (folder A still draining).
    expect(periodicSyncInFlight.has(1)).toBe(true)

    // Second tick at 250ms — account #1 is still in periodicSyncInFlight,
    // so it must be skipped (NOT restarted).
    const secondTick = runPeriodicSync([1], deps)

    // Advance to completion of folder A (1000ms total from start).
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all([firstTick, secondTick])

    // fetchFolder was called exactly once for account #1 (first tick only).
    // Second tick skipped it because slot was still occupied.
    expect(fetchCallsForAid1).toHaveLength(1)

    // Slot released after real work settled.
    expect(periodicSyncInFlight.has(1)).toBe(false)

    // Budget overrun was reported exactly once (first tick).
    const captureMock = deps.capture as ReturnType<typeof vi.fn>
    expect(captureMock.mock.calls).toHaveLength(1)
    expect(captureMock.mock.calls[0][0].context.source).toBe('periodicSync:accountTimeout')
    expect(captureMock.mock.calls[0][0].context.accountId).toBe(1)
  })

  it('HIGH-1: slot is released only AFTER real work drains, not when budget timer fires', async () => {
    vi.useFakeTimers()

    const SHORT_BUDGET = 100
    const slotReleasedAt: number[] = []
    let budgetFiredAt = 0

    // We intercept capture to record the moment budget fires (timedOut flip
    // happens just before capture is called, after sync settles).
    const originalFetchFolder = vi.fn((aid: number, folder: string): Promise<void> => {
      void aid
      void folder
      return new Promise<void>(resolve => { setTimeout(resolve, 500) })
    })

    const deps = makeDeps({
      foldersFor: () => ['X'],
      fetchFolder: originalFetchFolder,
      capture: (call) => {
        if (call.context.source === 'periodicSync:accountTimeout') {
          budgetFiredAt = Date.now()
        }
      },
      budgetMs: SHORT_BUDGET,
    })

    // Monkey-patch: track when slot is removed from the set.
    // We poll after settlement — the slot must be gone only after the await.
    const runPromise = runPeriodicSync([9], deps)

    // Budget fires at 100ms.
    await vi.advanceTimersByTimeAsync(SHORT_BUDGET + 10)

    // Slot is still held — folder X (500ms) is still in flight.
    expect(periodicSyncInFlight.has(9)).toBe(true)

    // Advance to folder completion.
    await vi.advanceTimersByTimeAsync(500)
    await runPromise

    slotReleasedAt.push(Date.now())

    // Slot must be gone now.
    expect(periodicSyncInFlight.has(9)).toBe(false)

    // Budget was reported (sync settled after overrun).
    expect(budgetFiredAt).toBeGreaterThan(0)
    // Slot released at or after budget was reported (capture happens before finally).
    expect(slotReleasedAt[0]).toBeGreaterThanOrEqual(budgetFiredAt)
  })

  // -------------------------------------------------------------------------
  // Soft-budget overrun: account settles naturally, slot released after drain.
  // -------------------------------------------------------------------------

  it('soft-budget overrun: warn and capture are called after sync settles, slot released only after drain', async () => {
    vi.useFakeTimers()

    const SHORT_BUDGET = 150 // fires while fetching the first folder
    const warnMsgs: string[] = []
    const captures: CaptureCall[] = []
    const fetchOrder: string[] = []

    const deps = makeDeps({
      foldersFor: () => ['INBOX', 'Sent'], // 2 folders
      fetchFolder: (_aid, folder) => {
        fetchOrder.push(folder)
        // INBOX takes 300ms (> budget). Sent would take 50ms but never starts.
        return folder === 'INBOX'
          ? new Promise<void>(resolve => { setTimeout(resolve, 300) })
          : new Promise<void>(resolve => { setTimeout(resolve, 50) })
      },
      warn: (msg) => warnMsgs.push(msg),
      capture: (call) => captures.push(call),
      budgetMs: SHORT_BUDGET,
    })

    const runPromise = runPeriodicSync([3], deps)

    // Let budget fire (150ms) then folder drain (300ms total).
    await vi.advanceTimersByTimeAsync(400)
    await runPromise

    // Only INBOX was fetched — Sent was blocked by timedOut guard.
    expect(fetchOrder).toEqual(['INBOX'])

    // warn was called after sync settled.
    expect(warnMsgs.length).toBeGreaterThanOrEqual(1)
    expect(warnMsgs[0]).toMatch(/account #3/)

    // captureException for accountTimeout (overrun, not failure).
    expect(captures).toHaveLength(1)
    expect(captures[0].context.source).toBe('periodicSync:accountTimeout')
    expect(captures[0].context.accountId).toBe(3)
    expect(captures[0].context.elapsedMs).toBeGreaterThanOrEqual(SHORT_BUDGET)

    // Slot released after drain.
    expect(periodicSyncInFlight.has(3)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // MEDIUM-1 (codex §2.24 wave-2):
  // allSettled rejected account reason is logged and captured with source
  // 'periodicSync:accountFailed' and correct accountId via index correlation.
  // -------------------------------------------------------------------------

  it('MEDIUM-1: allSettled — rejected account reason captured with source "periodicSync:accountFailed" and correct accountId', async () => {
    vi.useFakeTimers()

    const captures: CaptureCall[] = []
    const warnMsgs: string[] = []

    // Make foldersFor throw synchronously for account #5 — this propagates
    // out of syncOneAccountFolders before the folder loop, causing
    // runOneAccountPeriodicSync to reject (the error escapes both the
    // per-folder catch and the try block, lands in the outer try and
    // re-throws because it's not a timedOut path).
    // In production this corresponds to listFolderPrefs() throwing (DB error).
    const deps = makeDeps({
      foldersFor: (aid) => {
        if (aid === 5) throw new Error('DB read failure')
        return ['INBOX']
      },
      fetchFolder: () => new Promise<void>(resolve => { setTimeout(resolve, 50) }),
      capture: (call) => captures.push(call),
      warn: (msg) => warnMsgs.push(msg),
    })

    // Accounts 5 (will reject) and 6 (healthy).
    const runPromise = runPeriodicSync([5, 6], deps)
    await vi.advanceTimersByTimeAsync(200)
    await runPromise

    // Account #6 must have completed normally — slot released.
    expect(periodicSyncInFlight.has(6)).toBe(false)
    // Account #5's slot also released via finally.
    expect(periodicSyncInFlight.has(5)).toBe(false)

    // Exactly one capture for the rejection, with the right source and accountId.
    const failureCapture = captures.find(c => c.context.source === 'periodicSync:accountFailed')
    expect(failureCapture).toBeDefined()
    expect(failureCapture!.context.accountId).toBe(5)

    // warn was called with the rejection info.
    const failureWarn = warnMsgs.find(m => m.includes('5'))
    expect(failureWarn).toBeDefined()
  })

  it('MEDIUM-1: allSettled — second account still completes when first account rejects', async () => {
    vi.useFakeTimers()

    const completedAids: number[] = []

    const deps = makeDeps({
      foldersFor: (aid) => {
        if (aid === 1) throw new Error('config error')
        return ['INBOX']
      },
      fetchFolder: (aid) => {
        return new Promise<void>(resolve => {
          setTimeout(() => {
            completedAids.push(aid)
            resolve()
          }, 50)
        })
      },
    })

    const runPromise = runPeriodicSync([1, 2, 3], deps)
    await vi.advanceTimersByTimeAsync(300)
    await runPromise

    // Accounts 2 and 3 completed; account 1 rejected before fetch.
    expect(completedAids).toContain(2)
    expect(completedAids).toContain(3)
    expect(completedAids).not.toContain(1)
    expect(periodicSyncInFlight.size).toBe(0)
  })

  it('MEDIUM-1: rejection index correlation — first account rejects, second succeeds, capture has accountId=toStart[0]', async () => {
    // Explicitly verifies index-based correlation: result[0] → toStart[0].
    // This guards against off-by-one bugs in the results.forEach loop.
    vi.useFakeTimers()

    const captures: CaptureCall[] = []

    const deps = makeDeps({
      foldersFor: (aid) => {
        if (aid === 10) throw new Error('first rejects')
        return ['INBOX']
      },
      fetchFolder: () => new Promise<void>(resolve => { setTimeout(resolve, 50) }),
      capture: (call) => captures.push(call),
    })

    // toStart = [10, 20] — index 0 = aid 10 (rejects), index 1 = aid 20 (ok).
    const runPromise = runPeriodicSync([10, 20], deps)
    await vi.advanceTimersByTimeAsync(200)
    await runPromise

    const failureCaptures = captures.filter(c => c.context.source === 'periodicSync:accountFailed')
    expect(failureCaptures).toHaveLength(1)
    // Must be accountId 10, not 20.
    expect(failureCaptures[0].context.accountId).toBe(10)
  })

  // -------------------------------------------------------------------------
  // pre-sync replay failure is swallowed, slot still drains.
  // (mirror-boundary rethink: replay callback gives direct control)
  // -------------------------------------------------------------------------

  it('pre-sync replay failure is swallowed and folder sync continues normally', async () => {
    vi.useFakeTimers()

    const fetchedFolders: string[] = []

    const deps = makeDeps({
      replay: () => Promise.reject(new Error('offline replay DB error')),
      foldersFor: () => ['INBOX', 'Sent'],
      fetchFolder: (_aid, folder) => {
        fetchedFolders.push(folder)
        return new Promise<void>(resolve => { setTimeout(resolve, 50) })
      },
    })

    const runPromise = runPeriodicSync([8], deps)
    await vi.advanceTimersByTimeAsync(300)
    await runPromise

    // Folder sync must have proceeded despite replay failure.
    expect(fetchedFolders).toEqual(['INBOX', 'Sent'])
    // No capture (replay failure is swallowed, not reported as accountFailed).
    expect((deps.capture as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    // Slot released.
    expect(periodicSyncInFlight.has(8)).toBe(false)
  })

  it('pre-sync replay failure does not prevent other accounts from syncing', async () => {
    vi.useFakeTimers()

    const fetchedAids: number[] = []

    const deps = makeDeps({
      replay: (aid) => {
        // Account #1 replay always fails; #2 succeeds.
        if (aid === 1) return Promise.reject(new Error('replay error'))
        return Promise.resolve()
      },
      foldersFor: () => ['INBOX'],
      fetchFolder: (aid) => {
        fetchedAids.push(aid)
        return new Promise<void>(resolve => { setTimeout(resolve, 50) })
      },
    })

    const runPromise = runPeriodicSync([1, 2], deps)
    await vi.advanceTimersByTimeAsync(200)
    await runPromise

    // Account #2 fetched INBOX; account #1 also fetched (replay error swallowed).
    expect(fetchedAids).toContain(1)
    expect(fetchedAids).toContain(2)
    expect(periodicSyncInFlight.size).toBe(0)
  })

  it('empty folder list: account returns early without fetching, slot still released', async () => {
    vi.useFakeTimers()

    const deps = makeDeps({
      foldersFor: () => [],
      fetchFolder: vi.fn().mockRejectedValue(new Error('should not be called')),
    })

    await runPeriodicSync([11], deps)

    expect((deps.fetchFolder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    expect(periodicSyncInFlight.has(11)).toBe(false)
  })

  it('all-in-flight guard: if every accountId is already in flight, runPeriodicSync is a no-op', async () => {
    // Pre-populate the set as if a previous tick is still running.
    periodicSyncInFlight.add(1)
    periodicSyncInFlight.add(2)

    const deps = makeDeps()

    await runPeriodicSync([1, 2], deps)

    // Nothing was started.
    expect((deps.fetchFolder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    // Set still has the original entries (not cleared by us).
    expect(periodicSyncInFlight.has(1)).toBe(true)
    expect(periodicSyncInFlight.has(2)).toBe(true)

    // Cleanup manually since these were added by us.
    periodicSyncInFlight.delete(1)
    periodicSyncInFlight.delete(2)
  })
})

// ---------------------------------------------------------------------------

describe('§2.24 PR1 — waitForPeriodicSyncIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    periodicSyncInFlight.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    periodicSyncInFlight.clear()
  })

  it('returns true immediately when no account is in flight', async () => {
    // Set is empty — the while loop body never executes.
    const resultPromise = waitForPeriodicSyncIdle(3_000)
    // No timers needed: the set is already empty, resolves synchronously
    // after the first while-condition check.
    await vi.advanceTimersByTimeAsync(0)
    const result = await resultPromise
    expect(result).toBe(true)
  })

  it('returns true once the in-flight set drains within the budget', async () => {
    const deps = makeDeps({
      foldersFor: () => ['INBOX'],
      fetchFolder: () => new Promise<void>(resolve => { setTimeout(resolve, 200) }),
    })

    // Start the account pass but do not await it yet.
    const syncPromise = runPeriodicSync([77], deps)

    // Account 77 should be in flight right away.
    expect(periodicSyncInFlight.has(77)).toBe(true)

    // waitForPeriodicSyncIdle should resolve true once the pass finishes.
    const idlePromise = waitForPeriodicSyncIdle(3_000)

    // Advance past the 200ms folder fetch + some polling cycles (50ms each).
    await vi.advanceTimersByTimeAsync(500)
    await syncPromise

    const result = await idlePromise
    expect(result).toBe(true)
    expect(periodicSyncInFlight.size).toBe(0)
  })

  it('returns false when the in-flight set does not drain within timeoutMs', async () => {
    // Manually occupy a slot — simulates a hung account that never finishes.
    periodicSyncInFlight.add(99)

    const idlePromise = waitForPeriodicSyncIdle(200)

    // Advance past the timeout budget without draining the set.
    await vi.advanceTimersByTimeAsync(500)

    const result = await idlePromise
    expect(result).toBe(false)
    // Slot was never released by the occupier (we put it in manually).
    expect(periodicSyncInFlight.has(99)).toBe(true)
  })

  it('returns true with multiple accounts: resolves only after ALL slots drain', async () => {
    // Account 1: 100ms. Account 2: 300ms.
    const deps = makeDeps({
      foldersFor: () => ['INBOX'],
      fetchFolder: (aid) => {
        const delay = aid === 1 ? 100 : 300
        return new Promise<void>(resolve => { setTimeout(resolve, delay) })
      },
    })

    const syncPromise = runPeriodicSync([1, 2], deps)

    expect(periodicSyncInFlight.size).toBe(2)

    const idlePromise = waitForPeriodicSyncIdle(3_000)

    // After 150ms: account 1 done, account 2 still in flight.
    await vi.advanceTimersByTimeAsync(150)
    expect(periodicSyncInFlight.has(1)).toBe(false)
    expect(periodicSyncInFlight.has(2)).toBe(true)

    // After 400ms total: both done.
    await vi.advanceTimersByTimeAsync(300)
    await syncPromise

    const result = await idlePromise
    expect(result).toBe(true)
    expect(periodicSyncInFlight.size).toBe(0)
  })
})
