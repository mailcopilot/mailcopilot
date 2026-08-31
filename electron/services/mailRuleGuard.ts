/**
 * §2.162 — the AI side of "a mail rule whose firing cannot be justified is
 * refused", split out of services/ai.ts so the hotspot keeps only tool wiring.
 *
 * This module does TWO things and neither of them is the decision:
 *
 *  1. Resolves the halves of an update, so the verdict is about the rule as it
 *     will be after the patch rather than about the submitted half alone.
 *  2. Puts a refusal into words a model can act on.
 *
 * WHICH fields and WHICH actions are refused is decided exclusively by
 * `findEncodedMailRuleRefusal` in packages/core — the same function the
 * `rules:create` / `rules:update` IPC handlers, the storage guard and the rules
 * runner reach. No list of fields or actions may be introduced here: a second
 * list is a second thing to keep right, and the one that drifts is always the
 * one nobody is testing.
 */
import { findEncodedMailRuleRefusal, formatMailRuleRefusal, type MailRuleRefusal } from '../../packages/core'
import { createLogger } from '../logger'

const log = createLogger('MailRuleGuard')

/** The two halves of a stored rule, as `mail_rules` keeps them. */
export interface StoredMailRuleHalves {
  conditions: string
  actions: string
}

/**
 * How this module reads a stored rule. Injected rather than imported so the
 * guard is testable without standing up the whole db layer, and so the caller
 * stays the only place that knows where rules live.
 */
export type MailRuleLookup = (ruleId: string) => StoredMailRuleHalves | undefined

/** The patch an update tool submits — both halves optional, as the tool allows. */
export interface MailRuleUpdatePatch {
  ruleId: string
  conditions?: string
  actions?: string
}

/** MCP `content[]` payload shape. */
type McpTextResult = { content: { type: 'text'; text: string }[] }

/**
 * Refusal check for an UPDATE, run against the rule as it will be after the
 * patch rather than against the patch alone.
 *
 * A patch that only swaps the actions to `trash` leaves the stored sender
 * condition in place, so checking the submitted half on its own would wave that
 * combination through; the missing half is read back from storage.
 *
 * A patch that touches NEITHER half is deliberately not checked. Renaming,
 * re-prioritising and above all DISABLING a rule stored before this check
 * existed must stay possible, or the one action that neutralises such a rule is
 * the one action the guard blocks. Same semantics as `rules:update` in main.ts
 * and `updateMailRule` in packages/db.
 */
export function findMailRuleUpdateRefusal(
  lookupRule: MailRuleLookup,
  patch: MailRuleUpdatePatch,
): MailRuleRefusal | null {
  if (patch.conditions === undefined && patch.actions === undefined) return null
  const existing = lookupRule(patch.ruleId)
  return findEncodedMailRuleRefusal(
    patch.conditions ?? existing?.conditions ?? '[]',
    patch.actions ?? existing?.actions ?? '[]',
  )
}

/**
 * How a refused rule is explained to the model.
 *
 * Three properties this wording has to keep:
 *
 *  - It states the CAUSE, not just the code. A model handed
 *    `MAIL_RULE_REFUSED:unsupported_field:cc` can do nothing but read it back
 *    at the user; one told why the field cannot be answered can offer a rule
 *    that works. The machine code travels alongside in its own field, for
 *    anything that decodes rather than reads.
 *  - It tells the truth about `from_address`. That is the address parsed out of
 *    the `From:` header — NOT the SMTP envelope (this client never sees
 *    `MAIL FROM`) and NOT an authenticated identity (DKIM / DMARC are §2.160).
 *    It is preferred over the display name because it cannot be confused with
 *    one, and a refusal that oversells it teaches the model to oversell it to
 *    the user.
 *  - It describes STRUCTURE only — a field name, an action type, the shape a
 *    rule must have. The condition value, the rule name and every other string
 *    the model authored stay out: tool output re-enters the prompt on the next
 *    turn, and text that made a round trip through us reads as though we had
 *    vouched for it. The field token is sanitised by packages/core to
 *    `[a-z_]{1,32}` or the literal `unknown` before it gets here.
 */
export function describeMailRuleRefusal(refusal: MailRuleRefusal): string {
  if (refusal.reason === 'malformed_rule') {
    // The one refusal where detail is worth spending: the model wrote this JSON
    // and can fix it, unlike a policy refusal where what needs rethinking is the
    // intent. The expected shape is described, never the shape that arrived.
    return (
      `Rule refused: the rule is not shaped like a rule, so nothing was created or changed. This is structural — ` +
      `it says nothing about whether the rule would have been allowed. Both halves must be JSON arrays: conditions ` +
      `as [{"field": "…", "op": "…", "value": "…"}] with all three members present and all three strings, actions ` +
      `as [{"type": "…"}] with an optional string "folder". Rebuild both arrays in that shape and send them again; ` +
      `do not describe the rule in prose inside the JSON.`
    )
  }

  if (refusal.reason === 'unverifiable_sender') {
    const actionClause = refusal.action
      ? `A rule whose actions include "${refusal.action}" may not be gated on it.`
      : 'A rule that moves, files or deletes mail may not be gated on it.'
    return (
      `Rule refused: the condition field "${refusal.field}" matches the name the sender writes about themselves. ` +
      `"from_name" is that display name, and the legacy "from" matches the display name as well as the address, so ` +
      `anybody willing to type the expected string into a field nobody checks makes the rule fire on their own mail. ` +
      `${actionClause} Condition the sender on "from_address" instead — the address read from the "From:" header. ` +
      `That address is not authenticated either (this client checks no DKIM or DMARC signature), but it is the one ` +
      `sender value that cannot be confused with a display name. If the user described the sender by name rather ` +
      `than by address, ask them for the address: do not pass a name off as an address, and do not drop the action ` +
      `to something cosmetic just to keep the field.`
    )
  }

  return (
    `Rule refused: this client cannot evaluate a condition on the field "${refusal.field}", so nothing was created ` +
    `or changed. That field is not part of the stored message data — CC recipients, for example, are never stored — ` +
    `so the condition could never match, while its negated form ("not_contains") would match every message instead. ` +
    `Rebuild the rule from the condition fields listed in this tool's schema, or tell the user that this client ` +
    `cannot filter on that field.`
  )
}

/** MCP payload for a rule refused before any preview was registered. */
export function mailRuleRefusedResult(toolName: string, refusal: MailRuleRefusal): McpTextResult {
  const code = formatMailRuleRefusal(refusal)
  log.warn(`MCP ${toolName} → mail rule refused (${code})`)
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ok: false,
        reason: 'rule_refused',
        code,
        message: describeMailRuleRefusal(refusal),
      }),
    }],
  }
}
