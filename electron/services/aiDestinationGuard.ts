/**
 * Human confirmation for a change of the address AI requests are sent to.
 * BACKLOG §2.119.
 *
 * THE DEFECT. `aiOpenAiBaseUrl` and `aiProxyUrl` are members of
 * `rendererWritableSettingsSchema`, so an ordinary `settings:save` moves them.
 * The endpoint decides who the TLS peer of a request carrying
 * `Authorization: Bearer <the user's API key>` is — an attacker-chosen host
 * there holds the key and every prompt outright, which under this project's
 * threat model (a compromised renderer must not reach secrets held by main) is
 * a complete exfiltration primitive: no dialog, no restart, the very next
 * request goes to them. The proxy is a weaker but real version of the same
 * move: an ordinary forward proxy is reached by `CONNECT`, so it learns which
 * addresses the user contacts and how often rather than the key itself, and it
 * reads contents only over a cleartext endpoint or through TLS interception
 * with an already-trusted certificate. Both change who is on the path of a
 * secret, and neither should happen without a human — but the prompt says
 * about each only what is true of it (see {@link buildAiDestinationPrompt}).
 *
 * WHY NOT MAKE THEM MAIN-ONLY. Pointing the client at a self-hosted or
 * third-party OpenAI-compatible endpoint is a wanted capability, and so is a
 * corporate proxy; there is no other UI for either. The defect is not that the
 * setting exists, it is that changing *where a secret is sent* required no
 * human. So the remedy is the one `net:trustCert` uses: a native
 * `dialog.showMessageBox` drawn by the OS in the main process, naming the
 * concrete destination, which the renderer cannot script, focus, pre-answer or
 * read.
 *
 * WHY THERE IS NO TOKEN, AND WHY THAT IS THE POINT. The obvious-looking design
 * — main hands the renderer an "offer id" and only accepts a change that
 * quotes it — is exactly the mistake CLAUDE.md §5 records for `net:trustCert`
 * and `ai:auditLog:clear`: every value in such a gate is one main itself sent
 * to the renderer, so a compromised renderer replays it and the gate passes
 * with nothing ever shown to a human. Here the renderer supplies no proof at
 * all. The only thing that admits a destination is {@link approved}, a
 * main-process, session-scoped set whose sole writer is the `true` branch of
 * the dialog's own return value. There is nothing for the renderer to forge,
 * capture or replay — the worst it can do is make a dialog appear, which is
 * the intended behaviour.
 *
 * WHAT COUNTS AS A CHANGE lives in the pure half, ./aiDestination.ts.
 *
 * REFUSAL IS NON-DESTRUCTIVE: the guard writes no settings itself, it only
 * answers. The caller keeps the previous address and tells the renderer the
 * change was declined — never that it succeeded.
 */
import { app, dialog, BrowserWindow, type WebContents } from 'electron'
import { createLogger } from '../logger'
import { recordEvent } from '../metrics'
import { getSettings } from '../../packages/net/config'
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
import {
  aiDestinationApprovalKey,
  describeEffectiveAiEndpoint,
  isCleartextDestination,
  planAiDestinationChanges,
  type AiDestination,
  type AiDestinationChange,
  type AiDestinationField,
  type AiDestinationSettings,
} from './aiDestination'

const log = createLogger('AiDestinationGuard')

/** The keys of the `aiDestination.*` block in src/i18n/locales/*.json. */
export type AiDestinationLabelKey =
  | 'confirmTitle'
  | 'confirmMessage'
  | 'confirmDetail'
  | 'endpointLabel'
  | 'proxyLabel'
  | 'endpointRisk'
  | 'endpointRiskCleartext'
  | 'endpointRiskInactive'
  | 'endpointRiskInactiveCleartext'
  | 'proxyRisk'
  | 'proxyRiskCleartext'
  | 'currentValue'
  | 'newValue'
  | 'directValue'
  | 'confirmButton'
  | 'cancelButton'
  | 'declined'
  | 'invalid'
  | 'busy'

const AI_DESTINATION_LABELS: Record<string, Record<AiDestinationLabelKey, string>> = {
  en: enLocale.aiDestination,
  ru: ruLocale.aiDestination,
  fr: frLocale.aiDestination,
  de: deLocale.aiDestination,
  es: esLocale.aiDestination,
  it: itLocale.aiDestination,
}

/** Labels for `lang`, falling back to English for an unknown language.
 *  ADDING A LANGUAGE: add the locale file and one line above — the locale-walk
 *  test in aiDestinationGuard.test.ts fails if a shipped locale is missing
 *  here, so a forgotten line is a red test rather than a silently English
 *  security prompt. */
export function aiDestinationLabels(lang: string): Record<AiDestinationLabelKey, string> {
  return AI_DESTINATION_LABELS[lang] ?? AI_DESTINATION_LABELS.en
}

/** What the native dialog is asked to show. Pure data, so the wording of a
 *  security prompt is assertable without launching Electron. */
export interface AiDestinationPrompt {
  title: string
  message: string
  detail: string
  buttons: [string, string]
}

/**
 * The endpoint sentence for the state the user lands in.
 *
 * The cleartext half is judged on the address BEING APPROVED (`to`), not on the
 * effective-state flag: when the endpoint is the field changing, `to` IS the
 * effective endpoint, and when the provider makes it inert the scheme still
 * belongs in the sentence — it describes what will happen once that provider is
 * selected, which is the only thing approving this value can lead to.
 */
function endpointSentence(
  labels: Record<AiDestinationLabelKey, string>,
  active: boolean,
  to: AiDestination,
): string {
  const cleartext = isCleartextDestination(to)
  if (active) return cleartext ? labels.endpointRiskCleartext : labels.endpointRisk
  return cleartext ? labels.endpointRiskInactiveCleartext : labels.endpointRiskInactive
}

/**
 * Build the prompt text.
 *
 * The concrete addresses are IN THE PROMPT deliberately, current and new side
 * by side: the person confirms one specific endpoint, not an abstract "allow a
 * settings change" (same reasoning as the fingerprint in the certificate
 * dialog). Values are the canonical `display` forms — punycode host, explicit
 * port, no credentials — never the raw string the renderer sent.
 *
 * THE RISK SENTENCE IS PER FIELD, and it is per field because the two risks are
 * not the same one. An endpoint operator is the TLS peer: they hold the API key
 * and every prompt. An ordinary forward proxy is reached by `CONNECT`, and over
 * an https endpoint TLS then runs end to end past it, so it sees where the
 * requests go, how many and when — not the `Authorization` header, not the
 * body. Telling the user a proxy "receives your key" would be false in that
 * case, and a security prompt that overstates its own risk teaches people to
 * distrust every prompt we draw.
 *
 * EACH SENTENCE DESCRIBES THE STATE AFTER APPROVAL, NOT THE FIELD THAT MOVED.
 * That is why `next` is a parameter and why the variants are selected from the
 * EFFECTIVE state rather than from which input the user edited. Over an
 * `http://` endpoint there is no tunnel to speak of: an ordinary proxy reads
 * the key and the messages outright, with no interception and no certificate
 * involved. Keying the cleartext wording off "the endpoint field is the one
 * changing" produced a reachable lie — a user whose endpoint was ALREADY
 * `http://` could change only the proxy and be told, in a native dialog, that
 * this proxy could not read their key. It can. The variants replace the base
 * sentence rather than being appended to it: a person deciding whether to
 * approve needs one statement of what the other party will see, not a
 * conjunction they have to resolve themselves.
 *
 * THE STATE IS COMPOSITE — provider × endpoint scheme — and is computed once,
 * by {@link describeEffectiveAiEndpoint}, instead of being inferred from parts
 * at each sentence. The endpoint setting is inert under every provider but the
 * OpenAI-compatible one, so: an unused `http://` value in settings must not
 * make the PROXY warning claim the proxy reads the key (it does not — Gemini
 * and Anthropic are https), and an endpoint change made
 * while another provider is selected must be described as taking effect when
 * that provider is chosen, not as rerouting requests now. `next.aiProvider` is
 * the provider AFTER the pending save (or the one `ai:checkAuth` was told to
 * test), so a save that switches provider and endpoint together is described by
 * the combination it produces.
 *
 * An endpoint that resolves to neither http nor https (`invalid`) selects the
 * https-flavoured wording: nothing reaches the network at all in that state —
 * the request layer refuses to build a URL from it — so the cleartext claim
 * would be the false one there.
 */
export function buildAiDestinationPrompt(
  changes: readonly AiDestinationChange[],
  labels: Record<AiDestinationLabelKey, string>,
  next: AiDestinationSettings,
): AiDestinationPrompt {
  // The state the user will be in after approving — for an endpoint change the
  // endpoint is that change's `to`, for a proxy-only change it is the stored
  // value, and in both cases it counts only under the provider that will be in
  // force.
  const endpoint = describeEffectiveAiEndpoint(next)
  const blocks = changes.map(change => {
    const isProxy = change.field === 'aiProxyUrl'
    const fieldLabel = isProxy ? labels.proxyLabel : labels.endpointLabel
    const from = change.from.kind === 'url' ? change.from.display : labels.directValue
    const to = change.to.kind === 'url' ? change.to.display : labels.directValue
    const risk = isProxy
      ? (endpoint.cleartext ? labels.proxyRiskCleartext : labels.proxyRisk)
      : endpointSentence(labels, endpoint.active, change.to)
    return [
      fieldLabel,
      `  ${labels.currentValue}: ${from}`,
      `  ${labels.newValue}: ${to}`,
      risk,
    ].join('\n')
  })
  return {
    title: labels.confirmTitle,
    message: labels.confirmMessage,
    detail: `${blocks.join('\n\n')}\n\n${labels.confirmDetail}`,
    // Cancel first and as both `defaultId` and `cancelId`: the safe answer is
    // the one a stray Enter or Esc produces.
    buttons: [labels.cancelButton, labels.confirmButton],
  }
}

export type AiDestinationRejection = 'declined' | 'invalid' | 'busy'

export type AiDestinationVerdict =
  | { ok: true; prompted: boolean }
  | { ok: false; reason: AiDestinationRejection; fields: AiDestinationField[] }

export interface AiDestinationGuardDeps {
  /** The settings the change is judged against. Read INSIDE the critical
   *  section so a decision is never made against a stale baseline. */
  getCurrent: () => AiDestinationSettings
  /** Ask the human. Resolves `true` only for an explicit acceptance. */
  confirm: (prompt: AiDestinationPrompt, sender?: WebContents) => Promise<boolean>
  /** UI language for the prompt. */
  getLanguage: () => string
}

export interface AiDestinationGuard {
  ensureApproved: (
    next: AiDestinationSettings,
    sender?: WebContents,
  ) => Promise<AiDestinationVerdict>
  /** Test-only: drop session approvals and any stuck in-flight flag. */
  resetForTest: () => void
}

/** Aggregate, PII-clean outcome counter (CLAUDE.md §8): which field, and how
 *  the confirmation ended. The address itself is never a tag value — not the
 *  host, not a hash of it, not its length. */
function recordOutcome(
  fields: readonly AiDestinationField[],
  outcome: 'accepted' | 'declined' | 'blocked_invalid' | 'blocked_busy',
): void {
  try {
    for (const field of fields) {
      recordEvent('ai.destination_confirm', {
        field: field === 'aiProxyUrl' ? 'proxy' : 'endpoint',
        outcome,
      })
    }
  } catch { /* telemetry must not block the security decision */ }
}

export function createAiDestinationGuard(deps: AiDestinationGuardDeps): AiDestinationGuard {
  /**
   * Destinations a human has accepted during this run of the app.
   *
   * Session-scoped on purpose. It exists for one gap: the settings window
   * verifies a not-yet-saved address through `ai:checkAuth` and then saves it,
   * and asking twice for one decision is how a user is trained to click
   * through. It is NOT a trust store — after a restart the persisted value is
   * the baseline again, so nothing needs to survive, and a set that survives
   * has to be defended against everything that can write it.
   */
  const approved = new Set<string>()
  /** At most one dialog at a time — see {@link ensureApproved}. */
  let promptInFlight = false

  async function ensureApproved(
    next: AiDestinationSettings,
    sender?: WebContents,
  ): Promise<AiDestinationVerdict> {
    const changes = planAiDestinationChanges(deps.getCurrent(), next)
    if (changes.length === 0) return { ok: true, prompted: false }

    // A new destination that is not a usable http(s) address is refused
    // outright: the prompt has to name a host, and a value the request layer
    // cannot parse cannot be named. No dialog for this branch — it is a
    // malformed payload, not a decision.
    if (changes.some(c => c.to.kind !== 'url')) {
      const badFields = changes.filter(c => c.to.kind !== 'url').map(c => c.field)
      log.warn('AI destination change refused: unusable address', { fields: badFields })
      recordOutcome(badFields, 'blocked_invalid')
      return { ok: false, reason: 'invalid', fields: badFields }
    }

    const unapproved = changes.filter(c => !approved.has(aiDestinationApprovalKey(c)))
    if (unapproved.length === 0) return { ok: true, prompted: false }

    // A second change arriving while a dialog is open is REFUSED, not queued.
    // Queueing would let a compromised renderer stack dialogs faster than a
    // human can read them, and any answer given to the second box would be an
    // answer to a question the user was pushed into. One question at a time;
    // the caller is told nothing was applied and may ask again once the first
    // is answered.
    if (promptInFlight) {
      log.warn('AI destination change refused: a confirmation is already open', {
        fields: unapproved.map(c => c.field),
      })
      recordOutcome(unapproved.map(c => c.field), 'blocked_busy')
      return { ok: false, reason: 'busy', fields: unapproved.map(c => c.field) }
    }

    promptInFlight = true
    let accepted = false
    try {
      // `next`, not the changed fields: the risk wording describes the state
      // the user will be in after approving — see buildAiDestinationPrompt.
      const prompt = buildAiDestinationPrompt(unapproved, aiDestinationLabels(deps.getLanguage()), next)
      accepted = await deps.confirm(prompt, sender)
    } catch (err) {
      // A dialog that could not be shown is not an acceptance. What is logged
      // is derived from the PROTOTYPE CHAIN, never `err.name` or `err.message`
      // — both are assignable, so an arbitrary throw can put anything in them
      // (same rule as classifyContextMenuErrorKind in ./contextMenu.ts).
      log.warn('AI destination confirmation failed to complete', {
        errorKind: err instanceof TypeError ? 'TypeError'
          : err instanceof RangeError ? 'RangeError'
            : err instanceof Error ? 'Error' : 'UnknownError',
      })
      accepted = false
    } finally {
      promptInFlight = false
    }

    const changedFields = unapproved.map(c => c.field)
    if (!accepted) {
      log.warn('AI destination change declined by the user', { fields: changedFields })
      recordOutcome(changedFields, 'declined')
      return { ok: false, reason: 'declined', fields: changedFields }
    }

    for (const change of unapproved) approved.add(aiDestinationApprovalKey(change))
    log.info('AI destination change confirmed by the user', { fields: changedFields })
    recordOutcome(changedFields, 'accepted')
    return { ok: true, prompted: true }
  }

  return {
    ensureApproved,
    resetForTest() {
      approved.clear()
      promptInFlight = false
    },
  }
}

/**
 * The native dialog.
 *
 * `IS_E2E && !app.isPackaged` short-circuits, exactly as in
 * `confirmCertTrustNatively`: the harness cannot drive a native dialog, and
 * BOTH halves are required — `MAILCOPILOT_E2E` is an environment variable that
 * anything running as the user can set, so on a shipped build (where
 * `app.isPackaged` is true regardless of env tampering) the flag buys nothing.
 */
async function confirmAiDestinationNatively(
  prompt: AiDestinationPrompt,
  sender?: WebContents,
): Promise<boolean> {
  if (process.env.MAILCOPILOT_E2E === '1' && !app.isPackaged) return true
  const opts = {
    type: 'warning' as const,
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

let instance: AiDestinationGuard | null = null

/** Process-wide guard. Lazy so that importing this module reads no settings
 *  and builds no session state at load time; the electron import above is
 *  static and unavoidable — the dialog needs it — so what is deferred is the
 *  work, not the import graph. */
export function getAiDestinationGuard(): AiDestinationGuard {
  if (!instance) {
    instance = createAiDestinationGuard({
      getCurrent: () => getSettings(),
      getLanguage: () => {
        try {
          return getSettings().language ?? 'en'
        } catch {
          return 'en'
        }
      },
      confirm: confirmAiDestinationNatively,
    })
  }
  return instance
}

/**
 * Gate a requested AI destination state.
 *
 * `next` carries the EFFECTIVE values the caller is about to act on (post-merge
 * for a settings save, persisted-plus-overrides for a connection check), so
 * every route that can move the address is judged by the same comparison.
 */
export function ensureAiDestinationApproved(
  next: AiDestinationSettings,
  sender?: WebContents,
): Promise<AiDestinationVerdict> {
  return getAiDestinationGuard().ensureApproved(next, sender)
}

/** The localized sentence to hand the renderer for a refusal. */
export function aiDestinationRejectionMessage(
  reason: AiDestinationRejection,
  lang: string,
): string {
  const labels = aiDestinationLabels(lang)
  if (reason === 'invalid') return labels.invalid
  if (reason === 'busy') return labels.busy
  return labels.declined
}
