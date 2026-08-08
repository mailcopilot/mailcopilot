// §2.82 — first-run telemetry consent: persistence, migration and IPC.
//
// The decision logic itself is in electron/telemetryConsent.ts (pure, no
// dependencies, so the Sentry preflight can use it before anything heavy
// loads). This module owns the side effects: reading and writing settings,
// flipping the live SDK state, emitting the grant metric, and exposing the two
// IPC channels the consent screen talks to.
//
// Contract with the renderer (both channels are in the preload whitelist):
//   - `telemetry:consentState` → `{ needed, version }`. Read-only. `needed`
//     means "show the screen"; the renderer must not infer anything else from
//     it (in particular, `needed: false` does NOT mean telemetry is on).
//   - `telemetry:setConsent` ← `{ granted: boolean }`. The renderer reports the
//     click and nothing else: `version` and `at` are stamped here, so a
//     compromised renderer cannot backdate a decision or claim consent for a
//     disclosure version the user never saw.
//
// No buffering, anywhere. Events that occurred before the answer are dropped,
// not queued for later delivery — a retroactive flush would be transmission of
// data collected without consent (ePrivacy art. 5(3)).
//
// That claim is enforced by electron/telemetryGate.ts, not by this file: the
// gate stops COLLECTION (the metric aggregate window, the session-long
// feature-reach bitmap, metric spans, Sentry breadcrumbs, the session clock)
// and drops whatever exists on every transition. It is armed from
// `setSentryUserEnabled`, which `applyTelemetryEnabled` below calls. Before
// §2.82 iter2 the sentence above was aspirational: the aggregator held events
// for up to 10s regardless of consent, and the feature-reach bitmap
// accumulated for the whole session, so a user who declined, worked, then
// opted in from Settings → About shipped that entire period in
// `usage.session_summary` at quit.

import { app } from 'electron'
import { z } from 'zod'
import { handleIpc } from '../ipc'
import { createLogger } from '../logger'
import { getSettings, saveSettings, getRawPersistedSettings, type Settings } from '../../packages/net/config'
import { recordEvent } from '../metrics'
import { captureException, setSentryUserEnabled, setSentryUserId } from '../sentry'
import { getInstallIdHash } from '../installId'
import {
  TELEMETRY_CONSENT_VERSION,
  evaluateConsent,
  makeConsentRecord,
} from '../telemetryConsent'

// Acceptance conditions for `telemetry:setConsent` (§2.82 iter3, finding 2).
//
// The channel is renderer-writable by necessity — the answer comes from a
// click in a renderer window. Two cheap conditions bound what that means
// without asking the human a second question:
//
//   1. WHEN — only while the verdict is `needed`. Once an answer exists the
//      channel is closed, so a second call cannot overwrite a recorded refusal,
//      re-stamp a decision with a fresh timestamp, or replay the grant. The
//      withdrawal path (GDPR art. 7(3)) is Settings → About, which goes through
//      `settings:save` / `applyAboutToggle`, not through here.
//   2. WHO — only the main window's WebContents. The consent screen renders in
//      the main window only (src/Root.tsx gates on `renderChildWindow(hash)`
//      being null), so a call from Compose / Settings / Account / a mail window
//      is by construction not a click on the screen.
//
// What this deliberately does NOT claim: it is not protection against a
// compromised MAIN window on the first screen — that window is the one being
// asked, and distinguishing its real click from a synthetic one would require
// a native dialog, which was considered and declined. The accepted risk is
// stated here so nobody later mistakes the guard for more than it is.

const log = createLogger('TelemetryConsent')

/** Payload of `telemetry:setConsent`. Strict: nothing else is accepted. */
const setConsentSchema = z.object({ granted: z.boolean() }).strict()

export interface TelemetryConsentState {
  /** True when the consent screen must be shown. */
  needed: boolean
  /** Disclosure-composition version the screen must describe. */
  version: number
}

export type SetConsentResult =
  | { ok: true; granted: boolean }
  | { ok: false; reason: 'invalid_payload' | 'save_failed' | 'not_pending' | 'forbidden_sender' }

/**
 * Injectable seams. Defaults are the real implementations; tests override them
 * so the unit suite never loads electron-store / keytar / the Sentry SDK.
 */
export interface TelemetryConsentDeps {
  getSettings: () => Settings
  saveSettings: (settings: Settings) => void
  /** Apply the decision to the live SDK (enable flag + pseudonymous identity). */
  applyTelemetryEnabled: (enabled: boolean) => void
  /** `app.isPackaged` — the e2e bypass is only legal in an unpackaged build. */
  isPackaged: () => boolean
  /**
   * The `sentryEnabled` value as PERSISTED, before schema defaults. Used only
   * by the legacy migration, which must tell "the user turned the switch off"
   * apart from "the key was never written" — see `migrateTelemetryConsent`.
   */
  readPersistedSentryEnabled: () => unknown
  /** ISO timestamp source. */
  now: () => string
  /** Optional: push the new settings object to open windows. */
  broadcastSettings?: (settings: Settings) => void
  /**
   * Is this `IpcMainInvokeEvent.sender` the MAIN window's WebContents?
   *
   * A predicate rather than a `BrowserWindow`: this module already depends on
   * `app` but nothing here should have to reason about window identity, and
   * `electron/telemetryConsent.ts` (the pure decision layer) must stay free of
   * Electron entirely. electron/main.ts owns `win` and supplies the closure.
   *
   * Default is `false` — fail closed. A wiring that forgets to pass the
   * predicate rejects every write (a visible, testable breakage) instead of
   * silently accepting writes from any window.
   */
  isMainWindowSender: (sender: unknown) => boolean
}

function defaultApplyTelemetryEnabled(enabled: boolean): void {
  try {
    setSentryUserEnabled(enabled)
  } catch { /* telemetry must never throw */ }
  if (!enabled) return
  try {
    setSentryUserId(getInstallIdHash())
  } catch { /* telemetry must never throw */ }
}

function withDefaults(overrides?: Partial<TelemetryConsentDeps>): TelemetryConsentDeps {
  return {
    getSettings,
    saveSettings,
    applyTelemetryEnabled: defaultApplyTelemetryEnabled,
    isPackaged: () => app.isPackaged,
    readPersistedSentryEnabled: () => {
      try {
        return getRawPersistedSettings()?.sentryEnabled
      } catch {
        // Store unreadable: we cannot prove an explicit opt-out exists, so the
        // migration must not invent one. `undefined` → no seeding, ask.
        return undefined
      }
    },
    now: () => new Date().toISOString(),
    isMainWindowSender: () => false,
    ...overrides,
  }
}

/**
 * Should the consent gate be skipped for the automated test harness?
 *
 * 30+ e2e specs start from an empty data dir; without a bypass every one of
 * them would stall on the consent screen. The bypass is gated on THREE
 * conditions, and the `!isPackaged` one is the load-bearing part: `MAILCOPILOT_E2E`
 * is an environment variable, and anything running as the user can set it — a
 * consent gate that an env var switches off in a shipped build is not a consent
 * gate (same reasoning and same pair of conditions as the audit-log clear
 * dialog, BACKLOG §3.3.B1.f1.f1). `MAILCOPILOT_E2E_CONSENT=1` opts an individual
 * spec back INTO the real gate so the screen itself can be tested.
 */
function isE2EConsentBypass(deps: TelemetryConsentDeps): boolean {
  if (process.env.MAILCOPILOT_E2E !== '1') return false
  if (process.env.MAILCOPILOT_E2E_CONSENT === '1') return false
  try {
    if (deps.isPackaged()) return false
  } catch {
    // Cannot prove we are unpackaged → assume we are. Fail towards asking.
    return false
  }
  return true
}

/** Implementation behind `telemetry:consentState`. */
export function getTelemetryConsentState(overrides?: Partial<TelemetryConsentDeps>): TelemetryConsentState {
  const deps = withDefaults(overrides)
  if (isE2EConsentBypass(deps)) return { needed: false, version: TELEMETRY_CONSENT_VERSION }
  let settings: Settings | undefined
  try {
    settings = deps.getSettings()
  } catch {
    // Settings unreadable: we cannot prove an answer exists, so ask. Telemetry
    // stays off either way (the preflight fails closed on the same condition).
    return { needed: true, version: TELEMETRY_CONSENT_VERSION }
  }
  return { needed: evaluateConsent(settings) === 'needed', version: TELEMETRY_CONSENT_VERSION }
}

/**
 * Implementation behind `telemetry:setConsent`.
 *
 * Order of operations is deliberate:
 *   1. persist the record (so a crash right after cannot lose a refusal),
 *   2. apply it to the live SDK,
 *   3. only then emit the grant metric — before step 2 the client is still
 *      disabled and the event would be dropped.
 *
 * The WHO condition (main window only) is enforced one level up, in
 * `registerTelemetryConsentHandlers`, which is where the IPC event lives; the
 * WHEN condition is enforced here so that every caller — including a future
 * non-IPC one — goes through it.
 */
export function applyTelemetryConsent(
  payload: unknown,
  overrides?: Partial<TelemetryConsentDeps>,
): SetConsentResult {
  const deps = withDefaults(overrides)
  const parsed = setConsentSchema.safeParse(payload)
  if (!parsed.success) {
    // No payload echo in the log line — it is renderer-controlled (CLAUDE.md §8).
    log.warn('setConsent rejected: invalid payload')
    return { ok: false, reason: 'invalid_payload' }
  }
  const granted = parsed.data.granted

  let next: Settings
  try {
    const current = deps.getSettings()
    // WHEN: only while the question is actually open. `denied` and `granted`
    // are both closed states — the About switch, not this channel, is how a
    // recorded answer changes afterwards.
    if (evaluateConsent(current) !== 'needed') {
      log.warn('setConsent rejected: no consent question is pending')
      return { ok: false, reason: 'not_pending' }
    }
    next = {
      ...current,
      telemetryConsent: makeConsentRecord(granted, deps.now()),
      // Keep the Settings → About switch in agreement with the answer, so the
      // withdrawal path (GDPR art. 7(3)) starts from the right position.
      sentryEnabled: granted,
    }
    deps.saveSettings(next)
  } catch (err) {
    // Synthetic exception only: an fs/store error message embeds the settings
    // file path, which contains the OS account name.
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    log.error('failed to persist telemetry consent', { code: typeof code === 'string' ? code : 'unknown' })
    const sanitized = new Error('telemetry consent save failed')
    sanitized.name = 'TelemetryConsentSaveError'
    captureException(sanitized, { source: 'telemetryConsent.save' })
    return { ok: false, reason: 'save_failed' }
  }

  deps.applyTelemetryEnabled(granted)

  if (granted) {
    try {
      recordEvent('telemetry.consent_granted', { version: TELEMETRY_CONSENT_VERSION })
    } catch { /* telemetry must never throw */ }
  }

  try {
    deps.broadcastSettings?.(next)
  } catch { /* a destroyed window must not fail the consent write */ }

  log.info(`consent recorded granted=${granted} version=${TELEMETRY_CONSENT_VERSION}`)
  return { ok: true, granted }
}

/**
 * One-time migration for installs that predate the consent record.
 *
 *   - a PERSISTED `sentryEnabled === false` — the user already found the About
 *     switch and turned it off. That is an expressed refusal; seed it as a
 *     refusal at the current version and never ask.
 *   - anything else (key absent, or `true`) — leave the record absent.
 *     Telemetry switches off and the screen runs once. This is intentional and
 *     is the whole point of §2.82: the previous "enabled" state was never
 *     consented to, it was merely the default nobody was asked about.
 *
 * The word PERSISTED is load-bearing, and it is why this reads the raw store
 * instead of `getSettings()`. The parsed value cannot distinguish "absent" from
 * "explicitly false" — it only ever appears absent because the schema happens
 * to default `sentryEnabled` to `true` today. Someone changing that default to
 * `false` "for consistency with opt-in" would, through the parsed path, turn
 * every legacy install that never touched the switch into a recorded refusal
 * and permanently hide the consent screen from them. The dependency is now
 * explicit rather than incidental (§2.82 iter2 finding 4).
 *
 * Never throws: a failed migration only means the screen asks again next time.
 */
export function migrateTelemetryConsent(
  overrides?: Partial<TelemetryConsentDeps>,
): 'seeded_denied' | 'noop' {
  const deps = withDefaults(overrides)
  let current: Settings
  try {
    current = deps.getSettings()
  } catch {
    return 'noop'
  }
  // Any existing record (even a malformed one) is left alone: evaluateConsent
  // reads a broken record as "needed", so the screen will overwrite it.
  if (current?.telemetryConsent) return 'noop'
  let persistedSentryEnabled: unknown
  try {
    persistedSentryEnabled = deps.readPersistedSentryEnabled()
  } catch {
    return 'noop'
  }
  // Strictly `=== false` on the RAW value: `undefined` means the key was never
  // written (never asked → let the screen run), and no other value is an
  // expressed refusal.
  if (persistedSentryEnabled !== false) return 'noop'
  try {
    deps.saveSettings({ ...current, telemetryConsent: makeConsentRecord(false, deps.now()) })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    log.warn('failed to seed consent record for a legacy opt-out', {
      code: typeof code === 'string' ? code : 'unknown',
    })
    return 'noop'
  }
  log.info('seeded a refusal record for a legacy opt-out install')
  return 'seeded_denied'
}

/** Register the two consent IPC channels. */
export function registerTelemetryConsentHandlers(overrides?: Partial<TelemetryConsentDeps>): void {
  handleIpc('telemetry:consentState', (): TelemetryConsentState => getTelemetryConsentState(overrides))
  handleIpc('telemetry:setConsent', (event, payload: unknown): SetConsentResult => {
    // WHO: the consent screen only ever renders in the main window, so a write
    // arriving from any other WebContents is not a click on it. Checked here
    // because this is the only layer that sees the IPC event.
    const sender = (event as { sender?: unknown } | undefined)?.sender
    if (!withDefaults(overrides).isMainWindowSender(sender)) {
      // No sender identity in the log line — it is renderer-derived.
      log.warn('setConsent rejected: sender is not the main window')
      return { ok: false, reason: 'forbidden_sender' }
    }
    return applyTelemetryConsent(payload, overrides)
  })
}

/**
 * Single entry point for main.ts: migrate legacy installs, then register the
 * IPC surface. Keeps electron/main.ts (a §5 hotspot) down to one call.
 */
export function initTelemetryConsent(overrides?: Partial<TelemetryConsentDeps>): void {
  migrateTelemetryConsent(overrides)
  registerTelemetryConsentHandlers(overrides)
}
