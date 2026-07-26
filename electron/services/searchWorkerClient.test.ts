import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron/metrics before importing the SUT so startMetricSpan is a spy.
// We keep bucketQueryLen / bucketResultCount as the real implementations — the
// point of this test is to verify the span wiring, not to re-test bucketing.
const startMetricSpanMock = vi.fn()
vi.mock('../metrics', () => ({
  startMetricSpan: (name: string, attrs?: Record<string, unknown>) =>
    startMetricSpanMock(name, attrs),
}))

// worker_threads is pulled in at module load; we never instantiate a worker
// in these tests, so a minimal stub is enough to satisfy the import.
vi.mock('node:worker_threads', () => ({
  Worker: class FakeWorker {},
}))

// Sentry is pulled in transitively through '../metrics'; the mock above
// short-circuits that, so no Sentry module load happens here.

import { runWithFtsSpan } from './searchWorkerClient'

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
