/**
 * FTS5 index maintenance scheduler (§2.156).
 *
 * Replaces the periodic `INSERT INTO messages_fts(messages_fts)
 * VALUES('optimize')` that ran from main.ts. That call reorganises the WHOLE
 * index in one synchronous better-sqlite3 statement: on the reporting user's
 * 106 906-message mailbox (110 MB index) it held the main-process event loop
 * for 4 277 ms, eight times in a single session, which is what made the tray
 * icon go dead — the D-Bus object behind it lives in main and cannot answer
 * property reads while the loop is blocked.
 *
 * The FTS5 documentation prescribes the replacement: the 'merge' command with
 * a page limit "achieves the same result as optimize without blocking", called
 * once with a negative page count and then repeatedly with a positive one.
 * This module owns the "repeatedly" part, and specifically the pause between
 * steps — that pause is the whole point, because it is what gives the event
 * loop room between two synchronous SQLite calls.
 *
 * Measured on a copy of that mailbox (see packages/db/ftsIndex.ts header):
 * one 'optimize' = 1 384 ms blocked; the equivalent merge cycle = 410 steps,
 * median 5.2 ms, p95 12.9 ms, max 26 ms per step.
 */

import { createLogger } from '../logger'
import { recordEvent, recordHistogram } from '../metrics'
import { FTS_MERGE_PAGES_PER_STEP } from '../../packages/db/ftsIndex'

const log = createLogger('FtsMaintenance')

/** One merge step. Returns null when FTS is unavailable in this build. */
export type FtsMergeStepFn = (pages: number) => { durationMs: number; worked: boolean } | null

export type FtsMergeCycleOutcome =
  /** Nothing left to merge — same end state `optimize` would have produced. */
  | 'converged'
  /** Step or time budget for this cycle ran out; the rest waits for the next one. */
  | 'budget'
  /** Shutdown (or another stop condition) interrupted the cycle. */
  | 'stopped'
  /** FTS5 is not available in this build. */
  | 'unavailable'
  /** A single step blocked far longer than measured norms — stop and report. */
  | 'slow_step'
  /** SQLite threw. */
  | 'failed'

export type FtsMergeCycleSummary = {
  outcome: FtsMergeCycleOutcome
  steps: number
  /** Sum of the synchronous merge calls — the loop time actually consumed. */
  workMs: number
  /** Longest single synchronous call: the number that must stay small. */
  maxStepMs: number
  segmentsBefore?: number
  segmentsAfter?: number
  error?: unknown
}

/**
 * Pause between steps. Long enough for pending IPC, timers and D-Bus property
 * reads to run; short enough that a full convergence pass (~410 steps measured)
 * finishes in tens of seconds of wall clock on a 6-hour cadence.
 */
export const MERGE_STEP_GAP_MS = 25

/** Convergence took 410 steps on a 110 MB index; the cap is a safety net. */
const MAX_STEPS_PER_CYCLE = 1200

/** Cumulative synchronous merge time per cycle. Measured full pass: ~2.7 s. */
const MAX_WORK_MS_PER_CYCLE = 15_000

/**
 * A step this slow contradicts every measurement (max observed 26 ms), so it
 * means something about the environment is different from what this design
 * assumed — stop the cycle and say so, rather than keep issuing calls of
 * unknown cost against the event loop.
 */
const SLOW_STEP_MS = 250

const FIRST_RUN_DELAY_MS = 30_000
const CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })

export type FtsMergeCycleDeps = {
  mergeStep: FtsMergeStepFn
  /** Honest segment count for logging; never required for correctness. */
  segmentCount?: () => number | undefined
  /** True when the cycle must abandon its remaining steps (shutdown). */
  shouldStop: () => boolean
  delay?: (ms: number) => Promise<void>
  pages?: number
  gapMs?: number
  maxSteps?: number
  maxWorkMs?: number
  slowStepMs?: number
}

function safeSegmentCount(fn?: () => number | undefined): number | undefined {
  if (!fn) return undefined
  try { return fn() } catch { return undefined }
}

/**
 * Run merge steps until the index has nothing left to merge, a budget runs
 * out, or the caller asks to stop. Never throws: SQLite failures come back as
 * `outcome: 'failed'` so the caller can record them without a try/catch dance.
 */
export async function runFtsMergeCycle(deps: FtsMergeCycleDeps): Promise<FtsMergeCycleSummary> {
  const pages = deps.pages ?? FTS_MERGE_PAGES_PER_STEP
  const gapMs = deps.gapMs ?? MERGE_STEP_GAP_MS
  const maxSteps = deps.maxSteps ?? MAX_STEPS_PER_CYCLE
  const maxWorkMs = deps.maxWorkMs ?? MAX_WORK_MS_PER_CYCLE
  const slowStepMs = deps.slowStepMs ?? SLOW_STEP_MS
  const delay = deps.delay ?? sleep

  const segmentsBefore = safeSegmentCount(deps.segmentCount)
  const summary: FtsMergeCycleSummary = { outcome: 'converged', steps: 0, workMs: 0, maxStepMs: 0, segmentsBefore }

  const finish = (outcome: FtsMergeCycleOutcome, error?: unknown): FtsMergeCycleSummary => {
    summary.outcome = outcome
    summary.segmentsAfter = safeSegmentCount(deps.segmentCount)
    if (error !== undefined) summary.error = error
    return summary
  }

  if (deps.shouldStop()) return finish('stopped')

  // First call is negative on purpose: it starts a merge even when the
  // automerge criteria are not met. Every later call continues that merge.
  let stepPages = -Math.abs(pages)
  for (;;) {
    let result: { durationMs: number; worked: boolean } | null
    try {
      result = deps.mergeStep(stepPages)
    } catch (err) {
      return finish('failed', err)
    }
    if (!result) return finish('unavailable')

    summary.steps += 1
    summary.workMs += result.durationMs
    if (result.durationMs > summary.maxStepMs) summary.maxStepMs = result.durationMs

    if (result.durationMs >= slowStepMs) return finish('slow_step')
    if (!result.worked) return finish('converged')
    if (summary.steps >= maxSteps || summary.workMs >= maxWorkMs) return finish('budget')

    stepPages = Math.abs(pages)
    await delay(gapMs)
    if (deps.shouldStop()) return finish('stopped')
  }
}

export type FtsMaintenanceHandle = { stop(): void }

export type FtsMaintenanceDeps = FtsMergeCycleDeps & {
  firstRunDelayMs?: number
  intervalMs?: number
}

/**
 * Schedule merge cycles: one shortly after startup, then every 6 hours — the
 * cadence the previous `optimize` timer used. Timers are unref'd so they never
 * keep the process alive, and cycles never overlap.
 */
export function startFtsMaintenance(deps: FtsMaintenanceDeps): FtsMaintenanceHandle {
  let running = false
  let stopped = false

  const runCycle = async (): Promise<void> => {
    if (stopped || running || deps.shouldStop()) return
    running = true
    try {
      const summary = await runFtsMergeCycle({
        ...deps,
        shouldStop: () => stopped || deps.shouldStop(),
      })
      reportCycle(summary)
    } finally {
      running = false
    }
  }

  const first = setTimeout(() => { void runCycle() }, deps.firstRunDelayMs ?? FIRST_RUN_DELAY_MS)
  first.unref?.()
  const repeat = setInterval(() => { void runCycle() }, deps.intervalMs ?? CYCLE_INTERVAL_MS)
  repeat.unref?.()

  return {
    stop() {
      // `stopped` is the load-bearing half: a cycle already in flight keeps its
      // own reference to this flag and abandons its remaining steps.
      stopped = true
      clearTimeout(first)
      clearInterval(repeat)
    },
  }
}

/** Log + telemetry for one finished cycle. Segment counts are the honest unit
 *  (see packages/db/ftsIndex.ts); the old line reported storage blocks. */
export function reportCycle(summary: FtsMergeCycleSummary): void {
  const before = summary.segmentsBefore ?? '?'
  const after = summary.segmentsAfter ?? '?'
  if (summary.outcome === 'failed') {
    const err = summary.error
    log.warn(`FTS merge failed after ${summary.steps} steps: ${err instanceof Error ? err.message : String(err)}`)
    recordEvent('fts.merge.failed', { reason: err instanceof Error ? err.name : 'unknown' })
    return
  }
  if (summary.outcome === 'slow_step') {
    log.warn(
      `FTS merge stopped: a single step blocked ${summary.maxStepMs}ms (segments ${before} → ${after})`,
    )
  } else {
    log.info(
      `FTS merge: ${before} → ${after} segments, ${summary.steps} steps, ${summary.workMs}ms work, max step ${summary.maxStepMs}ms (${summary.outcome})`,
    )
  }
  recordHistogram('fts.merge.work_ms', summary.workMs, {
    outcome: summary.outcome,
    steps: summary.steps,
    max_step_ms: summary.maxStepMs,
    segments_before: summary.segmentsBefore,
    segments_after: summary.segmentsAfter,
  })
}
