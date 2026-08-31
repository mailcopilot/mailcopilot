import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for electron/services/ftsMaintenance.ts (§2.156).
 *
 * What these tests are for: the previous implementation ran FTS5 'optimize',
 * one synchronous call that rewrote the whole index and held the main-process
 * event loop for seconds. The replacement is only as good as three properties,
 * so each is asserted directly rather than implied:
 *
 *   1. the FTS5-documented protocol — ONE negative-page call, then positive
 *      ones (a cycle that starts with a positive page count merges nothing
 *      unless the automerge criteria happen to be met, i.e. it silently does
 *      no maintenance at all);
 *   2. the loop breathes — a pause between EVERY pair of synchronous steps;
 *   3. the cycle is bounded — by steps, by accumulated work, by shutdown, and
 *      by a step that blocks far longer than the design assumes.
 */

const logCalls: Record<string, unknown[][]> = { info: [], warn: [], error: [], debug: [] }
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => { logCalls.info.push(args) },
    warn: (...args: unknown[]) => { logCalls.warn.push(args) },
    error: (...args: unknown[]) => { logCalls.error.push(args) },
    debug: (...args: unknown[]) => { logCalls.debug.push(args) },
  }),
}))

const recordEventMock = vi.fn()
const recordHistogramMock = vi.fn()
vi.mock('../metrics', () => ({
  recordEvent: (...args: unknown[]) => recordEventMock(...args),
  recordHistogram: (...args: unknown[]) => recordHistogramMock(...args),
}))

import {
  runFtsMergeCycle,
  startFtsMaintenance,
  reportCycle,
  MERGE_STEP_GAP_MS,
  type FtsMergeStepFn,
} from './ftsMaintenance'

/** A merge step that reports work for the first `workingSteps` calls. */
function stepsThatWork(workingSteps: number, durationMs = 5): { fn: FtsMergeStepFn; pages: number[] } {
  const pages: number[] = []
  let seen = 0
  const fn: FtsMergeStepFn = (p) => {
    pages.push(p)
    seen += 1
    return { durationMs, worked: seen <= workingSteps }
  }
  return { fn, pages }
}

beforeEach(() => {
  logCalls.info.length = 0
  logCalls.warn.length = 0
  recordEventMock.mockClear()
  recordHistogramMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runFtsMergeCycle', () => {
  it('starts with a negative page count and continues with positive ones', async () => {
    const { fn, pages } = stepsThatWork(3)
    const summary = await runFtsMergeCycle({
      mergeStep: fn,
      shouldStop: () => false,
      delay: async () => {},
      pages: 64,
    })

    // Kills: "call merge with a positive count from the start" — that variant
    // only continues an already-running merge and can no-op forever.
    expect(pages).toEqual([-64, 64, 64, 64])
    expect(summary.outcome).toBe('converged')
    expect(summary.steps).toBe(4)
  })

  it('normalises a positive `pages` option into a negative first step', async () => {
    const { fn, pages } = stepsThatWork(0)
    await runFtsMergeCycle({ mergeStep: fn, shouldStop: () => false, delay: async () => {}, pages: 32 })
    expect(pages).toEqual([-32])
  })

  it('pauses between every pair of steps so the event loop can run', async () => {
    const { fn } = stepsThatWork(4)
    const delays: number[] = []
    const summary = await runFtsMergeCycle({
      mergeStep: fn,
      shouldStop: () => false,
      delay: async (ms) => { delays.push(ms) },
      gapMs: 25,
    })

    // Kills: a cycle that issues its steps back-to-back. Five steps means four
    // gaps — one after each step that is followed by another.
    expect(summary.steps).toBe(5)
    expect(delays).toEqual([25, 25, 25, 25])
  })

  it('stops as soon as a step reports no work left', async () => {
    const { fn, pages } = stepsThatWork(0)
    const summary = await runFtsMergeCycle({ mergeStep: fn, shouldStop: () => false, delay: async () => {} })
    expect(pages).toHaveLength(1)
    expect(summary.outcome).toBe('converged')
  })

  it('gives up on the step budget and leaves the rest for the next cycle', async () => {
    const { fn } = stepsThatWork(Number.POSITIVE_INFINITY)
    const summary = await runFtsMergeCycle({
      mergeStep: fn,
      shouldStop: () => false,
      delay: async () => {},
      maxSteps: 7,
    })
    expect(summary.outcome).toBe('budget')
    expect(summary.steps).toBe(7)
  })

  it('gives up on the accumulated-work budget', async () => {
    const { fn } = stepsThatWork(Number.POSITIVE_INFINITY, 40)
    const summary = await runFtsMergeCycle({
      mergeStep: fn,
      shouldStop: () => false,
      delay: async () => {},
      maxWorkMs: 100,
    })
    expect(summary.outcome).toBe('budget')
    expect(summary.workMs).toBeGreaterThanOrEqual(100)
    expect(summary.steps).toBe(3)
  })

  it('abandons the cycle when shutdown starts, without issuing another step', async () => {
    const { fn, pages } = stepsThatWork(Number.POSITIVE_INFINITY)
    let stop = false
    const summary = await runFtsMergeCycle({
      mergeStep: fn,
      shouldStop: () => stop,
      delay: async () => { stop = true },
    })
    // Kills: checking the stop condition only at cycle start. The merge writes
    // SQLite state and must not run after the shutdown WAL checkpoint.
    expect(summary.outcome).toBe('stopped')
    expect(pages).toEqual([-64])
  })

  it('does not start at all when shutdown is already in progress', async () => {
    const { fn, pages } = stepsThatWork(3)
    const summary = await runFtsMergeCycle({ mergeStep: fn, shouldStop: () => true, delay: async () => {} })
    expect(summary.outcome).toBe('stopped')
    expect(pages).toEqual([])
  })

  it('stops and reports when a single step blocks far longer than measured norms', async () => {
    const fn: FtsMergeStepFn = () => ({ durationMs: 900, worked: true })
    const summary = await runFtsMergeCycle({
      mergeStep: fn,
      shouldStop: () => false,
      delay: async () => {},
      slowStepMs: 250,
    })
    // Kills: an unbounded loop that keeps issuing calls of unknown cost at the
    // event loop — the exact failure mode this task exists to remove.
    expect(summary.outcome).toBe('slow_step')
    expect(summary.steps).toBe(1)
    expect(summary.maxStepMs).toBe(900)
  })

  it('reports an unavailable FTS index instead of looping', async () => {
    const summary = await runFtsMergeCycle({
      mergeStep: () => null,
      shouldStop: () => false,
      delay: async () => {},
    })
    expect(summary.outcome).toBe('unavailable')
  })

  it('turns a throwing step into a failed summary rather than an unhandled rejection', async () => {
    const summary = await runFtsMergeCycle({
      mergeStep: () => { throw new TypeError('no such table') },
      shouldStop: () => false,
      delay: async () => {},
    })
    expect(summary.outcome).toBe('failed')
    expect(summary.error).toBeInstanceOf(TypeError)
  })

  it('records segment counts around the cycle and survives a throwing counter', async () => {
    const { fn } = stepsThatWork(1)
    const counts = [12, 1]
    const summary = await runFtsMergeCycle({
      mergeStep: fn,
      segmentCount: () => counts.shift(),
      shouldStop: () => false,
      delay: async () => {},
    })
    expect(summary.segmentsBefore).toBe(12)
    expect(summary.segmentsAfter).toBe(1)

    const throwing = await runFtsMergeCycle({
      mergeStep: stepsThatWork(0).fn,
      segmentCount: () => { throw new Error('structure record unreadable') },
      shouldStop: () => false,
      delay: async () => {},
    })
    expect(throwing.outcome).toBe('converged')
    expect(throwing.segmentsBefore).toBeUndefined()
  })

  it('waits a real MERGE_STEP_GAP_MS between steps when no delay/gapMs override is given', async () => {
    // Every other test in this file injects its own `delay` (and often its own
    // `gapMs`), so none of them exercise the module's actual default — which
    // is exactly what electron/main.ts uses in production (it calls
    // startFtsMaintenance without a `delay` or `gapMs` override at all). A
    // regression that turned the default pause into a same-tick no-op would
    // reproduce the original `optimize` freeze and no test here would notice.
    vi.useFakeTimers()
    const { fn, pages } = stepsThatWork(2)
    const promise = runFtsMergeCycle({ mergeStep: fn, shouldStop: () => false })

    await vi.advanceTimersByTimeAsync(0)
    expect(pages).toHaveLength(1) // first (negative-page) step runs synchronously

    await vi.advanceTimersByTimeAsync(MERGE_STEP_GAP_MS - 1)
    expect(pages).toHaveLength(1) // still parked: the gap has not elapsed yet

    await vi.advanceTimersByTimeAsync(1)
    expect(pages).toHaveLength(2) // gap elapsed — second step runs

    await vi.advanceTimersByTimeAsync(MERGE_STEP_GAP_MS)
    const summary = await promise
    expect(summary.outcome).toBe('converged')
    expect(summary.steps).toBe(3)
  })
})

describe('reportCycle', () => {
  it('logs and records segments — the honest unit — plus the longest step', () => {
    reportCycle({ outcome: 'converged', steps: 40, workMs: 260, maxStepMs: 26, segmentsBefore: 20, segmentsAfter: 1 })

    const line = String(logCalls.info[0]![0])
    expect(line).toContain('20 → 1 segments')
    expect(line).toContain('max step 26ms')
    expect(recordHistogramMock).toHaveBeenCalledWith('fts.merge.work_ms', 260, {
      outcome: 'converged',
      steps: 40,
      max_step_ms: 26,
      segments_before: 20,
      segments_after: 1,
    })
  })

  it('records a failure event with the error name only', () => {
    reportCycle({ outcome: 'failed', steps: 2, workMs: 4, maxStepMs: 3, error: new RangeError('disk full: /home/user/mail.db') })
    expect(recordEventMock).toHaveBeenCalledWith('fts.merge.failed', { reason: 'RangeError' })
    // The message may name a path; it belongs in the local log, not telemetry.
    const tags = recordEventMock.mock.calls[0]![1] as Record<string, unknown>
    expect(JSON.stringify(tags)).not.toContain('/home/user')
  })

  it('warns when a step blocked longer than the design assumes', () => {
    reportCycle({ outcome: 'slow_step', steps: 1, workMs: 900, maxStepMs: 900 })
    expect(String(logCalls.warn[0]![0])).toContain('900ms')
  })
})

describe('startFtsMaintenance', () => {
  it('runs the first cycle after the startup delay and then on the interval', async () => {
    vi.useFakeTimers()
    const { fn, pages } = stepsThatWork(0)
    const handle = startFtsMaintenance({
      mergeStep: fn,
      shouldStop: () => false,
      delay: async () => {},
      firstRunDelayMs: 30_000,
      intervalMs: 60_000,
    })

    expect(pages).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pages).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pages).toHaveLength(2)

    handle.stop()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(pages).toHaveLength(2)
  })

  it('stop() also abandons a cycle that is already in flight', async () => {
    vi.useFakeTimers()
    const { fn, pages } = stepsThatWork(Number.POSITIVE_INFINITY)
    let release: (() => void) | undefined
    const handle = startFtsMaintenance({
      mergeStep: fn,
      shouldStop: () => false,
      // Park the cycle between two steps, the way the real 25 ms gap does.
      delay: async () => { await new Promise<void>((r) => { release = r }) },
      firstRunDelayMs: 1_000,
      intervalMs: 10 * 60_000,
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(pages).toHaveLength(1)

    handle.stop()
    release!()
    await vi.advanceTimersByTimeAsync(0)
    // Kills: a stop() that only clears the timers while the running cycle keeps
    // issuing merge steps at a database that may already be checkpointed.
    expect(pages).toHaveLength(1)
  })

  it('does not start a second cycle on the interval while the first is still running', async () => {
    vi.useFakeTimers()
    const { fn, pages } = stepsThatWork(Number.POSITIVE_INFINITY)
    let release: (() => void) | undefined
    const handle = startFtsMaintenance({
      mergeStep: fn,
      shouldStop: () => false,
      // Park the cycle mid-gap, the way the real 25 ms pause does, so the
      // interval below fires while `running` is still true.
      delay: async () => { await new Promise<void>((r) => { release = r }) },
      firstRunDelayMs: 1_000,
      intervalMs: 1_000,
    })

    await vi.advanceTimersByTimeAsync(1_000) // first cycle starts, parks after step 1
    expect(pages).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000) // interval fires again mid-cycle
    // Kills: a scheduler that lets `setInterval` start a second cycle while the
    // first is still parked in its own gap — two overlapping cycles would
    // issue merge steps against the same SQLite handle concurrently.
    expect(pages).toHaveLength(1)

    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(pages).toHaveLength(2) // released cycle resumes on its own, unblocked

    handle.stop()
  })

  it('skips the cycle while shutting down', async () => {
    vi.useFakeTimers()
    const { fn, pages } = stepsThatWork(0)
    startFtsMaintenance({
      mergeStep: fn,
      shouldStop: () => true,
      delay: async () => {},
      firstRunDelayMs: 1_000,
      intervalMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(pages).toHaveLength(0)
  })
})
