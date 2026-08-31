import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'

// Mock the DB module
vi.mock('../../packages/db', () => ({
  getUidsWithoutBodyText: vi.fn().mockReturnValue([]),
  updateMessageBodyText: vi.fn(),
  listIndexedFolders: vi.fn().mockReturnValue([]),
  listFoldersWithPendingBodies: vi.fn().mockReturnValue([]),
  getSearchIndexStats: vi.fn().mockReturnValue({ totalMessages: 0, bodyIndexed: 0, filenamesIndexed: 0 }),
}))

// Spy on Sentry captureException so cooldown gate tests can assert how
// many times the real Sentry call gets through.
const captureExceptionMock = vi.fn()
vi.mock('../sentry', () => ({
  captureException: (err: unknown, ctx: unknown) => captureExceptionMock(err, ctx),
}))

// One shared logger instance (the module calls createLogger once at import
// time) so tests can assert HOW OFTEN something is logged, not just that the
// call did not blow up.
// vi.hoisted: `createLogger` is invoked while the module under test is being
// imported, i.e. before this file's own top-level consts would run.
const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}))
vi.mock('../logger', () => ({
  createLogger: () => logMock,
}))

// Span capture: record each startMetricSpan invocation and track end()
// so we can assert open/close symmetry and final attribute payloads.
type SpanRecord = {
  name: string
  openAttrs: Record<string, unknown>
  finalAttrs: Record<string, unknown>
  ended: boolean
}
const spanRecords: SpanRecord[] = []

vi.mock('../metrics', async () => {
  const bucketsModule = await import('../metricsBuckets')
  return {
    recordEvent: vi.fn(),
    recordHistogram: vi.fn(),
    recordGauge: vi.fn(),
    folderRoleFromPath: bucketsModule.folderRoleFromPath,
    bucketBatchSize: bucketsModule.bucketBatchSize,
    startMetricSpan: vi.fn((name: string, attrs: Record<string, unknown>) => {
      const rec: SpanRecord = {
        name,
        openAttrs: { ...attrs },
        finalAttrs: {},
        ended: false,
      }
      spanRecords.push(rec)
      return {
        setAttributes(extra: Record<string, unknown>) {
          Object.assign(rec.finalAttrs, extra)
        },
        end() {
          rec.ended = true
        },
      }
    }),
  }
})

import {
  startBodyIndexer,
  stopBodyIndexer,
  getIndexStats,
  getBodyIndexerDelayMs,
  resetBodyIndexerBackoff,
  resetBodyIndexerErrors,
  captureOnce,
  resetBodyIndexerCaptureGate,
} from './bodyIndexer'
import {
  listIndexedFolders,
  listFoldersWithPendingBodies,
  getUidsWithoutBodyText,
  updateMessageBodyText,
  getSearchIndexStats,
} from '../../packages/db'

/** Shorthand for the folder work list the indexer now starts from. */
function pendingFolders(...folders: Array<[number, string, number]>) {
  return folders.map(([accountId, folder, pending]) => ({ accountId, folder, pending }))
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Poll until `predicate` holds or the deadline passes; returns whether it held. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(5)
  }
  return predicate()
}

describe('bodyIndexer', () => {
  afterEach(() => {
    stopBodyIndexer()
    resetBodyIndexerErrors()
    spanRecords.length = 0
    vi.restoreAllMocks()
    vi.mocked(listFoldersWithPendingBodies).mockReturnValue([])
    vi.mocked(listIndexedFolders).mockReturnValue([])
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([])
  })

  it('getIndexStats delegates to getSearchIndexStats', () => {
    vi.mocked(getSearchIndexStats).mockReturnValue({
      totalMessages: 100,
      bodyIndexed: 50,
      filenamesIndexed: 30,
    })
    const stats = getIndexStats([1, 2])
    expect(stats.totalMessages).toBe(100)
    expect(stats.bodyIndexed).toBe(50)
    expect(getSearchIndexStats).toHaveBeenCalledWith([1, 2])
  })

  it('does not start indexing when offline', async () => {
    const fetchBody = vi.fn()
    startBodyIndexer({
      fetchBody,
      isOffline: () => true,
      intervalMs: 50,
    })

    await new Promise(r => setTimeout(r, 200))
    expect(fetchBody).not.toHaveBeenCalled()
  })

  it('indexes messages with missing body text', async () => {
    vi.mocked(listFoldersWithPendingBodies).mockReturnValue(pendingFolders([1, 'INBOX', 2]))
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([10, 11])

    const fetchBody = vi.fn().mockResolvedValue({ text: 'Hello world' })

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000, // Large interval — only the first tick runs
      initialDelayMs: 20,
      batchSize: 10,
    })

    // Wait for the initial tick
    await new Promise(r => setTimeout(r, 300))

    expect(fetchBody).toHaveBeenCalledWith(1, 'INBOX', 10)
    expect(fetchBody).toHaveBeenCalledWith(1, 'INBOX', 11)
    expect(updateMessageBodyText).toHaveBeenCalledWith(1, 'INBOX', 10, 'Hello world')
    expect(updateMessageBodyText).toHaveBeenCalledWith(1, 'INBOX', 11, 'Hello world')
  })

  it('handles fetch failure gracefully (no crash)', async () => {
    vi.mocked(listFoldersWithPendingBodies).mockReturnValue(pendingFolders([1, 'INBOX', 1]))
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([5])

    const fetchBody = vi.fn().mockRejectedValue(new Error('IMAP timeout'))

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      initialDelayMs: 20,
      batchSize: 10,
    })

    await new Promise(r => setTimeout(r, 300))

    expect(fetchBody).toHaveBeenCalledWith(1, 'INBOX', 5)
    // Should not have updated body_text (will retry next tick)
    expect(updateMessageBodyText).not.toHaveBeenCalled()
  })

  it('marks empty body when fetchBody returns null', async () => {
    vi.mocked(listFoldersWithPendingBodies).mockReturnValue(pendingFolders([1, 'INBOX', 1]))
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([7])

    const fetchBody = vi.fn().mockResolvedValue(null)

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      initialDelayMs: 20,
      batchSize: 10,
    })

    await new Promise(r => setTimeout(r, 300))

    expect(updateMessageBodyText).toHaveBeenCalledWith(1, 'INBOX', 7, '')
  })

  it('stopBodyIndexer stops the timer', () => {
    const fetchBody = vi.fn()
    startBodyIndexer({ fetchBody, intervalMs: 50 })
    stopBodyIndexer()
    // After stopping, no more ticks should fire
    expect(fetchBody).not.toHaveBeenCalled()
  })

  it('prioritizes folders: INBOX before Sent before others', async () => {
    const callOrder: string[] = []
    vi.mocked(listFoldersWithPendingBodies).mockReturnValue(
      pendingFolders([1, 'Archive', 5], [1, 'Sent', 3], [1, 'INBOX', 10]),
    )
    vi.mocked(getUidsWithoutBodyText).mockImplementation((_aid, folder) => {
      callOrder.push(folder)
      return [1]
    })
    const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      initialDelayMs: 20,
      batchSize: 10,
    })

    await new Promise(r => setTimeout(r, 300))

    // INBOX should come first, then Sent, then Archive
    expect(callOrder[0]).toBe('INBOX')
    expect(callOrder[1]).toBe('Sent')
    expect(callOrder[2]).toBe('Archive')
  })

  it('opens body_indexer.batch span with folder_role and ends it on success', async () => {
    vi.mocked(listFoldersWithPendingBodies).mockReturnValue(pendingFolders([1, 'INBOX', 2]))
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([10, 11])

    const fetchBody = vi.fn().mockResolvedValue({ text: 'Hello world' })

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      initialDelayMs: 20,
      batchSize: 10,
    })

    await new Promise(r => setTimeout(r, 300))

    const batchSpans = spanRecords.filter(s => s.name === 'body_indexer.batch')
    expect(batchSpans.length).toBeGreaterThanOrEqual(1)
    const span = batchSpans[0]!
    expect(span.openAttrs.folder_role).toBe('inbox')
    expect(span.ended).toBe(true)
    expect(span.finalAttrs.fetched_ok_bucket).toBe('2')
    expect(span.finalAttrs.failed_bucket).toBe('0')
    expect(span.finalAttrs.batch_size_bucket).toBe('1-10')
  })

  it('ends body_indexer.batch span on error path with failed counter', async () => {
    vi.mocked(listFoldersWithPendingBodies).mockReturnValue(pendingFolders([1, 'INBOX', 3]))
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([1, 2, 3])

    const fetchBody = vi.fn().mockRejectedValue(new Error('IMAP timeout'))

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      initialDelayMs: 20,
      batchSize: 10,
    })

    await new Promise(r => setTimeout(r, 300))

    const batchSpans = spanRecords.filter(s => s.name === 'body_indexer.batch')
    expect(batchSpans.length).toBeGreaterThanOrEqual(1)
    const span = batchSpans[0]!
    expect(span.ended).toBe(true)
    expect(span.openAttrs.folder_role).toBe('inbox')
    expect(span.finalAttrs.fetched_ok_bucket).toBe('0')
    expect(typeof span.finalAttrs.failed_bucket).toBe('string')
    expect(span.finalAttrs.failed_bucket).not.toBe('0')
  })

  describe('captureOnce cooldown gate', () => {
    beforeEach(() => {
      resetBodyIndexerCaptureGate()
      captureExceptionMock.mockClear()
    })

    it('first capture for a key passes through to Sentry', () => {
      const err = new Error('boom')
      captureOnce('k1', err, { source: 'test' })
      expect(captureExceptionMock).toHaveBeenCalledTimes(1)
      expect(captureExceptionMock).toHaveBeenCalledWith(err, { source: 'test' })
    })

    it('second capture with same key within cooldown is suppressed', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      try {
        captureOnce('k1', new Error('boom'), {})
        // 1 minute later — well within the 5-minute default cooldown.
        vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))
        captureOnce('k1', new Error('boom'), {})
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('different key is not suppressed by an unrelated recent capture', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      try {
        captureOnce('k1', new Error('boom'), {})
        vi.setSystemTime(new Date('2026-01-01T00:00:30Z'))
        captureOnce('k2', new Error('different'), {})
        expect(captureExceptionMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('capture after cooldown expiry passes through again', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      try {
        captureOnce('k1', new Error('boom'), {})
        // 6 minutes later — past the 5-minute default cooldown.
        vi.setSystemTime(new Date('2026-01-01T00:06:00Z'))
        captureOnce('k1', new Error('boom'), {})
        expect(captureExceptionMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // `maxFolderRetries` was declared and documented but never read: the folder
  // backoff threshold was the literal 3. A caller setting it got a silent
  // no-op, which is exactly the defect class this repo keeps paying for. These
  // two tests pin the option to observable behaviour — the number of fetches
  // a dead folder is allowed before the tick abandons it — so a regression to
  // a hardcoded constant fails here rather than passing unnoticed.
  //
  // Fetches run in slices of CONCURRENCY=2, so with 5 dead UIDs: threshold 2
  // aborts inside the first slice (2 fetches), the default 3 aborts on the
  // first UID of the second slice (4 fetches).
  it('backs off a folder after maxFolderRetries consecutive errors', async () => {
    vi.mocked(listFoldersWithPendingBodies).mockReturnValue(pendingFolders([1, 'INBOX', 5]))
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([1, 2, 3, 4, 5])
    const fetchBody = vi.fn().mockRejectedValue(new Error('IMAP error'))

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      initialDelayMs: 20,
      batchSize: 10,
      maxFolderRetries: 2,
    })

    expect(await waitFor(() => fetchBody.mock.calls.length >= 2, 1_000)).toBe(true)
    await wait(150)
    expect(fetchBody).toHaveBeenCalledTimes(2)
  })

  it('uses 3 consecutive errors as the default backoff threshold', async () => {
    vi.mocked(listFoldersWithPendingBodies).mockReturnValue(pendingFolders([1, 'INBOX', 5]))
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([1, 2, 3, 4, 5])
    const fetchBody = vi.fn().mockRejectedValue(new Error('IMAP error'))

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      initialDelayMs: 20,
      batchSize: 10,
    })

    expect(await waitFor(() => fetchBody.mock.calls.length >= 4, 1_000)).toBe(true)
    await wait(150)
    expect(fetchBody).toHaveBeenCalledTimes(4)
  })

  // A per-UID `fetchBody` rejection is caught by Promise.allSettled inside the
  // folder's own try/finally (see the test above) and never reaches the tick's
  // outer catch. This test targets the OTHER path: something that throws
  // SYNCHRONOUSLY from the folder loop itself (a DB read failing, e.g.
  // getUidsWithoutBodyText hitting "database is locked"). That is not caught by
  // Promise.allSettled at all, and the only thing standing between it and a
  // permanently wedged indexer is the tick's own `try { ... } catch { ... }
  // finally { running = false }` wrapper.
  it('a throw from the folder loop itself (not fetchBody) is contained: reported once, and the indexer keeps ticking afterward', async () => {
    vi.mocked(listFoldersWithPendingBodies).mockReturnValue(pendingFolders([1, 'INBOX', 1]))
    let calls = 0
    vi.mocked(getUidsWithoutBodyText).mockImplementation(() => {
      calls++
      if (calls === 1) throw new Error('database is locked')
      return [1]
    })
    const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 30,
      initialDelayMs: 5,
      batchSize: 10,
    })

    // First tick throws before fetchBody is ever reached.
    expect(await waitFor(() => calls >= 1, 1_000)).toBe(true)
    expect(fetchBody).not.toHaveBeenCalled()
    expect(captureExceptionMock).toHaveBeenCalled()

    // If `running` were left `true` after the throw, every later tick would
    // bail at its very first line and fetchBody would never fire again — this
    // is the actual failure mode the try/catch/finally guards against.
    expect(await waitFor(() => fetchBody.mock.calls.length > 0, 1_000)).toBe(true)
  })

  // --- §2.115: adaptive schedule ---
  //
  // A live instance logged 10 473 of 10 497 ticks with `indexed: 0`, each one
  // scheduled as densely as a useful one. These tests pin the two halves of the
  // fix: empty ticks get rarer, and getting rarer must never mean "never".

  describe('§2.115 adaptive schedule', () => {
    /**
     * Minimal stand-in for the pending-body tables: folders map to the UIDs
     * still waiting for a body. Writing a body removes the UID, exactly like
     * the row leaving the partial index.
     */
    function makeBacklog() {
      const backlog = new Map<string, number[]>()
      vi.mocked(listFoldersWithPendingBodies).mockImplementation(() =>
        [...backlog.entries()]
          .filter(([, uids]) => uids.length > 0)
          .map(([key, uids]) => {
            const [accountId, folder] = key.split('|') as [string, string]
            return { accountId: Number(accountId), folder, pending: uids.length }
          }),
      )
      vi.mocked(getUidsWithoutBodyText).mockImplementation((accountId, folder, limit) =>
        (backlog.get(`${accountId}|${folder}`) ?? []).slice(0, limit ?? 100),
      )
      vi.mocked(updateMessageBodyText).mockImplementation((accountId, folder, uid) => {
        const key = `${accountId}|${folder}`
        backlog.set(key, (backlog.get(key) ?? []).filter(u => u !== uid))
      })
      return {
        add(accountId: number, folder: string, uids: number[]) {
          const key = `${accountId}|${folder}`
          backlog.set(key, [...(backlog.get(key) ?? []), ...uids])
        },
        remaining() {
          return [...backlog.values()].reduce((n, uids) => n + uids.length, 0)
        },
      }
    }

    it('doubles the delay on empty ticks up to the ceiling, and stops polling that often', async () => {
      const fetchBody = vi.fn()
      startBodyIndexer({
        fetchBody,
        isOffline: () => false,
        intervalMs: 20,
        idleMaxIntervalMs: 160,
        initialDelayMs: 5,
      })

      // 5 + 40 + 80 + 160 … — the ceiling is reached after four empty ticks.
      expect(await waitFor(() => getBodyIndexerDelayMs() === 160, 2_000)).toBe(true)
      const ticksAtCeiling = vi.mocked(listFoldersWithPendingBodies).mock.calls.length

      // This runs on the real clock, so the bound is derived from the window
      // that actually elapsed rather than the 400 ms asked for. Under a loaded
      // `npm test` a nominal 400 ms wait can return at 800+ ms, and a fixed
      // `<= 4` would then fail on correct behaviour — measuring the machine,
      // not the backoff. The rate is what this test is about: at the 160 ms
      // ceiling the indexer fits ceil(elapsed / 160) ticks in the window (+1
      // for the partial interval either edge lands in), whereas the regression
      // this pins — a delay that never grew past the 20 ms base — fits
      // elapsed / 20, eight times more, at any elapsed value.
      const windowStarted = Date.now()
      await wait(400)
      const windowMs = Date.now() - windowStarted

      const extraTicks = vi.mocked(listFoldersWithPendingBodies).mock.calls.length - ticksAtCeiling
      expect(extraTicks).toBeLessThanOrEqual(Math.ceil(windowMs / 160) + 1)
      expect(fetchBody).not.toHaveBeenCalled()
      // Empty ticks never touch the corpus-wide folder list either.
      expect(listIndexedFolders).not.toHaveBeenCalled()
    })

    it('indexes mail that arrives while the indexer is maximally backed off', async () => {
      const backlog = makeBacklog()
      const fetchBody = vi.fn().mockResolvedValue({ text: 'body text' })

      startBodyIndexer({
        fetchBody,
        isOffline: () => false,
        intervalMs: 20,
        idleMaxIntervalMs: 100,
        initialDelayMs: 5,
        batchSize: 50,
      })

      // Drive the indexer into its slowest state first.
      expect(await waitFor(() => getBodyIndexerDelayMs() === 100, 2_000)).toBe(true)

      // New mail lands (header sync inserted rows with no body).
      backlog.add(1, 'INBOX', [101, 102, 103])

      expect(await waitFor(() => backlog.remaining() === 0, 3_000)).toBe(true)
      expect(fetchBody).toHaveBeenCalledTimes(3)
      // Progress snaps the schedule back to the base interval, so the rest of
      // the backlog drains at full speed rather than one batch per ceiling.
      expect(await waitFor(() => getBodyIndexerDelayMs() === 20, 1_000)).toBe(true)

      // A second wave, arriving right after the first, is picked up promptly.
      backlog.add(1, 'INBOX', [104])
      expect(await waitFor(() => backlog.remaining() === 0, 1_000)).toBe(true)
      expect(fetchBody).toHaveBeenCalledWith(1, 'INBOX', 104)
    })

    it('keeps the base cadence while paused instead of backing off', async () => {
      const backlog = makeBacklog()
      let paused = true
      const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })

      startBodyIndexer({
        fetchBody,
        isOffline: () => false,
        isPaused: () => paused,
        intervalMs: 20,
        idleMaxIntervalMs: 1_000,
        initialDelayMs: 5,
      })

      backlog.add(1, 'INBOX', [1, 2])
      await wait(200)
      // Paused is "not now", not "no work": no fetches, no backoff growth.
      expect(fetchBody).not.toHaveBeenCalled()
      expect(getBodyIndexerDelayMs()).toBe(20)

      paused = false
      expect(await waitFor(() => backlog.remaining() === 0, 1_000)).toBe(true)
    })

    // --- resetBodyIndexerBackoff ---
    //
    // These assert TIME TO FIRST FETCH after a reset, on fake timers. The
    // earlier version of this test only read getBodyIndexerDelayMs() back, and
    // that number was already correct on the broken implementation: the reset
    // assigned the variable but left the ceiling-length timeout armed, so work
    // was still first fetched a full ceiling later. A schedule test that never
    // measures the schedule is a false assurance.

    /** Advance fake time in steps; returns fake ms until `predicate` held, or -1. */
    async function advanceUntil(predicate: () => boolean, maxMs: number, stepMs = 1): Promise<number> {
      if (predicate()) return 0
      for (let elapsed = stepMs; elapsed <= maxMs; elapsed += stepMs) {
        await vi.advanceTimersByTimeAsync(stepMs)
        if (predicate()) return elapsed
      }
      return -1
    }

    /** Run the indexer up to its idle ceiling with fake timers already active. */
    async function startAndReachCeiling(fetchBody: ReturnType<typeof vi.fn>) {
      startBodyIndexer({
        fetchBody,
        isOffline: () => false,
        intervalMs: 20,
        idleMaxIntervalMs: 1_000,
        initialDelayMs: 5,
      })
      // 5 + 40 + 80 + 160 + 320 + 640 + 1000 … — comfortably past the ceiling.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(getBodyIndexerDelayMs()).toBe(1_000)
    }

    it('resetBodyIndexerBackoff pulls the next tick forward: work is fetched at the base interval, not a ceiling later', async () => {
      vi.useFakeTimers()
      try {
        const backlog = makeBacklog()
        const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })
        await startAndReachCeiling(fetchBody)

        // A sync commits rows and hints at them, exactly as main does.
        backlog.add(1, 'INBOX', [1])
        resetBodyIndexerBackoff()

        const msToFirstFetch = await advanceUntil(() => fetchBody.mock.calls.length > 0, 1_500)
        expect(msToFirstFetch).toBeGreaterThanOrEqual(0)
        // Broken implementation: 999 ms (the untouched ceiling timeout).
        expect(msToFirstFetch).toBeLessThanOrEqual(30)
        expect(backlog.remaining()).toBe(0)
        expect(getBodyIndexerDelayMs()).toBe(20)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a burst of resets neither stacks timers nor pushes the tick out', async () => {
      vi.useFakeTimers()
      try {
        const backlog = makeBacklog()
        const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })
        await startAndReachCeiling(fetchBody)

        backlog.add(1, 'INBOX', [1])
        resetBodyIndexerBackoff()
        // Exactly one armed tick, and it stays exactly one: main resets once
        // per synced folder, i.e. many times inside one base interval.
        expect(vi.getTimerCount()).toBe(1)
        for (let i = 0; i < 5; i++) {
          await vi.advanceTimersByTimeAsync(3)
          resetBodyIndexerBackoff()
          expect(vi.getTimerCount()).toBe(1)
        }

        // 15 ms of the 20 ms interval already spent inside the burst: the
        // deadline set by the FIRST reset was never pushed out by the others.
        const msAfterBurst = await advanceUntil(() => fetchBody.mock.calls.length > 0, 500)
        expect(msAfterBurst).toBeGreaterThanOrEqual(0)
        expect(msAfterBurst).toBeLessThanOrEqual(10)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a reset that lands during a tick is not doubled away by that tick', async () => {
      vi.useFakeTimers()
      try {
        const backlog = makeBacklog()
        const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })
        // Base interval deliberately coarse: a reset swallowed by the tick's
        // own backoff produces exactly 2× base (the reset already lowered the
        // delay), so the two outcomes are 200 ms vs 400 ms of fake time and
        // the assertion has real margin rather than a couple of ticks.
        startBodyIndexer({
          fetchBody,
          isOffline: () => false,
          intervalMs: 200,
          idleMaxIntervalMs: 5_000,
          initialDelayMs: 5,
        })
        await vi.advanceTimersByTimeAsync(60_000)
        expect(getBodyIndexerDelayMs()).toBe(5_000)

        // The tick asks the DB for work, and only THEN does a sync commit rows
        // and hint. The tick itself will finish empty.
        const listMock = vi.mocked(listFoldersWithPendingBodies)
        const readBacklog = listMock.getMockImplementation()!
        let hinted = false
        listMock.mockImplementation(() => {
          const snapshot = readBacklog()
          if (!hinted) {
            hinted = true
            backlog.add(1, 'INBOX', [7])
            resetBodyIndexerBackoff()
          }
          return snapshot
        })

        const msToHint = await advanceUntil(() => hinted, 6_000, 10)
        expect(msToHint).toBeGreaterThanOrEqual(0)

        // Measured from the hint: one base interval (200 ms), not the doubled
        // 400 ms a tick that ignored the mid-flight reset would produce.
        const msHintToFirstFetch = await advanceUntil(() => fetchBody.mock.calls.length > 0, 2_000, 10)
        expect(msHintToFirstFetch).toBeGreaterThanOrEqual(0)
        expect(msHintToFirstFetch).toBeLessThanOrEqual(250)
        expect(fetchBody).toHaveBeenCalledWith(1, 'INBOX', 7)
      } finally {
        vi.useRealTimers()
      }
    })

    // Cross-slice check: §2.115 gave the indexer TWO knobs that both come from
    // main.ts — `resetBodyIndexerBackoff()` and `isPaused`. main.ts calls the
    // reset from `runSyncFolderHeaders`' own tail `finally`, which runs BEFORE
    // the OUTER finally that decrements `activeHeaderSyncs` (the counter behind
    // `isHeaderSyncActive()` / `isPaused`). So in production the reset can land
    // while `isPaused()` is STILL true. Neither the bodyIndexer.ts unit tests
    // (which never combine the two) nor the main.ts structural wiring test
    // (which cannot execute the scheduler at all) exercise that ordering.
    it('a reset that lands while paused is not lost: the pause is honoured, and work resumes at the base interval once it lifts', async () => {
      vi.useFakeTimers()
      try {
        const backlog = makeBacklog()
        const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })
        let paused = false
        // Ceiling deliberately WAY above the assertion windows below (100 s vs
        // a 500 ms wait): if `resetBodyIndexerBackoff()`'s re-arm were a no-op
        // while paused (the exact regression this pins), the only thing left
        // to fire the tick would be the stale ceiling-length timer, and it
        // would still be ~100 s out — nowhere near either bounded wait, so the
        // test cannot pass "by coincidence" the way a tight ceiling could.
        startBodyIndexer({
          fetchBody,
          isOffline: () => false,
          isPaused: () => paused,
          intervalMs: 20,
          idleMaxIntervalMs: 100_000,
          initialDelayMs: 5,
        })
        // Drive to the idle ceiling with nothing to do.
        await vi.advanceTimersByTimeAsync(400_000)
        expect(getBodyIndexerDelayMs()).toBe(100_000)

        // A header sync starts (pausing the indexer), commits rows, and calls
        // resetBodyIndexerBackoff() from its own tail finally — all while
        // isHeaderSyncActive() (and therefore isPaused()) is still true.
        paused = true
        backlog.add(1, 'INBOX', [1])
        resetBodyIndexerBackoff()

        // While still paused, no fetch happens no matter how long we wait —
        // the reset must never override the pause.
        await vi.advanceTimersByTimeAsync(500)
        expect(fetchBody).not.toHaveBeenCalled()

        // The sync finishes and clears the pause flag.
        paused = false
        const msToFetch = await advanceUntil(() => fetchBody.mock.calls.length > 0, 2_000)
        // Picked up well inside the bounded window — not the ~100 s ceiling a
        // lost reset would have left behind.
        expect(msToFetch).toBeGreaterThanOrEqual(0)
        expect(msToFetch).toBeLessThanOrEqual(100)
      } finally {
        vi.useRealTimers()
      }
    })

    // The `generation` counter exists specifically to stop a tick that was
    // still in flight when `stopBodyIndexer()` was called from re-arming the
    // timer of an instance that no longer exists — see the comment on
    // `generation` in bodyIndexer.ts. Nothing in this file previously started
    // a SECOND instance while a first one's tick was suspended, so that claim
    // was undemonstrated.
    it('a tick in flight when stopped cannot resurface and steal the next instance\'s schedule (stale generation)', async () => {
      const backlog = makeBacklog()
      backlog.add(1, 'INBOX', [1])
      let releaseOld: (() => void) | undefined
      const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
      const fetchBodyOld = vi.fn(() => oldGate.then(() => ({ text: 'stale body' })))

      startBodyIndexer({ fetchBody: fetchBodyOld, isOffline: () => false, intervalMs: 30, initialDelayMs: 5 })
      // Tick 1 (generation 1) is now suspended mid-fetch: `running` is true,
      // no timer is armed (scheduleNext only runs once the tick settles).
      expect(await waitFor(() => fetchBodyOld.mock.calls.length > 0, 1_000)).toBe(true)
      stopBodyIndexer()

      const fetchBodyNew = vi.fn().mockResolvedValue({ text: 'fresh body' })
      startBodyIndexer({ fetchBody: fetchBodyNew, isOffline: () => false, intervalMs: 5_000, initialDelayMs: 50 })
      // Distinct work for the NEW instance, on a different account/folder so
      // it cannot be satisfied by the old tick's own (still pending) uid —
      // this is what lets the two chains be told apart by which fetch fires.
      backlog.add(2, 'OTHER', [99])

      // Let the stale tick's fetch finally resolve. Its `.finally(() =>
      // scheduleNext(nextDelayMs))` now runs with `started === true` again but
      // a `generation` that is no longer current — this is the exact race the
      // guard exists for.
      releaseOld?.()
      await oldGate

      // The new instance must own the schedule: its own initial tick fires and
      // picks up the new work with fetchBodyNew.
      expect(await waitFor(() => fetchBodyNew.mock.calls.length > 0, 1_000)).toBe(true)
      expect(fetchBodyNew).toHaveBeenCalledWith(2, 'OTHER', 99)
      // The stale generation must never call fetchBody again after resolving
      // — if the guard were dropped, its re-armed timer would have clobbered
      // the new instance's own timer (both live in the same module-level
      // `timer` variable) well before this window elapses.
      await wait(150)
      expect(fetchBodyOld).toHaveBeenCalledTimes(1)
    })

    it('reset is a no-op once the indexer is stopped', async () => {
      vi.useFakeTimers()
      try {
        const backlog = makeBacklog()
        backlog.add(1, 'INBOX', [1])
        const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })
        startBodyIndexer({
          fetchBody,
          isOffline: () => false,
          intervalMs: 20,
          idleMaxIntervalMs: 1_000,
          initialDelayMs: 5,
        })
        stopBodyIndexer()
        expect(vi.getTimerCount()).toBe(0)

        resetBodyIndexerBackoff()
        // No timer resurrected, and nothing runs afterwards.
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(fetchBody).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('caps the backoff lower while a backlog is still waiting on folder retries', async () => {
      const backlog = makeBacklog()
      backlog.add(1, 'INBOX', [1, 2, 3, 4])
      // Every fetch fails: the folder enters its own error backoff and the tick
      // stops making progress while the work list stays non-empty.
      const fetchBody = vi.fn().mockRejectedValue(new Error('IMAP down'))

      startBodyIndexer({
        fetchBody,
        isOffline: () => false,
        intervalMs: 20,
        idleMaxIntervalMs: 100_000,
        retryMaxIntervalMs: 80, // stands in for the production 60 s
        initialDelayMs: 5,
      })

      expect(await waitFor(() => fetchBody.mock.calls.length > 0, 1_000)).toBe(true)
      // Delay grows, but stops at the retry ceiling — the idle ceiling would
      // otherwise park a recoverable folder for minutes.
      expect(await waitFor(() => getBodyIndexerDelayMs() === 80, 1_000)).toBe(true)
      await wait(300)
      expect(getBodyIndexerDelayMs()).toBe(80)
      expect(backlog.remaining()).toBe(4)
    })

    it('yields to the event loop between folders', async () => {
      const backlog = makeBacklog()
      for (let i = 0; i < 4; i++) backlog.add(1, `Folder${i}`, [i + 1])
      const order: string[] = []
      let scheduled = false
      vi.mocked(getUidsWithoutBodyText).mockImplementation((accountId, folder) => {
        order.push(folder)
        if (!scheduled) {
          scheduled = true
          // Queued while the first folder is being handled: with a yield
          // between folders it must run before the tick walks the rest.
          setTimeout(() => order.push('event-loop'), 0)
        }
        return [Number(accountId)]
      })
      const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })

      startBodyIndexer({
        fetchBody,
        isOffline: () => false,
        intervalMs: 100_000,
        initialDelayMs: 5,
      })

      expect(await waitFor(() => order.length >= 5, 5_000)).toBe(true)
      // The queued task ran between two folders, not after the whole pass.
      expect(order.indexOf('event-loop')).toBeGreaterThan(0)
      expect(order.indexOf('event-loop')).toBeLessThan(order.length - 1)
    })

    it('does not recompute corpus stats on every tick when onProgress is set', async () => {
      const onProgress = vi.fn()
      vi.mocked(getSearchIndexStats).mockReturnValue({ totalMessages: 10, bodyIndexed: 10, filenamesIndexed: 10 })

      startBodyIndexer({
        fetchBody: vi.fn(),
        isOffline: () => false,
        intervalMs: 10,
        idleMaxIntervalMs: 20,
        initialDelayMs: 5,
        statsIntervalMs: 60_000,
        onProgress,
      })

      expect(await waitFor(() => onProgress.mock.calls.length > 0, 5_000)).toBe(true)
      // Wait for several more ticks — the aggregation must not follow them.
      expect(await waitFor(
        () => vi.mocked(listFoldersWithPendingBodies).mock.calls.length >= 5,
        5_000,
      )).toBe(true)
      expect(onProgress).toHaveBeenCalledTimes(1)
      expect(vi.mocked(getSearchIndexStats).mock.calls.length).toBe(1)
    })

    // --- Caller-supplied predicates that throw ---
    //
    // `isOffline` and `isPaused` come from main and read real state (the
    // settings store, the header-sync counter). A settings read is I/O and can
    // fail — EACCES under concurrent access has been observed in this repo.
    // Both used to be evaluated OUTSIDE the tick's try/catch, so a throw
    // rejected the floating `tick()` promise: an unhandled rejection every
    // interval, forever, with none of the tick's bookkeeping executed.
    //
    // The chosen direction is FAIL SAFE — "cannot tell" is read as "hold off".
    // These tests exist to make that choice visible: with a full backlog and a
    // broken predicate, the correct observable outcome is that NOTHING is
    // fetched, and that indexing resumes within one base interval afterwards.
    describe('a predicate that throws', () => {
      /** Collect unhandled rejections for the duration of `body`. */
      async function withUnhandledRejectionWatch(body: () => Promise<void>): Promise<unknown[]> {
        const seen: unknown[] = []
        const onUnhandled = (reason: unknown) => { seen.push(reason) }
        process.on('unhandledRejection', onUnhandled)
        try {
          await body()
        } finally {
          process.off('unhandledRejection', onUnhandled)
        }
        return seen
      }

      beforeEach(() => {
        resetBodyIndexerCaptureGate()
        captureExceptionMock.mockClear()
        logMock.error.mockClear()
        // Call history is what these tests assert on, and the DB mocks are
        // module-level singletons shared with every earlier test.
        vi.mocked(listFoldersWithPendingBodies).mockClear()
      })

      it('is contained: no unhandled rejection, one tick still scheduled, reported once rather than per tick, and a later healthy tick runs normally', async () => {
        vi.useFakeTimers()
        try {
          const backlog = makeBacklog()
          backlog.add(1, 'INBOX', [1, 2])
          const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })
          let broken = true
          const isOffline = vi.fn(() => {
            if (broken) throw new Error('EACCES: permission denied, open settings.json')
            return false
          })

          const unhandled = await withUnhandledRejectionWatch(async () => {
            startBodyIndexer({
              fetchBody,
              isOffline,
              intervalMs: 20,
              idleMaxIntervalMs: 1_000,
              initialDelayMs: 5,
            })

            // ~50 ticks at the base cadence, every one of them hitting the
            // broken predicate.
            await vi.advanceTimersByTimeAsync(1_000)
            expect(isOffline.mock.calls.length).toBeGreaterThan(10)

            // Direction: "cannot tell" ⇒ "hold off". The backlog is untouched.
            expect(fetchBody).not.toHaveBeenCalled()
            expect(backlog.remaining()).toBe(2)
            // The tick never got as far as asking the DB for work.
            expect(listFoldersWithPendingBodies).not.toHaveBeenCalled()

            // The scheduler neither wedged nor forked: exactly one armed tick.
            expect(vi.getTimerCount()).toBe(1)
            // A skipped tick keeps the base cadence — it is "not now", not
            // "no work" — so recovery costs at most one interval.
            expect(getBodyIndexerDelayMs()).toBe(20)

            // Reported once for the whole storm, not once per tick.
            expect(logMock.error).toHaveBeenCalledTimes(1)
            expect(captureExceptionMock).toHaveBeenCalledTimes(1)
            expect(captureExceptionMock.mock.calls[0]?.[1]).toMatchObject({
              source: 'bodyIndexer',
              predicate: 'isOffline',
            })

            // The predicate recovers; the very next tick indexes normally.
            broken = false
            const msToFetch = await advanceUntil(() => fetchBody.mock.calls.length > 0, 500)
            expect(msToFetch).toBeGreaterThanOrEqual(0)
            expect(msToFetch).toBeLessThanOrEqual(30)
            expect(backlog.remaining()).toBe(0)
          })

          expect(unhandled).toEqual([])
        } finally {
          vi.useRealTimers()
        }
      })

      it('is read as "paused", not as "free to run", when isPaused is the one throwing', async () => {
        vi.useFakeTimers()
        try {
          const backlog = makeBacklog()
          backlog.add(1, 'INBOX', [7])
          const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })
          let broken = true

          const unhandled = await withUnhandledRejectionWatch(async () => {
            startBodyIndexer({
              fetchBody,
              isOffline: () => false,
              isPaused: () => {
                if (broken) throw new Error('header sync counter unavailable')
                return false
              },
              intervalMs: 20,
              idleMaxIntervalMs: 1_000,
              initialDelayMs: 5,
            })

            await vi.advanceTimersByTimeAsync(1_000)
            // Choosing the other direction here would resume IMAP fetches in
            // the middle of a header sync — the pool contention `isPaused`
            // exists to prevent.
            expect(fetchBody).not.toHaveBeenCalled()
            expect(logMock.error).toHaveBeenCalledTimes(1)
            expect(captureExceptionMock).toHaveBeenCalledTimes(1)
            expect(captureExceptionMock.mock.calls[0]?.[1]).toMatchObject({ predicate: 'isPaused' })

            broken = false
            const msToFetch = await advanceUntil(() => fetchBody.mock.calls.length > 0, 500)
            expect(msToFetch).toBeGreaterThanOrEqual(0)
            expect(msToFetch).toBeLessThanOrEqual(30)
            expect(fetchBody).toHaveBeenCalledWith(1, 'INBOX', 7)
          })

          expect(unhandled).toEqual([])
        } finally {
          vi.useRealTimers()
        }
      })

      // --- The PII boundary of the failure report ---
      //
      // In production `isOffline` is `() => getSettings().workOffline === true`,
      // so the exception it throws is written by Node's fs layer / the settings
      // store and normally embeds a filesystem path. `scrubEventPii` is the last
      // line of defence, not the only one (CLAUDE.md §5): an arbitrary message is
      // free text with no shape for a regex to recognise, so the send site itself
      // must emit aggregates.
      //
      // These tests pin both halves of the split: a SYNTHETIC error to Sentry,
      // the RAW error to the local log (electron-log writes a file on the user's
      // own machine — that is where diagnostics belong, and stripping it would
      // cost real value for no gain).
      describe('what it transmits', () => {
        /** Flatten everything a `captureException` call could carry — including
         *  nested `cause`s and stacks — into one searchable string. */
        function flattenCaptured(call: unknown[]): string {
          const parts: string[] = []
          const walk = (e: unknown, depth: number): void => {
            if (e === null || e === undefined || depth > 5) return
            if (e instanceof Error) {
              parts.push(e.name, e.message, e.stack ?? '')
              walk((e as { cause?: unknown }).cause, depth + 1)
              return
            }
            parts.push(String(e))
          }
          walk(call[0], 0)
          try {
            parts.push(JSON.stringify(call[1] ?? null))
          } catch {
            parts.push(String(call[1]))
          }
          return parts.join('\n')
        }

        /**
         * Run a single tick whose `isOffline` throws `err`. Deliberately does
         * NOT reset the capture gate — one test needs two consecutive runs to
         * share it.
         */
        async function tickWithThrow(err: unknown): Promise<void> {
          vi.useFakeTimers()
          try {
            startBodyIndexer({
              fetchBody: vi.fn().mockResolvedValue(null),
              isOffline: () => { throw err },
              intervalMs: 1_000,
              initialDelayMs: 5,
            })
            await vi.advanceTimersByTimeAsync(10)
          } finally {
            stopBodyIndexer()
            vi.useRealTimers()
          }
        }

        it('sends a synthetic error and no substring of the thrown message; the raw error stays in the local log', async () => {
          const SENTINEL = 'PREDICATE_SENTINEL_a41f9c'
          const inner = new Error(`inner store failure ${SENTINEL}`)
          const raw = Object.assign(
            new Error(`EACCES: permission denied, open '/home/${SENTINEL}/.config/MailCopilot/config.json'`),
            { code: 'EACCES', cause: inner },
          )

          await tickWithThrow(raw)

          expect(captureExceptionMock).toHaveBeenCalledTimes(1)
          const call = captureExceptionMock.mock.calls[0]!
          const payload = flattenCaptured(call)
          // The whole point: nothing third-party-authored travels.
          expect(payload).not.toContain(SENTINEL)
          expect(payload).not.toContain('permission denied')
          expect(payload).not.toContain('config.json')

          // What DOES travel: literals from bodyIndexer.ts plus the closed sets.
          const [error, ctx] = call as [Error, Record<string, unknown>]
          expect(error).not.toBe(raw)
          expect(error.name).toBe('BodyIndexerPredicateError')
          expect(error.message).toBe('body_indexer_predicate_isOffline_permission')
          expect((error as { cause?: unknown }).cause).toBeUndefined()
          expect(ctx).toEqual({
            source: 'bodyIndexer',
            predicate: 'isOffline',
            error_class: 'permission',
            error_kind: 'Error',
          })

          // The raw error is kept — locally, by design.
          expect(logMock.error).toHaveBeenCalledTimes(1)
          expect(logMock.error.mock.calls[0]![1]).toBe(raw)
        })

        // Each named class plus the `unknown` fallback. The direction of failure
        // is always "less information": anything the table does not recognise
        // degrades to `unknown` rather than travelling as text.
        const classCases: ReadonlyArray<readonly [string, unknown, string, string]> = [
          ['errno EACCES', Object.assign(new Error('open failed'), { code: 'EACCES' }), 'permission', 'Error'],
          ['errno EPERM', Object.assign(new Error('open failed'), { code: 'EPERM' }), 'permission', 'Error'],
          ['errno ENOENT', Object.assign(new Error('open failed'), { code: 'ENOENT' }), 'missing', 'Error'],
          ['errno EIO', Object.assign(new Error('read failed'), { code: 'EIO' }), 'io', 'Error'],
          ['a JSON.parse failure', new SyntaxError('Unexpected token } in JSON at position 42'), 'corrupt', 'SyntaxError'],
          ['a wrapper that kept only the wording', new Error('Unexpected end of JSON input'), 'corrupt', 'Error'],
          ['a wrapper that kept only the errno wording', new Error("EACCES: permission denied, open '/x'"), 'permission', 'Error'],
          [
            'an errno hidden one level down the cause chain',
            Object.assign(new Error('settings read failed'), {
              cause: Object.assign(new Error('inner'), { code: 'ENOENT' }),
            }),
            'missing',
            'Error',
          ],
          ['an unrecognised failure', new Error('something entirely novel'), 'unknown', 'Error'],
          [
            'a bug inside the predicate itself',
            new TypeError("Cannot read properties of undefined (reading 'workOffline')"),
            'unknown',
            'TypeError',
          ],
          ['a non-Error throw', 'a bare string blew up', 'unknown', 'UnknownError'],
        ]

        for (const [label, thrown, expectedClass, expectedKind] of classCases) {
          it(`classifies ${label} as ${expectedClass}/${expectedKind} without quoting it`, async () => {
            resetBodyIndexerCaptureGate()
            captureExceptionMock.mockClear()
            logMock.error.mockClear()

            await tickWithThrow(thrown)

            expect(captureExceptionMock).toHaveBeenCalledTimes(1)
            const call = captureExceptionMock.mock.calls[0]!
            const [error, ctx] = call as [Error, Record<string, unknown>]
            expect(error.message).toBe(`body_indexer_predicate_isOffline_${expectedClass}`)
            expect(ctx).toMatchObject({ error_class: expectedClass, error_kind: expectedKind })
            // No branch may echo the input, however it was classified.
            const thrownText = thrown instanceof Error ? thrown.message : String(thrown)
            expect(flattenCaptured(call)).not.toContain(thrownText)
            // …and the raw error is still available locally.
            expect(logMock.error.mock.calls[0]![1]).toBe(thrown)
          })
        }

        // The dedup fingerprint used to be `name + message.slice(0, 100)`, so two
        // genuinely different failures agreeing on their first 100 characters —
        // the common shape for one long path next to another — suppressed each
        // other for the whole 5-minute cooldown. Hashing the WHOLE message keeps
        // the key bounded without merging distinct failures.
        it('reports two failures that differ only after character 100 as two, not one', async () => {
          resetBodyIndexerCaptureGate()
          captureExceptionMock.mockClear()
          logMock.error.mockClear()

          const prefix = `EACCES: permission denied, open '/home/user/${'d'.repeat(80)}`
          const alpha = new Error(`${prefix}/alpha.json'`)
          const beta = new Error(`${prefix}/beta.json'`)
          // Precondition: the old truncating fingerprint could not tell them apart.
          expect(alpha.message.slice(0, 100)).toBe(beta.message.slice(0, 100))
          expect(alpha.message).not.toBe(beta.message)

          await tickWithThrow(alpha)
          // No gate reset in between: both reports are inside one cooldown window.
          await tickWithThrow(beta)

          expect(captureExceptionMock).toHaveBeenCalledTimes(2)
          expect(logMock.error).toHaveBeenCalledTimes(2)
        })
      })
    })
  })
})
