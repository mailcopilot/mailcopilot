import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setDbTelemetrySink,
  setDbErrorReporter,
  setDbEventReporter,
  reportDbEvent,
  reportDbError,
  withDbSpan,
  startDbSpan,
  __getDbTelemetryBufferSizeForTest,
  setDbTelemetryCollectionGate,
  resetDbTelemetryBuffer,
} from './telemetry'

beforeEach(() => {
  // Retention is consent-gated (§2.82) and fail-closed. The suites below
  // assert what the span buffer does WHEN allowed; the gate's own behaviour
  // has its own describe block, which installs its own gate.
  setDbTelemetryCollectionGate(() => true)
  resetDbTelemetryBuffer()
})

afterEach(() => {
  setDbTelemetrySink(null)
  setDbErrorReporter(null)
  setDbEventReporter(null)
  resetDbTelemetryBuffer()
  setDbTelemetryCollectionGate(null)
})

describe('packages/db/telemetry — span seam', () => {
  it('buffering default: withDbSpan runs fn and returns its value without sink installed', () => {
    const result = withDbSpan('db.upsert_messages', { folder_role: 'inbox' }, () => 42)
    expect(result).toBe(42)
  })

  it('installs a starter and calls it with name + attributes', () => {
    const end = vi.fn()
    const starter = vi.fn(() => ({ end }))
    setDbTelemetrySink(starter)

    withDbSpan('db.upsert_messages', { folder_role: 'inbox', row_count_bucket: '1-10' }, () => 'ok')

    expect(starter).toHaveBeenCalledTimes(1)
    expect(starter).toHaveBeenCalledWith('db.upsert_messages', { folder_role: 'inbox', row_count_bucket: '1-10' })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('calls end() on both success and error paths', () => {
    const end = vi.fn()
    setDbTelemetrySink(() => ({ end }))

    withDbSpan('db.upsert_messages', {}, () => 1)
    expect(() =>
      withDbSpan('db.upsert_messages', {}, () => { throw new Error('boom') }),
    ).toThrow('boom')

    expect(end).toHaveBeenCalledTimes(2)
  })

  it('a throwing starter does not break the caller (telemetry is fire-and-forget)', () => {
    setDbTelemetrySink(() => { throw new Error('sentry exploded') })

    const value = withDbSpan('db.search_messages', { query_len_bucket: '3-5' }, () => 'still works')
    expect(value).toBe('still works')
  })

  it('a throwing end() does not break the caller', () => {
    setDbTelemetrySink(() => ({
      end: () => { throw new Error('span.end exploded') },
    }))

    const value = withDbSpan('db.upsert_messages', {}, () => 123)
    expect(value).toBe(123)
  })

  it('a throwing setAttribute path does not break the caller', () => {
    setDbTelemetrySink(() => ({
      end: vi.fn(),
      setAttribute: () => { throw new Error('attr exploded') },
    }))

    const value = withDbSpan(
      'db.upsert_messages',
      {},
      () => 'ok',
      () => ({ row_count_bucket: '1-10' }),
    )
    expect(value).toBe('ok')
  })

  it('a throwing setAttributes path does not break the caller', () => {
    setDbTelemetrySink(() => ({
      end: vi.fn(),
      setAttributes: () => { throw new Error('attrs exploded') },
    }))

    const value = withDbSpan(
      'db.search_messages',
      {},
      () => [1, 2, 3],
      () => ({ result_count_bucket: '1-5' }),
    )
    expect(value).toEqual([1, 2, 3])
  })

  it('finalize() can attach post-hoc attributes on success', () => {
    const setAttributes = vi.fn()
    const end = vi.fn()
    setDbTelemetrySink(() => ({ end, setAttributes }))

    withDbSpan(
      'db.upsert_messages',
      { folder_role: 'inbox' },
      () => ({ rows: 42 }),
      (result) => (result.ok ? { row_count_bucket: '11-100' } : {}),
    )

    expect(setAttributes).toHaveBeenCalledWith({ row_count_bucket: '11-100' })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('finalize() can attach post-hoc attributes on error', () => {
    const setAttributes = vi.fn()
    const end = vi.fn()
    setDbTelemetrySink(() => ({ end, setAttributes }))

    expect(() =>
      withDbSpan(
        'db.upsert_messages',
        {},
        () => { throw new Error('sqlite busy') },
        (result) => (result.ok ? {} : { errored: true }),
      ),
    ).toThrow('sqlite busy')

    expect(setAttributes).toHaveBeenCalledWith({ errored: true })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('throwing finalize() is isolated from fn() return value', () => {
    const end = vi.fn()
    setDbTelemetrySink(() => ({ end, setAttributes: vi.fn() }))

    const value = withDbSpan(
      'db.search_messages',
      {},
      () => 'payload',
      () => { throw new Error('finalize exploded') },
    )

    expect(value).toBe('payload')
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('setDbErrorReporter receives fn() throws with source + initial attrs', () => {
    const reporter = vi.fn()
    setDbTelemetrySink(() => ({ end: vi.fn() }))
    setDbErrorReporter(reporter)

    const err = new Error('constraint violation')
    expect(() =>
      withDbSpan('db.upsert_messages', { folder_role: 'inbox' }, () => { throw err }),
    ).toThrow(err)

    expect(reporter).toHaveBeenCalledTimes(1)
    expect(reporter).toHaveBeenCalledWith(
      'db.upsert_messages',
      err,
      { folder_role: 'inbox' },
    )
  })

  it('a throwing error reporter does not mask the original error', () => {
    setDbTelemetrySink(() => ({ end: vi.fn() }))
    setDbErrorReporter(() => { throw new Error('sentry broke') })

    expect(() =>
      withDbSpan('db.upsert_messages', {}, () => { throw new Error('real failure') }),
    ).toThrow('real failure')
  })

  it('drops pre-reporter error reports outright — installing one replays nothing', () => {
    // Errors are NOT retained: the window before installation cannot be
    // consented to (the gate arrives later still), so holding them could
    // never be lawful. The report is gone, and that is the documented shape.
    expect(() =>
      reportDbError('db.migrate_purge_uidless_messages', new Error('messages.uid_unstorable_rows_purged'), { purged_count: 3 }),
    ).not.toThrow()

    const reporter = vi.fn()
    setDbErrorReporter(reporter)
    expect(reporter).not.toHaveBeenCalled()
  })

  it('a live report reaches the installed reporter unchanged', () => {
    const reporter = vi.fn()
    setDbErrorReporter(reporter)
    const err = new Error('no such table: messages')
    reportDbError('db.upsert_messages', err, { skipped_count: 1 })
    // The scrubbing boundary for live reports is electron/sentry.ts.
    expect(reporter).toHaveBeenCalledWith('db.upsert_messages', err, { skipped_count: 1 })
  })

  it('setDbErrorReporter(null) returns to the silent default', () => {
    const reporter = vi.fn()
    setDbErrorReporter(reporter)
    setDbErrorReporter(null)
    expect(() => reportDbError('db.upsert_messages', new Error('x'), {})).not.toThrow()
    expect(reporter).not.toHaveBeenCalled()
  })

  it('startDbSpan returns a safe handle even without a sink', () => {
    const h = startDbSpan('db.search_messages', { folder_role: 'inbox' })
    expect(() => h.setAttributes?.({ result_count_bucket: '1-5' })).not.toThrow()
    expect(() => h.setAttribute?.('query_len_bucket', '3-5')).not.toThrow()
    expect(() => h.end()).not.toThrow()
  })

  // --- buffered cold-start sink ---

  it('buffers spans recorded before any sink is installed', () => {
    withDbSpan('db.upsert_messages', { folder_role: 'inbox' }, () => 1)
    withDbSpan('db.search_messages', { query_len_bucket: '3-5' }, () => [])
    expect(__getDbTelemetryBufferSizeForTest()).toBe(2)
  })

  it('drains the buffer into the real sink on installation', () => {
    withDbSpan('db.upsert_messages', { folder_role: 'inbox' }, () => 1)
    withDbSpan('db.reconcile_uids', { folder_role: 'sent' }, () => 2)
    expect(__getDbTelemetryBufferSizeForTest()).toBe(2)

    const end = vi.fn()
    const calls: Array<{ name: string; attrs: Record<string, unknown> }> = []
    setDbTelemetrySink((name, attrs) => {
      calls.push({ name, attrs: attrs as Record<string, unknown> })
      return { end }
    })

    expect(calls).toHaveLength(2)
    expect(end).toHaveBeenCalledTimes(2)
    // Replayed attributes are decorated so dashboards can distinguish them.
    expect(calls[0].name).toBe('db.upsert_messages')
    expect(calls[0].attrs).toMatchObject({ folder_role: 'inbox', buffered: true })
    expect(typeof calls[0].attrs.buffered_duration_ms).toBe('number')
    expect(__getDbTelemetryBufferSizeForTest()).toBe(0)
  })

  it('replays finalize-attached attributes via setAttributes on drain', () => {
    withDbSpan(
      'db.upsert_messages',
      { folder_role: 'inbox' },
      () => 1,
      () => ({ row_count_bucket: '11-100' }),
    )

    const setAttributes = vi.fn()
    const end = vi.fn()
    setDbTelemetrySink(() => ({ end, setAttributes }))

    expect(setAttributes).toHaveBeenCalledWith({ row_count_bucket: '11-100' })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('respects the BUFFER_CAP and drops oldest entries when full', () => {
    for (let i = 0; i < 300; i++) {
      withDbSpan('db.upsert_messages', { i }, () => i)
    }
    // BUFFER_CAP = 256; the first 44 should have been dropped.
    expect(__getDbTelemetryBufferSizeForTest()).toBe(256)

    const seen: number[] = []
    setDbTelemetrySink((_name, attrs) => {
      seen.push((attrs as { i?: number }).i ?? -1)
      return { end: () => {} }
    })
    expect(seen.length).toBe(256)
    // Oldest should be 44, newest 299.
    expect(seen[0]).toBe(44)
    expect(seen[seen.length - 1]).toBe(299)
  })

  it('a throwing replay sink does not break sink installation or DB operations', () => {
    withDbSpan('db.upsert_messages', {}, () => 1)
    withDbSpan('db.search_messages', {}, () => 2)

    expect(() => setDbTelemetrySink(() => { throw new Error('replay exploded') })).not.toThrow()
    // Buffer still drained (cleared) regardless of replay failure.
    expect(__getDbTelemetryBufferSizeForTest()).toBe(0)

    // Live DB operations still succeed and are forwarded to the (broken) sink
    // without surfacing failures to the caller.
    const value = withDbSpan('db.upsert_messages', {}, () => 'still works')
    expect(value).toBe('still works')
  })

  it('a throwing end() during replay does not break drain', () => {
    withDbSpan('db.upsert_messages', {}, () => 1)
    withDbSpan('db.search_messages', {}, () => 2)

    const calls: string[] = []
    setDbTelemetrySink((name) => ({
      end: () => {
        calls.push(name)
        if (name === 'db.upsert_messages') throw new Error('end exploded')
      },
    }))

    expect(calls).toContain('db.upsert_messages')
    expect(calls).toContain('db.search_messages')
    expect(__getDbTelemetryBufferSizeForTest()).toBe(0)
  })

  it('post-install spans go to the real sink, not the buffer', () => {
    const starter = vi.fn(() => ({ end: vi.fn() }))
    setDbTelemetrySink(starter)

    withDbSpan('db.upsert_messages', { folder_role: 'inbox' }, () => 1)
    expect(starter).toHaveBeenCalledTimes(1)
    expect(__getDbTelemetryBufferSizeForTest()).toBe(0)
  })

  it('startDbSpan forwards setAttributes + end to the installed sink', () => {
    const end = vi.fn()
    const setAttributes = vi.fn()
    setDbTelemetrySink(() => ({ end, setAttributes }))

    const h = startDbSpan('db.search_messages', { folder_role: 'inbox' })
    h.setAttributes?.({ result_count_bucket: '1-5', query_len_bucket: '3-5' })
    h.end()

    expect(setAttributes).toHaveBeenCalledWith({ result_count_bucket: '1-5', query_len_bucket: '3-5' })
    expect(end).toHaveBeenCalledTimes(1)
  })

  // --- typed discrete event seam (reportDbEvent / setDbEventReporter) ---

  it('reportDbEvent: silent no-op by default (no reporter installed)', () => {
    // No sink wired — must not throw, nothing observable.
    expect(() =>
      reportDbEvent('db.mass_delete_messages', { reason: 'server_empty', watermark_preserved: true }),
    ).not.toThrow()
  })

  it('reportDbEvent: forwards name + tags to installed reporter', () => {
    const reporter = vi.fn()
    setDbEventReporter(reporter)

    reportDbEvent('db.mass_delete_messages', {
      folder_role: 'inbox',
      reason: 'server_empty',
      deleted_count_bucket: '101-1000',
      watermark_preserved: true,
    })

    expect(reporter).toHaveBeenCalledTimes(1)
    expect(reporter).toHaveBeenCalledWith('db.mass_delete_messages', {
      folder_role: 'inbox',
      reason: 'server_empty',
      deleted_count_bucket: '101-1000',
      watermark_preserved: true,
    })
  })

  it('reportDbEvent: throwing reporter does not propagate (fire-and-forget)', () => {
    setDbEventReporter(() => { throw new Error('sink broke') })
    expect(() =>
      reportDbEvent('db.mass_delete_messages', { reason: 'uidvalidity_bump' }),
    ).not.toThrow()
  })

  it('setDbEventReporter(null) resets to silent no-op', () => {
    const reporter = vi.fn()
    setDbEventReporter(reporter)
    reportDbEvent('db.mass_delete_messages', { reason: 'server_empty' })
    expect(reporter).toHaveBeenCalledTimes(1)

    setDbEventReporter(null)
    reportDbEvent('db.mass_delete_messages', { reason: 'server_empty' })
    // Reporter is no longer wired — still only the one call from before reset.
    expect(reporter).toHaveBeenCalledTimes(1)
  })
})

// §2.82 — the privacy page promises that nothing is COLLECTED before the user
// answers, not merely that nothing is sent. These pin that the span buffer
// above is part of "nothing".
describe('packages/db/telemetry — consent gate on retention', () => {
  it('retains nothing while no gate is installed (fail-closed default)', () => {
    setDbTelemetryCollectionGate(null)

    withDbSpan('db.upsert_messages', { folder_role: 'inbox' }, () => 1)

    expect(__getDbTelemetryBufferSizeForTest()).toBe(0)
    const starter = vi.fn(() => ({ end: vi.fn() }))
    setDbTelemetrySink(starter)
    expect(starter).not.toHaveBeenCalled()
  })

  it('retains nothing while an installed gate says collection is refused', () => {
    setDbTelemetryCollectionGate(() => false)

    withDbSpan('db.upsert_messages', {}, () => 1)

    expect(__getDbTelemetryBufferSizeForTest()).toBe(0)
  })

  it('a throwing gate reads as refused, not as allowed', () => {
    setDbTelemetryCollectionGate(() => { throw new Error('gate exploded') })

    expect(() => withDbSpan('db.upsert_messages', {}, () => 1)).not.toThrow()

    expect(__getDbTelemetryBufferSizeForTest()).toBe(0)
  })

  it('a consent transition drops what was already retained', () => {
    setDbTelemetryCollectionGate(() => true)
    withDbSpan('db.upsert_messages', { folder_role: 'inbox' }, () => 1)
    expect(__getDbTelemetryBufferSizeForTest()).toBe(1)

    // This is what main.ts registers as the gate's reset hook; it runs on
    // off→on AND on→off, so neither direction can flush a stale backlog.
    resetDbTelemetryBuffer()

    expect(__getDbTelemetryBufferSizeForTest()).toBe(0)
    const starter = vi.fn(() => ({ end: vi.fn() }))
    setDbTelemetrySink(starter)
    expect(starter).not.toHaveBeenCalled()
  })

  it('closing the gate through the setter drops what was retained', () => {
    setDbTelemetryCollectionGate(() => true)
    withDbSpan('db.upsert_messages', {}, () => 1)
    expect(__getDbTelemetryBufferSizeForTest()).toBe(1)

    setDbTelemetryCollectionGate(() => false)
    expect(__getDbTelemetryBufferSizeForTest()).toBe(0)
  })
})

describe('packages/db/telemetry — event seam tail', () => {
  it('setDbEventReporter(null) resets to silent no-op (events have no buffer)', () => {
    const reporter = vi.fn()
    setDbEventReporter(reporter)
    reportDbEvent('db.mass_delete_messages', { reason: 'server_empty' })
    expect(reporter).toHaveBeenCalledTimes(1)

    setDbEventReporter(null)
    reportDbEvent('db.mass_delete_messages', { reason: 'server_empty' })
    // Reporter is no longer wired — still only the one call from before reset.
    expect(reporter).toHaveBeenCalledTimes(1)
  })
})
