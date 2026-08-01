import { describe, it, expect, vi } from 'vitest'

// Only the last describe block imports `packages/net/config` (for the AC9
// renderer-writability guard). That module transitively pulls better-sqlite3,
// keytar and electron-store, so stub them the same way
// packages/net/config.test.ts does. The consent logic itself is pure and needs
// none of this.
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(() => Promise.resolve(null)),
    setPassword: vi.fn(() => Promise.resolve()),
    deletePassword: vi.fn(() => Promise.resolve(true)),
  },
}))
vi.mock('electron-store', () => ({
  default: class MockStore {
    get() { return undefined }
    set() {}
    delete() {}
  },
}))
vi.mock('../packages/db', () => ({ deleteAccountData: vi.fn() }))
import {
  TELEMETRY_CONSENT_VERSION,
  applyAboutToggle,
  applyAboutToggleFromOrigin,
  clampTelemetryForRenderer,
  evaluateConsent,
  isTelemetryAllowed,
  makeConsentRecord,
  syncConsentWithToggle,
} from './telemetryConsent'

const AT = '2026-07-27T10:00:00.000Z'

describe('evaluateConsent', () => {
  it('returns "needed" when there is no record (fresh install)', () => {
    expect(evaluateConsent({})).toBe('needed')
    expect(evaluateConsent(undefined)).toBe('needed')
    expect(evaluateConsent(null)).toBe('needed')
  })

  it('returns "needed" when sentryEnabled is true but no consent was ever recorded', () => {
    // The pre-§2.82 default. A legacy "enabled" flag is NOT consent: it was
    // never asked for (ePrivacy art. 5(3) / Planet49).
    expect(evaluateConsent({ sentryEnabled: true })).toBe('needed')
  })

  // AC6 — three cases.
  it('AC6: an "allow" at the current composition version is honored (no re-ask)', () => {
    expect(evaluateConsent({ telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION, at: AT } }))
      .toBe('granted')
  })

  it('AC6: a decision from an older composition version triggers one re-ask', () => {
    expect(evaluateConsent({ telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION - 1, at: AT } }))
      .toBe('needed')
    expect(evaluateConsent({ telemetryConsent: { granted: false, version: TELEMETRY_CONSENT_VERSION - 1, at: AT } }))
      .toBe('needed')
  })

  it('AC6: a refusal at the current version is final — never asked again', () => {
    expect(evaluateConsent({ telemetryConsent: { granted: false, version: TELEMETRY_CONSENT_VERSION, at: AT } }))
      .toBe('denied')
  })

  it('honors a decision recorded by a newer build (downgrade path)', () => {
    expect(evaluateConsent({ telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION + 1, at: AT } }))
      .toBe('granted')
  })

  it('fails closed on a malformed record', () => {
    const bad: unknown[] = [
      'granted',
      42,
      { granted: 'yes', version: TELEMETRY_CONSENT_VERSION, at: AT },
      { granted: true, version: '1', at: AT },
      { granted: true, version: 1.5, at: AT },
      { granted: true, version: TELEMETRY_CONSENT_VERSION },
      { granted: true, version: TELEMETRY_CONSENT_VERSION, at: '' },
      { version: TELEMETRY_CONSENT_VERSION, at: AT },
    ]
    for (const telemetryConsent of bad) {
      expect(evaluateConsent({ telemetryConsent })).toBe('needed')
    }
  })
})

describe('isTelemetryAllowed', () => {
  it('is true only for a granted record with the About switch not off', () => {
    expect(isTelemetryAllowed({ telemetryConsent: makeConsentRecord(true, AT) })).toBe(true)
    expect(isTelemetryAllowed({ telemetryConsent: makeConsentRecord(true, AT), sentryEnabled: true })).toBe(true)
  })

  it('is false when the About switch is off even if consent was granted', () => {
    expect(isTelemetryAllowed({ telemetryConsent: makeConsentRecord(true, AT), sentryEnabled: false })).toBe(false)
  })

  it('is false without a consent record even when sentryEnabled is true', () => {
    expect(isTelemetryAllowed({ sentryEnabled: true })).toBe(false)
    expect(isTelemetryAllowed({})).toBe(false)
    expect(isTelemetryAllowed(undefined)).toBe(false)
  })

  it('is false for a refusal', () => {
    expect(isTelemetryAllowed({ telemetryConsent: makeConsentRecord(false, AT), sentryEnabled: true })).toBe(false)
  })

  // AC (e) full chain — evaluateConsent honors a downgrade (version > CURRENT)
  // as 'granted'; this pins that the composed gate agrees end-to-end, not just
  // the classifier in isolation.
  it('AC6: honors a downgrade — a grant recorded by a newer build stays allowed', () => {
    expect(isTelemetryAllowed({
      telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION + 1, at: AT },
    })).toBe(true)
  })

  it('AC6: honors a downgrade — a refusal recorded by a newer build stays refused', () => {
    expect(isTelemetryAllowed({
      telemetryConsent: { granted: false, version: TELEMETRY_CONSENT_VERSION + 1, at: AT },
      sentryEnabled: true,
    })).toBe(false)
  })
})

describe('makeConsentRecord', () => {
  it('stamps the current composition version', () => {
    expect(makeConsentRecord(true, AT)).toEqual({ granted: true, version: TELEMETRY_CONSENT_VERSION, at: AT })
  })
})

describe('syncConsentWithToggle', () => {
  const NOW = '2026-07-28T00:00:00.000Z'

  it('never creates a record when none exists (a save must not manufacture consent)', () => {
    expect(syncConsentWithToggle(undefined, true, NOW)).toBeUndefined()
    expect(syncConsentWithToggle(null, true, NOW)).toBeUndefined()
  })

  it('flips granted and restamps `at` when the toggle changes', () => {
    const existing = makeConsentRecord(true, AT)
    expect(syncConsentWithToggle(existing, false, NOW)).toEqual({
      granted: false,
      version: TELEMETRY_CONSENT_VERSION,
      at: NOW,
    })
  })

  it('returns the record unchanged when the toggle agrees with it', () => {
    const existing = makeConsentRecord(true, AT)
    expect(syncConsentWithToggle(existing, true, NOW)).toEqual(existing)
  })

  it('keeps the stored version so a pending re-ask is not suppressed', () => {
    const stale = { granted: false, version: TELEMETRY_CONSENT_VERSION - 1, at: AT }
    const next = syncConsentWithToggle(stale, true, NOW)
    expect(next).toEqual({ granted: true, version: TELEMETRY_CONSENT_VERSION - 1, at: NOW })
    // Still "needed" — the user has not seen the current disclosure.
    expect(evaluateConsent({ telemetryConsent: next })).toBe('needed')
  })

  it('leaves a malformed record untouched (the screen will overwrite it)', () => {
    const junk = { granted: 'maybe' }
    expect(syncConsentWithToggle(junk, true, NOW)).toBe(junk)
  })

  it('AC6: keeps a newer-build version (downgrade) intact across a toggle flip', () => {
    const fromNewerBuild = { granted: true, version: TELEMETRY_CONSENT_VERSION + 1, at: AT }
    const next = syncConsentWithToggle(fromNewerBuild, false, NOW)
    expect(next).toEqual({ granted: false, version: TELEMETRY_CONSENT_VERSION + 1, at: NOW })
    // Still honored as a valid decision — the disclosure it covers is at least
    // as wide as what this build collects.
    expect(evaluateConsent({ telemetryConsent: next })).toBe('denied')
  })
})

// AC8 — what `settings:save` persists when the About switch moves.
describe('applyAboutToggle', () => {
  const NOW = '2026-07-28T00:00:00.000Z'

  it('turning the switch off withdraws consent and disables sending', () => {
    expect(applyAboutToggle(makeConsentRecord(true, AT), false, NOW)).toEqual({
      telemetryConsent: { granted: false, version: TELEMETRY_CONSENT_VERSION, at: NOW },
      sentryEnabled: false,
    })
  })

  it('turning it back on re-grants consent and re-enables sending', () => {
    expect(applyAboutToggle(makeConsentRecord(false, AT), true, NOW)).toEqual({
      telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION, at: NOW },
      sentryEnabled: true,
    })
  })

  // While the verdict is `needed` no record is created in either direction —
  // that is the invariant these three cover. The persisted flag is preserved
  // rather than clamped (see the §2.82 iter2 finding-3 block below); what makes
  // "cannot switch sending on" true is `isTelemetryAllowed`, which requires a
  // granted record and is asserted separately.
  it('cannot manufacture consent while none is on record', () => {
    expect(applyAboutToggle(undefined, true, NOW).telemetryConsent).toBeUndefined()
    expect(isTelemetryAllowed(applyAboutToggle(undefined, true, NOW))).toBe(false)
  })

  it('cannot switch sending on while a re-ask for a newer disclosure is pending', () => {
    const stale = { granted: true, version: TELEMETRY_CONSENT_VERSION - 1, at: AT }
    const out = applyAboutToggle(stale, true, NOW)
    expect(out.telemetryConsent).toEqual(stale)
    expect(isTelemetryAllowed({ ...out })).toBe(false)
  })

  it('cannot switch sending on from a malformed record', () => {
    const out = applyAboutToggle({ granted: 'maybe' }, true, NOW)
    expect(isTelemetryAllowed({ ...out })).toBe(false)
  })

  it('keeps a granted record and an on switch as-is', () => {
    const granted = makeConsentRecord(true, AT)
    expect(applyAboutToggle(granted, true, NOW)).toEqual({ telemetryConsent: granted, sentryEnabled: true })
  })

  // §2.82 iter2 finding 1, round-trip half. Main now publishes a CLAMPED
  // `sentryEnabled` (false while an answer is pending), and the renderer echoes
  // whatever it was given back on the next unrelated settings:save. Recording
  // that echo as a withdrawal would fabricate a refusal the user never made —
  // and would do it precisely to users mid-re-ask, whose switch is disabled.
  it('does not turn main\'s own clamp into a refusal while a re-ask is pending', () => {
    const stale = { granted: true, version: TELEMETRY_CONSENT_VERSION - 1, at: AT }
    expect(applyAboutToggle(stale, false, NOW, undefined)).toEqual({
      telemetryConsent: stale,
      sentryEnabled: true,
    })
  })

  it('does not record anything when there is no record yet and the clamp comes back', () => {
    expect(applyAboutToggle(undefined, false, NOW, undefined)).toEqual({
      telemetryConsent: undefined,
      sentryEnabled: true,
    })
  })

  it('preserves a malformed record verbatim instead of overwriting it', () => {
    const malformed = { granted: 'maybe' }
    expect(applyAboutToggle(malformed, false, NOW, undefined)).toEqual({
      telemetryConsent: malformed,
      sentryEnabled: true,
    })
  })

  // §2.82 iter2 finding 3 — the regression this branch exists to stop.
  //
  // `settings:save` persists the whole settings object, so before the fix a
  // save made for an UNRELATED reason (language, theme) while the consent
  // answer was pending wrote `sentryEnabled: false` to disk. On the next start
  // `migrateTelemetryConsent` reads exactly that value as proof of a legacy
  // opt-out and seeds a permanent refusal — so the user is never asked, having
  // never been asked. The fix is to preserve, not clamp.
  describe('the pending branch preserves the persisted flag instead of writing a decision', () => {
    it('leaves an absent flag as a non-refusal', () => {
      // `true` is not "on" — with no record `isTelemetryAllowed` is still false.
      // It only has to be distinguishable from the migration's refusal marker.
      const out = applyAboutToggle(undefined, false, NOW, undefined)
      expect(out.sentryEnabled).toBe(true)
      expect(isTelemetryAllowed({ ...out })).toBe(false)
    })

    it('leaves an existing genuine opt-out untouched', () => {
      expect(applyAboutToggle(undefined, false, NOW, false).sentryEnabled).toBe(false)
    })

    it('does not depend on the schema default: a non-boolean persisted value is not a refusal', () => {
      expect(applyAboutToggle(undefined, true, NOW, 'yes').sentryEnabled).toBe(true)
      expect(applyAboutToggle(undefined, true, NOW, null).sentryEnabled).toBe(true)
    })

    it('ignores what the renderer asked for — neither direction is an answer', () => {
      expect(applyAboutToggle(undefined, true, NOW, false).sentryEnabled).toBe(false)
      expect(applyAboutToggle(undefined, false, NOW, true).sentryEnabled).toBe(true)
    })
  })
})

// §2.82 iter2 finding 1 — src/App.tsx turns the renderer's own Sentry client on
// from `sentryEnabled` alone, on both settings:get and settings:changed. On a
// clean profile there is no consent record while the schema still defaults the
// field to `true`, so publishing the raw value is publishing a pre-ticked box.
// §2.82 iter4 (security finding 1) — `settings:save` is reachable from EVERY
// window and long after the consent question is closed, so before this gate a
// `sentryEnabled: true` from Compose (or any compromised WebContents) turned a
// recorded refusal back into consent. The rule is asymmetric on purpose: only
// the settings window can turn telemetry ON; anyone can turn it OFF.
describe('applyAboutToggleFromOrigin', () => {
  const NOW = '2026-07-29T00:00:00.000Z'
  const denied = { telemetryConsent: makeConsentRecord(false, AT), sentryEnabled: false }
  const granted = { telemetryConsent: makeConsentRecord(true, AT), sentryEnabled: true }

  describe('enabling', () => {
    it('is REJECTED from a non-settings window and leaves the refusal on record', () => {
      const out = applyAboutToggleFromOrigin(denied, true, NOW, false, 'other-window')
      expect(out.telemetryConsent).toEqual(makeConsentRecord(false, AT))
      expect(out.sentryEnabled).toBe(false)
      expect(isTelemetryAllowed({ ...denied, ...out })).toBe(false)
    })

    it('is ACCEPTED from the settings window', () => {
      const out = applyAboutToggleFromOrigin(denied, true, NOW, false, 'settings-window')
      expect(out.telemetryConsent).toEqual({ granted: true, version: TELEMETRY_CONSENT_VERSION, at: NOW })
      expect(out.sentryEnabled).toBe(true)
      expect(isTelemetryAllowed({ ...denied, ...out })).toBe(true)
    })

    it('cannot re-enable from another window after a withdrawal made in Settings', () => {
      // granted → user turns it off in Settings → a rogue window says "true".
      const afterWithdrawal = applyAboutToggleFromOrigin(granted, false, NOW, true, 'settings-window')
      const state = { ...granted, ...afterWithdrawal }
      expect(isTelemetryAllowed(state)).toBe(false)

      const attempt = applyAboutToggleFromOrigin(state, true, NOW, false, 'other-window')
      expect(isTelemetryAllowed({ ...state, ...attempt })).toBe(false)
      expect(attempt.telemetryConsent).toEqual(afterWithdrawal.telemetryConsent)
    })

    it('a rejected enable does not rewrite a granted record into a withdrawal', () => {
      // granted record + switch off on disk: substituting `false` instead of
      // preserving would be read as a fresh withdrawal and downgrade the record.
      const halfOff = { telemetryConsent: makeConsentRecord(true, AT), sentryEnabled: false }
      const out = applyAboutToggleFromOrigin(halfOff, true, NOW, false, 'other-window')
      expect(out.telemetryConsent).toEqual(makeConsentRecord(true, AT))
      expect(out.sentryEnabled).toBe(false)
    })

    it('cannot manufacture consent even from the settings window while none is on record', () => {
      const out = applyAboutToggleFromOrigin({}, true, NOW, undefined, 'settings-window')
      expect(out.telemetryConsent).toBeUndefined()
      expect(isTelemetryAllowed({ ...out })).toBe(false)
    })

    it('an echo of `true` while telemetry is already on is not an enable attempt', () => {
      const out = applyAboutToggleFromOrigin(granted, true, NOW, true, 'other-window')
      expect(out).toEqual(applyAboutToggle(granted.telemetryConsent, true, NOW, true))
      expect(isTelemetryAllowed({ ...granted, ...out })).toBe(true)
    })
  })

  describe('disabling — GDPR art. 7(3): never harder than consenting', () => {
    it('is accepted from ANY window', () => {
      for (const origin of ['settings-window', 'other-window'] as const) {
        const out = applyAboutToggleFromOrigin(granted, false, NOW, true, origin)
        expect(out.telemetryConsent).toEqual({ granted: false, version: TELEMETRY_CONSENT_VERSION, at: NOW })
        expect(out.sentryEnabled).toBe(false)
        expect(isTelemetryAllowed({ ...granted, ...out })).toBe(false)
      }
    })

    it('produces exactly what the ungated helper would, from any window', () => {
      for (const origin of ['settings-window', 'other-window'] as const) {
        expect(applyAboutToggleFromOrigin(granted, false, NOW, true, origin))
          .toEqual(applyAboutToggle(granted.telemetryConsent, false, NOW, true))
      }
    })
  })
})

describe('clampTelemetryForRenderer', () => {
  it('publishes false when no answer is on record, whatever the raw field says', () => {
    expect(clampTelemetryForRenderer({ sentryEnabled: true }).sentryEnabled).toBe(false)
    // A record with the field genuinely absent — the fresh-profile shape.
    const freshProfile: { theme: string; sentryEnabled?: boolean } = { theme: 'dark' }
    expect(clampTelemetryForRenderer(freshProfile).sentryEnabled).toBe(false)
  })

  it('publishes false for a refusal and for a stale disclosure version', () => {
    expect(clampTelemetryForRenderer({
      sentryEnabled: true,
      telemetryConsent: makeConsentRecord(false, AT),
    }).sentryEnabled).toBe(false)
    expect(clampTelemetryForRenderer({
      sentryEnabled: true,
      telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION - 1, at: AT },
    }).sentryEnabled).toBe(false)
  })

  it('publishes true only when consent is on record and the switch is on', () => {
    expect(clampTelemetryForRenderer({
      sentryEnabled: true,
      telemetryConsent: makeConsentRecord(true, AT),
    }).sentryEnabled).toBe(true)
    expect(clampTelemetryForRenderer({
      sentryEnabled: false,
      telemetryConsent: makeConsentRecord(true, AT),
    }).sentryEnabled).toBe(false)
  })

  it('leaves every other field untouched and does not mutate the input', () => {
    const input = { theme: 'dark', sentryEnabled: true, debugLogging: true }
    const out = clampTelemetryForRenderer(input)
    expect(out).toEqual({ theme: 'dark', sentryEnabled: false, debugLogging: true })
    expect(input.sentryEnabled).toBe(true)
  })
})

// AC9 — the consent record is main-only. Modelled on the `stdioApproved` guard
// in packages/net/config.test.ts, but with a WELL-FORMED payload: the generic
// MAIN_ONLY_SETTINGS_FIELDS loop over there feeds every field the string
// 'whatever', which a shape-checking schema would reject for the wrong reason.
describe('telemetryConsent is not renderer-writable', () => {
  it('settings:save rejects a well-formed telemetryConsent payload', async () => {
    const { rendererWritableSettingsSchema, MAIN_ONLY_SETTINGS_FIELDS } = await import('../packages/net/config')

    const result = rendererWritableSettingsSchema.safeParse({
      theme: 'dark',
      telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION, at: AT },
    })

    expect(result.success).toBe(false)
    // The rejection must be the `unrecognized_keys` one — that is the issue code
    // electron/main.ts turns into `{ ok: false, reason: 'forbidden_field' }`.
    const forbidden = result.success ? [] : result.error.issues
      .filter(issue => issue.code === 'unrecognized_keys')
      .flatMap(issue => (issue as { keys?: string[] }).keys ?? [])
    expect(forbidden).toContain('telemetryConsent')
    expect(MAIN_ONLY_SETTINGS_FIELDS).toContain('telemetryConsent')
  })
})
