// ──────────────────────────────────────────────────────────────────────
// mailRules.ts — Pure functions for evaluating static mail rules.
// No side effects, no imports from non-core packages.
// ──────────────────────────────────────────────────────────────────────

/**
 * Fields a rule condition can inspect.
 *
 * Sender matching is split into two fields with distinct meanings, because the
 * sender controls their own display name and can set it to anything — including
 * the exact address of somebody the user trusts:
 *
 * - `from_address` compares **only against `mail.fromAddr`**, the address the
 *   MIME parser read out of the `From:` header. Nothing is ever derived from
 *   `mail.from`, so a display name cannot impersonate an address. This does
 *   NOT make the address authentic — see {@link MailContext.fromAddr}.
 * - `from_name` compares **only against the display name**. The address is
 *   never a name candidate.
 * - `from` is the legacy field: it compares the display name **or** the
 *   address, each as a whole value. Kept for rules users already configured.
 *
 * Neither `from_name` nor `from` may gate an action that destroys or hides
 * mail: both can be satisfied by a stranger who types the expected display
 * name (see {@link UNVERIFIABLE_SENDER_FIELDS}).
 */
export type RuleField =
  /**
   * @deprecated Legacy sender field — compares against two whole values, the
   * display name and the address, and matches when either satisfies the
   * condition. Unsafe because the display name is chosen by the sender: one
   * who sets it to `user@example.com` makes `from equals user@example.com`
   * fire on their own mail. (Nothing is parsed *out of* those values — a name
   * like `Alice <user@example.com>` is compared whole and does not match that
   * condition — but a name set to the address verbatim still does.) Prefer
   * `from_address` (or `from_name`), and never gate a destructive action
   * (`move` / `trash` / `archive` / `mark_spam`) on this field.
   */
  | 'from'
  | 'from_address'
  | 'from_name'
  | 'to'
  | 'cc'
  | 'subject'
  | 'has_attachment';

/**
 * Comparison operators for string-based conditions — the canonical dictionary.
 *
 * A runtime tuple with the type derived from it, rather than a hand-written
 * union beside a hand-written list: a rule arrives as JSON, so the operator has
 * to be checked at runtime, and two spellings of the same vocabulary are two
 * things to keep in step. Every member here must have a branch in
 * {@link applyStringOp}.
 */
export const RULE_OPS = [
  'contains',
  'not_contains',
  'equals',
  'starts_with',
  'ends_with',
  'matches_regex',
] as const;

/** Comparison operators for string-based conditions. */
export type RuleOp = (typeof RULE_OPS)[number];

/** A single condition within a rule (AND-combined with siblings). */
export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string;
}

/**
 * Action types a matching rule can trigger — the canonical dictionary.
 *
 * Same construction and the same reason as {@link RULE_OPS}: this list is what
 * a stored or model-authored action is checked against, and every member must
 * have a branch in the executor (`executeRuleAction` in electron/main.ts, which
 * refuses anything else rather than reporting it as applied).
 */
export const RULE_ACTION_TYPES = [
  'move',
  'archive',
  'trash',
  'mark_read',
  'mark_starred',
  'mark_spam',
] as const;

/** Possible action types a matching rule can trigger. */
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

/** An action to execute when a rule matches. */
export interface RuleAction {
  type: RuleActionType;
  /**
   * Target folder. Optional in the type because most action types have no
   * target, but REQUIRED and non-blank for `move` — enforced at runtime by
   * {@link parseMailRuleParts}, since the value arrives as JSON.
   *
   * A `move` with no target used to pass every check and then do nothing, while
   * the caller wrote a `rule_log` row saying it had been applied.
   */
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

/**
 * Fields a condition can be answered about at all.
 *
 * A field is on this list only when every context builder in the repo actually
 * supplies its value. `cc` is deliberately absent: no builder writes it and
 * storage has no column for it (§2.91), so a `cc` condition used to compare
 * against the empty string — which made `cc not_contains <anything>` (and a
 * regex that accepts the empty string) true for EVERY message, so a rule
 * written to catch a handful of mails emptied the mailbox instead.
 *
 * Anything not on this list is refused rather than guessed at. See
 * {@link findMailRuleRefusal} for the save-time side and
 * {@link matchCondition} for the match-time side; both read this one list.
 */
const EVALUABLE_RULE_FIELDS: readonly RuleField[] = [
  'from',
  'from_address',
  'from_name',
  'to',
  'subject',
  'has_attachment',
];

/**
 * Actions that destroy or hide mail, and therefore may not be gated on a value
 * the sender writes about themselves.
 *
 * `mark_read` and `mark_starred` are deliberately absent: they are cosmetic and
 * reversible, so a forged display name buys an attacker nothing worth blocking
 * a user's existing rule over.
 */
const DESTRUCTIVE_RULE_ACTIONS: readonly RuleActionType[] = [
  'move',
  'trash',
  'archive',
  'mark_spam',
];

/**
 * Sender fields whose value is the sender's own display name, so a match on
 * them says who the sender *called themselves*, not who sent the mail.
 *
 * Both `from_name` and the legacy `from` are here. `from_name` compares against
 * the display name and nothing else; `from` compares against the display name
 * OR the address and matches when either satisfies the condition — so both can
 * be satisfied by a stranger who types the expected string into a field nobody
 * checks. Gating destruction on that is not something we are willing to do
 * whatever the wording of the rule, which is why this list refuses it rather
 * than the tool descriptions asking a model not to write it: a policy that
 * lives only in a prompt is not a control, because the same prompt can be
 * argued with.
 *
 * `from_address` is absent — not because it is authenticated (it is not, see
 * {@link MailContext.fromAddr}), but because it is the only sender value that
 * cannot be confused with the display name. Making it *trustworthy* is DKIM /
 * DMARC, tracked separately (§2.160).
 *
 * What this costs: "file everything from Acme Support" now has to be written
 * against the address or the domain (`from_address ends_with @acme.com`). The
 * case with no address-shaped equivalent — a sender who keeps one display name
 * across changing addresses — is exactly the case where the name is worth the
 * least, so it is not one we want driving `trash`.
 */
const UNVERIFIABLE_SENDER_FIELDS: readonly RuleField[] = ['from', 'from_name'];

/** Machine-readable reason a rule may not be saved and may not run. */
export type MailRuleRefusalReason =
  /**
   * The rule is not SHAPED like a rule: a half that is not an array, an entry
   * that is not an object, a condition with no usable operator or value. This
   * is a structural verdict and is reached before any policy question is asked,
   * because the answer to "may these fields drive these actions" is meaningless
   * when neither can be read.
   */
  | 'malformed_rule'
  /**
   * The condition names a field this client cannot answer about — one it never
   * stores (`cc`), or a name that is not a field at all. Such a condition
   * cannot be evaluated, so it neither matches nor is allowed to be saved.
   */
  | 'unsupported_field'
  /**
   * The condition gates a destructive action on the sender's own display name
   * (`from_name`, or the legacy `from`). Refused because the action cannot be
   * justified: the same mail arrives from anybody willing to type the expected
   * string into a field nobody checks.
   */
  | 'unverifiable_sender';

/** Why a rule was refused, in a form every caller can act on without parsing text. */
export interface MailRuleRefusal {
  reason: MailRuleRefusalReason;
  /**
   * Offending condition field. A well-formed rule yields a {@link RuleField};
   * a field name that came off untrusted JSON is reported as `'unknown'` when
   * it is not a plain identifier, so the value can be embedded in a message
   * without carrying arbitrary text along.
   *
   * `'unknown'` is also what `malformed_rule` carries — that verdict is about
   * the shape of the whole rule, so there is no one field to blame. Consumers
   * that name the field in user-facing copy must branch on `reason` first; the
   * ones in this repo already fall back to their generic sentence for a reason
   * they do not recognise.
   */
  field: string;
  /** For `'unverifiable_sender'` — the destructive action that forced the refusal. */
  action?: RuleActionType;
}

/**
 * The one `malformed_rule` verdict. A structural refusal has no single field to
 * blame, so it always carries the same `'unknown'` token — see the doc on
 * {@link MailRuleRefusal.field}.
 */
const MALFORMED_RULE_REFUSAL: MailRuleRefusal = {
  reason: 'malformed_rule',
  field: 'unknown',
};

/** Stable prefix of the error a refusing save path throws across IPC. */
export const MAIL_RULE_REFUSED_ERROR = 'MAIL_RULE_REFUSED';

/** Field names safe to embed verbatim in an error message. */
const SAFE_FIELD_TOKEN_RE = /^[a-z_]{1,32}$/i;

/** Minimal message summary passed into rule evaluation. */
export interface MailContext {
  /**
   * Sender as shown in the UI: the **display name on its own**, or the bare
   * address when the sender has no display name. Never a `Name <addr@host>`
   * rendering — every builder in this repo takes it from storage's
   * `COALESCE(NULLIF(TRIM(from_name),''), from_addr)` (packages/db), and the
   * name stored there is what the MIME parser returned, with the address kept
   * in a separate column.
   *
   * So this field alone can never be relied on to carry the address, and the
   * fact that it *looks* like it does is a forgery signal rather than a format:
   * the display name is chosen by the sender and may be anything, including
   * `Alice <victim@example.com>`. Treat this value as untrusted, never parse an
   * address out of it, and match addresses through `fromAddr` (field
   * `from_address`) instead.
   */
  from: string;
  /**
   * The address the MIME parser read out of the `From:` header, independent of
   * whether a display name exists. `from_address` is built from it.
   *
   * NOT an authenticated identity, and no code may be written as if it were.
   * The `From:` header is composed by the sender like every other header; this
   * client verifies neither DKIM nor DMARC (§2.160 tracks that separately), so
   * an unsigned message can carry any address here. Nor is it the SMTP envelope
   * sender (`MAIL FROM`), which we never see.
   *
   * What it *is* worth: it is the one sender value that cannot be confused with
   * the display name. A rule written against it says "this address was claimed"
   * rather than "somebody typed this string into a free-text field" — a real
   * difference in what forging it costs an attacker, and the whole reason the
   * legacy `from` was split. It is a narrower claim, not a verified one.
   */
  fromAddr: string;
  to: string;
  /**
   * @deprecated Never read. No context builder in the repo supplies it and
   * storage has no column behind it, so a `cc` condition is refused rather than
   * compared (see {@link EVALUABLE_RULE_FIELDS}). The property is kept so
   * callers that still pass a value keep compiling; the value is ignored.
   */
  cc?: string;
  subject: string;
  hasAttachments: boolean;
  accountId: number;
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Sender candidates of the legacy `from` field: the display name and the
 * address, each taken **whole**.
 *
 * No angle-bracket parsing happens here, and none may be reintroduced. The
 * display name is written by the sender, so `Alice <victim@example.com>` costs
 * an attacker nothing; splitting it at the brackets would publish
 * `victim@example.com` as a candidate in its own right and make
 * `from equals victim@example.com` fire on the attacker's mail. Comparing whole
 * values keeps that string what it actually is — a display name that merely
 * looks like an address.
 *
 * The trimmed form of a value is not a piece of it, so padding handed back by a
 * header parser is tolerated: a padded value contributes its trimmed self as
 * well, and nothing else.
 *
 * What remains unsound — deliberately, because users already have rules written
 * this way — is that name and address share one candidate list: a sender whose
 * display name *is* the victim address satisfies an address-shaped condition.
 * That is why `from_address` exists.
 */
function legacySenderCandidates(raw: string): string[] {
  if (!raw) return [];

  const out: string[] = [raw];
  const trimmed = raw.trim();
  if (trimmed && trimmed !== raw) out.push(trimmed);

  return out;
}

/**
 * Address candidates of the sender — the values `from_address` may match.
 *
 * Exactly one source: `mail.fromAddr`, the address the MIME parser read out of
 * the `From:` header. Nothing is derived from `mail.from`, and that omission —
 * separation of the address from the display name, NOT authenticity of the
 * address (see {@link MailContext.fromAddr}) — is the security property of this
 * field.
 *
 * `mail.from` is a *display name* (see {@link MailContext.from}), which the
 * sender writes themselves — including into a shape that looks parseable.
 * `From: "Alice <victim@example.com>" <attacker@evil.example>` parses into the
 * display name `Alice <victim@example.com>` and the address
 * `attacker@evil.example`; reading an address back out of that display name
 * would hand the attacker a `from_address equals victim@example.com` match on
 * their own mail. So no angle-bracket parsing happens here at all — not on
 * `mail.from`, and not on `mail.fromAddr` either, since a `Name <addr>` value
 * reaching the address field means the parser found no address and fell back to
 * the name, which is the same forgery by a longer route.
 *
 * Consequence worth knowing: a caller that supplies no `fromAddr` has no
 * address candidates, even when `mail.from` holds something address-shaped.
 * That is fail-closed on purpose — an unattributed string is not proof of an
 * address.
 */
function fromAddressCandidates(mail: MailContext): string[] {
  const declared = (mail.fromAddr ?? '').trim();
  // A sender with no known address compares as the empty string, mirroring how
  // an absent `cc` behaves.
  return declared ? [declared] : [''];
}

/**
 * Display-name candidates of the sender — the values `from_name` may match.
 *
 * `mail.from` *is* the display name, so it is taken whole: storage stores the
 * parsed name verbatim and never re-renders it as `Name <addr@host>` (see
 * {@link MailContext.from}). A sender whose display name genuinely contains
 * angle brackets is therefore reported as it really is, rather than being
 * silently truncated at the bracket.
 *
 * Never contains an address: the one case where `mail.from` holds one is the
 * sender who has no display name at all, whom storage renders as the bare
 * address (`COALESCE(NULLIF(TRIM(from_name),''), from_addr)`). That case is
 * recognised by comparing against `fromAddr` and yields `['']`, so `from_name`
 * conditions neither match the address nor silently fall back to it.
 *
 * Known limitation: a sender whose display name is *literally* their own
 * address is indistinguishable from a sender who has none, because
 * `MailContext` carries no separately stored name — such a sender yields `['']`
 * and matches no `from_name` condition. Fixing that needs `fromName` threaded
 * through the data layer and every context builder; it is tracked separately.
 */
function fromNameCandidates(mail: MailContext): string[] {
  const trimmed = (mail.from ?? '').trim();
  if (!trimmed) return [''];

  const addresses = new Set(
    fromAddressCandidates(mail).map((a) => a.toLowerCase()),
  );
  if (addresses.has(trimmed.toLowerCase())) return [''];

  return [trimmed];
}

/**
 * Resolve the candidate string values of a field from the mail context.
 * Returns `null` for `has_attachment` (boolean field — handled separately).
 *
 * What is compared against what:
 *
 * | field          | candidates                                                    |
 * |----------------|---------------------------------------------------------------|
 * | `from_address` | `mail.fromAddr` alone — nothing derived from `mail.from`       |
 * | `from_name`    | `mail.from` whole, unless it is the address — addresses excluded |
 * | `from`         | *legacy*: `mail.from` and `mail.fromAddr`, each whole — nothing is parsed out of either |
 * | `to` / `subject` | one candidate — the field's own raw value                    |
 * | `cc`           | none — the field is not evaluable, see below                  |
 *
 * The legacy `from` mixes the two categories into one list and matches when
 * *any* candidate matches, which is why a sender whose display name *is*
 * `victim@example.com` satisfies `from equals victim@example.com`. That
 * behaviour is preserved deliberately — rules already configured against it
 * must keep working — and is the reason `from_address` exists. A display name
 * that merely *contains* an address (`Alice <victim@example.com>`) does not:
 * candidates are whole values, never fragments cut out of one.
 *
 * A field outside {@link EVALUABLE_RULE_FIELDS} yields `null`, which
 * {@link matchCondition} turns into "no match" for EVERY operator. That is the
 * disarming half of §2.162: rules already saved against `cc` stop firing
 * without a schema migration, and no operator — `not_contains` and a
 * empty-string-accepting regex included — can turn the absence of a value into
 * a match.
 */
function fieldValues(field: RuleField, mail: MailContext): string[] | null {
  if (!EVALUABLE_RULE_FIELDS.includes(field)) return null;

  switch (field) {
    case 'from_address':
      return fromAddressCandidates(mail);
    case 'from_name':
      return fromNameCandidates(mail);
    case 'from': {
      const candidates = [
        ...legacySenderCandidates(mail.from),
        ...legacySenderCandidates(mail.fromAddr),
      ];
      const unique = [...new Set(candidates)];
      // A sender with neither name nor address compares as the empty string,
      // exactly as it did when this resolved to a single value.
      return unique.length > 0 ? unique : [''];
    }
    case 'to':
      return [mail.to];
    case 'cc':
      // Unreachable — `cc` is not evaluable and was rejected above. Kept so the
      // switch stays exhaustive over RuleField.
      return null;
    case 'subject':
      return [mail.subject];
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

/**
 * Apply a string operator across every candidate value of a field.
 *
 * Positive operators match when *any* candidate matches. `not_contains` is the
 * one negated operator and therefore must hold for *every* candidate —
 * otherwise "from does not contain @mycompany.com" would fire for an internal
 * colleague merely because their display name lacks the domain.
 */
function applyStringOpToCandidates(
  op: RuleOp,
  candidates: string[],
  needle: string,
): boolean {
  if (op === 'not_contains') {
    return candidates.every((c) => applyStringOp(op, c, needle));
  }
  return candidates.some((c) => applyStringOp(op, c, needle));
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/**
 * Evaluate a single condition against a mail context.
 *
 * - String fields use case-insensitive comparison.
 * - `from_address` is compared only against sender addresses and `from_name`
 *   only against the display name, so a forged display name cannot satisfy an
 *   address condition. The legacy `from` is compared against both categories
 *   at once and therefore can be satisfied by a forged display name — see
 *   {@link RuleField}.
 * - `has_attachment` ignores `value` and `op`; it simply checks the boolean.
 * - A field this client cannot answer about — `cc`, which is never stored, or a
 *   name that is not a field at all — matches NOTHING, whatever the operator
 *   (§2.162). Conditions are AND-combined, so one such condition disarms the
 *   whole rule.
 */
export function matchCondition(
  condition: RuleCondition,
  mail: MailContext,
): boolean {
  // Entries arrive from decoded JSON; a primitive or `null` in the array is not
  // a condition and matches nothing (reading `.field` off it would throw).
  if (typeof condition !== 'object' || condition === null) return false;

  if (condition.field === 'has_attachment') {
    return mail.hasAttachments;
  }

  const values = fieldValues(condition.field, mail);
  // `!values`, not `=== null`: `condition.field` is typed but arrives off
  // untrusted JSON, and an unrecognised name must fail closed rather than reach
  // the operators with `undefined` in hand.
  if (!values) return false;

  // Same reason, for the operand. Rules are stored as JSON and rows written
  // before `parseMailRuleParts` existed can be missing it; `undefined` here
  // used to reach `.toLowerCase()` and throw inside the runner's per-message
  // try, which retried the message and then abandoned it.
  if (typeof (condition as { value?: unknown }).value !== 'string') return false;

  return applyStringOpToCandidates(condition.op, values, condition.value);
}

/**
 * Check whether all conditions of a rule match (AND logic).
 * A rule with zero conditions never matches.
 *
 * `conditions` is typed as an array, but rules travel as JSON and this function
 * is reachable from paths that decode one; a value that is not an array is
 * treated as "matches nothing" rather than throwing on `.every` — the failure
 * mode the runner turned into a message retried and then abandoned. Callers
 * that store or evaluate a rule should reject it outright first, through
 * {@link parseMailRuleParts}; this is depth, not the check.
 */
export function matchRule(rule: MailRule, mail: MailContext): boolean {
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return false;
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

    // Same reason as the guard in `matchRule`: spreading a non-array throws.
    if (!Array.isArray(rule.actions)) continue;
    actions.push(...rule.actions);

    if (rule.stopProcessing) break;
  }

  return actions;
}

// ──────────────────────────────────────────────────────────────────────
// §2.162 — refusing rules whose firing cannot be justified
// ──────────────────────────────────────────────────────────────────────

/** Read a `field` off an untrusted condition entry. */
function readConditionField(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const field = (entry as { field?: unknown }).field;
  return typeof field === 'string' ? field : null;
}

/** Read a `type` off an untrusted action entry. */
function readActionType(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const type = (entry as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

/** Field name as it may appear in a message crossing a process boundary. */
function safeFieldToken(field: string): string {
  return SAFE_FIELD_TOKEN_RE.test(field) ? field : 'unknown';
}

/**
 * Is a value shaped like the `RuleCondition[]` / `RuleAction[]` the engine will
 * subscript, iterate, compare and execute?
 *
 * Structural only — no policy question is asked here. Both halves must be
 * arrays of objects; every condition must carry a string `field`, an `op` drawn
 * from {@link RULE_OPS} and a string `value`; every action a `type` drawn from
 * {@link RULE_ACTION_TYPES}, a string `folder` if it carries one at all, and a
 * non-blank `folder` when the type is `move`.
 *
 * The two operators/types are checked against the dictionaries, not merely
 * required to be strings, because an unrecognised one is a rule that LIES about
 * what it does. An operator the engine has no branch for makes every comparison
 * false, so a filter the user believes is configured silently catches nothing;
 * an action type the executor has no branch for did nothing, yet the caller
 * that awaited it went on to write a `rule_log` row saying it was applied — an
 * audit trail that reports work nobody did is worse than no row at all. A
 * `move` with no target folder is the same defect wearing a valid type, and is
 * rejected here for the same reason.
 *
 * The FIELD name is deliberately not checked against a dictionary here: an
 * unknown field is refused by policy as `unsupported_field`, which is a verdict
 * about what this client can answer and reads that way to the user. Operator
 * and action type are closed engine vocabularies, so an unknown one is a defect
 * of form and reported as such.
 */
function readRuleParts(
  conditions: unknown,
  actions: unknown,
): { conditions: RuleCondition[]; actions: RuleAction[] } | null {
  if (!Array.isArray(conditions) || !Array.isArray(actions)) return null;

  for (const entry of conditions) {
    if (typeof entry !== 'object' || entry === null) return null;
    const c = entry as { field?: unknown; op?: unknown; value?: unknown };
    if (typeof c.field !== 'string') return null;
    if (typeof c.op !== 'string') return null;
    if (!(RULE_OPS as readonly string[]).includes(c.op)) return null;
    // `has_attachment` ignores the value, but a condition that omits it is a
    // half-written record rather than a boolean condition, and the engine would
    // reach `value.toLowerCase()` with `undefined` in hand for any other field.
    if (typeof c.value !== 'string') return null;
  }

  for (const entry of actions) {
    if (typeof entry !== 'object' || entry === null) return null;
    const a = entry as { type?: unknown; folder?: unknown };
    if (typeof a.type !== 'string') return null;
    if (!(RULE_ACTION_TYPES as readonly string[]).includes(a.type)) return null;
    if (a.folder !== undefined && typeof a.folder !== 'string') return null;
    // `move` carries its target in the action, and an absent or blank one is
    // the same defect as an action type nobody implements: the executor moves
    // nothing and the caller records the move as applied. Whitespace counts as
    // absent — a folder name made of spaces addresses no mailbox.
    if (a.type === 'move' && (typeof a.folder !== 'string' || a.folder.trim() === '')) {
      return null;
    }
  }

  // The casts are earned by the checks above: every member the engine reads is
  // present, and both closed vocabularies have been verified.
  return {
    conditions: conditions as RuleCondition[],
    actions: actions as RuleAction[],
  };
}

/**
 * Decode and structurally validate the JSON halves of a rule — the shape stored
 * in `mail_rules` and received by both save paths.
 *
 * Returns `null` for anything that is not a well-formed rule: undecodable JSON,
 * a half that is not an array, an entry that is not an object, a condition
 * missing an operand. Callers that are about to EVALUATE a rule must go through
 * this instead of casting `JSON.parse` output, which is how a structurally
 * broken row reached `matchRule` and threw there — once per message, retried,
 * then abandoned (§2.162, cross-family review).
 */
export function parseMailRuleParts(
  conditionsJson: string,
  actionsJson: string,
): { conditions: RuleCondition[]; actions: RuleAction[] } | null {
  const decode = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  return readRuleParts(decode(conditionsJson), decode(actionsJson));
}

/**
 * THE policy decision: may a rule with these condition fields drive these
 * actions?
 *
 * Returns `null` when the rule is allowed, or the FIRST refusal otherwise.
 * Every enforcement point — the save paths (IPC `rules:create` /
 * `rules:update`, storage, the MCP rule tools) and the execution paths (the
 * static rules runner, `rules:applyToFolder`) — reaches this and nothing else,
 * so "which field" and "which action" are decided in exactly one place. The
 * rules editor asks the same function about a single row, which is why the
 * editor's warnings cannot drift from what the save paths refuse.
 *
 * The decision reads ONLY the `field` of each condition and the `type` of each
 * action. It never looks at `op` or `value`: what makes a rule unjustifiable is
 * structural (a field nobody can answer about, a display name the sender writes
 * himself), and a text heuristic over condition values would be a guess that
 * loses to the next unanticipated spelling.
 *
 * Three refusals, each defined by one list above:
 *   - `malformed_rule` — a half is not an array, or an entry is not an object.
 *     Asked first: there is no meaningful policy verdict about a value whose
 *     fields cannot be read. NOTE the deliberate limit — a condition missing
 *     `op`/`value` is NOT malformed here, because the editor probes this
 *     function with `[{ field }]` alone to decide what to warn about. Full
 *     shape validation belongs to {@link parseMailRuleParts}, which every path
 *     that stores or evaluates a rule goes through.
 *   - `unsupported_field` — the condition names something outside
 *     {@link EVALUABLE_RULE_FIELDS}. `cc` is the live case (§2.91: the client
 *     stores no CC), an unrecognised name off untrusted JSON is the other.
 *   - `unverifiable_sender` — a condition on {@link UNVERIFIABLE_SENDER_FIELDS}
 *     (`from_name` or the legacy `from`) combined with any of
 *     {@link DESTRUCTIVE_RULE_ACTIONS}. `mark_read` / `mark_starred` stay
 *     allowed on those fields: the refusal exists to stop mail being destroyed
 *     on a forgeable premise, not to break every rule a user already wrote.
 *
 * Inputs are `unknown` on purpose — the save paths hold JSON a renderer or a
 * model produced, and the editor holds draft state.
 */
export function findMailRuleRefusal(
  conditions: unknown,
  actions: unknown,
): MailRuleRefusal | null {
  if (!Array.isArray(conditions) || !Array.isArray(actions)) {
    return MALFORMED_RULE_REFUSAL;
  }
  const conditionList: unknown[] = conditions;
  const actionList: unknown[] = actions;

  // Every ACTION entry must be an object; its `type` is read leniently, because
  // the editor probes this function with half-built draft rows and a row with
  // no action type yet simply contributes no destructive action.
  if (actionList.some((e) => typeof e !== 'object' || e === null)) {
    return MALFORMED_RULE_REFUSAL;
  }

  // Every CONDITION entry must be an object WITH a readable field. Skipping an
  // unreadable one instead would make a condition invisible to the policy while
  // the engine still tried to evaluate it — the asymmetry that lets something
  // through is the one that matters here.
  const fields = conditionList.map(readConditionField);
  if (fields.some((f) => f === null)) return MALFORMED_RULE_REFUSAL;
  const readableFields = fields.filter((f): f is string => f !== null);

  const unsupported = readableFields.find(
    (f) => !(EVALUABLE_RULE_FIELDS as readonly string[]).includes(f),
  );
  if (unsupported !== undefined) {
    return { reason: 'unsupported_field', field: safeFieldToken(unsupported) };
  }

  const destructive = actionList
    .map(readActionType)
    .find(
      (t): t is RuleActionType =>
        t !== null && (DESTRUCTIVE_RULE_ACTIONS as readonly string[]).includes(t),
    );
  if (destructive === undefined) return null;

  const unverifiable = readableFields.find((f) =>
    (UNVERIFIABLE_SENDER_FIELDS as readonly string[]).includes(f),
  );
  if (unverifiable === undefined) return null;

  return {
    reason: 'unverifiable_sender',
    field: safeFieldToken(unverifiable),
    action: destructive,
  };
}

/**
 * The verdict for a caller holding the JSON-encoded halves of a rule — the
 * shape every save path receives (IPC payload, MCP tool argument) and the shape
 * stored in `mail_rules`.
 *
 * Shape first, policy second. A rule that does not decode, or decodes into
 * something that is not a pair of well-formed arrays, is refused as
 * `malformed_rule` — NOT waved through as "inert". It is not inert: an earlier
 * cut of this file said so, and structurally broken conditions went on to throw
 * inside `matchRule`, once per message, until the message was abandoned.
 */
export function findEncodedMailRuleRefusal(
  conditionsJson: string,
  actionsJson: string,
): MailRuleRefusal | null {
  const parts = parseMailRuleParts(conditionsJson, actionsJson);
  if (!parts) return MALFORMED_RULE_REFUSAL;
  return findMailRuleRefusal(parts.conditions, parts.actions);
}

/**
 * Encode a refusal into the message of an `Error` a save path throws across
 * IPC. Machine-readable on purpose: the renderer localises the refusal itself
 * (the field name is part of what the user must be told), and the funnel in
 * `electron/ipc.ts` keeps the original text intact behind its presentation tag.
 *
 * Format: `MAIL_RULE_REFUSED:<reason>:<field>[:<action>]`. `malformed_rule`
 * carries the field token `unknown`, so the shape is uniform for every reason
 * and a consumer never has to guess how many segments to expect.
 */
export function formatMailRuleRefusal(refusal: MailRuleRefusal): string {
  const parts = [
    MAIL_RULE_REFUSED_ERROR,
    refusal.reason,
    safeFieldToken(refusal.field),
  ];
  if (refusal.action) parts.push(refusal.action);
  return parts.join(':');
}

/**
 * The `Error` a refusing save path throws.
 *
 * Every layer that refuses a rule throws THIS, so the two of them (the IPC
 * handlers in main.ts and the storage guard in packages/db) cannot drift into
 * two differently-worded refusals for one case: the renderer decodes one code
 * whichever layer happened to catch the rule first.
 */
export function mailRuleRefusalError(refusal: MailRuleRefusal): Error {
  return new Error(`${formatMailRuleRefusal(refusal)}: mail rule refused`);
}

/**
 * Recover a refusal from a rejected IPC call. Reads the code
 * {@link formatMailRuleRefusal} wrote, wherever it sits in the message — the
 * IPC funnel prepends a presentation tag and Electron prefixes its own
 * "Error invoking remote method" text, so the code is never at position 0.
 *
 * Returns `null` for anything that is not one of our refusals.
 */
export function parseMailRuleRefusal(input: unknown): MailRuleRefusal | null {
  const text =
    typeof input === 'string'
      ? input
      : input instanceof Error
        ? input.message
        : '';
  if (!text) return null;

  const m = new RegExp(
    `${MAIL_RULE_REFUSED_ERROR}:(malformed_rule|unsupported_field|unverifiable_sender):([a-z_]{1,32})(?::([a-z_]{1,32}))?`,
    'i',
  ).exec(text);
  if (!m) return null;

  const reason = m[1] as MailRuleRefusalReason;
  const action = m[3];
  return {
    reason,
    field: m[2],
    ...(action && (DESTRUCTIVE_RULE_ACTIONS as readonly string[]).includes(action)
      ? { action: action as RuleActionType }
      : {}),
  };
}
