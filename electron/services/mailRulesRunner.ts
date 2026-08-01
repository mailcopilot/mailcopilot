// ──────────────────────────────────────────────────────────────────────
// mailRulesRunner.ts — Static mail-rule evaluation pass for one folder.
//
// Extracted out of the electron/main.ts hotspot for the same reason as
// aiRulesPipeline.ts: the ordering invariants below are the whole feature, so
// tests must drive the REAL loop with fakes instead of a mirror copy.
//
// ── Why this exists (2026-07-30 incident) ────────────────────────────────
// Rules used to be a fire-and-forget tail of two IPC handlers, and each of them
// decided what was "new" with `uid > MAX(uid) FROM messages`, sampled just
// before its own fetch. `MAX(uid)` is a property of STORAGE, and storage has
// many writers that never evaluate rules:
//   - `net:folderPage` (pagination) persists headers, no rule tail;
//   - the FLAGS-only sync branch returns before the rule tail;
//   - a sync that throws after committing its batches skips the tail;
//   - the periodic background sync, which persists batches for every folder
//     it visits (those with `folder_prefs.headerSyncMode` full/period);
//   - `search:remoteSearch`, which hydrates server hits into the cache;
//   - the app quitting between the upsert and the fire-and-forget call.
// Any of those wrote a message AND pushed the bar above it, so the rule could
// never see that message again. Nine messages the user had an explicit trash
// rule for sat in the inbox forever.
//
// The fix follows Thunderbird (nsImapMailFolder.cpp): the watermark is a
// dedicated per-folder property owned by the rule pipeline itself
// (`kHighestRecordedUIDPropertyName` there, `mail_rules_state` here), read and
// advanced at the exact point a message is evaluated. It is never derived from
// the message store WHILE EVALUATING — which was the bug. `MAX(uid)` is still
// read in exactly one situation, to anchor a folder that has no position yet
// (startup seed, or the lazy baseline for a folder that appeared later), and
// anchoring evaluates nothing. Thunderbird also resets its mark on a
// UIDVALIDITY bump; we re-baseline instead (see `runOnePass`).
//
// Invariants:
//   1. During a pass, this module is the only writer of `mail_rules_state`.
//      The one other writer is the startup seed
//      (`seedMailRulesStateFromCache` in packages/db), which runs BEFORE any
//      sync and only ever INSERTs a starting position for a folder that has no
//      row (`INSERT OR IGNORE` + `WHERE NOT EXISTS`) — it can never move a
//      watermark this runner established. Nothing else may touch the table,
//      and in particular the value is never derived from `MAX(uid)` at
//      evaluation time.
//   2. Messages are evaluated in ascending UID order and the watermark is
//      advanced per message, so an interrupted pass leaves a contiguous
//      unprocessed tail. The next pass picks that tail up — EXCEPT when the
//      interruption was a UIDVALIDITY change, where the next pass re-baselines
//      and the tail is deliberately not revisited (those UIDs no longer denote
//      the same messages).
//   3. A folder the pipeline has never seen is BASELINED, not swept: rules
//      apply to mail arriving from now on. Retroactive application stays an
//      explicit user action (`rules:applyToFolder`). The PRIMARY baseline is
//      the startup seed (`seedMailRulesStateFromCache` in packages/db) — see
//      `runOnePass` for why the lazy one below cannot carry that job alone.
//      The seed covers every folder this install KNOWS about, including known
//      but empty ones (anchored at 0), not just those with cached messages.
//   4. Single-flight per (account, folder) — the pass is triggered from
//      several sync paths and they overlap in practice. A trigger that arrives
//      while a pass is running is REMEMBERED, not dropped (§2.86 iter2): the
//      running pass samples its UID list once, so a message persisted after
//      that sample would otherwise wait for an unrelated future trigger. A
//      pass that ends ABNORMALLY (stopped early, or threw) re-arms the marker
//      instead of consuming it (§2.86 iter3) — it did not do the work the
//      trigger asked for.
//   5. A message whose action failed is retried on the next passes, and the
//      pass STOPS at it rather than stepping over it — up to
//      MAIL_RULES_MAX_ACTION_ATTEMPTS, after which it is skipped for good and
//      reported. A dropped IMAP connection must not silently destroy a rule
//      the user explicitly configured (§2.86 iter2). NOTE what this does NOT
//      give: the attempt counter lives in process memory, so a restart hands
//      the same message a fresh budget. A message that fails deterministically
//      (a rule targeting a folder the server rejects) therefore stalls the
//      folder again after every restart. Bounding that for real needs the
//      per-message mark of §2.87 (`messages.rules_applied_at`), not a bigger
//      counter.
//   6. The UID numbering space is re-read before every destructive action
//      (per ACTION, not per message — actions are IMAP round-trips and a bump
//      can land between two of them), before handing a message to the AI-rules
//      pipeline, and before every watermark write. A concurrent sync can bump
//      UIDVALIDITY mid-pass, and acting on a reused UID with a stale decision
//      is the one failure mode here that destroys mail.
// ──────────────────────────────────────────────────────────────────────

import {
  matchRule,
  type MailRule,
  type MailContext,
  type RuleAction,
} from '../../packages/core'
import { classifyNetError } from './netErrorTelemetry'

/** Upper bound on messages evaluated in a single pass. */
export const MAIL_RULES_MAX_PER_PASS = 200

/**
 * Upper bound on consecutive passes chained inside one `runMailRules` call
 * (cap-hit continuation + remembered triggers). Bounds the work of a single
 * invocation at MAIL_RULES_MAX_ROUNDS × MAIL_RULES_MAX_PER_PASS messages and
 * makes runaway self-scheduling structurally impossible; anything left over is
 * picked up by the next trigger.
 */
export const MAIL_RULES_MAX_ROUNDS = 25

/**
 * Attempts allowed per (account, folder, uid) before a message whose action
 * keeps failing is skipped for good. Counted in memory only: a restart grants a
 * fresh budget, which is what we want for the common cause — a dead IMAP
 * connection is exactly what restarting fixes.
 *
 * The flip side, stated precisely — an earlier wording overstated it in both
 * directions. Reaching the cap is DURABLE: give-up advances the watermark, so a
 * restart does not retry that message (it is skipped for good, and never
 * evaluated — that loss is §2.87's to close). What a restart refills is an
 * UNFINISHED budget: a message whose action fails deterministically stalls its
 * folder tail for up to MAIL_RULES_MAX_ACTION_ATTEMPTS passes, and if restarts
 * keep landing before the cap is reached, that stall repeats indefinitely
 * without ever reporting a give-up. Only a durable per-message mark (§2.87,
 * `messages.rules_applied_at`) bounds it.
 */
export const MAIL_RULES_MAX_ACTION_ATTEMPTS = 3

/** Minimal shape of a stored rule row the runner consumes (from listMailRules). */
export interface MailRulesRunnerRule {
  id: string
  accountId: string | null
  name: string
  enabled: boolean
  priority: number
  /** JSON-encoded RuleCondition[]. */
  conditions: string
  /** JSON-encoded RuleAction[]. */
  actions: string
  stopProcessing: boolean
}

/** Minimal shape of a cached message the runner evaluates. */
export interface MailRulesRunnerMessage {
  subject: string
  from: string
  fromAddr: string
  toAddr?: string | null
  bodyText?: string | null
  hasAttachments: boolean
}

/** Collaborators injected by main.ts so tests can drive the real loop. */
export interface MailRulesRunnerDeps {
  /** In-flight guard keyed `${accountId}:${folder}` (main.ts owns the instance). */
  inFlight: Set<string>
  /**
   * Triggers that arrived while a pass held the key, same key shape. Owned by
   * main.ts so it survives across calls; consumed by the running pass.
   */
  pendingRerun: Set<string>
  /**
   * Consecutive action failures keyed `${accountId}:${folder}:${uid}`. Owned by
   * main.ts (process-lifetime), cleared on success or on final give-up.
   */
  actionAttempts: Map<string, number>
  /** Rules visible to this account (account-scoped + global). */
  listMailRules: (accountId: string) => MailRulesRunnerRule[]
  /** Persisted pipeline position, or undefined when never evaluated. */
  getMailRulesState: (accountId: number, folder: string) => { watermarkUid: number; uidValidity: number | null } | undefined
  /** Write the pipeline position. Only this runner may call it. */
  setMailRulesState: (accountId: number, folder: string, watermarkUid: number, uidValidity: number | null) => void
  /** Current UIDVALIDITY for the folder, or null when unknown. */
  getUidValidity: (accountId: number, folder: string) => number | null
  /** Highest cached UID — used ONLY to baseline a folder, never to gate work. */
  getMaxUidForFolder: (accountId: number, folder: string) => number
  /** Unevaluated UIDs above the watermark, ascending. */
  getUidsForRulesSince: (accountId: number, folder: string, sinceUid: number, limit: number) => number[]
  /** Load one cached message. */
  getMessageByUid: (accountId: number, folder: string, uid: number) => MailRulesRunnerMessage | undefined
  /** Execute one rule action against the real mailbox. */
  executeRuleAction: (accountId: number, folder: string, uid: number, action: RuleAction) => Promise<void>
  /** Append a row to the rule_log execution table. */
  insertRuleLog: (data: {
    ruleId: string
    ruleName: string
    accountId: number
    folder: string
    uid: number
    subject: string
    fromAddr: string
    actionTaken: string
  }) => void
  /** Hand a message no static rule matched to the AI-rules pipeline. */
  enqueueForAiRules: (item: {
    accountId: number
    folder: string
    uid: number
    from: string
    to: string
    subject: string
    bodyPreview: string
    hasAttachment: boolean
  }) => void
  /** Structured logger (createLogger scope) — local file sink, never transmitted. */
  log: {
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string, err?: unknown) => void
  }
  /** Sentry reporter — never throws (see electron/sentry.ts). */
  captureException: (err: unknown, context: Record<string, unknown>) => void
}

/** Outcome of one `runMailRules` call, for logging and tests. */
export interface MailRulesPassResult {
  /** Messages evaluated across every round of this call. */
  evaluated: number
  /** Messages at least one rule matched. */
  matched: number
  /** True when the call only established a starting point and evaluated nothing. */
  baselined: boolean
  /** True when another pass for the same folder was already running. */
  skipped: boolean
  /**
   * True when the last round stopped early — a UIDVALIDITY change mid-pass, or
   * a message whose action failed and still has retries left. Neither is an
   * error: the watermark stays where it is and the next trigger resumes.
   */
  aborted: boolean
}

/** Result of a single round; `hitLimit` drives automatic continuation. */
interface RoundResult {
  evaluated: number
  matched: number
  baselined: boolean
  aborted: boolean
  hitLimit: boolean
}

const SKIPPED_PASS: MailRulesPassResult = {
  evaluated: 0, matched: 0, baselined: false, skipped: true, aborted: false,
}

/** Parse the stored JSON of a rule row; returns null when either side is malformed. */
function parseRule(row: MailRulesRunnerRule): MailRule | null {
  try {
    return {
      id: row.id,
      accountId: row.accountId,
      name: row.name,
      enabled: true,
      priority: row.priority,
      conditions: JSON.parse(row.conditions) as MailRule['conditions'],
      actions: JSON.parse(row.actions) as MailRule['actions'],
      stopProcessing: row.stopProcessing,
    }
  } catch {
    return null
  }
}

/**
 * Evaluate static mail rules for every message in `folder` the pipeline has not
 * looked at yet.
 *
 * Safe to call from any sync path and as often as it likes: the watermark makes
 * the pass idempotent, so over-triggering costs a cheap indexed query.
 *
 * Single-flight with memory. A call that finds the key busy records the request
 * and returns `skipped`; the running pass replays it before releasing the key.
 * Without that, the classic lost-wakeup applies — the running pass sampled its
 * UID list before the newer message was persisted, and nothing would look again
 * until an unrelated trigger happened by. The same mechanism drains a folder
 * that has more than MAIL_RULES_MAX_PER_PASS messages waiting. A pass that ends
 * abnormally re-arms the marker rather than consuming it, so a request is only
 * ever retired by a pass that actually served it.
 */
export async function runMailRules(
  accountId: number,
  folder: string,
  deps: MailRulesRunnerDeps,
): Promise<MailRulesPassResult> {
  const key = `${accountId}:${folder}`
  if (deps.inFlight.has(key)) {
    deps.pendingRerun.add(key)
    return { ...SKIPPED_PASS }
  }
  deps.inFlight.add(key)
  // Everything requested before this pass started is covered by it: nothing has
  // been sampled yet — PROVIDED this call goes on to complete normally. The
  // `finally` below puts the request back when it does not (§2.86 iter3).
  deps.pendingRerun.delete(key)
  let served = false
  try {
    const total: MailRulesPassResult = {
      evaluated: 0, matched: 0, baselined: false, skipped: false, aborted: false,
    }
    for (let round = 1; round <= MAIL_RULES_MAX_ROUNDS; round++) {
      const pass = await runOnePass(accountId, folder, deps)
      total.evaluated += pass.evaluated
      total.matched += pass.matched
      total.baselined = total.baselined || pass.baselined
      total.aborted = pass.aborted

      // From here to the `finally` below there is NO await. That is what makes
      // the hand-off race-free: a caller that arrives after this check cannot
      // observe the key as free (we still hold it) and cannot have its request
      // dropped (we no longer consume the set).
      const requestedAgain = deps.pendingRerun.delete(key)
      // An aborted round must not be retried inside the same call: for the
      // retry case that would burn the whole attempt budget in one go against
      // the same dead connection, and for the UIDVALIDITY case the next pass
      // has to re-read state from scratch anyway. The request consumed just
      // above is NOT lost by this `break` — the `finally` re-arms the key.
      if (pass.aborted) break
      if (!requestedAgain && !pass.hitLimit) break
      if (round === MAIL_RULES_MAX_ROUNDS) {
        deps.log.warn(
          `Rules pass for ${folder} account ${accountId} hit the ${MAIL_RULES_MAX_ROUNDS}-round cap; remaining messages wait for the next trigger`
        )
      }
    }
    served = !total.aborted
    return total
  } finally {
    // A call that stopped early or threw did NOT do what the trigger asked for,
    // yet it consumed the pending marker on entry. Dropping it there is a
    // lost wake-up of the worst kind: the classic case is a sync publishing a
    // UIDVALIDITY bump, the running pass aborting BECAUSE of that bump, eating
    // the trigger the same sync raised, and the re-anchor it existed for never
    // happening. Re-arming here (same set, no new state) keeps the folder
    // marked as still needing a look. No await between this and the release, so
    // the two are atomic against another caller.
    if (!served) deps.pendingRerun.add(key)
    deps.inFlight.delete(key)
  }
}

/** One evaluation round over at most MAIL_RULES_MAX_PER_PASS messages. */
async function runOnePass(
  accountId: number,
  folder: string,
  deps: MailRulesRunnerDeps,
): Promise<RoundResult> {
  const uidValidity = deps.getUidValidity(accountId, folder)
  const state = deps.getMailRulesState(accountId, folder)

  // A UIDVALIDITY bump means the stored watermark belongs to a different UID
  // numbering space, so comparing across it is meaningless in either direction.
  // "Unknown" (null) on either side is NOT a bump: it means no sync has
  // recorded the value yet, and treating it as one would re-baseline right
  // after the first sync — swallowing exactly the mail that sync just fetched.
  const bumped = state != null
    && state.uidValidity !== null
    && uidValidity !== null
    && state.uidValidity !== uidValidity

  if (!state || bumped) {
    // Baseline: re-anchor to the current highest cached UID and evaluate
    // NOTHING, so enabling a rule — or a server hiccup — can never
    // retroactively trash a mailbox. Thunderbird resets the mark to 0 on a bump
    // instead, which is safe there only because it purges and re-fetches the
    // folder through the same ingest path that filters.
    //
    // This lazy path is the SECONDARY one. It exists for a folder that appears
    // after startup (newly subscribed, newly created on the server), where
    // "everything currently cached" is by definition pre-existing mail. The
    // primary baseline is `seedMailRulesStateFromCache()`, which runs BEFORE
    // any sync: reached from here on first launch instead, `MAX(uid)` would
    // already include mail the just-finished fetch persisted, and that mail
    // would be declared old forever — the very defect §2.86 fixes.
    const baseline = deps.getMaxUidForFolder(accountId, folder)
    deps.setMailRulesState(accountId, folder, baseline, uidValidity)
    deps.log.info(`Rules baselined for ${folder} account ${accountId} at uid=${baseline}`)
    return { evaluated: 0, matched: 0, baselined: true, aborted: false, hitLimit: false }
  }

  // Value written back with every watermark advance. `uidValidity ?? stored`
  // so a transiently unreadable `sync_state` cannot erase a space we already
  // recorded — losing it would make the next real bump undetectable.
  const recordedValidity = uidValidity ?? state.uidValidity

  if (state.uidValidity === null && uidValidity !== null) {
    // The space just became known (first sync of a folder seeded from cache).
    // Adopt it without moving the watermark — see `bumped` above.
    deps.setMailRulesState(accountId, folder, state.watermarkUid, recordedValidity)
  }

  /**
   * Re-read the UID numbering space. A concurrent sync commits message rows
   * BEFORE it updates `sync_state`, so a bump can land in the middle of this
   * pass; acting on a reused UID with a decision made in the old space is the
   * one failure mode here that destroys mail (`trash` on a fresh message).
   * A pass that started with an unknown space has nothing to compare against.
   */
  const spaceChanged = (): boolean =>
    uidValidity !== null && deps.getUidValidity(accountId, folder) !== uidValidity

  const uids = deps.getUidsForRulesSince(accountId, folder, state.watermarkUid, MAIL_RULES_MAX_PER_PASS)
  if (uids.length === 0) {
    return { evaluated: 0, matched: 0, baselined: false, aborted: false, hitLimit: false }
  }

  // Rules are loaded once per pass; a rule edited mid-pass takes effect on the
  // next one. `enabled` is filtered here so `matchRule` never sees a disabled
  // rule, and priority order is fixed up front.
  const rules = deps.listMailRules(String(accountId))
    .filter(r => r.enabled)
    .map(parseRule)
    .filter((r): r is MailRule => r !== null)
    .sort((a, b) => a.priority - b.priority)

  let evaluated = 0
  let matched = 0
  let abortReason: 'uidvalidity_changed' | 'action_retry_pending' | null = null

  for (const uid of uids) {
    const attemptKey = `${accountId}:${folder}:${uid}`
    try {
      const msg = deps.getMessageByUid(accountId, folder, uid)
      if (!msg) {
        // Message vanished between the query and now (moved, expunged). It is
        // gone from this folder, so there is nothing left to act on — advance
        // past it rather than retrying it forever.
        deps.actionAttempts.delete(attemptKey)
        if (spaceChanged()) { abortReason = 'uidvalidity_changed'; break }
        deps.setMailRulesState(accountId, folder, uid, recordedValidity)
        continue
      }

      const context: MailContext = {
        from: msg.from,
        fromAddr: msg.fromAddr,
        to: msg.toAddr || '',
        subject: msg.subject,
        hasAttachments: msg.hasAttachments,
        accountId,
      }

      const hits: Array<{ rule: MailRule; actions: RuleAction[] }> = []
      for (const rule of rules) {
        if (rule.accountId !== null && String(rule.accountId) !== String(accountId)) continue
        if (!matchRule(rule, context)) continue
        hits.push({ rule, actions: rule.actions })
        if (rule.stopProcessing) break
      }

      if (hits.length === 0) {
        // No static rule matched — hand it to the AI-rules pipeline. That
        // pipeline acts on the (folder, uid) pair LATER and on its own
        // schedule, so handing it a UID from a numbering space that has since
        // been reassigned is the same hazard as acting on one here.
        if (spaceChanged()) { abortReason = 'uidvalidity_changed'; break }
        deps.enqueueForAiRules({
          accountId,
          folder,
          uid,
          from: msg.from,
          to: msg.toAddr || '',
          subject: msg.subject,
          bodyPreview: (msg.bodyText || '').substring(0, 500),
          hasAttachment: msg.hasAttachments,
        })
      } else {
        // Check before anything irreversible happens to this message, so a pass
        // that is already invalid neither counts a match nor logs one.
        if (spaceChanged()) { abortReason = 'uidvalidity_changed'; break }
        matched++
        const allActions = hits.flatMap(h => h.actions)
        deps.log.info(`Rule matched for uid=${uid} in ${folder}: ${allActions.map(a => a.type).join(',')}`)

        // One check per MESSAGE is not enough (§2.86 iter3, review finding):
        // every action is an IMAP round-trip, so a concurrent sync can bump
        // UIDVALIDITY between action #1 and action #2 of the same message, and
        // the second one would then act on a reused UID with a decision made in
        // the old space — the one failure mode here that destroys mail.
        let spaceLost = false
        for (const { rule, actions } of hits) {
          for (const action of actions) {
            if (spaceChanged()) { spaceLost = true; break }
            await deps.executeRuleAction(accountId, folder, uid, action)
            try {
              deps.insertRuleLog({
                ruleId: rule.id,
                ruleName: rule.name,
                accountId,
                folder,
                uid,
                subject: msg.subject,
                fromAddr: msg.fromAddr,
                actionTaken: JSON.stringify(action),
              })
            } catch (logErr) {
              deps.log.error('Failed to log rule execution:', logErr)
            }
          }
          if (spaceLost) break
        }
        // Partially-applied message: the watermark stays put, and the next
        // pass re-baselines. It will NOT see this message again — the old UID
        // no longer identifies it, which is precisely why the remaining
        // actions had to be refused. Not re-applying action 1 is the point,
        // not a gap.
        if (spaceLost) { abortReason = 'uidvalidity_changed'; break }
      }

      evaluated++
      deps.actionAttempts.delete(attemptKey)
      // Advance only after the message has been fully attempted. A crash
      // before this point re-runs the message next pass (actions are
      // idempotent in effect: the second move finds no such UID); a crash
      // after it never silently drops the remaining tail.
      if (spaceChanged()) { abortReason = 'uidvalidity_changed'; break }
      deps.setMailRulesState(accountId, folder, uid, recordedValidity)
    } catch (err) {
      // Executing an action failed — typically a transient IMAP error (dropped
      // connection, server hiccup). Stepping over the message here is what the
      // first cut did, following Thunderbird, and it is wrong for us: it turns
      // a network blip into the permanent loss of a rule the user explicitly
      // configured, and Sentry does not repair user state. Instead the
      // watermark stays put and the pass stops, so the next trigger retries
      // this exact message — bounded, so one poisonous message cannot wedge
      // the folder for the rest of this process's life. Across restarts the
      // budget refills, so the stall repeats; see the constant's doc comment
      // and §2.87.
      const attempts = (deps.actionAttempts.get(attemptKey) ?? 0) + 1
      deps.actionAttempts.set(attemptKey, attempts)
      deps.log.error(`Failed to process rule for uid=${uid} in ${folder} (attempt ${attempts}):`, err)

      if (attempts < MAIL_RULES_MAX_ACTION_ATTEMPTS) {
        abortReason = 'action_retry_pending'
        break
      }

      deps.actionAttempts.delete(attemptKey)
      // Synthetic, PII-free report: the raw error is server text (it names
      // mailboxes and quotes subjects — see services/netErrorTelemetry.ts) and
      // so is the folder name, so neither is transmitted. `error_class` comes
      // from the closed set in that module. Unlike `reportSanitizedNetError`
      // this is NOT dropped when the cause looks transient: a rule that was
      // abandoned is a user-visible loss, not network noise.
      const dropped = new Error(
        `mail rule action skipped after ${attempts} failed attempts`
      )
      dropped.name = 'MailRulesActionDropped'
      deps.captureException(dropped, {
        source: 'mailRulesRunner',
        attempts,
        error_class: classifyNetError(err),
      })

      if (spaceChanged()) { abortReason = 'uidvalidity_changed'; break }
      deps.setMailRulesState(accountId, folder, uid, recordedValidity)
    }
  }

  if (abortReason !== null) {
    deps.log.warn(`Rules pass for ${folder} account ${accountId} stopped early (${abortReason}) after ${evaluated} message(s); the next pass resumes from the watermark`)
  }

  return {
    evaluated,
    matched,
    baselined: false,
    aborted: abortReason !== null,
    // Only a full, uninterrupted batch means "there may be more right now".
    hitLimit: abortReason === null && uids.length === MAIL_RULES_MAX_PER_PASS,
  }
}
