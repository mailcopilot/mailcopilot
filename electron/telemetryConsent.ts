// §2.82 — telemetry consent state: the single place that decides whether the
// user has actually agreed to diagnostics being sent.
//
// Why a standalone module and not part of packages/net/config.ts: this file is
// imported by `electron/sentryPreflight.ts`, which runs BEFORE Sentry.init and
// must not pull better-sqlite3 / keytar / electron-store / zod into the import
// graph in front of it (see the header comment in sentryPreflight.ts). Keep
// this module dependency-free — no electron, no node builtins, no zod. It is a
// set of pure functions over a plain settings-shaped object.
//
// Legal framing (BACKLOG §2.82): ePrivacy art. 5(3) requires informed consent
// before non-essential data leaves the device, and GDPR art. 4(11) / recital 32
// require an active action — silence, inactivity and pre-ticked boxes are not
// consent (CJEU Planet49, C-673/17). Therefore "no record" means "no consent",
// never "assume yes".

/**
 * Version of the DISCLOSED COMPOSITION of collected data, not of the code.
 *
 * Bump this ONLY when what we collect materially changes (a new category of
 * data, a new sink, a wider scope) — that is the single lawful reason to show
 * the consent screen to a user who has already answered (§2.82 AC (e)). Do NOT
 * bump it for refactors, wording tweaks, or bug fixes.
 */
export const TELEMETRY_CONSENT_VERSION = 1

/** Persisted proof of the user's decision. Main-process writable only. */
export interface TelemetryConsentRecord {
  /** True only if the user actively chose "allow". */
  granted: boolean
  /** `TELEMETRY_CONSENT_VERSION` at the moment the decision was made. */
  version: number
  /** ISO timestamp of the decision — stamped by main, never by the renderer. */
  at: string
}

/**
 * - `granted` — send telemetry.
 * - `denied`  — do not send, and do not ask again.
 * - `needed`  — do not send, and show the consent screen once.
 *
 * Note that `denied` and `needed` are identical for the sending decision and
 * differ only in whether we may ask. Any doubt about the stored record (absent,
 * wrong shape, older composition version) collapses to `needed`, i.e. off.
 */
export type ConsentVerdict = 'granted' | 'denied' | 'needed'

/** Minimal structural view of settings — avoids importing the config types. */
export interface TelemetryConsentCarrier {
  sentryEnabled?: unknown
  telemetryConsent?: unknown
}

/**
 * Classify the persisted consent record.
 *
 * Fail-closed by construction: every branch that cannot positively prove an
 * active "allow" for the CURRENT composition version returns `needed` (which
 * means "off" for sending purposes).
 *
 * `version > TELEMETRY_CONSENT_VERSION` (the user downgraded the app after
 * consenting to a newer, broader disclosure) is treated as a valid decision:
 * the disclosure the user saw covered at least what this build collects, and
 * re-asking on a downgrade would show the screen for no new information.
 */
export function evaluateConsent(settings: TelemetryConsentCarrier | null | undefined): ConsentVerdict {
  const record = settings?.telemetryConsent
  if (!record || typeof record !== 'object') return 'needed'
  const { granted, version, at } = record as Partial<TelemetryConsentRecord>
  if (typeof granted !== 'boolean') return 'needed'
  if (typeof version !== 'number' || !Number.isInteger(version)) return 'needed'
  if (typeof at !== 'string' || at.length === 0) return 'needed'
  // Composition widened since the decision — one lawful re-ask (§2.82 AC (e)).
  if (version < TELEMETRY_CONSENT_VERSION) return 'needed'
  return granted ? 'granted' : 'denied'
}

/**
 * The effective "may we send anything" answer, used by the Sentry preflight,
 * by the runtime toggle wiring in main.ts, and by the `--sentry-enabled=`
 * argument handed to the renderer preload.
 *
 * Conjunction of two independent facts, both of which must hold:
 *   1. an active consent for the current composition version, and
 *   2. the Settings → About switch not being off.
 *
 * They are kept in sync (a toggle flip mirrors into the record, see
 * `syncConsentWithToggle`), so in practice they agree; requiring both means a
 * half-written state can only ever fail towards silence.
 */
export function isTelemetryAllowed(settings: TelemetryConsentCarrier | null | undefined): boolean {
  if (evaluateConsent(settings) !== 'granted') return false
  return settings?.sentryEnabled !== false
}

/**
 * Clamp the copy of settings that leaves main for a renderer window.
 *
 * The renderer turns ITS OWN Sentry client on from `sentryEnabled` alone
 * (src/App.tsx reads `s.sentryEnabled !== false` on both `settings:get` and
 * `settings:changed`), so handing it the raw persisted field is handing it a
 * pre-ticked box: on a clean profile there is no consent record at all, while
 * the schema still supplies `sentryEnabled: true` by default. That combination
 * starts renderer envelopes for a user who has never been asked — and it is
 * reachable in practice, because the consent screen's own hook gives up
 * waiting on main after a few seconds and mounts the app anyway.
 *
 * So main never publishes the raw field: what goes out is the EFFECTIVE
 * permission, `isTelemetryAllowed`. Windows that need to tell "the user turned
 * it off" apart from "nobody has asked yet" read the dedicated
 * `telemetry:consentState` channel — that distinction is not encodable in a
 * boolean, and trying to encode it here is what produced the pre-ticked box in
 * the first place.
 *
 * Round-trip safety: the renderer echoes the clamped value back in
 * `settings:save`, and `applyAboutToggle` treats an incoming value as a
 * decision only when a valid, current consent record already exists — so a
 * clamped `false` cannot manufacture a refusal the user never made.
 */
export function clampTelemetryForRenderer<T extends TelemetryConsentCarrier>(settings: T): T {
  return { ...settings, sentryEnabled: isTelemetryAllowed(settings) }
}

/** Build a decision record stamped with the current composition version. */
export function makeConsentRecord(granted: boolean, atIso: string): TelemetryConsentRecord {
  return { granted, version: TELEMETRY_CONSENT_VERSION, at: atIso }
}

/**
 * Mirror a Settings → About toggle flip into the stored consent record.
 *
 * GDPR art. 7(3): withdrawing must be as easy as giving. The About switch is
 * that path, so flipping it has to move the consent record too — otherwise
 * turning telemetry off in Settings would leave `granted: true` behind and the
 * first-run screen would keep re-appearing, or (worse) the record would out-vote
 * the user's latest explicit action.
 *
 * Two deliberate restrictions:
 *   - Returns `undefined` when there is no record yet. A `settings:save` from
 *     the renderer must never be able to MANUFACTURE consent; only the
 *     `telemetry:setConsent` handler (fed by the consent screen) creates one.
 *   - Keeps the stored `version`. If the composition version was bumped and the
 *     re-ask is still pending, flipping the switch on must not silently
 *     suppress the screen for a disclosure the user has not seen yet.
 */
export function syncConsentWithToggle(
  existing: unknown,
  granted: boolean,
  atIso: string,
): TelemetryConsentRecord | undefined {
  if (!existing || typeof existing !== 'object') return undefined
  const record = existing as Partial<TelemetryConsentRecord>
  if (typeof record.granted !== 'boolean' || typeof record.version !== 'number' || typeof record.at !== 'string') {
    // Malformed record: leave it untouched. `evaluateConsent` already reads it
    // as `needed`, so the screen will ask again and overwrite it properly.
    return existing as TelemetryConsentRecord
  }
  if (record.granted === granted) return record as TelemetryConsentRecord
  return { granted, version: record.version, at: atIso }
}

/** Both settings fields a Settings → About toggle flip has to produce. */
export interface AboutToggleOutcome {
  telemetryConsent: TelemetryConsentRecord | undefined
  sentryEnabled: boolean
}

/**
 * Resolve a Settings → About toggle flip into the pair of persisted values.
 *
 * While the verdict is `needed` (no record, malformed, or an older disclosure
 * version) an incoming value is not a decision AT ALL. The About switch is
 * disabled in the UI in that state and main publishes a clamped `false` (see
 * `clampTelemetryForRenderer`), so the value the renderer echoes back on the
 * next unrelated `settings:save` is main's own clamp coming home. Treating it
 * as an answer — in the record OR in the persisted flag — would fabricate one
 * the user never gave, so the branch touches neither: the record is passed
 * through untouched and `sentryEnabled` keeps whatever is already on disk
 * (`persistedEnabled`).
 *
 * Once an answer EXISTS, `sentryEnabled` is clamped to it. That field is
 * broadcast to every window on `settings:changed`, and the renderer turns ITS
 * own Sentry client on from that value alone (src/App.tsx), so it may never say
 * "on" while the record says otherwise.
 *
 * Consequence, intended: switching the toggle on before answering the screen
 * does nothing. There is no state in which the EFFECTIVE permission
 * (`isTelemetryAllowed`, which is what leaves main) says "on" and consent is
 * missing.
 *
 * @param persistedEnabled the `sentryEnabled` value as currently stored, read
 *   from the RAW store by the caller. Only consulted on the `needed` branch,
 *   and only to preserve it.
 */
export function applyAboutToggle(
  existingConsent: unknown,
  requestedEnabled: boolean,
  atIso: string,
  persistedEnabled?: unknown,
): AboutToggleOutcome {
  if (evaluateConsent({ telemetryConsent: existingConsent }) === 'needed') {
    return {
      telemetryConsent: asStoredRecord(existingConsent),
      // §2.82 iter2 (finding 3): PRESERVE what is on disk, do not write `false`.
      //
      // Writing the clamp looked harmless — the value is already effectively
      // off — but `migrateTelemetryConsent` reads a persisted
      // `sentryEnabled === false` as proof that a legacy user found the About
      // switch and turned it off, and seeds a permanent refusal from it. So a
      // user who saved an UNRELATED setting (language, theme) while the consent
      // answer was still pending — reachable whenever the consent-state channel
      // stalls and the screen's hook fails open — had main's own clamp echoed
      // back, persisted, and promoted to "the user refused" on the next start.
      // The screen would then never appear for them.
      //
      // Preserving means: an existing `false` stays `false` (a real legacy
      // opt-out we must not overwrite), and anything else — absent key, `true`,
      // garbage — becomes `true`. `true` here is not "on": with no consent
      // record `isTelemetryAllowed` is still false, `clampTelemetryForRenderer`
      // still publishes `false` to every window, and the About switch is still
      // disabled. It only keeps "nobody answered yet" distinguishable from "the
      // user said no". The literal `true` is deliberate rather than the schema
      // default: the migration's discriminator is `=== false`, and this branch
      // must stay correct even if that default is ever flipped.
      sentryEnabled: persistedEnabled !== false,
    }
  }
  const telemetryConsent = syncConsentWithToggle(existingConsent, requestedEnabled, atIso)
  return {
    telemetryConsent,
    sentryEnabled: requestedEnabled && evaluateConsent({ telemetryConsent }) === 'granted',
  }
}

/**
 * Which window sent the `settings:save` that carries the About-switch value.
 *
 * `settings-window` is the ONE window where a human can see the switch, the
 * disclosure text next to it, and the link to the privacy page. Every other
 * WebContents — main window, Compose, Account, a mail window — reaches the
 * same IPC channel with the same payload shape.
 */
export type AboutToggleOrigin = 'settings-window' | 'other-window'

/**
 * Resolve an About-switch value with the SENDER taken into account.
 *
 * §2.82 iter4 (security finding 1). `telemetry:setConsent` is gated on the
 * main window because that is where the first-run screen renders, and the
 * accepted residual risk was stated narrowly: a compromised MAIN WINDOW while
 * THE QUESTION IS ON SCREEN. `settings:save` silently widened that to "any
 * window, at any time, forever after": it reaches `applyAboutToggle`, and a
 * `sentryEnabled: true` there flips a recorded REFUSAL into consent. A window
 * that never displayed the question cannot be carrying the answer to it.
 *
 * The rule is deliberately ASYMMETRIC, and the asymmetry is the design:
 *
 *   - TURNING IT OFF is accepted from anywhere, unconditionally. GDPR art.
 *     7(3) requires withdrawal to be no harder than giving, and a "wrong"
 *     window asking for silence still produces silence — there is no attack in
 *     that direction. Nothing below may ever add a condition to this path.
 *   - TURNING IT ON is accepted only from the settings window, because that is
 *     the only surface on which the user can have seen what they are enabling.
 *
 * "Turning it on" means a real transition: `requestedEnabled` while the
 * effective permission (`isTelemetryAllowed`) is currently false. An echo of
 * `true` while telemetry is ALREADY on changes nothing and is accepted from
 * anywhere — every window round-trips the clamped flag on unrelated saves
 * (theme, language), and treating those as attempts would make ordinary saves
 * fail for no gain.
 *
 * A rejected enable does not fall through to `applyAboutToggle` with `false`
 * substituted: on a `granted: true` + switch-off state that substitution would
 * be read as a fresh WITHDRAWAL and rewrite the record. A rejected request is
 * not a decision in either direction, so both fields are preserved as-is —
 * `sentryEnabled` from the RAW persisted value for the same reason the
 * `needed` branch of `applyAboutToggle` uses it (the consent migration's
 * discriminator is a persisted `=== false`; see the comment there).
 */
export function applyAboutToggleFromOrigin(
  current: TelemetryConsentCarrier | null | undefined,
  requestedEnabled: boolean,
  atIso: string,
  persistedEnabled: unknown,
  origin: AboutToggleOrigin,
): AboutToggleOutcome {
  const isEnableTransition = requestedEnabled && !isTelemetryAllowed(current)
  if (isEnableTransition && origin !== 'settings-window') {
    return {
      telemetryConsent: asStoredRecord(current?.telemetryConsent),
      sentryEnabled: persistedEnabled !== false,
    }
  }
  return applyAboutToggle(current?.telemetryConsent, requestedEnabled, atIso, persistedEnabled)
}

/**
 * Pass a stored record through untouched. An absent one stays absent; a
 * malformed one is preserved verbatim (the consent screen will overwrite it —
 * `evaluateConsent` already reads it as `needed`), because silently deleting
 * it would lose forensic evidence of the corruption.
 */
function asStoredRecord(existing: unknown): TelemetryConsentRecord | undefined {
  if (!existing || typeof existing !== 'object') return undefined
  return existing as TelemetryConsentRecord
}
