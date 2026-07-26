import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Sentry sink so tests don't depend on real Sentry init.
const sentryInfo = vi.fn()
const startInactiveSpanMock = vi.fn<(opts: unknown) => {
  setAttributes: ReturnType<typeof vi.fn>
  setStatus: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}>(() => ({
  setAttributes: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
}))
vi.mock('./sentry', () => ({
  sentryLogger: { info: (...args: unknown[]) => sentryInfo(...args) },
  startInactiveSpan: (opts: unknown) => startInactiveSpanMock(opts),
}))

// Mock electron-log so we don't write to the filesystem during tests.
vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import {
  recordEvent,
  recordHistogram,
  recordGauge,
  flushAggregator,
  resetAggregator,
  startMetricSpan,
  startMetricSpanDynamic,
  bucketQueryLen,
  bucketResultCount,
  bucketDuration,
  bucketSessionLength,
  folderRoleFromPath,
} from './metrics'

describe('metrics module', () => {
  beforeEach(() => {
    sentryInfo.mockClear()
    startInactiveSpanMock.mockClear()
  })
  afterEach(() => {
    resetAggregator()
  })

  describe('recordEvent', () => {
    it('dispatches a registered event to Sentry', () => {
      recordEvent('app.updated', { from_version: '1.0.0', to_version: '1.1.0' })
      expect(sentryInfo).toHaveBeenCalledWith('app.updated', {
        from_version: '1.0.0',
        to_version: '1.1.0',
      })
    })

    it('strips undefined tag values', () => {
      recordEvent('onboarding.wizard_opened', { first_run: undefined })
      expect(sentryInfo).toHaveBeenCalledWith('onboarding.wizard_opened', {})
    })
  })

  describe('recordHistogram', () => {
    it('attaches value_ms to the payload', () => {
      recordHistogram('app.startup_ms', 1234.5, { accounts_count: 3 })
      expect(sentryInfo).toHaveBeenCalledWith('app.startup_ms', {
        accounts_count: 3,
        value_ms: 1235,
      })
    })

    it('aggregates high-volume events instead of emitting immediately', () => {
      recordHistogram('ipc.slow_ms', 500, { channel: 'net:x', duration_bucket: '500-1000' })
      recordHistogram('ipc.slow_ms', 700, { channel: 'net:x', duration_bucket: '500-1000' })
      recordHistogram('ipc.slow_ms', 900, { channel: 'net:x', duration_bucket: '500-1000' })
      expect(sentryInfo).not.toHaveBeenCalled()
      flushAggregator()
      expect(sentryInfo).toHaveBeenCalledTimes(1)
      const [name, payload] = sentryInfo.mock.calls[0]!
      expect(name).toBe('ipc.slow_ms')
      expect(payload).toMatchObject({
        channel: 'net:x',
        duration_bucket: '500-1000',
        count: 3,
        min_ms: 500,
        max_ms: 900,
        aggregated: true,
      })
    })

    it('keeps separate buckets for distinct tag sets', () => {
      recordHistogram('ipc.slow_ms', 500, { channel: 'net:a', duration_bucket: '500-1000' })
      recordHistogram('ipc.slow_ms', 500, { channel: 'net:b', duration_bucket: '500-1000' })
      flushAggregator()
      expect(sentryInfo).toHaveBeenCalledTimes(2)
    })
  })

  describe('recordGauge', () => {
    it('emits immediately without aggregation', () => {
      recordGauge('body_indexer.backlog', 17000)
      expect(sentryInfo).toHaveBeenCalledWith('body_indexer.backlog', { value: 17000 })
    })
  })

  describe('bucket helpers', () => {
    it('bucketQueryLen hits all ranges', () => {
      expect(bucketQueryLen(1)).toBe('1-2')
      expect(bucketQueryLen(3)).toBe('3-5')
      expect(bucketQueryLen(7)).toBe('6-10')
      expect(bucketQueryLen(15)).toBe('11-20')
      expect(bucketQueryLen(30)).toBe('21-50')
      expect(bucketQueryLen(100)).toBe('50+')
    })
    it('bucketResultCount separates zero from the rest', () => {
      expect(bucketResultCount(0)).toBe('0')
      expect(bucketResultCount(3)).toBe('1-5')
      expect(bucketResultCount(50)).toBe('21-50')
      expect(bucketResultCount(500)).toBe('100+')
    })
    it('bucketDuration is monotonic', () => {
      expect(bucketDuration(10)).toBe('<50')
      expect(bucketDuration(60)).toBe('50-100')
      expect(bucketDuration(800)).toBe('500-1000')
      expect(bucketDuration(10000)).toBe('5000+')
    })
    it('bucketSessionLength uses product boundaries', () => {
      expect(bucketSessionLength(30_000)).toBe('<1min')
      expect(bucketSessionLength(3 * 60_000)).toBe('1-5min')
      expect(bucketSessionLength(20 * 60_000)).toBe('5-30min')
      expect(bucketSessionLength(90 * 60_000)).toBe('30min-2h')
      expect(bucketSessionLength(3 * 60 * 60_000)).toBe('2h+')
    })
    it('folderRoleFromPath never leaks raw paths', () => {
      expect(folderRoleFromPath('INBOX')).toBe('inbox')
      expect(folderRoleFromPath('[Gmail]/Sent Mail')).toBe('sent')
      expect(folderRoleFromPath('[Gmail]/All Mail')).toBe('archive')
      expect(folderRoleFromPath('Custom/Client Emails')).toBe('other')
      expect(folderRoleFromPath('Junk')).toBe('spam')
    })
  })

  describe('startMetricSpan (typed API)', () => {
    // Contract for metric spans: every span gets an explicit `op`, and
    // `parentSpan: null` keeps metric sampling independent from ambient
    // Sentry/OTel context. Delivery still depends first on a real DSN in
    // the built bundle.
    //
    // After the two-function split, startMetricSpan is strict: its `name`
    // parameter is typed as MetricSpanName, so a typo'd literal fails at
    // compile time. Runtime-bridged names (packages/net, packages/db)
    // flow through startMetricSpanDynamic — see its own describe block.

    it('forwards `op` from METRIC_SPAN_OP for imap.sync', () => {
      startMetricSpan('imap.sync', {
        folder_role: 'inbox',
        provider: 'gmail',
        fetched_headers_bucket: '1-10',
      })
      expect(startInactiveSpanMock).toHaveBeenCalledTimes(1)
      expect(startInactiveSpanMock).toHaveBeenCalledWith({
        name: 'imap.sync',
        op: 'imap.sync',
        attributes: {
          folder_role: 'inbox',
          provider: 'gmail',
          fetched_headers_bucket: '1-10',
        },
        parentSpan: null,
      })
    })

    it('forwards `op` from METRIC_SPAN_OP for body_indexer.batch', () => {
      startMetricSpan('body_indexer.batch', {
        folder_role: 'inbox',
        batch_size_bucket: '1-10',
      })
      expect(startInactiveSpanMock).toHaveBeenCalledWith({
        name: 'body_indexer.batch',
        op: 'body_indexer.batch',
        attributes: {
          folder_role: 'inbox',
          batch_size_bucket: '1-10',
        },
        parentSpan: null,
      })
    })

    it('forwards `op` from METRIC_SPAN_OP for search.fts', () => {
      startMetricSpan('search.fts', { query_len_bucket: '3-5' })
      expect(startInactiveSpanMock).toHaveBeenCalledWith({
        name: 'search.fts',
        op: 'search.fts',
        attributes: { query_len_bucket: '3-5' },
        parentSpan: null,
      })
    })

    it('rejects unknown span-name literals at compile time', () => {
      // If TypeScript silently accepts the literal (as the old string
      // overload used to), the @ts-expect-error directive itself fails
      // the build. This is the regression guard Codex requested: typed
      // startMetricSpan must NEVER widen to `string`.
      //
      // The call below is intentionally unreachable at runtime so a
      // stray log doesn't pollute other cases; we only care about the
      // compile-time effect of the directive.
      function _typeOnlyCheck(): void {
        void (() => {
          // @ts-expect-error typo — typed API rejects unknown names
          startMetricSpan('imap.synk', {})
        })
      }
      expect(_typeOnlyCheck).toBeDefined()
    })

    it('degrades to a no-op handle when the underlying Sentry call throws', () => {
      startInactiveSpanMock.mockImplementationOnce(() => {
        throw new Error('sentry broken')
      })
      // Must not propagate — telemetry invariant.
      const span = startMetricSpan('offline.replay', {})
      expect(typeof span.end).toBe('function')
      // The no-op stub must be callable without throwing.
      expect(() => span.end()).not.toThrow()
    })
  })

  describe('startMetricSpanDynamic (runtime-bridge API)', () => {
    // This is the `string`-typed entry point that main.ts uses to wire
    // setNetTelemetrySink / setDbTelemetrySink. Its contract:
    //   1. A name that IS registered in METRIC_SPAN_OP emits the mapped
    //      `op` — same as the typed API.
    //   2. A name that is NOT registered emits `op = name` so the
    //      explicit-op invariant still holds for diagnostics/querying.
    //   3. It MUST exist under a distinct export name so direct callers
    //      cannot accidentally use the loose string path.

    it('emits the mapped `op` for a registered bridged name', () => {
      startMetricSpanDynamic('imap.idle', { folder_role: 'inbox' })
      expect(startInactiveSpanMock).toHaveBeenCalledWith({
        name: 'imap.idle',
        op: 'imap.idle',
        attributes: { folder_role: 'inbox' },
        parentSpan: null,
      })
    })

    it('falls back to `op = name` for an unregistered bridged name', () => {
      // Bridged names come from packages/net / packages/db as plain
      // strings; a yet-to-be-registered name must still ship with a
      // non-empty `op` for diagnostics/querying.
      startMetricSpanDynamic('unregistered.future.span', { sample: 'ok' })
      expect(startInactiveSpanMock).toHaveBeenCalledWith({
        name: 'unregistered.future.span',
        op: 'unregistered.future.span',
        attributes: { sample: 'ok' },
        parentSpan: null,
      })
    })

    it('degrades to a no-op handle when the underlying Sentry call throws', () => {
      startInactiveSpanMock.mockImplementationOnce(() => {
        throw new Error('sentry broken')
      })
      const span = startMetricSpanDynamic('some.bridged.name')
      expect(typeof span.end).toBe('function')
      expect(() => span.end()).not.toThrow()
    })
  })
})
