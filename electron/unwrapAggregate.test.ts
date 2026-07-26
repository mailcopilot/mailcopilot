import { describe, expect, it } from 'vitest'
import { unwrapAggregate } from './unwrapAggregate'

/**
 * Unit tests for the §2.14 AggregateError unwrapper. On Node, when a
 * connect() attempts multiple IPv4/IPv6 addresses, failures bubble up as
 * AggregateError — whose own `.message` is the literal string
 * "All promises were rejected", not the underlying network error. Before
 * §2.14, IPC callers saw that unhelpful string in toasts; the unwrapper
 * pulls out the first real inner Error so the user sees
 * "connect ETIMEDOUT 77.88.21.125:993" instead.
 *
 * The helper is intentionally duck-typed (`err.errors` is an array) to
 * cover both the real global AggregateError and library-synthesized
 * AggregateError-shaped objects.
 */
describe('unwrapAggregate', () => {
  it('returns the original Error unchanged when it is not aggregate-shaped', () => {
    const err = new Error('AUTHENTICATIONFAILED')
    expect(unwrapAggregate(err)).toBe(err)
  })

  it('returns null/undefined unchanged', () => {
    expect(unwrapAggregate(null)).toBeNull()
    expect(unwrapAggregate(undefined)).toBeUndefined()
  })

  it('returns a plain object unchanged when it has no errors field', () => {
    const notAgg = { message: 'boom', code: 'X' }
    expect(unwrapAggregate(notAgg)).toBe(notAgg)
  })

  it('returns the original value when errors is not an array', () => {
    const notAgg = { errors: 'not-an-array' }
    expect(unwrapAggregate(notAgg)).toBe(notAgg)
  })

  it('returns the original value when errors is an empty array', () => {
    const emptyAgg = { errors: [] as Error[] }
    expect(unwrapAggregate(emptyAgg)).toBe(emptyAgg)
  })

  it('unwraps a duck-typed single-inner AggregateError', () => {
    const inner = new Error('connect ETIMEDOUT 77.88.21.125:993')
    const agg = { errors: [inner] }
    expect(unwrapAggregate(agg)).toBe(inner)
  })

  it('unwraps a real Node AggregateError to its first inner error', () => {
    const inner = new Error('connect ETIMEDOUT 1.2.3.4:993')
    const agg = new (globalThis as unknown as { AggregateError: new (errors: readonly unknown[], message?: string) => Error & { errors: unknown[] } }).AggregateError([inner], 'All promises were rejected')
    expect(unwrapAggregate(agg)).toBe(inner)
  })

  it('returns the first Error with a non-empty message when multiple inners are present', () => {
    // find() prefers the first Error-with-message; if the very first inner is
    // an Error with a blank message the helper skips to the next one. This is
    // the exact branch that distinguishes "sees blank toast" from "sees real
    // network error" in the field.
    const blank = new Error('')
    const real = new Error('connect ENETUNREACH 2606:4700::1:993')
    const agg = new (globalThis as unknown as { AggregateError: new (errors: readonly unknown[], message?: string) => Error & { errors: unknown[] } }).AggregateError([blank, real])
    expect(unwrapAggregate(agg)).toBe(real)
  })

  it('falls back to the first inner when none are Error instances with messages', () => {
    // Defensive fallback — if the library hands us a bag of non-Error shapes
    // (e.g. plain strings or objects), we still return the first element
    // rather than dropping information silently.
    const fallback = 'string-inner-error'
    const agg = { errors: [fallback, 'second'] }
    expect(unwrapAggregate(agg)).toBe(fallback)
  })

  it('returns an Error whose message the renderer can show in a toast', () => {
    // Round-trip guard for the user-visible behavior: after unwrap, the
    // caller throws the returned value, and ipc.ts serializes `.message` to
    // the renderer. An unwrapped real Error must retain its message.
    const inner = new Error('connect ETIMEDOUT 77.88.21.125:993')
    const agg = new (globalThis as unknown as { AggregateError: new (errors: readonly unknown[], message?: string) => Error & { errors: unknown[] } }).AggregateError([inner])
    const out = unwrapAggregate(agg)
    expect(out).toBeInstanceOf(Error)
    expect((out as Error).message).toBe('connect ETIMEDOUT 77.88.21.125:993')
  })
})
