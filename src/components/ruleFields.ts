/**
 * ruleFields — presentation rules for the "condition field" dropdown of the
 * static mail-rules editor. Pure, no React, no i18n (labels are resolved by the
 * caller from `settings.rules.field.<value>`).
 *
 * Why `from` was split. A sender fully controls the display name of their own
 * message, so a rule written as «From equals user@example.com» also fired on a
 * message from an attacker whose *display name* was literally the string
 * `user@example.com`. The condition now names which half it inspects:
 * `from_address` compares addresses only, `from_name` the display name only.
 *
 * `from` keeps its old «name OR address» semantics in the engine so already
 * configured rules do not change behaviour behind the user's back, but it is
 * deprecated: it is offered in the dropdown ONLY while a condition still uses
 * it. New conditions therefore cannot be created on it, and the ones that exist
 * stay readable and editable — including the option to leave them alone.
 *
 * Why `cc` is gone (§2.91/§2.162). The client stores no CC at all, so the
 * condition compared against nothing and `cc not_contains <anything>` was true
 * for EVERY message — a rule meant to catch a handful of mails emptied the
 * mailbox. The engine now refuses that field outright; this module only stops
 * OFFERING it, and keeps showing it while a saved condition still names it, so
 * the user can see what stopped working instead of having it rewritten behind
 * their back.
 *
 * Which field/action pairs are refused is decided by `@mailcopilot/core`
 * ({@link findMailRuleRefusal}) and never re-listed here — the editor must warn
 * about exactly what the save paths and the runner enforce.
 */

import { findMailRuleRefusal, type RuleActionType } from '@mailcopilot/core'

/** Condition fields offered for new conditions, in dropdown order. */
export const RULE_CONDITION_FIELDS = [
  'from_address',
  'from_name',
  'to',
  'subject',
  'has_attachment',
] as const

/** Deprecated field kept for rules configured before the split. */
export const LEGACY_FROM_FIELD = 'from'

/** Field a freshly added condition starts on — the unambiguous sender half. */
export const DEFAULT_RULE_CONDITION_FIELD = 'from_address'

/** Fields whose value is chosen by the sender and therefore easy to forge. */
const SENDER_CONTROLLED_FIELDS = new Set<string>([LEGACY_FROM_FIELD, 'from_name'])

/** Fields that carry no value/operator (boolean conditions). */
const VALUELESS_FIELDS = new Set<string>(['has_attachment'])

/**
 * Dropdown choices for a condition currently set to `current`.
 *
 * Always contains the standard list; `current` is appended when it is not part
 * of it (deprecated `from`, or a field written by a newer build / by hand) so
 * that opening an existing rule never silently rewrites it to something else.
 */
export function ruleConditionFieldChoices(current: string): string[] {
  const base: string[] = [...RULE_CONDITION_FIELDS]
  return base.includes(current) || !current ? base : [...base, current]
}

/**
 * True when the field matches on a sender-chosen display name, so a rule built
 * on it can be triggered by a stranger who copies someone else's name.
 * Drives the one-line caveat under the condition row.
 */
export function isSenderControlledField(field: string): boolean {
  return SENDER_CONTROLLED_FIELDS.has(field)
}

/** True when the field is boolean and takes neither operator nor value. */
export function isValuelessField(field: string): boolean {
  return VALUELESS_FIELDS.has(field)
}

/**
 * What the editor has to say about one condition row, given the actions the
 * rule currently carries.
 *
 * Three cases, in decreasing severity:
 * - `unsupported_field` — the client cannot answer about this field at all
 *   (`cc`, or a name written by a newer build). The condition matches nothing,
 *   so the rule no longer runs and cannot be saved as it stands.
 * - `unverifiable_sender` — the condition matches on the sender's own display
 *   name (`from_name`, or the legacy `from`) while the rule performs `action`,
 *   which destroys or hides mail. That combination is refused on save; `action`
 *   names the one that forced it, so the warning can quote it.
 * - `sender_controlled` — the same display-name match while the rule only
 *   marks mail, which stays allowed because it is reversible. Advice, not a
 *   refusal.
 *
 * `malformed_rule`, the third verdict core can return, is deliberately not one
 * of these: it is about the shape of the whole rule, which no single row can
 * describe or fix. The editor cannot build a malformed rule anyway — see
 * {@link ruleConditionNotice} for how it is kept out of a row's verdict.
 */
export type RuleConditionNotice =
  | { kind: 'unsupported_field' }
  | { kind: 'unverifiable_sender'; action: RuleActionType }
  | { kind: 'sender_controlled' }

/**
 * Decide the notice for `field` inside a rule whose actions are `actions`.
 *
 * The refusals come straight from `findMailRuleRefusal`, asked about this
 * single condition: the editor must warn about exactly what the save paths
 * refuse, and a second list here would drift from the first one it duplicated.
 * `actions` is `unknown` because it is editor draft state.
 *
 * Anything that is not an array of actions is asked about as no actions at all,
 * rather than being handed to core as-is: core would answer `malformed_rule`,
 * which is a verdict about the whole rule and would put a warning about the
 * rule's SHAPE under one condition row, where it neither belongs nor can be
 * acted on.
 */
export function ruleConditionNotice(
  field: string,
  actions: unknown,
): RuleConditionNotice | null {
  // An empty field is a half-built row, not a verdict about anything.
  if (!field) return null

  const refusal = findMailRuleRefusal([{ field }], Array.isArray(actions) ? actions : [])
  if (refusal?.reason === 'unsupported_field') return { kind: 'unsupported_field' }
  if (refusal?.reason === 'unverifiable_sender' && refusal.action) {
    return { kind: 'unverifiable_sender', action: refusal.action }
  }
  if (isSenderControlledField(field)) return { kind: 'sender_controlled' }
  return null
}
