import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Settings } from '../../packages/net/config'
import { TELEMETRY_CONSENT_VERSION } from '../telemetryConsent'

// The service reaches for electron, the settings store, the metrics pipeline
// and the Sentry SDK at import time. All four are replaced here so the unit
// suite stays free of native bindings; the behaviour under test is injected
// through the deps seam.
const {
  handleIpcMock, recordEventMock, captureExceptionMock, setSentryUserEnabledMock, setSentryUserIdMock, logMock,
} = vi.hoisted(() => ({
  handleIpcMock: vi.fn(),
  recordEventMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  setSentryUserEnabledMock: vi.fn(),
  setSentryUserIdMock: vi.fn(),
  // Captured so the log-hygiene test can assert that nothing from settings, the
  // payload or the sender reaches any line (CLAUDE.md §8), and so the one
  // exceptional-outcome warning still has an assertion. The §2.236 diagnostics
  // whose log lines used to BE the deliverable are gone — see
  // getTelemetryConsentState in the module under test.
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('../logger', () => ({ createLogger: () => logMock }))
vi.mock('../ipc', () => ({ handleIpc: handleIpcMock }))
vi.mock('../metrics', () => ({ recordEvent: recordEventMock }))
vi.mock('../sentry', () => ({
  captureException: captureExceptionMock,
  setSentryUserEnabled: setSentryUserEnabledMock,
  setSentryUserId: setSentryUserIdMock,
}))
vi.mock('../installId', () => ({ getInstallIdHash: () => 'deadbeefdeadbeef' }))
vi.mock('../../packages/net/config', () => ({
  getSettings: vi.fn(() => ({}) as Settings),
  saveSettings: vi.fn(),
  getRawPersistedSettings: vi.fn(() => undefined),
}))

const NOW = '2026-07-27T12:00:00.000Z'

function makeDeps(settings: Partial<Settings> = {}) {
  const store = { ...settings } as Settings
  const saveSettings = vi.fn((s: Settings) => { Object.assign(store, s) })
  return {
    store,
    saveSettings,
    deps: {
      getSettings: () => ({ ...store }) as Settings,
      saveSettings,
      applyTelemetryEnabled: vi.fn(),
      isPackaged: () => false,
      now: () => NOW,
      broadcastSettings: vi.fn(),
      // The tests that care about the sender gate override this explicitly.
      isMainWindowSender: vi.fn(() => true),
      // Default seam: the fixture store IS the raw record (no schema defaults
      // applied), so absent stays absent.
      readPersistedSentryEnabled: () => (store as Record<string, unknown>).sentryEnabled,
    },
  }
}

describe('telemetryConsentService', () => {
  const ORIG_E2E = process.env.MAILCOPILOT_E2E
  const ORIG_E2E_CONSENT = process.env.MAILCOPILOT_E2E_CONSENT

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.MAILCOPILOT_E2E
    delete process.env.MAILCOPILOT_E2E_CONSENT
  })

  afterEach(() => {
    if (ORIG_E2E === undefined) delete process.env.MAILCOPILOT_E2E
    else process.env.MAILCOPILOT_E2E = ORIG_E2E
    if (ORIG_E2E_CONSENT === undefined) delete process.env.MAILCOPILOT_E2E_CONSENT
    else process.env.MAILCOPILOT_E2E_CONSENT = ORIG_E2E_CONSENT
  })

  describe('getTelemetryConsentState', () => {
    it('asks on a fresh install', async () => {
      const { getTelemetryConsentState } = await import('./telemetryConsentService')
      const { deps } = makeDeps({})
      expect(getTelemetryConsentState(deps)).toEqual({ needed: true, version: TELEMETRY_CONSENT_VERSION })
    })

    it('does not ask once an answer for the current version exists', async () => {
      const { getTelemetryConsentState } = await import('./telemetryConsentService')
      for (const granted of [true, false]) {
        const { deps } = makeDeps({ telemetryConsent: { granted, version: TELEMETRY_CONSENT_VERSION, at: NOW } })
        expect(getTelemetryConsentState(deps).needed).toBe(false)
      }
    })

    it('asks again after a disclosure-version bump', async () => {
      const { getTelemetryConsentState } = await import('./telemetryConsentService')
      const { deps } = makeDeps({
        telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION - 1, at: NOW },
      })
      expect(getTelemetryConsentState(deps).needed).toBe(true)
    })

    // AC6/AC (e) — a decision recorded by a NEWER build (app downgrade) covers
    // at least the current disclosure, so it must not trigger a re-ask either.
    it('does not ask again after a downgrade to an older build', async () => {
      const { getTelemetryConsentState } = await import('./telemetryConsentService')
      for (const granted of [true, false]) {
        const { deps } = makeDeps({
          telemetryConsent: { granted, version: TELEMETRY_CONSENT_VERSION + 1, at: NOW },
        })
        expect(getTelemetryConsentState(deps).needed).toBe(false)
      }
    })

    it('asks when settings cannot be read', async () => {
      const { getTelemetryConsentState } = await import('./telemetryConsentService')
      const { deps } = makeDeps({})
      const state = getTelemetryConsentState({
        ...deps,
        getSettings: () => { throw new Error('store unavailable') },
      })
      expect(state.needed).toBe(true)
    })

    it('skips the gate for the e2e harness on an unpackaged build', async () => {
      const { getTelemetryConsentState } = await import('./telemetryConsentService')
      process.env.MAILCOPILOT_E2E = '1'
      const { deps } = makeDeps({})
      expect(getTelemetryConsentState(deps).needed).toBe(false)
    })

    it('AC13: ignores MAILCOPILOT_E2E in a packaged build', async () => {
      const { getTelemetryConsentState } = await import('./telemetryConsentService')
      process.env.MAILCOPILOT_E2E = '1'
      const { deps } = makeDeps({})
      expect(getTelemetryConsentState({ ...deps, isPackaged: () => true }).needed).toBe(true)
    })

    it('MAILCOPILOT_E2E_CONSENT=1 opts a spec back into the real gate', async () => {
      const { getTelemetryConsentState } = await import('./telemetryConsentService')
      process.env.MAILCOPILOT_E2E = '1'
      process.env.MAILCOPILOT_E2E_CONSENT = '1'
      const { deps } = makeDeps({})
      expect(getTelemetryConsentState(deps).needed).toBe(true)
    })
  })

  describe('applyTelemetryConsent', () => {
    it('stamps version and timestamp itself and enables telemetry on a grant', async () => {
      const { applyTelemetryConsent } = await import('./telemetryConsentService')
      const { deps, saveSettings } = makeDeps({})

      expect(applyTelemetryConsent({ granted: true }, deps)).toEqual({ ok: true, granted: true })

      const saved = saveSettings.mock.calls[0][0]
      expect(saved.telemetryConsent).toEqual({ granted: true, version: TELEMETRY_CONSENT_VERSION, at: NOW })
      expect(saved.sentryEnabled).toBe(true)
      expect(deps.applyTelemetryEnabled).toHaveBeenCalledWith(true)
      expect(deps.broadcastSettings).toHaveBeenCalledWith(saved)
    })

    it('ignores renderer-supplied version and timestamp', async () => {
      const { applyTelemetryConsent } = await import('./telemetryConsentService')
      const { deps } = makeDeps({})
      // Extra fields are rejected outright by the strict schema — the renderer
      // cannot backdate a decision or claim a different disclosure version.
      const res = applyTelemetryConsent({ granted: true, version: 99, at: '1999-01-01T00:00:00.000Z' }, deps)
      expect(res).toEqual({ ok: false, reason: 'invalid_payload' })
      expect(deps.saveSettings).not.toHaveBeenCalled()
    })

    it('records a refusal, turns telemetry off and emits nothing', async () => {
      const { applyTelemetryConsent } = await import('./telemetryConsentService')
      const { deps, saveSettings } = makeDeps({ sentryEnabled: true })

      expect(applyTelemetryConsent({ granted: false }, deps)).toEqual({ ok: true, granted: false })

      const saved = saveSettings.mock.calls[0][0]
      expect(saved.telemetryConsent).toEqual({ granted: false, version: TELEMETRY_CONSENT_VERSION, at: NOW })
      expect(saved.sentryEnabled).toBe(false)
      expect(deps.applyTelemetryEnabled).toHaveBeenCalledWith(false)
      // A refusal must not produce a single event.
      expect(recordEventMock).not.toHaveBeenCalled()
    })

    it('emits telemetry.consent_granted only on a grant, after the SDK is enabled', async () => {
      const { applyTelemetryConsent } = await import('./telemetryConsentService')
      const order: string[] = []
      const { deps } = makeDeps({})
      deps.applyTelemetryEnabled = vi.fn(() => { order.push('apply') })
      recordEventMock.mockImplementation(() => { order.push('record') })

      applyTelemetryConsent({ granted: true }, deps)

      expect(recordEventMock).toHaveBeenCalledWith('telemetry.consent_granted', {
        version: TELEMETRY_CONSENT_VERSION,
      })
      expect(order).toEqual(['apply', 'record'])
      recordEventMock.mockReset()
    })

    it('rejects a malformed payload without touching state', async () => {
      const { applyTelemetryConsent } = await import('./telemetryConsentService')
      const { deps } = makeDeps({})
      for (const bad of [null, undefined, {}, { granted: 'yes' }, { granted: 1 }, 'granted']) {
        expect(applyTelemetryConsent(bad, deps)).toEqual({ ok: false, reason: 'invalid_payload' })
      }
      expect(deps.saveSettings).not.toHaveBeenCalled()
      expect(deps.applyTelemetryEnabled).not.toHaveBeenCalled()
    })

    it('reports a save failure without leaking the error message', async () => {
      const { applyTelemetryConsent } = await import('./telemetryConsentService')
      const { deps } = makeDeps({})
      const res = applyTelemetryConsent({ granted: true }, {
        ...deps,
        saveSettings: () => {
          throw Object.assign(new Error('EACCES: /home/ivan/.config/MailCopilot/settings.json'), { code: 'EACCES' })
        },
      })

      expect(res).toEqual({ ok: false, reason: 'save_failed' })
      // Telemetry state is not flipped when the decision could not be stored.
      expect(deps.applyTelemetryEnabled).not.toHaveBeenCalled()
      expect(captureExceptionMock).toHaveBeenCalledTimes(1)
      const [sent, context] = captureExceptionMock.mock.calls[0]
      expect((sent as Error).message).toBe('telemetry consent save failed')
      expect(JSON.stringify(context)).not.toContain('ivan')
    })

    // §2.82 iter3 finding 2 (WHEN) — the channel is open only while the
    // question is pending. Before this, a renderer could call it at any time:
    // overwrite a recorded refusal with a grant, re-stamp an existing decision
    // with a fresh timestamp, or replay the consent metric.
    describe('accepts a write only while the answer is pending', () => {
      it('rejects a second write once a decision exists', async () => {
        const { applyTelemetryConsent } = await import('./telemetryConsentService')
        for (const recorded of [true, false]) {
          const { deps, saveSettings } = makeDeps({
            telemetryConsent: { granted: recorded, version: TELEMETRY_CONSENT_VERSION, at: NOW },
          })
          expect(applyTelemetryConsent({ granted: !recorded }, deps)).toEqual({
            ok: false, reason: 'not_pending',
          })
          expect(saveSettings).not.toHaveBeenCalled()
          expect(deps.applyTelemetryEnabled).not.toHaveBeenCalled()
          expect(recordEventMock).not.toHaveBeenCalled()
        }
      })

      it('a recorded refusal cannot be flipped to a grant through this channel', async () => {
        const { applyTelemetryConsent } = await import('./telemetryConsentService')
        const denial = { granted: false, version: TELEMETRY_CONSENT_VERSION, at: NOW }
        const { deps, store } = makeDeps({ telemetryConsent: denial, sentryEnabled: false })
        expect(applyTelemetryConsent({ granted: true }, deps).ok).toBe(false)
        expect(store.telemetryConsent).toEqual(denial)
        expect(store.sentryEnabled).toBe(false)
      })

      // A record for an OLDER disclosure version reads as `needed`, so the
      // lawful re-ask still goes through — the gate is on the verdict, not on
      // "a record exists".
      it('still accepts the answer to a lawful re-ask', async () => {
        const { applyTelemetryConsent } = await import('./telemetryConsentService')
        const { deps } = makeDeps({
          telemetryConsent: { granted: false, version: TELEMETRY_CONSENT_VERSION - 1, at: NOW },
        })
        expect(applyTelemetryConsent({ granted: true }, deps)).toEqual({ ok: true, granted: true })
      })
    })

    it('does not fail the write when broadcasting throws', async () => {
      const { applyTelemetryConsent } = await import('./telemetryConsentService')
      const { deps } = makeDeps({})
      const res = applyTelemetryConsent({ granted: true }, {
        ...deps,
        broadcastSettings: () => { throw new Error('window destroyed') },
      })
      expect(res).toEqual({ ok: true, granted: true })
    })
  })

  describe('initTelemetryConsent composition', () => {
    it('migrates BEFORE exposing the handlers', async () => {
      // Restored after the §2.236 removal: a deleted diagnostics test happened
      // to be the only thing asserting that `initTelemetryConsent` runs the
      // migration at all. Direct tests of the migration and of the registration
      // both survive, but nothing tied them together — so dropping the migration
      // call from the composition would have gone unnoticed.
      //
      // The ordering is the part that matters. A legacy opt-out that is seeded
      // only AFTER the handlers are live leaves a window in which
      // `telemetry:consentState` answers `needed: true` for a user who has
      // already refused, and the consent screen asks a question that was
      // answered years ago.
      const { initTelemetryConsent } = await import('./telemetryConsentService')
      const { deps, saveSettings } = makeDeps({ sentryEnabled: false })
      const order: string[] = []
      saveSettings.mockImplementation(() => { order.push('migrated') })
      handleIpcMock.mockImplementation(() => { order.push('handler-registered') })

      initTelemetryConsent(deps)

      expect(order[0]).toBe('migrated')
      expect(order).toContain('handler-registered')
      expect(saveSettings.mock.calls[0][0].telemetryConsent).toEqual({
        granted: false,
        version: TELEMETRY_CONSENT_VERSION,
        at: NOW,
      })
    })
  })

  describe('migrateTelemetryConsent (AC11)', () => {
    it('seeds a refusal for an install that had already opted out', async () => {
      const { migrateTelemetryConsent } = await import('./telemetryConsentService')
      const { deps, saveSettings } = makeDeps({ sentryEnabled: false })

      expect(migrateTelemetryConsent(deps)).toBe('seeded_denied')
      expect(saveSettings.mock.calls[0][0].telemetryConsent).toEqual({
        granted: false,
        version: TELEMETRY_CONSENT_VERSION,
        at: NOW,
      })
    })

    it('leaves everything else without a record, so the screen asks once', async () => {
      const { migrateTelemetryConsent } = await import('./telemetryConsentService')
      for (const settings of [{}, { sentryEnabled: true }]) {
        const { deps, saveSettings } = makeDeps(settings)
        expect(migrateTelemetryConsent(deps)).toBe('noop')
        expect(saveSettings).not.toHaveBeenCalled()
      }
    })

    it('never overwrites an existing record', async () => {
      const { migrateTelemetryConsent } = await import('./telemetryConsentService')
      const { deps, saveSettings } = makeDeps({
        sentryEnabled: false,
        telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION, at: '2020-01-01T00:00:00.000Z' },
      })
      expect(migrateTelemetryConsent(deps)).toBe('noop')
      expect(saveSettings).not.toHaveBeenCalled()
    })

    it('never throws when the store is broken', async () => {
      const { migrateTelemetryConsent } = await import('./telemetryConsentService')
      const { deps } = makeDeps({ sentryEnabled: false })
      expect(migrateTelemetryConsent({ ...deps, getSettings: () => { throw new Error('boom') } })).toBe('noop')
      expect(migrateTelemetryConsent({ ...deps, saveSettings: () => { throw new Error('boom') } })).toBe('noop')
      expect(migrateTelemetryConsent({
        ...deps,
        readPersistedSentryEnabled: () => { throw new Error('boom') },
      })).toBe('noop')
    })

    // §2.82 iter2 finding 4 — the "absent vs explicitly false" distinction must
    // not ride on the schema's current default. These two cases pin the raw
    // read: they fail against a migration that classifies via getSettings().
    it('reads the RAW key, so a flipped schema default cannot fabricate refusals', async () => {
      const { migrateTelemetryConsent } = await import('./telemetryConsentService')
      const { deps, saveSettings } = makeDeps({})
      // Simulates someone changing `sentryEnabled: z.boolean().default(false)`:
      // the parsed view now says `false` for a legacy install that never
      // touched the switch, while the raw record has no such key.
      const parsedSaysFalse = {
        ...deps,
        getSettings: () => ({ sentryEnabled: false }) as Settings,
        readPersistedSentryEnabled: () => undefined,
      }
      expect(migrateTelemetryConsent(parsedSaysFalse)).toBe('noop')
      expect(saveSettings).not.toHaveBeenCalled()
    })

    it('still seeds a refusal when the raw key really is false', async () => {
      const { migrateTelemetryConsent } = await import('./telemetryConsentService')
      const { deps, saveSettings } = makeDeps({})
      const rawFalse = {
        ...deps,
        // Parsed view deliberately says `true` — only the raw value decides.
        getSettings: () => ({ sentryEnabled: true }) as Settings,
        readPersistedSentryEnabled: () => false,
      }
      expect(migrateTelemetryConsent(rawFalse)).toBe('seeded_denied')
      expect(saveSettings.mock.calls[0][0].telemetryConsent).toEqual({
        granted: false,
        version: TELEMETRY_CONSENT_VERSION,
        at: NOW,
      })
    })
  })

  describe('registerTelemetryConsentHandlers', () => {
    it('registers exactly the two whitelisted channels', async () => {
      const { registerTelemetryConsentHandlers } = await import('./telemetryConsentService')
      const { deps } = makeDeps({})
      registerTelemetryConsentHandlers(deps)

      expect(handleIpcMock.mock.calls.map(c => c[0])).toEqual(['telemetry:consentState', 'telemetry:setConsent'])
    })

    it('the registered handlers run the real implementations', async () => {
      const { registerTelemetryConsentHandlers } = await import('./telemetryConsentService')
      const { deps, saveSettings } = makeDeps({})
      registerTelemetryConsentHandlers(deps)

      const stateHandler = handleIpcMock.mock.calls[0][1] as (e: unknown) => TelemetryConsentStateLike
      const setHandler = handleIpcMock.mock.calls[1][1] as (e: unknown, p: unknown) => unknown

      expect(stateHandler({})).toEqual({ needed: true, version: TELEMETRY_CONSENT_VERSION })
      expect(setHandler({ sender: MAIN_SENDER }, { granted: true })).toEqual({ ok: true, granted: true })
      expect(saveSettings).toHaveBeenCalledTimes(1)
      expect(stateHandler({}).needed).toBe(false)
    })

    // §2.82 iter3 finding 2 (WHO) — the consent screen renders in the main
    // window only (src/Root.tsx), so a write from Compose / Settings / Account
    // / a mail window is by construction not a click on it.
    describe('sender gate', () => {
      /** Register with `deps` and hand back the `telemetry:setConsent` handler. */
      async function setHandlerFor(deps: unknown) {
        const { registerTelemetryConsentHandlers } = await import('./telemetryConsentService')
        registerTelemetryConsentHandlers(deps as Parameters<typeof registerTelemetryConsentHandlers>[0])
        return handleIpcMock.mock.calls[1][1] as (e: unknown, p: unknown) => SetConsentResultLike
      }

      it('rejects a write from a child window', async () => {
        const { deps, saveSettings } = makeDeps({})
        deps.isMainWindowSender = vi.fn((sender: unknown) => sender === MAIN_SENDER)
        const setHandler = await setHandlerFor(deps)

        expect(setHandler({ sender: { id: 'compose-window' } }, { granted: true })).toEqual({
          ok: false, reason: 'forbidden_sender',
        })
        expect(saveSettings).not.toHaveBeenCalled()
        expect(deps.applyTelemetryEnabled).not.toHaveBeenCalled()
        expect(recordEventMock).not.toHaveBeenCalled()
      })

      it('accepts a write from the main window', async () => {
        const { deps, saveSettings } = makeDeps({})
        deps.isMainWindowSender = vi.fn((sender: unknown) => sender === MAIN_SENDER)
        const setHandler = await setHandlerFor(deps)

        expect(setHandler({ sender: MAIN_SENDER }, { granted: true })).toEqual({ ok: true, granted: true })
        expect(saveSettings).toHaveBeenCalledTimes(1)
      })

      // Fail closed: a wiring that forgets the predicate must reject, not
      // silently accept writes from any window.
      it('rejects everything when no predicate is wired', async () => {
        const { deps, saveSettings } = makeDeps({})
        const withoutPredicate = { ...deps } as Partial<typeof deps>
        delete withoutPredicate.isMainWindowSender
        const setHandler = await setHandlerFor(withoutPredicate)

        expect(setHandler({ sender: MAIN_SENDER }, { granted: true })).toEqual({
          ok: false, reason: 'forbidden_sender',
        })
        expect(saveSettings).not.toHaveBeenCalled()
      })

      it('rejects a malformed event with no sender at all', async () => {
        const { deps } = makeDeps({})
        deps.isMainWindowSender = vi.fn((sender: unknown) => sender === MAIN_SENDER)
        const setHandler = await setHandlerFor(deps)

        for (const event of [{}, null, undefined, { sender: null }]) {
          expect(setHandler(event, { granted: true })).toEqual({ ok: false, reason: 'forbidden_sender' })
        }
      })
    })
  })

  // CLAUDE.md §8: whatever this module logs, it must carry no user data. The
  // §2.236 diagnostics that used to be asserted here are gone (see
  // getTelemetryConsentState for why), but this guard is not about them — it is
  // about every line the module still emits, and it gets cheaper to satisfy, not
  // less necessary, as lines are removed.
  describe('log hygiene', () => {
    it('puts nothing from settings, payload or sender into any log line', async () => {
      const { initTelemetryConsent } = await import('./telemetryConsentService')
      const POISON = 'ivan@example.com'
      const { deps } = makeDeps({
        telemetryConsent: { granted: true, version: TELEMETRY_CONSENT_VERSION, at: POISON },
      } as Partial<Settings>)
      initTelemetryConsent(deps)
      const stateHandler = handleIpcMock.mock.calls[0][1] as (e: unknown) => TelemetryConsentStateLike
      const setHandler = handleIpcMock.mock.calls[1][1] as (e: unknown, p: unknown) => SetConsentResultLike
      stateHandler({})
      setHandler({ sender: MAIN_SENDER }, { granted: true, note: POISON })

      const everything = JSON.stringify([
        logMock.info.mock.calls, logMock.warn.mock.calls, logMock.error.mock.calls,
      ])
      expect(everything).not.toContain(POISON)
      expect(everything).not.toContain('main-window-web-contents')
    })

    it('still reports an unreadable settings store — the one branch that must stay visible', async () => {
      // Kept at warn on purpose: in a packaged build the console transport is
      // warn-level, and "we could not read the answer at all" is the single
      // consent branch an operator needs to see without debug logging.
      const { getTelemetryConsentState } = await import('./telemetryConsentService')
      const { deps } = makeDeps({})
      const state = getTelemetryConsentState({
        ...deps,
        getSettings: () => { throw new Error('unreadable') },
      })
      expect(state.needed).toBe(true)
      expect(logMock.warn.mock.calls.map(c => c[0]))
        .toContain('consent state: settings unreadable, asking again')
    })
  })
})

/** Stand-in for the main window's WebContents — compared by identity only. */
const MAIN_SENDER = { id: 'main-window-web-contents' }

type SetConsentResultLike = { ok: boolean; reason?: string; granted?: boolean }

type TelemetryConsentStateLike = { needed: boolean; version: number }
