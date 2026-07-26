/**
 * Single source of truth for product & health telemetry.
 *
 * Every call to recordEvent / recordHistogram / recordGauge must reference
 * a name registered here, with a matching `kind`, and with tags whose keys
 * are a subset of the event's `tags` spec. This is enforced both at compile
 * time via typed wrappers in metrics.ts and at CI time via
 * scripts/check-telemetry-schema.mjs.
 *
 * Privacy inviolables — if you break these, it's a security bug:
 *   - No content: no query text, subject, body, email addresses, folder
 *     paths, filenames, UIDs, message ids, AI memory content.
 *   - Only structural fields: enums, counts, durations, buckets, booleans,
 *     canonical folder roles (inbox/sent/archive/...), provider kinds.
 *   - Account identity, if needed, is an integer id — never the email.
 *   - Install identity is a hashed UUID emitted ONLY in session events.
 */

// --- Low-cardinality enum domains ------------------------------------------

export const DOMAINS = {
  platform:     ['linux', 'darwin', 'win32'] as const,
  theme:        ['light', 'dark'] as const,
  scope:        ['folder', 'unified_inbox', 'unified_all'] as const,
  sort:         ['relevance', 'date'] as const,
  folder_role:  ['inbox', 'sent', 'archive', 'drafts', 'trash', 'spam', 'other'] as const,
  provider:     ['gmail', 'icloud', 'yandex', 'mailru', 'outlook', 'other'] as const,
  auth_type:    ['oauth', 'password', 'app_password'] as const,
  mail_action:  ['archive', 'delete', 'move', 'spam', 'read', 'unread', 'flag', 'unflag', 'pin', 'unpin', 'snooze', 'read_later', 'followup'] as const,
  action_src:   ['toolbar', 'hover', 'keyboard', 'context_menu', 'ai', 'rule', 'undo'] as const,
  ai_chip:      ['summarize', 'draft_reply', 'translate', 'gtd_classify', 'gtd_triage', 'weekly_review', 'cleanup_all', 'custom'] as const,
  send_failure_kind: ['auth', 'tls', 'network', 'rate_limit', 'permanent', 'unknown'] as const,
  compose_source: ['new', 'reply', 'reply_all', 'forward', 'mailto', 'template', 'ai_chip', 'draft'] as const,
  onboarding_method: ['oauth', 'manual'] as const,
  session_end_reason: ['quit', 'update', 'crash'] as const,
  misdirection_kind: ['external_domain', 'new_recipients_in_reply'] as const,
  misdirection_outcome: ['accepted', 'cancelled'] as const,
  search_error_kind: ['cancelled', 'error'] as const,
  auth_refresh_failure_reason: ['refresh_token_expired', 'network', 'unknown'] as const,
  auth_refresh_provider: ['outlook', 'google'] as const,
  auth_refresh_suppressed_reason: ['cooldown'] as const,
  // TLS trust rework — did the pin-time certificate capture produce a usable
  // trust anchor? A fingerprint-only pin cannot make a self-signed server
  // verify (buildTlsOptions needs the certificate body for `ca`), so a
  // population stuck on 'unavailable' means the recovery flow still fails
  // closed and the capture path needs a STARTTLS-capable probe.
  cert_pin_pem: ['captured', 'unavailable', 'mismatch'] as const,
  // Why a trust click did NOT end in a stored pin. `no_pending_offer` /
  // `offer_fingerprint_mismatch` are the authorization gate firing: something
  // asked to pin a certificate without an open recovery dialog for it, which
  // is either a UI bug or an attempt.
  cert_trust_reject_reason: [
    'fingerprint_mismatch',
    'pin_write_failed',
    'no_pending_offer',
    'offer_fingerprint_mismatch',
  ] as const,
  // Closed set of AI-budget denial reasons, produced by literals in
  // packages/db. Declared as a DOMAIN rather than a bare 'string' so the tag
  // cannot silently start carrying free text (account id, model name, error
  // message) if a future call site gets it wrong — the schema, not a comment,
  // is what holds the PII boundary.
  ai_reserve_denied_reason: ['over-cap', 'invalid-amount', 'ledger-write-failed'] as const,
  schema_kind:  ['event', 'histogram', 'gauge'] as const,
  // §2.17 Phase 0 — mail-open hot-path diagnosis. cache_hit_level identifies
  // which layer of the four-tier cache (in-memory LRU, DB JSON, on-disk EML,
  // IMAP fetch) actually served a `net:messageDetails` call. Same enum on
  // both sides of the IPC so renderer Sentry spans and main-side histogram
  // tags share a vocabulary. `imap_timeout` is reserved for the AbortController
  // 10s budget — distinguishes "served from network" from "fell back to
  // headers because the network was too slow".
  cache_hit_level: ['memory', 'db', 'eml', 'imap', 'imap_timeout'] as const,
  // §2.17 Phase 0 — pool wait timing requester tag. Identifies which
  // subsystem was waiting on the per-account IMAP pool semaphore. Phase 0
  // records timing only; Phase 1 will use this tag to give the interactive
  // tier priority over background indexer / sync.
  imap_pool_requester: ['interactive', 'background', 'indexer', 'sync', 'other'] as const,
  // §3.10 P0: every mutating MCP tool now goes through preview→apply.
  // The `kind` tag identifies which family of action audit events refer to.
  // Adding a new mutating tool? Add the tag here AND in
  // electron/services/aiPendingActions.ts → PendingActionKind.
  ai_action_kind: [
    'mail_action', 'unsubscribe', 'send_email', 'move_email',
    'snooze_email', 'unsnooze_email',
    'flag_email', 'mark_read_later',
    'add_followup', 'dismiss_followup',
    'create_mail_rule', 'update_mail_rule', 'delete_mail_rule',
  ] as const,
  // Why an apply was rejected at the apply-time validation gate. Low-
  // cardinality. `unknown` is a fallback for forward-compat — new failure
  // modes can ship without a schema bump in the same PR.
  ai_action_reject_reason: [
    'preview_not_found',
    'preview_expired',
    'kind_mismatch',
    'token_missing',
    'token_mismatch',
    'token_expired',
    'rate_limit',
    'callback_missing',
    'unknown',
  ] as const,
  // §2.19 iter4 — bucketed enum domains for update.* events. Mirrors the
  // taxonomy returned by `classifyUpdateError` in services/updateCheck.ts and
  // by the renderer-facing IPC `error_class` field. Privacy invariant:
  // telemetry tags must be enums, not raw error messages — raw updater text
  // can include install paths, version strings, server hostnames, usernames,
  // and stderr fragments. The `update.*` events are also `mainOnly: true`,
  // so the renderer cannot emit them at all (defense in depth).
  update_check_source:    ['auto', 'manual'] as const,
  update_check_result:    ['up-to-date', 'available', 'error'] as const,
  update_error_class:     ['network', 'permission', 'unknown'] as const,
  update_install_outcome: ['success', 'deferred', 'failed'] as const,
  // §3.3 B1 Privacy Audit Panel — bucketed enums for the audit-log export
  // and entry-deletion events. Both events are emitted from main only, so
  // the renderer cannot influence the tag values directly.
  ai_audit_export_format: ['json', 'csv'] as const,
  ai_audit_delete_scope:  ['single', 'all'] as const,
  // §2.39 — background AI-rule pipeline. `ai_rule_action` is the reversible
  // action set the pipeline may auto-apply (destructive trash/mark_spam never
  // auto-apply — see `ai_rule_destructive_action`). Both are emitted from main
  // only; the background pipeline lives in electron/main.ts and the renderer
  // never has a reason to record these.
  ai_rule_action: ['archive', 'move', 'mark_read', 'mark_starred'] as const,
  ai_rule_destructive_action: ['trash', 'mark_spam'] as const,
  // §3.3 B2 Thread AI Summary — AI provider identity for the summary span.
  // Distinct from the mail-provider `provider` domain above (which is a mail
  // host taxonomy, NOT an AI provider). Emitted from main only. 'local' covers
  // the future on-device (T2.5 Ollama) path; the `was_local` boolean on the
  // span disambiguates it, but the provider id is still tagged for grouping.
  ai_provider: ['subscription', 'anthropic-api', 'openai-api', 'gemini-api', 'local', 'unknown'] as const,
  // §3.3 B2 — bucketed error taxonomy for the thread-summary span. Privacy
  // invariant: never a raw provider error message (which can carry hostnames /
  // model ids / stderr) — only these enumerated classes. 'none' is the success
  // outcome so the span always carries a defined error_class. Reused by the
  // §3.3 B4 quick-action / instant-reply spans below (same closed taxonomy —
  // 'none' success, 'provider_error' transport/no-result, 'parse_error' empty/
  // unusable output) so both features share one privacy-reviewed error domain.
  ai_summary_error_class: ['none', 'provider_error', 'parse_error'] as const,
  // §3.3 B4 Compose Quick Actions — which rewrite preset ran. Low-cardinality
  // enum (four presets) tagged for grouping; carries NO draft content, only the
  // preset identity the user picked. Emitted from main only.
  ai_quick_action_preset: ['improve', 'shorter', 'formal', 'grammar'] as const,
  // §2.20 PR1 — reasons why a *_preview tool early-returned without
  // registering a pending action. `empty_match` covers the "matched=0 /
  // scanned=0" case (refused to register an empty preview that would
  // surface as a useless empty confirmation panel and burn the register
  // rate-limit). Open enum so future early-skip reasons can ship without
  // a same-PR schema bump, but listed values are the canonical taxonomy.
  ai_action_preview_skipped_reason: ['empty_match'] as const,
  // §2.20 PR1 — bucketed enum for `ai.action.batch_size` cardinality
  // (accounts spanning a single multi-account preview, total emails in
  // a batch). Buckets match the small-int buckets used elsewhere in
  // metricsBuckets.ts (bucketCount), kept inline here as an enum so the
  // CI schema check rejects out-of-domain tag values at the IPC bridge.
  ai_action_batch_bucket: ['0', '1', '2', '3-5', '6-10', '11-20', '21-50', '51+'] as const,
  // §3.10 P2 — bucketed enums for the internet-tool interceptor metric
  // `ai.egress.intercepted`. Mirrors the catalogue in
  // `electron/services/aiInternetGate.ts` (`KNOWN_INTERCEPT_TOOL_TAGS` /
  // `normaliseToolTag`). The metric is `mainOnly: true`, so a compromised
  // renderer cannot emit it; this domain is the second-line guard that
  // rejects any out-of-enum value at the IPC bridge as well.
  ai_egress_tool_name: [
    'WebSearch',
    'WebFetch',
    'mcp__mailcopilot__list_external_tools',
    'mcp__mailcopilot__call_external_tool',
    'list_external_tools',
    'call_external_tool',
    'other',
  ] as const,
  ai_egress_outcome: ['approved', 'denied'] as const,
  // §2.22 Wave A — RSVP card response. Lower-case mirror of the `RsvpMethod`
  // type in @mailcopilot/types, kept here as its own low-cardinality enum so
  // the IPC bridge in electron/ipc.ts can reject any out-of-domain value
  // (defense in depth — the schema-level zod validation already enforces
  // it, but the metrics bridge applies a second check on every record).
  rsvp_method: ['accepted', 'tentative', 'declined'] as const,
  // §2.25 (re-diagnosis) — call-site tag for `links.external_open_suppressed`.
  // Mirrors the `source` argument threaded into the `openExternalGated` funnel
  // in electron/main.ts (one tag per shell.openExternal call site). Fixed,
  // low-cardinality, PII-clean by construction — never a URL. The metric is
  // `mainOnly: true`, so a compromised renderer cannot emit it; this domain is
  // the second-line guard that rejects any out-of-enum value at the IPC bridge.
  external_open_source: ['window_open', 'ui_ipc', 'update_dialog', 'unsubscribe', 'oauth'] as const,
  // §2.23 PR1 — Sent-copy APPEND failure buckets. SMTP delivery succeeded but
  // the IMAP APPEND of the copy into the Sent folder failed. `reason` is the
  // low-cardinality classification produced by classifySentCopyAppendFailure
  // in electron/services/sentCopyFailure.ts — NEVER raw server text (ImapFlow
  // responseText can echo folder names and other user/server strings).
  // `sent_copy_provider` mirrors the closed `providerId` union on
  // AccountConfig in @mailcopilot/types ('gmail' | 'outlook' |
  // 'generic-imap') plus 'unknown' as a forward-compat fallback — distinct
  // from the host-derived `provider` domain above, which has no
  // 'generic-imap' member.
  sent_copy_append_reason: ['auth', 'network', 'quota', 'too_big', 'server_refused', 'unknown'] as const,
  sent_copy_provider: ['gmail', 'outlook', 'generic-imap', 'unknown'] as const,
  // §2.34 — which secret-read surface tripped the OS secret store (keytar /
  // libsecret / Secret Service). Low-cardinality, PII-clean by construction:
  //   'imap_smtp'      — per-account IMAP/SMTP password read (the incident path)
  //   'oauth_refresh'  — OAuth2 refresh-token read (Google / Outlook)
  //   'ai_keys'        — AI provider API key read
  //   'unknown'        — forward-compat fallback (e.g. §2.33 secretStore callers
  //                      that do not yet thread a surface)
  // Mirrors the `SecretStoreSurface` union in electron/sentry.ts — keep both in
  // sync (a drift is caught by typecheck, since call sites pass string literals
  // against the union).
  secret_store_surface: ['imap_smtp', 'oauth_refresh', 'ai_keys', 'unknown'] as const,
} as const

export type DomainName = keyof typeof DOMAINS

/** Tag value spec — either an enum domain name or a primitive type hint. */
export type TagSpec = DomainName | 'string' | 'number' | 'boolean'

export type MetricKind = 'event' | 'histogram' | 'gauge'

export type MetricDefinition = {
  kind: MetricKind
  /** One-line purpose. Used by the schema dump that generates telemetry.md. */
  purpose: string
  tags: Record<string, TagSpec>
  /** Buffer this event in a 10s window and flush one aggregated record. */
  aggregate?: boolean
  /**
   * §2.19 iter4 — when true, this metric MUST NOT be accepted from the
   * renderer over the `metrics:record` IPC bridge. The bridge in
   * `electron/ipc.ts` rejects any payload referencing a `mainOnly: true`
   * event and logs a warning. Use for events whose tags carry security or
   * privacy-sensitive enums that the main process can populate
   * authoritatively (bucketed via classifyUpdateError, etc.) — a compromised
   * renderer must not be able to smuggle a string-typed tag value past the
   * domain check by emitting these events directly.
   */
  mainOnly?: boolean
}

// --- Registry --------------------------------------------------------------

export const METRIC_EVENTS = {
  // --- App lifecycle --------------------------------------------------------
  'app.session_started': {
    kind: 'event',
    purpose: 'Fired once per app start. Carries install_id_hash for DAU/MAU.',
    tags: {
      version: 'string',
      platform: 'platform',
      theme: 'theme',
      lang: 'string',
      accounts_count: 'number',
      install_id_hash: 'string',
    },
  },
  'app.session_ended': {
    kind: 'histogram',
    purpose: 'Fired once on graceful shutdown. value_ms = session duration.',
    tags: {
      reason: 'session_end_reason',
      install_id_hash: 'string',
    },
  },
  'app.updated': {
    kind: 'event',
    purpose: 'Fired once after an auto-update installs a new version.',
    tags: {
      from_version: 'string',
      to_version: 'string',
    },
  },
  'usage.session_summary': {
    kind: 'event',
    purpose: 'End-of-session feature-reach bitmap. Which features were used at least once?',
    tags: {
      search_used: 'boolean',
      compose_used: 'boolean',
      snooze_used: 'boolean',
      read_later_used: 'boolean',
      ai_used: 'boolean',
      rules_used: 'boolean',
      templates_used: 'boolean',
      followup_used: 'boolean',
      install_id_hash: 'string',
    },
  },
  'app.startup_ms': {
    kind: 'histogram',
    purpose: 'Time from app.whenReady to the first visible BrowserWindow.',
    tags: {
      accounts_count: 'number',
    },
  },
  'window.rescued': {
    kind: 'event',
    purpose:
      'A rescue pass moved at least one off-screen window back into view after a display-configuration change (monitor hotplug, resolution change, resume). Frequent pass=2 records signal a WM feedback loop — investigate before users report window shaking.',
    tags: {
      windows_moved: 'number',
      pass: 'number',
    },
    mainOnly: true,
  },

  // --- Onboarding funnel ----------------------------------------------------
  'onboarding.wizard_opened': {
    kind: 'event',
    purpose: 'User opened the add-account flow.',
    tags: {
      first_run: 'boolean',
    },
  },
  'onboarding.method_selected': {
    kind: 'event',
    purpose: 'User picked OAuth vs manual IMAP/SMTP.',
    tags: {
      method: 'onboarding_method',
    },
  },
  'onboarding.autoconfig_result': {
    kind: 'event',
    purpose: 'Autoconfig probe finished — did we find IMAP/SMTP settings?',
    tags: {
      success: 'boolean',
      provider: 'provider',
    },
  },
  'onboarding.connection_test_result': {
    kind: 'event',
    purpose: 'IMAP or SMTP connectivity test finished.',
    tags: {
      kind: 'string',
      success: 'boolean',
      failure_kind: 'send_failure_kind',
    },
  },
  'onboarding.google_oauth_result': {
    kind: 'event',
    purpose: 'Google OAuth2 flow finished.',
    tags: {
      success: 'boolean',
      failure_kind: 'send_failure_kind',
    },
  },
  'onboarding.account_saved': {
    kind: 'event',
    purpose: 'Account credentials were written to keytar/electron-store.',
    tags: {
      provider: 'provider',
      auth_type: 'auth_type',
    },
  },
  'onboarding.first_headers_sync_completed': {
    kind: 'histogram',
    purpose: 'Time from account_saved to first header sync done (value_ms).',
    tags: {
      provider: 'provider',
      folder_count_bucket: 'string',
    },
  },
  'onboarding.first_message_opened': {
    kind: 'event',
    purpose: 'User opened their first message after signing in.',
    tags: {
      time_since_sync_bucket: 'string',
    },
  },

  // --- Compose + Send queue -------------------------------------------------
  'compose.opened': {
    kind: 'event',
    purpose: 'Compose window opened; tracks which entry point was used.',
    tags: {
      source: 'compose_source',
      has_draft: 'boolean',
    },
  },
  'send_queue.enqueued': {
    kind: 'event',
    purpose: 'Outgoing message added to send_queue (immediate or scheduled).',
    tags: {
      scheduled: 'boolean',
      send_and_archive: 'boolean',
      has_attachments: 'boolean',
      body_size_bucket: 'string',
    },
  },
  'send_queue.sent': {
    kind: 'histogram',
    purpose: 'Time from enqueue to successful SMTP delivery (value_ms).',
    tags: {
      scheduled: 'boolean',
    },
  },
  'send_queue.failed': {
    kind: 'event',
    purpose: 'SMTP attempt failed permanently (queue gave up).',
    tags: {
      failure_kind: 'send_failure_kind',
    },
  },
  'send_queue.retried': {
    kind: 'event',
    purpose: 'Transient SMTP error — message rescheduled.',
    tags: {
      attempt_number: 'number',
    },
  },
  // §2.23 PR1 — silent data divergence signal: the recipient got the mail
  // (SMTP succeeded) but the sender's Sent folder did not get the copy
  // (IMAP APPEND failed). Pairs with the `mail:sentCopyFailed` renderer
  // broadcast that drives the toast. PII-safe by construction: both tags are
  // enum buckets; the folder path, message id and server response stay in
  // the local diag log / captureException context, never in metric tags.
  // `mainOnly: true` — emitted exclusively from the sendMailWithAccountConfig
  // catch in electron/main.ts; the IPC bridge hard-rejects renderer attempts.
  'send_queue.append_failed': {
    kind: 'event',
    purpose: 'SMTP delivery succeeded but the IMAP APPEND of the message copy into the Sent folder failed.',
    tags: {
      reason: 'sent_copy_append_reason',
      provider_id: 'sent_copy_provider',
    },
    mainOnly: true,
  },
  'misdirection.prompted': {
    kind: 'event',
    purpose: 'Compose showed the misdirection warning dialog.',
    tags: {
      kind: 'misdirection_kind',
    },
  },
  'misdirection.outcome': {
    kind: 'event',
    purpose: 'User responded to the misdirection warning.',
    tags: {
      outcome: 'misdirection_outcome',
      kind: 'misdirection_kind',
    },
  },
  'template.applied': {
    kind: 'event',
    purpose: 'User inserted a template into compose.',
    tags: {
      var_count: 'number',
    },
  },
  'followup.created': {
    kind: 'event',
    purpose: 'Follow-up reminder attached to an outgoing message.',
    tags: {
      duration_days_bucket: 'string',
    },
  },

  // --- Search (existing; staying for backward compat — rewritten in PR 2) --
  'search.duration_ms': {
    kind: 'histogram',
    purpose: 'End-to-end FTS search latency (main-side, pre-remote-merge). Will be replaced by search.completed in PR 2.',
    tags: {
      scope: 'scope',
      folder_role: 'folder_role',
      account_count: 'number',
      sort: 'sort',
      pagination: 'boolean',
      len_bucket: 'string',
      token_count: 'number',
      result_bucket: 'string',
      duration_bucket: 'string',
      zero_results: 'boolean',
    },
  },
  'search.error': {
    kind: 'event',
    purpose: 'Search handler threw — either user cancelled or a real failure.',
    tags: {
      scope: 'scope',
      kind: 'search_error_kind',
    },
  },

  // --- Body indexer (existing) ---------------------------------------------
  'body_indexer.tick.duration_ms': {
    kind: 'histogram',
    purpose: 'One full indexer tick across all folders.',
    tags: {
      indexed: 'number',
      folders_scanned: 'number',
    },
  },
  'body_indexer.coverage_pct': {
    kind: 'gauge',
    purpose: 'Fraction of cached messages that have body_text indexed.',
    tags: {
      total_messages: 'number',
      indexed_messages: 'number',
    },
  },
  'body_indexer.backlog': {
    kind: 'gauge',
    purpose: 'Absolute number of cached messages still missing body_text.',
    tags: {},
  },
  'body_indexer.folder_error': {
    kind: 'event',
    purpose: 'Body indexer hit a folder-wide error streak and backed off.',
    tags: {
      folder_role: 'folder_role',
      error_streak: 'number',
      backoff_ms: 'number',
    },
  },

  // --- FTS / DB maintenance (existing) --------------------------------------
  'fts.optimize.duration_ms': {
    kind: 'histogram',
    purpose: 'FTS5 optimize pass: time and segment count before/after.',
    tags: {
      segments_before: 'number',
      segments_after: 'number',
      reduction: 'number',
    },
  },
  'fts.optimize.failed': {
    kind: 'event',
    purpose: 'FTS5 optimize threw an error.',
    tags: {
      reason: 'string',
    },
  },

  // --- §2.15-ter Cache Retention --------------------------------------------
  'cache.eml_pruned': {
    kind: 'event',
    purpose: 'Body retention sweep deleted .eml files older than the configured cutoff. Buckets only — no exact paths or counts leak.',
    tags: {
      // Number of files removed — bucketed via bucketCount in metricsBuckets.
      count_bucket: 'string',
      // Disk bytes reclaimed — bucketed via bucketFreedBytes (KB / MB ranges).
      freed_bytes_bucket: 'string',
    },
  },
  'cache.folder_index_disabled': {
    kind: 'event',
    purpose: 'ensureFolderPrefs auto-flagged a folder as excluded from FTS5 search (Junk/Spam/Trash on first registration) or the user toggled index_in_search off via the folder context menu. Lets us spot providers where role detection misses local folder names.',
    tags: {
      // How many folders went from indexed → excluded in this batch. Raw int
      // — typical batches are 1-3 (one Trash, one Junk per account).
      count: 'number',
      // 'spam' | 'trash' for auto-disable, 'manual' for context-menu toggle.
      role: 'string',
    },
  },

  // --- Header sync (existing) ----------------------------------------------
  'sync.headers.wall_ms': {
    kind: 'histogram',
    purpose: 'Full syncFolderHeaders run — upsert vs other split for profiling.',
    tags: {
      folder_role: 'folder_role',
      upsert_ms: 'number',
      other_ms: 'number',
      batches: 'number',
      rows: 'number',
      max_batch_ms: 'number',
    },
  },
  'sync.headers.coalesced': {
    kind: 'event',
    purpose: 'Duplicate syncFolderHeaders attached to an in-flight run.',
    tags: {
      folder_role: 'folder_role',
    },
  },

  // --- IMAP auth refresh (OAuth token expiry recovery) ---------------------
  'imap.auth_refresh_attempt': {
    kind: 'event',
    purpose: 'OAuth token refresh triggered by IMAP auth failure (XOAUTH2/AUTHENTICATE).',
    tags: {
      provider: 'auth_refresh_provider',
    },
  },
  'imap.auth_refresh_success': {
    kind: 'event',
    purpose: 'OAuth token refresh succeeded — IMAP retry will use the fresh token.',
    tags: {
      provider: 'auth_refresh_provider',
    },
  },
  'imap.auth_refresh_failure': {
    kind: 'event',
    purpose: 'OAuth token refresh failed — IMAP operation will surface the original auth error.',
    tags: {
      provider: 'auth_refresh_provider',
      reason: 'auth_refresh_failure_reason',
    },
  },
  'imap.auth_refresh_suppressed': {
    kind: 'event',
    purpose: 'Per-account cooldown suppressed a refresh attempt — prevents /token request storms against Azure/Google when a refresh token has been revoked.',
    tags: {
      reason: 'auth_refresh_suppressed_reason',
    },
  },
  'imap.idle_auth_refreshed': {
    kind: 'event',
    purpose: 'IDLE loop recovered from a mid-cycle auth failure via in-loop token refresh — push delivery resumed without the 60-min auth backoff.',
    tags: {
      provider: 'provider',
    },
  },
  'imap.auth_refresh_exhausted': {
    kind: 'event',
    purpose: 'IDLE loop tripped the storm-brake — N consecutive in-loop refreshes succeeded at the provider but IMAP kept rejecting the fresh tokens, so we fell back to the ordinary auth backoff instead of tight-looping /token.',
    tags: {
      provider: 'provider',
      consecutive: 'number',
    },
  },

  // --- TLS trust rework (Phase A2) — cert-error recovery funnel -------------
  //
  // Funnel: imap.cert_error (packages/net seam, fires per cert-failed op)
  //   → cert.recovery_dialog_shown (main broadcasts cert:recoveryRequired
  //     after the per-host storm-guard in electron/services/certRecovery.ts)
  //   → cert.trust_clicked (user accepted the certificate via net:trustCert).
  // cert.interception_notice_shown is the sibling one-time signal for the
  // "local TLS interception" banner (verifyCertTrust systemOnly === true).
  //
  // PII-clean by construction: the only tag is the host-derived `provider`
  // enum — never the hostname, fingerprint, issuer CN, or raw error text
  // (those stay in the renderer payload / local log). All four are emitted
  // from the main process only; `mainOnly: true` makes a compromised
  // renderer's `metrics:record` attempt a hard-reject at the IPC bridge.
  'imap.cert_error': {
    kind: 'event',
    purpose: 'An IMAP operation failed with a certificate-classified TLS error (self-signed, untrusted chain, pin mismatch, hostname mismatch). Emitted from the packages/net notifyCertError seam on every failed op; bursts collapse via aggregation.',
    tags: {
      provider: 'provider',
    },
    aggregate: true,
    mainOnly: true,
  },
  'cert.recovery_dialog_shown': {
    kind: 'event',
    purpose: 'Main broadcast cert:recoveryRequired to the renderer — the cert-recovery dialog is about to be shown (once per host per storm-guard window).',
    tags: {
      provider: 'provider',
    },
    mainOnly: true,
  },
  'cert.trust_clicked': {
    kind: 'event',
    purpose: 'User accepted the presented certificate — net:trustCert stored a TLS pin and triggered an account resync. `pem` reports whether the certificate body was captured with the pin: without it the pin is not a usable trust anchor and a self-signed server keeps failing closed.',
    tags: {
      provider: 'provider',
      pem: 'cert_pin_pem',
    },
    mainOnly: true,
  },
  'cert.trust_rejected': {
    kind: 'event',
    purpose: 'User accepted the certificate but no pin was stored — either the endpoint served a different certificate than the dialog showed (rotation / load balancer / active swap) or the pin store rejected the write. Pairs with cert.trust_clicked to show how often the trust step dead-ends.',
    tags: {
      provider: 'provider',
      reason: 'cert_trust_reject_reason',
    },
    mainOnly: true,
  },
  'cert.interception_notice_shown': {
    kind: 'event',
    purpose: 'One-time "local TLS interception" notice broadcast: the mail server chain verifies against the OS system store only (antivirus / corporate-proxy root), not against the bundled Mozilla roots.',
    tags: {
      provider: 'provider',
    },
    mainOnly: true,
  },

  // --- §2.17 Phase 0 — mail-open hot-path diagnostics ----------------------
  //
  // Phase 0 is observability-first: instrument the open-mail pipeline so
  // Sentry data can tell us where the latency actually goes (memory hit,
  // DB hit, on-disk EML re-parse, IMAP roundtrip, or IMAP timeout fallback)
  // before deciding whether priority queueing (Phase 1) or UX polish
  // (Phase 2) is the right fix. PII-safe: no UIDs, no folder paths, no
  // subjects — only structural cache_hit_level / size buckets / counts.
  'mail.open': {
    kind: 'histogram',
    purpose: 'End-to-end mail-open latency observed from the renderer (open click → details rendered). Renderer emits a Sentry span with this name; the schema entry exists so the name is reserved and the cache_hit_level taxonomy is documented in one place.',
    tags: {
      cache_hit_level: 'cache_hit_level',
      body_size_bucket: 'string',
      attachments_count: 'number',
    },
  },
  // §2.22 Wave A — ICS / iTIP invite bridge. Fired once per *successful* RSVP
  // send (Accept / Tentative / Decline). Failures are NOT counted here so the
  // metric reflects user-visible success only — failure visibility comes from
  // Sentry (`captureException` with `source: 'InviteBridge.rsvp'`). PII-safe:
  // no organiser email, no event title, no UID — only the response verb and
  // a boolean flag for whether the original invite had a LOCATION (used to
  // gauge whether the renderer's location pill is worth investing in).
  'mail.invite_rsvp': {
    kind: 'event',
    purpose: 'User responded to a calendar invite (Accept / Tentative / Decline) and the RSVP email was sent successfully. Counts feature reach for §2.22 invite bridge.',
    tags: {
      method: 'rsvp_method',
      hadLocation: 'boolean',
    },
  },
  'net.message_details.wall_ms': {
    kind: 'histogram',
    purpose: 'Main-process wall time of the net:messageDetails IPC handler — tells the cache-tier story without renderer→main round-trip noise. One sample per terminal branch (memory, db, eml, imap, imap_timeout).',
    tags: {
      cache_hit_level: 'cache_hit_level',
    },
  },
  'imap.pool_queue_wait_ms': {
    kind: 'event',
    purpose: 'Per-account IMAP pool wait observed at withImapRetryPerAccount entry. Phase 0 records timing only (no scheduling change) — emitted only when wait_to_acquire exceeds 500ms so dashboards see the long-tail.',
    tags: {
      requester: 'imap_pool_requester',
      wait_ms_bucket: 'string',
    },
  },

  // --- DB data-loss signals -------------------------------------------------
  'db.mass_delete_messages': {
    kind: 'event',
    purpose: 'Folder-wide DELETE FROM messages emitted. Every call site provides a reason so Sentry can distinguish legitimate UIDVALIDITY bumps from regressions that wipe healthy caches.',
    tags: {
      folder_role: 'folder_role',
      // 'server_empty' | 'uidvalidity_bump' | 'reconcile' — kept as string
      // (not a domain enum) so a new reason doesn't require a schema bump
      // in the same PR as the new call site. Low-cardinality by construction.
      reason: 'string',
      deleted_count_bucket: 'string',
      // False only for 'uidvalidity_bump' — in that case the watermark
      // is also invalidated, so callers will rebuild from scratch.
      watermark_preserved: 'boolean',
    },
  },
  'imap.stale_wipe_guard_tripped': {
    kind: 'event',
    purpose: 'IMAP mailbox.exists came back non-numeric (undefined, etc). The mass-delete guard refused to purge the local folder cache. A Sentry spike here indicates a provider regression or connection instability, not user data loss.',
    tags: {
      folder_role: 'folder_role',
      provider: 'provider',
    },
  },
  'db.shutdown_wal_checkpoint_ms': {
    kind: 'histogram',
    purpose: 'Wall-clock duration of PRAGMA wal_checkpoint(TRUNCATE) at before-quit. Ensures the WAL is folded into the main DB file so committed-but-not-checkpointed writes survive across sessions.',
    tags: {
      // 0 on success, 1 if the WAL was held by another reader and TRUNCATE could not complete.
      busy: 'number',
      // KB reclaimed — before_size - after_size. Lets us see if checkpoints are doing real work.
      reclaimed_kb_bucket: 'string',
      // ok=false means wal_checkpoint threw; rare but observable.
      ok: 'boolean',
    },
  },

  // --- §2.51 Atomic AI budget reservation ----------------------------------
  //
  // The one telemetry signal of the fail-closed AI budget cap. Emitted from
  // `packages/db/index.ts` (`reserveAiCost` / `admitAiReservation`) via the
  // `reportDbEvent` seam whenever a reservation is REFUSED, i.e. whenever an
  // AI call was denied before it could spend. The three `reason` values answer
  // different operational questions and must stay distinguishable:
  //   - 'over-cap'           — the projected `spent + reservation` would breach
  //                            the daily/monthly limit. EXPECTED, benign: the
  //                            cap is doing its job. A steady low rate is
  //                            healthy; a spike means users are hitting limits.
  //   - 'invalid-amount'     — a non-finite / non-positive reservation reached
  //                            the primitive. NOT benign: the pricing math
  //                            upstream is broken, and every such call is
  //                            hard-denied (fail-closed). Should be ~zero.
  //   - 'ledger-write-failed'— the reservation could not be durably committed
  //                            (sqlite/IO failure). The cap is blind, so the
  //                            call is denied. Should be ~zero; a spike means
  //                            the AI feature is effectively down and the DB is
  //                            in trouble.
  // Alert shape: any sustained non-zero rate of the latter two.
  //
  // PII-clean by construction: `reason` is the ONLY tag and it is a closed set
  // of three literals produced by the db layer itself — never an account id,
  // provider key, model name, prompt, dollar amount, or error text (those stay
  // in the local log / the thrown `AiBudgetReserveError`).
  'db.ai_reserve_denied': {
    kind: 'event',
    purpose: 'An AI budget reservation was refused, denying the call before any spend. reason=over-cap is the normal projected-cap refusal; invalid-amount and ledger-write-failed are fail-closed meter errors that should be ~zero.',
    tags: {
      // Closed enum domain, NOT a bare 'string'. The sibling
      // `db.mass_delete_messages.reason` convention (avoid a schema bump when
      // adding a reason) loses to the PII boundary here: 'string' accepts any
      // text, so a single mistaken call site could ship an account id, model
      // name or raw error message to Sentry. A new deny reason costs one line
      // in DOMAINS and is caught by check:telemetry, which is the cheaper
      // failure mode.
      reason: 'ai_reserve_denied_reason',
    },
    // A hard-capped account (or a broken meter) re-denies on every subsequent
    // AI call, so denials arrive in bursts. Collapse them into windowed counts;
    // the aggregator keys buckets by tag set, so each `reason` stays separate.
    aggregate: true,
    // Emitted exclusively from the main process (packages/db runs there). A
    // compromised renderer must not be able to forge budget-denial telemetry
    // and mask a real cap breach — the IPC bridge hard-rejects mainOnly events.
    mainOnly: true,
  },

  // --- MCP stdio gate (§3.10 P0) -------------------------------------------
  //
  // Security-relevant counters for the renderer-to-local-RCE gate. All three
  // answer the same question from different angles: "is the gate holding?"
  //   - connect_attempted  — how often stdio is actually launched
  //   - connect_blocked    — how often the gate refused (and why)
  //   - approval_granted   — how often a user explicitly said yes
  //
  // A spike in `connect_blocked` with `reason='not_approved'` without a
  // matching `approval_granted` spike is the canonical alert shape — it
  // indicates something is trying to launch stdio without human sign-off.
  'mcp.stdio.connect_attempted': {
    kind: 'event',
    purpose: 'Stdio MCP transport was about to be spawned. Fires once per successful connect — after the approval + allowlist gates passed.',
    tags: {
      approved_source: 'string',
    },
  },
  'mcp.stdio.connect_blocked': {
    kind: 'event',
    purpose: 'Stdio connect or save refused by the §3.10 P0 gate.',
    tags: {
      // 'not_approved' | 'unapproved_command' | 'forbidden_field' |
      // 'forbidden_env_key' | 'env_disabled' — low-cardinality string.
      // 'forbidden_env_key' is the §3.10 wave 2 reinforcement that
      // rejects loader-hook env vars (NODE_OPTIONS, PYTHONSTARTUP,
      // LD_PRELOAD, PATH, …) smuggled through per-connection `env`.
      reason: 'string',
    },
  },
  'mcp.stdio.approval_granted': {
    kind: 'event',
    purpose: 'User granted stdio MCP approval (either the global enable gate or a per-connection approval).',
    tags: {
      // 'env' | 'native-confirm' — source of the approval
      source: 'string',
      // 'global' | 'connection' — which approval surface was used
      scope: 'string',
    },
  },
  // §3.10 P0 wave 3 reinforcement: pre-wave-2 settings records may contain
  // `mcpConnections[].env` entries with forbidden loader-hook keys
  // (NODE_OPTIONS, PYTHONSTARTUP, LD_PRELOAD, PATH, …). The wave-2 schema
  // rejects those at parse time, which would crash getSettings() at boot
  // and brick the app. The wave-3 migration tolerance in getSettings()
  // strips those keys, audits the event here, and re-parses. This event
  // fires at most once per launch, aggregated across all connections.
  'mcp.stdio.env_sanitized_on_load': {
    kind: 'event',
    purpose: 'Settings migration stripped forbidden env keys from persisted mcpConnections on load (wave-3 tolerance for pre-wave-2 records).',
    tags: {
      // Number of env keys stripped across all connections, bucketed to
      // avoid cardinality explosion. Raw count is logged locally; Sentry
      // only receives the bucket.
      count_bucket: 'string',
    },
  },

  // --- AI action audit (§3.10 P0 — preview→apply confirmation barrier) ----
  //
  // Every mutating AI MCP tool emits one of these audit events. Together
  // they let us answer: "is the renderer-confirmation gate actually being
  // honoured?" A spike in `ai.action.rejected` with `reason='token_missing'`
  // is the canonical alert shape — it indicates the AI is trying to call
  // *_apply without a renderer-issued token (e.g. prompt injection, buggy
  // model, stale agent state).
  //
  // Privacy: PII-clean — only structural `kind` (which mutating tool family)
  // and `reason` (which validation gate failed). NO subjects, addresses,
  // UIDs, folder paths, or rule contents.
  'ai.action.preview_created': {
    kind: 'event',
    purpose: 'A *_preview MCP tool registered a pending mutating action awaiting user click on Apply.',
    tags: {
      kind: 'ai_action_kind',
    },
  },
  'ai.action.applied': {
    kind: 'event',
    purpose: 'An *_apply MCP tool successfully executed a previously-confirmed mutating action.',
    tags: {
      kind: 'ai_action_kind',
    },
  },
  'ai.action.rejected': {
    kind: 'event',
    purpose: 'An *_apply MCP tool was rejected at the validation gate — preview missing/expired, token missing/mismatched/expired, kind mismatch, callback missing, or rate limit.',
    tags: {
      kind: 'ai_action_kind',
      reason: 'ai_action_reject_reason',
    },
  },
  'ai.action.expired': {
    kind: 'event',
    purpose: 'A pending mutating action expired without the user ever clicking Apply (TTL).',
    tags: {
      kind: 'ai_action_kind',
    },
  },
  'ai.action.apply_duration_ms': {
    kind: 'histogram',
    purpose: 'Wall-clock duration of a successful apply — how long the underlying mutation took (DB + IMAP/SMTP).',
    tags: {
      kind: 'ai_action_kind',
    },
  },
  // §2.20 PR1 — *_preview tools now early-skip when they would register an
  // empty pending action (matched=0 / scanned=0). Tracks how often the AI
  // proposes a preview for nothing — a spike with kind=mail_action signals
  // either a bad search query suggestion in the prompt or prompt-injection
  // probing for empty-confirmation UX exhaustion. Distinct from
  // ai.action.preview_created (which counts only successful registrations).
  'ai.action.preview_skipped': {
    kind: 'event',
    purpose: 'A *_preview MCP tool refused to register because the resolved target set was empty (no matches/UIDs after query resolution).',
    tags: {
      kind: 'ai_action_kind',
      reason: 'ai_action_preview_skipped_reason',
    },
  },
  // §2.20 PR1 — cross-account batch sizing for preview_mail_action. Lets us
  // verify the system-prompt rule "one preview spanning all accounts" is
  // actually being followed by the model. Spike in `accounts_count_bucket`
  // ≥ 2 means cross-account triage is being packed into a single
  // confirmation panel (the desired outcome); flat at 1 means models are
  // still splitting per-account.
  //
  // §2.20 PR1 fix-wave 2 — `folders_count_bucket` measures distinct
  // (accountId, folder) tuples spanned by the batch. A spike at ≥ 2
  // alongside `accounts_count_bucket` = 1 highlights single-account
  // multi-folder batches — the surface where the codex HIGH
  // confirmation-integrity gap (forge multi-folder scope past
  // single-folder summary) lived before the renderer fix-wave.
  'ai.action.batch_size': {
    kind: 'event',
    purpose: 'Recorded when a preview registration includes a (potentially multi-account, multi-folder) batch. Accounts_count, emails_count and folders_count are coarse buckets — never raw integers.',
    tags: {
      kind: 'ai_action_kind',
      accounts_count_bucket: 'ai_action_batch_bucket',
      emails_count_bucket: 'ai_action_batch_bucket',
      folders_count_bucket: 'ai_action_batch_bucket',
    },
  },

  // --- AI outbound egress gate (§3.10 P1) ---------------------------------
  //
  // Closes the prompt-injection auto-egress vector (WebSearch / WebFetch /
  // external MCP) when EmailContext is in scope. See electron/services/
  // aiEgressPolicy.ts for the policy. PII-clean: `tool_name` is enumerated
  // (low-cardinality), `account_id` is the small-integer DB id (never email).
  //
  // A spike in `ai.egress.blocked` without matching `ai.egress.allowed_once`
  // tells us the model regularly tries to egress while email is in scope —
  // either because the user hits the gate often (UX signal) or because a
  // prompt-injection attempt is bouncing off the structural defence
  // (security signal).
  //
  // The `tool_name` enum: `WebSearch`, `WebFetch`,
  // `mcp__mailcopilot__list_external_tools`, `mcp__mailcopilot__call_external_tool`,
  // and `'other'` as a forward-compat fallback. Bounded cardinality.
  'ai.egress.blocked': {
    kind: 'event',
    purpose: 'Outbound egress tool call refused while user email data is in scope. Either filtered out of the SDK toolset (prophylactic) or blocked at the runtime guard (defence-in-depth catch).',
    tags: {
      tool_name: 'string',
      account_id: 'number',
    },
  },
  'ai.egress.allowed_once': {
    kind: 'event',
    purpose: 'User granted per-request egress consent and the AI exercised it. Lets us tell apart "users routinely override" from "the gate holds, attempts are mostly injection".',
    tags: {
      tool_name: 'string',
      account_id: 'number',
    },
  },

  // --- §3.10 P2 — interactive internet-tool interceptor --------------------
  //
  // Per-tool-call decision made by the interceptor (`aiInternetGate`).
  // Distinct from `ai.egress.blocked` (which counts per-request structural
  // pre-flight filtering) so we can tell apart:
  //   - `ai.egress.blocked`     — gate was active, tools never reached the
  //                                model (legacy P1 path / no interceptor
  //                                wired). Per-request count.
  //   - `ai.egress.intercepted` — model actually proposed an internet tool
  //                                and the user (or auto-deny timeout)
  //                                made a decision. Per-call count.
  //
  // PII boundary: `tool_name` is the same low-cardinality enum as
  // `ai.egress.blocked` plus the bare Vercel forms (`list_external_tools`,
  // `call_external_tool`) and `'other'`. `outcome` is `'approved' |
  // 'denied'`. `was_consented_for_turn` distinguishes "user clicked
  // Approve/Deny in this prompt" from "auto-resolved by per-turn
  // consent" — useful to estimate prompt-fatigue (high
  // was_consented_for_turn=true rate after a single click suggests the
  // user is approving the entire turn after one prompt, which is
  // expected behaviour).
  //
  // No raw `query` / `url` / args ever land in tags. The audit log
  // (ai_action_log) carries a SHA-256 truncated hash for forensic spotting
  // of repeated identical attempts; the metrics tag set stays clean.
  'ai.egress.intercepted': {
    kind: 'event',
    purpose: 'Internet-tool call (WebSearch / WebFetch / external MCP) intercepted by the runtime gate. One event per tool call; tags carry tool name, approve/deny outcome, and whether per-turn consent had already been recorded.',
    tags: {
      tool_name: 'ai_egress_tool_name',
      outcome: 'ai_egress_outcome',
      was_consented_for_turn: 'boolean',
    },
    // §3.10 P2 — main-only by construction. The interceptor lives in
    // `electron/services/aiInternetGate.ts` (main process); the renderer
    // never has a legitimate reason to emit this event. Marking
    // `mainOnly: true` makes a compromised renderer's `metrics:record`
    // attempt a hard-reject at the IPC bridge — without this guard a
    // renderer-side bug or XSS could smuggle email body / subject /
    // address strings into Sentry as `tool_name` / `outcome` tags before
    // the now-enum domains were added (defence in depth).
    mainOnly: true,
  },

  // --- §3.3 B1 AI Privacy Audit Panel --------------------------------------
  //
  // User-driven actions on the Settings → AI → Privacy & Audit panel. PII-
  // clean: tags are bucketed enums; the audit table itself never contains
  // raw email content (see `appendAiActionLog` in packages/db/index.ts).
  // Both events are emitted from main only so a compromised renderer cannot
  // smuggle string-typed tag values past the domain check.
  'ai.audit.export_requested': {
    kind: 'event',
    purpose: 'User requested an export of the AI privacy audit log to JSON or CSV. Counts the click; cancelled saves still count because the user expressed intent.',
    tags: {
      format: 'ai_audit_export_format',
    },
    mainOnly: true,
  },
  'ai.audit.entry_deleted': {
    kind: 'event',
    purpose: 'User soft-deleted an audit entry — either a single row or every live row via Clear All. Append-only invariant holds: the row is not removed, only marked deleted.',
    tags: {
      scope: 'ai_audit_delete_scope',
    },
    mainOnly: true,
  },

  // --- §2.51.f2 — per-request cost ceiling ----------------------------------
  //
  // The agentic loop was cut short because the accumulated ACTUAL cost of the
  // request reached `aiMaxBudgetPerRequest` (Settings → AI → maximum cost per
  // request). Emitted once per stopped request, from the main process only.
  //
  // Question it answers: is the ceiling doing anything useful, or is it merely
  // truncating normal work? A high stop rate at a low `steps` count means the
  // default is too tight for real conversations (UX regression); a flat zero
  // across the fleet means the setting is dead config for this path — which is
  // exactly the condition §2.51.f2 was filed to fix, so we want the signal.
  //
  // PII boundary: `provider` is the closed AI-provider enum and `steps` is a
  // small integer (completed agentic turns). No prompt, tool argument, model
  // output, dollar amount or mail content ever reaches a tag.
  'ai.request_budget.stopped': {
    kind: 'event',
    purpose: 'A chat request was stopped early because its accumulated actual cost reached the per-request ceiling (aiMaxBudgetPerRequest). Parity with the Claude Agent SDK maxBudgetUsd stop, which the SDK enforces internally and does not report here.',
    tags: {
      provider: 'ai_provider',
      steps: 'number',
    },
    mainOnly: true,
  },

  // --- §2.39 Background AI Rules pipeline -----------------------------------
  //
  // Usage/security signal for the autonomous email-triage pipeline. Both
  // events are main-only by construction (the pipeline runs on a main-process
  // timer; the renderer never records them). PII-clean: the only tag is the
  // bucketed action enum — no subject, sender, folder path, or UID.
  //
  // `ai.rule.applied` counts a reversible action the pipeline auto-applied
  // (archive/move/mark_read/mark_starred). A spike vs the number of enabled
  // rules is the "is this feature actually doing work" usage signal.
  //
  // `ai.rule.destructive_preview` counts a destructive action (trash/mark_spam)
  // the model proposed but the pipeline did NOT apply (preview/apply invariant,
  // CLAUDE.md §5). A high rate here relative to `ai.rule.applied` is the signal
  // that users want a destructive-apply UI (follow-up), or that a rule prompt
  // is over-eager / a prompt-injection is steering the model toward deletion.
  'ai.rule.applied': {
    kind: 'event',
    purpose: 'Background AI rule auto-applied a reversible action to a message. Counts one event per applied action; tag carries the action kind.',
    tags: {
      action: 'ai_rule_action',
    },
    mainOnly: true,
  },
  'ai.rule.destructive_preview': {
    kind: 'event',
    purpose: 'Background AI rule proposed a destructive action (trash/mark_spam) that was recorded as a pending preview instead of being auto-applied. Counts intent, not execution.',
    tags: {
      action: 'ai_rule_destructive_action',
    },
    mainOnly: true,
  },

  // --- §2.19 Auto-update UX -------------------------------------------------
  //
  // Visibility into the auto-update funnel: how often users (or the timer)
  // poll for updates, what comes back, how downloads progress, and what
  // happens at install time. PII-clean by construction:
  //   - `result` / `outcome` / `error_class` are bucketed enums, not raw
  //     error messages or version strings.
  //   - The version of the available release is intentionally NOT a tag —
  //     it would explode cardinality and leak install staleness; the
  //     interesting signal is the bucketed result, not "user X is on N-2".
  //   - `source: 'auto' | 'manual'` distinguishes the once-per-hour
  //     background poll from a Settings → About button click.
  //
  // `error_class` taxonomy (low-cardinality):
  //   'network'    — transient connectivity (ETIMEDOUT, ECONNRESET, …)
  //   'permission' — write permission denied, pkexec/dpkg refusal, etc.
  //   'unknown'    — anything else, so a future failure mode does not
  //                  require a schema bump in the same PR.
  // §2.19 iter4 — every update.* event is `mainOnly: true`. These are emitted
  // exclusively from `electron/main.ts` autoUpdater listeners and IPC
  // handlers; the renderer drives the UX through `update:check` /
  // `update:download` / `update:install` IPCs, never via `metrics:record`.
  // The `mainOnly` flag instructs the IPC bridge in `electron/ipc.ts` to
  // reject any renderer-side `metrics:record` referencing these names — a
  // compromised renderer cannot use string-typed tags to smuggle PII
  // (raw error messages, install paths) into Sentry.
  'update.check_triggered': {
    kind: 'event',
    purpose: 'A check-for-updates request was issued — either by the hourly background timer or by an explicit Settings → About click.',
    tags: {
      source: 'update_check_source',
    },
    mainOnly: true,
  },
  'update.check_result': {
    kind: 'event',
    purpose: 'Outcome of a check-for-updates request (whether triggered automatically or manually).',
    tags: {
      result: 'update_check_result',
      // Present only when result='error'.
      error_class: 'update_error_class',
    },
    mainOnly: true,
  },
  'update.download_started': {
    kind: 'event',
    purpose: 'electron-updater began downloading the new version (either auto-download or user click).',
    tags: {
      source: 'update_check_source',
    },
    mainOnly: true,
  },
  'update.download_completed': {
    kind: 'event',
    purpose: 'Update download finished successfully and is staged for install on quit.',
    tags: {},
    mainOnly: true,
  },
  'update.download_failed': {
    kind: 'event',
    purpose: 'Update download did not finish (network drop, disk full, signature mismatch, etc.).',
    tags: {
      error_class: 'update_error_class',
    },
    mainOnly: true,
  },
  'update.install_outcome': {
    kind: 'event',
    purpose: 'User pressed Restart-to-install — what happened next.',
    tags: {
      result: 'update_install_outcome',
      // Present only when result='failed'.
      error_class: 'update_error_class',
    },
    mainOnly: true,
  },

  // --- IPC / event loop (existing; aggregated) -----------------------------
  'ipc.slow_ms': {
    kind: 'histogram',
    purpose: 'IPC handler took longer than the slow threshold.',
    tags: {
      channel: 'string',
      duration_bucket: 'string',
    },
    aggregate: true,
  },
  'ui.freeze.renderer_ms': {
    kind: 'histogram',
    purpose: 'Renderer event loop was blocked longer than the freeze threshold.',
    tags: {
      duration_bucket: 'string',
      inflight_count: 'number',
      top_inflight: 'string',
    },
    aggregate: true,
  },
  'ui.freeze.main_ms': {
    kind: 'histogram',
    purpose: 'Main process event loop was blocked (perf_hooks delay).',
    tags: {
      duration_bucket: 'string',
      inflight_count: 'number',
      top_inflight: 'string',
    },
    aggregate: true,
  },

  // --- §2.25 (re-diagnosis) — centralized external-open gate ---------------
  //
  // The process-wide token-bucket limiter (electron/externalOpenGate.ts) that
  // fronts every shell.openExternal call denied an open. A spike here is the
  // canonical signal of a runaway external-open storm — in the field this was
  // an OS-level xdg-open/snap-firefox re-launch loop, not normal use, so the
  // count is what tells us the gate is actively shielding the machine.
  //
  // Aggregated (10s window) so a storm of thousands of denials collapses to a
  // handful of count records instead of flooding the sink. `mainOnly: true` —
  // emitted exclusively from the openExternalGated funnel in main.ts; the
  // renderer has no legitimate reason to record it, and the flag makes a
  // compromised renderer's metrics:record attempt a hard-reject at the IPC
  // bridge. PII-clean: `source` is a fixed low-cardinality call-site tag
  // ('window_open' | 'ui_ipc' | 'update_dialog' | 'unsubscribe' | 'oauth') —
  // never a URL.
  'links.external_open_suppressed': {
    kind: 'event',
    purpose: 'A shell.openExternal request was suppressed by the external-open token-bucket gate (rate limit). Aggregate count signals a runaway open storm.',
    tags: {
      source: 'external_open_source',
    },
    aggregate: true,
    mainOnly: true,
  },

  // --- §2.34 ship-first observability — OS secret store unavailable ---------
  //
  // Fired when a keytar / libsecret / Secret Service read FAILS (the backend
  // is missing or unresponsive — e.g. a managed Linux box with no system
  // keychain, where `keytar.getPassword` rejects with
  // "...org.freedesktop.secrets: Timeout was reached"). In that state every
  // `net:*` op that needs a stored password fails back-to-back and, before
  // §2.34, the failure went only to the local file log — invisible in Sentry
  // (createLogger().error() is not bridged, CLAUDE.md §8).
  //
  // Paired signal: the matching Sentry issue carries the `keychain_unavailable`
  // tag (stamped in electron/sentry.ts beforeSend / reportKeychainUnavailable),
  // so error visibility and this usage counter answer the same question from
  // two angles: "how many installs are running in secret-store-fallback mode,
  // and on which OS?".
  //
  // PII-clean by construction: both tags are closed enum domains — `surface`
  // (which read tripped it) and `platform` (which OS). NEVER the account email,
  // the key name, the password, or the raw backend error text (that stays in
  // the captured exception / local log, never in a metric tag).
  //
  // `mainOnly: true` — emitted exclusively from the main process (the
  // electron/sentry.ts helper and the packages/net telemetry seam, both
  // main-side). A compromised renderer must not be able to fabricate this
  // signal via the `metrics:record` IPC bridge.
  'secret_store.fallback_active': {
    kind: 'event',
    purpose: 'An OS secret-store read (keytar / libsecret / Secret Service) failed — the install is running without an accessible keychain. Counts reach + surfaces the affected OS.',
    tags: {
      surface: 'secret_store_surface',
      platform: 'platform',
    },
    mainOnly: true,
  },
} as const satisfies Record<string, MetricDefinition>

export type MetricName = keyof typeof METRIC_EVENTS

// --- Net-layer performance spans -------------------------------------------
//
// IMAP/SMTP performance spans flow through Sentry's tracing sink, not
// recordEvent/recordHistogram — they carry latency by construction and
// dashboards read span.duration directly. Still, the set of allowed span
// names and attribute keys must live in one place so scripts/check-telemetry-
// schema.mjs can catch typos and taxonomic drift. Privacy invariants from
// the top of this file apply here too: attribute values must be enums,
// counts, durations, buckets, or booleans — never content.
export const NET_SPANS = {
  'imap.idle': {
    purpose: 'One IDLE cycle (connect → IDLE → DONE/refresh/error).',
    attributes: {
      folder_role: 'folder_role',
      provider: 'provider',
      exit_reason: 'string',
      duration_bucket: 'string',
    },
  },
  'imap.sync': {
    purpose: 'One fetchAllFolderHeaders invocation (CONDSTORE or full FETCH).',
    attributes: {
      folder_role: 'folder_role',
      provider: 'provider',
      changed_since_present: 'boolean',
      fetched_headers_bucket: 'string',
      skipped: 'boolean',
      errored: 'boolean',
    },
  },
  'smtp.send': {
    purpose: 'One SMTP send attempt (transport.sendMail + post-processing).',
    attributes: {
      provider: 'provider',
      size_bucket: 'string',
      has_attachments: 'boolean',
    },
  },
} as const satisfies Record<string, { purpose: string; attributes: Record<string, TagSpec> }>

export type NetSpanName = keyof typeof NET_SPANS

// --- Electron-layer performance spans --------------------------------------
//
// Spans emitted from electron/services/* (not packages/net). Like NET_SPANS
// they flow through Sentry tracing, not recordEvent. Registered here so the
// set of allowed names lives in one place and new spans are discoverable
// alongside the rest of the telemetry surface. The CI schema checker does
// not currently grep for `startMetricSpan(...)` call sites — registration
// here is documentation-first.
export const ELECTRON_SPANS = {
  'body_indexer.batch': {
    purpose: 'One batch of UIDs processed inside a body indexer tick (inner loop, not the whole tick).',
    attributes: {
      folder_role: 'folder_role',
      batch_size_bucket: 'string',
      fetched_ok_bucket: 'string',
      failed_bucket: 'string',
    },
  },
  'offline.replay': {
    purpose: 'One replayOfflineOps() invocation — drains the offline_ops queue for a single account.',
    attributes: {
      ops_count_bucket: 'string',
      failed_bucket: 'string',
      uidvalidity_mismatch: 'boolean',
    },
  },
  'search.fts': {
    purpose: 'One FTS5 search dispatch (wraps cache:search / cache:unifiedSearch worker requests).',
    attributes: {
      query_len_bucket: 'string',
      result_count_bucket: 'string',
    },
  },
  // §2.17 Phase 0 — main-process span around the net:messageDetails IPC
  // handler. Wraps every terminal branch (memory hit, DB hit, on-disk EML
  // re-parse, IMAP fetch, IMAP timeout) so Sentry tracing can show the
  // span tree per user open. Pairs with the recordHistogram emission of
  // 'net.message_details.wall_ms' — the histogram aggregates dashboards;
  // the span gives per-trace drill-down.
  'net.message_details': {
    purpose: 'Main-process net:messageDetails IPC handler — covers cache lookup, DB read, EML re-parse, IMAP fetch, and the offline-fallback path.',
    attributes: {
      cache_hit_level: 'cache_hit_level',
      body_size_bucket: 'string',
      attachments_count: 'number',
    },
  },
  // §3.3 B2 Thread AI Summary — one span per ACTUAL generation (never on a
  // cache hit). Attributes are aggregates only (provider id, was_local flag,
  // token counts, latency, bucketed error class) — no thread content, subject,
  // address, or body ever appears here (privacy invariants at the top of file).
  'ai.thread_summary.generate': {
    purpose: 'One thread-summary generation (§3.3 B2): provider call → parse → cache upsert. Emitted only on a cache MISS that reached the provider; cache hits and structured refusals (budget/opt-out/too-short) emit no span.',
    attributes: {
      provider: 'ai_provider',
      was_local: 'boolean',
      tokens_in: 'number',
      tokens_out: 'number',
      latency_ms: 'number',
      error_class: 'ai_summary_error_class',
    },
  },
  // §3.3 B4 Compose Quick Actions — one span per rewrite generation (Improve /
  // Shorter / Formal / Grammar). Attributes are aggregates only (preset id,
  // provider id, was_local, token counts, latency, bucketed error class) — the
  // draft text and rewritten output NEVER appear here (privacy invariants at the
  // top of file). Structured refusals with no provider call (empty_input /
  // no_provider / budget) emit no span.
  'ai.quick_action.rewrite': {
    purpose: 'One compose quick-action rewrite generation (§3.3 B4): preset → provider call → whole rewritten text. Emitted only when a provider call was made; empty-input/no-provider/budget refusals emit no span.',
    attributes: {
      preset: 'ai_quick_action_preset',
      provider: 'ai_provider',
      was_local: 'boolean',
      tokens_in: 'number',
      tokens_out: 'number',
      latency_ms: 'number',
      error_class: 'ai_summary_error_class',
    },
  },
  // §3.3 B4 Instant Reply — one span per drafts generation. Attributes are
  // aggregates only (provider id, was_local, token counts, latency, bucketed
  // error class, and the COUNT of drafts produced) — the source email body and
  // the generated draft text NEVER appear here (privacy invariants at the top of
  // file). Structured refusals with no provider call (no_provider / budget /
  // opt-out / no-body) emit no span.
  'ai.instant_reply.generate': {
    purpose: 'One instant-reply drafts generation (§3.3 B4): cache body → provider call → 2–3 draft options. Emitted only when a provider call was made; no-provider/budget/opt-out/no-body refusals emit no span.',
    attributes: {
      provider: 'ai_provider',
      was_local: 'boolean',
      tokens_in: 'number',
      tokens_out: 'number',
      latency_ms: 'number',
      error_class: 'ai_summary_error_class',
      draft_count: 'number',
    },
  },
} as const satisfies Record<string, { purpose: string; attributes: Record<string, TagSpec> }>

export type ElectronSpanName = keyof typeof ELECTRON_SPANS

/**
 * Union of every span name that `startMetricSpan` is allowed to open directly
 * from the Electron main process. Covers:
 *   - packages/net spans bridged via setNetTelemetrySink (NET_SPANS)
 *   - packages/db spans bridged via setDbTelemetrySink (DB_SPANS)
 *   - Electron-service spans opened directly (ELECTRON_SPANS)
 *
 * Used to type-narrow `startMetricSpan(name, attrs)` so a typo at a direct
 * call site fails at compile time — see electron/metrics.ts and METRIC_SPAN_OP
 * below.
 */
export type MetricSpanName = NetSpanName | ElectronSpanName | DbSpanName

// --- DB-layer performance spans --------------------------------------------
//
// Spans emitted from packages/db (layer-pure, bridged into startMetricSpan
// by main.ts via setDbTelemetrySink). Registered here so the full set of
// main-process spans has one source of truth. Attribute keys match the
// call sites inside packages/db/index.ts (upsert_messages, reconcile_uids,
// search_messages).
export const DB_SPANS = {
  'db.upsert_messages': {
    purpose: 'One batched message upsert transaction (one span per batch, not per row).',
    attributes: {
      row_count_bucket: 'string',
      folder_role: 'folder_role',
    },
  },
  'db.reconcile_uids': {
    purpose: 'One UID reconciliation pass against a stable UIDVALIDITY (expunge sweep).',
    attributes: {
      row_count_bucket: 'string',
      folder_role: 'folder_role',
      uidvalidity_changed: 'boolean',
    },
  },
  'db.search_messages': {
    purpose: 'One full search invocation — FTS5 fast path, LIKE fallback, and advanced parser branch.',
    attributes: {
      query_len_bucket: 'string',
      folder_role: 'folder_role',
      result_count_bucket: 'string',
    },
  },
} as const satisfies Record<string, { purpose: string; attributes: Record<string, TagSpec> }>

export type DbSpanName = keyof typeof DB_SPANS

/**
 * Explicit span name → Sentry `op` mapping.
 *
 * Why this exists: `op` is part of the Sentry span/transaction shape we query
 * and group by. The SDK can emit a transaction without it, so this is not a
 * delivery workaround; it is a schema invariant that keeps our metric spans
 * explicit and discoverable. Rather than derive `op` from `name`
 * programmatically we list every entry explicitly so a future reader sees the
 * intent per span and can diverge if a domain reason demands it (e.g. grouping
 * several names under a common op).
 *
 * Invariant: every name in NET_SPANS ∪ ELECTRON_SPANS ∪ DB_SPANS must appear
 * here exactly once. The map is asserted complete by electron/metricsSchema.test.ts.
 */
export const METRIC_SPAN_OP: Record<MetricSpanName, string> = {
  // Net-layer — ops match Sentry's tracing conventions (imap.*/smtp.*).
  'imap.idle': 'imap.idle',
  'imap.sync': 'imap.sync',
  'smtp.send': 'smtp.send',
  // Electron service spans.
  'body_indexer.batch': 'body_indexer.batch',
  'offline.replay': 'offline.replay',
  'search.fts': 'search.fts',
  'net.message_details': 'net.message_details',
  'ai.thread_summary.generate': 'ai.thread_summary.generate',
  'ai.quick_action.rewrite': 'ai.quick_action.rewrite',
  'ai.instant_reply.generate': 'ai.instant_reply.generate',
  // DB-layer.
  'db.upsert_messages': 'db.upsert_messages',
  'db.reconcile_uids': 'db.reconcile_uids',
  'db.search_messages': 'db.search_messages',
}

/** Returns only the names of events with a given kind — useful for typing. */
export type MetricNamesOfKind<K extends MetricKind> = {
  [N in MetricName]: typeof METRIC_EVENTS[N] extends { kind: K } ? N : never
}[MetricName]

/** Shape of allowed tags for a given event name. */
export type TagsFor<N extends MetricName> = Partial<{
  [K in keyof typeof METRIC_EVENTS[N]['tags']]: TagValue
}>

/** All tag values must be cheap primitives — never structured content. */
export type TagValue = string | number | boolean | undefined
