/**
 * ruleRefusalText — turns a mail-rule refusal into text the user can act on.
 *
 * The save paths refuse a rule with a machine-readable code
 * (`MAIL_RULE_REFUSED:<reason>:<field>[:<action>]`, see
 * `packages/core/mailRules.ts`) rather than a sentence, because the sentence
 * has to name the field in the user's own language. This module is the one
 * place that turns that code — and the `refused` half of the
 * `rules:applyToFolder` reply — into localised copy, so the editor cannot end
 * up telling the user something different from what the runner enforces.
 *
 * Pure and React-free on purpose: the caller passes its own `t`, which keeps
 * every branch testable without rendering a component (CLAUDE.md §7).
 */

import {
  findEncodedMailRuleRefusal,
  parseMailRuleRefusal,
  type MailRuleRefusal,
  type RuleActionType,
} from '@mailcopilot/core'

/** The subset of i18next's `t` this module needs. */
export type RuleTranslate = (key: string, options?: Record<string, unknown>) => string

/** Localised name of a condition field; unknown names degrade to the token. */
export function ruleFieldLabel(t: RuleTranslate, field: string): string {
  return t(`settings.rules.field.${field}`, { defaultValue: field })
}

/** Localised name of an action type. */
export function ruleActionLabel(t: RuleTranslate, action: RuleActionType): string {
  return t(`settings.rules.action.${action}`, { defaultValue: action })
}

/**
 * Recover a refusal from whatever `window.api.invoke` rejected with.
 *
 * `parseMailRuleRefusal` finds the code anywhere in the text, which is what
 * makes this survive the two prefixes the message picks up on the way here (the
 * IPC funnel's `[mcerr:…]` tag and Electron's "Error invoking remote method").
 * A rejection value that is neither a string nor an `Error` is retried through
 * its `message`, since a structured-clone copy of an error is a plain object.
 */
export function readMailRuleRefusal(err: unknown): MailRuleRefusal | null {
  const direct = parseMailRuleRefusal(err)
  if (direct) return direct

  if (err !== null && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return parseMailRuleRefusal(message)
  }
  return null
}

/**
 * Read the `refused` field of an IPC reply.
 *
 * Validated rather than cast: the value crosses a process boundary, and an
 * unrecognised reason must fall back to the generic sentence instead of being
 * interpolated into copy that promises a specific explanation.
 */
export function readRefusedReply(value: unknown): MailRuleRefusal | null {
  if (value === null || typeof value !== 'object') return null

  const { reason, field, action } = value as {
    reason?: unknown
    field?: unknown
    action?: unknown
  }
  if (
    reason !== 'malformed_rule' &&
    reason !== 'unsupported_field' &&
    reason !== 'unverifiable_sender'
  ) {
    return null
  }

  return {
    reason,
    field: typeof field === 'string' ? field : 'unknown',
    ...(typeof action === 'string' ? { action: action as RuleActionType } : {}),
  }
}

/**
 * §2.202 — the verdict on a rule that is ALREADY STORED, read from the raw
 * `rules:list` row rather than from the draft the editor holds.
 *
 * Why the raw row. `findEncodedMailRuleRefusal` decides on the two JSON halves,
 * which is exactly what the save paths and the runner see; a draft has already
 * been decoded and no longer carries them. Re-encoding a draft back into JSON to
 * ask the question would make this a SECOND copy of the policy — one that
 * answers about a rule the user never wrote (the round trip drops whatever the
 * editor could not represent) and would drift from the one in packages/core the
 * moment either side changed. So the row is passed through untouched.
 *
 * A row whose halves are not both strings is asked about the empty string,
 * which yields the structural verdict — the same `malformed_rule` the storage
 * guard produces for a row that does not decode. A value that is not an object
 * at all is not a row, so there is no verdict to give about it: `null`.
 */
export function findRuleRowRefusal(row: unknown): MailRuleRefusal | null {
  if (row === null || typeof row !== 'object') return null

  const { conditions, actions } = row as { conditions?: unknown; actions?: unknown }
  return findEncodedMailRuleRefusal(
    typeof conditions === 'string' ? conditions : '',
    typeof actions === 'string' ? actions : '',
  )
}

/**
 * The verdicts for a whole `rules:list` reply, keyed by rule id so a screen can
 * look one up next to the draft it renders.
 *
 * A `Map`, not a plain object, because the keys come from data that crossed IPC:
 * an object would answer `refusals['toString']` with an inherited function and
 * put a badge — then a crash inside `ruleRefusalReasonText` — on a rule that is
 * perfectly fine. A `Map` has no prototype chain to inherit from.
 *
 * A row whose id is not a non-empty string is skipped entirely, refusal or not.
 * Such a row still renders (`toMailRuleDrafts` gives it the empty-string id), so
 * filing it under `''` would look like it works — until a second unreadable row
 * arrives and the two collide, at which point one row's refusal marks the other
 * row, which may be healthy. A badge that cannot be attached to a known rule is
 * worse than no badge, so it is not attached at all.
 *
 * Rules with no refusal are absent rather than present with `null`: "no entry"
 * is the common case and reads as such at the call site.
 */
export function collectRuleRowRefusals(raw: unknown): Map<string, MailRuleRefusal> {
  const refusals = new Map<string, MailRuleRefusal>()
  if (!Array.isArray(raw)) return refusals

  for (const row of raw) {
    const refusal = findRuleRowRefusal(row)
    if (!refusal) continue
    const id = (row as { id?: unknown }).id
    if (typeof id !== 'string' || id === '') continue
    refusals.set(id, refusal)
  }
  return refusals
}

/**
 * The "why" half of a refusal message — one sentence explaining what cannot be
 * evaluated and what to do instead. Wrapped by the callers below, which supply
 * the "what happened" half (not saved / not applied).
 *
 * `malformed_rule` is answered without naming a field: that verdict is about
 * the shape of the whole rule, and core reports `field: 'unknown'` for it, so
 * copy built around the field name would say "the unknown field". A rule of
 * that shape does not come from this editor (it cannot build one) — in practice
 * an assistant wrote it, which is who the wording has to make sense to.
 *
 * The final `unknown` fallback is kept for reasons that do not exist yet: a
 * newer main process may refuse for something this renderer has never heard of,
 * and a vague sentence beats an empty dialog or a raw machine code.
 */
export function ruleRefusalReasonText(t: RuleTranslate, refusal: MailRuleRefusal): string {
  // Resolved after the structural verdict on purpose — that one has no field.
  if (refusal.reason === 'malformed_rule') {
    return t('settings.rules.refusal.malformedRule')
  }

  const field = ruleFieldLabel(t, refusal.field)
  if (refusal.reason === 'unsupported_field') {
    return t('settings.rules.refusal.unsupportedField', { field })
  }
  if (refusal.reason === 'unverifiable_sender' && refusal.action) {
    return t('settings.rules.refusal.unverifiableSender', {
      field,
      action: ruleActionLabel(t, refusal.action),
      suggestion: ruleFieldLabel(t, 'from_address'),
    })
  }
  return t('settings.rules.refusal.unknown')
}

/**
 * Message for a failed save. A refusal is explained in full; anything else
 * (a dead IPC channel, a storage error) keeps the pre-existing generic text —
 * a refusal message would be a guess about a failure that is not this one.
 */
export function ruleSaveErrorText(t: RuleTranslate, err: unknown): string {
  const refusal = readMailRuleRefusal(err)
  if (!refusal) return t('settings.rules.saveFailed')
  return t('settings.rules.saveRefused', { reason: ruleRefusalReasonText(t, refusal) })
}

/**
 * Message for a rule that was saved but refused when applied to existing mail.
 * Kept distinct from the save wording: the rule does exist, so telling the user
 * it was not saved would send them looking for something that is there.
 */
export function ruleApplyRefusalText(t: RuleTranslate, refused: unknown): string {
  const refusal = readRefusedReply(refused)
  const reason = refusal
    ? ruleRefusalReasonText(t, refusal)
    : t('settings.rules.refusal.unknown')
  return t('settings.rules.applyRefused', { reason })
}
