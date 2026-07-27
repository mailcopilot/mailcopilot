import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { createLogger } from '../logger'
import { captureException } from '../sentry'
import { startMetricSpan } from '../metrics'
import { bucketQueryLen, bucketResultCount } from '../metricsBuckets'
import type {
  FolderCrawlState,
  MessageRow,
  SearchCoverageStats,
  SearchIndexStats,
} from '../../packages/db'
import type {
  SearchSort,
  SearchWorkerRequest,
  SearchWorkerRequestMap,
  SearchWorkerRequestType,
  SearchWorkerResponse,
  SearchWorkerResultMap,
} from './searchProtocol'

/**
 * Wrap an FTS query dispatch in a `search.fts` Sentry span. Additive to the
 * existing `search.duration_ms` histogram — the span lets dashboards drill
 * into individual slow queries while the histogram keeps the long-term
 * distribution.
 *
 * Privacy: the raw query string never leaves this module. Only
 * `query_len_bucket` (coarse length bucket) and, at end time,
 * `result_count_bucket` are attached.
 *
 * Telemetry is fail-closed: if startMetricSpan or any span method throws,
 * the search itself still runs and its result/error is propagated unchanged.
 */
export async function runWithFtsSpan<T extends { length: number }>(
  query: string,
  run: () => Promise<T>,
): Promise<T> {
  const queryLenBucket = bucketQueryLen(query.length)
  let span: ReturnType<typeof startMetricSpan> | null = null
  try {
    span = startMetricSpan('search.fts', { query_len_bucket: queryLenBucket })
  } catch {
    // Telemetry must never break search. Fall through with no span.
    span = null
  }
  try {
    const result = await run()
    try {
      span?.setAttributes?.({ result_count_bucket: bucketResultCount(result.length) })
    } catch { /* ignore */ }
    return result
  } finally {
    try {
      span?.end?.()
    } catch { /* ignore */ }
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const log = createLogger('SearchWorker')
// Cold-start FTS on a large, partially-indexed corpus can legitimately take 30-60s
// on first query until SQLite page cache is warm. After that, follow-up queries on
// the same worker are fast. 120s gives enough headroom without hiding real bugs.
const REQUEST_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 5_000

class SearchWorkerClient {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private shuttingDown = false
  private terminatingWorkers = new Set<Worker>()

  private ensureWorker(): Worker {
    if (this.worker) return this.worker

    const workerPath = path.join(__dirname, 'search-worker.js')
    let worker: Worker
    try {
      worker = new Worker(workerPath)
    } catch (error) {
      log.error(`Failed to spawn search worker at ${workerPath}:`, error)
      captureException(error, { source: 'searchWorkerClient', stage: 'spawn', workerPath })
      throw error instanceof Error ? error : new Error(String(error))
    }

    worker.on('message', (message: SearchWorkerResponse) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error))
    })

    worker.on('error', (error) => {
      log.error('Search worker error:', error)
      captureException(error, { source: 'searchWorkerClient', stage: 'runtime' })
    })

    worker.on('exit', (code) => {
      const wasExpected = this.shuttingDown || this.terminatingWorkers.has(worker)
      this.terminatingWorkers.delete(worker)
      const wasCurrent = this.worker === worker
      if (wasCurrent) {
        this.worker = null
      }
      if (!wasExpected) {
        if (code !== 0) {
          log.error(`Search worker exited with code ${code}`)
          captureException(new Error(`Search worker exited with code ${code}`), { source: 'searchWorkerClient', stage: 'exit', code })
        }
        this.rejectPending(new Error(`Search worker exited unexpectedly with code ${code}`))
        return
      }
      // Expected exit: only clean pending if the dying worker is still the current one.
      // If a new worker has been spawned in the meantime (terminate-and-respawn race),
      // its pending requests must NOT be touched here — cancelInflight already rejected
      // anything that belonged to the old worker.
      if (wasCurrent) {
        this.clearPendingTimeouts()
      }
    })

    this.worker = worker
    return worker
  }

  private clearPendingTimeouts(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
    }
    this.pending.clear()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private async abortWorker(worker: Worker, error: Error): Promise<void> {
    if (this.terminatingWorkers.has(worker)) return
    this.terminatingWorkers.add(worker)
    if (this.worker === worker) {
      this.rejectPending(error)
      this.worker = null
    }
    try {
      await worker.terminate()
    } catch {
      // Ignore termination races.
    }
  }

  private waitForExit(worker: Worker, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Search worker exit timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const handleExit = () => {
        cleanup()
        resolve()
      }

      const cleanup = () => {
        clearTimeout(timer)
        worker.off('exit', handleExit)
      }

      worker.on('exit', handleExit)
    })
  }

  private request<T extends Exclude<SearchWorkerRequestType, 'shutdown'>>(
    type: T,
    payload: SearchWorkerRequestMap[T],
  ): Promise<SearchWorkerResultMap[T]> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise<SearchWorkerResultMap[T]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        void this.abortWorker(worker, new Error(`Search worker request "${type}" timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)

      // Resolve is generic per-request; we erase the type at storage time so
      // the pending map can hold heterogeneous in-flight requests. The worker
      // message handler dispatches by id and the original Promise type is
      // restored on this side via the request<T> generic.
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout })
      worker.postMessage({ id, type, payload } as SearchWorkerRequest<T>)
    })
  }

  searchMessages(
    accountId: number,
    folder: string,
    query: string,
    limit: number,
    offset: number,
    sort: SearchSort,
  ): Promise<MessageRow[]> {
    return runWithFtsSpan(query, () =>
      this.request('cache:search', { accountId, folder, query, limit, offset, sort }),
    )
  }

  searchUnifiedInbox(
    accountIds: number[],
    query: string,
    limit: number,
    offset: number,
    scope: 'inbox' | 'all',
    sort: SearchSort,
  ): Promise<MessageRow[]> {
    return runWithFtsSpan(query, () =>
      this.request('cache:unifiedSearch', { accountIds, query, limit, offset, scope, sort }),
    )
  }

  getSearchIndexStats(accountIds: number[]): Promise<SearchIndexStats> {
    return this.request('search:indexStats', { accountIds })
  }

  getSearchCoverageStats(accountIds: number[]): Promise<SearchCoverageStats> {
    return this.request('search:coverageStats', { accountIds })
  }

  listFolderCrawlStates(accountIds: number[]): Promise<FolderCrawlState[]> {
    return this.request('search:crawlStates', { accountIds })
  }

  /**
   * Cancel any in-flight worker request by terminating the worker and rejecting
   * pending promises. The next call lazily respawns the worker. better-sqlite3
   * has no public `interrupt()` API, so termination is the only honest way to
   * stop a long-running FTS query mid-flight.
   *
   * Cheap when nothing is in flight — no-op.
   */
  cancelInflight(): void {
    const worker = this.worker
    if (!worker) return
    if (this.pending.size === 0) return
    log.debug(`Cancelling ${this.pending.size} in-flight search request(s)`)
    const error = new Error('Search request cancelled')
    this.terminatingWorkers.add(worker)
    this.worker = null
    this.rejectPending(error)
    void worker.terminate().catch(() => {
      // Termination races are fine — we no longer reference this worker.
    })
  }

  async shutdown(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    this.shuttingDown = true
    try {
      const exitPromise = this.waitForExit(worker, SHUTDOWN_TIMEOUT_MS)
      worker.postMessage({ id: 0, type: 'shutdown', payload: null } as SearchWorkerRequest<'shutdown'>)
      await exitPromise
    } catch (error) {
      await this.abortWorker(worker, error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.clearPendingTimeouts()
      if (this.worker === worker) {
        this.worker = null
      }
      this.shuttingDown = false
    }
  }
}

export const searchWorkerClient = new SearchWorkerClient()
