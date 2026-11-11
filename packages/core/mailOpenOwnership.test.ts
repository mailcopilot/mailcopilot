import { describe, expect, it, vi } from 'vitest'
import { runMailOpen, settleMailOpen, type MailOpenSettlement, type MailOpenSink } from './mailOpenOwnership'

describe('settleMailOpen', () => {
  it('applies a response when nothing moved', () => {
    expect(settleMailOpen({ nav: 3, open: 7 }, { nav: 3, open: 7 })).toEqual({
      kind: 'applied', applyDetails: true, clearLoading: true,
    })
  })

  it('discards after navigation but still releases the loading flag of the live request', () => {
    expect(settleMailOpen({ nav: 3, open: 7 }, { nav: 4, open: 7 })).toEqual({
      kind: 'navigated', applyDetails: false, clearLoading: true,
    })
  })

  it('leaves the loading flag to a newer open request', () => {
    expect(settleMailOpen({ nav: 3, open: 7 }, { nav: 3, open: 8 })).toEqual({
      kind: 'superseded', applyDetails: false, clearLoading: false,
    })
    // Newer open wins even when navigation also happened in between.
    expect(settleMailOpen({ nav: 3, open: 7 }, { nav: 5, open: 8 })).toMatchObject({ kind: 'superseded', clearLoading: false })
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeSink() {
  return {
    onApplied: vi.fn(),
    onFailed: vi.fn(),
    onDiscarded: vi.fn(),
    releaseLoading: vi.fn(),
  } satisfies MailOpenSink<string>
}

describe('runMailOpen', () => {
  const live: MailOpenSettlement = { kind: 'applied', applyDetails: true, clearLoading: true }

  it('applies the details and releases loading', async () => {
    const sink = makeSink()
    await runMailOpen(async () => 'details', () => live, sink)
    expect(sink.onApplied).toHaveBeenCalledWith('details')
    expect(sink.releaseLoading).toHaveBeenCalledOnce()
    expect(sink.onFailed).not.toHaveBeenCalled()
  })

  it('reads ownership after the await, not before', async () => {
    const d = deferred<string>()
    const sink = makeSink()
    let current: MailOpenSettlement = live
    const run = runMailOpen(() => d.promise, () => current, sink)
    current = { kind: 'superseded', applyDetails: false, clearLoading: false }
    d.resolve('late')
    await run
    expect(sink.onApplied).not.toHaveBeenCalled()
    expect(sink.onDiscarded).toHaveBeenCalledOnce()
    expect(sink.releaseLoading).not.toHaveBeenCalled()
  })

  it('reports a failure of the live request and releases loading', async () => {
    const sink = makeSink()
    const err = new Error('timeout')
    await runMailOpen(async () => { throw err }, () => live, sink)
    expect(sink.onFailed).toHaveBeenCalledWith(err)
    expect(sink.releaseLoading).toHaveBeenCalledOnce()
  })

  it('swallows the failure of a superseded request without touching loading', async () => {
    const sink = makeSink()
    await runMailOpen(
      async () => { throw new Error('old') },
      () => ({ kind: 'superseded', applyDetails: false, clearLoading: false }),
      sink,
    )
    expect(sink.onFailed).not.toHaveBeenCalled()
    expect(sink.releaseLoading).not.toHaveBeenCalled()
  })

  it('releases loading even when the apply sink throws, and reports it as a failure', async () => {
    const sink = makeSink()
    sink.onApplied.mockImplementation(() => { throw new Error('render') })
    await runMailOpen(async () => 'x', () => live, sink)
    expect(sink.onFailed).toHaveBeenCalledOnce()
    expect(sink.releaseLoading).toHaveBeenCalledOnce()
  })

  const navigated: MailOpenSettlement = { kind: 'navigated', applyDetails: false, clearLoading: true }

  it('hands a navigated-away response to onDiscarded with the settlement, and still releases loading', async () => {
    const sink = makeSink()
    await runMailOpen(async () => 'stale', () => navigated, sink)
    expect(sink.onApplied).not.toHaveBeenCalled()
    expect(sink.onDiscarded).toHaveBeenCalledExactlyOnceWith(navigated)
    expect(sink.releaseLoading).toHaveBeenCalledOnce()
  })

  it('swallows the failure of a navigated-away request but still releases loading', async () => {
    const sink = makeSink()
    await runMailOpen(async () => { throw new Error('late') }, () => navigated, sink)
    expect(sink.onFailed).not.toHaveBeenCalled()
    expect(sink.onDiscarded).toHaveBeenCalledExactlyOnceWith(navigated)
    expect(sink.releaseLoading).toHaveBeenCalledOnce()
  })

  it('treats a request function that throws synchronously as a failure of the live request', async () => {
    const sink = makeSink()
    const err = new Error('sync boom')
    await runMailOpen<string>(() => { throw err }, () => live, sink)
    expect(sink.onFailed).toHaveBeenCalledExactlyOnceWith(err)
    expect(sink.releaseLoading).toHaveBeenCalledOnce()
  })

  it('passes the very error thrown by the apply sink to onFailed', async () => {
    const sink = makeSink()
    const err = new Error('render')
    sink.onApplied.mockImplementation(() => { throw err })
    await runMailOpen(async () => 'x', () => live, sink)
    expect(sink.onFailed).toHaveBeenCalledExactlyOnceWith(err)
  })

  it('releases loading even when the failure sink throws, and lets that error surface', async () => {
    const sink = makeSink()
    sink.onFailed.mockImplementation(() => { throw new Error('error UI broke') })
    await expect(runMailOpen(async () => { throw new Error('net') }, () => live, sink)).rejects.toThrow('error UI broke')
    expect(sink.releaseLoading).toHaveBeenCalledOnce()
  })

  it('releases loading even when the discard sink throws', async () => {
    const sink = makeSink()
    sink.onDiscarded.mockImplementation(() => { throw new Error('span broke') })
    await expect(runMailOpen(async () => 'x', () => navigated, sink)).rejects.toThrow('span broke')
    expect(sink.onDiscarded).toHaveBeenCalledOnce()
    expect(sink.releaseLoading).toHaveBeenCalledOnce()
  })

  it('does not consult ownership before the request settles', async () => {
    const d = deferred<string>()
    const settle = vi.fn(() => live)
    const run = runMailOpen(() => d.promise, settle, makeSink())
    await Promise.resolve()
    expect(settle).not.toHaveBeenCalled()
    d.resolve('x')
    await run
    expect(settle).toHaveBeenCalled()
  })
})
