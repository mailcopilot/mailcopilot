// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMailOpenOwnership, type MailOpenOwnership } from './useMailOpenOwnership'
import type { MailOpenSink } from '../../packages/core/mailOpenOwnership'

/**
 * §2.308. The reading-pane state as `App.openMail` drives it: `openMail` marks
 * the pane loading, requests the details through `run`, and the sink writes
 * the pane. `ctxSeq` (the LIST generation) is not part of ownership; a sync
 * therefore appears here only as "nothing happens to the ownership counters",
 * which is the whole point of the fix.
 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

interface Pane { details: string | null; loading: boolean; error: string | null }

function setup() {
  const hook = renderHook(() => useMailOpenOwnership())
  const own = (): MailOpenOwnership => hook.result.current
  const pane: Pane = { details: null, loading: false, error: null }
  const sink: MailOpenSink<string> = {
    onApplied: (d) => { pane.details = d },
    onFailed: (e) => { pane.error = String(e) },
    onDiscarded: () => {},
    releaseLoading: () => { pane.loading = false },
  }
  /** What `openMail` does: begin, mark loading, request. */
  const open = (request: () => Promise<string>) => {
    const ticket = own().beginOpen()
    pane.details = null
    pane.loading = true
    return own().run(ticket, request, sink)
  }
  /** What the navigation paths do: invalidate, drop the open message, clear loading. */
  const navigate = () => {
    own().invalidateNavigation()
    pane.details = null
    pane.loading = false
  }
  return { own, pane, open, navigate }
}

describe('useMailOpenOwnership — open message vs refresh/navigation (§2.308)', () => {
  it('has a stable identity across renders (it sits in callback dependency lists)', () => {
    const { result, rerender } = renderHook(() => useMailOpenOwnership())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('AI-chat link into another folder: auto-sync during pending details does not orphan the open', async () => {
    const { pane, open, navigate } = setup()
    // openMessageRef: selectAccount() navigates, then openMail() starts.
    navigate()
    const d = deferred<string>()
    const run = open(() => d.promise)
    // The folder switch triggers auto-sync -> syncFolder() invalidates the LIST
    // only (`ctxSeq`); it has no entry point into open ownership at all.
    expect(pane.loading).toBe(true)
    d.resolve('details')
    await act(async () => { await run })
    expect(pane.details).toBe('details')
    expect(pane.loading).toBe(false)
  })

  it('ordinary open + periodic sync: the body still renders', async () => {
    const { pane, open } = setup()
    const d = deferred<string>()
    const run = open(() => d.promise)
    // periodic sync starts and finishes here: no ownership call, by design
    d.resolve('body')
    await act(async () => { await run })
    expect(pane).toEqual({ details: 'body', loading: false, error: null })
  })

  it('a real navigation during the pending request discards the stale response and leaves no loading', async () => {
    const { pane, open, navigate } = setup()
    const d = deferred<string>()
    const run = open(() => d.promise)
    navigate()
    d.resolve('stale')
    await act(async () => { await run })
    expect(pane.details).toBeNull()
    expect(pane.loading).toBe(false)
  })

  it('a newer open wins: the older response neither renders nor clears the newer loading flag', async () => {
    const { pane, open } = setup()
    const first = deferred<string>()
    const second = deferred<string>()
    const run1 = open(() => first.promise)
    const run2 = open(() => second.promise)
    first.resolve('first')
    await act(async () => { await run1 })
    expect(pane.details).toBeNull()
    expect(pane.loading).toBe(true)
    second.resolve('second')
    await act(async () => { await run2 })
    expect(pane).toEqual({ details: 'second', loading: false, error: null })
  })

  it('a newer open wins even if the older one settles LAST', async () => {
    const { pane, open } = setup()
    const first = deferred<string>()
    const second = deferred<string>()
    const run1 = open(() => first.promise)
    const run2 = open(() => second.promise)
    second.resolve('second')
    await act(async () => { await run2 })
    first.resolve('first')
    await act(async () => { await run1 })
    expect(pane).toEqual({ details: 'second', loading: false, error: null })
  })

  it('degraded path: a request that fails after sync leaves an error, not an endless loading', async () => {
    const { pane, open } = setup()
    const d = deferred<string>()
    const run = open(() => d.promise)
    d.reject(new Error('IMAP timeout'))
    await act(async () => { await run })
    expect(pane.loading).toBe(false)
    expect(pane.error).toContain('IMAP timeout')
    expect(pane.details).toBeNull()
  })

  it('degraded path: a failure after the user navigated away is silent and leaves no loading', async () => {
    const { pane, open, navigate } = setup()
    const d = deferred<string>()
    const run = open(() => d.promise)
    navigate()
    d.reject(new Error('IMAP timeout'))
    await act(async () => { await run })
    expect(pane).toEqual({ details: null, loading: false, error: null })
  })

  it('a live request releases loading after navigation even when the navigation path did not clear it', async () => {
    const { own, pane, open } = setup()
    const d = deferred<string>()
    const run = open(() => d.promise)
    // Raw invalidation only: a navigation path that forgot to clear the flag.
    own().invalidateNavigation()
    expect(pane.loading).toBe(true)
    d.resolve('stale')
    await act(async () => { await run })
    expect(pane.details).toBeNull()
    expect(pane.loading).toBe(false)
  })

  it('a newer open started after a navigation owns the pane; the pre-navigation response is ignored entirely', async () => {
    const { pane, open, navigate } = setup()
    const before = deferred<string>()
    const after = deferred<string>()
    const run1 = open(() => before.promise)
    navigate()
    const run2 = open(() => after.promise)
    before.resolve('before-navigation')
    await act(async () => { await run1 })
    expect(pane.details).toBeNull()
    expect(pane.loading).toBe(true) // the newer open still waits
    after.resolve('after-navigation')
    await act(async () => { await run2 })
    expect(pane).toEqual({ details: 'after-navigation', loading: false, error: null })
  })

  it('double navigation while a request is pending still leaves nothing shown and no loading', async () => {
    const { own, pane, open } = setup()
    const d = deferred<string>()
    const run = open(() => d.promise)
    own().invalidateNavigation()
    own().invalidateNavigation()
    d.resolve('stale')
    await act(async () => { await run })
    expect(pane).toEqual({ details: null, loading: false, error: null })
  })

  it('navigating after the newest open was issued discards both responses and leaves no loading', async () => {
    const { pane, open, navigate } = setup()
    const first = deferred<string>()
    const second = deferred<string>()
    const run1 = open(() => first.promise)
    const run2 = open(() => second.promise)
    navigate()
    second.resolve('second')
    first.resolve('first')
    await act(async () => { await Promise.all([run1, run2]) })
    expect(pane).toEqual({ details: null, loading: false, error: null })
  })

  it('reopening the same message after it finished: the new request is live and not blocked by the old one', async () => {
    const { pane, open } = setup()
    await act(async () => { await open(async () => 'first copy') })
    expect(pane.details).toBe('first copy')
    const d = deferred<string>()
    const run = open(() => d.promise)
    expect(pane).toMatchObject({ details: null, loading: true })
    d.resolve('second copy')
    await act(async () => { await run })
    expect(pane).toEqual({ details: 'second copy', loading: false, error: null })
  })

  it('reopening the same message while the first request is pending: only the second response is shown, even if the first fails last', async () => {
    const { pane, open } = setup()
    const first = deferred<string>()
    const second = deferred<string>()
    const run1 = open(() => first.promise)
    const run2 = open(() => second.promise)
    second.resolve('same message')
    await act(async () => { await run2 })
    first.reject(new Error('old request failed'))
    await act(async () => { await run1 })
    expect(pane).toEqual({ details: 'same message', loading: false, error: null })
  })

  it('a request function that throws synchronously ends in an error, not in endless loading', async () => {
    const { pane, open } = setup()
    await act(async () => { await open(() => { throw new Error('ipc unavailable') }) })
    expect(pane.loading).toBe(false)
    expect(pane.error).toContain('ipc unavailable')
  })

  it('a throwing apply sink surfaces as a failure and leaves no loading', async () => {
    const hook = renderHook(() => useMailOpenOwnership())
    const own = hook.result.current
    let loading = true
    const errors: string[] = []
    const ticket = own.beginOpen()
    await act(async () => {
      await own.run(ticket, async () => 'x', {
        onApplied: () => { throw new Error('render crashed') },
        onFailed: e => { errors.push((e as Error).message) },
        onDiscarded: () => {},
        releaseLoading: () => { loading = false },
      })
    })
    expect(errors).toEqual(['render crashed'])
    expect(loading).toBe(false)
  })
})
