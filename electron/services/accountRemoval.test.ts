import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

import { removeAccount, type AccountRemovalDeps } from './accountRemoval'

/**
 * `removeAccount` is the REAL function `accounts:remove` calls (§2.165, §3.3 B3);
 * only its collaborators are injected. Every test records the order in which the
 * collaborators run, so an assertion fails when the sequence changes, not when
 * some source text does.
 */

interface Trace {
  calls: string[]
  deps: AccountRemovalDeps
  /** Resolve / reject the pending `stopIdle` and `deleteAccount` promises by hand. */
  stopIdle: Deferred<void>
  deleteAccount: Deferred<void>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeTrace(overrides: Partial<AccountRemovalDeps> = {}, opts: { recordIsGone?: boolean } = {}): Trace {
  const calls: string[] = []
  const stopIdle = deferred<void>()
  const deleteAccount = deferred<void>()
  const deps: AccountRemovalDeps = {
    stopIdle: () => { calls.push('stopIdle'); return stopIdle.promise },
    deleteAccount: id => { calls.push(`deleteAccount:${id}`); return deleteAccount.promise },
    recordIsGone: id => { calls.push(`recordIsGone:${id}`); return opts.recordIsGone ?? false },
    teardown: id => { calls.push(`teardown:${id}`) },
    onPartialDelete: id => { calls.push(`onPartialDelete:${id}`) },
    fence: {
      begin: id => { calls.push(`fence.begin:${id}`) },
      end: id => { calls.push(`fence.end:${id}`) },
    },
    ...overrides,
  }
  return { calls, deps, stopIdle, deleteAccount }
}

/** Let queued continuations run. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

describe('removeAccount ordering', () => {
  // Fails if `deps.fence.begin(id)` is moved below the `await deps.stopIdle()` (or
  // anywhere after the first await): at that moment `calls` would hold only
  // `stopIdle`, the id could be re-issued before the fence is up.
  it('raises the fence in the same synchronous turn as the call, before anything has awaited', () => {
    const t = makeTrace()

    const pending = removeAccount(7, t.deps)

    // Nothing was resolved yet: this is the synchronous prefix of the function.
    expect(t.calls[0]).toBe('fence.begin:7')
    expect(t.calls).not.toContain('deleteAccount:7')
    expect(t.calls).not.toContain('teardown:7')

    t.stopIdle.resolve()
    t.deleteAccount.resolve()
    return pending
  })

  // Fails if the fence were begun after `deleteAccount` is called: the record
  // leaves inside deleteAccount's synchronous prefix, so begin must precede it.
  it('has the fence up before the deletion is even started, and before idle stopped', async () => {
    const t = makeTrace()
    const pending = removeAccount(7, t.deps)
    await settle()
    // stopIdle has not resolved, deleteAccount was not called, the fence is up.
    expect(t.calls).toEqual(['fence.begin:7', 'stopIdle'])

    t.stopIdle.resolve()
    await settle()
    expect(t.calls).toEqual(['fence.begin:7', 'stopIdle', 'deleteAccount:7'])

    t.deleteAccount.resolve()
    await pending
  })

  // Fails if teardown runs before `await deleteAccount` settles, or the fence is
  // ended before the teardown (the id would be free while the old owner's state
  // is still registered).
  it('runs teardown only after the deletion and ends the fence last', async () => {
    const t = makeTrace()
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    await settle()
    expect(t.calls).not.toContain('teardown:7')

    t.deleteAccount.resolve()
    await pending

    expect(t.calls).toEqual(['fence.begin:7', 'stopIdle', 'deleteAccount:7', 'teardown:7', 'fence.end:7'])
  })

  // Fails if the happy path consulted the store (e.g. the `recordIsGone` check
  // were hoisted above the `await deleteAccount`) or reported a partial delete.
  it('neither asks the store nor reports a partial delete when the deletion resolves', async () => {
    const t = makeTrace()
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.resolve()
    await pending

    expect(t.calls.some(c => c.startsWith('recordIsGone'))).toBe(false)
    expect(t.calls.some(c => c.startsWith('onPartialDelete'))).toBe(false)
  })

  // Fails if the `try { await deps.stopIdle() } catch {}` guard is removed: the
  // rejection would abort the removal before `deleteAccount` is ever called.
  it('goes on to delete when stopping the idle connection fails', async () => {
    const t = makeTrace()
    const pending = removeAccount(7, t.deps)
    t.stopIdle.reject(new Error('idle stop failed'))
    await settle()
    t.deleteAccount.resolve()
    await pending

    expect(t.calls).toEqual(['fence.begin:7', 'stopIdle', 'deleteAccount:7', 'teardown:7', 'fence.end:7'])
  })

  it('passes the same id to every collaborator', async () => {
    const t = makeTrace({}, { recordIsGone: true })
    const pending = removeAccount(42, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.reject(new Error('x'))
    await expect(pending).rejects.toThrow('x')

    for (const call of t.calls) {
      if (call.includes(':')) expect(call.endsWith(':42')).toBe(true)
    }
    expect(t.calls).toHaveLength(7)
  })
})

describe('removeAccount when the deletion rejects', () => {
  // Fails if the `recordIsGone` branch is dropped from the catch (the pre-fix-wave-5
  // handler): the generation is never bumped for a record that is gone.
  it('finishes the teardown, reports the partial delete and re-throws when the record is already gone', async () => {
    const failure = new Error('settings write failed')
    const t = makeTrace({}, { recordIsGone: true })
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.reject(failure)

    await expect(pending).rejects.toBe(failure)
    expect(t.calls).toEqual([
      'fence.begin:7',
      'stopIdle',
      'deleteAccount:7',
      'recordIsGone:7',
      'onPartialDelete:7',
      'teardown:7',
      'fence.end:7',
    ])
  })

  it('hands the original error object to onPartialDelete', async () => {
    const failure = new Error('secret backend down')
    const seen: unknown[] = []
    const t = makeTrace({ onPartialDelete: (_id, err) => { seen.push(err) } }, { recordIsGone: true })
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.reject(failure)
    await expect(pending).rejects.toBe(failure)

    expect(seen).toEqual([failure])
  })

  // Fails if teardown ran for a record that survived: a LIVE mailbox would lose
  // its auth-refresh handler and cert subscription.
  it('does NOT tear down, and does not report a partial delete, when the record survived', async () => {
    const failure = new Error('disk failure')
    const t = makeTrace({}, { recordIsGone: false })
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.reject(failure)

    await expect(pending).rejects.toBe(failure)
    expect(t.calls).toEqual(['fence.begin:7', 'stopIdle', 'deleteAccount:7', 'recordIsGone:7', 'fence.end:7'])
  })

  // Fails if the rethrow were removed or turned into a resolved result: a failed
  // deletion would be reported to the caller as a success.
  it.each([
    ['the record is gone', true],
    ['the record survived', false],
  ])('always re-throws the very same error when %s', async (_name, gone) => {
    const failure = new Error('boom')
    const t = makeTrace({}, { recordIsGone: gone })
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.reject(failure)

    await expect(pending).rejects.toBe(failure)
  })

  // Fails if `fence.end` leaves the `finally` while the store lookup in the
  // catch block can throw: the fence would stay up for that id forever.
  it('ends the fence even when the store lookup itself throws', async () => {
    const t = makeTrace({
      recordIsGone: () => { throw new Error('store unreadable') },
    })
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.reject(new Error('boom'))

    await expect(pending).rejects.toThrow()
    expect(t.calls).not.toContain('teardown:7')
    expect(t.calls[t.calls.length - 1]).toBe('fence.end:7')
  })
})

describe('removeAccount ends the fence on every exit', () => {
  // Fails if `fence.end` is taken out of the `finally` (e.g. placed after the
  // teardown in the try body): a throwing teardown would leave the id refused
  // for conversations until the app restarts.
  it('when the teardown after a resolved deletion throws', async () => {
    const t = makeTrace({
      teardown: () => { throw new Error('teardown failed') },
    })
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.resolve()

    await expect(pending).rejects.toThrow('teardown failed')
    expect(t.calls[t.calls.length - 1]).toBe('fence.end:7')
  })

  it('when the teardown after a rejected deletion throws, with the teardown error winning', async () => {
    const t = makeTrace({
      teardown: () => { throw new Error('teardown failed') },
    }, { recordIsGone: true })
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.reject(new Error('delete failed'))

    await expect(pending).rejects.toThrow('teardown failed')
    expect(t.calls[t.calls.length - 1]).toBe('fence.end:7')
  })

  // Fails if the fence were ended before the rejection handling finished.
  it('exactly once, after everything else, when the record survived a rejection', async () => {
    const t = makeTrace()
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.reject(new Error('early failure'))
    await expect(pending).rejects.toThrow('early failure')

    expect(t.calls.filter(c => c === 'fence.end:7')).toHaveLength(1)
    expect(t.calls[t.calls.length - 1]).toBe('fence.end:7')
  })

  it('exactly once on the happy path', async () => {
    const t = makeTrace()
    const pending = removeAccount(7, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.resolve()
    await pending

    expect(t.calls.filter(c => c === 'fence.end:7')).toHaveLength(1)
    expect(t.calls.filter(c => c === 'fence.begin:7')).toHaveLength(1)
  })

  it('does not touch the fence of another account', async () => {
    const t = makeTrace()
    const pending = removeAccount(3, t.deps)
    t.stopIdle.resolve()
    t.deleteAccount.resolve()
    await pending

    expect(t.calls.filter(c => c.startsWith('fence.')).every(c => c.endsWith(':3'))).toBe(true)
  })
})
