// ──────────────────────────────────────────────────────────────────────
// aiRulesPipeline.ts — Background AI Rules pipeline orchestration (§2.39).
//
// Extracted out of the electron/main.ts hotspot so the security-critical
// orchestration (queue → per-account isolation → rate/budget caps → strict
// validation → dedup → preview/apply) is a single injectable unit that tests
// exercise DIRECTLY, instead of re-implementing a "mirror" of the loop.
//
// ── §2.39 simplification: STATELESS-PER-TICK, ATOMIC-PER-ACCOUNT ──────────
// The earlier iteration carried a fragile per-ITEM precision apparatus across
// ticks (per-item rule cursor, per-item pending-apply retry, cross-tick
// un-persisted budget carry). Every fix wave added new cross-tick state and a
// new class of lifecycle bug (identity collisions, map leaks, stale cursors).
// That precision existed ONLY for (a) an exact dollar budget and (b) accounts
// with more rules than the hourly cap. Neither is load-bearing: the HARD bound
// is `AI_RULE_MAX_CALLS_PER_HOUR` (20 calls/hour), and a per-account enabled
// cap (`AI_RULE_MAX_ENABLED_PER_ACCOUNT <= hourly cap`, enforced at rule
// create/enable time) guarantees a full account rule set always fits one window.
//
// So the pipeline now keeps NOTHING between ticks except four plain counters —
// `callCount`, `resetAt`, `inFlight`, `accountRotation`. Every account is
// processed ATOMICALLY (all-or-nothing): either every applicable rule runs and
// its decisions are applied, or the whole account is requeued for a from-scratch
// retry. There is no per-item intermediate state, no resume-mid-rule-list, no
// cross-tick budget carry. This removes the entire divergent-bug class in the
// root while preserving every security invariant.
//
// Security invariants (CLAUDE.md §5 AI/MCP) preserved here:
//   - wrapUntrusted(): every email field is boundary-wrapped + neutralized
//     before it reaches the model (buildAiRulePrompt → untrustedBoundary).
//   - Per-account isolation: a per-account rule only ever sees its own mail
//     (groupBatchByAccount + rulesForAccount).
//   - Strict response validation: no regex salvage (parseAiRuleResponse).
//   - Preview/apply for destructive actions: trash/mark_spam are recorded as
//     pending previews and NEVER auto-applied.
//   - Reversible-action guard: an action must be positively classified as
//     reversible (isReversibleAiRuleAction) before the executor runs — reject
//     by default, so a future action added to parsing but not to the
//     destructive set cannot slip through as auto-applied.
//   - Single-flight: `inFlight` serializes overlapping ticks so two concurrent
//     runs cannot each read `spentToday` and double-spend the daily budget.
//
// main.ts owns only the timer, the in-memory queue instance, the rate-limit
// state, and the wiring of real dependencies (aiChatSimple, executeRuleAction,
// DB accessors, telemetry). Every collaborator is injected via
// `AiRulesPipelineDeps`, so a test can drive the REAL pipeline with fakes.
// ──────────────────────────────────────────────────────────────────────

import {
  AI_RULE_QUEUE_MAX,
  AI_RULE_BATCH_SIZE,
  AI_RULE_MAX_CALLS_PER_HOUR,
  groupBatchByAccount,
  rulesForAccount,
  buildAiRulePrompt,
  parseAiRuleResponse,
  validateDecisionFolder,
  dedupeAiRuleActions,
  isDestructiveAiRuleAction,
  isReversibleAiRuleAction,
  estimateAiRuleCostUsd,
  nullUsageReservationUsd,
  type AiRulePendingItem,
  type AiRuleSpec,
  type AiRuleDecision,
  type RuleAction,
} from '../../packages/core'

// ── Injected collaborator shapes ──────────────────────────────────────────

/** Minimal shape of an AI-rule row the pipeline consumes (from listAiRules). */
export interface AiRulePipelineRule {
  id: string
  accountId: string | null
  enabled: boolean
  prompt: string
  allowedActions: string
  budgetPerDayUsd: number
}

/** Result of one aiChatSimple model call. */
export interface AiRulePipelineChatResult {
  text: string
  model: string
  usage: { inputTokens: number; outputTokens: number } | null
}

/** An audit-log row written for every model call (Privacy Panel). */
export interface AiRuleAuditWrite {
  provider: string
  model: string | null
  goal: 'rule'
  toolName: null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  untrustedWrapped: number
  injectionBlocked: number
  outcome: 'ok' | 'error'
}

export interface AiRulesPipelineDeps {
  /** The mutable in-memory pending queue (main.ts owns the instance). */
  queue: AiRulePendingItem[]
  /** True when the app is shutting down — skip work. */
  isShuttingDown: () => boolean
  /** All configured AI rules (enabled + disabled); pipeline filters enabled. */
  listAiRules: () => AiRulePipelineRule[]
  /** Sum of today's `goal='rule'` audit cost rows (real spend, in USD). */
  sumRuleCostSince: (sinceIso: string) => number
  /** Cached mailbox paths per account, for `move` target validation. */
  getMailboxCache: () => Record<number, Array<{ path: string }>>
  /** One-shot model call. Returns null on provider error/abort. */
  aiChatSimple: (
    systemPrompt: string,
    userPrompt: string,
  ) => Promise<AiRulePipelineChatResult | null>
  /** Execute a reversible action against the real mailbox. */
  executeRuleAction: (
    accountId: number,
    folder: string,
    uid: number,
    action: RuleAction,
  ) => Promise<void>
  /** Append a row to the ai_rule_log execution table. */
  insertAiRuleLog: (data: {
    aiRuleId: string
    accountId: string
    folder: string
    uid: number
    actionTaken: string
    reasoning?: string
  }) => void
  /** Append a row to the append-only ai_action_log audit table (best-effort;
   *  its failure never blocks or unsettles anything). */
  appendAiActionLog: (row: AiRuleAuditWrite) => void
  /** Current provider/model for audit attribution. */
  getProviderModel: () => { provider: string; model: string | null }
  /** Typed telemetry event recorder. */
  recordEvent: (name: string, tags: Record<string, string>) => void
  /** Structured logger (createLogger scope). */
  log: {
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string, err?: unknown) => void
  }
  /** Injectable clock for deterministic rate-limit / budget tests. */
  now: () => number
}

// ── Pipeline run-state — the ONLY state that survives between ticks ─────────
//
// §2.39 simplification: exactly four plain counters, nothing per-item, no maps.
//   - `callCount`/`resetAt`: the rolling hourly rate-limit window (HARD bound).
//   - `inFlight`: single-flight latch serializing overlapping ticks (the 30s
//     timer can re-fire while a slow batch of ≤20 awaited network calls is still
//     running; two concurrent runs would each read `spentToday` and double-spend
//     the daily budget).
//   - `accountRotation`: rotates the starting account each cycle so an account
//     processed late does not starve behind the same leaders every tick.
//
// main.ts owns exactly one instance and threads it through every tick.
export interface AiRuleRateLimitState {
  callCount: number
  resetAt: number
  /** True while a batch is executing — a second tick returns immediately. */
  inFlight: boolean
  /** Monotonic cycle counter; `% accountCount` picks the starting account so
   *  no single account can permanently starve the others. */
  accountRotation: number
}

export function createRateLimitState(): AiRuleRateLimitState {
  return {
    callCount: 0,
    resetAt: 0,
    inFlight: false,
    accountRotation: 0,
  }
}

const HOUR_MS = 3_600_000

/** Enqueue an email for background triage. Capped at AI_RULE_QUEUE_MAX; once
 *  full the OLDEST pending item is dropped (an un-triaged message is
 *  preferable to an unbounded queue that OOMs the main process). */
export function enqueueForAiRules(
  queue: AiRulePendingItem[],
  item: AiRulePendingItem,
): void {
  if (queue.length >= AI_RULE_QUEUE_MAX) queue.shift()
  queue.push(item)
}

/** Parse a rule's stored allowedActions JSON into a validated action list.
 *  Malformed/non-array JSON falls back to a safe default; unknown action
 *  strings inside a well-formed array are filtered out (the AI-rule action set
 *  is a closed enum). */
export function parseAllowedActions(raw: string): RuleAction['type'][] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return ['archive', 'move', 'mark_read']
  }
  if (!Array.isArray(parsed)) return ['archive', 'move', 'mark_read']
  const known = new Set<RuleAction['type']>([
    'move',
    'archive',
    'trash',
    'mark_read',
    'mark_starred',
    'mark_spam',
  ])
  return parsed.filter(
    (a): a is RuleAction['type'] =>
      typeof a === 'string' && known.has(a as RuleAction['type']),
  )
}

/** Real folder paths cached for an account, as a lookup set for `move`. */
export function accountFolderSet(
  accountId: number,
  cache: Record<number, Array<{ path: string }>>,
): Set<string> {
  const boxes = cache[accountId] ?? []
  return new Set(boxes.map((b) => b.path))
}

// ── Core orchestration ─────────────────────────────────────────────────────

/**
 * Process one batch of queued emails through the AI Rules pipeline.
 *
 * Model (§2.39 simplification): STATELESS-PER-TICK, ATOMIC-PER-ACCOUNT.
 *
 *   - Single-flight (`rate.inFlight`) serializes overlapping ticks so two
 *     concurrent runs cannot each read `spentToday` and double-spend the budget.
 *   - Pre-latch preflight (`listAiRules`/`now`/`sumRuleCostSince`) runs inside a
 *     try/catch so a fault there resolves cleanly, dequeues nothing, and leaves
 *     `inFlight` false for the next healthy tick.
 *   - Hourly rate limit (`callCount`/`resetAt`) — a HARD bound on model calls.
 *   - Daily budget is a SOFT cap: `sumRuleCostSince(todayStart)` +
 *     in-batch `accumulatedCost`, re-checked before starting each account. There
 *     is NO cross-tick carry of un-persisted charges: if an audit INSERT fails,
 *     the soft cap under-counts that one call this tick — acceptable and
 *     documented, because the HARD hourly cap bounds total spend regardless.
 *   - ATOMIC per account: for each account, in `accountRotation` order,
 *       * `applicableRules` (globals + this account's rules). The config-time
 *         cap guarantees `applicableRules.length <= AI_RULE_MAX_CALLS_PER_HOUR`,
 *         so a full account always fits a fresh window.
 *       * If the REMAINING call/budget headroom cannot cover the account's WHOLE
 *         rule set, do NOT start it: requeue this account AND every not-yet-
 *         processed account, then stop. (No partial account.)
 *       * Otherwise run EVERY applicable rule. If ANY rule call fails
 *         (null result / rejected parse), the account is "incomplete": requeue
 *         all its items, apply NOTHING (full from-scratch retry next tick — no
 *         partial-apply, no double-apply, no silent loss).
 *       * If all rule calls succeed, dedup to one action per item and apply.
 *         A per-item apply that THROWS (transient IMAP) requeues THAT item only
 *         (it re-classifies from scratch next tick — correct, since successful
 *         items already left the queue). The execution-log INSERT is a separate
 *         best-effort write AFTER a successful apply; its failure never requeues.
 *   - On any exception after the splice, the `finally` requeues the exact
 *     remaining multiset under the hard queue cap (no silent loss).
 *
 * Invariant: each dequeued item is either fully triaged (all account rules ran
 * and its decisions applied / no-op) or requeued whole (retry from scratch).
 * Nothing per-item is remembered between ticks.
 */
export async function processAiRuleBatch(
  deps: AiRulesPipelineDeps,
  rate: AiRuleRateLimitState,
): Promise<void> {
  if (deps.isShuttingDown()) return
  // Single-flight: a second tick that overlaps a still-running batch returns
  // immediately. Without this the concurrent run would re-read `spentToday`
  // and overshoot the daily budget by a full second batch.
  if (rate.inFlight) return
  if (deps.queue.length === 0) return

  // ── Pre-latch preflight (fault-contained) ────────────────────────────────
  // Collaborators consulted BEFORE the single-flight latch. A throw here (a DB
  // read failing, a bad clock) must not escape as an unhandled rejection out of
  // the timer's `void processAiRuleBatch()`, must not dequeue anything, and must
  // leave `inFlight` false.
  let activeRules: AiRulePipelineRule[]
  let spentToday: number
  let maxBudget: number
  try {
    const rules = deps.listAiRules()
    activeRules = rules.filter((r) => r.enabled)
    if (activeRules.length === 0) {
      // No enabled rules — nothing can act on these; clear so we don't spin.
      deps.queue.length = 0
      return
    }

    // Hourly rate limit — reset the rolling window if it has elapsed.
    const nowMs = deps.now()
    if (nowMs > rate.resetAt) {
      rate.callCount = 0
      rate.resetAt = nowMs + HOUR_MS
    }
    if (rate.callCount >= AI_RULE_MAX_CALLS_PER_HOUR) {
      // Cap reached: leave the queue intact so items retry once the window rolls.
      deps.log.warn('Hourly rate limit reached, skipping batch')
      return
    }

    // Daily budget baseline — real spend from the durable audit log since
    // midnight. SOFT cap (see the note above): no cross-tick carry of an
    // un-persisted charge; the HARD hourly cap is the real bound.
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    spentToday = deps.sumRuleCostSince(todayStart.toISOString())
    maxBudget = activeRules.reduce((sum, r) => sum + r.budgetPerDayUsd, 0)
    if (spentToday >= maxBudget) {
      // Budget exhausted: do NOT clear the queue — the items must survive until
      // the next daily window. The AI_RULE_QUEUE_MAX drop-oldest cap bounds
      // growth in the meantime.
      deps.log.warn(
        `Daily budget exhausted (spent: $${spentToday.toFixed(2)}, limit: $${maxBudget.toFixed(2)})`,
      )
      return
    }
  } catch (err) {
    // Pre-latch fault: nothing was dequeued, the latch was never taken, and the
    // queue is untouched. Swallow so the timer's fire-and-forget promise
    // resolves; the next healthy tick retries the whole batch.
    deps.log.error('processAiRuleBatch preflight error:', err)
    return
  }

  // Latch AFTER the cheap early-outs so a skipped tick does not hold the latch;
  // released in `finally`. Everything past this point can await, so the timer
  // may re-enter — the latch makes that re-entry a no-op.
  rate.inFlight = true

  // The exact multiset dequeued this tick; any item still here at the end (an
  // incomplete account, a failed apply, an untouched account, an exception after
  // the splice) is requeued whole. An item is removed the instant its account is
  // fully applied (or a single failed-apply item is requeued individually).
  let batch: AiRulePendingItem[] = []
  const untriaged = new Map<number, AiRulePendingItem[]>()

  /** Requeue every item still owed triage at the FRONT of the queue (they were
   *  dequeued first, so re-fronting preserves FIFO for the retry), under the
   *  hard queue cap.
   *
   *  Eviction policy: after `unshift`, the queue is
   *  `[requeued-leftovers ... , pre-existing arrivals ...]`. Truncating with
   *  `queue.length = CAP` drops from the TAIL — the NEWEST arrivals that showed
   *  up while this batch was in flight (drop-newest-arrival). Rationale: a
   *  message we already dequeued is worth more than a brand-new arrival, so the
   *  in-flight cohort at the front is protected and the excess newest arrivals
   *  are shed. This intentionally differs from `enqueueForAiRules` (drop-oldest
   *  on push): the two paths protect different ends on purpose. */
  const requeueUntriaged = () => {
    const leftover: AiRulePendingItem[] = []
    for (const items of untriaged.values()) leftover.push(...items)
    untriaged.clear()
    if (leftover.length === 0) return
    deps.queue.unshift(...leftover)
    if (deps.queue.length > AI_RULE_QUEUE_MAX) {
      deps.queue.length = AI_RULE_QUEUE_MAX
    }
  }

  /** Drop every occurrence of the account's items from the un-triaged tracker —
   *  the whole account reached a FINAL outcome (all rules ran, decisions applied
   *  or no-op). Called only when an account completes atomically. */
  const markAccountFinal = (accountId: number) => {
    untriaged.delete(accountId)
  }

  /** Settle ONE item as final, removing it from its account's un-triaged bucket
   *  the INSTANT its mailbox outcome is irreversible (a reversible action was
   *  committed, or a destructive preview was recorded). This must happen BEFORE
   *  any best-effort post-apply work (execution-log INSERT, telemetry, logging):
   *  if that later work — or the processing of the NEXT resolved item — throws,
   *  the outer catch/finally requeue must NOT re-front an already-applied item
   *  (which would DOUBLE-APPLY next tick). Apply-settlement is independent of
   *  account atomicity: atomicity governs CLASSIFICATION (all rules must run
   *  before we decide), but once a decision is physically applied to the mailbox
   *  the item is done regardless of what happens to its siblings. */
  const settleItemFinal = (item: AiRulePendingItem) => {
    const bucket = untriaged.get(item.accountId)
    if (!bucket) return
    const idx = bucket.indexOf(item)
    if (idx !== -1) bucket.splice(idx, 1)
    if (bucket.length === 0) untriaged.delete(item.accountId)
  }

  /** Requeue exactly one item (a transient apply fault). Removes it from the
   *  account's un-triaged bucket so it is not double-counted, then re-fronts it
   *  under the hard cap for a from-scratch retry next tick. */
  const requeueOneItem = (item: AiRulePendingItem) => {
    const bucket = untriaged.get(item.accountId)
    if (bucket) {
      const idx = bucket.indexOf(item)
      if (idx !== -1) bucket.splice(idx, 1)
      if (bucket.length === 0) untriaged.delete(item.accountId)
    }
    if (deps.queue.length >= AI_RULE_QUEUE_MAX) deps.queue.shift()
    deps.queue.unshift(item)
  }

  /** Run a best-effort post-apply side effect (execution-log INSERT, telemetry,
   *  structured logging) with its throw FULLY contained. Once an item is settled
   *  final (fix #2), none of these observability writes may un-settle it — a
   *  throw here must never reach the outer catch/finally and trigger a requeue
   *  of an already-applied item (which would DOUBLE-APPLY next tick). */
  const bestEffort = (fn: () => void, errMsg?: string) => {
    try {
      fn()
    } catch (err) {
      deps.log.error(errMsg ?? 'Best-effort post-apply side effect failed:', err)
    }
  }

  try {
    // Dequeue up to one batch worth of items.
    batch = deps.queue.splice(0, AI_RULE_BATCH_SIZE)
    if (batch.length === 0) return

    // Seed the un-triaged tracker with the full dequeued batch, keyed by account.
    for (const it of batch) {
      const bucket = untriaged.get(it.accountId)
      if (bucket) bucket.push(it)
      else untriaged.set(it.accountId, [it])
    }

    const ruleSpecs: AiRuleSpec[] = activeRules.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      // `priority`/`stopProcessing` are not part of the AI-rule schema; every
      // rule is equal-priority and non-terminal → deterministic dedup (first
      // rule in listing order wins per email).
      priority: 0,
      prompt: r.prompt,
      allowedActions: parseAllowedActions(r.allowedActions),
      stopProcessing: false,
    }))

    const mailboxCache = deps.getMailboxCache()

    // Per-account isolation: a per-account rule only ever sees its own mail.
    const byAccount = groupBatchByAccount(batch)
    // Stable account order, rotated by the persistent cycle cursor so no single
    // account can permanently starve the others. Advance the cursor for the NEXT
    // cycle regardless of how this one ends.
    const baseOrder = [...byAccount.keys()]
    const rot = baseOrder.length > 0 ? rate.accountRotation % baseOrder.length : 0
    const accountOrder = [...baseOrder.slice(rot), ...baseOrder.slice(0, rot)]
    rate.accountRotation = (rate.accountRotation + 1) % Number.MAX_SAFE_INTEGER

    // Running spend accumulated across THIS batch's calls, added on top of the
    // day's baseline before starting each account.
    let accumulatedCost = 0

    // ── Shared destructive-preview / reversible-apply helper ─────────────────
    // Applies ONE resolved decision for ONE item, honouring every security
    // invariant. Returns 'final' when the item reached a terminal outcome
    // (preview recorded / reversible applied / action refused), or 'retry' when
    // a TRANSIENT apply failure means the item must be requeued from scratch.
    const applyDecision = async (
      item: AiRulePendingItem,
      rule: AiRuleSpec,
      decision: AiRuleDecision,
    ): Promise<'final' | 'retry'> => {
      if (isDestructiveAiRuleAction(decision.action)) {
        // Preview/apply invariant (CLAUDE.md §5): destructive background actions
        // are NEVER auto-applied. Record a pending-preview entry and leave the
        // message untouched. The preview WRITE is the terminal side effect here,
        // so it stays inside the try: if it fails, the item is requeued (a
        // preview is idempotent; the Privacy Panel dedups pending previews by
        // uid+action), which is correct because nothing was recorded.
        try {
          deps.insertAiRuleLog({
            aiRuleId: rule.id,
            accountId: String(item.accountId),
            folder: item.folder,
            uid: item.uid,
            actionTaken: JSON.stringify({
              type: decision.action,
              // §2.39 MEDIUM (defense-in-depth) — `folder` is only meaningful
              // for `move`. The parse boundary already strips it for non-move
              // actions, but the durable ai_rule_log row must STRUCTURALLY never
              // carry a folder field for a destructive (`trash`/`mark_spam`)
              // action — a model-echoed PII string must not reach this sink even
              // if the upstream guard regresses. Belt and suspenders.
              ...(decision.action === 'move' ? { folder: decision.folder } : {}),
              status: 'preview_pending',
            }),
            // §2.39 MEDIUM — model-generated `decision.reasoning` is NEVER
            // persisted to ai_rule_log. A prompt-injected sender can coax the
            // model to echo the subject / address / a body fragment into
            // `reasoning`; persisting it would mint a second, durable PII copy in
            // ai_rule_log that outlives deletion of the source email and surfaces
            // in the Settings rule log — violating the "verifiable private inbox"
            // invariant. The trusted, PII-free `actionTaken` (action type + rule
            // id + folder) is the only free-text we keep. `reasoning` stays in
            // local createLogger diagnostics only (never on disk in the DB sink).
          })
        } catch (err) {
          deps.log.error(
            `Failed to record destructive AI rule preview for uid=${item.uid}:`,
            err,
          )
          return 'retry'
        }
        // The preview is recorded → the item is FINAL. Settle it out of the
        // un-triaged tracker immediately, then run best-effort telemetry/logging
        // as guaranteed non-throwing so their failure can never un-settle it.
        settleItemFinal(item)
        bestEffort(() => {
          deps.recordEvent('ai.rule.destructive_preview', {
            action: decision.action === 'trash' ? 'trash' : 'mark_spam',
          })
        })
        bestEffort(() => {
          deps.log.info(
            `AI rule proposed destructive action (preview, not applied): uid=${item.uid} action=${decision.action}`,
          )
        })
        return 'final'
      }

      // Reject-by-default guard: only a POSITIVELY reversible action may be
      // auto-executed. A future action added to parsing but to neither the
      // reversible nor destructive set falls through here and is dropped, never
      // auto-applied. A refused action is a terminal (final) no-op for the item.
      if (!isReversibleAiRuleAction(decision.action)) {
        deps.log.warn(
          `AI rule produced a non-reversible, non-destructive action; refusing to auto-apply: uid=${item.uid} action=${decision.action}`,
        )
        return 'final'
      }

      const reversibleAction = decision.action as
        | 'archive'
        | 'move'
        | 'mark_read'
        | 'mark_starred'
      // §2.39 MEDIUM (defense-in-depth) — only a `move` carries a target
      // folder. The parse boundary already drops `folder` for non-move actions,
      // but `ruleAction` is what gets serialized into the durable ai_rule_log
      // row below, so we build it to STRUCTURALLY omit `folder` for every
      // non-move action. A model-echoed PII string must never reach the sink
      // even if the upstream guard regresses. Belt and suspenders on the
      // durable sink.
      const ruleAction: RuleAction =
        decision.action === 'move'
          ? { type: decision.action, folder: decision.folder }
          : { type: decision.action }

      try {
        await deps.executeRuleAction(item.accountId, item.folder, item.uid, ruleAction)
      } catch (err) {
        // Transient apply fault (IMAP down) — do NOT settle. The caller requeues
        // this one item; next tick it re-classifies from scratch. Successful
        // items already left the queue, so there is no double-apply risk.
        deps.log.error(`Failed to execute AI rule action for uid=${item.uid}:`, err)
        return 'retry'
      }
      // The mailbox commit SUCCEEDED and is irreversible — the item is FINAL.
      // Settle it out of the un-triaged tracker RIGHT NOW, before ANY post-apply
      // work. Everything below (execution-log INSERT, telemetry, logging) is
      // best-effort observability: if any of it throws — or if a LATER resolved
      // item throws — the outer catch/finally requeue must not re-front this
      // already-applied item (which would DOUBLE-APPLY next tick).
      settleItemFinal(item)
      bestEffort(() => {
        deps.insertAiRuleLog({
          aiRuleId: rule.id,
          accountId: String(item.accountId),
          folder: item.folder,
          uid: item.uid,
          actionTaken: JSON.stringify(ruleAction),
          // §2.39 MEDIUM — model-generated `decision.reasoning` is NEVER
          // persisted here either (see the destructive-preview path above): it
          // could carry sender-injected PII into a durable ai_rule_log row.
          // `actionTaken` (trusted action type + folder) is the only free-text.
        })
      }, `AI rule applied but execution-log write failed for uid=${item.uid} (action already applied, not retried)`)
      bestEffort(() => {
        deps.recordEvent('ai.rule.applied', { action: reversibleAction })
      })
      bestEffort(() => {
        deps.log.info(`AI rule applied: uid=${item.uid} action=${decision.action}`)
      })
      return 'final'
    }

    for (const accountId of accountOrder) {
      const accountBatch = byAccount.get(accountId)!
      const applicableRules = rulesForAccount(ruleSpecs, accountId)

      if (applicableRules.length === 0) {
        // No rule can act on this account's mail → its items are a completed
        // no-op; the whole account settles final.
        markAccountFinal(accountId)
        continue
      }

      // ── Admission: CALL-atomic gate + SOFT budget gate ─────────────────────
      // Two independent gates, decoupled on purpose (fix #1 — the old combined
      // gate `budgetRemaining >= rules * worstCasePerCall` deadlocked: a rule
      // whose budgetPerDayUsd was smaller than one null-usage reservation floor
      // ($0.05) could NEVER be admitted even in a totally fresh window, so its
      // queue never drained):
      //
      //   (1) CALL atomicity (HARD): the whole applicable rule set must fit the
      //       remaining hourly call window. The config-time per-account enabled
      //       cap guarantees `applicableRules.length <= AI_RULE_MAX_CALLS_PER_HOUR`,
      //       so a full account always fits a FRESH window; here we check the
      //       CURRENT remaining headroom. If it cannot cover the whole account we
      //       do NOT start it (no partial account) — defer this account and every
      //       not-yet-processed account, then stop.
      //
      //   (2) BUDGET (SOFT): admit as long as there is ANY positive budget
      //       headroom (`spentToday + accumulatedCost < maxBudget`). We do NOT
      //       require room for a worst-case reservation × rules — that is what
      //       caused the deadlock. An admitted account runs its WHOLE rule set;
      //       the daily budget is a soft cap that stops STARTING new accounts
      //       once exhausted, but never interrupts an already-admitted account.
      //       Bounded overshoot: because the account is call-atomic (≤ the call
      //       cap) the maximum a single admitted account can overspend the budget
      //       by is the cost of one account's rule set (≤ `AI_RULE_MAX_CALLS_PER_HOUR`
      //       calls' worth), and the HARD hourly call cap bounds total spend
      //       regardless. This keeps the invariant that a valid enabled rule with
      //       positive budget in a fresh window ALWAYS runs and its queue drains.
      const tick = deps.now()
      if (tick > rate.resetAt) {
        rate.callCount = 0
        rate.resetAt = tick + HOUR_MS
      }
      const callsRemaining = AI_RULE_MAX_CALLS_PER_HOUR - rate.callCount
      if (callsRemaining < applicableRules.length) {
        // Not enough CALL headroom for the whole account → do not begin it. Leave
        // this account AND all remaining accounts in `untriaged` (the loop
        // breaks, so later accounts are never touched) for the finally requeue.
        deps.log.warn(
          `Insufficient call headroom for account ${accountId}'s full rule set (calls left: ${callsRemaining}, rules: ${applicableRules.length}); deferring this and remaining accounts`,
        )
        break
      }
      const budgetRemaining = maxBudget - (spentToday + accumulatedCost)
      if (budgetRemaining <= 0) {
        // Daily budget exhausted → do not START this (or any later) account. An
        // already-admitted account is never interrupted; this only blocks new
        // account starts. Defer this and all remaining accounts for the requeue.
        deps.log.warn(
          `Daily budget exhausted before account ${accountId} (spent: $${(spentToday + accumulatedCost).toFixed(4)}, limit: $${maxBudget.toFixed(4)}); deferring this and remaining accounts`,
        )
        break
      }

      const folderSet = accountFolderSet(accountId, mailboxCache)

      // Run EVERY applicable rule over the account's sub-batch. Collect each
      // rule's validated decisions for a single atomic dedup+apply at the end.
      // If ANY rule call fails, the account is incomplete → apply nothing.
      const perRuleDecisions: Array<{ rule: AiRuleSpec; decisions: AiRuleDecision[] }> = []
      let accountComplete = true

      for (const rule of applicableRules) {
        // wrapUntrusted() + per-field neutralization happens in buildAiRulePrompt.
        const { systemPrompt, userPrompt } = buildAiRulePrompt(
          { prompt: rule.prompt, allowedActions: rule.allowedActions },
          accountBatch,
        )

        // Count the call BEFORE awaiting so a concurrent tick sees it spent.
        rate.callCount++
        const result = await deps.aiChatSimple(systemPrompt, userPrompt)

        if (!result) {
          // A null provider result is a TRANSIENT classification failure. The
          // account is incomplete — abandon its decisions and requeue it whole.
          deps.log.warn(`AI provider returned no response for rule=${rule.id}`)
          recordAiRuleAudit(deps, null, 'error', undefined)
          accountComplete = false
          break
        }

        // Advance the running budget. A provider-reported usage prices exactly;
        // a SUCCESSFUL call with NO usable usage (null/missing/non-finite) is
        // charged a model-aware reservation so a paid-but-unmetered call cannot
        // slip past the daily cap within this batch.
        const cost = estimateAiRuleCostUsd(result.model, result.usage)
        const chargedCost =
          typeof cost === 'number' ? cost : nullUsageReservationUsd(result.model)
        accumulatedCost += chargedCost
        recordAiRuleAudit(deps, result, 'ok', chargedCost)

        const parsed = parseAiRuleResponse(result.text, accountBatch.length, rule.allowedActions)
        if (!parsed.ok) {
          // A rejected parse is a TRANSIENT classification failure — the model
          // responded but its output was unusable. The account is incomplete.
          deps.log.warn(`AI response rejected for rule=${rule.id}: ${parsed.reason}`)
          accountComplete = false
          break
        }

        // A wholly-empty or wholly-filtered decision set is a CONFIRMED no-op
        // for these items at THIS rule, NOT a failure.
        const validated = parsed.decisions
          .map((d) => validateDecisionFolder(d, folderSet))
          .filter((d): d is AiRuleDecision => d !== null)
        perRuleDecisions.push({ rule, decisions: validated })
      }

      if (!accountComplete) {
        // Incomplete: apply NOTHING for this account; its items stay in
        // `untriaged` and are requeued whole by the finally block. A full
        // from-scratch retry next tick avoids partial-apply and double-apply.
        continue
      }

      // Every rule succeeded. Resolve to AT MOST ONE action per item, in rule
      // (listing) order — the first rule that decides an item claims it
      // (dedupeAiRuleActions, first-rule-wins). decision.index maps against the
      // account sub-batch every rule saw (identical order), so the index space
      // is correct.
      const resolved = dedupeAiRuleActions(perRuleDecisions, accountBatch)

      // Apply the resolved actions. Each applied/previewed item is settled out of
      // `untriaged` INSIDE applyDecision, the instant its mailbox outcome is
      // irreversible (fix #2) — so a later item's throw cannot re-front it. A
      // transient apply fault returns 'retry' and requeues THAT item individually.
      for (const { rule, item, decision } of resolved) {
        const outcome = await applyDecision(item, rule, decision)
        if (outcome === 'retry') {
          requeueOneItem(item)
        }
        // On 'final' the item was already settled inside applyDecision.
      }
      // Every item that got a decision was settled (applied) or requeued (retry)
      // inside the loop; only the account's no-op items (no rule claimed them)
      // remain in `untriaged`. They are confirmed no-ops → drop the whole account.
      markAccountFinal(accountId)
    }
  } catch (err) {
    deps.log.error('processAiRuleBatch error:', err)
  } finally {
    // Any item not settled as final (an incomplete account, an untouched account
    // after an early stop, or an exception after the splice) is still in
    // `untriaged` — requeue the exact remaining multiset under the hard cap so
    // no dequeued message is silently lost and no applied message is replayed.
    requeueUntriaged()
    rate.inFlight = false
  }
}

/**
 * Mirror a background AI-rule model call into the append-only audit log
 * (ai_action_log / B1 Privacy Panel). Best-effort — never throws, and its
 * failure never blocks or unsettles pipeline work.
 *
 * `chargedCost` is the amount the pipeline booked against the daily budget for
 * THIS call:
 *   - a real, priced cost when the provider reported usable token usage, OR
 *   - the model-aware null-usage RESERVATION for a successful-but-unmetered
 *     call, OR
 *   - `undefined` for an error outcome (no billable call → no cost row).
 *
 * §2.39 simplification: the daily budget is a SOFT cap. If this audit INSERT
 * fails, the next tick's `sumRuleCostSince` baseline will under-count this one
 * call — an accepted, documented gap. The HARD bound is the hourly call cap
 * (`AI_RULE_MAX_CALLS_PER_HOUR`), which binds regardless of audit persistence,
 * so there is NO cross-tick carry of an un-persisted charge (that carry, and its
 * lifecycle bugs, is exactly what this simplification removed). Writing the
 * reservation (not `null`) still tightens the soft cap across ticks in the
 * common case where the INSERT succeeds. `input_tokens`/`output_tokens` stay
 * null for a reserved row (we have no counts), so the Privacy Panel distinguishes
 * a metered row (tokens + cost) from a reserved row (cost only, tokens n/a).
 */
function recordAiRuleAudit(
  deps: AiRulesPipelineDeps,
  result: AiRulePipelineChatResult | null,
  outcome: 'ok' | 'error',
  chargedCost: number | undefined,
): void {
  // Only persist a finite charged cost; never write a non-finite value that a
  // later SUM() would propagate as NaN into the budget baseline.
  const costUsd =
    typeof chargedCost === 'number' && Number.isFinite(chargedCost)
      ? chargedCost
      : null
  try {
    const { provider, model: settingsModel } = deps.getProviderModel()
    const model = result?.model ?? settingsModel ?? null
    deps.appendAiActionLog({
      provider: provider || 'unknown',
      model,
      goal: 'rule',
      toolName: null,
      inputTokens: result?.usage?.inputTokens ?? null,
      outputTokens: result?.usage?.outputTokens ?? null,
      costUsd,
      // The background pipeline always wraps + neutralizes email content in
      // untrusted boundary markers (buildAiRulePrompt), so record one wrap.
      untrustedWrapped: 1,
      injectionBlocked: 0,
      outcome,
    })
  } catch (err) {
    // A throw out of the collaborator (should not happen — the DB helper
    // swallows internally) is only observability loss; the SOFT budget cap
    // simply under-counts this call this tick. Never propagate.
    deps.log.warn('AI rule audit-log write failed (soft budget may under-count this call)')
    void err
  }
}
