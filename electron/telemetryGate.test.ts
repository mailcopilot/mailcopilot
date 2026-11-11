import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isTelemetryCollectionAllowed,
  setTelemetryCollectionAllowed,
  telemetryCollectionStartedAtMs,
  telemetryCollectionEpoch,
  registerTelemetryCollectionResetHook,
  __resetTelemetryGateForTest,
  __clearTelemetryResetHooksForTest,
} from './telemetryGate'

/**
 * §2.82 iter2 finding 2 — the consent decision governs COLLECTION, not just
 * transmission. This suite pins the three properties the rest of the telemetry
 * pipeline depends on: fail-closed default, reset on every transition, and a
 * session clock that starts at the moment of consent.
 */
describe('telemetryGate', () => {
  beforeEach(() => {
    __clearTelemetryResetHooksForTest()
    __resetTelemetryGateForTest()
  })
  afterEach(() => {
    __clearTelemetryResetHooksForTest()
    __resetTelemetryGateForTest()
    vi.useRealTimers()
  })

  it('is fail-closed before anyone applies a verdict', () => {
    // A fresh process has not read settings yet. "Unknown" must mean silent —
    // the same policy sentryPreflight.ts applies to the SDK's enabled flag.
    expect(isTelemetryCollectionAllowed()).toBe(false)
  })

  it('runs every reset hook on off→on', () => {
    const a = vi.fn()
    const b = vi.fn()
    registerTelemetryCollectionResetHook(a)
    registerTelemetryCollectionResetHook(b)

    setTelemetryCollectionAllowed(true)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(isTelemetryCollectionAllowed()).toBe(true)
  })

  it('runs every reset hook on on→off as well', () => {
    const hook = vi.fn()
    registerTelemetryCollectionResetHook(hook)
    setTelemetryCollectionAllowed(true)
    hook.mockClear()

    // Withdrawal must not leave a buffer behind for a later re-opt-in to flush.
    setTelemetryCollectionAllowed(false)

    expect(hook).toHaveBeenCalledTimes(1)
    expect(isTelemetryCollectionAllowed()).toBe(false)
  })

  it('is a no-op when the verdict is unchanged', () => {
    // The boot path applies the same answer twice (preflight, then the
    // settings load). A repeated "still allowed" must not reset the clock or
    // drop live buffers.
    const hook = vi.fn()
    registerTelemetryCollectionResetHook(hook)
    setTelemetryCollectionAllowed(true)
    hook.mockClear()
    const origin = telemetryCollectionStartedAtMs()

    setTelemetryCollectionAllowed(true)

    expect(hook).not.toHaveBeenCalled()
    expect(telemetryCollectionStartedAtMs()).toBe(origin)
  })

  it('re-origins the session clock at the moment of consent', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T10:00:00.000Z'))
    __resetTelemetryGateForTest()
    // The user works for an hour with telemetry off...
    vi.setSystemTime(new Date('2026-07-27T11:00:00.000Z'))

    setTelemetryCollectionAllowed(true)

    // ...and app.session_ended must describe the consented period only.
    expect(telemetryCollectionStartedAtMs()).toBe(Date.parse('2026-07-27T11:00:00.000Z'))
    vi.setSystemTime(new Date('2026-07-27T11:30:00.000Z'))
    expect(Date.now() - telemetryCollectionStartedAtMs()).toBe(30 * 60_000)
  })

  it('a throwing hook cannot break the transition', () => {
    const good = vi.fn()
    registerTelemetryCollectionResetHook(() => { throw new Error('hook broken') })
    registerTelemetryCollectionResetHook(good)

    expect(() => { setTelemetryCollectionAllowed(true) }).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    expect(isTelemetryCollectionAllowed()).toBe(true)
  })
})

/**
 * The epoch is the monotonic identity of "the consent window we are in". Work that accumulates over time compares
 * epochs instead of clock readings, because the wall clock can step backwards.
 */
describe('telemetryCollectionEpoch', () => {
  beforeEach(() => {
    __clearTelemetryResetHooksForTest()
    __resetTelemetryGateForTest()
  })
  afterEach(() => {
    __clearTelemetryResetHooksForTest()
    __resetTelemetryGateForTest()
    vi.useRealTimers()
  })

  it('is a non-negative integer', () => {
    const epoch = telemetryCollectionEpoch()

    expect(Number.isInteger(epoch)).toBe(true)
    expect(epoch).toBeGreaterThanOrEqual(0)
  })

  it('increases by exactly one on an off to on transition', () => {
    const before = telemetryCollectionEpoch()

    setTelemetryCollectionAllowed(true)

    expect(telemetryCollectionEpoch()).toBe(before + 1)
  })

  it('increases by exactly one on an on to off transition', () => {
    setTelemetryCollectionAllowed(true)
    const before = telemetryCollectionEpoch()

    setTelemetryCollectionAllowed(false)

    expect(telemetryCollectionEpoch()).toBe(before + 1)
  })

  it('counts every transition of a sequence, one each', () => {
    const start = telemetryCollectionEpoch()

    setTelemetryCollectionAllowed(true)
    setTelemetryCollectionAllowed(false)
    setTelemetryCollectionAllowed(true)

    expect(telemetryCollectionEpoch()).toBe(start + 3)
  })

  it('does not change when the same value is set again, in either state', () => {
    const closed = telemetryCollectionEpoch()
    setTelemetryCollectionAllowed(false)
    expect(telemetryCollectionEpoch()).toBe(closed)

    setTelemetryCollectionAllowed(true)
    const open = telemetryCollectionEpoch()
    setTelemetryCollectionAllowed(true)
    setTelemetryCollectionAllowed(true)

    expect(open).toBe(closed + 1)
    expect(telemetryCollectionEpoch()).toBe(open)
  })

  it('is not reset by the test reset, so an epoch recorded earlier can never be matched again', () => {
    setTelemetryCollectionAllowed(true)
    const recorded = telemetryCollectionEpoch()

    __resetTelemetryGateForTest()

    expect(isTelemetryCollectionAllowed()).toBe(false)
    expect(telemetryCollectionEpoch()).toBe(recorded)
  })

  it('does not depend on the system clock, including a step backward', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T10:00:00.000Z'))
    const start = telemetryCollectionEpoch()

    setTelemetryCollectionAllowed(true)
    vi.setSystemTime(new Date('2026-07-27T09:00:00.000Z')) // one hour BACK
    setTelemetryCollectionAllowed(false)
    vi.setSystemTime(new Date('2026-07-27T09:00:00.000Z')) // frozen: the same reading
    setTelemetryCollectionAllowed(true)

    expect(telemetryCollectionEpoch()).toBe(start + 3)
  })

  it('does not change when only the clock moves', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T10:00:00.000Z'))
    setTelemetryCollectionAllowed(true)
    const epoch = telemetryCollectionEpoch()

    vi.setSystemTime(new Date('2026-07-27T08:00:00.000Z'))
    vi.setSystemTime(new Date('2026-07-27T12:00:00.000Z'))

    expect(telemetryCollectionEpoch()).toBe(epoch)
  })
})
