import { describe, it, expect } from 'vitest'
import {
  isKeychainUnavailableError,
  KEYCHAIN_UNAVAILABLE_RE,
  DBUS_SESSION_UNAVAILABLE_RE,
} from './keychainErrors'

// §2.33 (M3) — these tests pin the behaviour of the predicate now that it lives
// in @mailcopilot/core. They mirror the assertions that previously lived in
// electron/sentry.test.ts so the relocation is provably behaviour-preserving,
// and add coverage for the M1 "broad but not over-broad" regex design.

describe('§2.33 — isKeychainUnavailableError', () => {
  it('matches the reported D-Bus Secret Service incident (string)', () => {
    expect(isKeychainUnavailableError(
      'Error calling StartServiceByName for org.freedesktop.secrets: Timeout was reached',
    )).toBe(true)
  })

  it('matches libsecret / gnome-keyring / kwallet / Secret Service / macOS Keychain signatures', () => {
    expect(isKeychainUnavailableError(new Error('libsecret: backend unavailable'))).toBe(true)
    expect(isKeychainUnavailableError(new Error('gnome-keyring daemon not running'))).toBe(true)
    expect(isKeychainUnavailableError({ message: 'kwallet refused the connection' })).toBe(true)
    expect(isKeychainUnavailableError(new Error('Secret Service is not available'))).toBe(true)
    expect(isKeychainUnavailableError(new Error('SecretService backend missing'))).toBe(true)
    expect(isKeychainUnavailableError(new Error('SecKeychain access denied'))).toBe(true)
  })

  it('classifies via err.code as well as err.message', () => {
    expect(isKeychainUnavailableError({ code: 'libsecret' })).toBe(true)
  })

  it('walks a bounded err.cause chain for a wrapped keychain error', () => {
    const wrapped = new Error('failed to load account config') as Error & { cause?: unknown }
    wrapped.cause = new Error('org.freedesktop.secrets: Timeout was reached')
    expect(isKeychainUnavailableError(wrapped)).toBe(true)
  })

  it('finds a keychain error buried at cause depth 2 (within MAX_CAUSE_DEPTH limit)', () => {
    const keychainError = new Error('libsecret: daemon not available') as Error & { cause?: unknown }
    const mid = new Error('intermediate wrapper') as Error & { cause?: unknown }
    mid.cause = keychainError
    const outer = new Error('top-level error') as Error & { cause?: unknown }
    outer.cause = mid
    expect(isKeychainUnavailableError(outer)).toBe(true)
  })

  it('does not traverse a cause chain deeper than MAX_CAUSE_DEPTH=3 (depth-limit guard)', () => {
    // Build a 5-object chain l0→l1→l2→l3→deepErr.
    // extractKeychainText(l0,0) recurses: l1=depth1, l2=depth2, l3=depth3, deepErr=depth4.
    // depth4 > MAX_CAUSE_DEPTH(3) → returns '' without inspecting deepErr.message.
    const deepErr = new Error('org.freedesktop.secrets: buried beyond depth limit')
    const l3 = new Error('l3') as Error & { cause?: unknown }
    l3.cause = deepErr
    const l2 = new Error('l2') as Error & { cause?: unknown }
    l2.cause = l3
    const l1 = new Error('l1') as Error & { cause?: unknown }
    l1.cause = l2
    const l0 = new Error('l0') as Error & { cause?: unknown }
    l0.cause = l1
    expect(isKeychainUnavailableError(l0)).toBe(false)
  })

  it('does not blow up on a self-referential cause (cycle guard)', () => {
    const cyclic = new Error('boom') as Error & { cause?: unknown }
    cyclic.cause = cyclic
    expect(isKeychainUnavailableError(cyclic)).toBe(false)
  })

  it('M1: a bare D-Bus activation error for a DIFFERENT service is NOT classified', () => {
    // Only the org.freedesktop.secrets association may trip the predicate — an
    // activation timeout for some other D-Bus service must stay unclassified.
    expect(isKeychainUnavailableError('StartServiceByName for org.freedesktop.Notifications')).toBe(false)
    expect(isKeychainUnavailableError('Error calling StartServiceByName: Timeout was reached')).toBe(false)
  })

  it('does NOT match an ordinary transient network timeout (no false positive)', () => {
    expect(isKeychainUnavailableError('Error: net::ERR_TIMED_OUT')).toBe(false)
    expect(isKeychainUnavailableError('Socket timeout')).toBe(false)
    expect(isKeychainUnavailableError('ETIMEDOUT')).toBe(false)
  })

  it('returns false for null / undefined / non-error payloads', () => {
    expect(isKeychainUnavailableError(null)).toBe(false)
    expect(isKeychainUnavailableError(undefined)).toBe(false)
    expect(isKeychainUnavailableError(42)).toBe(false)
    expect(isKeychainUnavailableError({})).toBe(false)
  })

  it('exports the underlying regex (case-insensitive, cross-platform)', () => {
    expect(KEYCHAIN_UNAVAILABLE_RE.flags).toContain('i')
    expect(KEYCHAIN_UNAVAILABLE_RE.test('LIBSECRET')).toBe(true)
    expect(KEYCHAIN_UNAVAILABLE_RE.test('seckeychain')).toBe(true)
  })
})

// §2.33 (dbus-disabled) — repro-first coverage for the broadened classifier.
// The confirmed CI marker (pipeline 2293) was previously NOT matched, so
// secretStore.probeKeytar hard-failed and ai:saveApiKey threw on managed Linux
// without a session bus. These cases would fail before the DBUS_SESSION_
// UNAVAILABLE_RE addition and pass after it.
describe('§2.33 — D-Bus session-bus-unavailable class', () => {
  it('matches the confirmed CI transport-disabled marker (was hard-failing before)', () => {
    expect(isKeychainUnavailableError(
      "Unknown or unsupported transport 'disabled' for address 'disabled:'",
    )).toBe(true)
  })

  it('matches the other session-bus-unavailable markers', () => {
    expect(isKeychainUnavailableError(new Error('Cannot autolaunch D-Bus without a $DISPLAY'))).toBe(true)
    expect(isKeychainUnavailableError(new Error('Unable to autolaunch a dbus-daemon'))).toBe(true)
    expect(isKeychainUnavailableError({ message: 'org.freedesktop.DBus.Error.NoServer' })).toBe(true)
    expect(isKeychainUnavailableError(new Error('Failed to connect to the session bus'))).toBe(true)
    expect(isKeychainUnavailableError(new Error('Failed to connect to session bus'))).toBe(true)
    expect(isKeychainUnavailableError(new Error('Failed to connect to D-Bus session bus'))).toBe(true)
    expect(isKeychainUnavailableError(new Error('could not open the session bus socket'))).toBe(true)
  })

  it('classifies a wrapped transport-disabled error via the err.cause chain', () => {
    const wrapped = new Error('ai:saveApiKey failed') as Error & { cause?: unknown }
    wrapped.cause = new Error("Unknown or unsupported transport 'disabled' for address 'disabled:'")
    expect(isKeychainUnavailableError(wrapped)).toBe(true)
  })

  it('NEGATIVE: a StartServiceByName timeout for a NON-secrets service stays unclassified', () => {
    // Session-bus-WIDE unavailability is matched; per-SERVICE activation faults
    // for an unrelated service are NOT — see the specificity comment on the regex.
    expect(isKeychainUnavailableError(
      'Error calling StartServiceByName for org.freedesktop.Notifications: Timeout was reached',
    )).toBe(false)
  })

  it('NEGATIVE: plain network / arbitrary errors stay unclassified', () => {
    expect(isKeychainUnavailableError('Error: net::ERR_TIMED_OUT')).toBe(false)
    expect(isKeychainUnavailableError('ECONNREFUSED')).toBe(false)
    expect(isKeychainUnavailableError('something entirely unrelated happened')).toBe(false)
  })

  it('exports the D-Bus regex (case-insensitive)', () => {
    expect(DBUS_SESSION_UNAVAILABLE_RE.flags).toContain('i')
    expect(DBUS_SESSION_UNAVAILABLE_RE.test('UNKNOWN OR UNSUPPORTED TRANSPORT')).toBe(true)
  })
})
