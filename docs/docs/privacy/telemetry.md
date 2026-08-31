---
title: Telemetry
sidebar_position: 2
---

# Telemetry

{/*
  MAINTAINED BY HAND. There is no generator for this page.

  A script used to claim that role (scripts/gen-telemetry-docs.mjs). It knew
  14 of the 29 event domains, silently dropped 57 of 95 events, rewrote the
  file by full overwrite, and still exited 0 reporting the full count. It has
  been deleted (BACKLOG.md 2.130). Edit this page, and its five translations,
  by hand.

  Completeness is enforced from the other side instead:
  scripts/check-telemetry-docs.mjs requires every telemetry name registered in
  electron/metricsSchema.ts to appear in this page AND in all five
  translations. It runs in CI as part of npm run check:telemetry, and fails
  closed — a name it cannot find, a schema block it cannot parse, or a
  disclosure file it cannot read all turn the build red.
*/}

MailCopilot can send a small amount of diagnostic and usage data — but only after you actively agree to it. It never contains the content of your mail, but it does include a random identifier for this installation, so the data is **not fully anonymous**: see [Install identifier](#install-identifier) below for exactly what that identifier does and does not let us learn. This page documents exactly what is collected, and — just as importantly — what is never collected.

## First-run consent

The first time you start MailCopilot, before the account setup wizard opens, you see a consent screen titled **Send diagnostic data?**. It lists what would be sent if you allow it and what is never sent, and offers two equally sized buttons: **Allow** and **Don't allow**. Neither button is pre-selected or emphasized, and there is no pre-ticked checkbox — you have to make an active choice.

A few things follow from that:

- **Nothing is collected before you answer, not just nothing sent.** The counters and buffers behind diagnostics and usage data are never opened while consent is pending — MailCopilot does not quietly accumulate a backlog and flush it once you allow it. Whatever happened before you answered is simply gone; the moment you allow it, counting starts fresh from then on (a session-duration measurement, for example, starts counting from the moment of consent, not from app launch).
- **Closing the screen or pressing Escape counts as "Don't allow".** There is no way to dismiss the screen and end up opted in.
- **Your decision is remembered together with the version of this disclosure.** MailCopilot only shows the screen again if the list of what is collected genuinely widens — a new category of data, a new destination, or broader collection than before. Ordinary app updates, wording fixes, and bug fixes never trigger a re-ask.
- **If you had already turned diagnostics off** in Settings → About before this screen existed, that refusal is honored and you are not asked again. Everyone else has diagnostics switched off automatically, and is asked once on the next start.
- **You can change your mind at any time** in **Settings → About**. Until you answer the initial question, the toggle there is shown off and disabled, with a note explaining that it will take effect once you respond to the consent screen.

## What we send

If you allow it, MailCopilot sends:

- **Errors and crashes** — the type of error and the stack trace showing where in the code it happened. Some failure paths already route through a closed set of structural fields that rules out third-party server text entirely — for example, when saving a copy of a sent message to your Sent folder fails, the diagnostics carry the folder's role (`sent`, never its name), a salted SHA-256 hash of the message identifier truncated to 12 hex characters (never the identifier itself — this is a pseudonymous label, not anonymization: anyone holding a candidate message identifier can confirm a match by recomputing the hash), the length of the server's response, and a closed set of protocol codes (such as `AUTHENTICATIONFAILED` or `OVERQUOTA`). Other error reports that have not yet been converted to this structured form can still forward third-party server text, caught only by the address and path scrubbing described below — not a structural guarantee — see [How addresses and paths are scrubbed](#how-addresses-and-paths-are-scrubbed).
- **Versions** — the MailCopilot version, your operating system and its version.
- **Performance** — how long operations took, such as mail synchronization, search, sending, and AI requests.
- **Feature usage** — which features you used in a session and how often (search, composing mail, AI, rules, templates, snoozing, and more), plus, when you use the AI assistant, which provider and model handled the request and the estimated cost of that request. See [AI usage log](#ai-usage-log) below for the AI-specific fields.
- **AI key store activity** — actions on the store where your AI API keys are kept: which provider, whether the key was being read, saved, or removed, and how it went, including whether a key was found there. The key's value itself is never sent — not as text, not as a length, not as a hash.
- **Setup context** — how many accounts you have connected, the kind of mail service each one uses (for example Gmail or Outlook), how you signed in (OAuth vs. password), your interface language, and your theme.
- **Install identifier** — a random identifier created on first run, described in detail below. It links the data from your different sessions together, which is exactly why the data is not fully anonymous.

## What we never collect

MailCopilot does not design any code path to send the following. For typed metrics and the sent-copy failure diagnostics, that is an absolute guarantee, enforced by a closed set of structural fields the code is allowed to fill in. Every other diagnostic report relies primarily on the call site not putting the content there in the first place, backed by a shape-based scrubber that catches recognizable forms of addresses and file paths as a second layer — not a universal content filter. See [How addresses and paths are scrubbed](#how-addresses-and-paths-are-scrubbed) below for exactly what that second layer does and does not catch.

- The text of your messages (subject, body, attachments, drafts)
- Your email addresses or those of your contacts — the feedback form in Settings → About is the only place an address is sent on purpose, when you type one in yourself so you can get a reply.
- Your folder names or paths on your IMAP server — only the general kind of folder (such as Inbox, Sent, or Trash) ever appears in the data, never the name you gave it
- File names of attachments
- What you type into search — only the length of the query and the number of results are counted, never the text itself
- The content of AI chat conversations or AI memory
- Server hostnames, ports, or credentials
- Your IP address as data we attach — every event explicitly tells Sentry not to record one against it. The network connection itself unavoidably exposes your IP to whatever it touches in transit; what a receiving server, proxy, or its own logs do with that is that infrastructure's configuration, not something MailCopilot's payload controls.
- Your operating-system account name in the diagnostic reports we build — see [How addresses and paths are scrubbed](#how-addresses-and-paths-are-scrubbed) for the documented gaps

## How data is routed

All telemetry is sent to [Sentry](https://sentry.io), our error monitoring and performance platform, and only once you have allowed it on the consent screen (or later, by turning the toggle on in Settings → About). When diagnostics are off — whether because you declined, have not answered yet, or later disabled the toggle — the pipeline is bypassed entirely and nothing is sent. When you enable debug logging, the same events also appear in your local `main.log` so you can inspect exactly what would be transmitted.

### Install identifier

On first run, MailCopilot generates a random UUID and stores it in the local config file. This UUID never leaves your device. What is transmitted instead is a SHA-256 hash of it — truncated to 16 hex characters — which we call `install_id_hash`. It is attached to every telemetry event as the Sentry user id, on every event and transaction, not only session-level ones, so we can answer questions like "how many unique installs are running version X" or "is crash Y affecting 1 user or 100". The hash is:

- **Pseudonymous, not identifying, and not unlinkable** — it is not derived from any account email, device fingerprint, IP address, or hardware identifier, and there is no mapping on our side from the hash back to the UUID or to your device. But it is deliberately a stable per-installation identifier: it ties every event and transaction a given install ever sends into one trail, and — like any pseudonymous identifier handed to a third party — it could in principle be cross-referenced against other data available to Sentry or to us. This is the reason the consent screen calls the data "not fully anonymous" rather than anonymous.
- **Stable across releases** — the same install keeps the same hash when the app auto-updates, so retention metrics survive version bumps.
- **Dropped when you disable telemetry** — flipping the Settings toggle off immediately clears the identifier from the Sentry client and stops all further transmissions.

We use this identifier in the same way a web analytics tool would use a visitor id: it lets us count *distinct* installs rather than *total events*. That difference is the entire reason telemetry is useful — without it, one noisy install would look the same as a hundred calm installs.

### How addresses and paths are scrubbed

Two shape-based filters run on every outgoing event and structured log, in both the main and renderer processes, as the last stop before transmission — except the feedback-form envelope, whose address you typed in on purpose so we can reply, which is deliberately excluded from the address filter. They are a safety net for content that should never have reached that point, not the primary mechanism — the primary mechanism is that typed metric tags are closed enums and structural fields to begin with, so there is nothing free-form to scrub.

- **Email-shaped text** is replaced with `<email>`. The pattern matches the practical, common form of an address (letters, digits, and a small set of punctuation before the `@`, a dotted domain after it) — not the full formal email grammar. A deliberately excluded case: `root@localhost` and similar addresses without a dotted domain are left alone, so that ordinary prose mentioning a package like `@types/node` is not mangled. A local part built from unusual punctuation can leave a leading fragment behind after its `@domain.tld` is stripped.
- **Home-directory paths** (`/home/<name>/...`, `/Users/<name>/...`, `C:\Users\<name>\...`) have the account-name segment replaced with `<user>`. The one documented residual case: an account name containing a space, at the very end of a path, with no closing quote or separator after it, can leave its second word behind (`C:\Users\John Doe` at the end of a line keeps `Doe`). The main process additionally substitutes your literal home-directory path wherever it appears verbatim, which the sandboxed renderer cannot do.
- Both filters walk a known, bounded set of event fields (stack trace text, messages, request data, breadcrumbs, and similar) plus a depth- and size-limited walk of free-form containers (capped at 4 levels deep and 500 visited nodes, where every container element and object key counts against that budget, not just the strings actually rewritten) — not an unbounded sweep of the entire event, so content nested deeper or wider than that is not visited. One field is deliberately not touched: the machine hostname Sentry's own SDK attaches to every event (`server_name`), because on macOS and Windows it is frequently derived from the account name and no scrubbing rule can reliably tell that apart from an unrelated hostname.
- A leak in a shape neither filter recognizes — a folder name, a subject line, free-form server prose — is not caught here. That is why the metrics tables below, and the sent-copy failure diagnostics, are built from closed structural fields instead of relying on scrubbing free text.

### AI usage log

Each time you send a message to the AI assistant, MailCopilot records one structured log entry once the request finishes, in addition to the usage-summary boolean covered above. That entry carries: the **AI provider** (your API key's provider), the **model** that handled the request, the **total number of tool calls** and the **names of the tools called** (for example `send_email` or `mail_action`, never the arguments passed to them), whether the request was aborted or errored, and the **estimated cost** of the request in USD when the provider exposes pricing. None of this includes the text of your prompt, the AI's reply, or any email content — see [AI Data & Audit Log](./ai-data) for the full breakdown of what the AI assistant itself sends to providers, which is a separate, much larger topic from this structured log entry. Related latency measurements for individual AI features carry their own aggregate fields (conversation context type, whether history was present, token counts, the rewrite preset used, the number of draft replies generated, and similar) — see [Performance spans](#performance-spans) below.

## Events

### App lifecycle

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | no | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Fired once per app start. Carries install_id_hash for DAU/MAU. |
| `app.session_ended` | histogram | no | `reason`, `install_id_hash` | Fired once on graceful shutdown. value_ms = session duration. |
| `app.updated` | event | no | `from_version`, `to_version` | Fired once after an auto-update installs a new version. |
| `app.startup_ms` | histogram | no | `accounts_count` | Time from app.whenReady to the first visible BrowserWindow. |
| `window.rescued` | event | no | `windows_moved`, `pass` | A rescue pass moved at least one off-screen window back into view after a display-configuration change (monitor hotplug, resolution change, resume). |
| `tray.created` | event | no | `outcome`, `platform` | Outcome of an attempt to create the tray icon object (startup or re-enabling the tray in Settings) — `outcome` is `created` or `failed`. A `failed` outcome is a failure on our side (an empty or unreadable icon image, an error while constructing it) and says nothing about your desktop — MailCopilot does not check whether the desktop actually shows the icon. The reason for a failure is not distinguished. |
| `tray.menu_action` | event | no | `action` | Which tray menu entry was invoked (open / new message / check mail / quit) — a direct click on the tray icon on Linux and Windows is also recorded as `open` (macOS does not register a click handler for the icon, since clicking it opens the menu itself). |
| `notification.shown` | event | yes (10s window) | `batched` | A new-mail notification was shown; `batched` says whether one notification covered several messages. No account, folder, subject or sender. |
| `notification.suppressed` | event | yes (10s window) | `reason` | A new-mail notification was decided upon but not shown, because you were already looking at the app. |
| `notification.clicked` | event | yes (10s window) | — | A new-mail notification was clicked. No identifiers. |
| `badge.updated` | event | yes (10s window) | `has_unread` | The unread badge / tray tooltip total changed. Only whether anything is unread — never the count. |

### Telemetry consent

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `telemetry.consent_granted` | event | no | `version` | Fired only when you press Allow on the consent screen, tagged with the disclosure-composition version you saw. A refusal fires no event at all — measuring a "no" would itself be a transmission the refusal was meant to prevent. Re-enabling the Settings → About switch after turning it off does not fire this event either; only an answer to the consent screen does. |

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
| `send_queue.sent` | histogram | no | `scheduled` | Time from enqueue to successful SMTP delivery (value_ms). |
| `send_queue.failed` | event | no | `failure_kind` | SMTP attempt failed permanently (queue gave up). |
| `send_queue.retried` | event | no | `attempt_number` | Transient SMTP error — message rescheduled. |
| `send_queue.append_failed` | event | no | `reason`, `provider_id` | SMTP delivery succeeded but saving a copy of the message into the Sent folder over IMAP failed. See the sent-copy diagnostics described above under "What we send". |

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
| `search.duration_ms` | histogram | no | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | How long a search over the messages stored on this device took, not counting results fetched from the mail server afterwards. |
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
| `fts.merge.work_ms` | histogram | no | `outcome`, `steps`, `max_step_ms`, `segments_before`, `segments_after` | FTS5 incremental merge cycle: total synchronous merge time, longest single step, segment count before/after. |
| `fts.merge.failed` | event | no | `reason` | FTS5 incremental merge threw an error. |

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

### EML parsing

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `eml.parse_dispatch` | event | no | `path`, `size_bucket` | One EML parse, tagged with which path it took: `worker` (parsed off the main thread), `worker_failed` (the worker was available but this particular parse failed), `worker_aborted` (you closed the message before the worker finished), `inline_below_threshold` (small enough to parse on the main thread by design), or `inline_unavailable` (parsed on the main thread because the worker itself is unusable this session). |
| `eml.parse_worker_unavailable` | event | no | `reason` | Fired at most once per session, the moment off-thread EML parsing turns out to be impossible for the rest of that session — every later parse will fall back to `inline_unavailable` above. `reason` is `script_missing`, `spawn_failed`, `startup_failed`, or `not_main_thread`. |
| `eml.parse_cap_hard` | event | no | `size_bucket` | A message whose raw size was above the hard parse cap, so its body and attachments were never read. Most of the time this means the message opened as a header-only placeholder in the reading pane, but the event also fires when a background offline-sync download is refused partway through for being oversized -- nothing was opened and no placeholder was shown in that case, since there was no read to answer. Carries only the coarse size band described above — nothing about the message itself. Tells us whether anyone in the field actually receives mail that large, i.e. whether the cap sits in the right place. |
| `eml.parse_cap_soft` | event | no | `size_bucket`, `tier` | A decoded message body that was cut at the soft cap. Most of the time this means a banner appeared in the reading pane noting that only the beginning is shown, but the event also fires when the AI assistant's attachment-listing tool parses a locally-stored message in the background -- no banner is shown in that case, since there is no reading-pane view to show it in. `tier` is `default` for the limit every message opens at, or `full` when even the raised limit you asked for by clicking "Show full message" was not enough. No text, no length in bytes, no subject — only the band and which of the two limits was in force. |

None of these four events is aggregated: each is recorded individually rather than being collapsed with others from the same burst, because the field a maintainer needs — which path a parse took, why the worker died, or whether a cap actually tripped — would otherwise be buried in the count. `eml.parse_dispatch` and `eml.parse_worker_unavailable` describe how a parse ran; `eml.parse_cap_hard` and `eml.parse_cap_soft` record that a size cap was crossed — for the soft cap, during an actual parse; for the hard cap, possibly before any parse begins — and they are not emitted in lockstep with the dispatch event: a message over the hard cap is never handed to a parser at all, so it produces `eml.parse_cap_hard` and no `eml.parse_dispatch`; a message that only trips the soft cap does get parsed, so it produces its ordinary `eml.parse_dispatch` plus `eml.parse_cap_soft` alongside it.

What is guaranteed is one `eml.parse_dispatch` event per EML file MailCopilot actually hands to a parser — not one event per message you open, and, as above, none at all for a message stopped by the hard cap before parsing starts. Opening a message that is already sitting in the in-memory or on-disk details cache (the `memory` and `db` levels of `cache_hit_level`, described under [Mail open instrumentation](#mail-open-instrumentation) above) never parses an `.eml` file, so none of these four events fires for that open. Beyond that cache-hit exception, `eml.parse_dispatch`, `eml.parse_worker_unavailable`, and `eml.parse_cap_soft` fire only when a message is read from a locally-stored `.eml` file or freshly downloaded and has to be parsed -- this includes the AI assistant's background attachment lookups, which read a locally-stored `.eml` file the same way an ordinary open does. `eml.parse_cap_hard` fires in those same cases, plus one more that never touches an `.eml` file at all: a background offline-sync download refused partway through for being oversized, before anything is saved to disk. Each `eml.parse_dispatch` event carries that one parse's `path` and that one message's `size_bucket`; each `eml.parse_cap_hard` or `eml.parse_cap_soft` event carries the `size_bucket` of the message that tripped it — and, like every other event this app sends, the install identifier described in [Install identifier](#install-identifier), which ties it to the rest of your session's events. The `size_bucket` tag uses the same coarse-band treatment already applied to message size elsewhere on this page (see `body_size_bucket` under [Send queue](#send-queue) and [Mail open instrumentation](#mail-open-instrumentation)): one of five bands — `<1KB`, `1-10KB`, `10-100KB`, `100KB-1MB`, `1MB+` — not an exact byte count, not a size in any finer resolution, and never a subject, sender, filename, or message identifier.

### Calendar invites

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `mail.invite_rsvp` | event | no | `method`, `hadLocation` | Fired once a calendar-invite RSVP (Accept / Tentative / Decline) email was sent successfully. `hadLocation` records only whether the original invite had a location field, not what it said. Failed RSVP sends are not counted here. |

### IMAP OAuth token refresh

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | no | `provider` | OAuth token refresh triggered by an IMAP auth failure (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | no | `provider` | Refresh succeeded — IMAP retry will use the fresh token. |
| `imap.auth_refresh_failure` | event | no | `provider`, `reason` | Refresh failed — the original auth error will surface to the caller. |
| `imap.auth_refresh_suppressed` | event | no | `reason` | Per-account cooldown suppressed a refresh attempt to prevent /token request storms when a refresh token has been revoked. |
| `imap.idle_auth_refreshed` | event | no | `provider` | IDLE loop recovered from a mid-cycle auth failure via in-loop refresh — push delivery resumed without the 60-min auth backoff. |
| `imap.auth_refresh_exhausted` | event | no | `provider`, `consecutive` | IDLE loop tripped the storm-brake — N consecutive refreshes succeeded at the provider but IMAP kept rejecting the fresh tokens, so we fell back to ordinary auth backoff. |

### Certificate trust recovery

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `imap.cert_error` | event | yes (10s window) | `provider` | An IMAP operation failed with a certificate-classified TLS error (self-signed, untrusted chain, pin mismatch, hostname mismatch). |
| `cert.recovery_dialog_shown` | event | no | `provider` | The certificate recovery dialog was shown for a host, once per storm-guard window. |
| `cert.trust_clicked` | event | no | `provider`, `pem` | You accepted a presented certificate, storing a TLS pin and triggering a resync. `pem` records only whether the certificate body was captured with the pin, which determines whether a self-signed server can be trusted going forward. |
| `cert.trust_rejected` | event | no | `provider`, `reason` | A trust attempt did not end in a stored pin — for example you declined the confirmation, or the certificate the server presented did not match what the recovery dialog had shown. |
| `cert.interception_notice_shown` | event | no | `provider` | A one-time notice was shown that your mail server's certificate chain only verifies against your operating system's certificate store, not against the bundled public root list — the signature of antivirus software or a corporate proxy inspecting the connection. |

None of these tags ever carry the hostname, certificate fingerprint, issuer name, or raw error text — only the enumerated `provider` classification and closed reason codes.

### Account re-authentication badge

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `account.reauth_flagged` | event | no | `flagged_accounts_bucket` | A mailbox crossed the consecutive-auth-failure threshold and is now shown the "Sign in again" badge. Fired once when the badge appears, never per failed sync attempt, so this counts broken credentials rather than ordinary network flaps. |
| `account.reauth_badge_clicked` | event | no | — | You clicked "Sign in again" on the badge. Recorded on the click itself, not on the result: the record stays even if the account editor then fails to open. |
| `account.reauth_cleared` | event | no | `reason`, `flag_duration` | The badge for a mailbox stopped being shown — tagged with why (`signed_in`, meaning the mailbox started authenticating again, or `account_removed`, meaning you deleted the account instead) and how long the badge had been showing (`flag_duration`: `<1min`, `1-10min`, `10-60min`, `1-6h`, `6-24h`, `24h+`, or `unknown` for the rare case where no start time was recorded). |

None of these three carry an account id, email address, mail provider, or server text. `flagged_accounts_bucket` is a coarse bucket of how many mailboxes are flagged at once across the whole install, not which ones.

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
| `imap.header_response_unaddressable` | event | no | `folder_role`, `provider` | A header FETCH response carried no usable UID, so the message could not be stored and the sync run reported itself incomplete. Counts runs, not messages; names the provider whose FETCH stream drops UIDs. |
| `db.shutdown_wal_checkpoint_ms` | histogram | no | `busy`, `reclaimed_kb_bucket`, `ok` | Wall-clock duration of the `PRAGMA wal_checkpoint(TRUNCATE)` we run before quit so committed-but-not-checkpointed writes survive across sessions. |

### AI spending limits

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `db.ai_reserve_denied` | event | yes (10s window) | `reason` | An AI budget reservation was refused before any spend could occur — most often because your configured spending cap was reached. |
| `ai.request_budget.stopped` | event | no | `provider`, `steps` | A chat request was stopped early because its accumulated cost reached your configured per-request ceiling. `steps` is the number of agentic turns completed before the stop, never their content. |

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
| `ai.action.rejected` | event | no | `kind`, `reason` | An `*_apply` call was rejected at the validation gate — the preview was missing or expired, its confirmation token was missing, did not match, or had expired, the action kind did not match the preview, its callback was missing, or the action rate limit was hit. |
| `ai.action.expired` | event | no | `kind` | A pending mutating action expired without the user ever clicking Apply (TTL). |
| `ai.action.apply_duration_ms` | histogram | no | `kind` | Wall-clock duration of a successful apply — how long the underlying DB / IMAP / SMTP mutation took. |
| `ai.action.preview_skipped` | event | no | `kind`, `reason` | A `*_preview` MCP tool refused to register a pending action because the resolved target set was empty (no matches after query resolution). |
| `ai.action.batch_size` | event | no | `kind`, `accounts_count_bucket`, `emails_count_bucket`, `folders_count_bucket` | Recorded when a preview registration spans a batch of messages. All three counts are coarse buckets, never raw integers. |
| `ai.turn.action_not_prepared` | event | no | `role`, `search_calls_bucket` | One AI chat turn used the destructive tool machinery (a preview or apply call) but ended without registering a new pending action and without successfully claiming one you had already confirmed (a valid confirmation token accepted by MailCopilot — a stale or invalid confirmation does not count, while a successful claim excludes this event even if the action itself then fails to run), so no confirmation button appeared and nothing was changed. The panel tells you the same thing in words. `role` says which half of the pair was called — `preview` or `apply`. `search_calls_bucket` is a coarse band for how many searches ran in that turn. Neither your request, nor the assistant's reply, nor any search query is included — the detection is based purely on which tools ran. |

### AI outbound egress gate

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | no | `tool_name`, `account_id` | An outbound egress tool call (e.g. `WebSearch`, `WebFetch`, generic external MCP tool) was refused while user email data was in scope — either filtered out of the SDK toolset or stopped at the runtime guard. |
| `ai.egress.allowed_once` | event | no | `tool_name`, `account_id` | The user granted a one-shot egress consent and the AI exercised it. Distinguishes "users routinely override" from "the gate holds, attempts are mostly injection-driven". |
| `ai.egress.intercepted` | event | no | `tool_name`, `outcome`, `was_consented_for_turn` | One internet-tool call (web search, web fetch, external MCP tool) was intercepted by the confirmation modal described in [AI Egress Policy](./ai-data#ai-egress-policy), recording whether it was approved or denied and whether a prior consent for the same response turn already covered it. Never the query, URL, or tool arguments — those are only ever hashed in the local AI audit log. |

### AI privacy audit panel actions

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ai.audit.export_requested` | event | no | `format` | You clicked Export JSON or Export CSV on the AI audit log panel. |
| `ai.audit.entry_deleted` | event | no | `scope` | You soft-deleted one audit log entry, or cleared all of them. The underlying rows are not removed, only hidden — see [The Audit Log](./ai-data#the-audit-log). |

### Background AI rules

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ai.rule.applied` | event | no | `action` | The background AI rules pipeline auto-applied a reversible action (archive, move, mark read, or mark starred) to a message. |
| `ai.rule.destructive_preview` | event | no | `action` | The background AI rules pipeline proposed a destructive action (trash or mark as spam) but recorded it as a pending preview instead of applying it automatically. |

### Compose quick actions

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ai.quick_action.input_too_long` | event | no | `preset`, `length_bucket` | A quick action (Improve / Shorter / Formal / Fix grammar) refused your draft because it was longer than the limit the feature accepts, so nothing was sent to the AI provider. `preset` is which of the four buttons you pressed. `length_bucket` is a coarse size band — `<=8k`, `8k-12k`, `12k-20k`, `20k-50k`, `50k-100k` or `100k+` characters — never the exact length, and never a single character of the draft itself. It exists so we can tell whether the limit is too tight for ordinary long emails. The `<=8k` value is declared for completeness but is not reachable today: this event only fires above the 8,000-character quick-action limit, so it exists only so that lowering the limit in the future cannot produce a value outside the declared set. |
| `ai.proofread.input_too_long` | event | no | `length_bucket` | The proofreading check refused your draft because it was longer than the limit the feature accepts, so nothing was sent to the AI provider. `length_bucket` is the same coarse size band as above — never the exact length, and never a single character of the draft. It exists so we can tell whether the limit is too tight for ordinary long emails. |
| `ai.quick_action.preview_outcome` | event | no | `preset`, `outcome` | What you did with a quick-action rewrite you were shown in the review panel. `preset` is which of the four buttons you pressed. `outcome` is one of exactly three values — `replaced`, `inserted` or `cancelled`. Nothing about the text is included: not the draft, not the rewrite, not their length, not how many edits the panel found. It exists so we can tell whether the rewrites are worth taking or whether people dismiss them. A panel that goes away without a choice (you closed the window, or started another preset over it) records nothing at all. |

### Auto-updates

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `update.check_triggered` | event | no | `source` | An update check was issued, either by the hourly background timer or by your Settings → About click. |
| `update.check_result` | event | no | `result`, `error_class` | An update check finished: up to date, an update is available, or it failed. |
| `update.download_started` | event | no | `source` | An update download began, either automatically or from your click. |
| `update.download_completed` | event | no | — | An update download finished successfully and is staged to install on your next restart. |
| `update.download_failed` | event | no | `error_class` | An update download did not finish (network drop, disk full, signature mismatch, or similar). |
| `update.install_outcome` | event | no | `result`, `error_class` | What happened after you clicked Restart to install. |

None of these carry the version string of the release involved — only the bucketed outcome — so this table cannot be used to tell how far behind any individual install is.

### External link gate

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `links.external_open_suppressed` | event | yes (10s window) | `source` | A request to open a link in your default browser was rate-limited by the external-open gate. `source` identifies which part of the app made the request (for example an update dialog or an unsubscribe link), never the URL itself. |

### Secret store fallback

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `secret_store.fallback_active` | event | no | `surface`, `platform` | A read from your operating system's secret store (keytar / libsecret / Secret Service) failed, meaning this install is running without an accessible keychain. `surface` identifies which kind of credential read failed, never the credential, the account, or the account's email address. |

### AI API key storage

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ai.api_key_store_op` | event | yes (10s window) | `op`, `provider`, `outcome` | A stored AI API key was read from, written to, or deleted from your operating system's secret store. `op` is `read`, `write`, or `delete`. `provider` is `anthropic-api`, `openai-api`, or `gemini-api`. `outcome` is `found` or `absent` for a read (there is a key vs. there is none right now), `ok` for a successful write or delete, or `store_error` when the secret store itself could not be reached. The key's value never appears — not as text, not as a length, not as a hash. |

### AI destination confirmation

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ai.destination_confirm` | event | no | `field`, `outcome` | The outcome of the destination-confirmation gate that guards a change to the AI endpoint or proxy address (see [Confirming a New AI Destination](../ai-assistant#confirming-a-new-ai-destination)). `field` is `endpoint` or `proxy`. `outcome` is `accepted`, `declined` (the change was not approved — you clicked Cancel or pressed Escape, the confirmation window closed before you answered, or the dialog itself failed to open), `blocked_invalid` (the new address was not a usable http(s) URL, refused with no dialog shown), or `blocked_busy` (the change arrived while another confirmation was already open — only one dialog can be in flight for the whole app, so this can happen even for the same field). A `declined` count is not a count of deliberate refusals only — it also covers a dialog that could not be shown at all. Neither the address nor the host is ever included. |

### Settings save

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `settings.field_refused` | event | yes (10s window) | `field`, `code` | A settings save was stored with one field left out, because the value sent for it was outside what this version accepts. Every other accepted field of the same save was applied, and the skipped field kept the value it already had. `field` is the name of the skipped field (`mcpExportWhitelist`). `code` is the machine-readable reason (`unknown_export_tool` — the list contained an MCP tool name this version does not export, usually one left over from an older version). The value that was skipped is never included. |

### IPC performance

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | yes (10s window) | `channel`, `duration_bucket` | IPC handler took longer than the slow threshold. |

### UI responsiveness

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | yes (10s window) | `duration_bucket`, `inflight_count`, `oldest_inflight` | Renderer event loop was blocked longer than the freeze threshold. |
| `ui.freeze.main_ms` | histogram | yes (10s window) | `duration_bucket`, `inflight_count`, `oldest_inflight`, `top_sql`, `sql_ms` | Main process event loop was blocked (perf_hooks delay). The `top_sql` tag is a `<verb> <table>` digest of the slowest SQL statement measured in that window — statement shape only, never bind values. |

### Context menu

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `ui.context_menu_shown` | event | yes (10s window) | `context` | The native right-click context menu was shown. `context` records which section it offered: `link`, `editable` (a text field), or `selection` (non-editable selected text). |
| `ui.context_menu_link_action` | event | yes (10s window) | `action` | You activated one of the two link items in the context menu. `action` is `open` (Open Link in Browser) or `copy_address` (Copy Link Address). Neither the link's URL nor its visible text is ever included. |
| `ui.context_menu_spell_action` | event | yes (10s window) | `action` | You used a spelling item in the context menu. `action` is `replace` (a suggested spelling was applied) or `add_to_dictionary` (a word was added to your personal dictionary). Neither the word nor the replacement is ever included. |

### Spell checking

| Event | Kind | Aggregated | Tags | Purpose |
| --- | --- | --- | --- | --- |
| `spellcheck.configured` | event | yes (10s window) | `enabled`, `language_count`, `platform_owned` | The spell checking state applied to the app, at launch and after each settings save: whether it is on, HOW MANY dictionaries are enabled, and whether the operating system owns the language list (macOS). Which languages you chose is never included — only the count. |
| `spellcheck.dictionary_consent` | event | no | `outcome`, `language_count` | How the prompt asking to download a dictionary ended: `accepted`, `declined`, `blocked_busy` (another prompt was already open), `failed` (the prompt could not be shown) or `unconsented_download` (a download started without a recorded answer — a bug we want to hear about). The language names are never included. |

## Performance spans

Beyond the discrete events and histograms above, MailCopilot times a fixed set of operations as Sentry performance spans — the mechanism Sentry uses for latency tracing rather than counters. Every attribute value below is an aggregate: an enum, a count, a duration, or a boolean. None of them carry message content, an address, a query, a URL, or a prompt.

### Mail sync and delivery

| Span | Kind | Aggregated | Attributes | Purpose |
| --- | --- | --- | --- | --- |
| `imap.idle` | span | no | `folder_role`, `provider`, `exit_reason`, `duration_bucket` | One IDLE cycle: connect, wait for a push notification, and refresh or exit. |
| `imap.sync` | span | no | `folder_role`, `provider`, `changed_since_present`, `fetched_headers_bucket`, `skipped`, `errored` | One header-sync pass for a folder, via CONDSTORE or a full fetch. |
| `smtp.send` | span | no | `provider`, `size_bucket`, `has_attachments` | One SMTP send attempt. |

### Background processing

| Span | Kind | Aggregated | Attributes | Purpose |
| --- | --- | --- | --- | --- |
| `body_indexer.batch` | span | no | `folder_role`, `batch_size_bucket`, `fetched_ok_bucket`, `failed_bucket` | One batch of messages processed inside a body-indexer tick. |
| `offline.replay` | span | no | `ops_count_bucket`, `failed_bucket`, `uidvalidity_mismatch` | One replay of queued offline actions for an account once it reconnects. |
| `search.fts` | span | no | `query_len_bucket`, `result_count_bucket` | One full-text search dispatch to the search worker. |
| `net.message_details` | span | no | `cache_hit_level`, `body_size_bucket`, `attachments_count` | The main-process handler that resolves a message's full content, covering every path from an in-memory hit to a fresh IMAP fetch. |

### AI feature latency

| Span | Kind | Aggregated | Attributes | Purpose |
| --- | --- | --- | --- | --- |
| `ai.chat` | span | no | `ai.provider`, `ai.model`, `ai.context_type`, `ai.has_history`, `ai.session_resumed`, `ai.tool_call_count`, `ai.tools_used`, `ai.aborted`, `ai.cost_usd` | One AI Assistant chat request, from opening the provider stream to completion or abort. `ai.context_type` and the history/resumed flags describe which surface started the conversation and whether it continued a prior one — never its content. |
| `ai.thread_summary.generate` | span | no | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | One Thread AI Summary generation. Only fires on an actual provider call, never on a cache hit. |
| `ai.quick_action.rewrite` | span | no | `preset`, `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class` | One Compose Quick Actions rewrite. `preset` records which of Improve / Shorter / Formal / Fix grammar you picked, never your draft text. |
| `ai.instant_reply.generate` | span | no | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `draft_count` | One Instant Reply drafting call. `draft_count` is how many reply options were generated, never their text. |
| `ai.proofread.check` | span | no | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `edit_count`, `dropped_count` | One proofreading check of a draft. `edit_count` is how many suggestions you were offered; `dropped_count` is how many suggestions the model returned that could not be matched to your text and were discarded. Both are counts only — never a suggestion, never a fragment of the draft, never the explanation shown next to a suggestion. |
| `ai.translate.message` | span | no | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `source_labeled`, `target_lang`, `cache_hit` | One message translation. Emitted for cache hits too — `cache_hit` distinguishes them, and a cache hit carries no tokens or cost; an opt-out, empty-input, too-long, no-provider, or budget refusal emits no span. `target_lang` is a language code from the closed sixteen-value list offered in the target-language picker. `source_labeled` is a boolean recording only whether local detection (or your own later choice) named a source language for the caption -- never which language, since that would be a fact derived from the content of your mail. |
| `ai.translate.draft` | span | no | `provider`, `was_local`, `tokens_in`, `tokens_out`, `latency_ms`, `error_class`, `target_lang` | One draft translation from the compose window: your own part of the draft, translated on request. Emitted only when a provider was selected; an opt-out, empty-input, no-own-text, too-long, no-provider, or budget refusal emits no span. `target_lang` is a language code from the same closed sixteen-value list, the one you chose in the compose window -- never the language MailCopilot may have suggested for the reply, and never a flag recording whether your choice came from that suggestion: no such flag exists here, on purpose, since pairing it with `target_lang` would weakly disclose the language of the message you are replying to -- the same identity the reading-side span above withholds. |

The `provider` attribute on the AI feature-latency spans above that carry it (every one except `ai.chat`, which uses the separately scoped `ai.provider` attribute) is one of a fixed set of values: `anthropic-api`, `openai-api`, `gemini-api`, `local` (the future on-device model path), or `unknown`. Any value MailCopilot does not recognize is mapped to `unknown` before it is recorded, so this attribute can never widen to carry a free-form or unexpected string.

### Local database

| Span | Kind | Aggregated | Attributes | Purpose |
| --- | --- | --- | --- | --- |
| `db.upsert_messages` | span | no | `row_count_bucket`, `folder_role` | One batched message-upsert transaction. |
| `db.reconcile_uids` | span | no | `row_count_bucket`, `folder_role`, `uidvalidity_changed` | One reconciliation pass that clears out locally cached messages no longer on the server. |
| `db.search_messages` | span | no | `query_len_bucket`, `folder_role`, `result_count_bucket` | One search invocation across the local cache, whichever internal search path served it. |

## Contact

Questions or concerns about what we collect? Open an issue at [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) or contact the team directly through the feedback form in Settings → About.
