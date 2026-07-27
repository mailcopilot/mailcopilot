import Database from 'better-sqlite3'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { isAdvancedSearch, parseSearchQuery } from './searchParser'
import { withDbSpan, reportDbEvent } from './telemetry'
// Pure per-account enabled-rule cap logic lives in packages/core (no side
// effects, no DB/net/Electron). packages/core never imports packages/db, so
// this is an acyclic, layer-clean dependency.
import {
  canEnableAiRule,
  AI_RULE_ENABLED_LIMIT_ERROR,
  type AiRuleEnabledScope,
} from '../core'
// electron/metricsBuckets.ts is intentionally zero-dep (no Sentry / electron-log /
// electron-store), so importing it from packages/db does NOT violate the
// layer purity rule — it's the same pattern packages/net/imap.ts uses.
import {
  bucketQueryLen,
  bucketResultCount,
  bucketFetchedHeaders,
  folderRoleFromPath,
} from '../../electron/metricsBuckets'

/** Message row type returned from the DB */
export type MessageRow = {
  accountId: number
  folder: string
  uid: number
  subject: string
  /** Sender display name (if available), otherwise email */
  from: string
  /** Sender email (for consistent color/filters/search) */
  fromAddr: string
  /** Cached sender name (if present in the From header) */
  fromName?: string | null
  /** Raw recipients (To) for the to: operator and autocomplete */
  toAddr?: string | null
  date: string
  unread: boolean
  flagged: boolean
  hasAttachments: boolean
  /** Whether the message is pinned to the top of the list. */
  pinned?: boolean
  /** RFC822 Message-ID (for Conversation View). */
  messageId?: string | null
  /** RFC822 In-Reply-To (for Conversation View). */
  inReplyTo?: string | null
  /** RFC822 References (for Conversation View). */
  references?: string | null
  /** Plain-text body (populated by get_email, not by list/search). */
  bodyText?: string | null
  /** Space-separated attachment filenames for search. */
  attachmentFilenames?: string | null
  /** FTS5 snippet showing the matching context (body_text column). */
  matchSnippet?: string | null
}

/** Message row type as stored in SQLite (unread is a number 0|1) */
type RawMessageRow = Omit<MessageRow, 'unread' | 'flagged' | 'hasAttachments' | 'pinned' | 'bodyText' | 'attachmentFilenames'> & { unread: number; flagged: number; has_attachments: number; pinned?: number; body_text?: string | null; attachment_filenames?: string | null }

export type FolderHeaderSyncMode = 'full' | 'on_open' | 'period' | 'off'
export type FolderOfflineMode = 'off' | 'period' | 'full'
export type FolderPrefRow = {
  accountId: number
  folderPath: string
  visible: boolean
  includeInBadges: boolean
  headerSyncMode: FolderHeaderSyncMode
  headerSyncDays?: number
  offlineMode: FolderOfflineMode
  offlineDays?: number
  icon?: string
  /**
   * §2.15-ter: when false, new headers from sync skip FTS5 indexing and
   * remain hidden from search results; the row is still inserted into
   * `messages` so the user can list/manage Junk/Spam/Trash. Default true.
   */
  indexInSearch: boolean
  updatedAt: string
}

type RawFolderPrefRow = {
  accountId: number
  folderPath: string
  visible: number
  includeInBadges: number
  headerSyncMode: FolderHeaderSyncMode
  headerSyncDays?: number | null
  offlineMode: FolderOfflineMode
  offlineDays?: number | null
  icon?: string | null
  indexInSearch: number
  updatedAt: string
}

export type TlsPinRow = {
  id: number
  accountId: number
  host: string
  port: number
  fingerprintSha256: string
  /**
   * PEM body of the pinned certificate, when it was captured at pin time.
   *
   * Load-bearing for self-signed / private-CA endpoints: the pinned TLS path
   * verifies the chain with `rejectUnauthorized: true`, and a bare SHA-256
   * fingerprint cannot act as a trust anchor. The certificate itself can —
   * `buildTlsOptions` feeds it to OpenSSL via `ca`. NULL for pins created
   * before the column existed (fail-closed: such a self-signed endpoint keeps
   * failing with a normal certificate error until the pin is re-confirmed).
   */
  certPem: string | null
  createdAt: string
}

// For e2e and data isolation, the directory can be overridden via MAILCOPILOT_DATA_DIR.
export const dataDir = process.env.MAILCOPILOT_DATA_DIR || path.join(os.homedir(), '.mailcopilot')
const dbPath = path.join(dataDir, 'cache.db')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })
const db = new Database(dbPath)

db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY, user TEXT, imap_host TEXT, imap_port INTEGER, smtp_host TEXT, smtp_port INTEGER
);
CREATE TABLE IF NOT EXISTS folders(
  id INTEGER PRIMARY KEY, account_id INTEGER, path TEXT, name TEXT, special_use TEXT
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  email_norm TEXT NOT NULL,
  name TEXT,
  frequency INTEGER DEFAULT 0,
  last_used TEXT,
  last_seen TEXT,
  source TEXT DEFAULT 'auto'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email_norm ON contacts(email_norm);
CREATE INDEX IF NOT EXISTS idx_contacts_freq ON contacts(frequency DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_last_used ON contacts(last_used DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_last_seen ON contacts(last_seen DESC);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, account_id INTEGER, folder_path TEXT, uid INTEGER,
  subject TEXT,
  from_addr TEXT,
  from_name TEXT,
  to_addr TEXT,
  body_text TEXT,
  date TEXT,
  unread INTEGER,
  flagged INTEGER DEFAULT 0,
  has_attachments INTEGER DEFAULT 0,
  body_downloaded INTEGER DEFAULT 0,
  message_size INTEGER DEFAULT 0,
  message_id TEXT,
  in_reply_to TEXT,
  "references" TEXT,
  UNIQUE(account_id, folder_path, uid)
);
CREATE INDEX IF NOT EXISTS idx_messages_folder_uid ON messages(account_id, folder_path, uid);
CREATE INDEX IF NOT EXISTS idx_messages_subject ON messages(subject);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_addr);
`)

// Send queue (Undo Send / Schedule Send)
db.exec(`
CREATE TABLE IF NOT EXISTS send_queue(
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  message_data TEXT NOT NULL,
  send_at TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  attempt_count INTEGER DEFAULT 0,
  archive_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_send_queue_send_at ON send_queue(send_at);
CREATE INDEX IF NOT EXISTS idx_send_queue_status ON send_queue(status);
CREATE INDEX IF NOT EXISTS idx_send_queue_account_status ON send_queue(account_id, status, send_at);
`)

// Snooze (B2.13): local deferred message hiding.
db.exec(`
CREATE TABLE IF NOT EXISTS snoozed(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  message_id TEXT,
  folder TEXT NOT NULL,
  uidvalidity INTEGER,
  uid INTEGER,
  wake_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snoozed_wake_at ON snoozed(wake_at);
CREATE INDEX IF NOT EXISTS idx_snoozed_account_id ON snoozed(account_id);
CREATE INDEX IF NOT EXISTS idx_snoozed_account_folder_uid ON snoozed(account_id, folder, uid);
`)

// Follow-up Reminders (B2.15): reminders for unanswered messages.
db.exec(`
CREATE TABLE IF NOT EXISTS follow_ups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  sent_message_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  uid INTEGER,
  to_addr TEXT NOT NULL,
  subject TEXT,
  remind_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_remind_at ON follow_ups(remind_at);
CREATE INDEX IF NOT EXISTS idx_follow_ups_account_id ON follow_ups(account_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_status ON follow_ups(status);
`)

// Read Later: GTD "@Read/Review" virtual folder.
db.exec(`
CREATE TABLE IF NOT EXISTS read_later(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  folder TEXT NOT NULL,
  uid INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_read_later_account ON read_later(account_id);
`)

// Templates (B2.16): message templates with variables.
db.exec(`
CREATE TABLE IF NOT EXISTS templates(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  shortcut TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`)

// Mail Rules (B2.24): automatic rule-based mail processing.
db.exec(`
CREATE TABLE IF NOT EXISTS mail_rules(
  id TEXT PRIMARY KEY,
  account_id TEXT,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  conditions TEXT NOT NULL,
  actions TEXT NOT NULL,
  stop_processing INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_rules_account ON mail_rules(account_id, priority);
`)

// AI Rules (B2.24): AI-powered mail processing rules.
db.exec(`
CREATE TABLE IF NOT EXISTS ai_rules(
  id TEXT PRIMARY KEY,
  account_id TEXT,
  name TEXT NOT NULL,
  -- §2.39: new AI rules are DISABLED by default. This background pipeline
  -- calls a model on untrusted email content and can auto-apply actions, so
  -- a rule must be explicitly switched on by the user before it can run.
  enabled INTEGER DEFAULT 0,
  prompt TEXT NOT NULL,
  allowed_actions TEXT NOT NULL,
  budget_per_day_usd REAL DEFAULT 0.50,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`)

// AI Rule execution log.
db.exec(`
CREATE TABLE IF NOT EXISTS ai_rule_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ai_rule_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  uid INTEGER NOT NULL,
  action_taken TEXT NOT NULL,
  reasoning TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_rule_log_date ON ai_rule_log(created_at);
`)

// TLS pins (B2.2): trusted certificate fingerprints per account/server.
db.exec(`
CREATE TABLE IF NOT EXISTS tls_pins(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tls_pins_unique
  ON tls_pins(account_id, host, port, fingerprint_sha256);
CREATE INDEX IF NOT EXISTS idx_tls_pins_account ON tls_pins(account_id);
`)

// Folder roles cache (stale-while-revalidate for instant startup).
db.exec(`
CREATE TABLE IF NOT EXISTS cached_roles(
  account_id INTEGER PRIMARY KEY,
  roles_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// Mailboxes list cache for instant sidebar startup (stale-while-revalidate).
db.exec(`
CREATE TABLE IF NOT EXISTS cached_mailboxes(
  account_id INTEGER PRIMARY KEY,
  mailboxes_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// Folder sync/visibility settings (per account/folder).
db.exec(`
CREATE TABLE IF NOT EXISTS folder_prefs(
  account_id INTEGER NOT NULL,
  folder_path TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1,
  include_in_badges INTEGER NOT NULL DEFAULT 0,
  header_sync_mode TEXT NOT NULL DEFAULT 'on_open',
  header_sync_days INTEGER,
  offline_mode TEXT NOT NULL DEFAULT 'off',
  offline_days INTEGER,
  icon TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, folder_path)
);
CREATE INDEX IF NOT EXISTS idx_folder_prefs_account ON folder_prefs(account_id);
`)

// --- AI Chat Sessions ---

db.exec(`
CREATE TABLE IF NOT EXISTS ai_sessions(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  claude_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_updated ON ai_sessions(updated_at);

CREATE TABLE IF NOT EXISTS ai_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  cost_usd REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id, id);
`)

// --- AI / MCP audit log (§3.10 P0) ---
//
// Append-only audit log for security-relevant MCP events. Rows are NEVER
// mutated or deleted (the §3.10 P0 gate-keeper trail has to survive a
// compromised renderer trying to cover its tracks). Privacy invariant:
// raw commands or args never land here — only SHA-256 hashes of the
// `command + ' ' + args.join(' ')` tuple. A reviewer correlating audit
// rows with user-reported incidents needs to re-hash the suspicious
// invocation to match; there is no way to recover the original command
// from the audit log alone. This is intentional.
db.exec(`
CREATE TABLE IF NOT EXISTS ai_audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  command_hash TEXT,
  approved_source TEXT,
  reason TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_audit_log_type_created ON ai_audit_log(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_audit_log_created ON ai_audit_log(created_at);
`)

/**
 * Append one row to the §3.10 P0 MCP audit log. Pure best-effort:
 *   - Failure to write the audit row MUST NOT block / fail the caller
 *     (hence all `throw` paths are swallowed). The caller already made
 *     a user-visible decision (allow / block); missing an audit row is
 *     an observability loss, not a policy violation.
 *   - Callers pass the already-hashed command (SHA-256 hex). This module
 *     deliberately does not accept raw commands — the hash boundary
 *     lives on the caller side so there's no way for a future refactor
 *     to accidentally log raw commands.
 *
 * Known event_type values (kept as a bare string rather than an enum to
 * avoid a cross-module coupling — electron/services/mcpClient.ts holds
 * the canonical list):
 *   - 'stdio.connect_attempted'
 *   - 'stdio.connect_blocked'
 *   - 'stdio.approved'
 *   - 'settings.forbidden_field'
 *   - 'settings.forbidden_env_key' (§3.10 P0 wave 2 — per-connection env
 *     denylist hit; `reason` carries the offending keys as
 *     `keys:KEY1,KEY2,…`)
 */
export type McpAuditEvent = {
  eventType: string
  commandHash?: string | null
  approvedSource?: string | null
  reason?: string | null
  sessionId?: string | null
}

export function appendMcpAuditEvent(ev: McpAuditEvent): void {
  try {
    db.prepare(
      `INSERT INTO ai_audit_log(event_type, command_hash, approved_source, reason, session_id, created_at)
       VALUES(?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      ev.eventType,
      ev.commandHash ?? null,
      ev.approvedSource ?? null,
      ev.reason ?? null,
      ev.sessionId ?? null,
    )
  } catch {
    // Audit append must never throw back to the caller — missing rows are
    // an observability loss, not a policy violation.
  }
}

/**
 * Test/diagnostic helper — returns the most recent `limit` audit rows in
 * reverse-chronological order. NOT exposed over IPC; consumers are tests
 * and future main-process diagnostics panels.
 */
export function listRecentMcpAuditEvents(limit = 100): Array<{
  id: number
  eventType: string
  commandHash: string | null
  approvedSource: string | null
  reason: string | null
  sessionId: string | null
  createdAt: string
}> {
  type Row = {
    id: number
    event_type: string
    command_hash: string | null
    approved_source: string | null
    reason: string | null
    session_id: string | null
    created_at: string
  }
  const rows = db.prepare(
    `SELECT id, event_type, command_hash, approved_source, reason, session_id, created_at
     FROM ai_audit_log ORDER BY id DESC LIMIT ?`,
  ).all(limit) as Row[]
  return rows.map(r => ({
    id: r.id,
    eventType: r.event_type,
    commandHash: r.command_hash,
    approvedSource: r.approved_source,
    reason: r.reason,
    sessionId: r.session_id,
    createdAt: r.created_at,
  }))
}

// --- AI Privacy Audit Log (§3.3 B1) ----------------------------------------
//
// Append-only privacy audit log for the §3.3 B1 Privacy Audit Panel. Records
// one row per completed AI request (success / error / aborted) with provider,
// model, goal, tool, token usage, cost estimate, and the per-request
// `wrapUntrusted()` and egress-blocked counters. The renderer surfaces this
// table in Settings → AI → Privacy & Audit so the user can verify that
// untrusted email content was wrapped before reaching the model and that the
// egress gate did its job. Privacy invariants:
//   - NO raw prompt text, email body, subject, attachments, AI memory, or
//     tool input/output ever lands here. Only structural counters and
//     enumerated outcome strings.
//   - `goal` is a short caller-supplied label (e.g. 'chat', 'quick_action',
//     'summarize') — main code MUST NOT pass user prompt text into it.
//   - `cost_usd` is null for the subscription provider (no per-request cost
//     reported by the upstream API). The UI renders 'n/a' in that case.
//
// Append-only invariant: rows are NEVER mutated except for the soft-delete
// path which only sets `deleted_at`. The append-only audit log is part of
// the §0 «Verifiable Private Inbox Agent» trust model — a compromised
// renderer must not be able to silently rewrite history. `clearAiActionLog`
// soft-deletes every live row in one statement; there is no DELETE FROM
// path through the public API.
//
// Background row-count rotation (`pruneAiActionLog`) is the ONLY physical
// DELETE path. It is intentionally NOT exposed via IPC — a compromised
// renderer must not be able to drop rows. It runs automatically after every
// `appendAiActionLog` to cap table growth at `AI_ACTION_LOG_MAX_ROWS`,
// preventing a DoS where a flood of AI requests (or a malicious prompt
// injection coaxing the assistant into a tight loop) bloats the SQLite file
// until the disk fills. The rotation is by ascending `id` (which equals
// chronological order because `id` is INTEGER PRIMARY KEY AUTOINCREMENT),
// independent of `deleted_at` — both live and soft-deleted rows are subject
// to the physical cap. Losing the oldest audit rows is preferable to losing
// the ability to write new ones.
db.exec(`
CREATE TABLE IF NOT EXISTS ai_action_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT,
  goal TEXT,
  tool_name TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  untrusted_wrapped INTEGER NOT NULL DEFAULT 0,
  injection_blocked INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok','error','aborted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_action_log_provider_created ON ai_action_log(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_action_log_created ON ai_action_log(created_at);
`)

// --- Thread AI Summary cache (§3.3 B2) -------------------------------------
//
// Cache of generated one-line + 5-bullet AI summaries for message threads,
// keyed by a stable, order-independent `thread_hash` (see `computeThreadHash`)
// SCOPED to the owning `account_id`. Reopening the same thread returns the
// cached row instead of re-generating, which saves both latency and provider
// cost. This is a pure read/write cache: no mail state is ever mutated here,
// and there is no destructive path beyond overwriting an existing summary for
// the same `(account_id, thread_hash)` pair.
//
// The PRIMARY KEY is the COMPOSITE `(account_id, thread_hash)`, NOT the hash
// alone. This is a privacy/isolation invariant: two different accounts whose
// threads happen to share the same identity tokens (e.g. the same Message-IDs,
// which is entirely possible for a message CC'd to two of the user's own
// accounts) would otherwise collide on a hash-only key — account A could read
// or overwrite account B's summary. Account scoping is therefore enforced at
// the QUERY level (`WHERE account_id=? AND thread_hash=?`), never on the hash
// alone: a forged or accidentally-colliding hash from one account can never
// surface another account's row. The composite key also gives us the natural
// INSERT ... ON CONFLICT(account_id, thread_hash) upsert without a separate
// unique index. Privacy note: only the derived hash and the model-produced
// summary text land here; the raw thread identity set (Message-IDs / uids) is
// hashed one-way at the call site and never stored, so the cache cannot be
// walked back to the underlying mail.
//
// `bullets` is a JSON-encoded array of strings (the expandable 5-bullet form);
// `one_line` is the collapsed single-line form. `created_at` is epoch
// milliseconds (INTEGER) — this table is a cache, so it uses a numeric clock
// for cheap freshness comparisons rather than the ISO-8601 TEXT convention the
// audit/session tables use for human-readable append-only logs.
db.exec(`
CREATE TABLE IF NOT EXISTS ai_summaries(
  account_id TEXT NOT NULL,
  thread_hash TEXT NOT NULL,
  one_line TEXT NOT NULL,
  bullets TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, thread_hash)
);
CREATE INDEX IF NOT EXISTS idx_ai_summaries_account ON ai_summaries(account_id);
`)

export type AiActionLogEntry = {
  provider: string
  model?: string | null
  goal?: string | null
  toolName?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
  untrustedWrapped?: number
  injectionBlocked?: number
  outcome: 'ok' | 'error' | 'aborted'
}

export type AiActionLogRow = {
  id: number
  provider: string
  model: string | null
  goal: string | null
  toolName: string | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  untrustedWrapped: number
  injectionBlocked: number
  outcome: 'ok' | 'error' | 'aborted'
  createdAt: string
  deletedAt: string | null
}

export type AiActionLogListOptions = {
  limit?: number
  offset?: number
  provider?: string
  /** ISO timestamp (inclusive). */
  from?: string
  /** ISO timestamp (exclusive). */
  to?: string
}

export type AiActionLogListResult = {
  rows: AiActionLogRow[]
  total: number
}

export type AiUsageAggregatePeriod = 'today' | 'week' | 'month'

export type AiUsageAggregateRow = {
  provider: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  untrustedWrapped: number
  injectionBlocked: number
}

/**
 * Hard upper bound on physical row count in `ai_action_log`. Enforced after
 * every successful `appendAiActionLog` via `pruneAiActionLog`. See the schema
 * comment block above for the full rationale; in short, this is a DoS guard
 * against a flood of AI requests (legitimate or injection-driven) growing
 * the SQLite file until the disk fills.
 *
 * 10 000 rows ≈ a few MB worst-case (each row is a handful of counters and
 * short enumerated strings — no prompt text, no email body). At a sustained
 * 100 AI requests / day that is roughly three months of audit history, which
 * is plenty for the «Privacy & Audit» surface; older rows fall off silently.
 */
export const AI_ACTION_LOG_MAX_ROWS = 10_000

/**
 * Background row-count rotation for `ai_action_log`. Physically deletes
 * everything beyond the most recent `maxRows` rows (by `id`, which is
 * monotonic AUTOINCREMENT and therefore chronological). Returns the number
 * of rows deleted.
 *
 * Behaviour:
 *   - `maxRows >= currentRowCount` → 0 rows deleted (no-op).
 *   - `maxRows == 0` → every row is deleted (full wipe). Documented and
 *     exercised by a unit test; the AI service never calls with 0, but the
 *     contract is explicit so a future caller cannot be surprised.
 *   - `maxRows < 0` or non-integer → `TypeError`. This is a programming
 *     error in the caller, not a runtime condition. `appendAiActionLog`
 *     wraps its own call in try/catch so even a thrown `TypeError` here
 *     never bubbles up to the AI request path.
 *
 * Intentionally NOT exposed via IPC. The append-only audit log is part of
 * the trust model; a compromised renderer must not be able to silently drop
 * audit rows. The export is for in-process use (the `appendAiActionLog`
 * caller in this file) and for direct unit-testing.
 */
export function pruneAiActionLog(maxRows: number): number {
  if (!Number.isInteger(maxRows) || maxRows < 0) {
    throw new TypeError(`pruneAiActionLog: maxRows must be a non-negative integer, got ${String(maxRows)}`)
  }
  if (maxRows === 0) {
    // Full wipe — caller asked explicitly.
    const res = db.prepare(`DELETE FROM ai_action_log`).run()
    return res.changes
  }
  // Threshold-id approach: find the id of the row at position `maxRows`
  // from the end, then delete everything with a smaller id. Robust because
  // `id` is INTEGER PRIMARY KEY AUTOINCREMENT (strictly monotonic). One
  // index seek + one ranged DELETE; cheaper than `NOT IN (subquery)`.
  const threshold = db.prepare(
    `SELECT id FROM ai_action_log ORDER BY id DESC LIMIT 1 OFFSET ?`,
  ).get(maxRows) as { id: number } | undefined
  if (!threshold) {
    // Fewer than `maxRows` rows in the table — nothing to prune.
    return 0
  }
  const res = db.prepare(`DELETE FROM ai_action_log WHERE id <= ?`).run(threshold.id)
  return res.changes
}

/**
 * Append a single audit row. Pure best-effort — failure to write the row MUST
 * NOT block / fail the caller (mirrors `appendMcpAuditEvent`). The caller
 * (electron/services/ai.ts) has already streamed the result to the user;
 * losing one audit row is an observability loss, not a policy violation.
 *
 * Runs `pruneAiActionLog(AI_ACTION_LOG_MAX_ROWS)` after a SUCCESSFUL INSERT
 * to enforce the row-count cap. Defence-in-depth: if the INSERT itself fails
 * (CHECK constraint, malformed entry, SQLITE_BUSY at insert time), we MUST
 * NOT prune — a failed-to-record action has no business triggering physical
 * deletion of existing audit rows. The prune call is wrapped in its own
 * try/catch so a rotation failure (e.g. SQLITE_BUSY mid-rotation) never
 * blocks the caller either — observability-loss is acceptable, blocking the
 * AI path is not.
 *
 * Returns nothing. This used to return a boolean signalling whether the INSERT
 * durably persisted, so the §2.39 AI Rules pipeline could carry an un-persisted
 * budget charge across ticks. That cross-tick carry mechanism was REMOVED in the
 * pipeline simplification (the daily budget is now a SOFT cap bounded by the HARD
 * hourly call cap, with no un-persisted-charge carry), so no caller reads the
 * result any more — the API is back to `void`, matching every other best-effort
 * audit writer (`appendMcpAuditEvent`).
 */
export function appendAiActionLog(entry: AiActionLogEntry): void {
  let inserted = false
  try {
    db.prepare(
      `INSERT INTO ai_action_log(
         provider, model, goal, tool_name,
         input_tokens, output_tokens, cost_usd,
         untrusted_wrapped, injection_blocked, outcome, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      entry.provider,
      entry.model ?? null,
      entry.goal ?? null,
      entry.toolName ?? null,
      entry.inputTokens ?? null,
      entry.outputTokens ?? null,
      entry.costUsd ?? null,
      Math.max(0, Math.trunc(entry.untrustedWrapped ?? 0)),
      Math.max(0, Math.trunc(entry.injectionBlocked ?? 0)),
      entry.outcome,
    )
    inserted = true
  } catch {
    // Audit append must never throw back to the caller.
  }
  if (inserted) {
    try {
      pruneAiActionLog(AI_ACTION_LOG_MAX_ROWS)
    } catch {
      // Rotation failure is observability-loss, not a policy violation. The
      // INSERT already durably committed; a rotation hiccup does not undo it.
    }
  }
}

function mapAiActionLogRow(r: {
  id: number
  provider: string
  model: string | null
  goal: string | null
  tool_name: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  untrusted_wrapped: number
  injection_blocked: number
  outcome: string
  created_at: string
  deleted_at: string | null
}): AiActionLogRow {
  return {
    id: r.id,
    provider: r.provider,
    model: r.model,
    goal: r.goal,
    toolName: r.tool_name,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    untrustedWrapped: r.untrusted_wrapped,
    injectionBlocked: r.injection_blocked,
    outcome: (r.outcome === 'ok' || r.outcome === 'error' || r.outcome === 'aborted')
      ? r.outcome
      : 'error',
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
  }
}

/**
 * List live (not soft-deleted) audit rows in reverse-chronological order.
 * Pagination via `limit` (default 50, max 500) and `offset` (default 0).
 * Optional `provider`, `from`, `to` filters narrow the result. `total` is the
 * count of live rows matching the same filters (without pagination) — the
 * renderer uses it to render page counts.
 */
export function listAiActionLog(opts: AiActionLogListOptions = {}): AiActionLogListResult {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), 500)
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0))
  const where: string[] = ['deleted_at IS NULL']
  const params: unknown[] = []
  if (opts.provider) {
    where.push('provider = ?')
    params.push(opts.provider)
  }
  if (opts.from) {
    where.push('created_at >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('created_at < ?')
    params.push(opts.to)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  type Row = {
    id: number
    provider: string
    model: string | null
    goal: string | null
    tool_name: string | null
    input_tokens: number | null
    output_tokens: number | null
    cost_usd: number | null
    untrusted_wrapped: number
    injection_blocked: number
    outcome: string
    created_at: string
    deleted_at: string | null
  }

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS c FROM ai_action_log ${whereSql}`,
  ).get(...params) as { c: number }
  const total = totalRow?.c ?? 0

  const rows = db.prepare(
    `SELECT id, provider, model, goal, tool_name,
            input_tokens, output_tokens, cost_usd,
            untrusted_wrapped, injection_blocked, outcome,
            created_at, deleted_at
       FROM ai_action_log
       ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as Row[]

  return { rows: rows.map(mapAiActionLogRow), total }
}

/**
 * Aggregate usage and privacy counters per-provider for the requested period.
 * Soft-deleted rows are excluded. `cost_usd` is summed across rows where it
 * is non-null; if every row in the period has null cost (e.g. subscription
 * provider only) the aggregate `costUsd` is null.
 */
export function aggregateAiUsage(period: AiUsageAggregatePeriod): AiUsageAggregateRow[] {
  let cutoff: string
  if (period === 'today') {
    cutoff = `datetime('now', 'start of day')`
  } else if (period === 'week') {
    cutoff = `datetime('now', '-7 days')`
  } else {
    cutoff = `datetime('now', '-30 days')`
  }
  type Row = {
    provider: string
    requests: number
    input_tokens: number | null
    output_tokens: number | null
    cost_usd: number | null
    cost_rows: number
    untrusted_wrapped: number | null
    injection_blocked: number | null
  }
  const rows = db.prepare(
    `SELECT provider,
            COUNT(*) AS requests,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cost_usd) AS cost_usd,
            SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS cost_rows,
            SUM(untrusted_wrapped) AS untrusted_wrapped,
            SUM(injection_blocked) AS injection_blocked
       FROM ai_action_log
      WHERE deleted_at IS NULL AND created_at >= ${cutoff}
      GROUP BY provider
      ORDER BY provider ASC`,
  ).all() as Row[]
  return rows.map(r => ({
    provider: r.provider,
    requests: r.requests,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    costUsd: r.cost_rows > 0 ? (r.cost_usd ?? 0) : null,
    untrustedWrapped: r.untrusted_wrapped ?? 0,
    injectionBlocked: r.injection_blocked ?? 0,
  }))
}

/**
 * Soft-delete a single audit entry by id. Sets `deleted_at` to now; the row
 * stays in the table so the append-only invariant holds. Returns `true` iff
 * a live row was matched.
 */
export function softDeleteAiActionEntry(id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) return false
  const res = db.prepare(
    `UPDATE ai_action_log
        SET deleted_at = datetime('now')
      WHERE id = ? AND deleted_at IS NULL`,
  ).run(id)
  return res.changes > 0
}

/**
 * Soft-delete every live audit row. Returns the number of rows soft-deleted.
 * Never issues DELETE — the append-only invariant holds even for "Clear All".
 */
export function clearAiActionLog(): number {
  const res = db.prepare(
    `UPDATE ai_action_log
        SET deleted_at = datetime('now')
      WHERE deleted_at IS NULL`,
  ).run()
  return res.changes
}

/**
 * Export every live (not soft-deleted) audit row as JSON or CSV. Returns the
 * serialized payload; the IPC layer hands it to the renderer to either save
 * via Electron `dialog.showSaveDialog` or trigger a Blob download.
 */
export function exportAiActionLog(format: 'json' | 'csv'): string {
  type Row = {
    id: number
    provider: string
    model: string | null
    goal: string | null
    tool_name: string | null
    input_tokens: number | null
    output_tokens: number | null
    cost_usd: number | null
    untrusted_wrapped: number
    injection_blocked: number
    outcome: string
    created_at: string
    deleted_at: string | null
  }
  const rows = db.prepare(
    `SELECT id, provider, model, goal, tool_name,
            input_tokens, output_tokens, cost_usd,
            untrusted_wrapped, injection_blocked, outcome,
            created_at, deleted_at
       FROM ai_action_log
      WHERE deleted_at IS NULL
      ORDER BY id ASC`,
  ).all() as Row[]
  const mapped = rows.map(mapAiActionLogRow)
  if (format === 'json') {
    return JSON.stringify(mapped, null, 2)
  }
  // CSV — quote everything string-shaped and escape embedded quotes per RFC4180.
  const header = [
    'id', 'provider', 'model', 'goal', 'tool_name',
    'input_tokens', 'output_tokens', 'cost_usd',
    'untrusted_wrapped', 'injection_blocked', 'outcome',
    'created_at',
  ]
  const csvCell = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const lines = [header.join(',')]
  for (const r of mapped) {
    lines.push([
      csvCell(r.id),
      csvCell(r.provider),
      csvCell(r.model),
      csvCell(r.goal),
      csvCell(r.toolName),
      csvCell(r.inputTokens),
      csvCell(r.outputTokens),
      csvCell(r.costUsd),
      csvCell(r.untrustedWrapped),
      csvCell(r.injectionBlocked),
      csvCell(r.outcome),
      csvCell(r.createdAt),
    ].join(','))
  }
  // RFC4180 §2.1: each record is delimited by CRLF. Some spreadsheet importers
  // (Excel on Windows, classic) treat lone LF as part of the previous field
  // when a quoted cell contains a real LF — using CRLF here keeps the row
  // boundary unambiguous regardless of cell content.
  return lines.join('\r\n')
}

// --- Notification Center ---
db.exec(`
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
`)

/** Escape LIKE special characters: % → \%, _ → \_ */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&')
}

function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase()
}

function isServiceLikeEmail(emailNorm: string): boolean {
  const e = normalizeEmail(emailNorm)
  if (!e) return false
  return (
    e.startsWith('no-reply@')
    || e.startsWith('noreply@')
    || e.startsWith('do-not-reply@')
    || e.startsWith('donotreply@')
  )
}

function hasColumn(table: string, column: string): boolean {
  // SQL injection protection: only allow identifiers matching [a-zA-Z_][a-zA-Z0-9_]*.
  if (!/^[a-zA-Z_]\w*$/.test(table)) throw new Error(`Invalid table name: ${table}`)
  // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
  return rows.some(r => r.name === column)
}

// Singleton key/value table tracking which named, one-shot data migrations
// have already executed against this DB file. Used for migrations that
// cannot be expressed as a `hasColumn` / `CREATE INDEX IF NOT EXISTS`
// idempotency check (e.g. one-time data backfills that must NOT re-run
// after the user mutates the affected rows). New entries are written via
// `markSchemaMigrationApplied(name)` and read via `isSchemaMigrationApplied`.
db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations(
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

function isSchemaMigrationApplied(name: string): boolean {
  const row = db.prepare(`SELECT 1 AS v FROM schema_migrations WHERE name=?`).get(name) as { v: number } | undefined
  return Boolean(row)
}

function markSchemaMigrationApplied(name: string): void {
  db.prepare(
    `INSERT INTO schema_migrations(name, applied_at) VALUES(?, datetime('now'))
     ON CONFLICT(name) DO NOTHING`,
  ).run(name)
}

// --- Migrations (must be idempotent) ---
if (!hasColumn('messages', 'from_name')) {
  db.exec(`ALTER TABLE messages ADD COLUMN from_name TEXT`)
}
if (!hasColumn('messages', 'to_addr')) {
  db.exec(`ALTER TABLE messages ADD COLUMN to_addr TEXT`)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_addr)`)
if (!hasColumn('messages', 'body_text')) {
  db.exec(`ALTER TABLE messages ADD COLUMN body_text TEXT`)
}
if (!hasColumn('messages', 'flagged')) {
  db.exec(`ALTER TABLE messages ADD COLUMN flagged INTEGER DEFAULT 0`)
}
if (!hasColumn('messages', 'has_attachments')) {
  db.exec(`ALTER TABLE messages ADD COLUMN has_attachments INTEGER DEFAULT 0`)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_flagged ON messages(account_id, folder_path, flagged)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(account_id, folder_path, unread)`)

// Migration: offline storage of message bodies
if (!hasColumn('messages', 'body_downloaded')) {
  db.exec(`ALTER TABLE messages ADD COLUMN body_downloaded INTEGER DEFAULT 0`)
}
if (!hasColumn('messages', 'message_size')) {
  db.exec(`ALTER TABLE messages ADD COLUMN message_size INTEGER DEFAULT 0`)
}
// Conversation View (B2.8): threading headers
if (!hasColumn('messages', 'message_id')) {
  db.exec(`ALTER TABLE messages ADD COLUMN message_id TEXT`)
}
if (!hasColumn('messages', 'in_reply_to')) {
  db.exec(`ALTER TABLE messages ADD COLUMN in_reply_to TEXT`)
}
if (!hasColumn('messages', 'references')) {
  db.exec(`ALTER TABLE messages ADD COLUMN "references" TEXT`)
}

// Offline operations queue
db.exec(`
  CREATE TABLE IF NOT EXISTS offline_ops(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    folder TEXT NOT NULL,
    uid INTEGER NOT NULL,
    op_type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`)
// Migration: add unique index for upsert deduplication
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_ops_dedup
  ON offline_ops(account_id, folder, uid, op_type);
`)
// Migration: add uid_validity column for UIDVALIDITY guard during replay
if (!hasColumn('offline_ops', 'uid_validity')) {
  db.exec(`ALTER TABLE offline_ops ADD COLUMN uid_validity INTEGER`)
}
// Migration: add retry_count for poison-op handling (discard after MAX retries)
if (!hasColumn('offline_ops', 'retry_count')) {
  db.exec(`ALTER TABLE offline_ops ADD COLUMN retry_count INTEGER DEFAULT 0`)
}

// Sync state (per-folder)
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_state(
    account_id INTEGER NOT NULL,
    folder TEXT NOT NULL,
    highest_modseq TEXT,
    uid_validity INTEGER,
    last_full_sync TEXT,
    PRIMARY KEY (account_id, folder)
  );
`)

// Migration: archive ref for Send & Archive via queue
if (!hasColumn('send_queue', 'archive_ref')) {
  db.exec(`ALTER TABLE send_queue ADD COLUMN archive_ref TEXT`)
}

if (!hasColumn('folder_prefs', 'visible')) {
  db.exec(`ALTER TABLE folder_prefs ADD COLUMN visible INTEGER NOT NULL DEFAULT 1`)
}
if (!hasColumn('folder_prefs', 'include_in_badges')) {
  db.exec(`ALTER TABLE folder_prefs ADD COLUMN include_in_badges INTEGER NOT NULL DEFAULT 0`)
}
if (!hasColumn('folder_prefs', 'header_sync_mode')) {
  db.exec(`ALTER TABLE folder_prefs ADD COLUMN header_sync_mode TEXT NOT NULL DEFAULT 'on_open'`)
}
if (!hasColumn('folder_prefs', 'header_sync_days')) {
  db.exec(`ALTER TABLE folder_prefs ADD COLUMN header_sync_days INTEGER`)
}
if (!hasColumn('folder_prefs', 'offline_mode')) {
  db.exec(`ALTER TABLE folder_prefs ADD COLUMN offline_mode TEXT NOT NULL DEFAULT 'off'`)
}
if (!hasColumn('folder_prefs', 'offline_days')) {
  db.exec(`ALTER TABLE folder_prefs ADD COLUMN offline_days INTEGER`)
}
if (!hasColumn('folder_prefs', 'icon')) {
  db.exec(`ALTER TABLE folder_prefs ADD COLUMN icon TEXT`)
}
if (!hasColumn('folder_prefs', 'updated_at')) {
  db.exec(`ALTER TABLE folder_prefs ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))`)
}
// §2.15-ter: per-folder INDEX toggle. Default 1 (indexed) for backward compat.
// When 0, upsertMessages still inserts the row (so list view keeps working
// for Spam/Trash management), but the body_text column stays NULL — that
// excludes the row from FTS5 because the messages_fts content view
// references body_text/subject/from_addr/etc and the FTS triggers use the
// NULL body_text directly. Skipping FTS rebuild keeps Junk/Spam/Trash out
// of search hits, which is what users want for those roles.
if (!hasColumn('folder_prefs', 'index_in_search')) {
  db.exec(`ALTER TABLE folder_prefs ADD COLUMN index_in_search INTEGER NOT NULL DEFAULT 1`)
}

// Pin emails (B2.24): pinned column for messages
if (!hasColumn('messages', 'pinned')) {
  db.exec(`ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0`)
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(account_id, folder_path, pinned)`)

// Search Excellence: attachment filenames column for filename: operator
if (!hasColumn('messages', 'attachment_filenames')) {
  db.exec(`ALTER TABLE messages ADD COLUMN attachment_filenames TEXT`)
}

// Search Excellence Hardening: folder crawl state for background header coverage
db.exec(`
  CREATE TABLE IF NOT EXISTS folder_crawl_state(
    account_id INTEGER NOT NULL,
    folder_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started',
    watermark_uid INTEGER,
    total_exists INTEGER,
    crawled_count INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    completed_at TEXT,
    error TEXT,
    PRIMARY KEY (account_id, folder_path)
  );
`)
// Migration: add columns to existing table
if (!hasColumn('folder_crawl_state', 'total_exists')) {
  db.exec(`ALTER TABLE folder_crawl_state ADD COLUMN total_exists INTEGER`)
}
if (!hasColumn('folder_crawl_state', 'crawled_count')) {
  db.exec(`ALTER TABLE folder_crawl_state ADD COLUMN crawled_count INTEGER DEFAULT 0`)
}
if (!hasColumn('folder_crawl_state', 'highest_modseq')) {
  db.exec(`ALTER TABLE folder_crawl_state ADD COLUMN highest_modseq TEXT`)
}

// Migration: cached_detail stores serialized MessageDetails JSON for instant re-opens
// (avoids re-parsing large EML files on every click).
if (!hasColumn('messages', 'cached_detail')) {
  db.exec(`ALTER TABLE messages ADD COLUMN cached_detail TEXT`)
}

// Migration (TLS trust rework): keep the PEM body of a pinned certificate next
// to its fingerprint. The pinned TLS path verifies the chain for real now
// (`rejectUnauthorized: true`), so a self-signed or private-CA endpoint needs
// its own certificate as an explicit trust anchor — a fingerprint alone cannot
// make OpenSSL trust anything. Nullable on purpose: pins stored before this
// column existed keep working for publicly-chaining servers and stay
// fail-closed for self-signed ones until re-confirmed.
if (!hasColumn('tls_pins', 'cert_pem')) {
  db.exec(`ALTER TABLE tls_pins ADD COLUMN cert_pem TEXT`)
}

// Full-text search (FTS5) on subject/from.
// Using external content table `messages` so message metadata remains the single source of truth.
let hadFts =
  Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_fts'`).get())

// If FTS schema changed (e.g., new columns added) — recreate the table and triggers.
//
// §2.15-ter (codex iteration 4): the AFTER UPDATE trigger uses an explicit
// `OF subject, from_addr, from_name, to_addr, body_text, attachment_filenames`
// clause so that *only* mutations to those FTS-projected columns fire the
// trigger. UPDATEs on non-FTS columns (unread, flagged, body_downloaded,
// cached_detail, pinned, message_size) do NOT touch messages_fts at all —
// which means setUnread / setFlagged / setBodyDownloaded / setCachedDetail /
// setPinned need NO indexInSearch rebalance.
//
// Why this matters: before the OF clause, every UPDATE on any messages
// column fired the trigger's 'delete' on OLD VALUES + insert of NEW VALUES.
// For folders with indexInSearch=false, OLD VALUES were never indexed (the
// row was removed from FTS by upsertMessages), so the trigger's 'delete'
// would corrupt FTS5 shadow tables with "database disk image is malformed".
// updateMessageBodyText (touches body_text), updateAttachmentFilenames
// (touches attachment_filenames) and upsertMessages's conflict update
// (touches subject/from/to/body_text/attachment_filenames) all DO fire
// the AFTER UPDATE OF trigger and DO need the rebalance pattern — they
// each implement it (see §2.15-ter codex iteration 5 LOW: comments
// updated to match the post-iteration-4 reality where
// attachment_filenames sits in FTS_UPDATE_TRIGGER_COLUMNS).
//
// AFTER UPDATE OF columns (canonical FTS-projected set, must stay in sync
// with messages_fts column list above): subject, from_addr, from_name,
// to_addr, body_text, attachment_filenames.
const FTS_UPDATE_TRIGGER_COLUMNS = 'subject, from_addr, from_name, to_addr, body_text, attachment_filenames'
if (hadFts) {
  try {
    const cols = db.prepare(`PRAGMA table_info(messages_fts)`).all() as Array<{ name?: unknown }>
    const names = new Set(cols.map(c => String(c.name || '')))
    const required = ['subject', 'from_addr', 'from_name', 'to_addr', 'body_text', 'attachment_filenames']
    const ok = required.every(n => names.has(n))
    if (!ok) {
      // Atomic DROP+CREATE: wrap in transaction so a crash mid-migration won't leave
      // the FTS table dropped but not recreated.
      db.exec(`BEGIN;
        DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;
        DROP TRIGGER IF EXISTS messages_au;
        DROP TABLE IF EXISTS messages_fts;

        CREATE VIRTUAL TABLE messages_fts
        USING fts5(subject, from_addr, from_name, to_addr, body_text, attachment_filenames, content='messages', content_rowid='id', tokenize='unicode61');

        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES (new.id, new.subject, new.from_addr, new.from_name, new.to_addr, new.body_text, new.attachment_filenames);
        END;
        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES ('delete', old.id, old.subject, old.from_addr, old.from_name, old.to_addr, old.body_text, old.attachment_filenames);
        END;
        CREATE TRIGGER messages_au AFTER UPDATE OF ${FTS_UPDATE_TRIGGER_COLUMNS} ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES ('delete', old.id, old.subject, old.from_addr, old.from_name, old.to_addr, old.body_text, old.attachment_filenames);
          INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES (new.id, new.subject, new.from_addr, new.from_name, new.to_addr, new.body_text, new.attachment_filenames);
        END;
      COMMIT;`)
      hadFts = false
    }
  } catch {
    // If schema detection failed — leave it as is.
  }
}

let ftsEnabled = hadFts

try {
  // §2.15-ter (codex iteration 4): the messages_au trigger uses
  // `AFTER UPDATE OF <FTS columns>` so non-FTS UPDATEs (setUnread,
  // setFlagged, setBodyDownloaded, setCachedDetail, setPinned,
  // updateAttachmentFilenames) do NOT fire it. This closes a class of
  // FTS-corruption bugs in indexInSearch=false folders without the
  // upsertMessages-style rebalance dance.
  //
  // Existing databases created with the old `AFTER UPDATE` (no OF clause)
  // need the trigger replaced. CREATE TRIGGER IF NOT EXISTS does NOT do
  // that — it skips if a trigger of that name exists, regardless of body.
  // Migrate: detect the legacy trigger by looking for "AFTER UPDATE ON" in
  // sqlite_master, then DROP+RECREATE in a transaction so a crash cannot
  // leave the trigger missing.
  if (hadFts) {
    try {
      const triggerSqlRow = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_au'`
      ).get() as { sql?: string } | undefined
      const sql = triggerSqlRow?.sql || ''
      const hasOfClause = /AFTER\s+UPDATE\s+OF\s+/i.test(sql)
      if (sql && !hasOfClause) {
        db.exec(`BEGIN;
          DROP TRIGGER messages_au;
          CREATE TRIGGER messages_au AFTER UPDATE OF ${FTS_UPDATE_TRIGGER_COLUMNS} ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES ('delete', old.id, old.subject, old.from_addr, old.from_name, old.to_addr, old.body_text, old.attachment_filenames);
            INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES (new.id, new.subject, new.from_addr, new.from_name, new.to_addr, new.body_text, new.attachment_filenames);
          END;
        COMMIT;`)
      }
    } catch {
      // Trigger introspection / migration failed — fall through and rely on
      // CREATE TRIGGER IF NOT EXISTS below to install the trigger if the
      // legacy one was somehow missing. Existing legacy trigger remains
      // as-is (with the over-firing footprint), which is no worse than
      // before this fix.
    }
  }

  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
		USING fts5(subject, from_addr, from_name, to_addr, body_text, attachment_filenames, content='messages', content_rowid='id', tokenize='unicode61');

		CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
		  INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES (new.id, new.subject, new.from_addr, new.from_name, new.to_addr, new.body_text, new.attachment_filenames);
		END;
		CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
		  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES ('delete', old.id, old.subject, old.from_addr, old.from_name, old.to_addr, old.body_text, old.attachment_filenames);
		END;
		CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF ${FTS_UPDATE_TRIGGER_COLUMNS} ON messages BEGIN
		  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES ('delete', old.id, old.subject, old.from_addr, old.from_name, old.to_addr, old.body_text, old.attachment_filenames);
		  INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES (new.id, new.subject, new.from_addr, new.from_name, new.to_addr, new.body_text, new.attachment_filenames);
		END;
	`)

  // If FTS was just created — rebuild the index from existing rows.
  ftsEnabled = true
  if (!hadFts) {
    try {
      // §2.15-ter (codex iteration 5 HIGH 2): the bare 'rebuild' command
      // repopulates messages_fts from EVERY row in `messages`, including
      // folders with folder_prefs.index_in_search=0 (Spam/Junk/Trash that
      // the user excluded from search). After a schema migration or fresh
      // FTS table creation, this would silently re-index excluded folders
      // and violate the per-folder gate invariant. We follow up with a
      // targeted DELETE to remove rows for excluded folders before any
      // search query can hit the FTS index. Both statements run in a
      // transaction so a partial failure cannot leave the index in a
      // half-rebuilt state where excluded folders remain searchable.
      db.transaction(() => {
        db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
        db.exec(
          `INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
           SELECT 'delete', m.id, m.subject, m.from_addr, m.from_name, m.to_addr, m.body_text, m.attachment_filenames
           FROM messages m
           JOIN folder_prefs fp
             ON fp.account_id = m.account_id AND fp.folder_path = m.folder_path
           WHERE fp.index_in_search = 0`
        )
      })()
    } catch {
      // Theoretically rebuild may fail on some SQLite builds/configurations.
      // In that case we continue and fall back to LIKE when needed.
    }
  }
} catch {
  // If FTS5 is not available in this SQLite build — continue without FTS (fallback to LIKE).
  ftsEnabled = hadFts
}

/**
 * Run FTS5 'optimize' to merge segments. Without periodic optimization the
 * messages_fts_data table accumulates one segment per upsert — on a churning
 * mailbox this can grow to tens of thousands of segments and bloat the index
 * 10-20× its natural size, which dramatically slows cold searches because the
 * engine has to merge results from every segment on each MATCH query.
 *
 * 'optimize' is fast on small corpora (sub-second on tens of thousands of rows)
 * and idempotent: a no-op when the index is already in a single segment.
 * We run it once per startup and then on a 6-hour interval.
 */
export function optimizeFts(): { ok: boolean; durationMs: number; segmentsBefore?: number; segmentsAfter?: number } {
  if (!ftsEnabled) return { ok: false, durationMs: 0 }
  const start = Date.now()
  let segmentsBefore: number | undefined
  let segmentsAfter: number | undefined
  try {
    segmentsBefore = (db.prepare(`SELECT COUNT(*) as c FROM messages_fts_data`).get() as { c: number } | undefined)?.c
  } catch { /* ignore */ }
  try {
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('optimize')`)
  } catch {
    return { ok: false, durationMs: Date.now() - start, segmentsBefore }
  }
  try {
    segmentsAfter = (db.prepare(`SELECT COUNT(*) as c FROM messages_fts_data`).get() as { c: number } | undefined)?.c
  } catch { /* ignore */ }
  return { ok: true, durationMs: Date.now() - start, segmentsBefore, segmentsAfter }
}

/**
 * Build an FTS5 MATCH expression for search-as-you-type.
 * Every token of length ≥3 gets a `*` prefix wildcard — required for
 * morphologically rich languages (Russian "лариса" must match "ларису",
 * "ларисой", etc.) and for partial-word matching while typing. Tokens shorter
 * than 3 chars are kept exact because a 1-2 letter prefix would expand to a
 * huge slice of the term dictionary.
 */
function buildFtsMatch(tokens: string[]): string {
  if (tokens.length === 0) return ''
  return tokens.map(t => (t.length >= 3 ? `${t}*` : t)).join(' AND ')
}

/** Converts a row from SQLite: unread/flagged/has_attachments 0|1 → boolean */
function mapRow(row: RawMessageRow): MessageRow {
  const { has_attachments, body_text, attachment_filenames, pinned, ...rest } = row
  const mapped: MessageRow = { ...rest, unread: row.unread === 1, flagged: row.flagged === 1, hasAttachments: has_attachments === 1 }
  if (pinned === 1) mapped.pinned = true
  if (body_text != null) mapped.bodyText = body_text
  if (attachment_filenames != null) mapped.attachmentFilenames = attachment_filenames
  return mapped
}

function mapFolderPrefRow(row: RawFolderPrefRow): FolderPrefRow {
  return {
    accountId: row.accountId,
    folderPath: row.folderPath,
    visible: row.visible === 1,
    includeInBadges: row.includeInBadges === 1,
    headerSyncMode: row.headerSyncMode,
    headerSyncDays: typeof row.headerSyncDays === 'number' ? row.headerSyncDays : undefined,
    offlineMode: row.offlineMode,
    offlineDays: typeof row.offlineDays === 'number' ? row.offlineDays : undefined,
    icon: row.icon || undefined,
    // SQLite stores BOOLEAN as INTEGER. Default 1 was added in the column
    // migration above so older rows hydrate as `true`.
    indexInSearch: row.indexInSearch !== 0,
    updatedAt: row.updatedAt,
  }
}

// --- Contacts (B2.4) ---

export type ContactRow = {
  id: number
  email: string
  emailNorm: string
  name?: string | null
  frequency: number
  lastUsed?: string | null
  lastSeen?: string | null
  source: string
}

function mapContactRow(r: {
  id: number
  email: string
  email_norm: string
  name: string | null
  frequency: number
  last_used: string | null
  last_seen: string | null
  source: string
}): ContactRow {
  return {
    id: r.id,
    email: r.email,
    emailNorm: r.email_norm,
    name: r.name,
    frequency: r.frequency,
    lastUsed: r.last_used,
    lastSeen: r.last_seen,
    source: r.source,
  }
}

export function upsertContactsIncoming(items: { email: string; name?: string }[], seenAtIso = new Date().toISOString()) {
  const stmt = db.prepare(`
    INSERT INTO contacts(email, email_norm, name, frequency, last_used, last_seen, source)
    VALUES(@email, @email_norm, @name, 0, NULL, @last_seen, 'auto')
    ON CONFLICT(email_norm) DO UPDATE SET
      email=excluded.email,
      name=COALESCE(NULLIF(TRIM(excluded.name), ''), contacts.name),
      last_seen=excluded.last_seen
  `)
  const trx = db.transaction((rows: typeof items) => {
    for (const it of rows) {
      const email = (it.email || '').trim()
      const emailNorm = normalizeEmail(email)
      if (!emailNorm) continue
      if (isServiceLikeEmail(emailNorm)) continue
      stmt.run({
        email,
        email_norm: emailNorm,
        name: (it.name || '').trim() || null,
        last_seen: seenAtIso,
      })
    }
  })
  trx(items)
}

export function upsertContactsOutgoing(items: { email: string; name?: string }[], usedAtIso = new Date().toISOString()) {
  const stmt = db.prepare(`
    INSERT INTO contacts(email, email_norm, name, frequency, last_used, last_seen, source)
    VALUES(@email, @email_norm, @name, 1, @last_used, @last_seen, 'auto')
    ON CONFLICT(email_norm) DO UPDATE SET
      email=excluded.email,
      name=COALESCE(NULLIF(TRIM(excluded.name), ''), contacts.name),
      frequency=contacts.frequency + 1,
      last_used=excluded.last_used,
      last_seen=excluded.last_seen
  `)
  const trx = db.transaction((rows: typeof items) => {
    for (const it of rows) {
      const email = (it.email || '').trim()
      const emailNorm = normalizeEmail(email)
      if (!emailNorm) continue
      if (isServiceLikeEmail(emailNorm)) continue
      stmt.run({
        email,
        email_norm: emailNorm,
        name: (it.name || '').trim() || null,
        last_used: usedAtIso,
        last_seen: usedAtIso,
      })
    }
  })
  trx(items)
}

export function upsertContactManual(emailRaw: string, nameRaw?: string) {
  const email = (emailRaw || '').trim()
  const emailNorm = normalizeEmail(email)
  if (!emailNorm) return
  const now = new Date().toISOString()
  const name = (nameRaw || '').trim() || null
  db.prepare(`
    INSERT INTO contacts(email, email_norm, name, frequency, last_used, last_seen, source)
    VALUES(?, ?, ?, 0, NULL, ?, 'manual')
    ON CONFLICT(email_norm) DO UPDATE SET
      email=excluded.email,
      name=COALESCE(NULLIF(TRIM(excluded.name), ''), contacts.name),
      last_seen=excluded.last_seen,
      source='manual'
  `).run(email, emailNorm, name, now)
}

export function searchContacts(queryRaw: string, limit = 8): ContactRow[] {
  const q = (queryRaw || '').trim()
  if (!q) return []
  const qNorm = normalizeEmail(q)
  const nameNorm = qNorm // lower-case for name prefix match

  // Prefix match on email_norm and name (case-insensitive).
  const patEmail = `${escapeLike(qNorm)}%`
  const patName = `${escapeLike(nameNorm)}%`

  const rows = db.prepare(`
    SELECT
      id,
      email,
      email_norm,
      name,
      frequency,
      last_used,
      last_seen,
      source
    FROM contacts
    WHERE
      (
        email_norm LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(name, '')) LIKE ? ESCAPE '\\'
      )
      AND NOT (
        source='auto'
        AND (
          email_norm LIKE 'no-reply@%'
          OR email_norm LIKE 'noreply@%'
          OR email_norm LIKE 'do-not-reply@%'
          OR email_norm LIKE 'donotreply@%'
        )
      )
    ORDER BY frequency DESC, last_used DESC, last_seen DESC
    LIMIT ?
  `).all(patEmail, patName, limit) as Array<{
    id: number
    email: string
    email_norm: string
    name: string | null
    frequency: number
    last_used: string | null
    last_seen: string | null
    source: string
  }>
  return rows.map(mapContactRow)
}

/**
 * §2.15-ter: in-memory cache of folder_prefs.index_in_search keyed by
 * `${accountId}:${folderPath}`. Avoids a per-message DB round-trip on the
 * upsertMessages hot path (a typical sync batch is 100-500 rows).
 *
 * Invalidated explicitly when upsertFolderPref runs (the only writer).
 * Cache misses fall through to a single SELECT per (account, folder) per
 * upsertMessages call. Folders without an explicit pref row default to
 * `true` (indexed) — same semantics as the column DEFAULT.
 */
const indexInSearchCache = new Map<string, boolean>()

function indexInSearchCacheKey(accountId: number, folderPath: string): string {
  return `${accountId}:${folderPath}`
}

function invalidateIndexInSearchCache(accountId: number, folderPath: string): void {
  indexInSearchCache.delete(indexInSearchCacheKey(accountId, folderPath))
}

/**
 * §2.15-ter (codex iteration 4): drop every cache entry for an account.
 * Used by deleteAccountData where we wipe folder_prefs in bulk and
 * have no list of paths to invalidate individually. Iterates the Map
 * keys (string-prefix match) — Map sizes are bounded by the number of
 * folders the user has touched, so the scan is cheap.
 */
function invalidateIndexInSearchCacheForAccount(accountId: number): void {
  const prefix = `${accountId}:`
  for (const key of indexInSearchCache.keys()) {
    if (key.startsWith(prefix)) indexInSearchCache.delete(key)
  }
}

/** Test-only helper: drop the entire cache between vitest cases. */
export function __resetIndexInSearchCacheForTest(): void {
  indexInSearchCache.clear()
}

function getIndexInSearchCached(accountId: number, folderPath: string): boolean {
  const key = indexInSearchCacheKey(accountId, folderPath)
  const cached = indexInSearchCache.get(key)
  if (cached !== undefined) return cached
  const row = db.prepare(
    `SELECT index_in_search as v FROM folder_prefs WHERE account_id=? AND folder_path=?`
  ).get(accountId, folderPath) as { v: number } | undefined
  // Default true when no folder_prefs row exists yet (folder not registered
  // through ensureFolderPrefs). Mirrors column DEFAULT 1.
  const value = row ? row.v !== 0 : true
  indexInSearchCache.set(key, value)
  return value
}

// ---------------------------------------------------------------------------
// §2.15-ter — FTS5 trigger / per-folder index gate architectural invariant.
//
// SQLite triggers `messages_ai` / `messages_ad` / `messages_au` (AFTER
// INSERT / DELETE / UPDATE OF <FTS columns> on `messages`) are defined ONCE
// and the AI/AD triggers fire UNCONDITIONALLY for every row INSERT /
// DELETE. The AU trigger is scoped to FTS-projected columns only via the
// `OF` clause (codex iteration 4), so non-FTS UPDATEs (setUnread,
// setFlagged, setBodyDownloaded, setCachedDetail, setPinned) do NOT fire
// it. None of the triggers consult `folder_prefs.index_in_search` — the
// per-folder gate is enforced at the CALLER level: when a folder has
// `indexInSearch=false`, the row must NOT live in `messages_fts`
// regardless of what the triggers do.
//
// Four FTS-mutation paths exist in this file. Each balances the trigger
// asymmetry differently:
//
//   1. INSERT (`upsertMessages`, fresh row):
//        Trigger inserts row into FTS → caller follows up with FTS5 'delete'
//        on the new rowid + content snapshot, removing it again. No
//        pre-action needed — the rowid is fresh.
//
//   2. CONFLICT UPDATE (`upsertMessages`, existing row):
//        Trigger does 'delete' on OLD VALUES + insert of NEW VALUES.
//        OLD VALUES are NOT in FTS (a previous upsert removed them via
//        path 1). Same corruption as path 3. Fix: caller pre-inserts
//        OLD VALUES before UPDATE so 'delete' balances, then post-deletes
//        NEW VALUES so the row leaves FTS again.
//
//   3. UPDATE (`updateMessageBodyText`, `updateAttachmentFilenames`):
//        Both touch FTS-projected columns (body_text, attachment_filenames),
//        so the AFTER UPDATE OF trigger fires. Same shape as path 2.
//        Caller pre-inserts OLD VALUES before UPDATE, runs UPDATE,
//        then post-deletes NEW VALUES inside a transaction.
//
//   4. DELETE (`deleteMessages`, `removeStaleMessages`,
//      `removeStaleMessagesByUids`, `removeTempPlaceholders`,
//      `deleteAccountData`, the DELETE half of `moveMessagesLocally`):
//        Trigger does 'delete' on OLD VALUES — same corruption when the
//        row is missing from FTS. Fix: caller pre-inserts OLD VALUES
//        before DELETE so the trigger's 'delete' is balanced. No
//        post-action needed — the trigger's 'delete' removes the row.
//        This pattern is factored into `prepareFtsDeleteRebalance()` below.
//
//   5. TOGGLE (`upsertFolderPref` flips `index_in_search`,
//      §2.15-ter codex iteration 5 HIGH 1):
//        Pure reconciliation — does NOT mutate `messages`, so no trigger
//        fires. true → false: enumerates rows for (account, folder) and
//        runs FTS5 'delete' for each so they leave the index. false →
//        true: runs 'delete' (no-op when row not in FTS) followed by an
//        INSERT to backfill rows that were excluded by previous
//        `upsertMessages` calls. Both branches run inside the same
//        transaction as the `folder_prefs` UPSERT to keep the prefs row
//        and FTS state consistent.
//
//   6. SCHEMA REBUILD (`messages_fts` virtual table created or recreated,
//      §2.15-ter codex iteration 5 HIGH 2):
//        FTS5 'rebuild' command repopulates from EVERY row in `messages`,
//        ignoring `folder_prefs`. We follow it with a targeted
//        `INSERT INTO messages_fts(messages_fts, rowid, ...) VALUES
//        ('delete', ...)` for rows whose folder has
//        `index_in_search = 0`. Wrapped in a transaction so a partial
//        failure cannot leave excluded folders searchable.
//
// >>> If you add a NEW mutation path on `messages` that touches an
// >>> FTS-projected column (subject, from_addr, from_name, to_addr,
// >>> body_text, attachment_filenames), you MUST handle the
// >>> indexInSearch=false case using one of the patterns above. UPDATEs
// >>> on non-FTS columns (unread, flagged, body_downloaded, cached_detail,
// >>> pinned, message_size) need NO rebalance because the AFTER UPDATE OF
// >>> trigger does not fire for them. Failing to follow this rule will
// >>> corrupt FTS5 shadow tables in production for any user with a
// >>> Junk/Spam/Trash folder. There is a reproducer test for each path
// >>> in `packages/db/index.test.ts`.
//
// Production data corruption regressions caught by this invariant so far:
// upsertMessages initial INSERT (initial), updateMessageBodyText (2026-04
// body indexer), deleteMessages (2026-04-25 mail.flows.spec.ts:250
// delete-forever from Trash), upsertMessages CONFLICT UPDATE (2026-04-25
// codex iter4 BLOCKER), updateAttachmentFilenames (2026-04-25 codex iter4
// BLOCKER follow-on). Five structural bugs of the same shape — hence the
// helper and the OF-scoped trigger.
// ---------------------------------------------------------------------------

/**
 * Helper for the DELETE-path FTS rebalance pattern (case 3 above).
 *
 * Returns a `rebalance(rowsToDelete)` function that, when called inside the
 * caller's transaction BEFORE the DELETE statement runs, re-inserts OLD
 * VALUES into `messages_fts` for every row in an `indexInSearch=false`
 * folder. Once the AFTER DELETE trigger fires its own 'delete', it sees a
 * matching row and balances cleanly.
 *
 * Rows in `indexInSearch=true` folders need no pre-action — the AFTER DELETE
 * trigger's 'delete' balances against the row that the AFTER INSERT trigger
 * originally pushed.
 *
 * Returns a no-op when FTS5 is not available in this SQLite build
 * (`ftsEnabled=false`). The cache lookup is the same one used by the hot
 * path in `upsertMessages`.
 *
 * Usage:
 *   const rebalance = prepareFtsDeleteRebalance()
 *   const trx = db.transaction((items: T[]) => {
 *     rebalance(items.map(it => ({ accountId, folder, uid: it.uid })))
 *     for (const it of items) deleteStmt.run(...)
 *   })
 *
 * @internal — exported only for tests (`__resetIndexInSearchCacheForTest`
 *             friend). Production code should call it inside the same
 *             transaction as the DELETE.
 */
type FtsDeleteRebalanceTarget = { accountId: number; folder: string; uid: number }
type FtsDeleteRebalance = (rows: ReadonlyArray<FtsDeleteRebalanceTarget>) => void

function prepareFtsDeleteRebalance(): FtsDeleteRebalance {
  if (!ftsEnabled) {
    // FTS5 not available — triggers do not exist, no rebalance needed.
    return () => { /* no-op */ }
  }
  // Resolves the row's content snapshot from `messages` (the row still
  // exists at this point because the caller pre-runs us BEFORE its DELETE).
  // Single-row SELECT keyed by (account, folder, uid) — same lookup shape
  // as upsertMessages.idLookup, so query-plan reuse is identical.
  const selectStmt = db.prepare(
    `SELECT id, subject, from_addr, from_name, to_addr, body_text, attachment_filenames
     FROM messages WHERE account_id=? AND folder_path=? AND uid=?`
  )
  // Pre-insert OLD VALUES into messages_fts so the AFTER DELETE trigger's
  // 'delete' has a matching row to subtract. The trigger does the rest.
  const ftsInsertStmt = db.prepare(
    `INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )

  return function rebalance(rows: ReadonlyArray<FtsDeleteRebalanceTarget>): void {
    for (const r of rows) {
      // Per-folder gate: only excluded folders need rebalancing — included
      // folders already have the row indexed and the trigger's 'delete'
      // will balance against it naturally.
      if (getIndexInSearchCached(r.accountId, r.folder)) continue
      const row = selectStmt.get(r.accountId, r.folder, r.uid) as
        | { id: number; subject: string | null; from_addr: string | null; from_name: string | null; to_addr: string | null; body_text: string | null; attachment_filenames: string | null }
        | undefined
      if (!row) continue
      ftsInsertStmt.run(
        row.id,
        row.subject ?? '',
        row.from_addr ?? '',
        row.from_name ?? '',
        row.to_addr ?? '',
        row.body_text ?? '',
        row.attachment_filenames ?? '',
      )
    }
  }
}

/**
 * Bulk variant for the wide DELETE paths (`removeStaleMessages` mass-delete,
 * `deleteAccountData`, `removeTempPlaceholders`) where the caller does not
 * have an explicit UID list — it deletes by predicate (`account_id=?`,
 * `folder_path=?`, `uid<0`, etc.).
 *
 * Approach: select the full list of (id, content snapshot) for rows in
 * `indexInSearch=false` folders matching the predicate, then bulk-insert
 * each into `messages_fts`. The caller's subsequent DELETE fires the
 * AFTER DELETE trigger once per row, and each trigger now sees a matching
 * FTS row to balance.
 *
 * @param scope a row-selecting predicate as a `WHERE` clause without the
 *              `WHERE` keyword, plus its parameters. Must match the same
 *              rows the caller is about to DELETE.
 *
 * Note: this path can be expensive for very large mass-deletes (full
 * folder purge). Acceptable trade-off — UIDVALIDITY bumps and account
 * deletes are rare and we'd rather pay one extra SELECT/INSERT pair per
 * row than risk corruption.
 */
function rebalanceFtsForBulkDelete(
  whereClause: string,
  whereParams: ReadonlyArray<unknown>,
): void {
  if (!ftsEnabled) return
  // Resolve only rows whose folder is excluded from search — included
  // folders need no rebalancing.
  const sql =
    `SELECT m.id, m.subject, m.from_addr, m.from_name, m.to_addr, m.body_text, m.attachment_filenames
     FROM messages m
     LEFT JOIN folder_prefs fp
       ON fp.account_id = m.account_id AND fp.folder_path = m.folder_path
     WHERE (${whereClause})
       AND COALESCE(fp.index_in_search, 1) = 0`
  const rows = db.prepare(sql).all(...whereParams) as Array<{
    id: number
    subject: string | null
    from_addr: string | null
    from_name: string | null
    to_addr: string | null
    body_text: string | null
    attachment_filenames: string | null
  }>
  if (rows.length === 0) return
  const ftsInsertStmt = db.prepare(
    `INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  for (const r of rows) {
    ftsInsertStmt.run(
      r.id,
      r.subject ?? '',
      r.from_addr ?? '',
      r.from_name ?? '',
      r.to_addr ?? '',
      r.body_text ?? '',
      r.attachment_filenames ?? '',
    )
  }
}

export function upsertMessages(
  accountId: number,
  folder: string,
  rows: {
    uid: number
    subject: string
    fromAddr: string
    fromName?: string
    toAddr?: string
    bodyText?: string
    date: string
    unread: boolean
    flagged?: boolean
    hasAttachments?: boolean
    attachmentFilenames?: string
    messageId?: string
    inReplyTo?: string
    references?: string
  }[]
) {
  const stmt = db.prepare(`INSERT INTO messages(
      account_id, folder_path, uid,
      subject, from_addr, from_name, to_addr, body_text,
      date, unread, flagged, has_attachments, attachment_filenames,
      message_id, in_reply_to, "references"
    )
    VALUES(
      @account_id, @folder_path, @uid,
      @subject, @from_addr, @from_name, @to_addr, @body_text,
      @date, @unread, @flagged, @has_attachments, @attachment_filenames,
      @message_id, @in_reply_to, @references
    )
    ON CONFLICT(account_id, folder_path, uid) DO UPDATE SET
      subject=excluded.subject,
      from_addr=excluded.from_addr,
      from_name=excluded.from_name,
      to_addr=excluded.to_addr,
      body_text=COALESCE(excluded.body_text, messages.body_text),
      date=excluded.date,
      unread=excluded.unread,
      flagged=excluded.flagged,
      has_attachments=COALESCE(excluded.has_attachments, messages.has_attachments),
      attachment_filenames=COALESCE(excluded.attachment_filenames, messages.attachment_filenames),
      message_id=excluded.message_id,
      in_reply_to=excluded.in_reply_to,
      "references"=excluded."references"`)

  // §2.15-ter: per-folder index gate. Resolved once per call (not per row)
  // through an in-memory cache to avoid a hot-path SELECT for every batch
  // of headers. Folders without an explicit pref row default to indexed.
  const indexInSearch = getIndexInSearchCached(accountId, folder)

  // After the upsert transaction commits, the FTS5 AFTER INSERT / AFTER
  // UPDATE triggers have already pushed (subject, from_addr, from_name,
  // to_addr, body_text, attachment_filenames) into messages_fts. When the
  // folder is excluded from search we follow up with the FTS5 'delete'
  // command for each rowid so the row leaves the search index but stays
  // visible in the list view (Spam/Trash management). The 'delete' command
  // is idempotent — running it on a rowid that was never indexed is a no-op.
  // We resolve message ids inside the same transaction so the lookup sees
  // the rows we just upserted.
  //
  // §2.15-ter (codex iteration 4 BLOCKER): the conflict-update path needs
  // an OLD-VALUES pre-insert. Flow on a SECOND upsert into an excluded
  // folder:
  //   1. Row exists in messages, was removed from FTS by the previous
  //      upsert's `ftsDeleteStmt` ('delete' command).
  //   2. stmt.run(...) fires the AFTER UPDATE OF trigger (subject etc are
  //      always written by the conflict UPDATE).
  //   3. Trigger emits `INSERT('delete', OLD.id, OLD.subject, ...)`.
  //      OLD VALUES are NOT in FTS → "database disk image is malformed".
  //
  // Fix: for excluded folders, before running stmt, look up the existing
  // row (if any) and re-insert OLD VALUES into FTS. The trigger's 'delete'
  // then balances. The existing ftsDeleteStmt afterwards removes NEW
  // VALUES so the row stays excluded from FTS overall.
  const idLookup = ftsEnabled && !indexInSearch
    ? db.prepare(`SELECT id, subject, from_addr, from_name, to_addr, body_text, attachment_filenames
                  FROM messages WHERE account_id=? AND folder_path=? AND uid=?`)
    : null
  const ftsDeleteStmt = ftsEnabled && !indexInSearch
    ? db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
                  VALUES('delete', ?, ?, ?, ?, ?, ?, ?)`)
    : null
  // Pre-insert OLD VALUES into messages_fts before the AFTER UPDATE OF
  // trigger fires on a conflict-update path.
  const ftsPreInsertStmt = ftsEnabled && !indexInSearch
    ? db.prepare(`INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
    : null

  const trx = db.transaction((items: typeof rows) => {
    for (const r of items) {
      // Excluded folder: rebalance for the conflict-update case. If a row
      // exists for this UID, pre-insert its CURRENT (about-to-be OLD)
      // values into FTS so the trigger's 'delete' can subtract cleanly.
      // For brand-new inserts the lookup returns no row and we skip — the
      // AFTER INSERT trigger doesn't need pre-balancing.
      if (idLookup && ftsPreInsertStmt) {
        const existing = idLookup.get(accountId, folder, r.uid) as
          | { id: number; subject: string | null; from_addr: string | null; from_name: string | null; to_addr: string | null; body_text: string | null; attachment_filenames: string | null }
          | undefined
        if (existing) {
          ftsPreInsertStmt.run(
            existing.id,
            existing.subject ?? '',
            existing.from_addr ?? '',
            existing.from_name ?? '',
            existing.to_addr ?? '',
            existing.body_text ?? '',
            existing.attachment_filenames ?? '',
          )
        }
      }

      stmt.run({
        account_id: accountId,
        folder_path: folder,
        uid: r.uid,
        subject: r.subject,
        from_addr: r.fromAddr,
        from_name: (r.fromName || '').trim() || null,
        to_addr: (r.toAddr || '').trim() || null,
        body_text: typeof r.bodyText === 'string' ? r.bodyText : null,
        date: r.date,
        unread: r.unread ? 1 : 0,
        flagged: r.flagged ? 1 : 0,
        has_attachments: r.hasAttachments == null ? null : r.hasAttachments ? 1 : 0,
        attachment_filenames: typeof r.attachmentFilenames === 'string' ? r.attachmentFilenames.trim() : null,
        message_id: (r.messageId || '').trim() || null,
        in_reply_to: (r.inReplyTo || '').trim() || null,
        references: (r.references || '').trim() || null,
      })

      // Same-transaction follow-up: drop the FTS row that the AFTER INSERT/
      // UPDATE trigger just produced. We match the values by re-reading the
      // row because the FTS5 'delete' command requires the exact column
      // values that were last inserted (it stores no content of its own).
      if (idLookup && ftsDeleteStmt) {
        const idRow = idLookup.get(accountId, folder, r.uid) as
          | { id: number; subject: string | null; from_addr: string | null; from_name: string | null; to_addr: string | null; body_text: string | null; attachment_filenames: string | null }
          | undefined
        if (idRow) {
          ftsDeleteStmt.run(
            idRow.id,
            idRow.subject ?? '',
            idRow.from_addr ?? '',
            idRow.from_name ?? '',
            idRow.to_addr ?? '',
            idRow.body_text ?? '',
            idRow.attachment_filenames ?? '',
          )
        }
      }
    }
  })
  // Telemetry span wraps the whole batch transaction (not per-row) so we
  // get one Sentry span per upsert call, regardless of batch size. The
  // seam swallows any telemetry failure so a broken sink can never turn
  // a successful write into a failure.
  withDbSpan(
    'db.upsert_messages',
    {
      row_count_bucket: bucketFetchedHeaders(rows.length),
      folder_role: folderRoleFromPath(folder),
    },
    () => { trx(rows) },
  )
}

export function getMessages(accountId: number, folder: string, limit = 100): MessageRow[] {
  const stmt = db.prepare(`SELECT
      account_id as accountId,
      folder_path as folder,
      uid,
      subject,
      COALESCE(NULLIF(TRIM(from_name), ''), from_addr) as 'from',
      from_addr as fromAddr,
      from_name as fromName,
      to_addr as toAddr,
      message_id as messageId,
      in_reply_to as inReplyTo,
      "references" as "references",
      body_text,
      date,
      unread,
      flagged,
      has_attachments,
      attachment_filenames,
      pinned
    FROM messages
    WHERE account_id=? AND folder_path=?
      AND NOT EXISTS (
        SELECT 1 FROM snoozed s
        WHERE s.account_id = messages.account_id
          AND s.folder = messages.folder_path
          AND s.uid = messages.uid
      )
    ORDER BY uid DESC LIMIT ?`)
  const rows = stmt.all(accountId, folder, limit) as RawMessageRow[]
  return rows.map(mapRow)
}

export function getMessagesBeforeUid(accountId: number, folder: string, limit = 100, beforeUid?: number): MessageRow[] {
  if (typeof beforeUid !== 'number' || !Number.isFinite(beforeUid)) {
    return getMessages(accountId, folder, limit)
  }
  const stmt = db.prepare(`SELECT
      account_id as accountId,
      folder_path as folder,
      uid,
      subject,
      COALESCE(NULLIF(TRIM(from_name), ''), from_addr) as 'from',
      from_addr as fromAddr,
      from_name as fromName,
      to_addr as toAddr,
      message_id as messageId,
      in_reply_to as inReplyTo,
      "references" as "references",
      body_text,
      date,
      unread,
      flagged,
      has_attachments,
      attachment_filenames,
      pinned
    FROM messages
    WHERE account_id=? AND folder_path=? AND uid < ?
      AND NOT EXISTS (
        SELECT 1 FROM snoozed s
        WHERE s.account_id = messages.account_id
          AND s.folder = messages.folder_path
          AND s.uid = messages.uid
      )
    ORDER BY uid DESC LIMIT ?`)
  const rows = stmt.all(accountId, folder, beforeUid, limit) as RawMessageRow[]
  return rows.map(mapRow)
}

/** Get the maximum UID cached for a given account + folder (or 0 if empty). */
export function getMaxUidForFolder(accountId: number, folder: string): number {
  const row = db.prepare(
    `SELECT MAX(uid) as maxUid FROM messages WHERE account_id=? AND folder_path=?`
  ).get(accountId, folder) as { maxUid: number | null } | undefined
  return row?.maxUid ?? 0
}

/** Get a single message by accountId + folder + uid — O(1) via UNIQUE index */
export function getMessageByUid(accountId: number, folder: string, uid: number): MessageRow | undefined {
  const row = db.prepare(`SELECT
      account_id as accountId,
      folder_path as folder,
      uid,
      subject,
      COALESCE(NULLIF(TRIM(from_name), ''), from_addr) as 'from',
      from_addr as fromAddr,
      from_name as fromName,
      to_addr as toAddr,
      message_id as messageId,
      in_reply_to as inReplyTo,
      "references" as "references",
      body_text,
      date,
      unread,
      flagged,
      has_attachments,
      attachment_filenames,
      pinned
    FROM messages WHERE account_id=? AND folder_path=? AND uid=?`).get(accountId, folder, uid) as RawMessageRow | undefined
  return row ? mapRow(row) : undefined
}

/** Count unread messages — SQL COUNT instead of loading all rows (excludes snoozed) */
export function countUnreadMessages(accountId: number, folder: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM messages
     WHERE account_id=? AND folder_path=? AND unread=1
       AND NOT EXISTS (
         SELECT 1 FROM snoozed s
         WHERE s.account_id = messages.account_id
           AND s.folder = messages.folder_path
           AND s.uid = messages.uid
       )`
  ).get(accountId, folder) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

/** Find thread messages by a set of Message-IDs via SQL */
export function getThreadMessages(accountId: number, folder: string, threadIds: string[]): MessageRow[] {
  if (threadIds.length === 0) return []

  const placeholders = threadIds.map(() => '?').join(',')
  const likeConditions = threadIds.map(() => `"references" LIKE ? ESCAPE '\\'`).join(' OR ')
  const likeParams = threadIds.map(id => `%${escapeLike(id)}%`)

  const sql = `SELECT
      account_id as accountId,
      folder_path as folder,
      uid,
      subject,
      COALESCE(NULLIF(TRIM(from_name), ''), from_addr) as 'from',
      from_addr as fromAddr,
      from_name as fromName,
      to_addr as toAddr,
      message_id as messageId,
      in_reply_to as inReplyTo,
      "references" as "references",
      date,
      unread,
      flagged,
      has_attachments,
      pinned
    FROM messages
    WHERE account_id=? AND folder_path=? AND (
      message_id IN (${placeholders})
      OR in_reply_to IN (${placeholders})
      OR ${likeConditions}
    )
    ORDER BY date ASC`
  const rows = db.prepare(sql).all(accountId, folder, ...threadIds, ...threadIds, ...likeParams) as RawMessageRow[]
  return rows.map(mapRow)
}

export function setUnread(accountId: number, folder: string, uids: number[], unread: boolean) {
  const stmt = db.prepare(`UPDATE messages SET unread=? WHERE account_id=? AND folder_path=? AND uid=?`)
  const trx = db.transaction((ids: number[]) => {
    for (const uid of ids) {
      stmt.run(unread ? 1 : 0, accountId, folder, uid)
    }
  })
  trx(uids)
}

export function setFlagged(accountId: number, folder: string, uids: number[], flagged: boolean) {
  const stmt = db.prepare(`UPDATE messages SET flagged=? WHERE account_id=? AND folder_path=? AND uid=?`)
  const trx = db.transaction((ids: number[]) => {
    for (const uid of ids) {
      stmt.run(flagged ? 1 : 0, accountId, folder, uid)
    }
  })
  trx(uids)
}

export function searchMessages(accountId: number, folder: string, q: string, limit = 100, offset = 0): MessageRow[] {
  const query = q.trim()
  if (!query) return []

  // Wrap the whole search path (FTS5 fast path + LIKE fallback + advanced
  // parser branch) in a single span. We attach query_len_bucket up front
  // from the trimmed query length, and result_count_bucket in finalize
  // once we know the row count. No raw query text ever reaches the span.
  return withDbSpan(
    'db.search_messages',
    {
      query_len_bucket: bucketQueryLen(query.length),
      folder_role: folderRoleFromPath(folder),
    },
    () => searchMessagesImpl(accountId, folder, query, limit, offset),
    (result) => (result.ok ? { result_count_bucket: bucketResultCount(result.value.length) } : undefined),
  )
}

function searchMessagesImpl(accountId: number, folder: string, query: string, limit: number, offset: number): MessageRow[] {
  const parsed = parseSearchQuery(query)
  const advanced = isAdvancedSearch(parsed)

  // Simple queries (no operators/negations) are sent to FTS5 for speed.
  if (!advanced && ftsEnabled) {
    try {
      // Split user input into FTS5-safe sub-tokens.
      // unicode61 tokenizer splits on punctuation (. @ - etc.), so "report.pdf" is indexed as
      // tokens ["report", "pdf"].  We mirror this by splitting the query the same way, then
      // doing prefix matching on each sub-token: "report.pdf" -> "report* AND pdf*".
      const tokens = query
        .split(/[^\p{L}\p{N}_]+/gu)
        .filter(Boolean)
      if (tokens.length === 0) throw new Error('empty fts tokens')
      const fts = buildFtsMatch(tokens)

      // FTS5 bm25() weights: subject(10), from_addr(5), from_name(5), to_addr(3), body_text(1), attachment_filenames(2)
      const stmt = db.prepare(`SELECT
          m.account_id as accountId,
          m.folder_path as folder,
          m.uid,
          m.subject,
          COALESCE(NULLIF(TRIM(m.from_name), ''), m.from_addr) as 'from',
          m.from_addr as fromAddr,
          m.from_name as fromName,
          m.to_addr as toAddr,
          m.message_id as messageId,
          m.in_reply_to as inReplyTo,
          m."references" as "references",
          m.body_text,
          m.date,
          m.unread,
          m.flagged,
          m.has_attachments as has_attachments,
          m.attachment_filenames,
          m.pinned,
          snippet(messages_fts, 4, '«', '»', '…', 40) as matchSnippet /* col 4 = body_text in FTS5(subject,from_addr,from_name,to_addr,body_text,attachment_filenames) */
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE m.account_id=? AND m.folder_path=? AND messages_fts MATCH ?
          AND NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=m.account_id AND s.folder=m.folder_path AND s.uid=m.uid)
        ORDER BY bm25(messages_fts, 10.0, 5.0, 5.0, 3.0, 1.0, 2.0) LIMIT ? OFFSET ?`)
      const rows = stmt.all(accountId, folder, fts, limit, offset) as Array<RawMessageRow & { matchSnippet?: string }>
      return rows.map(r => {
        const mapped = mapRow(r)
        if (r.matchSnippet) mapped.matchSnippet = r.matchSnippet
        return mapped
      })
    } catch {
      // Fall through to advanced/LIKE below.
    }
  }

  if (advanced) {
    const where: string[] = []
    const params: unknown[] = []

    where.push(`m.account_id=?`)
    params.push(accountId)

    const scopeFolder = parsed.anywhere ? null : (parsed.folder || folder)
    if (scopeFolder) {
      where.push(`m.folder_path=?`)
      params.push(scopeFolder)
    }

    /* Exclude snoozed messages */
    where.push(`NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=m.account_id AND s.folder=m.folder_path AND s.uid=m.uid)`)

    // §2.15-ter (codex iteration 4): exclude folders with indexInSearch=false.
    // The FTS5 fast path above is already correct because excluded rows
    // are not in messages_fts. The advanced/LIKE fallback paths read
    // from messages directly and would otherwise return rows from
    // Spam/Trash/Junk that the user explicitly excluded from search.
    where.push(`NOT EXISTS (SELECT 1 FROM folder_prefs fp WHERE fp.account_id=m.account_id AND fp.folder_path=m.folder_path AND fp.index_in_search=0)`)

    if (typeof parsed.isUnread === 'boolean') { where.push(`m.unread=?`); params.push(parsed.isUnread ? 1 : 0) }
    if (typeof parsed.isFlagged === 'boolean') { where.push(`m.flagged=?`); params.push(parsed.isFlagged ? 1 : 0) }
    if (typeof parsed.hasAttachment === 'boolean') { where.push(`m.has_attachments=?`); params.push(parsed.hasAttachment ? 1 : 0) }

    if (parsed.uids.length > 0) {
      const ph = parsed.uids.map(() => '?').join(',')
      where.push(`m.uid IN (${ph})`)
      for (const uid of parsed.uids) params.push(uid)
    }

    // Use local midnight (not UTC) so that after:/before: match the user's timezone
    const dayStartIso = (d: string) => new Date(`${d}T00:00:00`).toISOString()
    if (parsed.after) { where.push(`m.date >= ?`); params.push(dayStartIso(parsed.after)) }
    if (parsed.before) { where.push(`m.date < ?`); params.push(dayStartIso(parsed.before)) }

    /** A single LIKE condition across a set of columns for one term. */
    const makeLikeCond = (cols: string[], term: string): string => {
      const pat = `%${escapeLike(term.toLowerCase())}%`
      for (let i = 0; i < cols.length; i++) params.push(pat)
      return '(' + cols.map(c => `LOWER(${c}) LIKE ? ESCAPE '\\'`).join(' OR ') + ')'
    }

    const addLikeAny = (cols: string[], term: string, negate = false) => {
      const cond = makeLikeCond(cols, term)
      where.push(negate ? `NOT ${cond}` : cond)
    }

    /**
     * Multiple terms for the same field → combine with OR within a group.
     * `from:a OR from:b` → `(condA OR condB)`.
     * For negations: `NOT (condA OR condB)` = none match.
     */
    const addLikeGroup = (cols: string[], terms: string[], negate = false) => {
      if (terms.length === 0) return
      if (terms.length === 1) { addLikeAny(cols, terms[0]!, negate); return }
      const parts = terms.map(t => makeLikeCond(cols, t))
      const group = '(' + parts.join(' OR ') + ')'
      where.push(negate ? `NOT ${group}` : group)
    }

    for (const term of parsed.text) {
      addLikeAny(['m.subject', 'm.from_addr', 'm.from_name', 'm.to_addr'], term, false)
    }
    for (const term of parsed.notText) {
      addLikeAny(['m.subject', 'm.from_addr', 'm.from_name', 'm.to_addr'], term, true)
    }

    // from/to: multiple values are combined via OR
    // (a message has one sender, from:a from:b = "from a OR from b")
    addLikeGroup(['m.from_addr', 'm.from_name'], parsed.from, false)
    addLikeGroup(['m.from_addr', 'm.from_name'], parsed.notFrom, true)

    addLikeGroup(['m.to_addr'], parsed.to, false)
    addLikeGroup(['m.to_addr'], parsed.notTo, true)

    for (const term of parsed.subject) {
      addLikeAny(['m.subject'], term, false)
    }
    for (const term of parsed.notSubject) {
      addLikeAny(['m.subject'], term, true)
    }
    for (const term of parsed.body) {
      addLikeAny(['m.body_text'], term, false)
    }
    for (const term of parsed.notBody) {
      addLikeAny(['m.body_text'], term, true)
    }
    for (const term of parsed.filename) {
      addLikeAny(['m.attachment_filenames'], term, false)
    }
    for (const term of parsed.notFilename) {
      addLikeAny(['m.attachment_filenames'], term, true)
    }

    const orderBy = parsed.anywhere ? `m.date DESC, m.uid DESC` : `m.uid DESC`
    const sql = `SELECT
        m.account_id as accountId,
        m.folder_path as folder,
        m.uid,
        m.subject,
        COALESCE(NULLIF(TRIM(m.from_name), ''), m.from_addr) as 'from',
        m.from_addr as fromAddr,
        m.from_name as fromName,
        m.to_addr as toAddr,
        m.message_id as messageId,
        m.in_reply_to as inReplyTo,
        m."references" as "references",
        m.body_text,
        m.date,
        m.unread,
        m.flagged,
        m.has_attachments as has_attachments,
        m.attachment_filenames,
        m.pinned
      FROM messages m
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`

    const rows = db.prepare(sql).all(...params, limit, offset) as RawMessageRow[]
    return rows.map(mapRow)
  }

  const like = `%${escapeLike(query)}%`
  // §2.15-ter (codex iteration 4): LIKE fallback path also respects
  // folder_prefs.index_in_search. Same rationale as the advanced branch
  // above — the FTS path already excludes these folders by virtue of not
  // having rows in messages_fts; the LIKE fallback hits messages directly
  // and must filter explicitly.
  const stmt = db.prepare(`SELECT
      account_id as accountId,
      folder_path as folder,
      uid,
      subject,
      COALESCE(NULLIF(TRIM(from_name), ''), from_addr) as 'from',
      from_addr as fromAddr,
      from_name as fromName,
      to_addr as toAddr,
      message_id as messageId,
      in_reply_to as inReplyTo,
      "references" as "references",
      body_text,
      date,
      unread,
      flagged,
      has_attachments,
      attachment_filenames,
      pinned
    FROM messages
    WHERE account_id=? AND folder_path=? AND (
      subject LIKE ? ESCAPE '\\'
      OR from_addr LIKE ? ESCAPE '\\'
      OR from_name LIKE ? ESCAPE '\\'
      OR to_addr LIKE ? ESCAPE '\\'
      OR body_text LIKE ? ESCAPE '\\'
      OR attachment_filenames LIKE ? ESCAPE '\\'
    )
    AND NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=messages.account_id AND s.folder=messages.folder_path AND s.uid=messages.uid)
    AND NOT EXISTS (SELECT 1 FROM folder_prefs fp WHERE fp.account_id=messages.account_id AND fp.folder_path=messages.folder_path AND fp.index_in_search=0)
    ORDER BY uid DESC LIMIT ? OFFSET ?`)
  const rows = stmt.all(accountId, folder, like, like, like, like, like, like, limit, offset) as RawMessageRow[]
  return rows.map(mapRow)
}

/** Move messages locally: copy rows to destination folder with temporary negative UIDs,
 *  then delete from source. Temporary UIDs are replaced by real server UIDs after
 *  offline replay + folder sync. Uses negative UIDs to avoid conflict with real IMAP UIDs. */
export function moveMessagesLocally(accountId: number, fromFolder: string, toFolder: string, uids: number[]) {
  if (uids.length === 0) return
  // Generate temporary negative UIDs starting from -(max existing negative UID) - 1
  const minRow = db.prepare(
    `SELECT MIN(uid) as minUid FROM messages WHERE account_id=? AND folder_path=?`
  ).get(accountId, toFolder) as { minUid: number | null } | undefined
  let tempUid = Math.min((minRow?.minUid ?? 0) - 1, -1)

  const selectStmt = db.prepare(`SELECT * FROM messages WHERE account_id=? AND folder_path=? AND uid=?`)
  const insertStmt = db.prepare(`INSERT OR IGNORE INTO messages(
    account_id, folder_path, uid, subject, from_addr, from_name, to_addr, body_text,
    date, unread, flagged, has_attachments, attachment_filenames,
    message_id, in_reply_to, "references", pinned
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const deleteStmt = db.prepare(`DELETE FROM messages WHERE account_id=? AND folder_path=? AND uid=?`)
  // §2.15-ter: rebalance FTS for source rows in indexInSearch=false folders
  // before the AFTER DELETE trigger fires. See architectural invariant
  // block near `prepareFtsDeleteRebalance`. The destination INSERT is
  // handled separately below — the AFTER INSERT trigger pushes the row
  // into FTS unconditionally; if the destination folder is excluded we
  // follow up with FTS5 'delete' to mirror the upsertMessages pattern.
  const rebalance = prepareFtsDeleteRebalance()
  const fromFolderExcluded = ftsEnabled && !getIndexInSearchCached(accountId, fromFolder)
  const toFolderExcluded = ftsEnabled && !getIndexInSearchCached(accountId, toFolder)
  // Same lookup + delete shape as upsertMessages — match the row that the
  // AFTER INSERT trigger just pushed and follow up with FTS5 'delete' to
  // honor the destination's indexInSearch=false setting.
  const destIdLookup = toFolderExcluded
    ? db.prepare(`SELECT id, subject, from_addr, from_name, to_addr, body_text, attachment_filenames
                  FROM messages WHERE account_id=? AND folder_path=? AND uid=?`)
    : null
  const destFtsDeleteStmt = toFolderExcluded
    ? db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
                  VALUES('delete', ?, ?, ?, ?, ?, ?, ?)`)
    : null

  const trx = db.transaction(() => {
    if (fromFolderExcluded) {
      rebalance(uids.map((uid) => ({ accountId, folder: fromFolder, uid })))
    }
    for (const uid of uids) {
      const row = selectStmt.get(accountId, fromFolder, uid) as Record<string, unknown> | undefined
      if (row) {
        const newUid = tempUid--
        insertStmt.run(
          accountId, toFolder, newUid,
          row.subject, row.from_addr, row.from_name, row.to_addr, row.body_text,
          row.date, row.unread, row.flagged, row.has_attachments, row.attachment_filenames,
          row.message_id, row.in_reply_to, row.references, row.pinned ?? 0,
        )
        // Mirror upsertMessages: drop the just-inserted row from FTS when
        // the destination folder is excluded from search.
        if (destIdLookup && destFtsDeleteStmt) {
          const idRow = destIdLookup.get(accountId, toFolder, newUid) as
            | { id: number; subject: string | null; from_addr: string | null; from_name: string | null; to_addr: string | null; body_text: string | null; attachment_filenames: string | null }
            | undefined
          if (idRow) {
            destFtsDeleteStmt.run(
              idRow.id,
              idRow.subject ?? '',
              idRow.from_addr ?? '',
              idRow.from_name ?? '',
              idRow.to_addr ?? '',
              idRow.body_text ?? '',
              idRow.attachment_filenames ?? '',
            )
          }
        }
      }
      deleteStmt.run(accountId, fromFolder, uid)
    }
  })
  trx()
}

/** Remove temporary (negative UID) placeholders from a folder.
 *  Called after offline replay + sync when real UIDs are available. */
export function removeTempPlaceholders(accountId: number, folder: string) {
  // §2.15-ter: rebalance FTS for any rows in indexInSearch=false folders
  // before the AFTER DELETE trigger fires. See architectural invariant
  // block near `prepareFtsDeleteRebalance`. Wrapped in a transaction so
  // pre-insert + DELETE are atomic.
  db.transaction(() => {
    rebalanceFtsForBulkDelete(
      `m.account_id=? AND m.folder_path=? AND m.uid < 0`,
      [accountId, folder],
    )
    db.prepare(`DELETE FROM messages WHERE account_id=? AND folder_path=? AND uid < 0`).run(accountId, folder)
  })()
}

export function deleteMessages(accountId: number, folder: string, uids: number[]) {
  const stmt = db.prepare(`DELETE FROM messages WHERE account_id=? AND folder_path=? AND uid=?`)
  // §2.15-ter: when this folder has indexInSearch=false, the rows we're
  // about to delete are NOT present in messages_fts (upsertMessages already
  // removed them). The AFTER DELETE trigger fires unconditionally and will
  // try to subtract token counts from rowids that don't exist, producing
  // SQLITE_CORRUPT_VTAB ("database disk image is malformed"). Pre-insert
  // OLD VALUES so the trigger's 'delete' is balanced. See architectural
  // invariant block near `prepareFtsDeleteRebalance` above.
  const rebalance = prepareFtsDeleteRebalance()
  const trx = db.transaction((ids: number[]) => {
    rebalance(ids.map((uid) => ({ accountId, folder, uid })))
    for (const uid of ids) {
      stmt.run(accountId, folder, uid)
    }
  })
  trx(uids)
}

/**
 * Allowed reason codes for a mass-delete path of `removeStaleMessages`.
 * Every `freshUids=[]` call MUST explicitly declare one of these so the
 * data-loss path is auditable in telemetry and unreachable by accident.
 *
 *   - 'server_empty'      — IMAP mailbox.exists === 0 confirmed (NOT undefined).
 *   - 'uidvalidity_bump'  — UIDVALIDITY changed, server reassigned UIDs.
 *   - 'reconcile'         — explicit reconciliation flow, caller has verified
 *                           it holds the full authoritative UID set.
 *
 * The new-signature contract (see overload below) makes it a compile-time
 * error to pass `[]` without `opts.reason`. This is the core guard against
 * the 2026-04-21 data-loss regression where `mailbox.exists === undefined`
 * silently wiped ~75k cached messages on a transient server read.
 */
export type MassDeleteReason = 'server_empty' | 'uidvalidity_bump' | 'reconcile'

export type RemoveStaleMessagesOpts = {
  /** REQUIRED when freshUids is empty — ensures every mass-delete path is
   *  auditable via the `db.mass_delete_messages` telemetry event. */
  reason: MassDeleteReason
}

/**
 * Removes from cache messages that no longer exist on the IMAP server.
 *
 * Two modes:
 *
 * 1. `freshUids` non-empty: reconcile. Delete rows with uid >= minUid that
 *    are missing from the fresh set. No `opts` required.
 *
 * 2. `freshUids` empty: mass delete (folder purge). REQUIRES explicit
 *    `opts.reason` so the call site declares *why* it is purging the
 *    entire folder. Callers are expected to have verified the precondition
 *    themselves:
 *      - 'server_empty': caller observed `typeof exists === 'number' && exists === 0`
 *      - 'uidvalidity_bump': caller observed UIDVALIDITY mismatch
 *      - 'reconcile': caller has the full authoritative UID set as [] (rare)
 *    A typed overload enforces this at compile time — passing `[]` without
 *    `opts` is a type error. Emits `db.mass_delete_messages` telemetry
 *    with (folder_role, reason, deleted_count_bucket, watermark_preserved).
 */
export function removeStaleMessages(accountId: number, folder: string, freshUids: [], opts: RemoveStaleMessagesOpts): number
// Non-empty-tuple overload: a literal [] does NOT satisfy [number, ...number[]],
// so `removeStaleMessages(1, "INBOX", [])` without opts is a compile error.
// Variable-typed `number[]` still accepts this signature at runtime (length
// check on line 1454 is defence-in-depth for JS consumers / as-any casts).
export function removeStaleMessages(accountId: number, folder: string, freshUids: [number, ...number[]]): number
export function removeStaleMessages(accountId: number, folder: string, freshUids: number[], opts: RemoveStaleMessagesOpts): number
export function removeStaleMessages(
  accountId: number,
  folder: string,
  freshUids: number[],
  opts?: RemoveStaleMessagesOpts,
): number {
  // Span name 'db.reconcile_uids' reflects the reconciliation role of this
  // function: it takes the fresh UID set from the server (post-FETCH) and
  // expunges cached rows that no longer exist there. uidvalidity_changed is
  // always false here — actual UIDVALIDITY bumps are handled upstream by
  // purging the folder before this path runs, so by the time we're here,
  // we're operating under stable UIDVALIDITY.
  return withDbSpan(
    'db.reconcile_uids',
    {
      row_count_bucket: bucketFetchedHeaders(freshUids.length),
      folder_role: folderRoleFromPath(folder),
      uidvalidity_changed: opts?.reason === 'uidvalidity_bump',
    },
    () => {
      if (freshUids.length === 0) {
        // Mass-delete path — folder purge. The new-signature overload makes
        // opts.reason required at compile time, but legacy untyped callers
        // (JS consumers, tests with `as any`) could still reach here without
        // one. Defence in depth: refuse to delete, log, capture.
        if (!opts || !opts.reason) {
          // Fire-and-forget telemetry: something bypassed the compile-time
          // guard. Production Sentry will surface this under db.reconcile_uids
          // via the span's error reporter.
          throw new Error(
            `removeStaleMessages: refusing empty-freshUids mass delete without opts.reason ` +
            `(account=${accountId}, folder_role=${folderRoleFromPath(folder)}) — ` +
            `stale_wipe_guard tripped`
          )
        }
        // Count first so the telemetry event has an accurate deleted_count_bucket
        // even when the DELETE itself is fast. Same-connection read is
        // synchronous so there's no race.
        const countRow = db.prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE account_id=? AND folder_path=?`
        ).get(accountId, folder) as { n: number } | undefined
        const existing = countRow?.n ?? 0
        // §2.15-ter (codex iteration 4): rebalance FTS for any rows in
        // indexInSearch=false folders before the AFTER DELETE trigger
        // fires. See architectural invariant block near
        // `prepareFtsDeleteRebalance`. For folder purge we use the bulk
        // variant which scopes by predicate.
        //
        // Atomicity: rebalance + DELETE wrapped in a single
        // db.transaction so a throw between them (driver error,
        // process kill, panic) cannot leave excluded-folder rows
        // re-inserted into FTS without their messages-row counterpart.
        // Mirrors the pattern used in deleteMessages,
        // removeStaleMessagesByUids, removeTempPlaceholders.
        const result = db.transaction(() => {
          rebalanceFtsForBulkDelete(
            `m.account_id=? AND m.folder_path=?`,
            [accountId, folder],
          )
          return db.prepare(
            `DELETE FROM messages WHERE account_id=? AND folder_path=?`
          ).run(accountId, folder)
        })()
        // Emit db.mass_delete_messages only when we actually deleted rows.
        // A zero-delete (already empty) does not carry information useful
        // to a Sentry signal and would be noisy. Preserve watermark_preserved
        // semantics: 'server_empty' and 'reconcile' preserve the watermark
        // in folder_crawl_state (caller's responsibility), 'uidvalidity_bump'
        // invalidates it.
        if (existing > 0) {
          reportDbEvent('db.mass_delete_messages', {
            folder_role: folderRoleFromPath(folder),
            reason: opts.reason,
            deleted_count_bucket: bucketFetchedHeaders(result.changes),
            watermark_preserved: opts.reason !== 'uidvalidity_bump',
          })
        }
        return result.changes
      }
      const minUid = Math.min(...freshUids)
      const keepSet = new Set(freshUids)
      // Get all uid >= minUid for this folder from DB
      const rows = db.prepare(
        `SELECT uid FROM messages WHERE account_id=? AND folder_path=? AND uid >= ?`
      ).all(accountId, folder, minUid) as Array<{ uid: number }>
      const toDelete = rows.filter(r => !keepSet.has(r.uid)).map(r => r.uid)
      if (toDelete.length === 0) return 0
      const stmt = db.prepare(`DELETE FROM messages WHERE account_id=? AND folder_path=? AND uid=?`)
      // §2.15-ter: pre-insert OLD VALUES into FTS for rows in
      // indexInSearch=false folders so the AFTER DELETE trigger can
      // balance. See architectural invariant block near
      // `prepareFtsDeleteRebalance`.
      const rebalance = prepareFtsDeleteRebalance()
      const trx = db.transaction((ids: number[]) => {
        rebalance(ids.map((uid) => ({ accountId, folder, uid })))
        for (const uid of ids) stmt.run(accountId, folder, uid)
      })
      trx(toDelete)
      return toDelete.length
    },
    (result) => (result.ok ? { deleted_count_bucket: bucketFetchedHeaders(result.value) } : undefined),
  )
}

export type UnifiedCursor = {
  date: string
  accountId: number
  uid: number
}

/** Pagination for Unified Inbox (folder_path='INBOX') by (date, account_id, uid) in descending order */
export function getUnifiedInboxPage(accountIds: number[], limit = 100, cursor?: UnifiedCursor): MessageRow[] {
  const ids = accountIds.map(n => Math.floor(Number(n))).filter(n => Number.isFinite(n) && n > 0)
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  let sql = `SELECT
      account_id as accountId,
      folder_path as folder,
      uid,
      subject,
      COALESCE(NULLIF(TRIM(from_name), ''), from_addr) as 'from',
      from_addr as fromAddr,
      from_name as fromName,
      to_addr as toAddr,
      message_id as messageId,
      in_reply_to as inReplyTo,
      "references" as "references",
      date,
      unread,
      flagged,
      has_attachments,
      attachment_filenames,
      pinned
    FROM messages
    WHERE folder_path='INBOX' AND account_id IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM snoozed s
        WHERE s.account_id = messages.account_id
          AND s.folder = messages.folder_path
          AND s.uid = messages.uid
      )`
  const params: unknown[] = [...ids]

  if (cursor) {
    sql += ` AND (
      date < ?
      OR (date = ? AND (account_id < ? OR (account_id = ? AND uid < ?)))
    )`
    params.push(cursor.date, cursor.date, cursor.accountId, cursor.accountId, cursor.uid)
  }

  sql += ` ORDER BY date DESC, account_id DESC, uid DESC LIMIT ?`
  params.push(limit)

  const rows = db.prepare(sql).all(...params) as RawMessageRow[]
  return rows.map(mapRow)
}

/**
 * Search across multiple accounts.
 * scope: 'inbox' — only INBOX, 'all' — all indexed folders.
 */
export function searchUnifiedInbox(accountIds: number[], q: string, limit = 100, offset = 0, scope: 'inbox' | 'all' = 'all'): MessageRow[] {
  const ids = accountIds.map(n => Math.floor(Number(n))).filter(n => Number.isFinite(n) && n > 0)
  const query = q.trim()
  if (!query || ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  const folderFilter = scope === 'inbox'

  const parsed = parseSearchQuery(query)
  const advanced = isAdvancedSearch(parsed)

  if (!advanced && ftsEnabled) {
    try {
      const tokens = query
        .split(/[^\p{L}\p{N}_]+/gu)
        .filter(Boolean)
      if (tokens.length === 0) throw new Error('empty fts tokens')
      const fts = buildFtsMatch(tokens)

      const folderWhere = folderFilter ? `AND m.folder_path='INBOX'` : ''
      // FTS5 bm25() weights: subject(10), from_addr(5), from_name(5), to_addr(3), body_text(1), attachment_filenames(2)
      const sql = `SELECT
          m.account_id as accountId,
          m.folder_path as folder,
          m.uid,
          m.subject,
          COALESCE(NULLIF(TRIM(m.from_name), ''), m.from_addr) as 'from',
          m.from_addr as fromAddr,
          m.from_name as fromName,
          m.to_addr as toAddr,
          m.message_id as messageId,
          m.in_reply_to as inReplyTo,
          m."references" as "references",
          m.body_text,
          m.date,
          m.unread,
          m.flagged,
          m.has_attachments as has_attachments,
          m.attachment_filenames,
          m.pinned,
          snippet(messages_fts, 4, '«', '»', '…', 40) as matchSnippet /* col 4 = body_text in FTS5(subject,from_addr,from_name,to_addr,body_text,attachment_filenames) */
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE m.account_id IN (${placeholders}) ${folderWhere} AND messages_fts MATCH ?
          AND NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=m.account_id AND s.folder=m.folder_path AND s.uid=m.uid)
        ORDER BY bm25(messages_fts, 10.0, 5.0, 5.0, 3.0, 1.0, 2.0) LIMIT ? OFFSET ?`
      const rows = db.prepare(sql).all(...ids, fts, limit, offset) as Array<RawMessageRow & { matchSnippet?: string }>
      return rows.map(r => {
        const mapped = mapRow(r)
        if (r.matchSnippet) mapped.matchSnippet = r.matchSnippet
        return mapped
      })
    } catch {
      // Fall through to LIKE below.
    }
  }

  if (advanced) {
    const where: string[] = []
    const params: unknown[] = []

    where.push(`m.account_id IN (${placeholders})`)
    params.push(...ids)

    // Scope: parsed.anywhere overrides everything, parsed.folder specifies explicit folder,
    // otherwise use the scope parameter.
    const scopeFolder = parsed.anywhere ? null : (parsed.folder || (folderFilter ? 'INBOX' : null))
    if (scopeFolder) {
      where.push(`m.folder_path=?`)
      params.push(scopeFolder)
    }

    /* Exclude snoozed messages */
    where.push(`NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=m.account_id AND s.folder=m.folder_path AND s.uid=m.uid)`)

    // §2.15-ter (codex iteration 4): same indexInSearch=false filter as the
    // single-account searchMessages advanced branch. Unified inbox's FTS
    // path is already correct (excluded rows are not in messages_fts), but
    // the advanced fallback hits messages directly.
    where.push(`NOT EXISTS (SELECT 1 FROM folder_prefs fp WHERE fp.account_id=m.account_id AND fp.folder_path=m.folder_path AND fp.index_in_search=0)`)

    if (typeof parsed.isUnread === 'boolean') { where.push(`m.unread=?`); params.push(parsed.isUnread ? 1 : 0) }
    if (typeof parsed.isFlagged === 'boolean') { where.push(`m.flagged=?`); params.push(parsed.isFlagged ? 1 : 0) }
    if (typeof parsed.hasAttachment === 'boolean') { where.push(`m.has_attachments=?`); params.push(parsed.hasAttachment ? 1 : 0) }

    if (parsed.uids.length > 0) {
      const ph = parsed.uids.map(() => '?').join(',')
      where.push(`m.uid IN (${ph})`)
      for (const uid of parsed.uids) params.push(uid)
    }

    // Use local midnight (not UTC) so that after:/before: match the user's timezone
    const dayStartIso = (d: string) => new Date(`${d}T00:00:00`).toISOString()
    if (parsed.after) { where.push(`m.date >= ?`); params.push(dayStartIso(parsed.after)) }
    if (parsed.before) { where.push(`m.date < ?`); params.push(dayStartIso(parsed.before)) }

    const makeLikeCond = (cols: string[], term: string): string => {
      const pat = `%${escapeLike(term.toLowerCase())}%`
      for (let i = 0; i < cols.length; i++) params.push(pat)
      return '(' + cols.map(c => `LOWER(${c}) LIKE ? ESCAPE '\\'`).join(' OR ') + ')'
    }

    const addLikeAny = (cols: string[], term: string, negate = false) => {
      const cond = makeLikeCond(cols, term)
      where.push(negate ? `NOT ${cond}` : cond)
    }

    const addLikeGroup = (cols: string[], terms: string[], negate = false) => {
      if (terms.length === 0) return
      if (terms.length === 1) { addLikeAny(cols, terms[0]!, negate); return }
      const parts = terms.map(t => makeLikeCond(cols, t))
      const group = '(' + parts.join(' OR ') + ')'
      where.push(negate ? `NOT ${group}` : group)
    }

    for (const term of parsed.text) addLikeAny(['m.subject', 'm.from_addr', 'm.from_name', 'm.to_addr'], term, false)
    for (const term of parsed.notText) addLikeAny(['m.subject', 'm.from_addr', 'm.from_name', 'm.to_addr'], term, true)

    addLikeGroup(['m.from_addr', 'm.from_name'], parsed.from, false)
    addLikeGroup(['m.from_addr', 'm.from_name'], parsed.notFrom, true)

    addLikeGroup(['m.to_addr'], parsed.to, false)
    addLikeGroup(['m.to_addr'], parsed.notTo, true)

    for (const term of parsed.subject) addLikeAny(['m.subject'], term, false)
    for (const term of parsed.notSubject) addLikeAny(['m.subject'], term, true)
    for (const term of parsed.body) addLikeAny(['m.body_text'], term, false)
    for (const term of parsed.notBody) addLikeAny(['m.body_text'], term, true)
    for (const term of parsed.filename) addLikeAny(['m.attachment_filenames'], term, false)
    for (const term of parsed.notFilename) addLikeAny(['m.attachment_filenames'], term, true)

    const sql = `SELECT
        m.account_id as accountId,
        m.folder_path as folder,
        m.uid,
        m.subject,
        COALESCE(NULLIF(TRIM(m.from_name), ''), m.from_addr) as 'from',
        m.from_addr as fromAddr,
        m.from_name as fromName,
        m.to_addr as toAddr,
        m.message_id as messageId,
        m.in_reply_to as inReplyTo,
        m."references" as "references",
        m.body_text,
        m.date,
        m.unread,
        m.flagged,
        m.has_attachments as has_attachments,
        m.attachment_filenames,
        m.pinned
      FROM messages m
      WHERE ${where.join(' AND ')}
      ORDER BY m.date DESC, m.account_id DESC, m.uid DESC
      LIMIT ? OFFSET ?`
    const rows = db.prepare(sql).all(...params, limit, offset) as RawMessageRow[]
    return rows.map(mapRow)
  }

  const like = `%${escapeLike(query)}%`
  const folderWhere = folderFilter ? `AND folder_path='INBOX'` : ''
  // §2.15-ter (codex iteration 4): same indexInSearch=false filter as
  // searchMessagesImpl LIKE fallback.
  const sql = `SELECT
      account_id as accountId,
      folder_path as folder,
      uid,
      subject,
      COALESCE(NULLIF(TRIM(from_name), ''), from_addr) as 'from',
      from_addr as fromAddr,
      from_name as fromName,
      to_addr as toAddr,
      message_id as messageId,
      in_reply_to as inReplyTo,
      "references" as "references",
      body_text,
      date,
      unread,
      flagged,
      has_attachments,
      attachment_filenames,
      pinned
    FROM messages
    WHERE account_id IN (${placeholders}) ${folderWhere} AND (
      subject LIKE ? ESCAPE '\\'
      OR from_addr LIKE ? ESCAPE '\\'
      OR from_name LIKE ? ESCAPE '\\'
      OR to_addr LIKE ? ESCAPE '\\'
      OR body_text LIKE ? ESCAPE '\\'
      OR attachment_filenames LIKE ? ESCAPE '\\'
    )
    AND NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=messages.account_id AND s.folder=messages.folder_path AND s.uid=messages.uid)
    AND NOT EXISTS (SELECT 1 FROM folder_prefs fp WHERE fp.account_id=messages.account_id AND fp.folder_path=messages.folder_path AND fp.index_in_search=0)
    ORDER BY date DESC, account_id DESC, uid DESC LIMIT ? OFFSET ?`
  const rows = db.prepare(sql).all(...ids, like, like, like, like, like, like, limit, offset) as RawMessageRow[]
  return rows.map(mapRow)
}

function normalizeFingerprintSha256(fpRaw: string): string {
  return (fpRaw || '').trim().toUpperCase().replace(/-/g, ':')
}

/**
 * Upper bound on a stored certificate body. An 8192-bit certificate with a long
 * SAN list is still well under 10 KB of PEM, so this only rejects pathological
 * input before it reaches the X.509 parser.
 */
const MAX_CERT_PEM_BYTES = 32 * 1024

const PEM_CERT_BEGIN = '-----BEGIN CERTIFICATE-----'
const PEM_CERT_END = '-----END CERTIFICATE-----'

/**
 * Validate a supplied certificate and reduce it to what may be stored.
 *
 * Returns null for "no certificate supplied" (undefined / null / blank), which
 * callers use to mean "leave whatever is already stored alone". Anything else
 * throws: this value ends up in OpenSSL's `ca` list as a trust anchor, so
 * garbage must not reach the store.
 *
 * Two independent guarantees, deliberately not one:
 *
 *  1. `pem` is the *canonical re-encoding* of the parsed certificate
 *     (`cert.toString()`), never the caller's bytes. This is what actually
 *     enforces "one certificate and nothing else": OpenSSL consumes every PEM
 *     block in a string handed to `ca`, but `X509Certificate` parses only the
 *     first block and silently ignores the rest — so a second block of a type
 *     the armour scan below does not recognise (e.g. `BEGIN TRUSTED
 *     CERTIFICATE`) could otherwise ride along behind a fingerprint that
 *     verifies. Re-encoding drops anything that is not the parsed certificate
 *     by construction, rather than by pattern matching.
 *  2. The armour scan still rejects such input outright, so a caller passing a
 *     bundle gets an error instead of silently truncated data.
 *
 * `fingerprintSha256` is taken from the parsed certificate's DER, so it
 * describes exactly the bytes in `pem` — armour, whitespace and line wrapping
 * cannot influence it.
 */
function parsePinCertPem(pemRaw: string | null | undefined): { pem: string; fingerprintSha256: string } | null {
  const raw = (pemRaw || '').trim()
  if (!raw) return null
  if (Buffer.byteLength(raw, 'utf8') > MAX_CERT_PEM_BYTES) {
    throw new Error('TLS pin certificate is too large')
  }

  // Exactly one certificate block, and nothing before or after it. `raw` is
  // already trimmed, so a leading `startsWith` check also rejects any preceding
  // block or junk (OpenSSL's PEM reader would otherwise just skip ahead to the
  // first BEGIN line it recognises).
  const endIdx = raw.indexOf(PEM_CERT_END)
  const singleBlock =
    raw.startsWith(PEM_CERT_BEGIN)
    && endIdx >= 0
    && raw.slice(endIdx + PEM_CERT_END.length).trim() === ''
    && (raw.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0) === 1
  if (!singleBlock) {
    throw new Error('TLS pin certificate must be a single PEM-encoded certificate')
  }

  let cert: X509Certificate
  try {
    cert = new X509Certificate(raw)
  } catch {
    // Unparsable body: reject rather than let it through as an unverifiable
    // trust anchor.
    throw new Error('TLS pin certificate must be PEM-encoded')
  }
  return {
    pem: cert.toString().trim(),
    fingerprintSha256: normalizeFingerprintSha256(cert.fingerprint256),
  }
}

export function listTlsPins(accountId: number): TlsPinRow[] {
  const rows = db.prepare(`
    SELECT
      id,
      account_id as accountId,
      host,
      port,
      fingerprint_sha256 as fingerprintSha256,
      cert_pem as certPem,
      created_at as createdAt
    FROM tls_pins
    WHERE account_id=?
    ORDER BY host ASC, port ASC, created_at DESC
  `).all(accountId) as TlsPinRow[]
  return rows.map((r) => ({
    ...r,
    fingerprintSha256: normalizeFingerprintSha256(r.fingerprintSha256),
    certPem: r.certPem || null,
  }))
}

export function listTlsPinsForEndpoint(accountId: number, hostRaw: string, port: number): string[] {
  const host = (hostRaw || '').trim().toLowerCase()
  const rows = db.prepare(`
    SELECT fingerprint_sha256 as fp
    FROM tls_pins
    WHERE account_id=? AND lower(host)=? AND port=?
    ORDER BY created_at DESC
  `).all(accountId, host, port) as Array<{ fp?: string }>
  return rows
    .map(r => normalizeFingerprintSha256(String(r.fp || '')))
    .filter(Boolean)
}

/**
 * PEM bodies of the pinned certificates for an endpoint, newest pin first.
 *
 * Parallel to `listTlsPinsForEndpoint` (fingerprints) — feeds
 * `buildTlsOptions({ tlsPinnedCertsPem })` so a pinned self-signed /
 * private-CA server can verify its chain against its own certificate instead
 * of relying on a weakened `rejectUnauthorized`. Returns `[]` when the
 * endpoint has no pins, or when every pin predates the `cert_pem` column
 * (fingerprint-only pins are skipped, never faked into anchors).
 */
export function listTlsPinnedCertsPemForEndpoint(accountId: number, hostRaw: string, port: number): string[] {
  const host = (hostRaw || '').trim().toLowerCase()
  const rows = db.prepare(`
    SELECT cert_pem as pem
    FROM tls_pins
    WHERE account_id=? AND lower(host)=? AND port=? AND cert_pem IS NOT NULL
    ORDER BY created_at DESC
  `).all(accountId, host, port) as Array<{ pem?: string | null }>
  return rows
    .map(r => String(r.pem || '').trim())
    .filter(Boolean)
}

/**
 * Create or refresh a pin.
 *
 * `certPemRaw` is optional for backward compatibility: callers that only have
 * a fingerprint keep working, and passing nothing on an existing pin preserves
 * a previously stored certificate rather than clearing it. Passing a PEM
 * backfills pins created before the certificate was captured.
 *
 * Throws when a supplied certificate does not hash to `fingerprintRaw`. The
 * stored PEM becomes an OpenSSL trust anchor for this endpoint, so a
 * (certificate, fingerprint) pair that disagrees would mean the anchor the
 * connection actually trusts is not the certificate the user confirmed —
 * exactly the fail-open hole the pinned path was fixed to close. Nothing is
 * written on mismatch: an existing pin keeps its previous state.
 *
 * What lands in the column is the canonical re-encoding of the parsed
 * certificate, not the caller's bytes — see `parsePinCertPem`.
 */
export function upsertTlsPin(
  accountId: number,
  hostRaw: string,
  portRaw: number,
  fingerprintRaw: string,
  certPemRaw?: string | null,
): TlsPinRow {
  const host = (hostRaw || '').trim().toLowerCase()
  const port = Math.floor(Number(portRaw))
  const fp = normalizeFingerprintSha256(fingerprintRaw)
  const parsedCert = parsePinCertPem(certPemRaw)
  if (!host) throw new Error('TLS pin host is required')
  if (!Number.isFinite(port) || port <= 0) throw new Error('TLS pin port is invalid')
  if (!fp) throw new Error('TLS pin fingerprint is required')
  // Cross-check before any write: the certificate must be the one being pinned.
  // Both sides come from the same parsed DER, so the stored PEM is guaranteed to
  // be the certificate this fingerprint describes.
  if (parsedCert && parsedCert.fingerprintSha256 !== fp) {
    throw new Error('TLS pin certificate does not match the pinned fingerprint')
  }
  const certPem = parsedCert?.pem ?? null

  db.prepare(`
    INSERT INTO tls_pins(account_id, host, port, fingerprint_sha256, cert_pem, created_at)
    VALUES(?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, host, port, fingerprint_sha256) DO UPDATE SET
      cert_pem = COALESCE(excluded.cert_pem, tls_pins.cert_pem)
  `).run(accountId, host, port, fp, certPem)

  const row = db.prepare(`
    SELECT
      id,
      account_id as accountId,
      host,
      port,
      fingerprint_sha256 as fingerprintSha256,
      cert_pem as certPem,
      created_at as createdAt
    FROM tls_pins
    WHERE account_id=? AND host=? AND port=? AND fingerprint_sha256=?
    ORDER BY id DESC
    LIMIT 1
  `).get(accountId, host, port, fp) as TlsPinRow | undefined

  if (!row) throw new Error('Failed to save TLS pin')
  return {
    ...row,
    fingerprintSha256: normalizeFingerprintSha256(row.fingerprintSha256),
    certPem: row.certPem || null,
  }
}

export function removeTlsPin(pinId: number): boolean {
  const res = db.prepare(`DELETE FROM tls_pins WHERE id=?`).run(pinId)
  return res.changes > 0
}

// --- Folder roles cache ---

/** Save cached roles for an account (upsert) */
export function cacheFolderRoles(accountId: number, roles: Record<string, string | undefined>): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO cached_roles(account_id, roles_json, updated_at)
    VALUES(?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET roles_json=excluded.roles_json, updated_at=excluded.updated_at
  `).run(accountId, JSON.stringify(roles), now)
}

/** Get cached roles for an account (or null if none) */
export function getCachedFolderRoles(accountId: number): Record<string, string | undefined> | null {
  const row = db.prepare(
    `SELECT roles_json FROM cached_roles WHERE account_id=?`
  ).get(accountId) as { roles_json: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.roles_json) as Record<string, string | undefined>
  } catch {
    return null
  }
}

/** Get cached roles for all accounts */
export function getAllCachedFolderRoles(): Record<number, Record<string, string | undefined>> {
  const rows = db.prepare(
    `SELECT account_id, roles_json FROM cached_roles`
  ).all() as Array<{ account_id: number; roles_json: string }>
  const result: Record<number, Record<string, string | undefined>> = {}
  for (const row of rows) {
    try {
      result[row.account_id] = JSON.parse(row.roles_json) as Record<string, string | undefined>
    } catch { /* ignore */ }
  }
  return result
}

// --- Mailboxes list cache ---

type CachedMailbox = { path: string; name: string; specialUse?: string | null; unread?: number }

/** Save cached mailboxes for an account (upsert) */
export function cacheMailboxes(accountId: number, mailboxes: CachedMailbox[]): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO cached_mailboxes(account_id, mailboxes_json, updated_at)
    VALUES(?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET mailboxes_json=excluded.mailboxes_json, updated_at=excluded.updated_at
  `).run(accountId, JSON.stringify(mailboxes), now)
}

/** Get cached mailboxes for all accounts */
export function getAllCachedMailboxes(): Record<number, CachedMailbox[]> {
  const rows = db.prepare(
    `SELECT account_id, mailboxes_json FROM cached_mailboxes`
  ).all() as Array<{ account_id: number; mailboxes_json: string }>
  const result: Record<number, CachedMailbox[]> = {}
  for (const row of rows) {
    try {
      result[row.account_id] = JSON.parse(row.mailboxes_json) as CachedMailbox[]
    } catch { /* ignore */ }
  }
  return result
}

/** All folder_prefs for all accounts, grouped by account_id */
export function getAllFolderPrefs(): Record<number, FolderPrefRow[]> {
  const rows = db.prepare(`
    SELECT
      account_id as accountId,
      folder_path as folderPath,
      visible,
      include_in_badges as includeInBadges,
      header_sync_mode as headerSyncMode,
      header_sync_days as headerSyncDays,
      offline_mode as offlineMode,
      offline_days as offlineDays,
      icon,
      index_in_search as indexInSearch,
      updated_at as updatedAt
    FROM folder_prefs
    ORDER BY account_id ASC, folder_path ASC
  `).all() as RawFolderPrefRow[]
  const result: Record<number, FolderPrefRow[]> = {}
  for (const row of rows) {
    const mapped = mapFolderPrefRow(row)
    if (!result[row.accountId]) result[row.accountId] = []
    result[row.accountId].push(mapped)
  }
  return result
}

const HEADER_SYNC_MODES = new Set<FolderHeaderSyncMode>(['full', 'on_open', 'period', 'off'])
const OFFLINE_MODES = new Set<FolderOfflineMode>(['off', 'period', 'full'])

export type FolderStatRow = { folderPath: string; messageCount: number; unreadCount: number }

/** Aggregated folder statistics for an account from the message cache (excludes snoozed messages) */
export function listFolderStats(accountId: number): FolderStatRow[] {
  return db.prepare(
    `SELECT folder_path AS folderPath, COUNT(*) AS messageCount,
            SUM(CASE WHEN unread=1 THEN 1 ELSE 0 END) AS unreadCount
     FROM messages
     WHERE account_id=?
       AND NOT EXISTS (
         SELECT 1 FROM snoozed s
         WHERE s.account_id = messages.account_id
           AND s.folder = messages.folder_path
           AND s.uid = messages.uid
       )
     GROUP BY folder_path ORDER BY folder_path ASC`
  ).all(accountId) as FolderStatRow[]
}

export function listFolderPrefs(accountId: number): FolderPrefRow[] {
  const rows = db.prepare(`
    SELECT
      account_id as accountId,
      folder_path as folderPath,
      visible,
      include_in_badges as includeInBadges,
      header_sync_mode as headerSyncMode,
      header_sync_days as headerSyncDays,
      offline_mode as offlineMode,
      offline_days as offlineDays,
      icon,
      index_in_search as indexInSearch,
      updated_at as updatedAt
    FROM folder_prefs
    WHERE account_id=?
    ORDER BY folder_path ASC
  `).all(accountId) as RawFolderPrefRow[]
  return rows.map(mapFolderPrefRow)
}

/** Delete folder_prefs entries for folders that no longer exist on the server. */
export function deleteStaleFolderPrefs(accountId: number, stalePaths: string[]): void {
  if (stalePaths.length === 0) return
  const BATCH = 500
  for (let i = 0; i < stalePaths.length; i += BATCH) {
    const chunk = stalePaths.slice(i, i + BATCH)
    const ph = chunk.map(() => '?').join(',')
    db.prepare(`DELETE FROM folder_prefs WHERE account_id=? AND folder_path IN (${ph})`).run(accountId, ...chunk)
    // §2.15-ter (codex iteration 4): drop the cache entries for the deleted
    // paths so a subsequent upsertMessages on the same path re-resolves to
    // the column DEFAULT (true) rather than serving a stale cached value.
    for (const folderPath of chunk) {
      invalidateIndexInSearchCache(accountId, folderPath)
    }
  }
}

export function getFolderPref(accountId: number, folderPath: string): FolderPrefRow | undefined {
  const row = db.prepare(`
    SELECT
      account_id as accountId,
      folder_path as folderPath,
      visible,
      include_in_badges as includeInBadges,
      header_sync_mode as headerSyncMode,
      header_sync_days as headerSyncDays,
      offline_mode as offlineMode,
      offline_days as offlineDays,
      icon,
      index_in_search as indexInSearch,
      updated_at as updatedAt
    FROM folder_prefs
    WHERE account_id=? AND folder_path=?
  `).get(accountId, folderPath) as RawFolderPrefRow | undefined
  return row ? mapFolderPrefRow(row) : undefined
}

export function upsertFolderPref(
  accountId: number,
  folderPathRaw: string,
  patch: Partial<Omit<FolderPrefRow, 'accountId' | 'folderPath' | 'updatedAt'>>,
): FolderPrefRow {
  const folderPath = (folderPathRaw || '').trim()
  if (!folderPath) throw new Error('folderPath is required')

  const prev = getFolderPref(accountId, folderPath)
  let headerSyncMode = (patch.headerSyncMode ?? prev?.headerSyncMode ?? 'on_open') as FolderHeaderSyncMode
  let offlineMode = (patch.offlineMode ?? prev?.offlineMode ?? 'off') as FolderOfflineMode
  if (!HEADER_SYNC_MODES.has(headerSyncMode)) throw new Error(`Invalid headerSyncMode: ${headerSyncMode}`)
  if (!OFFLINE_MODES.has(offlineMode)) throw new Error(`Invalid offlineMode: ${offlineMode}`)

  const visible = patch.visible ?? prev?.visible ?? true
  let includeInBadges = patch.includeInBadges ?? prev?.includeInBadges ?? false
  // §2.15-ter: per-folder INDEX gate. Default true; explicit false from
  // caller (or persisted previous false) propagates through.
  const indexInSearch = patch.indexInSearch ?? prev?.indexInSearch ?? true
  let headerSyncDays = typeof patch.headerSyncDays === 'number'
    ? Math.max(1, Math.floor(patch.headerSyncDays))
    : patch.headerSyncDays === null
      ? undefined
      : prev?.headerSyncDays
  let offlineDays = typeof patch.offlineDays === 'number'
    ? Math.max(1, Math.floor(patch.offlineDays))
    : patch.offlineDays === null
      ? undefined
      : prev?.offlineDays

  // Hidden folder is completely excluded from sync/offline/badges.
  if (!visible) {
    includeInBadges = false
    headerSyncMode = 'off'
    headerSyncDays = undefined
    offlineMode = 'off'
    offlineDays = undefined
  } else {
    // Visible folder must sync headers at least on open.
    if (headerSyncMode === 'off') {
      headerSyncMode = folderPath.toUpperCase() === 'INBOX' ? 'full' : 'on_open'
    }
    if (offlineMode === 'off') offlineDays = undefined
  }

  const iconRaw = patch.icon ?? prev?.icon
  const icon = typeof iconRaw === 'string' ? iconRaw.trim().slice(0, 8) : undefined

  // §2.15-ter (codex iteration 5 HIGH 1): detect a toggle of index_in_search
  // so we can reconcile messages_fts in the same transaction as the upsert.
  // Without this, toggling "Exclude from search" on an already-indexed
  // folder (Spam/Junk/Trash that started as indexed) leaves stale rows in
  // FTS5 and search keeps returning them. Conversely, toggling back to
  // included does not backfill rows that were inserted while excluded.
  //
  // Previous default for `prev` is `true` (mirrors column DEFAULT 1) when
  // no folder_prefs row exists yet, so a brand-new pref where the caller
  // does not pass indexInSearch is a no-op (true → true).
  const prevIndex = prev?.indexInSearch ?? true
  const indexChanged = prevIndex !== indexInSearch

  // Wrap the upsert + FTS reconciliation in a single transaction so a
  // crash mid-flight cannot leave folder_prefs out of sync with FTS.
  // The reconciliation MUST run AFTER the upsert so getIndexInSearchCached
  // (used elsewhere) sees the new value once the cache is invalidated; it
  // is otherwise free to read pre- or post-upsert state because we drive
  // the reconcile via `indexChanged` + `indexInSearch` (the new value).
  db.transaction(() => {
    db.prepare(`
      INSERT INTO folder_prefs(
        account_id, folder_path,
        visible, include_in_badges,
        header_sync_mode, header_sync_days,
        offline_mode, offline_days,
        icon, index_in_search, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(account_id, folder_path) DO UPDATE SET
        visible=excluded.visible,
        include_in_badges=excluded.include_in_badges,
        header_sync_mode=excluded.header_sync_mode,
        header_sync_days=excluded.header_sync_days,
        offline_mode=excluded.offline_mode,
        offline_days=excluded.offline_days,
        icon=excluded.icon,
        index_in_search=excluded.index_in_search,
        updated_at=excluded.updated_at
    `).run(
      accountId,
      folderPath,
      visible ? 1 : 0,
      includeInBadges ? 1 : 0,
      headerSyncMode,
      typeof headerSyncDays === 'number' ? headerSyncDays : null,
      offlineMode,
      typeof offlineDays === 'number' ? offlineDays : null,
      icon || null,
      indexInSearch ? 1 : 0,
    )

    // FTS reconciliation on toggle. Only runs when FTS5 is enabled and the
    // user actually flipped the column. Both branches operate on the full
    // set of message rows for this (account, folder) pair.
    if (ftsEnabled && indexChanged) {
      if (!indexInSearch) {
        // true → false: purge existing FTS rows for this folder. The rows
        // stay in `messages` (the user can still see them in the list view),
        // but stop being searchable. We use the FTS5 'delete' command which
        // reads the content snapshot from `messages` (external content
        // table), so we don't need to re-derive the projected columns.
        // Using the rowid + content snapshot pattern matches the AFTER
        // DELETE trigger / upsertMessages 'delete' that lives elsewhere.
        const ftsDeleteStmt = db.prepare(
          `INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
           VALUES('delete', ?, ?, ?, ?, ?, ?, ?)`
        )
        const rows = db.prepare(
          `SELECT id, subject, from_addr, from_name, to_addr, body_text, attachment_filenames
           FROM messages WHERE account_id=? AND folder_path=?`
        ).all(accountId, folderPath) as Array<{
          id: number
          subject: string | null
          from_addr: string | null
          from_name: string | null
          to_addr: string | null
          body_text: string | null
          attachment_filenames: string | null
        }>
        for (const r of rows) {
          ftsDeleteStmt.run(
            r.id,
            r.subject ?? '',
            r.from_addr ?? '',
            r.from_name ?? '',
            r.to_addr ?? '',
            r.body_text ?? '',
            r.attachment_filenames ?? '',
          )
        }
      } else {
        // false → true: backfill FTS rows for messages that exist in this
        // folder but are not in messages_fts. We MUST NOT call FTS5
        // 'delete' as a precaution: while it is intuitively idempotent,
        // calling 'delete' on a rowid that is NOT in FTS corrupts FTS5
        // shadow tables ("database disk image is malformed") — the same
        // class of bug that drives the entire OLD-VALUES rebalance dance
        // elsewhere in this file.
        //
        // The contract before the toggle: every row for an excluded
        // folder is NOT in messages_fts (upsertMessages pre/post-deletes
        // them, plus path 6 SCHEMA REBUILD also strips them). So a plain
        // INSERT is sufficient and won't create duplicates. If a defect
        // ever leaves stragglers in FTS, the next 'delete'-balanced
        // mutation (true→false toggle, deleteMessages, upsertMessages
        // conflict, FTS rebuild) will reconcile.
        const ftsInsertStmt = db.prepare(
          `INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        const rows = db.prepare(
          `SELECT id, subject, from_addr, from_name, to_addr, body_text, attachment_filenames
           FROM messages WHERE account_id=? AND folder_path=?`
        ).all(accountId, folderPath) as Array<{
          id: number
          subject: string | null
          from_addr: string | null
          from_name: string | null
          to_addr: string | null
          body_text: string | null
          attachment_filenames: string | null
        }>
        for (const r of rows) {
          ftsInsertStmt.run(
            r.id,
            r.subject ?? '',
            r.from_addr ?? '',
            r.from_name ?? '',
            r.to_addr ?? '',
            r.body_text ?? '',
            r.attachment_filenames ?? '',
          )
        }
      }
    }
  })()

  // §2.15-ter: invalidate the in-memory index gate cache so the next
  // upsertMessages call observes the new value without restart.
  invalidateIndexInSearchCache(accountId, folderPath)

  return getFolderPref(accountId, folderPath)!
}

export function removeFolderPref(accountId: number, folderPathRaw: string): boolean {
  const folderPath = (folderPathRaw || '').trim()
  if (!folderPath) return false
  const res = db.prepare(`DELETE FROM folder_prefs WHERE account_id=? AND folder_path=?`).run(accountId, folderPath)
  // §2.15-ter (codex iteration 4): invalidate the in-memory cache. Without
  // this a cached `false` would stick around after the row is gone and
  // upsertMessages would keep skipping FTS even though the column DEFAULT
  // is `1` (indexed). Mirrors the pattern in upsertFolderPref.
  invalidateIndexInSearchCache(accountId, folderPath)
  return res.changes > 0
}

export function deleteAccountData(accountId: number) {
  const id = Math.floor(Number(accountId))
  if (!Number.isFinite(id) || id <= 0) return
  // Atomic deletion of all account data in a single transaction.
  // FTS5 is synced via triggers, deleting rows from messages will cascade to messages_fts.
  db.transaction(() => {
    // §2.15-ter: rebalance FTS for any rows in indexInSearch=false folders
    // for this account before the AFTER DELETE trigger fires. See
    // architectural invariant block near `prepareFtsDeleteRebalance`.
    rebalanceFtsForBulkDelete(
      `m.account_id=?`,
      [id],
    )
    db.prepare(`DELETE FROM messages WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM folders WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM send_queue WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM snoozed WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM follow_ups WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM read_later WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM tls_pins WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM folder_prefs WHERE account_id=?`).run(id)
    // §2.15-ter (codex iteration 4): drop cached indexInSearch values for
    // this account; otherwise stale `false` entries would survive an
    // account deletion + reinstall and break FTS for the new account
    // before its first folder_prefs row is written.
    invalidateIndexInSearchCacheForAccount(id)
    db.prepare(`DELETE FROM cached_roles WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM cached_mailboxes WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM offline_ops WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM sync_state WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM folder_crawl_state WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM rule_log WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM mail_rules WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM ai_rule_log WHERE account_id=?`).run(id)
    db.prepare(`DELETE FROM ai_rules WHERE account_id=?`).run(id)
    // §3.3 B2 Thread AI Summary cache. `ai_summaries.account_id` is TEXT (it
    // stores the caller-supplied string account id), so bind the STRING form
    // explicitly rather than relying on SQLite's TEXT-affinity coercion of the
    // integer `id`. Summaries are derived from email content — leaving them
    // behind would let derived thread text survive account removal.
    db.prepare(`DELETE FROM ai_summaries WHERE account_id=?`).run(String(id))
  })()
}

export function getAccountMessageCount(accountId: number, folder?: string): number {
  if (folder) {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE account_id=? AND folder_path=?`).get(accountId, folder) as { cnt?: number } | undefined
    return row?.cnt ?? 0
  }
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE account_id=?`).get(accountId) as { cnt?: number } | undefined
  return row?.cnt ?? 0
}

/** Get all cached UIDs for a folder (for expunge reconciliation) */
export function getFolderUids(accountId: number, folder: string): number[] {
  const rows = db.prepare(
    `SELECT uid FROM messages WHERE account_id=? AND folder_path=? ORDER BY uid`
  ).all(accountId, folder) as Array<{ uid: number }>
  return rows.map(r => r.uid)
}

/**
 * Get current local flags (unread, flagged) for every cached message in a folder.
 * Used by FLAGS sync to compute the diff against server state and avoid
 * rewriting ~all rows on every periodic sync.
 */
export function getFolderFlags(
  accountId: number,
  folder: string,
): Map<number, { unread: boolean; flagged: boolean }> {
  const rows = db.prepare(
    `SELECT uid, unread, flagged FROM messages WHERE account_id=? AND folder_path=?`,
  ).all(accountId, folder) as Array<{ uid: number; unread: number; flagged: number }>
  const out = new Map<number, { unread: boolean; flagged: boolean }>()
  for (const r of rows) out.set(r.uid, { unread: r.unread === 1, flagged: r.flagged === 1 })
  return out
}

/** Remove specific stale messages by UIDs (expunge reconciliation).
 *  Batches to stay within SQLite bind parameter limit (999). */
export function removeStaleMessagesByUids(accountId: number, folder: string, uids: number[]): void {
  if (uids.length === 0) return
  const BATCH = 500
  // §2.15-ter: pre-insert OLD VALUES into FTS for rows in
  // indexInSearch=false folders so the AFTER DELETE trigger can balance.
  // See architectural invariant block near `prepareFtsDeleteRebalance`.
  const rebalance = prepareFtsDeleteRebalance()
  for (let i = 0; i < uids.length; i += BATCH) {
    const chunk = uids.slice(i, i + BATCH)
    const placeholders = chunk.map(() => '?').join(',')
    // Single transaction per chunk so the FTS pre-insert and DELETE are
    // atomic — a crash mid-chunk cannot leave shadow tables half-rebalanced.
    db.transaction(() => {
      rebalance(chunk.map((uid) => ({ accountId, folder, uid })))
      db.prepare(
        `DELETE FROM messages WHERE account_id=? AND folder_path=? AND uid IN (${placeholders})`
      ).run(accountId, folder, ...chunk)
    })()
  }
}

// --- Search completeness ---

export type SearchIndexStats = {
  totalMessages: number
  /** Messages where body_text has been processed (NOT NULL — includes empty bodies). */
  bodyIndexed: number
  /** Messages where attachment_filenames have been extracted (NOT NULL). */
  filenamesIndexed: number
}

/**
 * Returns index completeness stats for given accounts (all folders).
 *
 * §2.15-ter (codex iteration 4): excluded folders are filtered out. The
 * stats power the `app.statusbar.bodyIndex` label which represents
 * body-indexing coverage for searchable folders. Excluded folders
 * (Junk/Spam/Trash) intentionally don't participate in body indexing or
 * FTS, so counting them would falsely inflate the denominator and never
 * reach 100% — resulting in a perpetually-visible "indexing X%" message.
 */
export function getSearchIndexStats(accountIds: number[]): SearchIndexStats {
  if (accountIds.length === 0) return { totalMessages: 0, bodyIndexed: 0, filenamesIndexed: 0 }
  const ph = accountIds.map(() => '?').join(',')
  const row = db.prepare(`SELECT
    COUNT(*) as total,
    SUM(CASE WHEN m.body_text IS NOT NULL THEN 1 ELSE 0 END) as body_indexed,
    SUM(CASE WHEN m.attachment_filenames IS NOT NULL THEN 1 ELSE 0 END) as filenames_indexed
  FROM messages m
  WHERE m.account_id IN (${ph})
    AND NOT EXISTS (SELECT 1 FROM folder_prefs fp WHERE fp.account_id=m.account_id AND fp.folder_path=m.folder_path AND fp.index_in_search=0)`).get(...accountIds) as { total: number; body_indexed: number; filenames_indexed: number } | undefined
  return {
    totalMessages: row?.total ?? 0,
    bodyIndexed: row?.body_indexed ?? 0,
    filenamesIndexed: row?.filenames_indexed ?? 0,
  }
}

// --- Folder crawl state (Search Excellence Hardening) ---

export type CrawlStatus = 'not_started' | 'crawling' | 'covered_recent' | 'covered_full' | 'error'

export type FolderCrawlState = {
  accountId: number
  folderPath: string
  status: CrawlStatus
  /** UID watermark — crawl has covered UIDs from this value and above. */
  watermarkUid: number | null
  /** IMAP EXISTS count at the time of last crawl. */
  totalExists: number | null
  /** Number of messages already crawled into local cache. */
  crawledCount: number
  /** IMAP CONDSTORE HIGHESTMODSEQ for incremental flag/change sync. */
  highestModseq: string | null
  lastAttemptAt: string | null
  completedAt: string | null
  error: string | null
}

type RawCrawlRow = {
  account_id: number
  folder_path: string
  status: string
  watermark_uid: number | null
  total_exists: number | null
  crawled_count: number | null
  highest_modseq: string | null
  last_attempt_at: string | null
  completed_at: string | null
  error: string | null
}

function mapCrawlRow(r: RawCrawlRow): FolderCrawlState {
  return {
    accountId: r.account_id,
    folderPath: r.folder_path,
    status: (['not_started', 'crawling', 'covered_recent', 'covered_full', 'error'] as const).includes(r.status as CrawlStatus) ? r.status as CrawlStatus : 'not_started',
    watermarkUid: r.watermark_uid,
    totalExists: r.total_exists,
    crawledCount: r.crawled_count ?? 0,
    highestModseq: (r as Record<string, unknown>).highest_modseq as string | null ?? null,
    lastAttemptAt: r.last_attempt_at,
    completedAt: r.completed_at,
    error: r.error,
  }
}

/** Get crawl state for all folders of given accounts. */
export function listFolderCrawlStates(accountIds: number[]): FolderCrawlState[] {
  if (accountIds.length === 0) return []
  const ph = accountIds.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT * FROM folder_crawl_state WHERE account_id IN (${ph}) ORDER BY account_id, folder_path`
  ).all(...accountIds) as RawCrawlRow[]
  return rows.map(mapCrawlRow)
}

/** Get crawl state for a specific folder. */
export function getFolderCrawlState(accountId: number, folder: string): FolderCrawlState | undefined {
  const row = db.prepare(
    `SELECT * FROM folder_crawl_state WHERE account_id=? AND folder_path=?`
  ).get(accountId, folder) as RawCrawlRow | undefined
  return row ? mapCrawlRow(row) : undefined
}

/** Upsert crawl state for a folder (fully atomic — no pre-read).
 *  Uses a sentinel value to distinguish "not provided" from "explicitly set to null".
 *  On INSERT: defaults applied in SQL. On UPDATE: CASE expressions keep existing value
 *  for non-provided fields, preventing lost-update races between concurrent writers. */
const CRAWL_SENTINEL = '__CRAWL_NOT_SET__'
export function upsertFolderCrawlState(
  accountId: number,
  folder: string,
  update: Partial<Omit<FolderCrawlState, 'accountId' | 'folderPath'>>,
): void {
  db.prepare(`INSERT INTO folder_crawl_state(account_id, folder_path, status, watermark_uid, total_exists, crawled_count, highest_modseq, last_attempt_at, completed_at, error)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, folder_path) DO UPDATE SET
      status      = CASE WHEN ?  = '${CRAWL_SENTINEL}' THEN status      ELSE ?  END,
      watermark_uid = CASE WHEN ? = '${CRAWL_SENTINEL}' THEN watermark_uid ELSE ? END,
      total_exists  = CASE WHEN ? = '${CRAWL_SENTINEL}' THEN total_exists  ELSE ? END,
      crawled_count = CASE WHEN ? = '${CRAWL_SENTINEL}' THEN crawled_count ELSE ? END,
      highest_modseq= CASE WHEN ? = '${CRAWL_SENTINEL}' THEN highest_modseq ELSE ? END,
      last_attempt_at=CASE WHEN ? = '${CRAWL_SENTINEL}' THEN last_attempt_at ELSE ? END,
      completed_at  = CASE WHEN ? = '${CRAWL_SENTINEL}' THEN completed_at  ELSE ? END,
      error         = CASE WHEN ? = '${CRAWL_SENTINEL}' THEN error         ELSE ? END`).run(
    // INSERT values (defaults for new row)
    accountId, folder,
    update.status ?? 'not_started',
    update.watermarkUid ?? null,
    update.totalExists ?? null,
    update.crawledCount ?? 0,
    update.highestModseq ?? null,
    update.lastAttemptAt ?? null,
    update.completedAt ?? null,
    update.error ?? null,
    // UPDATE CASE pairs: sentinel check + actual value
    update.status !== undefined ? update.status : CRAWL_SENTINEL, update.status ?? null,
    update.watermarkUid !== undefined ? String(update.watermarkUid ?? '') : CRAWL_SENTINEL, update.watermarkUid ?? null,
    update.totalExists !== undefined ? String(update.totalExists ?? '') : CRAWL_SENTINEL, update.totalExists ?? null,
    update.crawledCount !== undefined ? String(update.crawledCount ?? 0) : CRAWL_SENTINEL, update.crawledCount ?? 0,
    update.highestModseq !== undefined ? (update.highestModseq ?? CRAWL_SENTINEL) : CRAWL_SENTINEL, update.highestModseq ?? null,
    update.lastAttemptAt !== undefined ? (update.lastAttemptAt ?? CRAWL_SENTINEL) : CRAWL_SENTINEL, update.lastAttemptAt ?? null,
    update.completedAt !== undefined ? (update.completedAt ?? CRAWL_SENTINEL) : CRAWL_SENTINEL, update.completedAt ?? null,
    update.error !== undefined ? (update.error ?? CRAWL_SENTINEL) : CRAWL_SENTINEL, update.error ?? null,
  )
}

/**
 * Atomic wrapper: apply a `messages` batch upsert AND a `folder_crawl_state`
 * update inside the same transaction. Either both commit or neither does.
 *
 * Addresses the 2026-04-21 data-loss regression: previously the `onBatch`
 * callback upserted messages, and a separate code path updated
 * `folder_crawl_state` after the whole fetch completed. A crash or forced
 * quit between the two could leave `folder_crawl_state.status='covered_full'`
 * while the matching rows never made it to disk — next launch trusted the
 * state and skipped the re-fetch.
 *
 * The transaction uses better-sqlite3's `db.transaction(...)` which maps to
 * `BEGIN DEFERRED ... COMMIT` with automatic SAVEPOINT nesting. For our use
 * this is the same as `BEGIN IMMEDIATE` in practice because the first write
 * upgrades the lock anyway, and `synchronous=NORMAL` + WAL mode ensures the
 * group commit is durable once COMMIT returns.
 *
 * Intentionally synchronous — better-sqlite3 transactions cannot span async
 * boundaries. Callers must pre-assemble the batch before calling.
 */
export function applyFolderSyncBatch(
  accountId: number,
  folder: string,
  messages: Parameters<typeof upsertMessages>[2],
  crawlStateUpdate: Partial<Omit<FolderCrawlState, 'accountId' | 'folderPath'>> | null,
): void {
  const trx = db.transaction(() => {
    if (messages.length > 0) upsertMessages(accountId, folder, messages)
    if (crawlStateUpdate) upsertFolderCrawlState(accountId, folder, crawlStateUpdate)
  })
  trx()
}

/**
 * Run `PRAGMA wal_checkpoint(TRUNCATE)` and report bytes reclaimed.
 *
 * Called from electron/main.ts on `before-quit` so committed-but-not-yet-
 * checkpointed pages in `.db-wal` are folded into the main file before the
 * process exits. Without this, a 72MB WAL can accumulate overnight; if the
 * WAL is then lost to OS-level cleanup or external interference between
 * sessions, those committed transactions vanish silently.
 *
 * Returns structural info for logging — caller logs size before/after. Never
 * throws: a checkpoint failure is observable (busy!=0 or bytes unchanged) but
 * MUST NOT block shutdown. Telemetry/log the degradation and continue.
 */
export function checkpointWal(): {
  beforeBytes: number
  afterBytes: number
  busy: number
  checkpointedFrames: number
  totalFrames: number
  ok: boolean
} {
  const walPath = `${db.name}-wal`
  const sizeOf = (p: string): number => {
    try { return fs.statSync(p).size } catch { return 0 }
  }
  const beforeBytes = sizeOf(walPath)
  let busy = 0
  let totalFrames = 0
  let checkpointedFrames = 0
  let ok = true
  try {
    // wal_checkpoint(TRUNCATE) returns a single row: (busy, log, checkpointed).
    //   busy: 0 on success, 1 if another connection held a read/write lock.
    //   log: total frames in WAL before checkpoint.
    //   checkpointed: frames checkpointed (== log means full checkpoint).
    const row = db.pragma('wal_checkpoint(TRUNCATE)', { simple: false }) as
      | Array<{ busy: number; log: number; checkpointed: number }>
      | undefined
    const r = Array.isArray(row) ? row[0] : undefined
    if (r) {
      busy = typeof r.busy === 'number' ? r.busy : 0
      totalFrames = typeof r.log === 'number' ? r.log : 0
      checkpointedFrames = typeof r.checkpointed === 'number' ? r.checkpointed : 0
    }
  } catch {
    ok = false
  }
  const afterBytes = sizeOf(walPath)
  return { beforeBytes, afterBytes, busy, checkpointedFrames, totalFrames, ok }
}

/**
 * Run `PRAGMA wal_checkpoint(PASSIVE)` for periodic in-session WAL drain.
 *
 * §2.15-bis: SQLite WAL accumulates committed transactions until a checkpoint
 * folds them into the main DB file. The shutdown handler runs `wal_checkpoint(
 * TRUNCATE)`, but if Electron exits abruptly (SIGKILL, OS crash, power loss,
 * `kill -9`, OOM kill) `before-quit` never fires and the WAL grows unbounded —
 * any committed but un-checkpointed pages are at risk if the WAL is later lost
 * to OS/AV/external interference.
 *
 * PASSIVE mode is the only checkpoint that is safe to run on a periodic timer
 * while the app is live: it does NOT acquire a writer lock, does NOT block
 * readers, and silently skips frames held by active read snapshots. FULL and
 * TRUNCATE both block readers — unacceptable on a 60s interval that ticks
 * during user-driven IMAP sync / search.
 *
 * Returns `{ busy, log, checkpointed }` from the pragma row. Never throws — a
 * failure here is a no-op (next tick will retry); the shutdown TRUNCATE is the
 * authoritative guarantee. Callers may log `busy > 0` as a soft signal that a
 * read transaction was active, but should NOT treat it as an error.
 */
export function checkpointWalPassive(): {
  busy: number
  log: number
  checkpointed: number
} {
  let busy = 0
  let log = 0
  let checkpointed = 0
  try {
    const row = db.pragma('wal_checkpoint(PASSIVE)', { simple: false }) as
      | Array<{ busy: number; log: number; checkpointed: number }>
      | undefined
    const r = Array.isArray(row) ? row[0] : undefined
    if (r) {
      busy = typeof r.busy === 'number' ? r.busy : 0
      log = typeof r.log === 'number' ? r.log : 0
      checkpointed = typeof r.checkpointed === 'number' ? r.checkpointed : 0
    }
  } catch {
    // Swallow: a periodic checkpoint failure is non-fatal — the shutdown
    // TRUNCATE checkpoint and SQLite's auto-replay on next open are the
    // authoritative guarantees. Caller logs at debug if it cares.
    //
    // No log here by design: `packages/db` is intentionally logger-free
    // (see header note above; same reason metricsBuckets.ts has no Sentry/
    // electron-log dep). Coupling the DB layer to electron-log would pull
    // an Electron-only dependency into a package that other entry points
    // (e2e harnesses, future workers) import in plain Node. Observability
    // is the caller's responsibility — checkpointWal()'s call site in
    // electron/main.ts logs the result, and the periodic caller logs
    // `busy > 0 || checkpointed < log` at debug. Codex §2.15-bis review
    // iteration 2 Low #2.
  }
  return { busy, log, checkpointed }
}

/** Delete crawl state for an account (used when account is removed). */
export function deleteFolderCrawlStates(accountId: number): void {
  db.prepare(`DELETE FROM folder_crawl_state WHERE account_id=?`).run(accountId)
}

/** Delete crawl state for specific folders (stale folder cleanup). */
export function deleteFolderCrawlStatesByPaths(accountId: number, paths: string[]): void {
  if (paths.length === 0) return
  const BATCH = 500
  for (let i = 0; i < paths.length; i += BATCH) {
    const chunk = paths.slice(i, i + BATCH)
    const ph = chunk.map(() => '?').join(',')
    db.prepare(`DELETE FROM folder_crawl_state WHERE account_id=? AND folder_path IN (${ph})`).run(accountId, ...chunk)
  }
}

// --- Search coverage (Search Excellence Hardening) ---

export type SearchCoverageStats = {
  /** Total messages in local cache for the given scope. */
  totalMessages: number
  /** Messages with body_text indexed (NOT NULL). */
  bodyIndexed: number
  /** Messages with attachment_filenames extracted (NOT NULL). */
  filenamesIndexed: number
  /** Folder crawl coverage breakdown. */
  folderCoverage: {
    total: number
    coveredFull: number
    coveredRecent: number
    crawling: number
    notStarted: number
    error: number
  }
}

/** Returns comprehensive search coverage stats for given accounts.
 * Denominator = indexable folders only (headerSyncMode != 'off').
 * Uses cached_mailboxes intersected with folder_prefs to determine the
 * indexable folder set.  Folders with headerSyncMode='off' are excluded
 * so the indicator reflects the user's configured sync policy. */
export function getSearchCoverageStats(accountIds: number[]): SearchCoverageStats {
  const indexStats = getSearchIndexStats(accountIds)
  const crawlStates = listFolderCrawlStates(accountIds)

  // Build set of indexable folder paths (headerSyncMode != 'off').
  // A folder is indexable if it has a pref with mode != 'off',
  // OR it has no pref row (new folder — defaults determined by role, but we
  // count it as indexable since typical roles default to 'full').
  const indexablePaths = new Set<string>()
  for (const aid of accountIds) {
    const prefs = listFolderPrefs(aid)
    const prefsByPath = new Map(prefs.map(p => [p.folderPath, p]))

    const mbRow = db.prepare(`SELECT mailboxes_json FROM cached_mailboxes WHERE account_id=?`).get(aid) as { mailboxes_json: string } | undefined
    if (mbRow) {
      try {
        const boxes = JSON.parse(mbRow.mailboxes_json) as Array<{ path?: string }>
        for (const box of boxes) {
          const p = box.path
          if (!p) continue
          const pref = prefsByPath.get(p)
          // Include if no pref (defaults apply — typical roles get 'full') or mode != 'off'
          if (!pref || pref.headerSyncMode !== 'off') {
            indexablePaths.add(`${aid}:${p}`)
          }
        }
      } catch { /* ignore */ }
    } else {
      // No cached mailboxes yet — count crawl states as fallback
      for (const s of crawlStates) {
        if (s.accountId === aid) indexablePaths.add(`${aid}:${s.folderPath}`)
      }
    }
  }

  const totalFolders = indexablePaths.size

  const folderCoverage = {
    total: totalFolders,
    coveredFull: 0,
    coveredRecent: 0,
    crawling: 0,
    notStarted: 0,
    error: 0,
  }
  for (const s of crawlStates) {
    // Only count crawl states for indexable folders
    if (!indexablePaths.has(`${s.accountId}:${s.folderPath}`)) continue
    switch (s.status) {
      case 'covered_full': folderCoverage.coveredFull++; break
      case 'covered_recent': folderCoverage.coveredRecent++; break
      case 'crawling': folderCoverage.crawling++; break
      case 'error': folderCoverage.error++; break
      default: folderCoverage.notStarted++; break
    }
  }
  // Indexable folders without a crawl_state row are implicitly not_started.
  const trackedFolders = folderCoverage.coveredFull + folderCoverage.coveredRecent + folderCoverage.crawling + folderCoverage.notStarted + folderCoverage.error
  if (totalFolders > trackedFolders) {
    folderCoverage.notStarted += (totalFolders - trackedFolders)
  }
  return {
    ...indexStats,
    folderCoverage,
  }
}

/** Returns UIDs where body_text has not been indexed yet (NULL = not attempted). */
export function getUidsWithoutBodyText(accountId: number, folder: string, limit = 100): number[] {
  const rows = db.prepare(
    `SELECT uid FROM messages WHERE account_id=? AND folder_path=? AND body_text IS NULL ORDER BY uid DESC LIMIT ?`
  ).all(accountId, folder, limit) as Array<{ uid: number }>
  return rows.map(r => r.uid)
}

/**
 * Returns distinct (account_id, folder_path) pairs eligible for body
 * indexing: folders WITHOUT an explicit `folder_prefs.index_in_search=0`
 * row. Folders with no `folder_prefs` row default to indexed (column
 * DEFAULT 1) and are included.
 *
 * §2.15-ter (codex iteration 5 MEDIUM): the body indexer used to enumerate
 * every folder in `messages` and download bodies for excluded folders
 * (Spam/Junk/Trash) too — wasted bandwidth and disk for content that the
 * user explicitly opted out of search. Excluded folders are filtered out
 * here so callers see a consistent "search-eligible" view.
 *
 * The function is named `listIndexedFolders` because its sole consumer is
 * the body indexer (`electron/services/bodyIndexer.ts`) — the name
 * describes intent, not raw distinct folders. Use a direct query against
 * `messages` if you need the raw list.
 */
export function listIndexedFolders(): Array<{ accountId: number; folder: string; count: number }> {
  const rows = db.prepare(
    `SELECT
       m.account_id as accountId,
       m.folder_path as folder,
       COUNT(*) as count
     FROM messages m
     LEFT JOIN folder_prefs fp
       ON fp.account_id = m.account_id AND fp.folder_path = m.folder_path
     WHERE COALESCE(fp.index_in_search, 1) = 1
     GROUP BY m.account_id, m.folder_path`
  ).all() as Array<{ accountId: number; folder: string; count: number }>
  return rows
}

/**
 * Batch update attachment_filenames for existing messages.
 *
 * §2.15-ter (codex iteration 4): attachment_filenames is one of the
 * FTS-projected columns (subject, from_addr, from_name, to_addr,
 * body_text, attachment_filenames), so an UPDATE here fires the
 * AFTER UPDATE OF messages_au trigger. For folders with
 * indexInSearch=false the row is NOT in messages_fts (upsertMessages
 * removed it via 'delete'), so the trigger's `delete OLD VALUES` would
 * corrupt FTS5 ("database disk image is malformed"). Same fix shape as
 * updateMessageBodyText: pre-insert OLD VALUES inside a transaction,
 * UPDATE, then post-delete NEW VALUES so the row leaves FTS again.
 */
export function updateAttachmentFilenames(accountId: number, folder: string, uid: number, filenames: string | null) {
  const skipFts = ftsEnabled && !getIndexInSearchCached(accountId, folder)

  if (!skipFts) {
    db.prepare(
      `UPDATE messages SET attachment_filenames=? WHERE account_id=? AND folder_path=? AND uid=?`
    ).run(filenames, accountId, folder, uid)
    return
  }

  type MsgRow = {
    id: number
    subject: string | null
    from_addr: string | null
    from_name: string | null
    to_addr: string | null
    body_text: string | null
    attachment_filenames: string | null
  }
  const selectRow = db.prepare(
    `SELECT id, subject, from_addr, from_name, to_addr, body_text, attachment_filenames
     FROM messages WHERE account_id=? AND folder_path=? AND uid=?`
  )
  const ftsInsertStmt = db.prepare(
    `INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const ftsDeleteStmt = db.prepare(
    `INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
     VALUES('delete', ?, ?, ?, ?, ?, ?, ?)`
  )
  const updateStmt = db.prepare(
    `UPDATE messages SET attachment_filenames=? WHERE account_id=? AND folder_path=? AND uid=?`
  )

  db.transaction(() => {
    const oldRow = selectRow.get(accountId, folder, uid) as MsgRow | undefined
    if (!oldRow) {
      // Row not present — nothing to update, no rebalance needed.
      return
    }
    // Step 1: pre-insert OLD VALUES so the trigger's 'delete' balances.
    ftsInsertStmt.run(
      oldRow.id,
      oldRow.subject ?? '',
      oldRow.from_addr ?? '',
      oldRow.from_name ?? '',
      oldRow.to_addr ?? '',
      oldRow.body_text ?? '',
      oldRow.attachment_filenames ?? '',
    )
    // Step 2: UPDATE — trigger fires `delete OLD + insert NEW`. Both
    // operations are now balanced (OLD is in FTS, NEW just got pushed).
    updateStmt.run(filenames, accountId, folder, uid)
    // Step 3: post-delete NEW VALUES so the row leaves FTS again.
    const newRow = selectRow.get(accountId, folder, uid) as MsgRow | undefined
    if (newRow) {
      ftsDeleteStmt.run(
        newRow.id,
        newRow.subject ?? '',
        newRow.from_addr ?? '',
        newRow.from_name ?? '',
        newRow.to_addr ?? '',
        newRow.body_text ?? '',
        newRow.attachment_filenames ?? '',
      )
    }
  })()
}

// --- Offline storage ---

/** Marks whether a message body has been downloaded to disk */
export function setBodyDownloaded(accountId: number, folder: string, uid: number, downloaded: boolean, messageSize?: number) {
  db.prepare(
    `UPDATE messages SET body_downloaded=?, message_size=COALESCE(?, message_size) WHERE account_id=? AND folder_path=? AND uid=?`
  ).run(downloaded ? 1 : 0, messageSize ?? null, accountId, folder, uid)
}

/** Returns true if the message already has body_text indexed (not NULL). */
export function hasBodyTextIndexed(accountId: number, folder: string, uid: number): boolean {
  const row = db.prepare(
    `SELECT 1 FROM messages WHERE account_id=? AND folder_path=? AND uid=? AND body_text IS NOT NULL`
  ).get(accountId, folder, uid) as unknown
  return !!row
}

/** Returns cached MessageDetails JSON, or null if not cached. */
export function getCachedDetail(accountId: number, folder: string, uid: number): string | null {
  const row = db.prepare(
    `SELECT cached_detail FROM messages WHERE account_id=? AND folder_path=? AND uid=? AND cached_detail IS NOT NULL`
  ).get(accountId, folder, uid) as { cached_detail: string } | undefined
  return row?.cached_detail ?? null
}

/** Stores serialized MessageDetails JSON for instant re-opens. */
export function setCachedDetail(accountId: number, folder: string, uid: number, json: string): void {
  db.prepare(
    `UPDATE messages SET cached_detail=? WHERE account_id=? AND folder_path=? AND uid=?`
  ).run(json, accountId, folder, uid)
}

/** Updates the cached plain-text message body (for the body: search operator). */
export function updateMessageBodyText(accountId: number, folder: string, uid: number, bodyText: string | null | undefined) {
  const normalized = typeof bodyText === 'string'
    ? bodyText.split('\0').join('').slice(0, 200_000)
    : null

  // §2.15-ter (production data corruption fix): for folders excluded from
  // search, upsertMessages already removed the row from messages_fts via the
  // 'delete' command. The AFTER UPDATE trigger fires unconditionally on every
  // messages UPDATE and emits two operations:
  //   1. INSERT INTO messages_fts(messages_fts, rowid, ...) VALUES ('delete', old.id, OLD VALUES)
  //   2. INSERT INTO messages_fts(rowid, ...) VALUES (new.id, NEW VALUES)
  // Operation (1) corrupts the FTS5 shadow tables ("database disk image is
  // malformed") because the rowid is not present in the index — FTS5 in
  // content-table mode subtracts token counts from records that do not exist.
  //
  // Fix: before running the UPDATE, manually re-insert OLD VALUES into
  // messages_fts so the trigger's 'delete' is balanced. After the UPDATE, the
  // trigger has indexed NEW VALUES; we follow up with a final 'delete' on
  // NEW VALUES to leave the row excluded from FTS, mirroring the pattern in
  // upsertMessages. All three steps run in a transaction so a crash mid-flight
  // cannot leave FTS shadow tables half-populated.
  const skipFts = ftsEnabled && !getIndexInSearchCached(accountId, folder)

  if (!skipFts) {
    db.prepare(
      `UPDATE messages SET body_text=? WHERE account_id=? AND folder_path=? AND uid=?`
    ).run(normalized, accountId, folder, uid)
    return
  }

  type MsgRow = {
    id: number
    subject: string | null
    from_addr: string | null
    from_name: string | null
    to_addr: string | null
    body_text: string | null
    attachment_filenames: string | null
  }
  const selectRow = db.prepare(
    `SELECT id, subject, from_addr, from_name, to_addr, body_text, attachment_filenames
     FROM messages WHERE account_id=? AND folder_path=? AND uid=?`
  )
  const ftsInsertStmt = db.prepare(
    `INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const ftsDeleteStmt = db.prepare(
    `INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
     VALUES('delete', ?, ?, ?, ?, ?, ?, ?)`
  )
  const updateStmt = db.prepare(
    `UPDATE messages SET body_text=? WHERE account_id=? AND folder_path=? AND uid=?`
  )

  const trx = db.transaction(() => {
    const oldRow = selectRow.get(accountId, folder, uid) as MsgRow | undefined
    if (!oldRow) {
      // Nothing to update — same no-op semantics as the prior code path.
      return
    }
    // Re-insert OLD VALUES into FTS so the AFTER UPDATE trigger's 'delete'
    // step sees a matching row to subtract.
    ftsInsertStmt.run(
      oldRow.id,
      oldRow.subject ?? '',
      oldRow.from_addr ?? '',
      oldRow.from_name ?? '',
      oldRow.to_addr ?? '',
      oldRow.body_text ?? '',
      oldRow.attachment_filenames ?? '',
    )
    // UPDATE fires the trigger: 'delete' OLD (balanced) + insert NEW.
    updateStmt.run(normalized, accountId, folder, uid)
    // Read NEW VALUES and remove the row from FTS to honor indexInSearch=false.
    const newRow = selectRow.get(accountId, folder, uid) as MsgRow | undefined
    if (!newRow) return
    ftsDeleteStmt.run(
      newRow.id,
      newRow.subject ?? '',
      newRow.from_addr ?? '',
      newRow.from_name ?? '',
      newRow.to_addr ?? '',
      newRow.body_text ?? '',
      newRow.attachment_filenames ?? '',
    )
  })
  trx()
}

/** Returns UIDs of messages whose body has not been downloaded yet (for background sync) */
export function getUidsWithoutBody(accountId: number, folder: string, limit = 50, sinceDateIso?: string, maxSizeBytes?: number): number[] {
  let sql = `SELECT uid FROM messages WHERE account_id=? AND folder_path=? AND body_downloaded=0`
  const params: unknown[] = [accountId, folder]
  if (sinceDateIso) {
    sql += ` AND date >= ?`
    params.push(sinceDateIso)
  }
  if (maxSizeBytes && maxSizeBytes > 0) {
    sql += ` AND (message_size = 0 OR message_size <= ?)`
    params.push(maxSizeBytes)
  }
  sql += ` ORDER BY uid DESC LIMIT ?`
  params.push(limit)
  return (db.prepare(sql).all(...params) as { uid: number }[]).map(r => r.uid)
}

/** Returns UIDs of messages whose body is downloaded and date is older than threshold (for cleanup) */
export function getUidsOlderThan(accountId: number, folder: string, olderThanIso: string): number[] {
  return (db.prepare(
    `SELECT uid FROM messages WHERE account_id=? AND folder_path=? AND body_downloaded=1 AND date < ?`
  ).all(accountId, folder, olderThanIso) as { uid: number }[]).map(r => r.uid)
}

/**
 * §2.15-ter: returns the count and total message_size sum of bodies that
 * would be deleted by a body retention sweep at the given cutoff. Used by
 * `cache:bodyTrimPreview` IPC to drive the Settings shrink-confirmation
 * dialog. Sums `message_size` for downloaded bodies older than the cutoff
 * across folders that match the predicate (offlineMode='full' for global
 * retention, or 'period' for the per-folder retention preview).
 *
 * `mode='full'` matches folders configured for `offlineMode='full'` only —
 * those are the folders affected by changing the global `bodyRetentionDays`
 * setting. Per-folder period retention is intentionally excluded from the
 * preview because it is governed by `offlineDays`, not the global value.
 */
export function previewBodyRetentionImpact(cutoffIso: string): { count: number; totalSize: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(m.message_size), 0) AS totalSize
    FROM messages m
    JOIN folder_prefs fp
      ON fp.account_id = m.account_id
     AND fp.folder_path = m.folder_path
    WHERE m.body_downloaded = 1
      AND m.date < ?
      AND fp.offline_mode = 'full'
  `).get(cutoffIso) as { count: number; totalSize: number } | undefined
  return { count: row?.count ?? 0, totalSize: row?.totalSize ?? 0 }
}

/**
 * Sum of `message_size` for the given UIDs in a single folder. Best-effort
 * accounting for cache.eml_pruned telemetry — `message_size` is populated
 * lazily by the body indexer, so older rows may report 0.
 */
export function sumMessageSizes(accountId: number, folder: string, uids: number[]): number {
  if (uids.length === 0) return 0
  let total = 0
  // Chunk the IN-list to stay well below SQLite's compile-time variable
  // limit (default 32766 in modern builds).
  const BATCH = 500
  for (let i = 0; i < uids.length; i += BATCH) {
    const chunk = uids.slice(i, i + BATCH)
    const ph = chunk.map(() => '?').join(',')
    const row = db.prepare(
      `SELECT COALESCE(SUM(message_size), 0) AS s FROM messages
       WHERE account_id=? AND folder_path=? AND uid IN (${ph})`
    ).get(accountId, folder, ...chunk) as { s: number } | undefined
    total += row?.s ?? 0
  }
  return total
}

/** Downloaded body counters for progress display */
export function countBodiesDownloaded(accountId: number, folder: string): { downloaded: number; total: number } {
  const row = db.prepare(
    `SELECT SUM(CASE WHEN body_downloaded=1 THEN 1 ELSE 0 END) as downloaded, COUNT(*) as total
     FROM messages WHERE account_id=? AND folder_path=?`
  ).get(accountId, folder) as { downloaded: number; total: number } | undefined
  return { downloaded: row?.downloaded ?? 0, total: row?.total ?? 0 }
}

// --- Offline operations queue ---

export type OfflineOp = {
  id: number
  accountId: number
  folder: string
  uid: number
  opType: string
  payload: unknown
  uidValidity: number | null
  createdAt: string
}

export function getOfflineOps(accountId?: number): OfflineOp[] {
  const sql = accountId
    ? `SELECT id, account_id as accountId, folder, uid, op_type as opType, payload, uid_validity as uidValidity, created_at as createdAt FROM offline_ops WHERE account_id=? ORDER BY created_at`
    : `SELECT id, account_id as accountId, folder, uid, op_type as opType, payload, uid_validity as uidValidity, created_at as createdAt FROM offline_ops ORDER BY created_at`
  const rows = (accountId ? db.prepare(sql).all(accountId) : db.prepare(sql).all()) as Array<{
    id: number; accountId: number; folder: string; uid: number; opType: string; payload: string | null; uidValidity: number | null; createdAt: string
  }>
  return rows.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }))
}

export function deleteOfflineOp(id: number) {
  db.prepare(`DELETE FROM offline_ops WHERE id=?`).run(id)
}

/** Insert or update offline op — deduplicates by (account_id, folder, uid, op_type).
 *  Stores uidValidity at queue time for UIDVALIDITY guard during replay.
 *
 *  ON CONFLICT also refreshes uid_validity (Codex post-§2.15 Medium): a re-queue
 *  after a transient failure may carry a newer uidValidity than the previous
 *  row (e.g. folder re-opened, UIDVALIDITY had bumped, local state updated,
 *  now we re-queue under the new value). Keeping the stale value would make
 *  offlineReplay's UIDVALIDITY guard either skip the op or treat it as drift
 *  incorrectly. We use COALESCE(excluded, old) so a caller that passes null
 *  (uidValidity unknown) does not clobber a known value — only explicit new
 *  values overwrite. */
export function upsertOfflineOp(accountId: number, folder: string, uid: number, opType: string, payload?: unknown, uidValidity?: number | null) {
  db.prepare(
    `INSERT INTO offline_ops(account_id, folder, uid, op_type, payload, uid_validity)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, folder, uid, op_type) DO UPDATE SET
       payload = excluded.payload,
       uid_validity = COALESCE(excluded.uid_validity, offline_ops.uid_validity),
       created_at = datetime('now')`
  ).run(accountId, folder, uid, opType, payload ? JSON.stringify(payload) : null, uidValidity ?? null)
}

/** Increment retry count for a batch of offline ops (by id). */
export function incrementOfflineOpRetry(ids: number[]) {
  if (ids.length === 0) return
  const BATCH = 500
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    const ph = chunk.map(() => '?').join(',')
    db.prepare(`UPDATE offline_ops SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id IN (${ph})`).run(...chunk)
  }
}

/** Delete offline ops that exceeded max retry count. */
export function deletePoisonOfflineOps(maxRetries: number) {
  db.prepare(`DELETE FROM offline_ops WHERE COALESCE(retry_count, 0) >= ?`).run(maxRetries)
}

/** Delete all offline ops for a given account and folder */
export function deleteOfflineOpsForFolder(accountId: number, folder: string) {
  db.prepare(`DELETE FROM offline_ops WHERE account_id=? AND folder=?`).run(accountId, folder)
}

// --- Sync state (per-folder CONDSTORE tracking) ---

export type SyncState = {
  accountId: number
  folder: string
  highestModseq: string | null
  uidValidity: number | null
  lastFullSync: string | null
}

export function getSyncState(accountId: number, folder: string): SyncState | undefined {
  const row = db.prepare(
    `SELECT account_id as accountId, folder, highest_modseq as highestModseq,
            uid_validity as uidValidity, last_full_sync as lastFullSync
     FROM sync_state WHERE account_id=? AND folder=?`
  ).get(accountId, folder) as SyncState | undefined
  return row
}

export function upsertSyncState(accountId: number, folder: string, highestModseq: string | null, uidValidity: number | null) {
  db.prepare(
    `INSERT INTO sync_state(account_id, folder, highest_modseq, uid_validity, last_full_sync)
     VALUES(?, ?, ?, ?, datetime('now'))
     ON CONFLICT(account_id, folder) DO UPDATE SET
       highest_modseq = excluded.highest_modseq,
       uid_validity = excluded.uid_validity,
       last_full_sync = datetime('now')`
  ).run(accountId, folder, highestModseq, uidValidity)
}

// --- Send queue ---

export type SendQueueStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'canceled'

export type ArchiveRef = {
  accountId: number
  folder: string
  archiveFolder: string
  uid: number
}

export type SendQueueRow = {
  id: string
  accountId: number
  messageData: unknown
  sendAt: string
  status: SendQueueStatus
  lastError: string | null
  attemptCount: number
  createdAt: string
  updatedAt: string
  archiveRef: ArchiveRef | null
}

type RawSendQueueRow = {
  id: string
  accountId: number
  message_data: string
  sendAt: string
  status: SendQueueStatus
  lastError: string | null
  attemptCount: number
  createdAt: string
  updatedAt: string
  archive_ref: string | null
}

function mapSendQueueRow(row: RawSendQueueRow): SendQueueRow {
  let messageData: unknown = null
  try {
    messageData = JSON.parse(row.message_data)
  } catch {
    messageData = null
  }
  let archiveRef: ArchiveRef | null = null
  if (row.archive_ref) {
    try {
      archiveRef = JSON.parse(row.archive_ref) as ArchiveRef
    } catch {
      archiveRef = null
    }
  }
  return {
    id: row.id,
    accountId: row.accountId,
    messageData,
    sendAt: row.sendAt,
    status: row.status,
    lastError: row.lastError,
    attemptCount: row.attemptCount,
    archiveRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function queueNowIso(): string {
  return new Date().toISOString()
}

function queueRandomId(): string {
  try {
    return randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

export function enqueueSendQueue(
  accountId: number,
  messageData: unknown,
  sendAtIso: string,
  id?: string,
  archiveRef?: ArchiveRef | null,
): string {
  const now = queueNowIso()
  const queueId = (id || '').trim() || queueRandomId()
  db.prepare(`
    INSERT INTO send_queue(id, account_id, message_data, send_at, status, last_error, attempt_count, archive_ref, created_at, updated_at)
    VALUES(?, ?, ?, ?, 'queued', NULL, 0, ?, ?, ?)
  `).run(queueId, accountId, JSON.stringify(messageData ?? {}), sendAtIso, archiveRef ? JSON.stringify(archiveRef) : null, now, now)
  return queueId
}

export function getSendQueueById(id: string): SendQueueRow | undefined {
  const row = db.prepare(`
    SELECT
      id,
      account_id as accountId,
      message_data,
      send_at as sendAt,
      status,
      last_error as lastError,
      attempt_count as attemptCount,
      archive_ref,
      created_at as createdAt,
      updated_at as updatedAt
    FROM send_queue
    WHERE id=?
  `).get(id) as RawSendQueueRow | undefined
  return row ? mapSendQueueRow(row) : undefined
}

export function listSendQueue(opts?: { accountId?: number; statuses?: SendQueueStatus[]; limit?: number }): SendQueueRow[] {
  const where: string[] = []
  const params: unknown[] = []

  if (typeof opts?.accountId === 'number' && Number.isFinite(opts.accountId) && opts.accountId > 0) {
    where.push(`account_id=?`)
    params.push(Math.floor(opts.accountId))
  }

  if (Array.isArray(opts?.statuses) && opts.statuses.length > 0) {
    const allowed: SendQueueStatus[] = ['queued', 'sending', 'sent', 'failed', 'canceled']
    const statuses = opts.statuses.filter(s => allowed.includes(s))
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`)
      params.push(...statuses)
    }
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(1000, Math.floor(opts?.limit ?? 200)))

  const rows = db.prepare(`
    SELECT
      id,
      account_id as accountId,
      message_data,
      send_at as sendAt,
      status,
      last_error as lastError,
      attempt_count as attemptCount,
      archive_ref,
      created_at as createdAt,
      updated_at as updatedAt
    FROM send_queue
    ${whereSql}
    ORDER BY send_at ASC, created_at ASC
    LIMIT ?
  `).all(...params, limit) as RawSendQueueRow[]

  return rows.map(mapSendQueueRow)
}

export function listDueSendQueue(nowIso = queueNowIso(), limit = 20): SendQueueRow[] {
  const lim = Math.max(1, Math.min(500, Math.floor(limit)))
  // Recover stuck items: if status='sending' for >2 minutes, reset to 'queued' for retry.
  // This handles crashes or timeouts during send.
  const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  db.prepare(`
    UPDATE send_queue SET status='queued', updated_at=?
    WHERE status='sending' AND updated_at < ?
  `).run(nowIso, stuckCutoff)
  const rows = db.prepare(`
    SELECT
      id,
      account_id as accountId,
      message_data,
      send_at as sendAt,
      status,
      last_error as lastError,
      attempt_count as attemptCount,
      archive_ref,
      created_at as createdAt,
      updated_at as updatedAt
    FROM send_queue
    WHERE status='queued' AND send_at <= ?
    ORDER BY send_at ASC, created_at ASC
    LIMIT ?
  `).all(nowIso, lim) as RawSendQueueRow[]
  return rows.map(mapSendQueueRow)
}

export function markSendQueueSending(id: string): boolean {
  const now = queueNowIso()
  const res = db.prepare(`
    UPDATE send_queue
    SET status='sending',
        attempt_count=attempt_count + 1,
        updated_at=?
    WHERE id=? AND status='queued'
  `).run(now, id)
  return res.changes > 0
}

export function markSendQueueSent(id: string): boolean {
  const now = queueNowIso()
  const res = db.prepare(`
    UPDATE send_queue
    SET status='sent',
        last_error=NULL,
        updated_at=?
    WHERE id=?
  `).run(now, id)
  return res.changes > 0
}

export function markSendQueueFailed(id: string, error: string): boolean {
  const now = queueNowIso()
  const err = (error || '').slice(0, 4000)
  const res = db.prepare(`
    UPDATE send_queue
    SET status='failed',
        last_error=?,
        updated_at=?
    WHERE id=?
  `).run(err, now, id)
  return res.changes > 0
}

export function rescheduleSendQueue(id: string, sendAtIso: string): boolean {
  const now = queueNowIso()
  const res = db.prepare(`
    UPDATE send_queue
    SET status='queued',
        send_at=?,
        last_error=NULL,
        updated_at=?
    WHERE id=? AND status IN ('queued', 'sending', 'failed')
  `).run(sendAtIso, now, id)
  return res.changes > 0
}

export function sendQueueNow(id: string, nowIso = queueNowIso()): boolean {
  return rescheduleSendQueue(id, nowIso)
}

export function cancelSendQueue(id: string): SendQueueRow | undefined {
  const row = getSendQueueById(id)
  if (!row) return undefined
  if (row.status !== 'queued' && row.status !== 'failed') return undefined
  const now = queueNowIso()
  db.prepare(`
    UPDATE send_queue
    SET status='canceled',
        updated_at=?
    WHERE id=?
  `).run(now, id)
  return getSendQueueById(id)
}

// --- Snooze (B2.13) ---

export type SnoozedRow = {
  id: number
  accountId: number
  messageId: string | null
  folder: string
  uidvalidity: number | null
  uid: number | null
  wakeAt: string
  createdAt: string
}

function rowToSnoozed(r: Record<string, unknown>): SnoozedRow {
  return {
    id: r.id as number,
    accountId: r.account_id as number,
    messageId: (r.message_id as string) ?? null,
    folder: r.folder as string,
    uidvalidity: (r.uidvalidity as number) ?? null,
    uid: (r.uid as number) ?? null,
    wakeAt: r.wake_at as string,
    createdAt: r.created_at as string,
  }
}

export function insertSnooze(
  accountId: number,
  messageId: string | null,
  folder: string,
  uid: number | null,
  wakeAt: string,
): number {
  const now = new Date().toISOString()
  const res = db.prepare(`
    INSERT INTO snoozed(account_id, message_id, folder, uid, wake_at, created_at)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(accountId, messageId, folder, uid, wakeAt, now)
  return Number(res.lastInsertRowid)
}

export function removeSnooze(id: number): boolean {
  return db.prepare(`DELETE FROM snoozed WHERE id=?`).run(id).changes > 0
}

export function removeSnoozeByUid(accountId: number, folder: string, uid: number): boolean {
  return db.prepare(
    `DELETE FROM snoozed WHERE account_id=? AND folder=? AND uid=?`
  ).run(accountId, folder, uid).changes > 0
}

export function listSnoozed(accountId: number): SnoozedRow[] {
  const rows = db.prepare(
    `SELECT * FROM snoozed WHERE account_id=? ORDER BY wake_at ASC`
  ).all(accountId) as Record<string, unknown>[]
  return rows.map(rowToSnoozed)
}

export function listAllSnoozedUids(accountId: number): Array<{ folder: string; uid: number }> {
  return db.prepare(
    `SELECT folder, uid FROM snoozed WHERE account_id=? AND uid IS NOT NULL`
  ).all(accountId) as Array<{ folder: string; uid: number }>
}

export function listDueSnooze(nowIso: string): SnoozedRow[] {
  const rows = db.prepare(
    `SELECT * FROM snoozed WHERE wake_at <= ? ORDER BY wake_at ASC`
  ).all(nowIso) as Record<string, unknown>[]
  return rows.map(rowToSnoozed)
}

// --- Templates (B2.16) ---

export type TemplateRow = {
  id: number
  name: string
  subject: string
  body: string
  shortcut: string | null
  createdAt: string
  updatedAt: string
}

function rowToTemplate(r: Record<string, unknown>): TemplateRow {
  return {
    id: r.id as number,
    name: r.name as string,
    subject: (r.subject as string) ?? '',
    body: (r.body as string) ?? '',
    shortcut: (r.shortcut as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

export function listTemplates(): TemplateRow[] {
  const rows = db.prepare(`SELECT * FROM templates ORDER BY updated_at DESC, id DESC`).all() as Record<string, unknown>[]
  return rows.map(rowToTemplate)
}

export function getTemplate(id: number): TemplateRow | undefined {
  const row = db.prepare(`SELECT * FROM templates WHERE id=?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToTemplate(row) : undefined
}

export function createTemplate(name: string, subject: string, body: string, shortcut?: string | null): TemplateRow {
  const now = new Date().toISOString()
  const res = db.prepare(`
    INSERT INTO templates(name, subject, body, shortcut, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(name, subject, body, shortcut ?? null, now, now)
  return getTemplate(Number(res.lastInsertRowid))!
}

export function updateTemplate(id: number, patch: {
  name?: string
  subject?: string
  body?: string
  shortcut?: string | null
}): TemplateRow | undefined {
  const existing = getTemplate(id)
  if (!existing) return undefined
  const now = new Date().toISOString()
  const name = patch.name ?? existing.name
  const subject = patch.subject ?? existing.subject
  const body = patch.body ?? existing.body
  const shortcut = patch.shortcut !== undefined ? patch.shortcut : existing.shortcut
  db.prepare(`
    UPDATE templates SET name=?, subject=?, body=?, shortcut=?, updated_at=?
    WHERE id=?
  `).run(name, subject, body, shortcut, now, id)
  return getTemplate(id)
}

export function deleteTemplate(id: number): boolean {
  return db.prepare(`DELETE FROM templates WHERE id=?`).run(id).changes > 0
}

// --- Follow-up Reminders (B2.15) ---

export type FollowUpRow = {
  id: number
  accountId: number
  sentMessageId: string
  folder: string
  uid: number | null
  toAddr: string
  subject: string | null
  remindAt: string
  status: string
  createdAt: string
}

function rowToFollowUp(r: Record<string, unknown>): FollowUpRow {
  return {
    id: r.id as number,
    accountId: r.account_id as number,
    sentMessageId: r.sent_message_id as string,
    folder: r.folder as string,
    uid: (r.uid as number) ?? null,
    toAddr: r.to_addr as string,
    subject: (r.subject as string) ?? null,
    remindAt: r.remind_at as string,
    status: r.status as string,
    createdAt: r.created_at as string,
  }
}

export function insertFollowUp(
  accountId: number,
  sentMessageId: string,
  folder: string,
  uid: number | null,
  toAddr: string,
  subject: string | undefined,
  remindAt: string,
): number {
  const now = new Date().toISOString()
  const res = db.prepare(`
    INSERT INTO follow_ups(account_id, sent_message_id, folder, uid, to_addr, subject, remind_at, status, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(accountId, sentMessageId, folder, uid ?? null, toAddr, subject ?? null, remindAt, now)
  return Number(res.lastInsertRowid)
}

export function removeFollowUp(id: number): boolean {
  return db.prepare(`DELETE FROM follow_ups WHERE id=?`).run(id).changes > 0
}

export function listFollowUps(accountId?: number): FollowUpRow[] {
  if (typeof accountId === 'number') {
    const rows = db.prepare(
      `SELECT * FROM follow_ups WHERE status IN ('pending','notified') AND account_id=? ORDER BY remind_at ASC`
    ).all(accountId) as Record<string, unknown>[]
    return rows.map(rowToFollowUp)
  }
  const rows = db.prepare(
    `SELECT * FROM follow_ups WHERE status IN ('pending','notified') ORDER BY remind_at ASC`
  ).all() as Record<string, unknown>[]
  return rows.map(rowToFollowUp)
}

export function listDueFollowUps(nowIso: string): FollowUpRow[] {
  const rows = db.prepare(
    `SELECT * FROM follow_ups WHERE status='pending' AND remind_at <= ? ORDER BY remind_at ASC`
  ).all(nowIso) as Record<string, unknown>[]
  return rows.map(rowToFollowUp)
}

export function dismissFollowUp(id: number): boolean {
  return db.prepare(
    `UPDATE follow_ups SET status='dismissed' WHERE id=?`
  ).run(id).changes > 0
}

export function markFollowUpNotified(id: number): boolean {
  return db.prepare(
    `UPDATE follow_ups SET status='notified' WHERE id=? AND status='pending'`
  ).run(id).changes > 0
}

export function markFollowUpAnswered(id: number): boolean {
  return db.prepare(
    `UPDATE follow_ups SET status='answered' WHERE id=?`
  ).run(id).changes > 0
}

// --- Read Later (GTD @Read/Review) ---

export type ReadLaterRow = {
  id: number
  accountId: number
  folder: string
  uid: number
  createdAt: string
}

function rowToReadLater(r: Record<string, unknown>): ReadLaterRow {
  return {
    id: r.id as number,
    accountId: r.account_id as number,
    folder: r.folder as string,
    uid: r.uid as number,
    createdAt: r.created_at as string,
  }
}

export function insertReadLater(accountId: number, folder: string, uid: number): number {
  const now = new Date().toISOString()
  const res = db.prepare(`
    INSERT OR IGNORE INTO read_later(account_id, folder, uid, created_at)
    VALUES(?, ?, ?, ?)
  `).run(accountId, folder, uid, now)
  if (res.changes === 0) {
    // Already exists — return existing id
    const existing = db.prepare(
      `SELECT id FROM read_later WHERE account_id=? AND folder=? AND uid=?`
    ).get(accountId, folder, uid) as { id: number } | undefined
    return existing?.id ?? 0
  }
  return Number(res.lastInsertRowid)
}

export function removeReadLater(id: number): boolean {
  return db.prepare(`DELETE FROM read_later WHERE id=?`).run(id).changes > 0
}

export function removeReadLaterByUid(accountId: number, folder: string, uid: number): boolean {
  return db.prepare(
    `DELETE FROM read_later WHERE account_id=? AND folder=? AND uid=?`
  ).run(accountId, folder, uid).changes > 0
}

export function listReadLater(accountId: number): ReadLaterRow[] {
  const rows = db.prepare(
    `SELECT * FROM read_later WHERE account_id=? ORDER BY created_at DESC`
  ).all(accountId) as Record<string, unknown>[]
  return rows.map(rowToReadLater)
}

export function listAllReadLaterUids(accountId: number): Array<{ folder: string; uid: number }> {
  return db.prepare(
    `SELECT folder, uid FROM read_later WHERE account_id=?`
  ).all(accountId) as Array<{ folder: string; uid: number }>
}

// --- AI Chat Sessions ---

export type AiSessionRow = {
  id: string
  title: string
  provider: string
  claudeSessionId: string | null
  createdAt: string
  updatedAt: string
}

export type AiMessageRow = {
  id: number
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  costUsd: number | null
  createdAt: string
}

function rowToAiSession(r: Record<string, unknown>): AiSessionRow {
  return {
    id: r.id as string,
    title: (r.title as string) ?? '',
    provider: r.provider as string,
    claudeSessionId: (r.claude_session_id as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

function rowToAiMessage(r: Record<string, unknown>): AiMessageRow {
  return {
    id: r.id as number,
    sessionId: r.session_id as string,
    role: r.role as 'user' | 'assistant',
    content: (r.content as string) ?? '',
    costUsd: typeof r.cost_usd === 'number' ? r.cost_usd : null,
    createdAt: r.created_at as string,
  }
}

export function createAiSession(id: string, provider: string): AiSessionRow {
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO ai_sessions(id, title, provider, created_at, updated_at) VALUES(?, '', ?, ?, ?)`).run(id, provider, now, now)
  return getAiSession(id)!
}

export function getAiSession(id: string): AiSessionRow | undefined {
  const row = db.prepare(`SELECT * FROM ai_sessions WHERE id=?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToAiSession(row) : undefined
}

export function listAiSessions(limit = 50): AiSessionRow[] {
  // Exclude the hidden cost-ledger session (see AI_COST_LEDGER_SESSION_ID /
  // recordAiCost) — it is a budget bookkeeping anchor, not a user chat.
  const rows = db.prepare(
    `SELECT * FROM ai_sessions WHERE id != ? ORDER BY updated_at DESC LIMIT ?`
  ).all(AI_COST_LEDGER_SESSION_ID, limit) as Record<string, unknown>[]
  return rows.map(rowToAiSession)
}

export function updateAiSessionTitle(id: string, title: string): void {
  db.prepare(`UPDATE ai_sessions SET title=?, updated_at=? WHERE id=?`).run(title, new Date().toISOString(), id)
}

export function updateAiSessionClaudeId(id: string, claudeSessionId: string): void {
  db.prepare(`UPDATE ai_sessions SET claude_session_id=?, updated_at=? WHERE id=?`).run(claudeSessionId, new Date().toISOString(), id)
}

export function deleteAiSession(id: string): boolean {
  // The hidden cost-ledger session (AI_COST_LEDGER_SESSION_ID) is a budget
  // bookkeeping anchor, not a user chat: its ai_messages rows are the running
  // spend total that sumAiCostSince/checkBudgetLimits read (ai_messages has
  // ON DELETE CASCADE from ai_sessions). Deleting it would drop the sum and
  // bypass the daily/monthly cap. The generic aiSession:delete IPC lets any
  // renderer pass an arbitrary id, so this guard lives at the data layer —
  // it protects every caller, not just that one handler. No-op (0 deleted).
  if (id === AI_COST_LEDGER_SESSION_ID) return false
  return db.prepare(`DELETE FROM ai_sessions WHERE id=?`).run(id).changes > 0
}

export function deleteAllAiSessions(): number {
  // Preserve the hidden cost-ledger session (AI_COST_LEDGER_SESSION_ID): its
  // ai_messages rows are the budget spend total that checkBudgetLimits reads.
  // A user clearing their chat history must NOT be able to reset the running
  // budget total (ai_messages has ON DELETE CASCADE from ai_sessions).
  return db.prepare(`DELETE FROM ai_sessions WHERE id != ?`).run(AI_COST_LEDGER_SESSION_ID).changes
}

export function insertAiMessage(sessionId: string, role: 'user' | 'assistant', content: string, costUsd?: number | null): AiMessageRow {
  const now = new Date().toISOString()
  // cost_usd feeds sumAiCostSince/checkBudgetLimits (the budget cap). The
  // aiSession:addMessage IPC lets a renderer supply an arbitrary costUsd, and a
  // negative/non-finite value would SHRINK the running spend sum and cancel out
  // real (e.g. B2 summary) spend, defeating the cap. Clamp to the same
  // non-negative invariant recordAiCost enforces: keep a finite positive cost,
  // otherwise store null (no spend). null is preserved rather than coerced to 0
  // so a plain chat message with no metering stays cost-less as before; the
  // security-relevant case (finite non-positive) collapses to no budget effect.
  const safeCost = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0 ? costUsd : null
  const res = db.prepare(`INSERT INTO ai_messages(session_id, role, content, cost_usd, created_at) VALUES(?, ?, ?, ?, ?)`).run(sessionId, role, content, safeCost, now)
  db.prepare(`UPDATE ai_sessions SET updated_at=? WHERE id=?`).run(now, sessionId)
  return { id: Number(res.lastInsertRowid), sessionId, role, content, costUsd: safeCost, createdAt: now }
}

export function listAiMessages(sessionId: string): AiMessageRow[] {
  const rows = db.prepare(`SELECT * FROM ai_messages WHERE session_id=? ORDER BY id ASC`).all(sessionId) as Record<string, unknown>[]
  return rows.map(rowToAiMessage)
}

export function getLastAiMessages(sessionId: string, limit: number): AiMessageRow[] {
  const rows = db.prepare(
    `SELECT * FROM (SELECT * FROM ai_messages WHERE session_id=? ORDER BY id DESC LIMIT ?) sub ORDER BY id ASC`
  ).all(sessionId, limit) as Record<string, unknown>[]
  return rows.map(rowToAiMessage)
}

/**
 * INTERNAL, SINGLE SOURCE OF TRUTH for the AI budget sum. Sums `cost_usd` for
 * ledger rows (rows under {@link AI_COST_LEDGER_SESSION_ID}) created at/after
 * `sinceIso`. Both the public {@link sumAiCostSince} and the in-transaction
 * {@link sumAiCostSinceInTx} delegate here, so the projected-admission path and
 * the public budget-message path can NEVER drift on the SQL (§2.51 fix-2 Low:
 * previously the two callers each inlined their own `SELECT SUM(...)` and had to
 * be kept in sync by hand). It is safe to call from inside an active
 * `BEGIN IMMEDIATE` transaction — better-sqlite3 statements are synchronous and
 * reentrant on the single connection.
 *
 * WHY LEDGER-ONLY (§2.51 double-count fix). Every budget-relevant spend is
 * booked under {@link AI_COST_LEDGER_SESSION_ID}: `recordAiCost` (compose /
 * instant-reply / thread-summary), and `reserveAiCost` / `admitAiReservation` /
 * `reconcileAiReservation` (the chat and other agentic reservation path). The
 * renderer ALSO persists the finished chat assistant message under its REAL
 * chat session with a `cost_usd` for UI (session-cost badge + per-message badge
 * in `AiPanel.tsx`) — but that same chat spend was already counted via its
 * reservation in the ledger. Summing the whole `ai_messages` table therefore
 * DOUBLE-COUNTED chat cost (once as the ledger reservation, once as the chat
 * assistant row). Restricting the sum to the ledger session makes chat assistant
 * rows display-only and leaves exactly one budget entry per call.
 */
function sumLedgerCostSince(sinceIso: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_messages WHERE session_id = ? AND created_at >= ?`
  ).get(AI_COST_LEDGER_SESSION_ID, sinceIso) as { total: number } | undefined
  return row?.total ?? 0
}

/**
 * Returns the AI budget spend since the given ISO date — the sum of `cost_usd`
 * for LEDGER rows only (see {@link AI_COST_LEDGER_SESSION_ID}). Used by the
 * daily/monthly budget cap (`checkBudgetLimits`).
 *
 * LEDGER-ONLY (§2.51 double-count fix): rows under a real chat session — e.g. the
 * assistant chat message the renderer saves for its cost badges — are NOT
 * summed, because that same chat spend is already counted via its reservation in
 * the ledger. Counting both double-charged chat cost against the cap. The
 * canonical ledger is now the single budget source; chat `cost_usd` is
 * display-only. See {@link sumLedgerCostSince} for the full rationale.
 */
export function sumAiCostSince(sinceIso: string): number {
  return sumLedgerCostSince(sinceIso)
}

/**
 * Reserved `ai_sessions.id` used as the FK anchor for non-chat AI cost entries
 * (see {@link recordAiCost}). `ai_messages.session_id` is a NOT NULL FK to
 * `ai_sessions`, and `foreign_keys` is ON, so a cost row for work that has no
 * user-facing chat session (e.g. a §3.3 B2 thread-summary generation) still
 * needs *a* parent session. Rather than inventing a second cost table — which
 * would fork the ledger `sumAiCostSince`/`checkBudgetLimits` reads — every such
 * cost is booked against this single hidden session. It is excluded from
 * {@link listAiSessions} so it never surfaces in the chat-session UI.
 *
 * LEDGER IS CANONICAL FOR THE BUDGET (§2.51). This hidden session is the ONE
 * source of truth the budget cap sums: {@link sumAiCostSince} counts `cost_usd`
 * ONLY for rows under this session id. Everything that must count against the
 * daily/monthly cap books here — `recordAiCost` (compose / instant-reply /
 * thread-summary) and `reserveAiCost` / `admitAiReservation` /
 * `reconcileAiReservation` (chat + agentic reservation path).
 *
 * CHAT ASSISTANT MESSAGES ARE DISPLAY-ONLY. The renderer separately persists the
 * finished chat assistant message under its REAL chat session WITH a `cost_usd`
 * so the AiPanel session-cost badge and per-message badge can render it. That
 * chat spend is ALREADY counted via its reservation in this ledger, so summing
 * it a second time from the chat session would DOUBLE-COUNT the call. Restricting
 * the budget sum to this ledger session keeps chat `cost_usd` purely for UI and
 * leaves exactly one budget entry per call.
 */
export const AI_COST_LEDGER_SESSION_ID = '__ai_cost_ledger__'

/**
 * Record a standalone AI cost entry into the SAME `ai_messages` ledger that
 * {@link sumAiCostSince} — and therefore `checkBudgetLimits` — reads, WITHOUT
 * requiring a user-facing chat session. Use this for provider calls that spend
 * money but have no chat thread of their own, such as §3.3 B2 thread-summary
 * generations: previously those only wrote `ai_action_log` (with `costUsd`
 * null), so their spend was invisible to the daily/monthly budget cap and could
 * run unbounded.
 *
 * The cost is booked as an `assistant` row under the hidden
 * {@link AI_COST_LEDGER_SESSION_ID} session (lazily created on first use), so
 * there is exactly ONE cost ledger and one budget query — no parallel table.
 * `provider` and `model` are folded into the row `content` purely for local
 * debuggability; only `cost_usd` participates in the budget sum. A non-finite
 * or negative `costUsd` is treated as `0` (a metering glitch must not be able
 * to *reduce* the running total or throw).
 *
 * @returns the persisted ledger {@link AiMessageRow}.
 */
export function recordAiCost(
  accountId: string,
  provider: string,
  model: string | null,
  costUsd: number,
): AiMessageRow {
  const safeCost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0
  const now = new Date().toISOString()
  // Lazily ensure the hidden ledger session exists (idempotent).
  const existing = db.prepare(`SELECT 1 FROM ai_sessions WHERE id=?`).get(AI_COST_LEDGER_SESSION_ID)
  if (!existing) {
    db.prepare(
      `INSERT INTO ai_sessions(id, title, provider, created_at, updated_at) VALUES(?, ?, ?, ?, ?)`
    ).run(AI_COST_LEDGER_SESSION_ID, 'AI cost ledger', provider, now, now)
  }
  const content = `cost account=${accountId} provider=${provider}${model ? ` model=${model}` : ''}`
  const res = db.prepare(
    `INSERT INTO ai_messages(session_id, role, content, cost_usd, created_at) VALUES(?, 'assistant', ?, ?, ?)`
  ).run(AI_COST_LEDGER_SESSION_ID, content, safeCost, now)
  return {
    id: Number(res.lastInsertRowid),
    sessionId: AI_COST_LEDGER_SESSION_ID,
    role: 'assistant',
    content,
    costUsd: safeCost,
    createdAt: now,
  }
}

// --- Atomic AI budget reservation (§2.51 — fail-closed cap) ----------------
//
// PROBLEM this solves. `recordAiCost` above books the cost of a completed
// call, but the budget CHECK (checkBudgetLimits → sumAiCostSince) and that
// WRITE are separated in time (check-then-act). Concurrent AI calls all read
// the pre-spend total, all pass the cap, and only then does any of them book
// a cost — every one of them can punch through the daily/monthly cap before
// the first write lands. And `recordAiCost` is fail-OPEN: a non-finite /
// negative amount, or a durable ledger-write failure, silently books 0 (or is
// swallowed), so a metering glitch disables the cap entirely.
//
// FIX. Perform BOTH the projected-budget check AND the reservation insert
// ATOMICALLY inside one BEGIN IMMEDIATE transaction (via better-sqlite3
// `.immediate()`) — this is {@link admitAiReservation}. Inside the transaction
// it (1) sums the SAME `ai_messages` ledger that `sumAiCostSince` reads for each
// supplied limit window, (2) refuses to insert if `currentSum + reservationUsd`
// would exceed ANY window limit (over-cap deny — a genuine HARD cap: the
// reservation itself can never push the total past the limit), and only
// otherwise (3) inserts the reservation row. Because the row carries a positive
// `cost_usd`, it participates in `sumAiCostSince` the instant it commits, so a
// second concurrent caller re-summing inside its own immediate transaction sees
// the first reservation and is denied when over cap. The write lock is acquired
// at BEGIN (not on first write), so the sum+insert pair is genuinely serialized
// across connections/threads — there is no window between the projected check
// and the insert for a racing caller to slip through. After the async provider
// call finishes (which cannot live inside a sync sqlite transaction — see the
// file-level note on `db.transaction`), a separate `reconcileAiReservation`
// transaction replaces the reservation with the actual cost — one net effect on
// the ledger, no double-count.
//
// TWO DISTINCT DENIALS. `admitAiReservation` distinguishes them by RESULT vs
// THROW, and the caller (ai-mcp) MUST treat them differently:
//   - OVER-CAP deny (`{ ok: false, reason: 'over-cap' }`) — the projected sum
//     would exceed a limit. This is a NORMAL budget refusal, NOT a broken meter;
//     the caller shows the ordinary "budget limit reached" message. It does NOT
//     throw.
//   - FAIL-CLOSED throw (`AiBudgetReserveError`) — an invalid reservation amount
//     or a durable ledger-write failure. A broken meter must never widen the cap,
//     so the caller treats the throw as a hard DENY of the AI call.
//
// The lower-level {@link reserveAiCost} keeps only the fail-closed guarantee (it
// does NOT know limits); {@link admitAiReservation} layers the atomic projected
// cap on top of it, reusing the same insert inside the immediate transaction.

/**
 * Marker embedded in the `content` of a reservation ledger row so a human
 * scanning `ai_messages` (or a future migration) can tell a live reservation
 * apart from a settled/actual cost. PII-free by construction: content only
 * ever holds account id / provider / model — never prompt or email text.
 */
const AI_RESERVATION_MARKER = 'reservation'

/**
 * Distinct error thrown by {@link reserveAiCost} when a reservation cannot be
 * booked. Existence of this error IS the fail-closed deny signal: the caller
 * must abort the AI call rather than proceed unmetered. `reason` classifies
 * the failure for diagnostics / telemetry without leaking any PII.
 */
export class AiBudgetReserveError extends Error {
  readonly reason: 'invalid-amount' | 'ledger-write-failed'
  /** The underlying sqlite / IO error for the `ledger-write-failed` case, if any.
   *  Set as a plain property (not the ES2022 `Error` `cause` option) to keep the
   *  ES2020 lib target — the compile lib does not type the two-arg Error ctor. */
  readonly cause?: unknown
  constructor(reason: 'invalid-amount' | 'ledger-write-failed', message: string, cause?: unknown) {
    super(message)
    this.name = 'AiBudgetReserveError'
    this.reason = reason
    this.cause = cause
  }
}

/**
 * Opaque handle returned by {@link reserveAiCost}, threaded back into
 * {@link reconcileAiReservation}. `id` is the `ai_messages.id` of the booked
 * reservation row (autoincrement PK — the reservation token). `reservedUsd`
 * is the positive amount that is currently counting against the budget for
 * this in-flight call; reconcile subtracts it and adds the actual cost.
 */
export type AiCostReservation = {
  /** `ai_messages.id` of the reservation row — the reconcile token. */
  id: number
  /** The positive USD amount reserved (already counted by `sumAiCostSince`). */
  reservedUsd: number
  /** Ledger session anchor (always {@link AI_COST_LEDGER_SESSION_ID}). */
  sessionId: string
  /** ISO timestamp the reservation was booked. */
  createdAt: string
}

/**
 * INTERNAL: ensure the hidden ledger session exists and insert one reservation
 * row, returning its autoincrement id. MUST be called from inside an active
 * `BEGIN IMMEDIATE` transaction (both `reserveAiCost` and `admitAiReservation`
 * wrap it in `db.transaction(...).immediate()`). Assumes `reservationUsd` has
 * already been validated as finite and > 0 by the caller.
 */
function insertReservationRow(
  accountId: string,
  provider: string,
  model: string | null,
  reservationUsd: number,
  nowIso: string,
): number {
  const existing = db.prepare(`SELECT 1 FROM ai_sessions WHERE id=?`).get(AI_COST_LEDGER_SESSION_ID)
  if (!existing) {
    db.prepare(
      `INSERT INTO ai_sessions(id, title, provider, created_at, updated_at) VALUES(?, ?, ?, ?, ?)`
    ).run(AI_COST_LEDGER_SESSION_ID, 'AI cost ledger', provider, nowIso, nowIso)
  }
  const content = `${AI_RESERVATION_MARKER} account=${accountId} provider=${provider}${model ? ` model=${model}` : ''}`
  const res = db.prepare(
    `INSERT INTO ai_messages(session_id, role, content, cost_usd, created_at) VALUES(?, 'assistant', ?, ?, ?)`
  ).run(AI_COST_LEDGER_SESSION_ID, content, reservationUsd, nowIso)
  return Number(res.lastInsertRowid)
}

/**
 * INTERNAL: sum the LEDGER `cost_usd` for rows created at/after `sinceIso`, from
 * INSIDE an active reservation transaction. Delegates to the SINGLE shared
 * {@link sumLedgerCostSince} (same SQL as the public {@link sumAiCostSince}), so
 * the atomic-admission path and the public budget-message path can never drift
 * on the budget query (§2.51 fix-2 Low). Kept as a named seam purely to make the
 * intent ("this runs under BEGIN IMMEDIATE") explicit at the call site; it does
 * NOT duplicate the daily/monthly window logic, which lives in the caller.
 */
function sumAiCostSinceInTx(sinceIso: string): number {
  return sumLedgerCostSince(sinceIso)
}

/**
 * ATOMICALLY reserve a positive, conservative cost against the AI budget — the
 * LOW-LEVEL insert, WITHOUT any limit check. Prefer {@link admitAiReservation},
 * which layers the atomic projected cap on top of this; call `reserveAiCost`
 * directly only when the limit has already been enforced or is intentionally
 * absent.
 *
 * Runs a single `BEGIN IMMEDIATE` transaction that (1) ensures the hidden
 * ledger session exists and (2) inserts a reservation row into `ai_messages`
 * with `cost_usd = reservationUsd`, so the amount is visible to the very next
 * `sumAiCostSince` / `checkBudgetLimits` read from any connection.
 *
 * FAIL-CLOSED: `reservationUsd` MUST be finite and > 0. A non-finite,
 * negative, or zero amount throws {@link AiBudgetReserveError} (`invalid-amount`)
 * — it is NOT clamped to 0 (that is the fail-OPEN behaviour of `recordAiCost`
 * this primitive deliberately inverts). Any sqlite write failure is caught,
 * reported via the db telemetry seam, and re-thrown as
 * {@link AiBudgetReserveError} (`ledger-write-failed`). There is no silent
 * success path: either a reservation row is durably committed, or the caller
 * gets a throw and must deny the AI call.
 *
 * @param accountId  Account the spend is attributed to (aggregate only).
 * @param provider   Provider id (e.g. 'openai-api'); folded into `content`.
 * @param model      Model id or null; folded into `content` for debuggability.
 * @param reservationUsd  Positive conservative reservation (caller pre-computes
 *   it, e.g. via `nullUsageReservationUsd` — this primitive does NOT price).
 * @returns {@link AiCostReservation} handle to pass to reconcile.
 * @throws {AiBudgetReserveError} on invalid amount or ledger-write failure.
 */
export function reserveAiCost(
  accountId: string,
  provider: string,
  model: string | null,
  reservationUsd: number,
): AiCostReservation {
  // Fail-closed input guard: reject anything that is not a finite positive
  // number. A NaN / Infinity / <= 0 reservation cannot count against a cap, so
  // rather than book 0 (fail-open) we deny — a broken meter must not widen the
  // budget.
  if (!Number.isFinite(reservationUsd) || reservationUsd <= 0) {
    reportDbEvent('db.ai_reserve_denied', { reason: 'invalid-amount' })
    throw new AiBudgetReserveError(
      'invalid-amount',
      `reserveAiCost: reservationUsd must be a finite positive number, got ${String(reservationUsd)}`,
    )
  }

  const now = new Date().toISOString()

  try {
    // BEGIN IMMEDIATE: acquire the write lock at transaction start so the
    // ledger-session ensure + reservation insert are one atomic, serialized
    // unit against any concurrent reserve/reconcile.
    const insert = db.transaction((): number =>
      insertReservationRow(accountId, provider, model, reservationUsd, now)
    )
    const id = insert.immediate()
    return { id, reservedUsd: reservationUsd, sessionId: AI_COST_LEDGER_SESSION_ID, createdAt: now }
  } catch (err) {
    // A durable ledger-write failure MUST NOT be swallowed: if we cannot book
    // the reservation, the cap has no record of this in-flight spend, so the
    // only safe outcome is to deny the call. Report for diagnostics, then throw.
    reportDbEvent('db.ai_reserve_denied', { reason: 'ledger-write-failed' })
    throw new AiBudgetReserveError(
      'ledger-write-failed',
      `reserveAiCost: failed to book reservation into the cost ledger`,
      err,
    )
  }
}

/**
 * One daily/monthly budget window the atomic admission must honour. `sinceIso`
 * is the inclusive lower bound of the window (e.g. today-start or month-start,
 * computed by the caller from `Settings` — the db layer stays agnostic to the
 * calendar semantics); `limitUsd` is the HARD cap for the window. A window with
 * `limitUsd <= 0` means "unlimited" and is skipped by {@link admitAiReservation}
 * (mirroring `checkBudgetLimits`, which treats a non-positive limit as off).
 */
export type AiBudgetLimitWindow = {
  /** Inclusive ISO lower bound of the window (matches `sumAiCostSince` semantics). */
  sinceIso: string
  /** Hard USD cap for this window; `<= 0` disables the window. */
  limitUsd: number
}

/**
 * Result of {@link admitAiReservation}. THREE outcomes, deliberately split so
 * the caller can distinguish a normal budget refusal from a fail-closed meter
 * error (which THROWS instead — see below):
 *   - `{ ok: true, reservation }`        — admitted; caller MUST later settle it.
 *   - `{ ok: false, reason: 'over-cap' }`— projected sum would breach a window
 *                                          limit. Ordinary budget deny; NO row
 *                                          was inserted, the running total is
 *                                          unchanged. Caller shows the normal
 *                                          "budget limit reached" refusal.
 *
 * The fail-closed cases (invalid amount / ledger-write failure) are NOT
 * represented here — they THROW {@link AiBudgetReserveError}, because a broken
 * meter must hard-deny rather than be mistaken for a routine over-cap refusal.
 */
export type AiReservationAdmission =
  | { ok: true; reservation: AiCostReservation }
  | { ok: false; reason: 'over-cap' }

/**
 * ATOMIC, HARD-CAP budget admission — the projected limit check AND the
 * reservation insert run in ONE `BEGIN IMMEDIATE` transaction, so the cap is a
 * true DB-level invariant that reservation rows can never punch through.
 *
 * Inside the single immediate transaction:
 *   1. For each supplied {@link AiBudgetLimitWindow} with `limitUsd > 0`, sum the
 *      ledger from `sinceIso` (same math as `sumAiCostSince`).
 *   2. If `currentSum + reservationUsd > limitUsd` for ANY window, insert
 *      NOTHING and return `{ ok: false, reason: 'over-cap' }`. This closes the
 *      Blocker/High: unlike an outer `checkBudgetLimits(settings) !== null`
 *      pre-check (which only answers "already exceeded?"), the projected `+
 *      reservationUsd` comparison prevents the reservation itself from crossing
 *      the cap — e.g. spent $0.19, cap $0.20, reservation $0.05 is now DENIED
 *      instead of booking $0.24.
 *   3. Otherwise insert the reservation row and return the handle.
 *
 * Because both the read and the write hold the same BEGIN-IMMEDIATE write lock,
 * a concurrent caller cannot slip a reservation in between this one's sum and
 * its insert; the check+reserve is genuinely serialized across connections.
 *
 * FAIL-CLOSED (unchanged from `reserveAiCost`): a non-finite / non-positive
 * `reservationUsd` throws {@link AiBudgetReserveError} (`invalid-amount`) and any
 * durable sqlite write failure throws (`ledger-write-failed`). Over-cap is a
 * NORMAL deny and does NOT throw — the two are distinct on purpose.
 *
 * WHAT "HARD CAP" MEANS (§2.51 — precise semantics). The cap is hard in TWO
 * senses, both against the LEDGER-ONLY budget sum (see
 * {@link AI_COST_LEDGER_SESSION_ID}): (1) concurrent-bypass protection — the
 * reservation is written and visible to competitors inside the same immediate
 * transaction, so racing callers cannot each read a pre-spend total and all slip
 * past; and (2) projected admission — `currentSum + reservationUsd > limit`
 * DENIES before any row lands, so a reservation can never itself push the total
 * past the cap. It is NOT a hard cap on the FINAL settled dollar amount.
 *
 * OVERSHOOT IS N-CALL, NOT SINGLE-CALL (§2.51 — precise). Projected admission
 * bounds only the NUMBER of simultaneous reservations that fit under the cap
 * (roughly N ≈ cap / floor, since each in-flight reservation books at least the
 * conservative FLOOR `reservationUsd` = `nullUsageReservationUsd`, NOT an upper
 * bound). But each of those N admitted calls may then reconcile ABOVE its own
 * floor — the true cost of an open-ended agentic call is unknown until it
 * completes — so the WORST-CASE aggregate overshoot is MULTIPLICATIVE across the
 * N concurrent in-flight calls, not a single call's excess. In practice the
 * per-account single-flight (AC6, `electron/services/ai.ts`) serializes one
 * account's calls down to ~1 in-flight, so this N-call exposure is a
 * cross-feature / cross-account concurrency window, not a single user in one
 * chat. Once any call reconciles, the ledger reflects its ACTUAL cost and
 * subsequent admissions are denied against the true total. This bound is an
 * accepted property of the approved conservative-floor design; a provable
 * per-call / global upper bound is a separate followup, out of §2.51 scope.
 *
 * HOW BIG IS THE OVERSHOOT, CONCRETELY (§2.51 fix-3, MEDIUM — measured, not
 * hand-waved). The floor is `nullUsageReservationUsd(model)` =
 * `max(0.05, 2k-in + 2k-out priced for the model)`, which works out to $0.05 for
 * every model in the current rate table except gpt-4 ($0.08). So with the default
 * $5 daily cap, admission alone permits N ≈ 5 / 0.05 = 100 simultaneously
 * in-flight reservations before the ledger shows the cap as reached.
 *
 * The floor is NOT an upper bound on the settled actual, in two distinct ways:
 *   - ONE-SHOT surfaces (quick action, instant reply, thread summary) cap output
 *     at `max_tokens = 2000`, but the INPUT is unbounded — a long thread is easily
 *     20k+ prompt tokens. On gpt-4o that is ~$0.13 actual against a $0.05 floor
 *     (~2.6x).
 *   - The AGENTIC chat path runs up to `aiMaxTurns` (default 30) tool cycles with
 *     a context that grows every turn, so ONE call can settle one to two ORDERS OF
 *     MAGNITUDE above the floor.
 *
 * Worst-case aggregate overshoot is therefore `Σ(actual_i − floor_i)` across the
 * in-flight set. Theoretical ceiling with the defaults and 100 concurrent agentic
 * calls each settling ~10x the floor: 100 × $0.45 ≈ $45 on a $5 cap (~10x).
 * Realistically the concurrent in-flight count is 1–5 (per-account single-flight
 * on the compose/summary surfaces plus one interactive chat), putting the
 * practical overshoot at ~$1–2 on a $5 cap.
 *
 * NOT FIXED HERE, deliberately. The obvious "reserve an upper bound instead of a
 * floor" costs more than it buys: the only candidate upper bound for the agentic
 * path is the per-request budget setting (default $2 — and note it is currently a
 * Settings-only field with NO enforcement in the service layer), and reserving $2
 * per chat would deny every chat once the remaining daily budget drops below $2,
 * i.e. ~2 guaranteed chats per day on the default cap. That is a product
 * trade-off, not a bug fix, so it stays a followup carrying the numbers above.
 *
 * @param accountId  Account the spend is attributed to (aggregate only).
 * @param provider   Provider id (e.g. 'openai-api'); folded into `content`.
 * @param model      Model id or null; folded into `content` for debuggability.
 * @param reservationUsd  Positive conservative reservation (caller pre-computes).
 * @param windows    Budget windows to enforce (daily/monthly). An empty array
 *   means "no cap" and the reservation is always booked (still fail-closed on a
 *   bad amount / write failure).
 * @returns {@link AiReservationAdmission} — admitted handle or over-cap deny.
 * @throws {AiBudgetReserveError} on invalid amount or ledger-write failure.
 */
export function admitAiReservation(
  accountId: string,
  provider: string,
  model: string | null,
  reservationUsd: number,
  windows: readonly AiBudgetLimitWindow[],
): AiReservationAdmission {
  // Fail-closed input guard (same contract as reserveAiCost): a broken amount
  // denies via THROW, never books 0.
  if (!Number.isFinite(reservationUsd) || reservationUsd <= 0) {
    reportDbEvent('db.ai_reserve_denied', { reason: 'invalid-amount' })
    throw new AiBudgetReserveError(
      'invalid-amount',
      `admitAiReservation: reservationUsd must be a finite positive number, got ${String(reservationUsd)}`,
    )
  }

  const now = new Date().toISOString()
  const active = windows.filter(w => Number.isFinite(w.limitUsd) && w.limitUsd > 0)

  try {
    // BEGIN IMMEDIATE: the projected-sum reads AND the reservation insert are
    // one atomic, serialized unit. The write lock is taken at BEGIN, so no
    // racing caller can commit a reservation between our sum and our insert.
    const admit = db.transaction((): AiReservationAdmission => {
      for (const w of active) {
        const currentSum = sumAiCostSinceInTx(w.sinceIso)
        // HARD cap: refuse if THIS reservation would push the window over its
        // limit. Strict `>` matches `checkBudgetLimits`'s `>=` boundary: there,
        // `spent >= limit` denies further spend; here `spent + reservation >
        // limit` denies booking a reservation that would exceed the limit,
        // while still allowing a reservation that lands exactly on it.
        if (currentSum + reservationUsd > w.limitUsd) {
          reportDbEvent('db.ai_reserve_denied', { reason: 'over-cap' })
          return { ok: false, reason: 'over-cap' }
        }
      }
      const id = insertReservationRow(accountId, provider, model, reservationUsd, now)
      return {
        ok: true,
        reservation: { id, reservedUsd: reservationUsd, sessionId: AI_COST_LEDGER_SESSION_ID, createdAt: now },
      }
    })
    return admit.immediate()
  } catch (err) {
    // A durable ledger-write failure MUST NOT be swallowed: with no record of
    // the in-flight spend the cap is blind, so deny (throw) rather than proceed.
    reportDbEvent('db.ai_reserve_denied', { reason: 'ledger-write-failed' })
    throw new AiBudgetReserveError(
      'ledger-write-failed',
      `admitAiReservation: failed to book reservation into the cost ledger`,
      err,
    )
  }
}

/**
 * Result of {@link reconcileAiReservation}: the net ledger effect after the
 * reservation is settled with the actual cost.
 */
export type AiCostReconcileResult = {
  /** True if the reservation row existed and was settled (idempotency guard). */
  settled: boolean
  /** The final `cost_usd` now recorded for this call (0 when actualUsd <= 0). */
  finalUsd: number
}

/**
 * Settle a prior {@link reserveAiCost} reservation with the ACTUAL cost, in a
 * single `BEGIN IMMEDIATE` transaction — replacing (not adding to) the
 * reservation so there is exactly ONE net effect on the ledger for the call.
 *
 * Implemented as an UPDATE-IN-PLACE of the reservation row: `cost_usd` is
 * overwritten with the settled amount and the `reservation` marker in
 * `content` is rewritten to `cost` so the row is no longer a live reservation.
 * Update-in-place (vs delete-reservation + insert-actual) is deliberate — it
 * is a single row mutation, cannot transiently drop the amount out of
 * `sumAiCostSince`, and is trivially idempotent (a second reconcile of the
 * same, already-settled row is a no-op because the WHERE clause requires the
 * live reservation marker).
 *
 * SETTLE SEMANTICS (§2.51 — precise). The reservation is a conservative FLOOR
 * (`nullUsageReservationUsd`), NOT an upper bound. For a VALID `actualUsd`,
 * reconcile writes the REAL settled amount, which may be ABOVE OR BELOW the
 * floor — it is a replace-in-place, NOT a lower-only clamp. (Proven by the test
 * "reconcileAiReservation ABOVE the reservation still REPLACES it": a $0.05
 * reservation reconciling to $0.20 raises the row to $0.20, it does not stay at
 * the floor.)
 *
 * `actualUsd` is settled fail-SAFE (not fail-closed): ONLY a garbage actual —
 * non-finite / negative — collapses to 0. This particular case does NOT weaken
 * the cap: garbage carries no usable cost, so 0 is the safe reading, and the
 * fail-CLOSED admission guarantee lives entirely in reserve, never here. Do NOT
 * read that special case as "reconcile only ever lowers" — a valid actual above
 * the floor is written up, as above.
 *
 * NOTE ON NULL-USAGE FLOOR. When the provider reports no usable usage, the
 * ai-mcp caller is expected to pass the conservative floor computed by the
 * SHARED core math (`estimateAiRuleCostUsd` → fallback `nullUsageReservationUsd`
 * / `AI_RULE_NULL_USAGE_COST_FLOOR`), NOT 0 — otherwise a null-usage call would
 * reconcile down to free. This primitive does not re-derive that math; it books
 * whatever finite positive `actualUsd` it is handed (or 0 on garbage).
 *
 * @param reservation  Handle returned by {@link reserveAiCost}.
 * @param actualUsd    Real settled cost (caller pre-computes via shared math).
 * @returns {@link AiCostReconcileResult}.
 */
export function reconcileAiReservation(
  reservation: AiCostReservation,
  actualUsd: number,
): AiCostReconcileResult {
  // Settle fail-safe: a VALID actual is written as-is (may be above OR below the
  // conservative floor — replace-in-place, not a lower-only clamp). ONLY a
  // garbage actual (non-finite / negative) clamps to 0, which never disables the
  // cap (see doc-comment; fail-CLOSED lives in reserve).
  const finalUsd = Number.isFinite(actualUsd) && actualUsd > 0 ? actualUsd : 0
  const settledContent = `cost (settled) reservation_id=${reservation.id}`

  const settle = db.transaction((): boolean => {
    // Only settle a row that is still a LIVE reservation (marker present). This
    // makes reconcile idempotent: a duplicate settle finds no matching row and
    // is a no-op, so the actual cost cannot be booked twice.
    const res = db.prepare(
      `UPDATE ai_messages
         SET cost_usd = ?, content = ?
       WHERE id = ?
         AND session_id = ?
         AND content LIKE ?`
    ).run(
      finalUsd,
      settledContent,
      reservation.id,
      AI_COST_LEDGER_SESSION_ID,
      `${AI_RESERVATION_MARKER} %`,
    )
    return res.changes > 0
  })

  const settled = settle.immediate()
  return { settled, finalUsd }
}

// --- Thread AI Summary cache (§3.3 B2) -------------------------------------

/**
 * Decoded cache row for a thread AI summary. `bullets` is materialised back
 * into a `string[]` from its JSON storage form; every other field maps 1:1 to
 * the `ai_summaries` column of the same name.
 */
export type ThreadSummaryRow = {
  /** Stable, order-independent identity hash of the thread (see `computeThreadHash`). */
  threadHash: string
  accountId: string
  /** Collapsed single-line summary shown above the message stack. */
  oneLine: string
  /** Expandable bullet list (the 5-bullet form), decoded from JSON. */
  bullets: string[]
  /** Provider that generated the summary, e.g. 'openai-api', 'subscription'. */
  provider: string
  /** Creation time in epoch milliseconds. */
  createdAt: number
}

/**
 * Payload for {@link upsertThreadSummary}. `threadHash` is the caller-supplied
 * stable identity produced by {@link computeThreadHash}; `bullets` is the raw
 * `string[]` (this function JSON-encodes it for storage).
 */
export type ThreadSummaryInput = {
  threadHash: string
  accountId: string
  oneLine: string
  bullets: string[]
  provider: string
  /** Optional creation time in epoch ms; defaults to `Date.now()`. */
  createdAt?: number
}

/**
 * Compute a stable, ORDER-INDEPENDENT identity hash for a message thread.
 *
 * Hashing input: the set of per-message identity tokens of the thread — each
 * token is a Message-ID or a synthetic `account:folder:uid` key, whatever the
 * caller uses to identify the thread's members. The function:
 *   1. trims each token, drops empty tokens,
 *   2. de-duplicates and sorts the remaining tokens lexicographically, so the
 *      result is independent of the order the messages were passed in,
 *   3. serialises the sorted set with UNAMBIGUOUS, length-prefixed framing —
 *      each token is emitted as `${token.length}:${token}` and the frames are
 *      concatenated. Length prefixing makes the serialisation injective: a
 *      token that itself contains the delimiter (e.g. a `\n`, or a literal
 *      `":"`) cannot forge the boundary between two other tokens, so distinct
 *      sets can never collide by accident of concatenation. (A plain `\n` join
 *      is NOT injective — `['a','b']` and `['a\nb']` would hash identically.)
 *   4. returns the lowercase hex SHA-256 of that canonical string.
 *
 * The same identity set in any order yields the same hash; adding or removing a
 * message changes it. The hash is one-way — the raw identity set is NOT
 * recoverable from it, which is why the cache can key on it without storing the
 * underlying mail identities. NOTE: the hash is NOT account-scoped on its own;
 * account isolation is enforced at the SQL layer via the composite
 * `(account_id, thread_hash)` key — see {@link getThreadSummary} /
 * {@link upsertThreadSummary} and the `ai_summaries` schema block.
 *
 * Throws if the identity set is empty after normalisation: a thread with no
 * usable identity token has no stable key, and silently hashing the empty
 * string would collapse all such threads onto one cache row.
 */
export function computeThreadHash(identityTokens: readonly string[]): string {
  const normalized = Array.from(
    new Set(identityTokens.map(t => t.trim()).filter(t => t.length > 0)),
  ).sort()
  if (normalized.length === 0) {
    throw new Error('computeThreadHash: identity set is empty after normalisation')
  }
  // Length-prefixed framing (`${len}:${token}` per frame) is injective: no
  // token content can forge a frame boundary, so distinct sets never collide.
  const canonical = normalized.map(tok => `${tok.length}:${tok}`).join('')
  return createHash('sha256').update(canonical).digest('hex')
}

function rowToThreadSummary(r: Record<string, unknown>): ThreadSummaryRow {
  let bullets: string[] = []
  const raw = r.bullets
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        bullets = parsed.filter((b): b is string => typeof b === 'string')
      }
    } catch {
      // Corrupt cache row — treat as no bullets rather than throwing on read.
      bullets = []
    }
  }
  return {
    threadHash: r.thread_hash as string,
    accountId: r.account_id as string,
    oneLine: (r.one_line as string) ?? '',
    bullets,
    provider: r.provider as string,
    createdAt: Number(r.created_at),
  }
}

/**
 * Insert or replace the cached summary for a thread, keyed by the composite
 * `(accountId, threadHash)`. On conflict (same account AND same thread hash)
 * every field is overwritten, so a fresh generation supersedes a stale cache
 * entry — but ONLY within the same account. A colliding `threadHash` under a
 * different `accountId` inserts a distinct row and never overwrites another
 * account's summary. Returns the persisted row.
 */
export function upsertThreadSummary(input: ThreadSummaryInput): ThreadSummaryRow {
  const createdAt = input.createdAt ?? Date.now()
  const bulletsJson = JSON.stringify(input.bullets)
  db.prepare(
    `INSERT INTO ai_summaries(account_id, thread_hash, one_line, bullets, provider, created_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, thread_hash) DO UPDATE SET
       one_line = excluded.one_line,
       bullets = excluded.bullets,
       provider = excluded.provider,
       created_at = excluded.created_at`,
  ).run(input.accountId, input.threadHash, input.oneLine, bulletsJson, input.provider, createdAt)
  return {
    threadHash: input.threadHash,
    accountId: input.accountId,
    oneLine: input.oneLine,
    bullets: input.bullets,
    provider: input.provider,
    createdAt,
  }
}

/**
 * Return the cached summary for `threadHash` OWNED BY `accountId`, or
 * `undefined` if none exists for that account. Account scoping is enforced at
 * the query level (`WHERE account_id=? AND thread_hash=?`), so a hash that
 * happens to collide across accounts can never return another account's row —
 * this is the read-side half of the cross-account isolation invariant (the
 * write-side half is the composite key in {@link upsertThreadSummary}).
 */
export function getThreadSummary(accountId: string, threadHash: string): ThreadSummaryRow | undefined {
  const row = db.prepare(`SELECT * FROM ai_summaries WHERE account_id=? AND thread_hash=?`)
    .get(accountId, threadHash) as Record<string, unknown> | undefined
  return row ? rowToThreadSummary(row) : undefined
}

// --- Mail Rules (B2.24) ---

export type MailRuleRow = {
  id: string
  accountId: string | null
  name: string
  enabled: boolean
  priority: number
  conditions: string
  actions: string
  stopProcessing: boolean
  createdAt: string
  updatedAt: string
}

function rowToMailRule(r: Record<string, unknown>): MailRuleRow {
  return {
    id: r.id as string,
    accountId: (r.account_id as string) ?? null,
    name: r.name as string,
    enabled: (r.enabled as number) === 1,
    priority: (r.priority as number) ?? 0,
    conditions: r.conditions as string,
    actions: r.actions as string,
    stopProcessing: (r.stop_processing as number) === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

export function listMailRules(accountId?: string): MailRuleRow[] {
  if (accountId != null) {
    const rows = db.prepare(
      `SELECT * FROM mail_rules WHERE account_id = ? OR account_id IS NULL ORDER BY priority ASC, id ASC`
    ).all(accountId) as Record<string, unknown>[]
    return rows.map(rowToMailRule)
  }
  const rows = db.prepare(
    `SELECT * FROM mail_rules ORDER BY priority ASC, id ASC`
  ).all() as Record<string, unknown>[]
  return rows.map(rowToMailRule)
}

export function getMailRule(id: string): MailRuleRow | undefined {
  const row = db.prepare(`SELECT * FROM mail_rules WHERE id=?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToMailRule(row) : undefined
}

export function createMailRule(data: {
  accountId?: string | null
  name: string
  conditions: string
  actions: string
  priority?: number
  stopProcessing?: boolean
}): MailRuleRow {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO mail_rules(id, account_id, name, enabled, priority, conditions, actions, stop_processing, created_at, updated_at)
    VALUES(?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.accountId ?? null,
    data.name,
    data.priority ?? 0,
    data.conditions,
    data.actions,
    data.stopProcessing ? 1 : 0,
    now,
    now,
  )
  return getMailRule(id)!
}

export function updateMailRule(id: string, patch: {
  accountId?: string | null
  name?: string
  enabled?: boolean
  priority?: number
  conditions?: string
  actions?: string
  stopProcessing?: boolean
}): MailRuleRow | undefined {
  const existing = getMailRule(id)
  if (!existing) return undefined
  const now = new Date().toISOString()
  const accountId = patch.accountId !== undefined ? patch.accountId : existing.accountId
  const name = patch.name ?? existing.name
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (existing.enabled ? 1 : 0)
  const priority = patch.priority ?? existing.priority
  const conditions = patch.conditions ?? existing.conditions
  const actions = patch.actions ?? existing.actions
  const stopProcessing = patch.stopProcessing !== undefined ? (patch.stopProcessing ? 1 : 0) : (existing.stopProcessing ? 1 : 0)
  db.prepare(`
    UPDATE mail_rules SET account_id=?, name=?, enabled=?, priority=?, conditions=?, actions=?, stop_processing=?, updated_at=?
    WHERE id=?
  `).run(accountId, name, enabled, priority, conditions, actions, stopProcessing, now, id)
  return getMailRule(id)
}

export function deleteMailRule(id: string): boolean {
  return db.prepare(`DELETE FROM mail_rules WHERE id=?`).run(id).changes > 0
}

/** Retrieve cached messages for rule dry-run testing.
 *  @param folder — restrict to a specific folder (default: 'INBOX')
 */
export function getMessagesForRuleTest(accountId?: number, limit = 500, folder = 'INBOX'): Array<{
  accountId: number; folder: string; uid: number; subject: string;
  from: string; fromAddr: string; toAddr: string | null;
  hasAttachments: boolean;
}> {
  const conditions: string[] = [`folder_path = ?`]
  const params: unknown[] = [folder]
  if (accountId != null) {
    conditions.push(`account_id = ?`)
    params.push(accountId)
  }
  params.push(limit)
  const sql = `SELECT account_id, folder_path, uid, subject, from_addr, from_name, to_addr, has_attachments FROM messages WHERE ${conditions.join(' AND ')} ORDER BY uid DESC LIMIT ?`
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>
  return rows.map(r => ({
    accountId: r.account_id as number,
    folder: r.folder_path as string,
    uid: r.uid as number,
    subject: (r.subject as string) || '',
    from: (r.from_name as string) || (r.from_addr as string) || '',
    fromAddr: (r.from_addr as string) || '',
    toAddr: (r.to_addr as string) || null,
    hasAttachments: (r.has_attachments as number) === 1,
  }))
}

// --- AI Rules (B2.24) ---

export type AiRuleRow = {
  id: string
  accountId: string | null
  name: string
  enabled: boolean
  prompt: string
  allowedActions: string
  budgetPerDayUsd: number
  createdAt: string
  updatedAt: string
}

function rowToAiRule(r: Record<string, unknown>): AiRuleRow {
  return {
    id: r.id as string,
    accountId: (r.account_id as string) ?? null,
    name: r.name as string,
    enabled: (r.enabled as number) === 1,
    prompt: r.prompt as string,
    allowedActions: r.allowed_actions as string,
    budgetPerDayUsd: (r.budget_per_day_usd as number) ?? 0.5,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

export function listAiRules(accountId?: string): AiRuleRow[] {
  if (accountId != null) {
    const rows = db.prepare(
      `SELECT * FROM ai_rules WHERE account_id = ? OR account_id IS NULL ORDER BY name ASC, id ASC`
    ).all(accountId) as Record<string, unknown>[]
    return rows.map(rowToAiRule)
  }
  const rows = db.prepare(
    `SELECT * FROM ai_rules ORDER BY name ASC, id ASC`
  ).all() as Record<string, unknown>[]
  return rows.map(rowToAiRule)
}

export function getAiRule(id: string): AiRuleRow | undefined {
  const row = db.prepare(`SELECT * FROM ai_rules WHERE id=?`).get(id) as Record<string, unknown> | undefined
  return row ? rowToAiRule(row) : undefined
}

/**
 * Throw a machine-detectable error if enabling the rule identified by
 * `candidateId` (scoped to `candidateAccountId`) would push any affected account
 * past `AI_RULE_MAX_ENABLED_PER_ACCOUNT` (§2.39). The atomic-per-account
 * pipeline requires a full account rule set to fit one hourly window; this cap
 * is what keeps that guarantee.
 *
 * The thrown Error's message STARTS with `AI_RULE_ENABLED_LIMIT_ERROR` so the
 * renderer can detect it across IPC (where Electron re-wraps the message) and
 * show a localized string. The count logic itself is the pure `canEnableAiRule`
 * from packages/core.
 */
function assertAiRuleEnablementAllowed(
  candidateId: string,
  candidateAccountId: string | null,
): void {
  // The candidate may not yet be stored (create path). Build the "existing" set
  // from all stored rules, excluding any row with the candidate id (so a stored
  // candidate is not double-counted), then let `canEnableAiRule` re-add it as
  // the enabled candidate.
  const stored = listAiRules()
    .filter((r) => r.id !== candidateId)
    .map<AiRuleEnabledScope>((r) => ({
      id: r.id,
      accountId: r.accountId,
      enabled: r.enabled,
    }))
  const allowed = canEnableAiRule(stored, candidateId, {
    accountId: candidateAccountId,
  })
  if (!allowed) {
    throw new Error(
      `${AI_RULE_ENABLED_LIMIT_ERROR}: too many enabled AI rules for this account`,
    )
  }
}

/**
 * Create an AI rule. `enabled` is ALWAYS written explicitly (0/1) — never left
 * to the column default — so the "disabled by default" invariant holds even on
 * legacy DBs whose schema still carries `DEFAULT 1`
 * (see `runAiRulesEnabledDefaultOffMigrationV1`, which also hardens the schema
 * default to 0). Do NOT add a raw `INSERT INTO ai_rules` elsewhere that omits
 * `enabled`; go through this function so the opt-in invariant is enforced in
 * one place.
 */
export function createAiRule(data: {
  accountId?: string | null
  name: string
  prompt: string
  allowedActions: string
  budgetPerDayUsd?: number
  /** §2.39: defaults to false — a new rule is inactive until the user
   *  explicitly enables it. */
  enabled?: boolean
}): AiRuleRow {
  const id = randomUUID()
  // §2.39: enforce the per-account enabled-rule cap when a rule is created
  // ALREADY enabled. A disabled create can never breach the cap (no enabled
  // count changes), so it is always allowed. The pure `canEnableAiRule` check
  // treats the new (not-yet-stored) rule as the candidate.
  if (data.enabled) {
    assertAiRuleEnablementAllowed(id, data.accountId ?? null)
  }
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO ai_rules(id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.accountId ?? null,
    data.name,
    data.enabled ? 1 : 0,
    data.prompt,
    data.allowedActions,
    data.budgetPerDayUsd ?? 0.5,
    now,
    now,
  )
  return getAiRule(id)!
}

export function updateAiRule(id: string, patch: {
  name?: string
  enabled?: boolean
  prompt?: string
  allowedActions?: string
  budgetPerDayUsd?: number
}): AiRuleRow | undefined {
  const existing = getAiRule(id)
  if (!existing) return undefined
  // §2.39: enforce the per-account enabled-rule cap on the enable transition.
  // Only a change that turns the rule ON (from disabled to enabled) can breach
  // the cap; disabling, or editing an already-enabled rule, never increases any
  // account's enabled count, so those are unconditionally allowed. Account scope
  // is immutable via this patch (no `accountId` field), so the existing scope is
  // authoritative.
  if (patch.enabled === true && !existing.enabled) {
    assertAiRuleEnablementAllowed(id, existing.accountId)
  }
  const now = new Date().toISOString()
  const name = patch.name ?? existing.name
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (existing.enabled ? 1 : 0)
  const prompt = patch.prompt ?? existing.prompt
  const allowedActions = patch.allowedActions ?? existing.allowedActions
  const budgetPerDayUsd = patch.budgetPerDayUsd ?? existing.budgetPerDayUsd
  db.prepare(`
    UPDATE ai_rules SET name=?, enabled=?, prompt=?, allowed_actions=?, budget_per_day_usd=?, updated_at=?
    WHERE id=?
  `).run(name, enabled, prompt, allowedActions, budgetPerDayUsd, now, id)
  return getAiRule(id)
}

export function deleteAiRule(id: string): boolean {
  return db.prepare(`DELETE FROM ai_rules WHERE id=?`).run(id).changes > 0
}

// --- AI Rule Log ---

export type AiRuleLogRow = {
  id: number
  aiRuleId: string
  accountId: string
  folder: string
  uid: number
  actionTaken: string
  reasoning: string | null
  costUsd: number | null
  createdAt: string
}

function rowToAiRuleLog(r: Record<string, unknown>): AiRuleLogRow {
  return {
    id: r.id as number,
    aiRuleId: r.ai_rule_id as string,
    accountId: r.account_id as string,
    folder: r.folder as string,
    uid: r.uid as number,
    actionTaken: r.action_taken as string,
    reasoning: (r.reasoning as string) ?? null,
    costUsd: typeof r.cost_usd === 'number' ? r.cost_usd : null,
    createdAt: r.created_at as string,
  }
}

export function insertAiRuleLog(data: {
  aiRuleId: string
  accountId: string
  folder: string
  uid: number
  actionTaken: string
  reasoning?: string
  costUsd?: number
}): AiRuleLogRow {
  const now = new Date().toISOString()
  const res = db.prepare(`
    INSERT INTO ai_rule_log(ai_rule_id, account_id, folder, uid, action_taken, reasoning, cost_usd, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.aiRuleId,
    data.accountId,
    data.folder,
    data.uid,
    data.actionTaken,
    data.reasoning ?? null,
    data.costUsd ?? null,
    now,
  )
  return {
    id: Number(res.lastInsertRowid),
    aiRuleId: data.aiRuleId,
    accountId: data.accountId,
    folder: data.folder,
    uid: data.uid,
    actionTaken: data.actionTaken,
    reasoning: data.reasoning ?? null,
    costUsd: data.costUsd ?? null,
    createdAt: now,
  }
}

export function listAiRuleLog(limit: number): AiRuleLogRow[] {
  const rows = db.prepare(
    `SELECT * FROM ai_rule_log ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as Record<string, unknown>[]
  return rows.map(rowToAiRuleLog)
}

/**
 * Sum the real dollar spend of background AI-rule model calls since a given
 * ISO timestamp. §2.39: cost is now derived from provider-reported token
 * usage and mirrored into the append-only `ai_action_log` audit table (one
 * row per model call, `goal='rule'`), so the daily-budget check reads actual
 * spend rather than the old hard-coded per-action estimate that lived in
 * `ai_rule_log`. Soft-deleted audit rows still count toward spend — deleting
 * an audit entry must not reset the budget.
 */
export function sumAiRuleCostSince(sinceIso: string): number {
  // `ai_action_log.created_at` is written via SQLite `datetime('now')`
  // (`YYYY-MM-DD HH:MM:SS`, UTC), whereas the caller passes a JS ISO string
  // (`YYYY-MM-DDTHH:MM:SS.sssZ`). A raw string `>=` would mis-order the two
  // formats (space 0x20 < 'T' 0x54). Normalise BOTH sides through SQLite's
  // `datetime()` so the comparison is a real timestamp comparison.
  const row = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM ai_action_log
      WHERE goal = 'rule' AND datetime(created_at) >= datetime(?)`
  ).get(sinceIso) as { total: number } | undefined
  return row?.total ?? 0
}

// --- Static Rule Execution Log ---

db.exec(`
CREATE TABLE IF NOT EXISTS rule_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  folder TEXT NOT NULL,
  uid INTEGER NOT NULL,
  subject TEXT,
  from_addr TEXT,
  action_taken TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rule_log_date ON rule_log(created_at);
CREATE INDEX IF NOT EXISTS idx_rule_log_rule ON rule_log(rule_id);
`)

export type RuleLogRow = {
  id: number
  ruleId: string
  ruleName: string
  accountId: number
  folder: string
  uid: number
  subject: string | null
  fromAddr: string | null
  actionTaken: string
  createdAt: string
}

function rowToRuleLog(r: Record<string, unknown>): RuleLogRow {
  return {
    id: r.id as number,
    ruleId: r.rule_id as string,
    ruleName: r.rule_name as string,
    accountId: r.account_id as number,
    folder: r.folder as string,
    uid: r.uid as number,
    subject: (r.subject as string) ?? null,
    fromAddr: (r.from_addr as string) ?? null,
    actionTaken: r.action_taken as string,
    createdAt: r.created_at as string,
  }
}

export function insertRuleLog(data: {
  ruleId: string; ruleName: string; accountId: number; folder: string;
  uid: number; subject?: string; fromAddr?: string; actionTaken: string;
}): void {
  db.prepare(`
    INSERT INTO rule_log(rule_id, rule_name, account_id, folder, uid, subject, from_addr, action_taken, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.ruleId,
    data.ruleName,
    data.accountId,
    data.folder,
    data.uid,
    data.subject ?? null,
    data.fromAddr ?? null,
    data.actionTaken,
    new Date().toISOString(),
  )
}

export function listRuleLog(limit: number, ruleId?: string): RuleLogRow[] {
  if (ruleId != null) {
    const rows = db.prepare(
      `SELECT * FROM rule_log WHERE rule_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(ruleId, limit) as Record<string, unknown>[]
    return rows.map(rowToRuleLog)
  }
  const rows = db.prepare(
    `SELECT * FROM rule_log ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as Record<string, unknown>[]
  return rows.map(rowToRuleLog)
}

export function clearRuleLog(olderThanDays?: number): number {
  if (olderThanDays != null && olderThanDays > 0) {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString()
    return db.prepare(`DELETE FROM rule_log WHERE created_at < ?`).run(cutoff).changes
  }
  return db.prepare(`DELETE FROM rule_log`).run().changes
}

// --- Pin emails (B2.24) ---

export function setPinned(accountId: number, folder: string, uid: number, pinned: boolean): void {
  db.prepare(
    `UPDATE messages SET pinned = ? WHERE account_id = ? AND folder_path = ? AND uid = ?`
  ).run(pinned ? 1 : 0, accountId, folder, uid)
}

// --- Notification Center ---

export type NotificationRow = {
  id: number
  type: string
  title: string
  body: string
  refId: string | null
  read: boolean
  createdAt: string
}

function rowToNotification(r: Record<string, unknown>): NotificationRow {
  return {
    id: r.id as number,
    type: r.type as string,
    title: r.title as string,
    body: (r.body as string) ?? '',
    refId: (r.ref_id as string) ?? null,
    read: !!(r.read as number),
    createdAt: r.created_at as string,
  }
}

export function insertNotification(
  type: string,
  title: string,
  body: string,
  refId?: string,
): number {
  const now = new Date().toISOString()
  const res = db.prepare(`
    INSERT INTO notifications(type, title, body, ref_id, read, created_at)
    VALUES(?, ?, ?, ?, 0, ?)
  `).run(type, title, body, refId ?? null, now)
  return Number(res.lastInsertRowid)
}

export function listNotifications(limit = 50): NotificationRow[] {
  const rows = db.prepare(
    `SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as Record<string, unknown>[]
  return rows.map(rowToNotification)
}

export function countUnreadNotifications(): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt FROM notifications WHERE read=0`
  ).get() as { cnt: number }
  return row.cnt
}

export function markNotificationRead(id: number): boolean {
  return db.prepare(
    `UPDATE notifications SET read=1 WHERE id=?`
  ).run(id).changes > 0
}

export function markAllNotificationsRead(): number {
  return db.prepare(
    `UPDATE notifications SET read=1 WHERE read=0`
  ).run().changes
}

export function deleteNotification(id: number): boolean {
  return db.prepare(`DELETE FROM notifications WHERE id=?`).run(id).changes > 0
}

export function purgeOldNotifications(olderThanDays = 30): number {
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString()
  return db.prepare(`DELETE FROM notifications WHERE created_at < ?`).run(cutoff).changes
}

// ---------------------------------------------------------------------------
// One-time data migrations (placed at end-of-file because they depend on
// helpers defined above — `upsertFolderPref`, `getAllCachedFolderRoles`,
// `getAllCachedMailboxes`). Each migration is gated by a `schema_migrations`
// row so it executes exactly once per DB file. NEVER add logic here that
// re-runs after the migration row is written; that is the whole point of
// the gate. Add new migrations as new exported helper functions and call
// them from the runner below.
// ---------------------------------------------------------------------------

/**
 * §2.15-ter security follow-up (codex iter6 Medium): when the
 * `index_in_search` column was first introduced (2026-04, ALTER TABLE …
 * ADD COLUMN … DEFAULT 1), every existing folder_prefs row inherited
 * `index_in_search=1`. Newly-created prefs go through `defaultFolderPref()`
 * in main.ts which auto-disables Junk/Trash, but pre-existing rows on
 * upgrade-from-baseline accounts stayed indexed — Spam/Trash content kept
 * polluting search. This migration runs once per DB:
 *   1. Reads cached role hints (cached_roles + cached_mailboxes specialUse).
 *   2. For every (account, folder) pair classified as Junk/Trash, if the
 *      pref row still has `index_in_search=1` (default value, indicating
 *      the user has not explicitly opted in to Junk/Trash search),
 *      flips it to 0 via `upsertFolderPref` so the FTS purge transaction
 *      runs alongside the column update.
 *   3. Marks the migration applied; subsequent app starts are no-ops.
 *
 * IMPORTANT — this migration must NOT re-flip a folder after the user
 * explicitly re-enabled search on Junk/Trash (or after a future override
 * mechanism flips it back). The single-shot `schema_migrations` gate
 * guarantees that: once the row is written, this function returns early
 * forever. There is no per-row "user-modified" marker — we rely on the
 * gate, not on row-level state, to guarantee idempotency.
 *
 * Folder role classification falls back to two sources, in priority order:
 *   - `cached_roles.roles_json` (server-detected roles, populated by
 *     `cacheFolderRoles` after the first sync).
 *   - `cached_mailboxes.mailboxes_json[].specialUse` (RFC 6154 SPECIAL-USE
 *     flags `\Junk` / `\Trash`).
 *
 * Accounts with empty caches at migration time will not be touched by
 * this run — but those accounts also have no folder_prefs rows yet
 * (caches and prefs are populated together by `ensureFolderPrefs`), so
 * they go through the new-pref code path which already auto-disables
 * Junk/Trash. The empty-cache case is therefore not a gap.
 */
function runJunkTrashDefaultOffMigrationV1(): void {
  const MIGRATION_NAME = 'migrate_junk_trash_default_off_v1'
  if (isSchemaMigrationApplied(MIGRATION_NAME)) return

  // Wrap classification + upsertFolderPref calls + marker write in a
  // single transaction so a crash mid-flight cannot leave the DB in a
  // half-migrated state where some rows flipped but the marker did not
  // land (next start would re-flip rows the user just toggled back on).
  db.transaction(() => {
    // Build (accountId, folderPath) -> role classification ('junk'|'trash'|null).
    const targets = new Map<string, { accountId: number; folderPath: string; role: 'junk' | 'trash' }>()
    const key = (accountId: number, folderPath: string) => `${accountId}:${folderPath}`

    // Source 1: cached_roles. roles_json has shape { junk?: string, trash?: string, ... }
    const allRoles = getAllCachedFolderRoles()
    for (const [accountIdStr, roles] of Object.entries(allRoles)) {
      const accountId = Number(accountIdStr)
      if (!Number.isFinite(accountId)) continue
      const junkPath = roles.junk
      const trashPath = roles.trash
      if (typeof junkPath === 'string' && junkPath.length > 0) {
        targets.set(key(accountId, junkPath), { accountId, folderPath: junkPath, role: 'junk' })
      }
      if (typeof trashPath === 'string' && trashPath.length > 0) {
        targets.set(key(accountId, trashPath), { accountId, folderPath: trashPath, role: 'trash' })
      }
    }

    // Source 2: cached_mailboxes specialUse flags (\\Junk / \\Trash).
    const allMailboxes = getAllCachedMailboxes()
    for (const [accountIdStr, mailboxes] of Object.entries(allMailboxes)) {
      const accountId = Number(accountIdStr)
      if (!Number.isFinite(accountId)) continue
      for (const mb of mailboxes) {
        if (!mb || typeof mb.path !== 'string' || mb.path.length === 0) continue
        if (mb.specialUse === '\\Junk') {
          targets.set(key(accountId, mb.path), { accountId, folderPath: mb.path, role: 'junk' })
        } else if (mb.specialUse === '\\Trash') {
          targets.set(key(accountId, mb.path), { accountId, folderPath: mb.path, role: 'trash' })
        }
      }
    }

    // Apply: only flip rows that exist AND are still at index_in_search=1.
    // We read each row first instead of bulk UPDATE because upsertFolderPref
    // (1) carries the FTS reconciliation (true→false purge), (2) cache
    // invalidation, (3) updated_at refresh — duplicating those pieces here
    // would be a stability liability.
    const checkStmt = db.prepare(
      `SELECT 1 AS v FROM folder_prefs WHERE account_id=? AND folder_path=? AND index_in_search=1`,
    )
    for (const t of targets.values()) {
      const exists = checkStmt.get(t.accountId, t.folderPath) as { v: number } | undefined
      if (!exists) continue
      upsertFolderPref(t.accountId, t.folderPath, { indexInSearch: false })
    }

    markSchemaMigrationApplied(MIGRATION_NAME)
  })()
}

/**
 * Test-only entry point for {@link runJunkTrashDefaultOffMigrationV1}. Tests
 * cannot trigger the module-init run because the migration is one-shot
 * gated and the gate is already armed by the time `loadDbModule` returns.
 * This helper lets tests reset the gate and re-execute against
 * test-controlled `cached_roles` / `cached_mailboxes` / `folder_prefs`
 * fixtures. Production code MUST NOT call this (the leading `__` is the
 * convention used by `__resetIndexInSearchCacheForTest`).
 */
export function __runJunkTrashDefaultOffMigrationV1ForTest(): void {
  db.prepare(`DELETE FROM schema_migrations WHERE name=?`).run('migrate_junk_trash_default_off_v1')
  runJunkTrashDefaultOffMigrationV1()
}

/** Test-only inspector: returns true iff the migration row exists. */
export function __isJunkTrashDefaultOffMigrationV1AppliedForTest(): boolean {
  return isSchemaMigrationApplied('migrate_junk_trash_default_off_v1')
}

try {
  runJunkTrashDefaultOffMigrationV1()
} catch {
  // A failed one-time data migration must not crash module-init — that
  // would brick the whole app over a Spam/Trash polish pass. The
  // migration row stays absent on failure, so it will retry on the next
  // start (idempotent by construction: re-running on already-flipped
  // rows is a no-op because the `index_in_search=1` filter excludes
  // already-flipped rows). We deliberately do not log here — the DB
  // module has no logger dependency by design (used from main + tests).
}

/** Read a column's declared DEFAULT expression from PRAGMA table_info. Returns
 *  the raw `dflt_value` string (e.g. `'0'`, `'1'`, `'0.50'`) or null when the
 *  column has no default / does not exist. Table/column names are validated to
 *  match a bare SQL identifier before interpolation. */
function columnDefault(table: string, column: string): string | null {
  if (!/^[a-zA-Z_]\w*$/.test(table)) throw new Error(`Invalid table name: ${table}`)
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name?: unknown
    dflt_value?: unknown
  }>
  const row = rows.find((r) => r.name === column)
  if (!row) return null
  return row.dflt_value == null ? null : String(row.dflt_value)
}

/**
 * §2.39 — enforce the "AI rules are DISABLED by default" invariant at the DB
 * schema level for UPGRADED installations.
 *
 * `CREATE TABLE IF NOT EXISTS ai_rules(... enabled INTEGER DEFAULT 0 ...)` only
 * applies its column default to FRESH databases. An install created before
 * §2.39 still carries the old `DEFAULT 1`, so a raw
 * `INSERT INTO ai_rules(...)` that omitted `enabled` would silently create an
 * ENABLED rule — a background pipeline that calls a model on untrusted email
 * content and can auto-apply actions. `createAiRule` always writes `enabled`
 * explicitly (0/1), so this is not reachable through the app today, but the
 * invariant "a rule cannot become enabled without an explicit opt-in" must
 * hold at the storage layer, not just by caller discipline.
 *
 * SQLite cannot `ALTER COLUMN` a default, so we rebuild the table only when the
 * declared default is still `1`, preserving every existing row's values
 * (an already-enabled rule stays enabled; a disabled rule stays disabled) and
 * declaring the new default `0`. Guarded by a named migration marker AND by the
 * observed default, so it runs at most once and is a no-op on fresh DBs.
 */
function runAiRulesEnabledDefaultOffMigrationV1(): void {
  const MIGRATION_NAME = 'migrate_ai_rules_enabled_default_off_v1'
  if (isSchemaMigrationApplied(MIGRATION_NAME)) return

  const currentDefault = columnDefault('ai_rules', 'enabled')
  // Fresh DBs (created by the current schema) already have DEFAULT 0 → nothing
  // to rebuild; just mark the migration applied so we never re-check.
  if (currentDefault === null || currentDefault === '0') {
    markSchemaMigrationApplied(MIGRATION_NAME)
    return
  }

  db.transaction(() => {
    // Rebuild ai_rules with the hardened schema, preserving all rows verbatim.
    // Rename → recreate → copy → drop is the standard SQLite column-alter
    // pattern. Foreign keys are not defined on ai_rules, so no FK dance needed.
    db.exec(`ALTER TABLE ai_rules RENAME TO ai_rules_legacy_pre239`)
    db.exec(`
      CREATE TABLE ai_rules(
        id TEXT PRIMARY KEY,
        account_id TEXT,
        name TEXT NOT NULL,
        enabled INTEGER DEFAULT 0,
        prompt TEXT NOT NULL,
        allowed_actions TEXT NOT NULL,
        budget_per_day_usd REAL DEFAULT 0.50,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    db.exec(`
      INSERT INTO ai_rules(id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at)
      SELECT id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at
        FROM ai_rules_legacy_pre239
    `)
    db.exec(`DROP TABLE ai_rules_legacy_pre239`)
    markSchemaMigrationApplied(MIGRATION_NAME)
  })()
}

try {
  runAiRulesEnabledDefaultOffMigrationV1()
} catch {
  // A failed schema-hardening migration must not crash module-init. The
  // marker stays absent on failure, so it retries next start. No logger
  // dependency in the DB module by design.
}

/** Test-only: reset the gate and re-run the ai_rules enabled-default migration
 *  against a test-controlled schema. Production code MUST NOT call this. */
export function __runAiRulesEnabledDefaultOffMigrationV1ForTest(): void {
  db.prepare(`DELETE FROM schema_migrations WHERE name=?`).run('migrate_ai_rules_enabled_default_off_v1')
  runAiRulesEnabledDefaultOffMigrationV1()
}

/** Test-only inspector: the declared DEFAULT of ai_rules.enabled. */
export function __aiRulesEnabledColumnDefaultForTest(): string | null {
  return columnDefault('ai_rules', 'enabled')
}

export default db
