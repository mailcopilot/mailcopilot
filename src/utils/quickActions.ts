/**
 * B4 "Compose Quick Actions + Instant Reply" — renderer-side pure helpers and
 * the request/response contract types the renderer expects from the backend.
 *
 * These types MIRROR the canonical `packages/types` definitions the backend
 * agents (ai-mcp + electron-boundary) are expected to add for the
 * `ai:quickAction:rewrite` / `ai:instantReply:generate` IPC channels. They live
 * here (not `packages/types`) only so the renderer type-checks against the
 * declared contract before the backend lands; once the canonical shared types
 * exist in `@mailcopilot/types`, these can be replaced by re-exports. No email
 * content is ever built into a prompt on the renderer side — the renderer sends
 * the RAW draft text (quick action) or a message REF (instant reply), and
 * `electron/services/ai.ts` wraps untrusted content with `wrapUntrusted()`
 * before injecting it into any provider prompt.
 *
 * CLAUDE.md §5 hotspot policy: Compose.tsx / ThreadView.tsx stay thin, all the
 * preset metadata, cursor-insert math, and refusal mapping live here as pure,
 * unit-testable functions.
 */

/**
 * The four compose quick-action presets. The renderer only ever sends the
 * preset ID (a low-cardinality enum) plus the raw draft text — it NEVER builds
 * the rewrite instruction itself. Main maps the preset ID to a system prompt in
 * `ai.ts`, so the actual instruction text is a backend concern (kept out of the
 * renderer to avoid prompt drift and to keep untrusted-content wrapping on one
 * side only).
 *
 *   - `improve`  — polish clarity/tone while preserving meaning.
 *   - `shorter`  — condense to the essential message.
 *   - `formal`   — raise register to a formal/professional tone.
 *   - `grammar`  — fix grammar/spelling only, minimal wording change.
 */
export type QuickActionPreset = 'improve' | 'shorter' | 'formal' | 'grammar'

/** Ordered list of presets as rendered in the compose toolbar. */
export const QUICK_ACTION_PRESETS: readonly QuickActionPreset[] = [
  'improve',
  'shorter',
  'formal',
  'grammar',
] as const

/**
 * i18n key for a preset's toolbar button label. Kept as a pure mapping so the
 * component just maps over {@link QUICK_ACTION_PRESETS} without a switch.
 */
export function quickActionLabelKey(preset: QuickActionPreset): string {
  return `ai.quickAction.preset.${preset}`
}

/**
 * Request payload for the `ai:quickAction:rewrite` IPC channel.
 *
 * `text` is the CURRENT draft body verbatim (untrusted from the model's point
 * of view once it re-enters a prompt — main wraps it). `accountId` scopes the
 * budget/provider selection to the account authoring the draft.
 */
export type QuickActionRequest = {
  accountId: number
  preset: QuickActionPreset
  /** Current draft body text to rewrite. Never concatenated into a prompt here. */
  text: string
}

/**
 * Structured refusal reasons the renderer surfaces inline (never thrown),
 * mirroring the B2 Thread Summary discipline so budget/no-provider/etc. degrade
 * gracefully instead of crashing the toolbar.
 *   - `budget`         — daily/monthly AI budget cap exceeded.
 *   - `no_provider`    — no AI provider configured.
 *   - `provider_error` — provider call failed / returned unusable output.
 *   - `empty_input`    — draft body was empty/whitespace (nothing to rewrite).
 */
export type QuickActionRefusalReason =
  | 'budget'
  | 'no_provider'
  | 'provider_error'
  | 'empty_input'

/**
 * Discriminated result of a `ai:quickAction:rewrite` call. The renderer branches
 * on `ok`: `true` carries the rewritten text (shown in the diff preview),
 * `false` carries a structured reason (never an exception).
 */
export type QuickActionResult =
  | { ok: true; rewritten: string; provider: string }
  | { ok: false; reason: QuickActionRefusalReason }

/**
 * Request payload for the `ai:instantReply:generate` IPC channel.
 *
 * The renderer supplies only a message REF (`folder` + `uid`, plus optional
 * `messageId` for compat) — NEVER body text. Main fetches the canonical body
 * from the local SQLite cache by `(accountId, folder, uid)` and wraps it with
 * `wrapUntrusted()` before prompting. This mirrors the B2 contract's "refs only,
 * bodies fetched by main" cache-poisoning defense (CLAUDE.md §5).
 */
export type InstantReplyRequest = {
  accountId: number
  folder: string
  uid: number
  /** Ignored by main (compat only); identity is cache-derived. */
  messageId?: string | null
}

/** Instant Reply refusal reasons — a superset-compatible subset of the quick-action set. */
export type InstantReplyRefusalReason =
  | 'budget'
  | 'no_provider'
  | 'provider_error'

/**
 * A single generated draft option. `text` prefills a new Compose body verbatim
 * on selection; nothing is ever sent automatically (no-auto-send invariant).
 * `tone` is an optional short localized-by-model hint the UI may show as a chip
 * label; the renderer treats it as opaque display text.
 */
export type InstantReplyDraft = {
  text: string
  tone?: string
}

/**
 * Discriminated result of a `ai:instantReply:generate` call. On success the
 * backend returns 2–3 draft options; on refusal a structured reason.
 */
export type InstantReplyResult =
  | { ok: true; drafts: InstantReplyDraft[] }
  | { ok: false; reason: InstantReplyRefusalReason }

/**
 * Result of inserting `insert` into `original` at caret position `caret`.
 *
 * Pure so it can be unit-tested outside jsdom. `caret` is clamped into
 * `[0, original.length]` so an out-of-range/stale selection index can never
 * throw or corrupt the body. Returns both the new text and the caret position
 * AFTER the inserted text, so the caller can restore the selection.
 */
export type InsertAtCaretResult = {
  text: string
  /** Caret index positioned immediately after the inserted text. */
  caret: number
}

/**
 * Insert `insert` into `original` at `caret` (clamped). Used by the diff-preview
 * "Insert" action to splice the rewritten text at the user's cursor instead of
 * replacing the whole body.
 */
export function insertAtCaret(original: string, insert: string, caret: number): InsertAtCaretResult {
  const clamped = Math.max(0, Math.min(caret, original.length))
  const next = original.slice(0, clamped) + insert + original.slice(clamped)
  return { text: next, caret: clamped + insert.length }
}

/**
 * Whether a draft body has any non-whitespace content worth rewriting. The
 * quick-action buttons are disabled when this is false so we never fire an IPC
 * round-trip (and burn budget) on an empty draft; the backend also guards with
 * `empty_input`, but gating here avoids the pointless call.
 */
export function hasRewritableText(text: string): boolean {
  return text.trim().length > 0
}
