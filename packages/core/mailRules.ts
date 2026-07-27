// ──────────────────────────────────────────────────────────────────────
// mailRules.ts — Pure functions for evaluating static mail rules.
// No side effects, no imports from non-core packages.
// ──────────────────────────────────────────────────────────────────────

/** Fields a rule condition can inspect. */
export type RuleField = 'from' | 'to' | 'cc' | 'subject' | 'has_attachment';

/** Comparison operators for string-based conditions. */
export type RuleOp =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'starts_with'
  | 'ends_with'
  | 'matches_regex';

/** A single condition within a rule (AND-combined with siblings). */
export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string;
}

/** Possible action types a matching rule can trigger. */
export type RuleActionType =
  | 'move'
  | 'archive'
  | 'trash'
  | 'mark_read'
  | 'mark_starred'
  | 'mark_spam';

/** An action to execute when a rule matches. */
export interface RuleAction {
  type: RuleActionType;
  /** Target folder (required for 'move'). */
  folder?: string;
}

/** A complete mail rule definition. */
export interface MailRule {
  id: string;
  /** Scope to a specific account, or null for all accounts. */
  accountId: string | null;
  name: string;
  enabled: boolean;
  /** Lower number = higher priority (evaluated first). */
  priority: number;
  /** All conditions must match (AND logic). */
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** If true, no further rules are evaluated after this one matches. */
  stopProcessing: boolean;
}

/** Minimal mail envelope passed into rule evaluation. */
export interface MailContext {
  from: string;
  fromAddr: string;
  to: string;
  cc?: string;
  subject: string;
  hasAttachments: boolean;
  accountId: number;
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the string value of a field from the mail context.
 * Returns `null` for `has_attachment` (boolean field — handled separately).
 */
function fieldValue(field: RuleField, mail: MailContext): string | null {
  switch (field) {
    case 'from':
      return mail.from || mail.fromAddr;
    case 'to':
      return mail.to;
    case 'cc':
      return mail.cc ?? '';
    case 'subject':
      return mail.subject;
    case 'has_attachment':
      return null;
  }
}

/** Apply a string operator (case-insensitive). */
function applyStringOp(op: RuleOp, haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();

  switch (op) {
    case 'contains':
      return h.includes(n);
    case 'not_contains':
      return !h.includes(n);
    case 'equals':
      return h === n;
    case 'starts_with':
      return h.startsWith(n);
    case 'ends_with':
      return h.endsWith(n);
    case 'matches_regex': {
      try {
        const re = new RegExp(needle, 'i');
        return re.test(haystack);
      } catch {
        // Invalid regex never matches.
        return false;
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/**
 * Evaluate a single condition against a mail context.
 *
 * - String fields use case-insensitive comparison.
 * - `has_attachment` ignores `value` and `op`; it simply checks the boolean.
 */
export function matchCondition(
  condition: RuleCondition,
  mail: MailContext,
): boolean {
  if (condition.field === 'has_attachment') {
    return mail.hasAttachments;
  }

  const val = fieldValue(condition.field, mail);
  if (val === null) return false;

  return applyStringOp(condition.op, val, condition.value);
}

/**
 * Check whether all conditions of a rule match (AND logic).
 * A rule with zero conditions never matches.
 */
export function matchRule(rule: MailRule, mail: MailContext): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((c) => matchCondition(c, mail));
}

/**
 * Evaluate an ordered list of rules against a mail context.
 *
 * Rules are processed in `priority` order (ascending — lower number first).
 * Only enabled rules whose `accountId` matches (or is null) are considered.
 *
 * Behaviour:
 * - Actions from every matching rule are collected.
 * - If a matching rule has `stopProcessing: true`, evaluation stops
 *   immediately after that rule (its actions are still included).
 *
 * @returns Collected actions from all matching rules (may be empty).
 */
export function evaluateRules(
  rules: MailRule[],
  mail: MailContext,
): RuleAction[] {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  const actions: RuleAction[] = [];

  for (const rule of sorted) {
    if (!rule.enabled) continue;

    // Account scope check: null matches any account.
    if (
      rule.accountId !== null &&
      String(rule.accountId) !== String(mail.accountId)
    ) {
      continue;
    }

    if (!matchRule(rule, mail)) continue;

    actions.push(...rule.actions);

    if (rule.stopProcessing) break;
  }

  return actions;
}
