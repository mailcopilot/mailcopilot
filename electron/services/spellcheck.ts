/**
 * Spell checking — BACKLOG §2.103.
 *
 * WHAT THIS FILE IS FOR. Electron ships a spellchecker that is ON by default
 * (`webPreferences.spellcheck` defaults to `true`), and whose language list,
 * when empty, Electron populates from the OS locale on launch. The first time
 * that language is needed Chromium FETCHES its hunspell dictionary from
 * Google's CDN ({@link DICTIONARY_DOWNLOAD_ORIGIN}) — an unannounced request to
 * a third party, made by an app whose stated posture is `default-deny` egress
 * and whose whole positioning is "trust is provable". So the feature is not
 * "add a language picker": it is to put every branch that can reach that CDN
 * behind an explicit human answer, and to leave the checker disarmed until
 * then.
 *
 * THE GUARANTEE, stated at the width this layer can actually hold:
 * **MailCopilot does not arm a downloadable dictionary without a recorded
 * native consent.** Not "the request never happens" — the request belongs to
 * Chromium, the dictionary files belong to Google's CDN, and on macOS both the
 * checker and its language list belong to the OS (point 5). Claiming the wider
 * guarantee would be enforcement built on state we do not own, which CLAUDE.md
 * §5 "Кто владеет правдой" forbids; what we do own is whether the checker is
 * ever armed with a language nobody agreed to, and that is enforced here.
 *
 * THE SHAPE, and why it is this one:
 *
 *  1. SINGLE WRITER. Nothing outside this module calls `setSpellCheckerEnabled`
 *     / `setSpellCheckerLanguages` / `setSpellCheckerDictionaryDownloadURL`.
 *     main.ts wires; this file decides — the same split as
 *     electron/services/windowRescue.ts for window geometry. A second writer
 *     would mean two answers to "is a dictionary allowed to be fetched right
 *     now", and the weaker one would win. Inside the module the ordinary
 *     policy has exactly one applier, {@link applyToSession}; the download
 *     guard (point 6) also disarms, but only on a path that is by definition a
 *     defect, and only in the safe direction.
 *
 *  2. THE AVAILABLE LANGUAGE SET IS CHROMIUM'S, NOT OURS. It is read from
 *     `session.availableSpellCheckerLanguages` and reported to the renderer
 *     through main-only settings (`spellcheckAvailable`), never mirrored as a
 *     hardcoded list — a copy of someone else's set drifts, which is the same
 *     failure §2.167 records for the MCP export ceiling. This also means no new
 *     IPC channel: the picker renders from the settings object the Settings
 *     window already reads, so the preload whitelist is untouched.
 *
 *  3. CONSENT IS A NATIVE DIALOG DRAWN BY MAIN, and the only writer of the
 *     grant record is that dialog's own `true` branch. There is no token for a
 *     renderer to quote and no offer id to replay — the mistake CLAUDE.md §5
 *     records for `net:trustCert` and `ai:auditLog:clear`. The worst a
 *     compromised renderer can do is make a dialog appear, which is the
 *     intended behaviour. Same construction, for the same reason, as
 *     ./aiDestinationGuard.ts.
 *
 *  4. REFUSAL IS HONEST AND NON-DESTRUCTIVE. Declining does not enable the
 *     language "without downloading" — we would be promising a spellchecker
 *     that silently does nothing for that language, since we cannot see
 *     Chromium's dictionary cache without reverse-engineering its on-disk
 *     layout. The language is simply not enabled, the rest of the save lands,
 *     and the Settings window says so. A decline is not persisted either: it is
 *     an answer about one moment, not a permanent refusal, so re-picking the
 *     language asks again.
 *
 *  5. macOS OWNS ITS OWN LIST. There `setSpellCheckerLanguages` is a documented
 *     no-op, the OS spellchecker detects the language itself, and NO dictionary
 *     is downloaded at all. So on macOS there is no language picker and no
 *     consent prompt — offering a control that changes nothing is exactly what
 *     CLAUDE.md §5 "Кто владеет правдой" forbids. What remains there is the
 *     on/off switch, which does work.
 *
 *  6. A DOWNLOAD WE DID NOT AUTHORISE IS TREATED AS A DEFECT, NOT AS NOISE.
 *     {@link initSpellcheck} subscribes to `spellcheck-dictionary-download-begin`
 *     and, if the language is not in the grant record, disarms the checker and
 *     reports a synthetic error. Chromium fires that event once the fetch is
 *     already under way, so this DETECTS AND CONTAINS rather than prevents: it
 *     stops the next request and makes the hole visible. It is defence in depth
 *     against a branch we did not think of (a persisted Chromium preference, a
 *     future call site) — the invariant is enforced, not merely intended.
 *
 * PII. The three inputs this file could leak are the words being checked, the
 * user's chosen languages, and third-party error text. None reaches telemetry:
 * the metric tags are a fixed enum plus a COUNT of languages, the local log
 * carries counts and closed classes, and thrown values are classified by
 * prototype chain (never `err.name`/`err.message`, both assignable). The
 * misspelled word itself never enters this module at all — it lives in the
 * context menu, which hands it straight back to `webContents.replaceMisspelling`
 * (./contextMenu.ts).
 */
import { app, dialog, BrowserWindow, session, type Session, type WebContents } from 'electron'
import { createLogger } from '../logger'
import { captureException } from '../sentry'
import { recordEvent } from '../metrics'
import { SPELLCHECK_MAX_LANGUAGES, type Settings } from '../../packages/net/config'
// The renderer's own translation resources, read directly rather than copied —
// see the CONTEXT_MENU_LABELS comment in ./contextMenu.ts for why (the i18n
// merge gate can only see what lives in these files) and for the measured
// bundle cost of doing it this way.
import enLocale from '../../src/i18n/locales/en.json'
import ruLocale from '../../src/i18n/locales/ru.json'
import frLocale from '../../src/i18n/locales/fr.json'
import deLocale from '../../src/i18n/locales/de.json'
import esLocale from '../../src/i18n/locales/es.json'
import itLocale from '../../src/i18n/locales/it.json'

const log = createLogger('Spellcheck')

/**
 * Where Chromium fetches hunspell dictionaries from when the download URL is
 * left at its default.
 *
 * Named here because the consent dialog must say it out loud: "a dictionary
 * file will be downloaded from <this>" is the entire content of the decision
 * the user is being asked to make, and a prompt that hides the counterparty is
 * not consent (CLAUDE.md §5 "Telemetry consent" makes the same point about
 * disclosure matching what is actually sent).
 *
 * This module never CHANGES the URL — pointing it elsewhere would only move
 * which third party is contacted, and a self-hosted mirror is not a capability
 * anyone asked for. It reads it into the prompt and nothing else.
 */
export const DICTIONARY_DOWNLOAD_ORIGIN = 'redirector.gvt1.com (Google)'

/** True on the platform whose OS owns the spellchecker language list. */
export function isPlatformOwnedSpellcheck(platform: string = process.platform): boolean {
  return platform === 'darwin'
}

// --- Pure half -------------------------------------------------------------

/** What the platform reports it can spellcheck, as observed by main. */
export interface SpellcheckAvailability {
  languages: string[]
  platformOwned: boolean
}

/**
 * The subset of `Settings` this service reads when deciding what to apply.
 *
 * `spellcheckAvailable` is deliberately ABSENT: it is main's own report OUT to
 * the Settings window, never an input to a decision — the live availability is
 * read from the session every time ({@link readSpellcheckAvailability}), so a
 * stored copy could only ever be the stale one. Listing it here made a second,
 * drifting shape of that field (it had already lost `max`).
 */
export interface SpellcheckSettingsView {
  spellcheckEnabled?: boolean
  spellcheckLanguages?: string[]
  spellcheckDictionaryConsent?: { granted: string[]; at: string }
}

/**
 * Reduce a requested language list to what may actually be applied.
 *
 * Three separate reductions, in this order, and each one is load-bearing:
 *
 *  - MEMBERSHIP in the live availability list. `setSpellCheckerLanguages`
 *    THROWS on a code Chromium does not know, and that call sits on the
 *    settings-save path — one stale entry persisted by an older build would
 *    otherwise turn every later save into a failure. Matching is
 *    case-insensitive but the CANONICAL casing from the availability list is
 *    what is returned: Chromium answers `en-US`, and a renderer echoing
 *    `en-us` should not become a second, non-matching entry.
 *  - DEDUPLICATION, on the same case-insensitive key.
 *  - the {@link SPELLCHECK_MAX_LANGUAGES} CAP, applied last so that a truncated
 *    list is truncated from a list of real languages rather than from one
 *    padded with junk.
 *
 * Order of the request is preserved: it is the order the user built in the
 * picker, and Chromium checks against all enabled dictionaries anyway.
 */
export function normalizeSpellcheckLanguages(
  requested: readonly string[] | undefined,
  available: readonly string[],
  max: number = SPELLCHECK_MAX_LANGUAGES,
): string[] {
  if (!Array.isArray(requested) || requested.length === 0) return []
  const canonical = new Map<string, string>()
  for (const entry of available) {
    if (typeof entry === 'string' && entry) canonical.set(entry.toLowerCase(), entry)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of requested) {
    if (typeof raw !== 'string') continue
    const key = raw.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    const match = canonical.get(key)
    if (!match) continue
    seen.add(key)
    out.push(match)
    if (out.length >= max) break
  }
  return out
}

/**
 * Which of the requested languages still need a human answer before their
 * dictionary may be fetched.
 *
 * `platformOwned` collapses the whole question: macOS downloads nothing, so
 * asking there would be a prompt about an event that cannot happen — and a
 * prompt the user cannot make sense of is how people are trained to click
 * through the ones that matter.
 *
 * Comparison is case-insensitive for the reason given in
 * {@link normalizeSpellcheckLanguages}: the grant record was written from a
 * canonical list, and a differently-cased echo must not read as "never
 * granted" and re-prompt forever.
 */
export function planDictionaryConsent(input: {
  requested: readonly string[]
  granted: readonly string[] | undefined
  platformOwned: boolean
}): { needed: string[] } {
  if (input.platformOwned) return { needed: [] }
  const granted = new Set((input.granted ?? []).map(l => l.toLowerCase()))
  return { needed: input.requested.filter(l => !granted.has(l.toLowerCase())) }
}

/**
 * The effective session state for a settings object.
 *
 * `enabled` is a CONJUNCTION, not the stored flag: on a downloading platform a
 * checker with no language would fall back to `en-US` (Electron's documented
 * behaviour for an empty list) and fetch that dictionary — the exact silent
 * request this feature exists to remove. So "on with nothing chosen" resolves
 * to off. On macOS there is nothing to choose and the flag stands alone.
 */
export function resolveSpellcheckSession(
  settings: SpellcheckSettingsView,
  availability: SpellcheckAvailability,
): { enabled: boolean; languages: string[] } {
  const languages = availability.platformOwned
    ? []
    : normalizeSpellcheckLanguages(
      // Only consented languages may be armed. The settings-save gate already
      // drops the rest, but this is the layer that also covers a value that
      // never passed through it: a persisted list from a build before the
      // consent record existed, or one hand-edited into the store.
      (settings.spellcheckLanguages ?? []).filter(l =>
        (settings.spellcheckDictionaryConsent?.granted ?? [])
          .some(g => g.toLowerCase() === l.toLowerCase()),
      ),
      availability.languages,
    )
  const enabled = settings.spellcheckEnabled === true
    && (availability.platformOwned || languages.length > 0)
  // ONE meaning for the pair: "what to apply". A disabled checker reports no
  // languages, so a caller reading `.languages` without also reading `.enabled`
  // cannot arm a dictionary the user turned off — the failure direction of a
  // two-field answer is that someone reads one field.
  return { enabled, languages: enabled ? languages : [] }
}

/**
 * Fold a consent answer into the two fields a save must write.
 *
 * Pure, and separate from the dialog, so the "declined ⇒ not enabled, and the
 * refusal is not persisted" rule is assertable without Electron. The grant list
 * is a UNION with what was already granted: a user who consented to Russian
 * last month and adds German today has not withdrawn Russian, and re-asking
 * for it would be the click-training this design avoids.
 */
export function applySpellcheckDecision(input: {
  /** Languages the payload asked for, already normalised against availability. */
  requested: readonly string[]
  /** Languages a human accepted during THIS save (empty when nothing was asked). */
  approvedNow: readonly string[]
  previousConsent: { granted: string[]; at: string } | undefined
  platformOwned: boolean
  now: string
}): { spellcheckLanguages: string[]; spellcheckDictionaryConsent?: { granted: string[]; at: string } } {
  const previouslyGranted = input.previousConsent?.granted ?? []
  const grantedKeys = new Set(previouslyGranted.map(l => l.toLowerCase()))
  const approvedKeys = new Set(input.approvedNow.map(l => l.toLowerCase()))

  // On macOS nothing is downloaded, so nothing is gated and no record is
  // written — a consent record there would claim an answer to a question the
  // user was never asked.
  const spellcheckLanguages = input.platformOwned
    ? [...input.requested]
    : input.requested.filter(l => grantedKeys.has(l.toLowerCase()) || approvedKeys.has(l.toLowerCase()))

  const newlyGranted = input.approvedNow.filter(l => !grantedKeys.has(l.toLowerCase()))
  if (input.platformOwned || newlyGranted.length === 0) {
    return input.previousConsent
      ? { spellcheckLanguages, spellcheckDictionaryConsent: input.previousConsent }
      : { spellcheckLanguages }
  }
  return {
    spellcheckLanguages,
    spellcheckDictionaryConsent: {
      granted: [...previouslyGranted, ...newlyGranted],
      at: input.now,
    },
  }
}

// --- Prompt ----------------------------------------------------------------

/** The keys of the `spellcheck.*` block in src/i18n/locales/*.json. */
export type SpellcheckLabelKey =
  | 'consentTitle'
  | 'consentMessage'
  | 'consentDetail'
  | 'consentLanguages'
  | 'consentButton'
  | 'cancelButton'
  | 'declined'

const SPELLCHECK_LABELS: Record<string, Record<SpellcheckLabelKey, string>> = {
  en: enLocale.spellcheck,
  ru: ruLocale.spellcheck,
  fr: frLocale.spellcheck,
  de: deLocale.spellcheck,
  es: esLocale.spellcheck,
  it: itLocale.spellcheck,
}

/** Labels for `lang`, falling back to English for an unknown language.
 *  ADDING A LANGUAGE: add the locale file and one line above — the locale-walk
 *  test in spellcheck.test.ts fails if a shipped locale is missing here, so a
 *  forgotten line is a red test rather than a silently English prompt. */
export function spellcheckLabels(lang: string): Record<SpellcheckLabelKey, string> {
  return SPELLCHECK_LABELS[lang] ?? SPELLCHECK_LABELS.en
}

export interface SpellcheckPrompt {
  title: string
  message: string
  detail: string
  buttons: [string, string]
}

/**
 * Build the consent prompt.
 *
 * The language codes and the counterparty are IN the text, not abstracted into
 * "allow spell checking": the person is agreeing to a specific outbound
 * request, and a prompt that does not name what leaves the machine cannot be
 * the informed answer this gate is claiming to have collected.
 *
 * Codes rather than translated language names: the code is what is requested
 * from the CDN, and it is what the Settings window shows next to the entry, so
 * the two screens describe the same object. Names live in the renderer, where
 * `Intl.DisplayNames` can produce them for the UI language.
 */
export function buildSpellcheckPrompt(
  languages: readonly string[],
  labels: Record<SpellcheckLabelKey, string>,
): SpellcheckPrompt {
  return {
    title: labels.consentTitle,
    message: labels.consentMessage,
    detail: [
      `${labels.consentLanguages}: ${languages.join(', ')}`,
      '',
      labels.consentDetail.replace('{{origin}}', DICTIONARY_DOWNLOAD_ORIGIN),
    ].join('\n'),
    // Cancel first and as both `defaultId` and `cancelId`: the safe answer is
    // the one a stray Enter or Esc produces (same rule as the AI destination
    // and certificate dialogs).
    buttons: [labels.cancelButton, labels.consentButton],
  }
}

// --- Telemetry -------------------------------------------------------------

export type SpellcheckConsentOutcome =
  | 'accepted'
  | 'declined'
  | 'blocked_busy'
  | 'failed'
  | 'unconsented_download'

/**
 * Aggregate outcome counter (CLAUDE.md §8). The LANGUAGES are never a tag —
 * not the code, not a hash of it: a person's dictionary set is a statement
 * about who they are. What is emitted is how the answer ended, and how many
 * languages it was about.
 */
function recordConsentOutcome(outcome: SpellcheckConsentOutcome, count: number): void {
  try {
    recordEvent('spellcheck.dictionary_consent', { outcome, language_count: count })
  } catch { /* telemetry must not block the security decision */ }
}

// --- Session application (the single writer) --------------------------------

export interface SpellcheckDeps {
  getSettings: () => Settings
  saveSettings: (s: Settings) => void
  /** UI language for the consent prompt. */
  getLanguage: () => string
  /**
   * True when the harness is driving the app. The session is left DISARMED
   * then: a test must not make the machine fetch dictionaries from a third
   * party, and no spec can assert Chromium's own suggestion quality anyway.
   * Everything else — settings, consent, refusal, the menu plan — runs.
   */
  isE2E: () => boolean
}

let deps: SpellcheckDeps | null = null
/** At most one consent dialog at a time — see {@link ensureSpellcheckDictionariesApproved}. */
let promptInFlight = false

/** Sessions this module has already subscribed a download guard on. */
const guardedSessions = new WeakSet<Session>()

/**
 * Read what the platform actually offers.
 *
 * Fail-closed on error: an availability list we could not read is reported as
 * EMPTY, which resolves every downstream question to "nothing may be enabled".
 * The alternative (treat unknown as permitted) would let a failure arm the
 * checker.
 */
export function readSpellcheckAvailability(sess: Session): SpellcheckAvailability {
  const platformOwned = isPlatformOwnedSpellcheck()
  try {
    const languages = sess.availableSpellCheckerLanguages ?? []
    return { languages: [...languages], platformOwned }
  } catch (err) {
    log.warn('spellchecker availability unreadable', { errorKind: classifyErrorKind(err) })
    return { languages: [], platformOwned }
  }
}

/** Prototype-chain classification. Never `err.name` — it is assignable, and an
 *  arbitrary throw can put anything (including PII) in it. */
function classifyErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'TypeError'
  if (err instanceof RangeError) return 'RangeError'
  if (err instanceof Error) return 'Error'
  return 'UnknownError'
}

/**
 * Apply the settings to one session. The only place that applies the ORDINARY
 * policy to Chromium's spellchecker state — {@link attachDownloadGuard} also
 * calls `setSpellCheckerEnabled(false)`, but that is emergency disarming on a
 * path this file treats as a defect, not a second policy writer. Nothing
 * outside this module touches those APIs at all.
 *
 * ORDER FOLLOWS THE TARGET STATE, and both directions are load-bearing:
 *
 *  - Arming: languages FIRST, then the switch. A checker armed while its
 *    language list is still the previous one — or Electron's OS-locale default,
 *    which an empty list produces — is precisely the window in which an
 *    unconsented dictionary gets fetched.
 *  - Disarming: the switch FIRST, then clearing the list. The same OS-locale
 *    refill applies to an empty list, so clearing while the checker is still on
 *    opens that window from the other side. The download guard can only observe
 *    a request that already began; it cannot un-send one.
 *
 * Returns what was ACTUALLY applied, not what was resolved: callers emit
 * telemetry from it, and the E2E disarm and the failure branch below both make
 * the resolved state a lie.
 *
 * Idempotent and defensive: every Electron call is wrapped, because
 * `setSpellCheckerLanguages` throws on a code it does not know and this runs on
 * the settings-save path — a throw here would fail a save that has nothing to
 * do with spelling. The intersection above should make that unreachable; the
 * wrapper is what keeps "should" from being load-bearing.
 */
function applyToSession(
  sess: Session,
  settings: SpellcheckSettingsView,
): { enabled: boolean; languages: string[] } {
  const availability = readSpellcheckAvailability(sess)
  const state = resolveSpellcheckSession(settings, availability)
  const armed = state.enabled && !(deps?.isE2E() ?? false)
  try {
    if (armed) {
      if (!availability.platformOwned) sess.setSpellCheckerLanguages(state.languages)
      sess.setSpellCheckerEnabled(true)
    } else {
      sess.setSpellCheckerEnabled(false)
      if (!availability.platformOwned) sess.setSpellCheckerLanguages([])
    }
    return { enabled: armed, languages: armed ? state.languages : [] }
  } catch (err) {
    log.warn('applying spellchecker state failed', {
      errorKind: classifyErrorKind(err),
      languageCount: state.languages.length,
    })
    // Direction of failure: disarm. A half-applied state must not leave a
    // checker running against a language set we did not authorise.
    try { sess.setSpellCheckerEnabled(false) } catch { /* nothing further to do */ }
    return { enabled: false, languages: [] }
  }
}

/**
 * Defence in depth (see header point 6): a dictionary download that begins for
 * a language with no grant record is a defect in this file, not a user action.
 *
 * WHAT THIS IS, precisely: DETECTION AND CONTAINMENT of a request that has
 * ALREADY BEGUN — not prevention of it. `spellcheck-dictionary-download-begin`
 * is Chromium's event, fired once the fetch is under way, and nothing here can
 * un-send it. Prevention is the job of the layers above (never arming a
 * language without a recorded consent); this layer exists because a layer that
 * is only intended is not enforced. The response is to DISARM rather than to
 * merely report, so the NEXT request does not happen either, and the hole is
 * visible instead of silent.
 *
 * THE REGISTRY MEANS "SUBSCRIBED", NOT "TRIED". `guardedSessions` is marked
 * only after `sess.on` returned, so a subscription that threw is retried by the
 * next apply (a second window on the same session, a settings save, a
 * re-apply). Marking first made the early return above lock the failure in:
 * one throw and the session lost its guard for the rest of its life, silently —
 * the same inverted failure direction this file rejects everywhere else.
 * De-duplication survives, because the only way to reach the mark is a
 * subscription that actually succeeded.
 */
function attachDownloadGuard(sess: Session): void {
  if (guardedSessions.has(sess)) return
  try {
    sess.on('spellcheck-dictionary-download-begin', (_event, languageCode) => {
      const settings = safeSettings()
      const granted = settings?.spellcheckDictionaryConsent?.granted ?? []
      if (granted.some(g => g.toLowerCase() === String(languageCode).toLowerCase())) return
      // The language code is Chromium's, but it is also a fact about this user,
      // so it goes to the LOCAL log only (never Sentry, never a metric tag).
      log.warn('dictionary download began without a recorded consent — disarming spellchecker')
      log.debug('unconsented dictionary language:', languageCode)
      recordConsentOutcome('unconsented_download', 1)
      try { sess.setSpellCheckerEnabled(false) } catch { /* best effort */ }
      // Best-effort, like every other telemetry call here: this callback runs
      // later, OUTSIDE the subscribe-time try enclosing it, and a reporting
      // failure must not surface out of an Electron event handler on a security
      // path (CLAUDE.md §8).
      try {
        const sanitized = new Error('spellcheck_dictionary_download_unconsented')
        sanitized.name = 'SpellcheckConsentBypass'
        captureException(sanitized, { source: 'spellcheck' })
      } catch { /* telemetry must not block the disarm above */ }
    })
    guardedSessions.add(sess)
  } catch (err) {
    log.warn('subscribing to dictionary download events failed', { errorKind: classifyErrorKind(err) })
  }
}

/**
 * The stored settings, or `null` when they could not be read.
 *
 * EVERY CALLER THAT APPLIES POLICY MUST COLLAPSE `null` INTO AN EMPTY POLICY
 * (`?? {}`), never into "skip the apply". Skipping leaves Chromium at its own
 * default — enabled, OS locale, fetch on the first spellchecked field — which
 * is the exact state this service exists to remove, so an unreadable store
 * would fail in the permissive direction. An empty policy resolves to
 * "disabled, no languages" through {@link resolveSpellcheckSession}, which is
 * the safe direction and the same fail-closed rule as
 * {@link readSpellcheckAvailability}.
 *
 * The one legitimate reader of `null`-as-skip is {@link publishAvailability}:
 * it WRITES a settings object, and writing one built on a store it could not
 * read would clobber every other setting.
 */
function safeSettings(): Settings | null {
  try { return deps?.getSettings() ?? null } catch { return null }
}

/**
 * Wire the service and apply the stored policy to the default session.
 *
 * MUST run before the first window loads content: Electron populates an empty
 * language list from the OS locale on launch, and the fetch follows the first
 * spellchecked field. Called from `app.whenReady()` ahead of `createWindow()`.
 */
export function initSpellcheck(injected: SpellcheckDeps): void {
  deps = injected
  const sess = session.defaultSession
  attachDownloadGuard(sess)
  // `?? {}` and not `if (settings)` — see {@link safeSettings}. An unreadable
  // store must disarm the checker, not leave Chromium's default armed.
  const applied = applyToSession(sess, safeSettings() ?? {})
  publishAvailability(sess)
  try {
    recordEvent('spellcheck.configured', {
      enabled: applied.enabled,
      language_count: applied.languages.length,
      platform_owned: readSpellcheckAvailability(sess).platformOwned,
    })
  } catch { /* telemetry must not block startup */ }
}

/**
 * Write main's report of the platform language set into settings, so the
 * Settings window can render the picker without a new IPC channel.
 *
 * Written only when it CHANGED, compared on content: an unconditional write on
 * every launch would churn the store (and its watchers) for nothing.
 */
function publishAvailability(sess: Session): void {
  try {
    const current = deps?.getSettings()
    if (!current) return
    const availability = readSpellcheckAvailability(sess)
    const previous = current.spellcheckAvailable
    const same = previous
      && previous.platformOwned === availability.platformOwned
      && previous.max === SPELLCHECK_MAX_LANGUAGES
      && previous.languages.length === availability.languages.length
      && previous.languages.every((l, i) => l === availability.languages[i])
    if (same) return
    deps?.saveSettings({
      ...current,
      spellcheckAvailable: {
        languages: availability.languages,
        platformOwned: availability.platformOwned,
        // Reported, not duplicated on the renderer side — see the field's
        // JSDoc in packages/net/config.ts.
        max: SPELLCHECK_MAX_LANGUAGES,
        at: new Date().toISOString(),
      },
    })
  } catch (err) {
    // A report we could not persist costs the picker its options, nothing else.
    log.warn('publishing spellchecker availability failed', { errorKind: classifyErrorKind(err) })
  }
}

/**
 * Apply the policy to a window's session at creation time.
 *
 * Windows share `session.defaultSession` today, so this is normally a repeat of
 * what {@link initSpellcheck} did — deliberately. The invariant is "no window
 * exists whose session was configured by nobody", and holding it here means a
 * future window created with its own partition inherits the policy instead of
 * inheriting Chromium's default (armed, OS locale, download).
 */
export function applySpellcheckToWindow(win: BrowserWindow): void {
  if (!deps) return
  try {
    const sess = win.webContents.session
    attachDownloadGuard(sess)
    // `?? {}` and not `if (settings)` — see {@link safeSettings}.
    applyToSession(sess, safeSettings() ?? {})
  } catch (err) {
    log.warn('applying spellchecker state to a window failed', { errorKind: classifyErrorKind(err) })
  }
}

/**
 * Re-apply after a settings change, to every live window's session.
 *
 * Deduplicated by session identity rather than by window: one `defaultSession`
 * shared by six windows is one application, and calling six times would emit
 * six identical Chromium state changes.
 */
export function reapplySpellcheck(): void {
  if (!deps) return
  // `?? {}` and not an early return — see {@link safeSettings}. A settings read
  // that failed must disarm the live sessions, not leave whatever they were
  // last armed with in place.
  const settings = safeSettings() ?? {}
  const seen = new Set<Session>()
  let applied: { enabled: boolean; languages: string[] } | null = null
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      const sess = win.webContents.session
      if (seen.has(sess)) continue
      seen.add(sess)
      attachDownloadGuard(sess)
      applied = applyToSession(sess, settings)
    } catch (err) {
      log.warn('re-applying spellchecker state failed', { errorKind: classifyErrorKind(err) })
    }
  }
  if (seen.size === 0) {
    try { applied = applyToSession(session.defaultSession, settings) } catch { /* nothing to apply to */ }
  }
  try {
    // The APPLIED outcome, not the resolved one: under the harness, or after a
    // failed apply, the two differ and only the first is true.
    const outcome = applied ?? { enabled: false, languages: [] }
    recordEvent('spellcheck.configured', {
      enabled: outcome.enabled,
      language_count: outcome.languages.length,
      platform_owned: readSpellcheckAvailability(session.defaultSession).platformOwned,
    })
  } catch { /* telemetry must not block a settings save */ }
}

// --- Consent ---------------------------------------------------------------

export interface SpellcheckConsentVerdict {
  /** Languages a human accepted during this call (possibly empty). */
  approved: string[]
  /** Languages that were asked about and refused, or refused without asking. */
  declined: string[]
  /** The availability the decision was made against — the caller normalises with it. */
  availability: SpellcheckAvailability
}

/**
 * Ask the human about every requested language whose dictionary would have to
 * be downloaded, and answer with what may be enabled.
 *
 * WRITES NOTHING. Like ./aiDestinationGuard.ts, the gate only answers; the
 * caller folds the answer into the save it was already making
 * ({@link applySpellcheckDecision}). That is what keeps a refusal
 * non-destructive: the stored languages and the stored consent record are
 * untouched on every path through here.
 *
 * ONE DIALOG AT A TIME. A second request arriving while one is open is REFUSED,
 * not queued: queueing lets a compromised renderer stack prompts faster than a
 * person can read them, and any answer to the second box is an answer to a
 * question the user was pushed into.
 */
export async function ensureSpellcheckDictionariesApproved(
  requestedRaw: readonly string[] | undefined,
  sender?: WebContents,
): Promise<SpellcheckConsentVerdict> {
  const availability = readSpellcheckAvailability(session.defaultSession)
  const requested = normalizeSpellcheckLanguages(requestedRaw, availability.languages)
  const empty: SpellcheckConsentVerdict = { approved: [], declined: [], availability }
  if (requested.length === 0) return empty

  const settings = safeSettings()
  const { needed } = planDictionaryConsent({
    requested,
    granted: settings?.spellcheckDictionaryConsent?.granted,
    platformOwned: availability.platformOwned,
  })
  if (needed.length === 0) return empty

  if (promptInFlight) {
    log.warn('dictionary consent refused: a confirmation is already open', { count: needed.length })
    recordConsentOutcome('blocked_busy', needed.length)
    return { approved: [], declined: needed, availability }
  }

  promptInFlight = true
  let accepted = false
  try {
    const prompt = buildSpellcheckPrompt(needed, spellcheckLabels(deps?.getLanguage() ?? 'en'))
    accepted = await confirmSpellcheckNatively(prompt, sender)
  } catch (err) {
    // A dialog that could not be shown is not an acceptance.
    log.warn('dictionary consent failed to complete', { errorKind: classifyErrorKind(err) })
    recordConsentOutcome('failed', needed.length)
    return { approved: [], declined: needed, availability }
  } finally {
    promptInFlight = false
  }

  if (!accepted) {
    log.info('dictionary download declined by the user', { count: needed.length })
    recordConsentOutcome('declined', needed.length)
    return { approved: [], declined: needed, availability }
  }
  log.info('dictionary download approved by the user', { count: needed.length })
  recordConsentOutcome('accepted', needed.length)
  return { approved: needed, declined: [], availability }
}

/**
 * The native dialog.
 *
 * `IS_E2E && !app.isPackaged` short-circuits to ACCEPTED, exactly as in
 * `confirmAiDestinationNatively` and `confirmCertTrustNatively`: the harness
 * cannot drive a native dialog, and BOTH halves are required — `MAILCOPILOT_E2E`
 * is an environment variable anything running as the user can set, so on a
 * shipped build the flag must buy nothing. Accepting here is safe under the
 * harness because the session is left disarmed there anyway
 * ({@link SpellcheckDeps.isE2E}), so no dictionary is ever fetched during a run.
 */
async function confirmSpellcheckNatively(
  prompt: SpellcheckPrompt,
  sender?: WebContents,
): Promise<boolean> {
  if (process.env.MAILCOPILOT_E2E === '1' && !app.isPackaged) return true
  const opts = {
    type: 'question' as const,
    title: prompt.title,
    message: prompt.message,
    detail: prompt.detail,
    buttons: [...prompt.buttons],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const parent = sender ? BrowserWindow.fromWebContents(sender) : null
  const result = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts)
  // Anything that is not the explicit second button — Cancel, Esc, a destroyed
  // parent window (response −1) — is a refusal.
  return result.response === 1
}

/** Localized notice for a save whose dictionary download was declined. */
export function spellcheckDeclinedMessage(lang: string): string {
  return spellcheckLabels(lang).declined
}

/** Test-only: drop the in-flight flag and the injected deps. */
export function resetSpellcheckForTest(): void {
  deps = null
  promptInFlight = false
}
