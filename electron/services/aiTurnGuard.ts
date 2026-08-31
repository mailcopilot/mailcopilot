/**
 * Per-turn honesty guard for destructive AI actions (§2.123).
 *
 * THE FAILURE THIS EXISTS FOR. The user asked the assistant to archive a batch
 * of mail. The assistant answered "press the confirmation button" — but it had
 * never registered a preview, so there was no button. The user, believing the
 * barrier had simply failed to render, started confirming destructive actions
 * *in prose* ("yes, do it"), which is exactly the preview/apply barrier being
 * routed around by social means (CLAUDE.md §5 — AI / MCP). In the same turn the
 * model called `search_emails` eighteen times, almost all of them empty.
 *
 * WHAT IS DETECTED, AND WHY IT IS NOT TEXT PARSING. The detector never looks at
 * a single character the model wrote. It observes TURN STATE only:
 *
 *   1. Which tools the turn actually called. A call to any member of the
 *      preview/apply catalogue below is the structural proof that the turn was
 *      about a destructive action — the model reached for the destructive
 *      machinery, whatever words surrounded it.
 *   2. Whether a prepared action existed in this turn. Two facts count, and
 *      both arrive through funnels in `ai.ts`: a `*_preview` handler REGISTERED
 *      one (`notePreviewRegistered`), or an `*_apply` handler CLAIMED one that
 *      the user had already confirmed (`notePreparedActionClaimed`). The
 *      pending-action registry is consulted as a third, weaker witness.
 *
 * "Destructive request, nothing prepared" is then a mismatch between those two
 * facts, and the user is told the truth: no action is armed, nothing changed,
 * ask again. Deliberately NOT detected: the promise itself. Recognising "I have
 * prepared a button for you" in free-form model prose, in every language we
 * ship, is a regex arms race that loses by construction — and it would key the
 * guard to the model's wording rather than to what the system actually did.
 *
 * WHY THE APPLY HALF IS ITS OWN WITNESS. The confirmation click does not run
 * inside the turn that produced the preview: the panel issues the token and
 * then sends a NEW message ("proceed, token=…"), so the apply lands in a LATER
 * turn. A successful atomic claim deletes the registry entry, so that turn ends
 * with a destructive tool call, no registration of its own, and a registry that
 * SHRANK. Without `notePreparedActionClaimed()` every honest confirmation would
 * be answered with "nothing was prepared, nothing has been changed" — moments
 * after the mailbox actually changed. That is the exact failure this guard
 * exists to prevent, pointed the other way.
 *
 * WHAT THIS DOES NOT CATCH. A turn in which the model never touches the
 * destructive machinery at all leaves no structural trace of destructive
 * intent, so it produces no notice. That is a deliberate limit, not an
 * oversight: the alternative is classifying user or model prose. The barrier
 * itself is unaffected either way — an unprepared action still cannot be
 * applied, because `*_apply` requires a renderer-issued confirmation token
 * (see `aiPendingActions.ts`). This guard makes the dead end VISIBLE instead of
 * leaving the user to invent a workaround for it.
 *
 * SECOND CONCERN, SAME TURN STATE: fruitless `search_emails` repetition. A
 * model that cannot find anything tends to re-issue searches until the step
 * budget runs out, which is what preceded the mismatch above. The limiter below
 * answers repeats with a STRUCTURED refusal — the model is told the search
 * space is exhausted rather than being allowed to silently spin.
 *
 * Hotspot policy (CLAUDE.md §5): `ai.ts` is ~7.2k lines. All of the logic lives
 * here; `ai.ts` only creates the guard, feeds it tool names, and yields the
 * notice.
 *
 * NO REGULAR EXPRESSIONS ANYWHERE IN THIS MODULE, BY DESIGN. Query normalisation
 * for the repeat key is a hand-written tokenizer for exactly that reason: a
 * future reader must not be able to mistake this file for a place where model
 * or user text gets interpreted.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createLogger } from '../logger'
import { recordEvent } from '../metrics'
import { bucketCount } from '../metricsBuckets'
// Type-only import: no runtime dependency on the registry module (keeps this
// module trivially unit-testable), but the `Record<PendingActionKind, …>`
// catalogue below still fails TYPECHECK the day a new mutating action kind is
// added without teaching this guard about its tool pair.
import type { PendingActionKind } from './aiPendingActions'

const log = createLogger('AiTurnGuard')

// --- Destructive tool catalogue --------------------------------------------

/**
 * Which tool pair each mutating action kind is exposed under.
 *
 * The naming is NOT uniform (`preview_mail_action` vs `send_email_preview`),
 * which is exactly why this is an explicit table rather than a prefix rule:
 * a convention-based matcher would silently classify a future read-only tool
 * whose name happens to contain "preview", and misclassification here has a
 * user-visible cost (a false "nothing was prepared" notice).
 *
 * Exhaustive over `PendingActionKind` by type. Adding a kind without adding
 * its tools is a compile error.
 */
const DESTRUCTIVE_TOOL_PAIRS: Record<PendingActionKind, { preview: string; apply: string }> = {
  mail_action:      { preview: 'preview_mail_action',      apply: 'apply_mail_action' },
  unsubscribe:      { preview: 'preview_unsubscribe',      apply: 'apply_unsubscribe' },
  send_email:       { preview: 'send_email_preview',       apply: 'send_email_apply' },
  move_email:       { preview: 'move_email_preview',       apply: 'move_email_apply' },
  snooze_email:     { preview: 'preview_snooze_email',     apply: 'apply_snooze_email' },
  unsnooze_email:   { preview: 'preview_unsnooze_email',   apply: 'apply_unsnooze_email' },
  flag_email:       { preview: 'preview_flag_email',       apply: 'apply_flag_email' },
  mark_read_later:  { preview: 'preview_mark_read_later',  apply: 'apply_mark_read_later' },
  add_followup:     { preview: 'preview_add_followup',     apply: 'apply_add_followup' },
  dismiss_followup: { preview: 'preview_dismiss_followup', apply: 'apply_dismiss_followup' },
  create_mail_rule: { preview: 'preview_create_mail_rule', apply: 'apply_create_mail_rule' },
  update_mail_rule: { preview: 'preview_update_mail_rule', apply: 'apply_update_mail_rule' },
  delete_mail_rule: { preview: 'preview_delete_mail_rule', apply: 'apply_delete_mail_rule' },
}

const PREVIEW_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(DESTRUCTIVE_TOOL_PAIRS).map(p => p.preview),
)
const APPLY_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(DESTRUCTIVE_TOOL_PAIRS).map(p => p.apply),
)

/** Which half of the preview→apply pair a tool call belongs to. */
export type DestructiveToolRole = 'preview' | 'apply'

const MAILCOPILOT_TOOL_PREFIX = 'mcp__mailcopilot__'

/**
 * Strip the server namespace the SDKs add. The Claude Agent SDK exposes our
 * tools as `mcp__mailcopilot__<bare>`; the Vercel `@ai-sdk/mcp` client uses
 * both shapes depending on how the server is mounted; unit tests call bare
 * names. Tools from OTHER MCP servers keep their own `mcp__<server>__` prefix
 * and therefore never match the catalogue — intentional: an external server
 * that happens to expose a tool called `preview_something` must not be read as
 * OUR destructive machinery.
 */
function bareToolName(toolName: string): string {
  return toolName.startsWith(MAILCOPILOT_TOOL_PREFIX)
    ? toolName.slice(MAILCOPILOT_TOOL_PREFIX.length)
    : toolName
}

/** `'preview'` / `'apply'` for a mailcopilot destructive tool, else `null`. */
export function classifyDestructiveTool(toolName: string): DestructiveToolRole | null {
  if (!toolName) return null
  const bare = bareToolName(toolName)
  if (PREVIEW_TOOL_NAMES.has(bare)) return 'preview'
  if (APPLY_TOOL_NAMES.has(bare)) return 'apply'
  return null
}

// --- search_emails repetition limiter --------------------------------------

/**
 * How many `search_emails` calls may come back EMPTY within one turn before
 * the tool starts refusing further searches.
 *
 * Chosen against the two populations that matter:
 *   - Legitimate: one call covers exactly ONE account (see the system prompt's
 *     "all email tools operate on a SINGLE account" rule), so a sweep across a
 *     multi-account mailbox legitimately produces several empty answers in a
 *     row. Eight leaves room for a wide sweep plus a couple of misses.
 *   - Pathological: the incident this guard was written for issued eighteen
 *     searches in a single turn with almost nothing to show for it.
 *
 * Only EMPTY results count. A turn that keeps finding mail can search as often
 * as its step budget allows — this limiter never touches a productive search.
 *
 * The budget is global to the turn, but it never costs a CONFIGURED account its
 * FIRST search: see `listConfiguredAccountIds`.
 */
export const SEARCH_EMAILS_EMPTY_BUDGET = 8

/**
 * How many DISTINCT account ids that the user does NOT have configured may be
 * searched in one turn before the first-look exemption stops applying to them.
 *
 * Counted per distinct id actually searched, not per exemption granted: an id
 * probed early (while the budget was still open) has already had its look, and
 * letting it also mint an exemption later would let a model bank slots by
 * enumerating ids before the budget runs out.
 *
 * The exemption exists because a global budget alone gets the multi-account case
 * backwards: with nine mailboxes configured, a sweep that legitimately finds
 * nothing in the first eight would refuse the ninth account BEFORE it was ever
 * searched once. The user would be told "nothing matched" about a mailbox nobody
 * looked in — a different flavour of the same dishonesty this module exists to
 * prevent. So the first search of an account not yet touched in this turn is
 * exempt from the empty-result budget; every FURTHER search of an already-probed
 * account is not.
 *
 * The ceiling answers "why can't the model just enumerate account ids to search
 * forever" — but it must bite ONLY on ids that do not name a real mailbox. A
 * ceiling applied to configured accounts is the original bug one size larger:
 * the seventeenth configured mailbox would be refused before anyone looked in
 * it. Reality already bounds the honest case (a configured account exists only
 * because the user created it), so configured ids get their first look with no
 * ceiling at all; only ids OUTSIDE the configured set are counted here.
 *
 * Two, because the honest reasons for searching an id that is not configured are
 * races with the account list (one added or removed mid-turn) rather than sweeps
 * — such an id has no mail to find in any case. Hitting this ceiling is not a
 * refusal by itself: it only means the ordinary empty-result budget applies to
 * that search.
 */
export const SEARCH_EMAILS_UNCONFIGURED_ACCOUNT_LIMIT = 2

/**
 * Fallback ceiling on DISTINCT first-look exemptions, used only when the set of
 * configured accounts cannot be determined (no accessor injected, or reading it
 * threw). "Unknown" must not be read as "unconfigured": treating every id as
 * bogus would refuse first looks at real mailboxes, so the degraded path keeps
 * the pre-§2.123-fix behaviour — any distinct id may claim an exemption, capped
 * here. Sixteen is far above any real configuration we have seen and far below
 * the eighteen-call spin the guard was written for.
 */
export const SEARCH_EMAILS_ACCOUNT_LIMIT = 16

/**
 * Identity of a search, for repeat detection. Never leaves the process.
 *
 * `offset` is part of the identity because it changes the answer: an empty page
 * at `offset: 100` says nothing about `offset: 0`, and treating them as the same
 * search would block the model from restarting a paginated sweep from the top.
 * `limit` is deliberately NOT part of it — a smaller window cannot turn an empty
 * page into a non-empty one, so including it would only hand the model a knob
 * for re-issuing the identical dead search under a fresh key.
 */
export type SearchCallKey = {
  accountId: number
  folder: string
  query: string
  offset: number
}

export type SearchDecision =
  | { allowed: true }
  | {
      allowed: false
      /** Machine-readable tag handed to the model in the refusal payload. */
      reason: 'repeat_empty_search' | 'empty_search_budget_exhausted'
      message: string
      emptySearches: number
    }

/**
 * Normalise a search key WITHOUT regular expressions (see the module header).
 * Case and whitespace only — no interpretation of the query language.
 */
function normalizeSearchKey(key: SearchCallKey): string {
  const query = collapseWhitespace(key.query).toLowerCase()
  const folder = collapseWhitespace(key.folder).toLowerCase()
  // NUL as the field separator: it cannot occur in an IMAP folder name or in
  // a query the model composes, so `folder="a b" query="c"` and `folder="a"
  // query="b c"` cannot collapse into the same key.
  return `${key.accountId}\u0000${folder}\u0000${key.offset}\u0000${query}`
}

function collapseWhitespace(value: string): string {
  let out = ''
  let pendingSpace = false
  for (const ch of value) {
    const isSpace = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
    if (isSpace) {
      if (out.length > 0) pendingSpace = true
      continue
    }
    if (pendingSpace) {
      out += ' '
      pendingSpace = false
    }
    out += ch
  }
  return out
}

const REPEAT_REFUSAL_MESSAGE =
  'This exact search already returned zero results earlier in this turn, and the mailbox '
  + 'has not changed since. Repeating it cannot produce a different answer. Do not retry it: '
  + 'either search something materially different, or tell the user plainly that nothing matched.'

const BUDGET_REFUSAL_MESSAGE =
  `${SEARCH_EMAILS_EMPTY_BUDGET} searches in this turn came back empty. Stop searching. `
  + 'Report to the user what you did and did not find, and ask them to narrow the request '
  + '(specific sender, subject, folder or date range) instead of searching again.'

// --- The guard --------------------------------------------------------------

/** Outcome of the end-of-turn consistency check. */
export type TurnGuardVerdict = {
  /** Destructive tools were used, yet nothing was armed for confirmation. */
  mismatch: boolean
  /** Which half of the pair proved destructive intent (first one observed). */
  role: DestructiveToolRole | null
  /** How many searches ran in this turn — context for the telemetry bucket. */
  searchCalls: number
}

export interface AiTurnGuard {
  readonly requestId: string
  /** Record one tool call observed on the event stream. */
  noteToolCall(toolName: string): void
  /** Record that a `*_preview` handler actually registered a pending action. */
  notePreviewRegistered(): void
  /**
   * Record that an `*_apply` handler successfully claimed a pending action —
   * i.e. the model presented a live preview id together with the confirmation
   * token the RENDERER issued when the user clicked Apply. That claim is proof
   * that a prepared action existed and the user confirmed it, so this turn is
   * the opposite of "nothing was prepared", whatever the dispatch does next.
   */
  notePreparedActionClaimed(): void
  /** Ask whether a `search_emails` call may run. Counts allowed calls. */
  decideSearch(key: SearchCallKey): SearchDecision
  /** Report how many rows an allowed search returned. */
  noteSearchResult(key: SearchCallKey, matched: number): void
  /**
   * End-of-turn check. Reads the registry (through the injected accessor) but
   * changes no state of its own, and emits NO telemetry — reporting is a
   * separate call, so a caller may evaluate without recording.
   */
  evaluateCompletedTurn(): TurnGuardVerdict
}

export type CreateTurnGuardInput = {
  requestId: string
  /**
   * Ids currently held by the pending-action registry. Injected rather than
   * imported so this module keeps no runtime dependency on the registry (and
   * so tests can drive it directly). `ai.ts` passes the real registry.
   *
   * A LAST-RESORT witness, and the weakest one. The authoritative signals are
   * the two funnels in `ai.ts` (`notePreviewRegistered`, which travels through
   * AsyncLocalStorage, and `notePreparedActionClaimed`). If the ALS channel
   * were ever lost on some provider path, a registry entry that did not exist
   * when the turn started still suggests preparation — and a false "nothing was
   * prepared" notice next to a live Apply button is the one failure mode of
   * this guard that would damage trust rather than protect it.
   *
   * KNOWN WEAKNESS, deliberately accepted. The registry is process-global while
   * the guard is per-turn, and entries carry no owning request id, so a preview
   * armed by a CONCURRENT chat also looks "new" here. The fallback is therefore
   * consulted only for a turn that itself called a `*_preview` tool (see
   * `hasNewRegistryEntry` usage): a turn that never reached for the preview half
   * can no longer be exonerated by another chat's work. Narrowing this further
   * means giving registry entries an owning request id — a change to
   * `aiPendingActions.ts` that buys nothing for the primary signals, so it is a
   * followup rather than part of this guard.
   */
  listPreviewIds: () => string[]
  /**
   * Ids of the accounts the user actually has configured. Injected rather than
   * imported for the same reason as `listPreviewIds`: this module keeps no
   * runtime dependency on the config store, and tests drive it directly.
   *
   * Used for exactly one decision — whether an account id claiming the
   * first-look exemption names a real mailbox (unlimited exemption, bounded by
   * the user's own configuration) or is a bare number the model produced
   * (bounded by `SEARCH_EMAILS_UNCONFIGURED_ACCOUNT_LIMIT`). It is NOT an
   * authorisation check: an id that names no mailbox still reaches the data
   * layer and still comes back empty. The guard only refuses to let such an id
   * mint search budget.
   *
   * Omitted or throwing means "unknown", NOT "nothing is configured" — see
   * `SEARCH_EMAILS_ACCOUNT_LIMIT` for the degraded path. Read lazily and once
   * per turn: a turn that never searches never touches the config store, and a
   * turn that does sees one stable snapshot.
   */
  listConfiguredAccountIds?: () => number[]
}

export function createTurnGuard(input: CreateTurnGuardInput): AiTurnGuard {
  const { requestId, listPreviewIds, listConfiguredAccountIds } = input
  const preexistingPreviewIds = new Set(safeListPreviewIds(listPreviewIds))

  let destructiveRole: DestructiveToolRole | null = null
  let previewsRegistered = 0
  let preparedActionsClaimed = 0
  let previewToolCalls = 0
  let searchCalls = 0
  let emptySearches = 0
  const emptySearchKeys = new Set<string>()
  const accountsSearched = new Set<number>()
  const unconfiguredAccountsSearched = new Set<number>()
  // `undefined` = not resolved yet, `null` = could not be resolved (see the
  // fallback path in `firstLookAllowed`).
  let configuredAccountIds: ReadonlySet<number> | null | undefined

  return {
    requestId,

    noteToolCall(toolName: string): void {
      const role = classifyDestructiveTool(toolName)
      if (!role) return
      if (role === 'preview') previewToolCalls++
      // First observation wins: it is the earliest structural evidence that
      // this turn was about mutating the mailbox.
      if (destructiveRole === null) destructiveRole = role
    },

    notePreviewRegistered(): void {
      previewsRegistered++
    },

    notePreparedActionClaimed(): void {
      preparedActionsClaimed++
    },

    decideSearch(key: SearchCallKey): SearchDecision {
      const normalized = normalizeSearchKey(key)
      if (emptySearchKeys.has(normalized)) {
        log.warn(`search_emails refused (repeat of an empty search) requestId=${requestId}`)
        return { allowed: false, reason: 'repeat_empty_search', message: REPEAT_REFUSAL_MESSAGE, emptySearches }
      }
      // An account nobody has looked in yet gets its first search regardless of
      // what the other mailboxes produced — refusing it would report "nothing
      // matched" about a mailbox that was never searched. The exemption is
      // ceilinged only for ids that are not configured accounts, so walking
      // invented ids cannot mint unlimited budget.
      const firstLookAtAccount = !accountsSearched.has(key.accountId) && firstLookAllowed(key.accountId)
      if (emptySearches >= SEARCH_EMAILS_EMPTY_BUDGET && !firstLookAtAccount) {
        log.warn(`search_emails refused (empty-search budget exhausted) requestId=${requestId} empty=${emptySearches}`)
        return { allowed: false, reason: 'empty_search_budget_exhausted', message: BUDGET_REFUSAL_MESSAGE, emptySearches }
      }
      accountsSearched.add(key.accountId)
      const configured = resolveConfiguredAccountIds()
      if (configured !== null && !configured.has(key.accountId)) {
        unconfiguredAccountsSearched.add(key.accountId)
      }
      searchCalls++
      return { allowed: true }
    },

    noteSearchResult(key: SearchCallKey, matched: number): void {
      if (matched > 0) return
      emptySearches++
      emptySearchKeys.add(normalizeSearchKey(key))
    },

    evaluateCompletedTurn(): TurnGuardVerdict {
      // Either funnel proves a prepared action was in play: this turn armed one
      // (preview), or it applied one the user had already confirmed (apply).
      const armedByFunnel = previewsRegistered > 0 || preparedActionsClaimed > 0
      // Registry delta is defence in depth only, and only for a turn that
      // reached for the preview half itself — see `listPreviewIds` above for the
      // concurrent-chat weakness this narrowing closes.
      const armedByRegistry = armedByFunnel
        ? false
        : previewToolCalls > 0 && hasNewRegistryEntry()
      const mismatch = destructiveRole !== null && !armedByFunnel && !armedByRegistry
      return { mismatch, role: destructiveRole, searchCalls }
    },
  }

  /**
   * May this account id take its first search outside the empty-result budget?
   *
   * Three cases, in the order that keeps the honest one unbounded:
   *   - configured account → yes, always. The user created the mailbox; the
   *     number of them is the bound, and every one of them deserves to be looked
   *     in before the user is told "nothing matched".
   *   - id that is not a configured account → only while the anti-abuse ceiling
   *     has room. Such an id can find nothing anyway; what it must not do is
   *     spend the turn's budget without limit.
   *   - configured set unknown → the pre-fix behaviour, ceilinged at
   *     SEARCH_EMAILS_ACCOUNT_LIMIT. Failing to read the account list must not
   *     start refusing first looks at real mailboxes.
   */
  function firstLookAllowed(accountId: number): boolean {
    const configured = resolveConfiguredAccountIds()
    if (configured === null) return accountsSearched.size < SEARCH_EMAILS_ACCOUNT_LIMIT
    if (configured.has(accountId)) return true
    return unconfiguredAccountsSearched.size < SEARCH_EMAILS_UNCONFIGURED_ACCOUNT_LIMIT
  }

  /** Turn-scoped snapshot of the configured account ids; `null` when unknown. */
  function resolveConfiguredAccountIds(): ReadonlySet<number> | null {
    if (configuredAccountIds !== undefined) return configuredAccountIds
    configuredAccountIds = readConfiguredAccountIds(listConfiguredAccountIds)
    return configuredAccountIds
  }

  function hasNewRegistryEntry(): boolean {
    for (const id of safeListPreviewIds(listPreviewIds)) {
      if (!preexistingPreviewIds.has(id)) return true
    }
    return false
  }
}

/**
 * Read the configured account ids defensively.
 *
 * Returns `null` for "unknown" — no accessor, a throwing accessor, or an answer
 * that is not an array — which selects the degraded ceiling rather than
 * declaring every id bogus. An EMPTY array is a genuine answer ("no mailbox is
 * configured"), not a failure: with nothing configured there is no real mailbox
 * whose first look could be wrongly refused.
 *
 * Non-integer / non-finite entries are dropped rather than rejecting the whole
 * list: a malformed entry should cost that one id its exemption, not turn the
 * whole set into "unknown".
 */
function readConfiguredAccountIds(accessor: (() => number[]) | undefined): ReadonlySet<number> | null {
  if (!accessor) return null
  let ids: number[]
  try {
    ids = accessor()
  } catch {
    return null
  }
  if (!Array.isArray(ids)) return null
  const out = new Set<number>()
  for (const id of ids) {
    if (typeof id === 'number' && Number.isInteger(id)) out.add(id)
  }
  return out
}

/** The registry read must never break a chat turn. Failing to read it means we
 *  fall back to the funnel counter alone. */
function safeListPreviewIds(listPreviewIds: () => string[]): string[] {
  try {
    return listPreviewIds()
  } catch {
    return []
  }
}

// --- Per-request plumbing ---------------------------------------------------

const turnGuardStorage = new AsyncLocalStorage<AiTurnGuard>()

/**
 * Run `fn` with `guard` as the ambient turn guard. Composed into the
 * per-request AsyncLocalStorage scopes in `aiChat()`, exactly like the privacy
 * counters — MCP tool callbacks execute inside `await` chains anchored there,
 * so they can reach the guard without threading it through tool signatures.
 */
export function runWithTurnGuard<T>(guard: AiTurnGuard, fn: () => T): T {
  return turnGuardStorage.run(guard, fn)
}

/**
 * The guard for the turn currently executing, or `undefined` when a tool runs
 * outside any chat turn — the MCP export server, stdio MCP, and unit tests that
 * call handlers directly. Every caller MUST treat `undefined` as "no limiting,
 * no bookkeeping": an external MCP session is not a turn and has no business
 * being rate-limited by one.
 */
export function currentTurnGuard(): AiTurnGuard | undefined {
  return turnGuardStorage.getStore()
}

// --- Telemetry --------------------------------------------------------------

/**
 * One usage event per detected mismatch. PII-clean by construction: the role is
 * a two-value enum and the search count ships as a coarse bucket — no query, no
 * folder, no account, no model text.
 *
 * Answers one question we are prepared to act on: does the assistant regularly
 * end destructive turns with nothing armed? A non-trivial rate means the prompt
 * or the tool surface is misleading the model, and the fix is upstream of this
 * notice.
 */
export function recordTurnGuardMismatch(verdict: TurnGuardVerdict): void {
  try {
    recordEvent('ai.turn.action_not_prepared', {
      role: verdict.role ?? 'preview',
      search_calls_bucket: bucketCount(verdict.searchCalls),
    })
  } catch { /* telemetry must never throw back into a chat turn */ }
}
