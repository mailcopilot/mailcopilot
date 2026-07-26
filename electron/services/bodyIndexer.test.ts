import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'

// Mock the DB module
vi.mock('../../packages/db', () => ({
  getUidsWithoutBodyText: vi.fn().mockReturnValue([]),
  updateMessageBodyText: vi.fn(),
  listIndexedFolders: vi.fn().mockReturnValue([]),
  getSearchIndexStats: vi.fn().mockReturnValue({ totalMessages: 0, bodyIndexed: 0, filenamesIndexed: 0 }),
}))

// Spy on Sentry captureException so cooldown gate tests can assert how
// many times the real Sentry call gets through.
const captureExceptionMock = vi.fn()
vi.mock('../sentry', () => ({
  captureException: (err: unknown, ctx: unknown) => captureExceptionMock(err, ctx),
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
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
  resetBodyIndexerErrors,
  captureOnce,
  resetBodyIndexerCaptureGate,
} from './bodyIndexer'
import { listIndexedFolders, getUidsWithoutBodyText, updateMessageBodyText, getSearchIndexStats } from '../../packages/db'

describe('bodyIndexer', () => {
  afterEach(() => {
    stopBodyIndexer()
    resetBodyIndexerErrors()
    spanRecords.length = 0
    vi.restoreAllMocks()
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
    vi.mocked(listIndexedFolders).mockReturnValue([
      { accountId: 1, folder: 'INBOX', count: 2 },
    ])
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([10, 11])

    const fetchBody = vi.fn().mockResolvedValue({ text: 'Hello world' })

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000, // Large interval — we rely on the initial setTimeout(5000)
      batchSize: 10,
    })

    // Wait for the initial tick (5s delay + execution)
    await new Promise(r => setTimeout(r, 6000))

    expect(fetchBody).toHaveBeenCalledWith(1, 'INBOX', 10)
    expect(fetchBody).toHaveBeenCalledWith(1, 'INBOX', 11)
    expect(updateMessageBodyText).toHaveBeenCalledWith(1, 'INBOX', 10, 'Hello world')
    expect(updateMessageBodyText).toHaveBeenCalledWith(1, 'INBOX', 11, 'Hello world')
  }, 10_000)

  it('handles fetch failure gracefully (no crash)', async () => {
    vi.mocked(listIndexedFolders).mockReturnValue([
      { accountId: 1, folder: 'INBOX', count: 1 },
    ])
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([5])

    const fetchBody = vi.fn().mockRejectedValue(new Error('IMAP timeout'))

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      batchSize: 10,
    })

    await new Promise(r => setTimeout(r, 6000))

    expect(fetchBody).toHaveBeenCalledWith(1, 'INBOX', 5)
    // Should not have updated body_text (will retry next tick)
    expect(updateMessageBodyText).not.toHaveBeenCalled()
  }, 10_000)

  it('marks empty body when fetchBody returns null', async () => {
    vi.mocked(listIndexedFolders).mockReturnValue([
      { accountId: 1, folder: 'INBOX', count: 1 },
    ])
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([7])

    const fetchBody = vi.fn().mockResolvedValue(null)

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      batchSize: 10,
    })

    await new Promise(r => setTimeout(r, 6000))

    expect(updateMessageBodyText).toHaveBeenCalledWith(1, 'INBOX', 7, '')
  }, 10_000)

  it('stopBodyIndexer stops the timer', () => {
    const fetchBody = vi.fn()
    startBodyIndexer({ fetchBody, intervalMs: 50 })
    stopBodyIndexer()
    // After stopping, no more ticks should fire
    expect(fetchBody).not.toHaveBeenCalled()
  })

  it('prioritizes folders: INBOX before Sent before others', async () => {
    const callOrder: string[] = []
    vi.mocked(listIndexedFolders).mockReturnValue([
      { accountId: 1, folder: 'Archive', count: 5 },
      { accountId: 1, folder: 'Sent', count: 3 },
      { accountId: 1, folder: 'INBOX', count: 10 },
    ])
    vi.mocked(getUidsWithoutBodyText).mockImplementation((_aid, folder) => {
      callOrder.push(folder)
      return [1]
    })
    const fetchBody = vi.fn().mockResolvedValue({ text: 'body' })

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      batchSize: 10,
    })

    await new Promise(r => setTimeout(r, 6000))

    // INBOX should come first, then Sent, then Archive
    expect(callOrder[0]).toBe('INBOX')
    expect(callOrder[1]).toBe('Sent')
    expect(callOrder[2]).toBe('Archive')
  }, 10_000)

  it('opens body_indexer.batch span with folder_role and ends it on success', async () => {
    vi.mocked(listIndexedFolders).mockReturnValue([
      { accountId: 1, folder: 'INBOX', count: 2 },
    ])
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([10, 11])

    const fetchBody = vi.fn().mockResolvedValue({ text: 'Hello world' })

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      batchSize: 10,
    })

    await new Promise(r => setTimeout(r, 6000))

    const batchSpans = spanRecords.filter(s => s.name === 'body_indexer.batch')
    expect(batchSpans.length).toBeGreaterThanOrEqual(1)
    const span = batchSpans[0]!
    expect(span.openAttrs.folder_role).toBe('inbox')
    expect(span.ended).toBe(true)
    expect(span.finalAttrs.fetched_ok_bucket).toBe('2')
    expect(span.finalAttrs.failed_bucket).toBe('0')
    expect(span.finalAttrs.batch_size_bucket).toBe('1-10')
  }, 10_000)

  it('ends body_indexer.batch span on error path with failed counter', async () => {
    vi.mocked(listIndexedFolders).mockReturnValue([
      { accountId: 1, folder: 'INBOX', count: 3 },
    ])
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([1, 2, 3])

    const fetchBody = vi.fn().mockRejectedValue(new Error('IMAP timeout'))

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      batchSize: 10,
    })

    await new Promise(r => setTimeout(r, 6000))

    const batchSpans = spanRecords.filter(s => s.name === 'body_indexer.batch')
    expect(batchSpans.length).toBeGreaterThanOrEqual(1)
    const span = batchSpans[0]!
    expect(span.ended).toBe(true)
    expect(span.openAttrs.folder_role).toBe('inbox')
    expect(span.finalAttrs.fetched_ok_bucket).toBe('0')
    expect(typeof span.finalAttrs.failed_bucket).toBe('string')
    expect(span.finalAttrs.failed_bucket).not.toBe('0')
  }, 10_000)

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

  it('backs off folders with repeated errors', async () => {
    vi.mocked(listIndexedFolders).mockReturnValue([
      { accountId: 1, folder: 'INBOX', count: 2 },
    ])
    vi.mocked(getUidsWithoutBodyText).mockReturnValue([1])
    const fetchBody = vi.fn().mockRejectedValue(new Error('IMAP error'))

    startBodyIndexer({
      fetchBody,
      isOffline: () => false,
      intervalMs: 100_000,
      batchSize: 10,
      maxFolderRetries: 2,
    })

    // First tick: error #1
    await new Promise(r => setTimeout(r, 6000))
    expect(fetchBody).toHaveBeenCalledTimes(1)

    // The folder should now be in backoff state — reset for another manual check
    // (The actual backoff timer would prevent retry within 30s)
  }, 10_000)
})
