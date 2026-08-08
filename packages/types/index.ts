export type {
  ImapConfig,
  SmtpConfig,
  AccountConfig,
  AutoconfigResult,
  AccountMeta,
  Identity,
  OAuthConnectStage,
  OAuthProgress,
} from './account'

export type {
  Mailbox,
  FolderHeaderSyncMode,
  FolderOfflineMode,
  FolderPreference,
  FolderRoles,
  TlsPin,
} from './folder'

export type {
  MailSummary,
  MailAddress,
  MessageEnvelope,
  AttachmentMeta,
  MessageDetails,
  UnsubscribeAttemptResult,
  ComposeAttachment,
  ComposeInit,
  // §2.22 Wave A — ICS / iTIP invite bridge.
  CalendarInvite,
  CalendarInvitePublic,
  RsvpMethod,
} from './mail'

// ─── §3.3 B2 — Thread AI Summary IPC contract ──────────────────────────────
//
// Shared main↔renderer payload types for the `ai:threadSummary:*` IPC channels.
// The main-side generator lives in `electron/services/aiThreadSummary.ts`; the
// renderer AI panel (agent 3) imports THESE types so both sides agree on the
// exact request/response shapes. No email content ever appears in a response
// payload beyond the model-generated summary the user explicitly asked for.

/**
 * A message reference the renderer hands to the generate handler. Main fetches
 * the canonical body AND the identity token from the local SQLite cache by
 * `(accountId, folder, uid)` — the renderer never supplies body text, and the
 * thread-identity hash is ALWAYS computed by main from trusted, cache-sourced
 * data.
 *
 * `messageId` is IGNORED by main (it is not in the IPC validation schema — zod
 * strips it). It is retained here only so existing renderer call sites that
 * still populate it type-check; a renderer-supplied Message-ID can NOT influence
 * the identity/hash (cross-thread cache-poisoning defense, CLAUDE.md §5). Main's
 * identity token is the DB row's Message-ID or a synthetic `account:folder:uid`
 * fallback — never this field.
 */
export type ThreadSummaryMessageRef = {
  folder: string
  uid: number
  /** Ignored by main (see type doc). Retained for renderer call-site compat. */
  messageId?: string | null
}

/**
 * The generated summary payload. `oneLine` is the collapsed one-liner shown
 * above the message stack; `bullets` is always the 5-bullet expanded form.
 * `cached` is true when the result was served from the `ai_summaries` cache
 * without a fresh provider call. `provider` is the AI provider that produced
 * the (possibly cached) summary. `wasLocal` reflects whether a local provider
 * generated it (always false today — T2.5 Ollama not shipped — reserved for
 * the local-preferred path).
 */
export type ThreadSummary = {
  threadHash: string
  oneLine: string
  bullets: string[]
  provider: string
  cached: boolean
  wasLocal: boolean
  /** Creation time of the underlying cache row, epoch ms. */
  createdAt: number
}

/**
 * Request payload for the `ai:threadSummary:generate` IPC channel.
 *
 * There is deliberately NO caller-supplied `threadHash`: main ALWAYS recomputes
 * the identity hash from the DB-sourced identity tokens, so a compromised
 * renderer cannot read or poison another thread's cache row by forging a hash
 * (CLAUDE.md §5).
 */
export type ThreadSummaryGenerateRequest = {
  accountId: number
  messages: ThreadSummaryMessageRef[]
}

/**
 * Structured refusal reasons surfaced to the renderer instead of throwing.
 * Mirrors the discriminated-refusal discipline of the AI service so the panel
 * can render a graceful message rather than a raw error toast.
 *   - `budget`       — daily/monthly AI budget cap exceeded.
 *   - `opt_out`      — the account's Thread Summary setting is OFF.
 *   - `too_short`    — fewer than the minimum messages for a summary.
 *   - `no_provider`  — no AI provider configured.
 *   - `provider_error` — the provider call failed / returned unusable output.
 */
export type ThreadSummaryRefusalReason =
  | 'budget'
  | 'opt_out'
  | 'too_short'
  | 'no_provider'
  | 'provider_error'

/**
 * Discriminated result of a `ai:threadSummary:generate` call. The renderer
 * branches on `ok`: `true` carries the summary, `false` carries a structured
 * `reason` (never an exception) so budget/opt-out/etc. degrade gracefully.
 */
export type ThreadSummaryResult =
  | { ok: true; summary: ThreadSummary }
  | { ok: false; reason: ThreadSummaryRefusalReason }
