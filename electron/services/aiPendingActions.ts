/**
 * AI pending action registry — single source of truth for the preview→apply
 * confirmation barrier that wraps every mutating MCP tool.
 *
 * Why this module exists (CLAUDE.md §5 — Verifiable Private Inbox Agent invariant):
 *
 * Email content is UNTRUSTED data. A malicious sender can embed instructions
 * inside an email body that nudge the LLM into executing destructive tools
 * (snooze, flag, follow-up, mail rule mutation, …) without the user ever
 * asking. Even with `wrapUntrusted()` boundary markers, prompt-injection
 * defence is best-effort. The structural mitigation is: every mutating tool
 * MUST go through preview→apply, and apply MUST require a confirmation token
 * issued by the renderer UI on an explicit user click. Without a renderer
 * token, the AI cannot mutate state — period.
 *
 * Contract:
 *   1. `*_preview` tools call `registerPendingAction(...)` and return the
 *      `previewId` to the model so it can describe the action to the user.
 *   2. The renderer surfaces a confirmation block. On user click, renderer
 *      calls `ai:action:apply` IPC, which calls `consumePendingAction()` —
 *      this issues a `confirmation_token` and removes the entry from the
 *      registry. The token is then injected into the AI's next turn so the
 *      model can call `*_apply` with it.
 *   3. `*_apply` tools validate the token via `validateConfirmationToken()`.
 *      If the token is missing, expired, mismatched, or already-used — the
 *      apply is rejected and an `ai_action_rejected` audit event is emitted.
 *
 * Hotspot policy (CLAUDE.md §5): `electron/services/ai.ts` is already a
 * 3000+ line file. Without extraction, adding 9 inline preview/apply blocks
 * would push it past 4000 lines and make the security-critical apply path
 * harder to audit. This module owns the entire registry surface so reviewers
 * have one place to inspect.
 */

import { randomUUID } from 'node:crypto'
import { createLogger } from '../logger'
import { recordEvent, recordHistogram } from '../metrics'
import { listAccounts } from '../../packages/net/config'

const log = createLogger('AiPendingActions')

// --- Action type catalog ---------------------------------------------------
//
// Adding a new mutating tool? Add a tag here, add the payload shape to
// `PendingActionPayload`, and the rest of the system (audit events,
// telemetry tags, renderer summary helpers) picks it up via exhaustive
// switch.

export type PendingActionKind =
  | 'mail_action'      // archive / trash / mark_read (existing)
  | 'unsubscribe'      // bulk unsubscribe (existing)
  | 'send_email'       // SMTP send (existing)
  | 'move_email'       // IMAP move (existing)
  | 'snooze_email'     // GTD snooze
  | 'unsnooze_email'   // GTD unsnooze
  | 'flag_email'       // star / unstar
  | 'mark_read_later'  // GTD read-later add/remove
  | 'add_followup'     // GTD follow-up reminder
  | 'dismiss_followup' // GTD follow-up dismiss
  | 'create_mail_rule' // mail rule create
  | 'update_mail_rule' // mail rule update
  | 'delete_mail_rule' // mail rule delete

/**
 * Payload shapes per action kind. Kept minimal — only the data needed to
 * execute the underlying callback. Renderer-facing summary fields
 * (subject, recipient counts, …) are derived in `summarizePending()`.
 */
export type PendingActionPayload =
  // `mail_action` accepts both single-account legacy shape AND a cross-
  // account multi-batch shape (§2.20 PR1). `accountId` and `fromFolder`
  // remain required for back-compat with the existing audit/summary
  // surface; for cross-account batches they store the FIRST batch's
  // values (used as audit-telemetry breadcrumbs only — execution path
  // groups by `refs[].accountId:folder` and is multi-account-aware).
  // The optional `accountIds` array carries the full set of distinct
  // accountIds spanned by `refs` so `summarizePending()` can resolve
  // emails for the multi-account confirmation block.
  | { kind: 'mail_action'; data: { action: 'archive' | 'trash' | 'mark_read'; accountId: number; fromFolder: string; refs: { accountId: number; folder: string; uid: number }[]; accountIds?: number[] } }
  | { kind: 'unsubscribe'; data: { accountId: number; fromFolder: string; refs: { accountId: number; folder: string; uid: number }[] } }
  | { kind: 'send_email'; data: { accountId: number; to: string; cc?: string; bcc?: string; subject: string; body: string } }
  | { kind: 'move_email'; data: { accountId: number; fromFolder: string; toFolder: string; uids: number[] } }
  | { kind: 'snooze_email'; data: { accountId: number; folder: string; uids: number[]; wakeAt: string } }
  | { kind: 'unsnooze_email'; data: { snoozeIds: number[] } }
  | { kind: 'flag_email'; data: { accountId: number; folder: string; uids: number[]; flagged: boolean } }
  | { kind: 'mark_read_later'; data: { accountId: number; folder: string; uids: number[]; add: boolean } }
  | { kind: 'add_followup'; data: { accountId: number; folder: string; uid: number; toAddr: string; subject?: string; remindAt: string } }
  | { kind: 'dismiss_followup'; data: { followUpId: number } }
  | { kind: 'create_mail_rule'; data: { name: string; conditions: string; actions: string; priority?: number; stopProcessing?: boolean } }
  | { kind: 'update_mail_rule'; data: { ruleId: string; name?: string; enabled?: boolean; conditions?: string; actions?: string; priority?: number; stopProcessing?: boolean } }
  | { kind: 'delete_mail_rule'; data: { ruleId: string } }

/** Metadata captured at preview time for audit / renderer surfacing. */
export type PendingActionMeta = {
  /** ID issued at preview time. AI references this in *_apply calls. */
  previewId: string
  /** Confirmation token issued by `consumePendingAction()` on user click.
   *  `null` while the action is awaiting user confirmation. */
  confirmationToken: string | null
  /** Wall-clock timestamp at preview registration. */
  createdAt: number
  /** Wall-clock timestamp when the user clicked Apply (token issued). */
  consumedAt: number | null
}

export type PendingActionEntry = PendingActionPayload & PendingActionMeta

// --- TTL + capacity guards -------------------------------------------------

/** TTL for pending actions: previews expire 10 minutes after creation if the
 *  user never clicks Apply. */
export const PREVIEW_TTL_MS = 10 * 60_000

/** Hard cap on registry size. Defends against accidental DoS where a buggy
 *  agent loop creates thousands of previews. */
export const MAX_REGISTRY_SIZE = 256

/** Tokens have a short lifetime after issuance — the AI must call apply
 *  immediately. If the model stalls, the token expires and the user must
 *  click Apply again. */
export const TOKEN_TTL_MS = 60_000

// --- Rate limiter for apply operations -------------------------------------

/** Max apply operations across all action kinds per sliding window. Keeps
 *  the same value as the legacy `APPLY_RATE_LIMIT` to preserve behaviour
 *  for existing preview/apply pairs. */
export const APPLY_RATE_LIMIT = 10
export const APPLY_RATE_WINDOW_MS = 10 * 60_000

const applyTimestamps: number[] = []

/** Check if an apply operation is allowed. Returns true if allowed, false
 *  if the sliding-window limit is exceeded. Side-effects: records the
 *  timestamp on success. */
export function checkApplyRateLimit(): boolean {
  const now = Date.now()
  while (applyTimestamps.length > 0 && now - applyTimestamps[0] > APPLY_RATE_WINDOW_MS) {
    applyTimestamps.shift()
  }
  if (applyTimestamps.length >= APPLY_RATE_LIMIT) return false
  applyTimestamps.push(now)
  return true
}

/** Reset rate limiter (for tests). */
export function resetApplyRateLimit(): void {
  applyTimestamps.length = 0
}

// --- Rate limiter for preview registrations -------------------------------
//
// Without this, the AI can rapid-fire preview_* calls and evict a user's
// legitimate pending preview before they get a chance to click Apply
// (MAX_REGISTRY_SIZE oldest-first eviction is otherwise the only bound).
// Sliding window matches the apply limiter pattern.

export const REGISTER_RATE_LIMIT = 30
export const REGISTER_RATE_WINDOW_MS = 5 * 60_000

const registerTimestamps: number[] = []

/** Returns true if a new preview registration is allowed under the sliding
 *  window. Side-effects: records timestamp on success. */
export function checkRegisterRateLimit(): boolean {
  const now = Date.now()
  while (registerTimestamps.length > 0 && now - registerTimestamps[0] > REGISTER_RATE_WINDOW_MS) {
    registerTimestamps.shift()
  }
  if (registerTimestamps.length >= REGISTER_RATE_LIMIT) return false
  registerTimestamps.push(now)
  return true
}

/** Reset register rate limiter (for tests). */
export function resetRegisterRateLimit(): void {
  registerTimestamps.length = 0
}

// --- Registry --------------------------------------------------------------

const registry = new Map<string, PendingActionEntry>()

/**
 * Register a pending action and return its previewId. Called by `*_preview`
 * MCP tool handlers.
 *
 * Throws `RegisterRateLimitError` when the sliding-window register limit
 * has been exceeded. Callers (preview tool handlers) catch this and return
 * a structured error to the AI so the model can surface the situation to
 * the user instead of looping. This defends against a malicious AI loop
 * (driven by prompt-injected email content) that would otherwise saturate
 * the registry and evict a user's legitimate pending preview before they
 * click Apply.
 *
 * Emits `ai_action_preview_created` on success and
 * `ai_action_rejected{reason='rate_limit'}` on rate-limit reject.
 */
export class RegisterRateLimitError extends Error {
  constructor(message = 'Preview registration rate limit exceeded') {
    super(message)
    this.name = 'RegisterRateLimitError'
  }
}

export function registerPendingAction(payload: PendingActionPayload): string {
  if (!checkRegisterRateLimit()) {
    emitAuditEvent('ai_action_rejected', { kind: payload.kind, reason: 'rate_limit' })
    log.warn(`Refused preview registration — register rate limit (${REGISTER_RATE_LIMIT}/${REGISTER_RATE_WINDOW_MS}ms) exceeded`)
    throw new RegisterRateLimitError()
  }

  cleanupExpired()
  if (registry.size >= MAX_REGISTRY_SIZE) {
    // Oldest-first eviction. Hard cap defends against pathological growth
    // (buggy AI loop, malformed SDK behaviour). With the register-rate
    // limit above, hitting this branch should be effectively impossible
    // in practice, but the cap stays as a defence-in-depth bound.
    const oldestKey = registry.keys().next().value
    if (oldestKey) {
      registry.delete(oldestKey)
      log.warn(`Evicted oldest pending action — registry size cap (${MAX_REGISTRY_SIZE}) reached`)
    }
  }

  const previewId = randomUUID()
  const entry: PendingActionEntry = {
    ...payload,
    previewId,
    confirmationToken: null,
    createdAt: Date.now(),
    consumedAt: null,
  }
  registry.set(previewId, entry)

  emitAuditEvent('ai_action_preview_created', { kind: payload.kind })
  return previewId
}

/** Look up a pending action by previewId without modifying the registry.
 *  Returns null if the entry does not exist or has expired. */
export function lookupPendingAction(previewId: string): PendingActionEntry | null {
  const entry = registry.get(previewId)
  if (!entry) return null
  if (Date.now() - entry.createdAt > PREVIEW_TTL_MS) {
    registry.delete(previewId)
    emitAuditEvent('ai_action_expired', { kind: entry.kind })
    return null
  }
  return entry
}

/**
 * Issue a confirmation token for a pending action. Called by the
 * renderer-driven IPC handler when the user clicks Apply. The token is the
 * key the AI must present back via `*_apply` tools.
 *
 * Returns `null` if the previewId is unknown or expired — the renderer
 * should display an error in that case.
 */
export function consumePendingAction(previewId: string): { confirmationToken: string; entry: PendingActionEntry } | null {
  const entry = lookupPendingAction(previewId)
  if (!entry) return null
  if (entry.confirmationToken) {
    // Already-issued token — re-issuing would let a malicious AI reuse a
    // confirmation arbitrarily many times. The user must click Apply again.
    log.warn(`Refusing to re-issue confirmation token for previewId=${previewId} (already consumed)`)
    return null
  }
  entry.confirmationToken = randomUUID()
  entry.consumedAt = Date.now()
  return { confirmationToken: entry.confirmationToken, entry }
}

/**
 * Read-only token validation. Returns the matching entry **without**
 * mutating the registry — useful for diagnostic/peek paths (e.g. tests,
 * debug introspection) that need to know whether a token would validate
 * but must NOT consume the entry.
 *
 * NOT for the apply path. The apply path MUST go through
 * `claimPendingActionForApply()` so that lookup + token-match + delete
 * happen in a single critical section. Splitting validation and deletion
 * across two calls re-opens a race window where two concurrent applies
 * with the same token both pass validation, both invoke dispatch, and both
 * mutate state (e.g. SMTP send fires twice). See §3.10 P0 BLOCKER fix.
 */
export type ValidationError =
  | { ok: false; reason: 'preview_not_found' }
  | { ok: false; reason: 'preview_expired' }
  | { ok: false; reason: 'kind_mismatch'; expectedKind: PendingActionKind; actualKind: PendingActionKind }
  | { ok: false; reason: 'token_missing' }
  | { ok: false; reason: 'token_mismatch' }
  | { ok: false; reason: 'token_expired' }

export type ValidationResult<K extends PendingActionKind> =
  | { ok: true; entry: Extract<PendingActionEntry, { kind: K }> }
  | ValidationError

export function peekPendingActionToken<K extends PendingActionKind>(
  previewId: string,
  expectedKind: K,
  presentedToken: string | undefined,
): ValidationResult<K> {
  return validateInternal(previewId, expectedKind, presentedToken, /* emitAudit */ true, /* deleteOnSuccess */ false)
}

/**
 * Atomic token claim — the apply path. Combines lookup + kind/token/TTL
 * validation + DELETE-on-success into a single synchronous critical
 * section. Once `ok: true` is returned the entry is GONE from the
 * registry, so a concurrent claim with the same token will hit
 * `preview_not_found` and reject before reaching dispatch. This is the
 * only correct way to consume a pending action for execution.
 *
 * On dispatch failure the entry stays deleted (caller does NOT
 * re-register). Forcing the user to re-issue preview + re-click is the
 * conservative choice: re-registering would re-open the race window we
 * just closed and let an attacker retry a captured token after a
 * legitimate dispatch error.
 */
export function claimPendingActionForApply<K extends PendingActionKind>(
  previewId: string,
  expectedKind: K,
  presentedToken: string | undefined,
): ValidationResult<K> {
  return validateInternal(previewId, expectedKind, presentedToken, /* emitAudit */ true, /* deleteOnSuccess */ true)
}

function validateInternal<K extends PendingActionKind>(
  previewId: string,
  expectedKind: K,
  presentedToken: string | undefined,
  emitAudit: boolean,
  deleteOnSuccess: boolean,
): ValidationResult<K> {
  const raw = registry.get(previewId)
  if (!raw) {
    if (emitAudit) emitAuditEvent('ai_action_rejected', { kind: expectedKind, reason: 'preview_not_found' })
    return { ok: false, reason: 'preview_not_found' }
  }
  if (Date.now() - raw.createdAt > PREVIEW_TTL_MS) {
    registry.delete(previewId)
    if (emitAudit) emitAuditEvent('ai_action_expired', { kind: raw.kind })
    return { ok: false, reason: 'preview_expired' }
  }
  if (raw.kind !== expectedKind) {
    if (emitAudit) emitAuditEvent('ai_action_rejected', { kind: expectedKind, reason: 'kind_mismatch' })
    return { ok: false, reason: 'kind_mismatch', expectedKind, actualKind: raw.kind }
  }
  if (!raw.confirmationToken) {
    if (emitAudit) emitAuditEvent('ai_action_rejected', { kind: raw.kind, reason: 'token_missing' })
    return { ok: false, reason: 'token_missing' }
  }
  if (!presentedToken || presentedToken !== raw.confirmationToken) {
    if (emitAudit) emitAuditEvent('ai_action_rejected', { kind: raw.kind, reason: 'token_mismatch' })
    return { ok: false, reason: 'token_mismatch' }
  }
  if (raw.consumedAt && Date.now() - raw.consumedAt > TOKEN_TTL_MS) {
    registry.delete(previewId)
    if (emitAudit) emitAuditEvent('ai_action_rejected', { kind: raw.kind, reason: 'token_expired' })
    return { ok: false, reason: 'token_expired' }
  }
  if (deleteOnSuccess) {
    // ATOMIC CLAIM: remove the entry NOW, before returning to the caller.
    // Concurrent claims for the same previewId+token will hit
    // `preview_not_found` above and reject before dispatch.
    registry.delete(previewId)
  }
  return { ok: true, entry: raw as Extract<PendingActionEntry, { kind: K }> }
}

/**
 * @deprecated Backwards-compatible alias used only by existing test code.
 * For the apply path, always use `claimPendingActionForApply`. For peek,
 * use `peekPendingActionToken`.
 */
export const validateConfirmationToken = peekPendingActionToken

/**
 * Remove a pending action from the registry. Called by `*_apply` after the
 * underlying mutation succeeds. Emits `ai_action_applied` audit event.
 *
 * Note: with the atomic-claim path (`claimPendingActionForApply`), the
 * registry entry has already been removed before dispatch. Callers should
 * prefer `recordApplySucceeded(entry, durationMs)` which emits the audit
 * event from an in-scope entry reference and does not need to re-fetch
 * from the registry. This function is retained for back-compat and for
 * the cancel path (where entry may still be in the registry).
 */
export function deletePendingAction(previewId: string, durationMs?: number): void {
  const entry = registry.get(previewId)
  registry.delete(previewId)
  if (entry) {
    emitAuditEvent('ai_action_applied', { kind: entry.kind })
    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
      try {
        recordHistogram('ai.action.apply_duration_ms', durationMs, { kind: entry.kind })
      } catch { /* telemetry must never throw back into caller */ }
    }
  }
}

/**
 * Emit `ai_action_applied` audit event + apply-duration histogram for an
 * already-claimed entry. Used by the atomic-claim apply path: the entry
 * is no longer in the registry (we deleted it inside
 * `claimPendingActionForApply`), so we cannot re-fetch by previewId. The
 * caller passes the in-scope `entry` reference returned by the claim.
 *
 * This closes the LOW#3 race where periodic cleanup could remove the
 * entry between dispatch start and `deletePendingAction`, dropping the
 * audit event for a successful mutation.
 */
export function recordApplySucceeded(entry: PendingActionEntry, durationMs?: number): void {
  emitAuditEvent('ai_action_applied', { kind: entry.kind })
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    try {
      recordHistogram('ai.action.apply_duration_ms', durationMs, { kind: entry.kind })
    } catch { /* telemetry must never throw back into caller */ }
  }
}

/** Iterate all currently-pending actions. Used by the system prompt's
 *  `[Pending actions awaiting user confirmation]` block so the AI can call
 *  apply with the correct previewId on user confirmation. */
export function listPendingActions(): PendingActionEntry[] {
  cleanupExpired()
  return [...registry.values()]
}

/** Clear the entire registry (tests + new-session boundary). */
export function clearPendingActions(): void {
  registry.clear()
}

/**
 * Cancel a pending action — called by the renderer when the user clicks
 * Cancel in the confirmation block. Different from `deletePendingAction`
 * (which is the success path and emits `ai_action_applied`): cancel
 * silently removes the entry without emitting either applied or rejected.
 * The TTL-expired path is the only one that emits `ai_action_expired`.
 */
export function cancelPendingAction(previewId: string): boolean {
  const entry = registry.get(previewId)
  if (!entry) return false
  registry.delete(previewId)
  log.info(`Pending action cancelled by user kind=${entry.kind} previewId=${previewId}`)
  return true
}

/** Remove expired entries. Public so the periodic interval can call it; also
 *  invoked at the top of `lookupPendingAction` and `registerPendingAction`. */
export function cleanupExpired(): number {
  const now = Date.now()
  let removed = 0
  for (const [id, entry] of registry) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) {
      registry.delete(id)
      emitAuditEvent('ai_action_expired', { kind: entry.kind })
      removed++
    }
  }
  return removed
}

// Periodic cleanup. Cheap operation — only iterates current entries, no DB.
const cleanupTimer = setInterval(cleanupExpired, 5 * 60_000)
cleanupTimer.unref()

// --- Renderer-facing summary -----------------------------------------------

/** A renderer-safe summary of a pending action — strings + counts, no
 *  email content. Used by the AiPanel to render the confirmation block.
 *  Email subjects are NOT included here: the AI will surface them in its
 *  text response, and the renderer trusts the `previewId` to identify
 *  which preview the AI is referring to. */
export type PendingActionSummary = {
  previewId: string
  kind: PendingActionKind
  /** Short i18n key under `ai.confirmation.kinds.*` — renderer maps this
   *  to a localized verb ("Snooze", "Flag", "Send", …). */
  i18nKey: string
  /** Best-effort short description used as fallback when the renderer
   *  cannot resolve the i18n key. Plain English for log/dev. */
  description: string
  /** Account being mutated, when known — `null` for global actions
   *  (rule mutations, follow-up dismissal) or for cross-account batches
   *  (multiple accounts in one preview). */
  accountId: number | null
  /** §2.20 PR1 — email of the account being mutated, resolved from
   *  `listAccounts()` at summary time. `null` when:
   *   - `accountId` is null (global action / cross-account batch);
   *   - the account was deleted between preview registration and the
   *     summary call (renderer should fall back to "Account #{id}").
   *  Renderer is the only consumer; AI prompt path (describePendingPreviews)
   *  intentionally does NOT include this field — accountId remains the
   *  stable structural identifier inside the model context. */
  accountEmail: string | null
  /** Number of emails affected, when applicable. */
  emailCount: number | null
  /** Folder context, when applicable. `null` for cross-account batches
   *  (folder may differ per account/batch). */
  folder: string | null
  /** §2.20 PR1 — for cross-account batches (currently only `mail_action`),
   *  per-account slots `{ accountId, email }` preserving the producer-
   *  supplied (or refs[]-derived) ordering. `email: null` at a slot means
   *  the account was deleted between preview registration and summary, OR
   *  has no `email` field set; the renderer should show
   *  `t('ai.confirmation.accountFallback', { id })` for that slot.
   *  `undefined` for single-account or global actions. */
  accountSlots?: { accountId: number; email: string | null }[]
  /** §2.20 PR1 — number of distinct accounts spanned by a cross-account
   *  batch. `1` for single-account, `0` for global actions. */
  accountsCount?: number
  /**
   * §2.20 PR1 fix-wave 2 — for `mail_action` batches, exhaustive folder
   * breakdown derived from `refs[]` (authoritative). Each entry is one
   * `(accountId, folder)` tuple with the count of refs in that scope.
   * The renderer surfaces this whenever `breakdown.length >= 2` so the
   * user can see all scopes the apply will mutate (closes confirmation
   * integrity gap from codex security review §2.20 fix-wave 2: prompt
   * injection could craft a multi-folder batch where the previous
   * single-folder summary showed only the first folder name while
   * `mailActionCallback` group-by-`accountId:folder` archived ALL
   * scopes — a folder-scope confirmation forge).
   *
   * `undefined` for single-folder single-account previews (legacy shape
   * stays clean) and for non-`mail_action` kinds that have a single
   * folder context by construction (snooze/flag/move/etc.).
   *
   * Order is stable: by `accountId` ascending, then `folder` (locale
   * compare) ascending — predictable for renderer rendering and for
   * snapshot tests.
   */
  folderBreakdown?: { accountId: number; folder: string; count: number }[]
  /** Wall-clock ms when preview was registered. */
  createdAt: number
}

/**
 * Resolve an account email for a single accountId. Returns `null` when the
 * account is not present in `listAccounts()` (deleted between preview
 * registration and summary), and also when `listAccounts()` itself throws —
 * the summary path must never crash the renderer surface because of an
 * accounts-store hiccup.
 */
function resolveAccountEmail(accountId: number | null): string | null {
  if (accountId === null || !Number.isFinite(accountId)) return null
  try {
    const account = listAccounts().find(a => a.id === accountId)
    if (!account) return null
    return account.email ?? null
  } catch (err) {
    log.warn(`resolveAccountEmail failed for accountId=${accountId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * §2.20 PR1 fix-wave 2 — Derive `(accountId, folder, count)` breakdown
 * from `refs[]`. `refs[]` is the AUTHORITATIVE source for what the apply
 * path will mutate (`mailActionCallback` in `electron/main.ts` groups by
 * `accountId:folder` and operates per-group). Summarising from the same
 * source closes the confirmation integrity gap where a multi-folder
 * batch was previously summarised with only the first folder name.
 *
 * Empty `refs[]` returns `[]`; caller decides whether to set
 * `folderBreakdown`. Order is stable: `accountId` ascending, then
 * `folder` (locale compare) ascending — predictable for renderer and
 * for snapshot tests.
 */
export function deriveFolderBreakdown(
  refs: { accountId: number; folder: string; uid: number }[],
): { accountId: number; folder: string; count: number }[] {
  const grouped = new Map<string, { accountId: number; folder: string; count: number }>()
  for (const ref of refs) {
    const key = `${ref.accountId}::${ref.folder}`
    const entry = grouped.get(key)
    if (entry) {
      entry.count++
    } else {
      grouped.set(key, { accountId: ref.accountId, folder: ref.folder, count: 1 })
    }
  }
  return [...grouped.values()].sort((a, b) =>
    a.accountId !== b.accountId ? a.accountId - b.accountId : a.folder.localeCompare(b.folder),
  )
}

/**
 * Resolve `{ accountId, email }` slots for a multi-account batch. Order
 * matches the input `accountIds` array (caller is responsible for choosing
 * the correct ordering — typically the producer-supplied first-seen order
 * from `refs[]`). Missing/deleted accounts contribute `email: null` so the
 * renderer can show a per-slot fallback (`ai.confirmation.accountFallback`)
 * and still get the count right. Caller passes the unique, ordered set —
 * we do NOT dedupe here.
 */
function resolveAccountSlots(accountIds: number[]): { accountId: number; email: string | null }[] {
  if (accountIds.length === 0) return []
  let accounts: ReturnType<typeof listAccounts> = []
  try {
    accounts = listAccounts()
  } catch (err) {
    log.warn(`resolveAccountSlots listAccounts threw: ${err instanceof Error ? err.message : String(err)}`)
    return accountIds.map(id => ({ accountId: id, email: null }))
  }
  const byId = new Map<number, string>()
  for (const a of accounts) {
    if (a.email) byId.set(a.id, a.email)
  }
  return accountIds.map(id => ({ accountId: id, email: byId.get(id) ?? null }))
}

export function summarizePending(entry: PendingActionEntry): PendingActionSummary {
  const base = {
    previewId: entry.previewId,
    kind: entry.kind,
    createdAt: entry.createdAt,
  } as const

  switch (entry.kind) {
    case 'mail_action': {
      const d = entry.data
      // §2.20 PR1 — refs[] is the AUTHORITATIVE source for which accounts
      // the apply path will mutate (mailActionCallback groups by
      // refs[].accountId:folder). `accountIds` is only honoured for
      // *ordering* when its set matches refs[]; on mismatch we log and
      // fall back to refs[] first-seen order so summary cardinality
      // matches what apply will actually do. Without this guard, a buggy
      // or malicious producer could pass `accountIds: [1,2]` with
      // `refs: [{accountId:1,…}, {accountId:1,…}]` and the user would see
      // "2 accounts" while apply only touched 1 — exactly the
      // showup-inconsistency the codex Medium#1 flagged.
      const refsAccountIds: number[] = []
      const seenRefIds = new Set<number>()
      for (const r of d.refs) {
        if (!seenRefIds.has(r.accountId)) {
          seenRefIds.add(r.accountId)
          refsAccountIds.push(r.accountId)
        }
      }
      let orderedAccountIds: number[]
      if (d.accountIds && d.accountIds.length > 0) {
        const accountIdsSet = new Set(d.accountIds)
        const refsSet = seenRefIds
        const setsEqual =
          accountIdsSet.size === refsSet.size &&
          [...accountIdsSet].every(id => refsSet.has(id))
        if (setsEqual) {
          // Honour producer-supplied ordering; dedupe preserving order.
          orderedAccountIds = []
          const seen = new Set<number>()
          for (const id of d.accountIds) {
            if (!seen.has(id)) {
              seen.add(id)
              orderedAccountIds.push(id)
            }
          }
        } else {
          // Mismatch — refs[] wins. Producer is buggy; we log so the gap
          // is visible in audit trail but never surface inconsistent
          // counts to the renderer.
          log.warn(`summarizePending mail_action: accountIds vs refs[] mismatch (accountIds=[${[...accountIdsSet].join(',')}] refs=[${[...refsSet].join(',')}]) — falling back to refs[]`)
          orderedAccountIds = refsAccountIds
        }
      } else {
        orderedAccountIds = refsAccountIds
      }
      // §2.20 PR1 fix-wave 2 — derive folder breakdown from refs[] (the
      // authoritative source for what the apply path will mutate). The
      // renderer uses this whenever scope spans >1 folder to show each
      // affected (account, folder) — closes the confirmation integrity
      // gap where a multi-folder batch was previously summarised with
      // only the first folder name (codex HIGH §2.20 fix-wave 2).
      const breakdown = deriveFolderBreakdown(d.refs)
      const isMultiAccount = orderedAccountIds.length >= 2
      if (isMultiAccount) {
        const slots = resolveAccountSlots(orderedAccountIds)
        return {
          ...base,
          i18nKey: `ai.confirmation.kinds.mail_action.${d.action}`,
          description: `Mail action: ${d.action} (${d.refs.length} email${d.refs.length === 1 ? '' : 's'} across ${orderedAccountIds.length} accounts)`,
          accountId: null,
          accountEmail: null,
          accountSlots: slots,
          accountsCount: orderedAccountIds.length,
          emailCount: d.refs.length,
          folder: null,
          // Multi-account batches always span ≥1 (account,folder) tuple
          // per account; the renderer needs the full list to show every
          // scope being mutated.
          folderBreakdown: breakdown,
        }
      }
      // Single-account branch. `folder` field stays set for back-compat
      // when scope is a single folder (legacy single-folder shape that
      // existing renderer code already handles). When scope spans >1
      // folder we set `folder: null` and emit `folderBreakdown` so the
      // renderer can list all folders explicitly. This also closes the
      // edge case where `fromFolder` might disagree with refs[] (buggy
      // producer): `breakdown[0].folder` (refs-derived) wins.
      const isMultiFolder = breakdown.length >= 2
      const acctId = orderedAccountIds[0] ?? d.accountId
      return {
        ...base,
        i18nKey: `ai.confirmation.kinds.mail_action.${d.action}`,
        description: `Mail action: ${d.action} (${d.refs.length} email${d.refs.length === 1 ? '' : 's'})`,
        accountId: acctId,
        accountEmail: resolveAccountEmail(acctId),
        accountsCount: 1,
        emailCount: d.refs.length,
        folder: isMultiFolder ? null : (breakdown[0]?.folder ?? d.fromFolder),
        folderBreakdown: isMultiFolder ? breakdown : undefined,
      }
    }
    case 'unsubscribe': {
      const d = entry.data
      return {
        ...base,
        i18nKey: 'ai.confirmation.kinds.unsubscribe',
        description: `Unsubscribe (${d.refs.length} email${d.refs.length === 1 ? '' : 's'})`,
        accountId: d.accountId,
        accountEmail: resolveAccountEmail(d.accountId),
        emailCount: d.refs.length,
        folder: d.fromFolder,
      }
    }
    case 'send_email': {
      const d = entry.data
      return {
        ...base,
        i18nKey: 'ai.confirmation.kinds.send_email',
        description: `Send email to ${d.to}`,
        accountId: d.accountId,
        accountEmail: resolveAccountEmail(d.accountId),
        emailCount: 1,
        folder: null,
      }
    }
    case 'move_email': {
      const d = entry.data
      return {
        ...base,
        i18nKey: 'ai.confirmation.kinds.move_email',
        description: `Move ${d.uids.length} email${d.uids.length === 1 ? '' : 's'} to ${d.toFolder}`,
        accountId: d.accountId,
        accountEmail: resolveAccountEmail(d.accountId),
        emailCount: d.uids.length,
        folder: d.fromFolder,
      }
    }
    case 'snooze_email': {
      const d = entry.data
      return {
        ...base,
        i18nKey: 'ai.confirmation.kinds.snooze_email',
        description: `Snooze ${d.uids.length} email${d.uids.length === 1 ? '' : 's'} until ${d.wakeAt}`,
        accountId: d.accountId,
        accountEmail: resolveAccountEmail(d.accountId),
        emailCount: d.uids.length,
        folder: d.folder,
      }
    }
    case 'unsnooze_email': {
      const d = entry.data
      return {
        ...base,
        i18nKey: 'ai.confirmation.kinds.unsnooze_email',
        description: `Remove snooze from ${d.snoozeIds.length} reminder${d.snoozeIds.length === 1 ? '' : 's'}`,
        accountId: null,
        accountEmail: null,
        emailCount: d.snoozeIds.length,
        folder: null,
      }
    }
    case 'flag_email': {
      const d = entry.data
      return {
        ...base,
        i18nKey: d.flagged ? 'ai.confirmation.kinds.flag_email.star' : 'ai.confirmation.kinds.flag_email.unstar',
        description: `${d.flagged ? 'Star' : 'Unstar'} ${d.uids.length} email${d.uids.length === 1 ? '' : 's'}`,
        accountId: d.accountId,
        accountEmail: resolveAccountEmail(d.accountId),
        emailCount: d.uids.length,
        folder: d.folder,
      }
    }
    case 'mark_read_later': {
      const d = entry.data
      return {
        ...base,
        i18nKey: d.add ? 'ai.confirmation.kinds.mark_read_later.add' : 'ai.confirmation.kinds.mark_read_later.remove',
        description: `${d.add ? 'Add' : 'Remove'} ${d.uids.length} email${d.uids.length === 1 ? '' : 's'} ${d.add ? 'to' : 'from'} Read Later`,
        accountId: d.accountId,
        accountEmail: resolveAccountEmail(d.accountId),
        emailCount: d.uids.length,
        folder: d.folder,
      }
    }
    case 'add_followup': {
      const d = entry.data
      return {
        ...base,
        i18nKey: 'ai.confirmation.kinds.add_followup',
        description: `Add follow-up reminder for ${d.toAddr} at ${d.remindAt}`,
        accountId: d.accountId,
        accountEmail: resolveAccountEmail(d.accountId),
        emailCount: 1,
        folder: d.folder,
      }
    }
    case 'dismiss_followup': {
      return {
        ...base,
        i18nKey: 'ai.confirmation.kinds.dismiss_followup',
        description: `Dismiss follow-up reminder #${entry.data.followUpId}`,
        accountId: null,
        accountEmail: null,
        emailCount: 1,
        folder: null,
      }
    }
    case 'create_mail_rule': {
      return {
        ...base,
        i18nKey: 'ai.confirmation.kinds.create_mail_rule',
        description: `Create mail rule: ${entry.data.name}`,
        accountId: null,
        accountEmail: null,
        emailCount: null,
        folder: null,
      }
    }
    case 'update_mail_rule': {
      return {
        ...base,
        i18nKey: 'ai.confirmation.kinds.update_mail_rule',
        description: `Update mail rule #${entry.data.ruleId}`,
        accountId: null,
        accountEmail: null,
        emailCount: null,
        folder: null,
      }
    }
    case 'delete_mail_rule': {
      return {
        ...base,
        i18nKey: 'ai.confirmation.kinds.delete_mail_rule',
        description: `Delete mail rule #${entry.data.ruleId}`,
        accountId: null,
        accountEmail: null,
        emailCount: null,
        folder: null,
      }
    }
  }
}

// --- Audit telemetry -------------------------------------------------------
//
// Audit events are typed (electron/metricsSchema.ts → ai_action_*). All
// `recordEvent` calls are wrapped — telemetry must never throw back into
// the caller. Every emit is also mirrored to the local log so on-disk audit
// is preserved even if Sentry is down or disabled.

type AuditEventName =
  | 'ai_action_preview_created'
  | 'ai_action_applied'
  | 'ai_action_rejected'
  | 'ai_action_expired'

function emitAuditEvent(name: AuditEventName, attrs: { kind: PendingActionKind; reason?: string }): void {
  // Local log line — works even if Sentry is disabled. PII-clean: only kind
  // and (for rejections) reason category.
  log.info(`audit ${name} kind=${attrs.kind}${attrs.reason ? ` reason=${attrs.reason}` : ''}`)
  try {
    if (name === 'ai_action_rejected') {
      recordEvent('ai.action.rejected', { kind: attrs.kind, reason: attrs.reason ?? 'unknown' })
    } else if (name === 'ai_action_expired') {
      recordEvent('ai.action.expired', { kind: attrs.kind })
    } else if (name === 'ai_action_preview_created') {
      recordEvent('ai.action.preview_created', { kind: attrs.kind })
    } else if (name === 'ai_action_applied') {
      recordEvent('ai.action.applied', { kind: attrs.kind })
    }
  } catch { /* telemetry must never throw */ }
}

// --- Defensive interpolation guard ----------------------------------------
//
// User-controlled strings (folder names, rule names, …) flow into the
// system-prompt `[Pending actions]` block via `summarizePending()`. IMAP
// folder names can contain quotes, equals signs, line breaks, even
// `confirmation_token=` substrings. Although the pending-actions block is
// inside an `<<<UNTRUSTED_EMAIL_DATA>>>` boundary, model confusion is still
// possible. Strip newlines, escape quotes, and clamp length.

const PENDING_PROMPT_FIELD_MAX_LEN = 64

export function escapePendingPromptField(value: string | null | undefined): string {
  if (value == null) return ''
  // Strip ALL whitespace runs first (line breaks, tabs, NBSPs collapse to one space).
  const collapsed = String(value).replace(/\s+/g, ' ').trim()
  // Escape backslashes first, then double-quotes — order matters so we don't
  // double-escape backslashes injected by the quote-replacement.
  const escaped = collapsed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  if (escaped.length <= PENDING_PROMPT_FIELD_MAX_LEN) return escaped
  return escaped.slice(0, PENDING_PROMPT_FIELD_MAX_LEN) + '…'
}
