import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isTelemetryCollectionAllowed,
  setTelemetryCollectionAllowed,
  telemetryCollectionStartedAtMs,
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
