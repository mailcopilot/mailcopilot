---
sidebar_position: 1
title: AI Data & Audit Log
---

# AI Data & Audit Log

This page explains what data the AI assistant processes, how MailCopilot records that processing in a local audit log, and what controls you have over that data.

## What the AI Assistant Sends to Providers

When you use the AI assistant, MailCopilot transmits the following to your chosen AI provider:

- The content of the email or conversation thread you are currently viewing (subject, body, sender, recipients).
- Any attachments you explicitly ask the assistant to read.
- Your AI memory notes (if the Memory feature is configured).
- The text of your chat message to the assistant.

**What is never sent:**

- Emails or folders you have not opened or referenced in the current session.
- Your IMAP/SMTP credentials or server configuration.
- Your email account passwords.
- Any data from accounts you have not explicitly used in the current AI request.

The AI assistant is entirely optional. If you do not configure a provider, no email data is ever transmitted to any external service.

## Thread AI Summary

[Thread AI Summary](../ai-assistant#thread-ai-summary) is a separate, opt-in feature that generates a short summary of an open thread. It follows the same protections as the rest of the AI assistant:

- **Off by default, per account.** Nothing is sent for summarization unless you enable **Settings > AI > Thread AI Summary** for that specific account.
- **Wrapped content.** Every message included in the summary request is wrapped with `wrapUntrusted()` boundary markers before it reaches the AI provider, the same protection described below in [Prompt Injection Protection](#prompt-injection-protection).
- **Audited generations.** Each time a summary is actually generated (not served from cache), one entry is written to the [AI audit log](#the-audit-log) with `goal` set to the summary action. Reopening a thread that was already summarized reads the cached result and does not create a new audit entry or contact the AI provider again.
- **Account-scoped cache.** A generated summary is cached and looked up per account: the cache key combines your account with the thread's identity, so a cached summary for one account is never reused or exposed for another account.
- **Budget-aware.** If the daily AI budget has been reached, the summary is refused gracefully instead of being generated -- see [Thread AI Summary](../ai-assistant#thread-ai-summary) for what you see in that case.
- **Provider selection.** Thread AI Summary uses your configured **API-key provider** (Anthropic, OpenAI-compatible, or Google Gemini) -- a **Claude subscription is not supported for thread summary** and produces the same "no AI provider" refusal as having no provider configured at all. It is designed to prefer a local, on-device model once local-model support ships, so thread content would not need to leave your machine -- that support has not shipped yet, so today it always uses your configured remote API-key provider.
- **Telemetry contains no message content.** The anonymous usage event recorded for each generation carries only the provider identifier, whether the model ran locally, input/output token counts, latency, and a bucketed error class -- never the thread's subject, body, or participant addresses.

## Compose Quick Actions

[Compose Quick Actions](../ai-assistant#compose-quick-actions) rewrites your current draft text (Improve / Shorter / Formal / Fix grammar) in the compose window. It follows the same protections as the rest of the AI assistant:

- **No silent substitution.** A rewrite is only shown as a before/after comparison. Your draft body is changed only after you explicitly click **Replace** or **Insert at cursor** -- clicking **Cancel**, or dismissing the comparison, leaves your draft untouched and nothing further is sent.
- **Wrapped content.** Your draft text is wrapped with `wrapUntrusted()` boundary markers before it reaches the AI provider, the same protection described in [Prompt Injection Protection](#prompt-injection-protection) below -- this also protects against text you pasted from an untrusted source.
- **Audited generations.** Each rewrite writes one entry to the [AI audit log](#the-audit-log) with `goal` set to `quick_action`; the specific preset used (Improve / Shorter / Formal / Fix grammar) is recorded in the telemetry span, not in the audit entry.
- **Provider selection.** Quick Actions uses your configured **API-key provider** (Anthropic, OpenAI-compatible, or Google Gemini) -- a **Claude subscription is not supported** and produces the same "no AI provider" refusal as having no provider configured. There is no separate on/off setting: Quick Actions is available whenever a supported provider is configured and the draft has text to rewrite.
- **Budget-aware.** If the daily AI budget has been reached, the rewrite is refused gracefully -- see [Compose Quick Actions](../ai-assistant#compose-quick-actions) for what you see in that case.
- **Telemetry contains no message content.** The anonymous usage event recorded for each rewrite carries only the preset used, the provider identifier, whether the model ran locally, token counts, latency, and a bucketed error class -- never the draft text itself.

## Instant Reply

[Instant Reply](../ai-assistant#instant-reply) is a separate, opt-in feature that drafts two or three short reply options for the message you have open. It follows the same protections as the rest of the AI assistant, plus one additional safeguard specific to how it sources the email body:

- **Off by default, per account.** Nothing is sent for drafting unless you enable **Settings > AI > Instant Reply** for that specific account. When disabled, the Instant Reply button is not shown and no request is made.
- **Cache-sourced body only.** Instant Reply resolves the source email's body from MailCopilot's local cache by account, folder, and message UID -- it never trusts body text that might be supplied by the window itself, which closes off a class of cache-poisoning attacks where a manipulated view could otherwise influence what gets sent to the AI provider.
- **Wrapped content.** The source email body is wrapped with `wrapUntrusted()` boundary markers before it reaches the AI provider, the same protection described in [Prompt Injection Protection](#prompt-injection-protection) below.
- **No auto-send, ever.** Selecting a drafted option only prefills a **new** compose window. Nothing is sent until you explicitly review the draft and press Send yourself.
- **Audited generations.** Each time drafts are generated, one entry is written to the [AI audit log](#the-audit-log) with `goal` set to the instant-reply action.
- **Provider selection.** Instant Reply uses your configured **API-key provider** (Anthropic, OpenAI-compatible, or Google Gemini) -- a **Claude subscription is not supported** and produces the same "no AI provider" refusal as having no provider configured.
- **Budget-aware.** If the daily AI budget has been reached, drafting is refused gracefully -- see [Instant Reply](../ai-assistant#instant-reply) for what you see in that case.
- **Telemetry contains no message content.** The anonymous usage event recorded for each generation carries only the provider identifier, whether the model ran locally, token counts, latency, and a bucketed error class -- never the email's subject, body, sender or recipient addresses, or the drafted reply text.

## AI Egress Policy

MailCopilot intercepts every outbound internet-tool call the AI makes — web search, web fetch, and external MCP tool calls — and pauses the AI to ask for your approval before the call is executed. This prevents a malicious email from silently exfiltrating your data through a prompt-injection attack.

### How It Works

When the AI wants to use an internet tool (for example, to search the web), MailCopilot pauses the response and shows an inline confirm modal in the AI panel with the prompt **"AI wants to access the internet"**. The modal displays:

- The type of action — "Web search:", "Fetch URL:", or "External tool call"
- The requested query, URL, or external tool name when available
- **Allow** and **Deny** buttons

Click **Allow** to let the AI proceed, or **Deny** to refuse. Your decision applies for the entire current response turn — if the AI makes multiple internet-tool calls in one reply, you are only asked once. Clicking **Allow** grants access for all remaining calls in that turn.

If you do not respond within 30 seconds, MailCopilot denies the tool call automatically.

### Shield Icon

A shield icon is shown in the AI panel header whenever egress interception is active. Hovering over it shows: "AI web access is intercepted — you will be asked to approve each outbound call". This icon confirms that the interceptor is running and no internet call can bypass your approval.

### Policy Settings

You can adjust the egress policy in **Settings → AI** (under the **AI web access** control). Controls when the AI can use internet tools. With **Deny by default** or **Ask each turn**, MailCopilot prompts on the first internet-tool call in each response turn. With **Always allow**, the prompt is skipped — internet tools execute without confirmation:

- **Deny by default (recommended)** — intercept all internet-tool calls; you approve or deny each turn via the confirm modal.
- **Ask each turn** — same behavior as default-deny: explicit per-turn opt-in via the confirm modal.
- **Always allow** — AI may freely call web tools even with email content in scope. Warning: AI may send email content to external services.

### Audit Log

Each intercepted internet-tool call creates an audit row; denied calls increment **Blocked**, while approved calls are recorded with **Blocked** = 0. Each entry is also counted in the telemetry event `ai.egress.intercepted` with tags indicating the tool name, outcome (approved or denied), and whether per-turn consent was already in effect. For query/URL details, the audit log stores only a SHA-256 hash truncated to the first 16 hex characters; raw queries and URLs are never written to disk.

## The Audit Log

MailCopilot maintains a local audit log of every AI action. The log is stored in your local database on your device and is never transmitted to MailCopilot or any third party.

### What Each Entry Records

| Field | Description |
|-------|-------------|
| **Timestamp** | Exact date and time when the action occurred. |
| **Provider** | The AI provider used (e.g., Anthropic, OpenAI, Google). |
| **Model** | The specific model version that handled the request. |
| **Goal** | A brief description of what the assistant was asked to do. |
| **Tool** | The MCP tool called, if any (e.g., `send_email`, `mail_action`, `move_email`). |
| **Tokens in / out** | Input and output token counts for this action. Token counts are recorded when the AI provider exposes them through the SDK; columns may show **n/a** when the provider does not surface per-request counts. |
| **Cost (USD)** | Estimated cost based on the provider's published pricing, or **n/a** for subscription providers. Cost is always recorded when available and is the primary signal for spending tracking. |
| **Wrapped** | Number of `wrapUntrusted()` boundary marker invocations. Each invocation means a block of email content was sandboxed before being passed to the AI to prevent prompt injection. |
| **Blocked** | Number of outbound egress attempts blocked by the security policy during this action. |
| **Outcome** | Result of the action: **OK** (completed successfully), **Error** (failed), or **Aborted** (cancelled by you or the system). |

### Immutability and Retention

New entries are always appended. All columns except `deleted_at` are immutable after insert — existing records are never modified once written. This means the app cannot alter past entries (only soft-delete them or let the rotation cap remove oldest rows). Soft-deleting an entry (see below) sets the `deleted_at` timestamp and hides the entry from the view, but every other column remains unchanged.

The log is capped at **10,000 entries**. When a new entry is added and the total exceeds this limit, the oldest rows are automatically removed to keep the log within the cap. Entries older than the most recent 10,000 are permanently deleted from the local database. If you need a permanent record, export the log regularly using the **Export JSON** or **Export CSV** buttons before entries age out.

### Accessing the Audit Log

Open **Settings → AI** and expand the **Privacy & Audit** section. The log is paginated and sorted newest-first.

### Exporting

Click **Export JSON** or **Export CSV** to download the currently visible audit log (live rows under the 10,000-row rotation cap; soft-deleted and rotated-out entries are excluded). The export includes all fields listed above for each included entry. The CSV export uses RFC 4180 format with CRLF record separators and proper quoting (fields containing commas, quotation marks, or embedded newlines are escaped). The CSV file is compatible with Excel, Numbers, and LibreOffice. You can use the export to:

- Review AI activity at any time.
- Respond to personal data access requests under GDPR or similar regulations.
- Keep an offline copy for your own records.

### Deleting Entries

**Per-row soft delete** — click the delete icon on a log entry to hide it from the view. The record's `deleted_at` timestamp is set and the entry disappears from the list and aggregates, but the underlying data is retained to preserve audit integrity.

**Clear All** — marks all audit entries as soft-deleted (sets `deleted_at` on every record). Before proceeding, MailCopilot shows a native OS confirmation dialog with the title "Clear AI audit log" and buttons **Cancel** and **Delete All**. Entries are hidden from the list, aggregates, and exports. Note that the automatic 10,000-row cap (see above) physically removes the oldest rows over time; soft-deleted entries count toward the cap and will eventually be hard-purged by the rotation.

## Token and Cost Aggregates

The top of the Privacy & Audit panel shows per-provider token and cost totals. Select a period — **Today**, **Last 7 days**, or **Last 30 days** — to filter the aggregates. These are rolling windows (not calendar week or month). The totals are computed from the local audit log and are never sent to any server.

For subscription-based providers, costs are shown as **n/a** because per-request pricing does not apply.

## Prompt Injection Protection

Every block of email content passed to the AI is wrapped with `wrapUntrusted()` boundary markers. These markers instruct the AI to treat the enclosed content as untrusted user data — not as instructions — so a malicious email cannot hijack the assistant's behavior. The **Wrapped** column in the audit log lets you see exactly how many times this protection was applied in each request. The count is precise: if the same email is fetched more than once within a single request (for example, when the AI revisits it during a multi-step task), each fetch is counted separately, so the total accurately reflects the true number of email reads.

## See Also

- [AI Assistant](../ai-assistant) — full guide to using the AI assistant.
- [Telemetry](./telemetry) — anonymous diagnostic data collected by MailCopilot (separate from the AI audit log).
