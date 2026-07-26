import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setNetTelemetrySink,
  setNetErrorReporter,
  withNetSpan,
  startNetSpan,
  reportNetError,
} from './telemetry'

afterEach(() => {
  setNetTelemetrySink(null)
  setNetErrorReporter(null)
})

describe('packages/net/telemetry — span seam', () => {
  it('no-op default: withNetSpan runs fn and returns its value without sink installed', async () => {
    const result = await withNetSpan('imap.sync', { folder_role: 'inbox' }, async () => 42)
    expect(result).toBe(42)
  })

  it('installs a starter and calls it with name + attributes', async () => {
    const end = vi.fn()
    const starter = vi.fn(() => ({ end }))
    setNetTelemetrySink(starter)

    await withNetSpan('imap.sync', { folder_role: 'inbox', provider: 'gmail' }, async () => 'ok')

    expect(starter).toHaveBeenCalledTimes(1)
    expect(starter).toHaveBeenCalledWith('imap.sync', { folder_role: 'inbox', provider: 'gmail' })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('calls end() on both success and error paths', async () => {
    const end = vi.fn()
    setNetTelemetrySink(() => ({ end }))

    await withNetSpan('imap.sync', {}, async () => 1)
    await expect(
      withNetSpan('imap.sync', {}, async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')

    expect(end).toHaveBeenCalledTimes(2)
  })

  it('a throwing starter does not break the caller (telemetry is fire-and-forget)', async () => {
    setNetTelemetrySink(() => { throw new Error('sentry exploded') })

    const value = await withNetSpan('smtp.send', { provider: 'gmail' }, async () => 'still works')
    expect(value).toBe('still works')
  })

  it('a throwing end() does not break the caller', async () => {
    setNetTelemetrySink(() => ({
      end: () => { throw new Error('span.end exploded') },
    }))

    const value = await withNetSpan('imap.sync', {}, async () => 123)
    expect(value).toBe(123)
  })

  it('finalize() can attach post-hoc attributes on success', async () => {
    const setAttributes = vi.fn()
    const end = vi.fn()
    setNetTelemetrySink(() => ({ end, setAttributes }))

    await withNetSpan(
      'imap.sync',
      { folder_role: 'inbox' },
      async () => ({ fetched: 42 }),
      (result) => (result.ok ? { fetched_headers_bucket: '11-100' } : {}),
    )

    expect(setAttributes).toHaveBeenCalledWith({ fetched_headers_bucket: '11-100' })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('finalize() can attach post-hoc attributes on error', async () => {
    const setAttributes = vi.fn()
    const end = vi.fn()
    setNetTelemetrySink(() => ({ end, setAttributes }))

    await expect(
      withNetSpan(
        'imap.sync',
        {},
        async () => { throw new Error('fetch stalled') },
        (result) => (result.ok ? {} : { errored: true }),
      ),
    ).rejects.toThrow('fetch stalled')

    expect(setAttributes).toHaveBeenCalledWith({ errored: true })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('throwing finalize() is isolated from fn() return value', async () => {
    const end = vi.fn()
    setNetTelemetrySink(() => ({ end, setAttributes: vi.fn() }))

    const value = await withNetSpan(
      'imap.sync',
      {},
      async () => 'payload',
      () => { throw new Error('finalize exploded') },
    )

    expect(value).toBe('payload')
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('setNetErrorReporter receives fn() rejections with source + initial attrs', async () => {
    const reporter = vi.fn()
    setNetTelemetrySink(() => ({ end: vi.fn() }))
    setNetErrorReporter(reporter)

    const err = new Error('auth failure')
    await expect(
      withNetSpan('imap.sync', { folder_role: 'inbox', provider: 'gmail' }, async () => { throw err }),
    ).rejects.toBe(err)

    expect(reporter).toHaveBeenCalledTimes(1)
    expect(reporter).toHaveBeenCalledWith(
      'imap.sync',
      err,
      { folder_role: 'inbox', provider: 'gmail' },
    )
  })

  it('a throwing error reporter does not mask the original error', async () => {
    setNetTelemetrySink(() => ({ end: vi.fn() }))
    setNetErrorReporter(() => { throw new Error('sentry broke') })

    await expect(
      withNetSpan('imap.sync', {}, async () => { throw new Error('real failure') }),
    ).rejects.toThrow('real failure')
  })

  it('reportNetError is safe to call without a reporter installed', () => {
    expect(() => reportNetError('imap.idle', new Error('x'))).not.toThrow()
  })

  it('startNetSpan returns a safe handle even without a sink', () => {
    const h = startNetSpan('imap.idle', { folder_role: 'inbox' })
    expect(() => h.setAttributes?.({ exit_reason: 'refresh' })).not.toThrow()
    expect(() => h.setAttribute?.('duration_bucket', '5-20min')).not.toThrow()
    expect(() => h.end()).not.toThrow()
  })

  it('startNetSpan forwards setAttributes + end to the installed sink', () => {
    const end = vi.fn()
    const setAttributes = vi.fn()
    setNetTelemetrySink(() => ({ end, setAttributes }))

    const h = startNetSpan('imap.idle', { folder_role: 'inbox', provider: 'gmail' })
    h.setAttributes?.({ exit_reason: 'refresh', duration_bucket: '20-30min' })
    h.end()

    expect(setAttributes).toHaveBeenCalledWith({ exit_reason: 'refresh', duration_bucket: '20-30min' })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('startNetSpan survives a sink whose setAttributes throws', () => {
    setNetTelemetrySink(() => ({
      end: vi.fn(),
      setAttributes: () => { throw new Error('attr failed') },
    }))

    const h = startNetSpan('imap.idle', {})
    expect(() => h.setAttributes?.({ exit_reason: 'network' })).not.toThrow()
    expect(() => h.end()).not.toThrow()
  })
})
