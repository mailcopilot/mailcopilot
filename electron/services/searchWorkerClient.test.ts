import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron/metrics before importing the SUT so startMetricSpan is a spy.
// We keep bucketQueryLen / bucketResultCount as the real implementations — the
// point of this test is to verify the span wiring, not to re-test bucketing.
const startMetricSpanMock = vi.fn()
vi.mock('../metrics', () => ({
  startMetricSpan: (name: string, attrs?: Record<string, unknown>) =>
    startMetricSpanMock(name, attrs),
}))

// worker_threads is pulled in at module load. The span tests never instantiate a
// worker; the client-independence tests do, so the stub records every worker it
// is asked to create and lets a test play the worker's side of the protocol.
const workers = vi.hoisted(() => ({ created: [] as Array<{
  postMessage: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => void
}> }))

vi.mock('node:worker_threads', () => ({
  Worker: class FakeWorker {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    readonly postMessage = vi.fn()
    // A real `terminate()` resolves and the worker then exits with code 1.
    readonly terminate = vi.fn(async () => { queueMicrotask(() => this.emit('exit', 1)); return 1 })
    constructor() {
      workers.created.push(this)
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    off(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter(l => l !== listener))
      return this
    }
    emit(event: string, ...args: unknown[]) {
      for (const l of [...(this.listeners.get(event) ?? [])]) l(...args)
    }
  },
}))

// Sentry is pulled in transitively through '../metrics'; the mock above
// short-circuits that, so no Sentry module load happens here.

import { SearchWorkerClient, runWithFtsSpan, searchWorkerClient } from './searchWorkerClient'

describe('runWithFtsSpan', () => {
  let spanHandle: {
    setAttributes: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    startMetricSpanMock.mockReset()
    spanHandle = {
      setAttributes: vi.fn(),
      end: vi.fn(),
    }
    startMetricSpanMock.mockReturnValue(spanHandle)
  })

  it('opens search.fts with query_len_bucket at span start', async () => {
    const rows = [{}, {}, {}]
    const result = await runWithFtsSpan('hello world', async () => rows)

    expect(result).toBe(rows)
    expect(startMetricSpanMock).toHaveBeenCalledTimes(1)
    // 'hello world'.length === 11 → '11-20'
    expect(startMetricSpanMock).toHaveBeenCalledWith('search.fts', {
      query_len_bucket: '11-20',
    })
  })

  it('assigns a known query_len_bucket value at span open', async () => {
    startMetricSpanMock.mockClear()
    await runWithFtsSpan('ab', async () => [])
    // 'ab' is 2 chars → '1-2'
    expect(startMetricSpanMock).toHaveBeenCalledWith('search.fts', {
      query_len_bucket: '1-2',
    })
  })

  it('sets result_count_bucket on the span at the end of a successful run', async () => {
    const rows = new Array(7).fill({}) // 7 results → '6-20'
    await runWithFtsSpan('query', async () => rows)

    expect(spanHandle.setAttributes).toHaveBeenCalledWith({
      result_count_bucket: '6-20',
    })
    expect(spanHandle.end).toHaveBeenCalledTimes(1)
  })

  it('sets result_count_bucket = "0" for zero-result queries', async () => {
    await runWithFtsSpan('nothing-matches', async () => [])
    expect(spanHandle.setAttributes).toHaveBeenCalledWith({
      result_count_bucket: '0',
    })
    expect(spanHandle.end).toHaveBeenCalledTimes(1)
  })

  it('ends the span and propagates the error on failure (no result_count_bucket)', async () => {
    const boom = new Error('fts exploded')
    await expect(
      runWithFtsSpan('query', async () => {
        throw boom
      }),
    ).rejects.toBe(boom)

    expect(spanHandle.setAttributes).not.toHaveBeenCalled()
    expect(spanHandle.end).toHaveBeenCalledTimes(1)
  })

  it('does not break search when startMetricSpan itself throws', async () => {
    startMetricSpanMock.mockImplementationOnce(() => {
      throw new Error('sentry init failed')
    })
    const rows = [{}]
    const result = await runWithFtsSpan('query', async () => rows)
    expect(result).toBe(rows)
  })

  it('does not break search when span.setAttributes throws', async () => {
    spanHandle.setAttributes.mockImplementationOnce(() => {
      throw new Error('attribute boom')
    })
    const rows = [{}]
    const result = await runWithFtsSpan('query', async () => rows)
    expect(result).toBe(rows)
    expect(spanHandle.end).toHaveBeenCalledTimes(1)
  })

  it('does not break search when span.end throws', async () => {
    spanHandle.end.mockImplementationOnce(() => {
      throw new Error('end boom')
    })
    const rows = [{}]
    const result = await runWithFtsSpan('query', async () => rows)
    expect(result).toBe(rows)
  })
})

describe('independent SearchWorkerClient instances', () => {
  const ROW = { accountId: 1, folder: 'INBOX', uid: 10, subject: 'Invoice' }
  const search = (client: SearchWorkerClient, query = 'invoice') => client.searchUnifiedInbox([1], query, 20, 0, 'all', 'date')

  /** The worker side of one request: answers the request with the given id. */
  const answer = (worker: (typeof workers.created)[number], id: number, rows: unknown[]) =>
    worker.emit('message', { id, ok: true, result: rows })

  beforeEach(() => {
    workers.created.length = 0
    startMetricSpanMock.mockReset()
    startMetricSpanMock.mockReturnValue({ setAttributes: vi.fn(), end: vi.fn() })
  })

  it('gives every client its own worker', async () => {
    const a = new SearchWorkerClient()
    const b = new SearchWorkerClient()
    const pa = search(a)
    const pb = search(b)

    expect(workers.created).toHaveLength(2)
    answer(workers.created[0], 1, [ROW])
    answer(workers.created[1], 1, [ROW])
    await Promise.all([pa, pb])
  })

  // Fails if the pending-request table, the worker or the cancel were shared
  // between instances (a module-level singleton behind the class): cancelling
  // the question the user abandoned would kill someone else's search.
  it('cancelInflight() on one client rejects its own request and leaves the other client\'s request pending', async () => {
    const a = new SearchWorkerClient()
    const b = new SearchWorkerClient()
    const pa = search(a, 'independent query')
    const pb = search(b, 'ordinary search')
    const [workerA, workerB] = workers.created
    let settledB = false
    void pb.then(() => { settledB = true }, () => { settledB = true })

    a.cancelInflight()

    await expect(pa).rejects.toThrow('Search request cancelled')
    expect(workerA.terminate).toHaveBeenCalledTimes(1)
    expect(workerB.terminate).not.toHaveBeenCalled()
    // Let the terminated worker's exit event run too.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settledB).toBe(false)

    // Both clients used request id 1: the answer for B's id 1 reaches B, not A.
    answer(workerB, 1, [ROW])
    await expect(pb).resolves.toEqual([ROW])
  })

  it('the exit of the terminated worker of one client does not reject the other client\'s request', async () => {
    const a = new SearchWorkerClient()
    const b = new SearchWorkerClient()
    void search(a).catch(() => {})
    const pb = search(b)
    const [, workerB] = workers.created

    a.cancelInflight()
    await new Promise(resolve => setTimeout(resolve, 0))
    answer(workerB, 1, [ROW])

    await expect(pb).resolves.toEqual([ROW])
  })

  it('an answer from one client\'s worker never resolves the request with the same id on the other client', async () => {
    const a = new SearchWorkerClient()
    const b = new SearchWorkerClient()
    const pa = search(a)
    const pb = search(b)
    const [workerA, workerB] = workers.created
    const rowA = { ...ROW, uid: 1 }
    const rowB = { ...ROW, uid: 2 }

    answer(workerB, 1, [rowB])
    answer(workerA, 1, [rowA])

    await expect(pa).resolves.toEqual([rowA])
    await expect(pb).resolves.toEqual([rowB])
  })

  it('a client that was cancelled respawns its own worker on the next request and leaves the other worker alone', async () => {
    const a = new SearchWorkerClient()
    const b = new SearchWorkerClient()
    void search(a).catch(() => {})
    const pb = search(b)
    const [, workerB] = workers.created

    a.cancelInflight()
    const again = search(a)

    expect(workers.created).toHaveLength(3)
    expect(workers.created[2]).not.toBe(workerB)
    // The cancelled client's ids keep counting (the request it lost was id 1).
    answer(workers.created[2], 2, [ROW])
    answer(workerB, 1, [ROW])
    await expect(again).resolves.toEqual([ROW])
    await expect(pb).resolves.toEqual([ROW])
  })

  it('cancelInflight() on a client with nothing in flight does nothing, to its worker or to the other client', async () => {
    const a = new SearchWorkerClient()
    const b = new SearchWorkerClient()
    const pa = search(a)
    answer(workers.created[0], 1, [ROW])
    await pa
    const pb = search(b)

    a.cancelInflight()

    expect(workers.created[0].terminate).not.toHaveBeenCalled()
    expect(workers.created[1].terminate).not.toHaveBeenCalled()
    answer(workers.created[1], 1, [ROW])
    await expect(pb).resolves.toEqual([ROW])
  })

  it('cancelling an extra client does not reject a request pending on the shared, exported client', async () => {
    const extra = new SearchWorkerClient()
    const pExtra = search(extra, 'independent query')
    const pShared = search(searchWorkerClient, 'ordinary search')
    const [workerExtra, workerShared] = workers.created
    let sharedSettled = false
    void pShared.then(() => { sharedSettled = true }, () => { sharedSettled = true })

    extra.cancelInflight()

    await expect(pExtra).rejects.toThrow('Search request cancelled')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sharedSettled).toBe(false)
    expect(workerShared.terminate).not.toHaveBeenCalled()
    expect(workerExtra.terminate).toHaveBeenCalledTimes(1)
    answer(workerShared, 1, [ROW])
    await expect(pShared).resolves.toEqual([ROW])
    // Leave the exported singleton without a live worker for the other tests.
    searchWorkerClient.cancelInflight()
  })
})
