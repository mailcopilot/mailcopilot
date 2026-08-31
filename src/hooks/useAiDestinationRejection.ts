import { useCallback, useState } from 'react'

/**
 * Renderer half of BACKLOG §2.119 — "the address AI requests are sent to was
 * NOT changed".
 *
 * Main gates a change of `aiOpenAiBaseUrl` / `aiProxyUrl` behind a native
 * confirmation (electron/services/aiDestinationGuard.ts). When the change does
 * not go through, `settings:save` still returns `{ ok: true }` — every OTHER
 * edit in the same save was applied — and carries the refusal alongside:
 *
 *   { ok: true, aiDestinationRejected: { reason, fields, message } }
 *
 * Ignoring that field is worse than the defect §2.119 fixed: the settings
 * window would close, and closing is this window's only "saved" signal, so the
 * person walks away believing their key now goes somewhere it does not. This
 * hook exists so the window has a first-class answer to "was the thing I came
 * to change actually changed?" instead of an inline `if` in a 3800-line file.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: derive the sentence shown to the
 * user. `message` arrives already localized by main, which reads the very same
 * `src/i18n/locales/*.json` resources the renderer does. A second wording here
 * would drift from the native dialog the person just answered, and the two
 * texts describing one event would disagree. We render what we are given.
 */

/** How the confirmation ended, as reported by the main-process guard. */
export const AI_DESTINATION_REJECTION_REASONS = ['declined', 'invalid', 'busy'] as const
export type AiDestinationRejectionReason = (typeof AI_DESTINATION_REJECTION_REASONS)[number]

/** The two settings fields that decide where the AI API key is delivered. */
export const AI_DESTINATION_FIELDS = ['aiOpenAiBaseUrl', 'aiProxyUrl'] as const
export type AiDestinationField = (typeof AI_DESTINATION_FIELDS)[number]

/** A refusal, normalized for rendering. */
export interface AiDestinationRejection {
  reason: AiDestinationRejectionReason
  /** Fields whose address stayed as it was. May be empty on a malformed reply. */
  fields: AiDestinationField[]
  /** Localized by main. Empty string when the reply carried none. */
  message: string
}

function isRejectionReason(value: unknown): value is AiDestinationRejectionReason {
  return typeof value === 'string'
    && (AI_DESTINATION_REJECTION_REASONS as readonly string[]).includes(value)
}

function isDestinationField(value: unknown): value is AiDestinationField {
  return typeof value === 'string'
    && (AI_DESTINATION_FIELDS as readonly string[]).includes(value)
}

/**
 * Read a `settings:save` reply. Returns `null` when the save moved the address
 * (or never asked to), and a rejection otherwise.
 *
 * FAIL-VISIBLE, NOT FAIL-SILENT. The presence of the `aiDestinationRejected`
 * object is the whole trigger; a `reason` this build does not know, a missing
 * `fields` array or a missing `message` degrade the DETAIL of the notice but
 * never turn a refusal back into a success. The alternative — dropping a
 * payload we cannot fully parse — reintroduces the exact silent-close bug for
 * any future main that adds a fourth reason.
 */
export function parseAiDestinationRejection(result: unknown): AiDestinationRejection | null {
  if (typeof result !== 'object' || result === null) return null
  const payload = (result as { aiDestinationRejected?: unknown }).aiDestinationRejected
  if (typeof payload !== 'object' || payload === null) return null
  const raw = payload as { reason?: unknown; fields?: unknown; message?: unknown }
  return {
    // An unknown reason falls back to the calmest presentation: it is still a
    // refusal (the window stays open, main's sentence is shown), just without
    // an alarm we cannot justify.
    reason: isRejectionReason(raw.reason) ? raw.reason : 'declined',
    fields: Array.isArray(raw.fields) ? raw.fields.filter(isDestinationField) : [],
    message: typeof raw.message === 'string' ? raw.message : '',
  }
}

export interface UseAiDestinationRejectionReturn {
  /** Refusal to render, or null when there is nothing to say. */
  aiDestinationRejection: AiDestinationRejection | null
  /**
   * Record the outcome of one `settings:save`.
   *
   * Returns `true` when the save may be treated as complete (the window may
   * close), `false` when the address the user asked for was not applied. The
   * boolean is the contract the caller acts on — a caller that forgets to read
   * it closes the window, which is the defect this hook exists to prevent, so
   * it is deliberately the return value rather than a piece of state the caller
   * has to remember to consult.
   */
  recordSettingsSaveResult: (result: unknown) => boolean
  /** Drop the notice (e.g. before a fresh attempt). */
  clearAiDestinationRejection: () => void
}

export function useAiDestinationRejection(): UseAiDestinationRejectionReturn {
  const [rejection, setRejection] = useState<AiDestinationRejection | null>(null)

  const recordSettingsSaveResult = useCallback((result: unknown): boolean => {
    const parsed = parseAiDestinationRejection(result)
    // Cleared on every save, so a stale notice from an earlier attempt cannot
    // outlive the attempt that succeeded.
    setRejection(parsed)
    return parsed === null
  }, [])

  const clearAiDestinationRejection = useCallback(() => setRejection(null), [])

  return {
    aiDestinationRejection: rejection,
    recordSettingsSaveResult,
    clearAiDestinationRejection,
  }
}
