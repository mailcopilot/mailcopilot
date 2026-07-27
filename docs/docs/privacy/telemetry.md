---
title: Telemetry
sidebar_position: 2
---

# Telemetry

MailCopilot collects a small amount of anonymous diagnostic and usage data when you enable **Send anonymous diagnostics and usage data** in Settings → About. This page documents exactly what is collected, and — just as importantly — what is never collected.

## What we never collect

Under no circumstances does MailCopilot transmit any of the following:

- The text of your messages (subject, body, attachments, drafts)
- Your email addresses or those of your contacts
- Folder names or paths on your IMAP server
- File names of attachments
- The text of your search queries
- The content of AI chat conversations or AI memory
- Server hostnames, ports, or credentials

## How data is routed

All telemetry is sent to [Sentry](https://sentry.io), our error monitoring and performance platform. When you disable the toggle in Settings, the pipeline is bypassed entirely — nothing is sent. When you enable debug logging, the same events also appear in your local `main.log` so you can inspect exactly what would be transmitted.

### Anonymous install identifier

On first run, MailCopilot generates a random UUID and stores it in the local config file. This UUID never leaves your device. What is transmitted instead is a SHA-256 hash of it — truncated to 16 hex characters — which we call `install_id_hash`. It is attached to every telemetry event as the Sentry user id so we can answer questions like "how many unique installs are running version X" or "is crash Y affecting 1 user or 100". The hash is:

- **Anonymous** — not derived from, or correlated with, any account email, device fingerprint, IP address, or hardware identifier.
- **Stable across releases** — the same install keeps the same hash when the app auto-updates, so retention metrics survive version bumps.
- **Not reversible** — there is no mapping on our side from the hash back to the UUID or to your device.
- **Dropped when you disable telemetry** — flipping the Settings toggle off immediately clears the identifier from the Sentry client and stops all further transmissions.

We use this identifier in the same way a web analytics tool would use an anonymous visitor id: it lets us count *distinct* installs rather than *total events*. That difference is the entire reason telemetry is useful — without it, one noisy install would look the same as a hundred calm installs.

## Events

### App lifecycle

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | no | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Fired once per app start. Carries install_id_hash for DAU/MAU. |
| `app.session_ended` | histogram | no | `reason`, `install_id_hash` | Fired once on graceful shutdown. value_ms = session duration. |
| `app.updated` | event | no | `from_version`, `to_version` | Fired once after an auto-update installs a new version. |
| `app.startup_ms` | histogram | no | `accounts_count` | Time from app.whenReady to the first visible BrowserWindow. |

### Usage summary

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `usage.session_summary` | event | no | `search_used`, `compose_used`, `snooze_used`, `read_later_used`, `ai_used`, `rules_used`, `templates_used`, `followup_used`, `install_id_hash` | End-of-session feature-reach bitmap. Which features were used at least once? |

### Onboarding

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `onboarding.wizard_opened` | event | no | `first_run` | User opened the add-account flow. |
| `onboarding.method_selected` | event | no | `method` | User picked OAuth vs manual IMAP/SMTP. |
| `onboarding.autoconfig_result` | event | no | `success`, `provider` | Autoconfig probe finished — did we find IMAP/SMTP settings? |
| `onboarding.connection_test_result` | event | no | `kind`, `success`, `failure_kind` | IMAP or SMTP connectivity test finished. |
| `onboarding.google_oauth_result` | event | no | `success`, `failure_kind` | Google OAuth2 flow finished. |
| `onboarding.account_saved` | event | no | `provider`, `auth_type` | Account credentials were written to keytar/electron-store. |
| `onboarding.first_headers_sync_completed` | histogram | no | `provider`, `folder_count_bucket` | Time from account_saved to first header sync done (value_ms). |
| `onboarding.first_message_opened` | event | no | `time_since_sync_bucket` | User opened their first message after signing in. |

### Compose

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `compose.opened` | event | no | `source`, `has_draft` | Compose window opened; tracks which entry point was used. |

### Send queue

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `send_queue.enqueued` | event | no | `scheduled`, `send_and_archive`, `has_attachments`, `body_size_bucket` | Outgoing message added to send_queue (immediate or scheduled). |
| `send_queue.sent` | histogram | no | `scheduled` | Time from enqueue to successful delivery — SMTP for most accounts, Microsoft Graph for Outlook (value_ms). |
| `send_queue.failed` | event | no | `failure_kind` | Send attempt failed permanently (queue gave up). Covers both SMTP and Microsoft Graph send paths. |
| `send_queue.retried` | event | no | `attempt_number` | Transient send error — message rescheduled. Covers both SMTP and Microsoft Graph send paths. |

### Misdirection warnings

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `misdirection.prompted` | event | no | `kind` | Compose showed the misdirection warning dialog. |
| `misdirection.outcome` | event | no | `outcome`, `kind` | User responded to the misdirection warning. |

### Templates

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `template.applied` | event | no | `var_count` | User inserted a template into compose. |

### Follow-up reminders

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `followup.created` | event | no | `duration_days_bucket` | Follow-up reminder attached to an outgoing message. |

### Search

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `search.duration_ms` | histogram | no | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | End-to-end FTS search latency (main-side, pre-remote-merge). Will be replaced by search.completed in PR 2. |
| `search.error` | event | no | `scope`, `kind` | Search handler threw — either user cancelled or a real failure. |

### Body indexer

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `body_indexer.tick.duration_ms` | histogram | no | `indexed`, `folders_scanned` | One full indexer tick across all folders. |
| `body_indexer.coverage_pct` | gauge | no | `total_messages`, `indexed_messages` | Fraction of cached messages that have body_text indexed. |
| `body_indexer.backlog` | gauge | no | — | Absolute number of cached messages still missing body_text. |
| `body_indexer.folder_error` | event | no | `folder_role`, `error_streak`, `backoff_ms` | Body indexer hit a folder-wide error streak and backed off. |

### Full-text index maintenance

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `fts.optimize.duration_ms` | histogram | no | `segments_before`, `segments_after`, `reduction` | FTS5 optimize pass: time and segment count before/after. |
| `fts.optimize.failed` | event | no | `reason` | FTS5 optimize threw an error. |

### Header sync

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `sync.headers.wall_ms` | histogram | no | `folder_role`, `upsert_ms`, `other_ms`, `batches`, `rows`, `max_batch_ms` | Full syncFolderHeaders run — upsert vs other split for profiling. |
| `sync.headers.coalesced` | event | no | `folder_role` | Duplicate syncFolderHeaders attached to an in-flight run. |

### Mail open instrumentation

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `mail.open` | histogram | no | `cache_hit_level`, `body_size_bucket`, `attachments_count` | End-to-end mail-open latency as observed from the renderer (open click to details rendered). The `cache_hit_level` tag encodes which cache tier served the body: `memory`, `db`, `eml`, `imap`, or `imap_timeout`. |
| `net.message_details.wall_ms` | histogram | no | `cache_hit_level` | Main-process wall time of the `net:messageDetails` IPC handler. Isolates the server-side latency from renderer-to-main round-trip noise. One sample per terminal branch (`memory`, `db`, `eml`, `imap`, `imap_timeout`). |
| `imap.pool_queue_wait_ms` | event | no | `requester`, `wait_ms_bucket` | Time spent waiting to acquire an IMAP connection from the per-account pool. Emitted only when the wait exceeds 500 ms, so dashboards capture the long tail without noise from fast acquisitions. |

### IMAP OAuth token refresh

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | no | `provider` | OAuth token refresh triggered by an IMAP auth failure (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | no | `provider` | Refresh succeeded — IMAP retry will use the fresh token. |
| `imap.auth_refresh_failure` | event | no | `provider`, `reason` | Refresh failed — the original auth error will surface to the caller. |
| `imap.auth_refresh_suppressed` | event | no | `reason` | Per-account cooldown suppressed a refresh attempt to prevent /token request storms when a refresh token has been revoked. |
| `imap.idle_auth_refreshed` | event | no | `provider` | IDLE loop recovered from a mid-cycle auth failure via in-loop refresh — push delivery resumed without the 60-min auth backoff. |
| `imap.auth_refresh_exhausted` | event | no | `provider`, `consecutive` | IDLE loop tripped the storm-brake — N consecutive refreshes succeeded at the provider but IMAP kept rejecting the fresh tokens, so we fell back to ordinary auth backoff. |

### Cache retention

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `cache.eml_pruned` | event | no | `count_bucket`, `freed_bytes_bucket` | Body retention sweep deleted `.eml` files older than the configured cutoff. Counts and sizes are bucketed — no exact file paths or counts are transmitted. |
| `cache.folder_index_disabled` | event | no | `count`, `role` | A folder was excluded from full-text search — either automatically for Junk/Spam/Trash on first registration, or manually via the folder context menu. `role` is `spam`, `trash`, or `manual`. |

### Cache safety and data-loss signals

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `db.mass_delete_messages` | event | no | `folder_role`, `reason`, `deleted_count_bucket`, `watermark_preserved` | Folder-wide DELETE FROM messages emitted. Every call site provides a reason so a regression that wipes healthy caches is distinguishable from a legitimate UIDVALIDITY bump. |
| `imap.stale_wipe_guard_tripped` | event | no | `folder_role`, `provider` | The mass-delete guard refused to purge the local folder cache because `mailbox.exists` came back non-numeric. A spike here points to a provider/connection issue, not user data loss. |
| `db.shutdown_wal_checkpoint_ms` | histogram | no | `busy`, `reclaimed_kb_bucket`, `ok` | Wall-clock duration of the `PRAGMA wal_checkpoint(TRUNCATE)` we run before quit so committed-but-not-checkpointed writes survive across sessions. |

### MCP stdio gate (renderer-to-RCE protection)

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `mcp.stdio.connect_attempted` | event | no | `approved_source` | Stdio MCP transport was about to be spawned — fires once per successful connect after the approval and allowlist gates passed. |
| `mcp.stdio.connect_blocked` | event | no | `reason` | Stdio connect or save refused by the gate (`not_approved`, `unapproved_command`, `forbidden_field`, `forbidden_env_key`, `env_disabled`). |
| `mcp.stdio.approval_granted` | event | no | `source`, `scope` | User granted stdio MCP approval (global enable or per-connection); `source` distinguishes env vs native-confirm, `scope` distinguishes global vs per-connection. |
| `mcp.stdio.env_sanitized_on_load` | event | no | `count_bucket` | Settings migration stripped forbidden loader-hook env keys from persisted MCP connections on load. Fires at most once per launch. |

### AI action audit (preview → apply confirmation barrier)

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ai.action.preview_created` | event | no | `kind` | A `*_preview` MCP tool registered a pending mutating action awaiting user click on Apply. |
| `ai.action.applied` | event | no | `kind` | An `*_apply` MCP tool successfully executed a previously-confirmed mutating action. |
| `ai.action.rejected` | event | no | `kind`, `reason` | An `*_apply` call was rejected at the validation gate (preview missing/expired, token mismatch, kind mismatch, callback missing, or rate limit). |
| `ai.action.expired` | event | no | `kind` | A pending mutating action expired without the user ever clicking Apply (TTL). |
| `ai.action.apply_duration_ms` | histogram | no | `kind` | Wall-clock duration of a successful apply — how long the underlying DB / IMAP / SMTP mutation took. |

### AI outbound egress gate

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | no | `tool_name`, `account_id` | An outbound egress tool call (e.g. `WebSearch`, `WebFetch`, generic external MCP tool) was refused while user email data was in scope — either filtered out of the SDK toolset or stopped at the runtime guard. |
| `ai.egress.allowed_once` | event | no | `tool_name`, `account_id` | The user granted a one-shot egress consent and the AI exercised it. Distinguishes "users routinely override" from "the gate holds, attempts are mostly injection-driven". |

### IPC performance

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | yes (10s window) | `channel`, `duration_bucket` | IPC handler took longer than the slow threshold. |

### UI responsiveness

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | yes (10s window) | `duration_bucket`, `inflight_count`, `top_inflight` | Renderer event loop was blocked longer than the freeze threshold. |
| `ui.freeze.main_ms` | histogram | yes (10s window) | `duration_bucket`, `inflight_count`, `top_inflight` | Main process event loop was blocked (perf_hooks delay). |

## Contact

Questions or concerns about what we collect? Open an issue at [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) or contact the team directly through the feedback form in Settings → About.
