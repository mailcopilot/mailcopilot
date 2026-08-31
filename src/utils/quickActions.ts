/**
 * B4 "Compose Quick Actions + Instant Reply" + B7 "AI Proofread" — renderer-side
 * pure helpers over the shared main↔renderer contract.
 *
 * §3.3.B4.f3(c): the contract types are no longer duplicated here. They live in
 * `@mailcopilot/types` and both sides — `electron/services/ai.ts` /
 * `electron/services/composeAi.ts` and this module — import the SAME
 * definitions, so a refusal reason added on one side is a compile error on the
 * other until it is handled. The re-exports below keep every existing renderer
 * import path (`src/utils/quickActions`) working unchanged.
 *
 * No email content is ever built into a prompt on the renderer side — the
 * renderer sends only the user's OWN part of the draft, as identified by
 * `splitComposeBody()` (quick action, proofread), or a message REF (instant
 * reply), and main wraps untrusted content with `wrapUntrusted()` before
 * injecting it into any provider prompt. The quoted original, the forwarded
 * message and the signature never leave the renderer at all (§2.78); where no
 * boundary is recognizable the split falls back to "all own text", so this is a
 * best-effort narrowing, not a parser guarantee — see the limitation list in
 * `packages/core/composeBody.ts` and §2.173.
 *
 * CLAUDE.md §5 hotspot policy: Compose.tsx / ThreadView.tsx stay thin, all the
 * preset metadata, cursor-insert math, and refusal mapping live here as pure,
 * unit-testable functions.
 */

import type {
  QuickActionPreset,
  ProofreadEditCategory,
  ProofreadRefusalReason,
} from '@mailcopilot/types'

export type {
  QuickActionPreset,
  QuickActionRequest,
  QuickActionRefusalReason,
  QuickActionResult,
  InstantReplyRequest,
  InstantReplyRefusalReason,
  InstantReplyDraft,
  InstantReplyResult,
  ProofreadEdit,
  ProofreadEditCategory,
  ProofreadRequest,
  ProofreadRefusalReason,
  ProofreadResult,
} from '@mailcopilot/types'

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
 * Refusals the renderer decides on its own; these NEVER arrive over IPC.
 *   - `no_own_text` — the draft consists solely of quoted/forwarded material
 *     and a signature, so there is nothing of the user's own to rewrite
 *     (§2.78: an AI rewrite never touches quoted text or the signature).
 *
 * Note the asymmetry with B7: `no_own_text` is renderer-only for a QUICK ACTION
 * (the toolbar gates the button before any IPC), but it is a REAL backend
 * refusal reason for a proofread check, because main re-splits the received
 * text itself and can conclude there is nothing of the user's own to check.
 */
export type QuickActionLocalRefusalReason = 'no_own_text'

/** Everything the toolbar can render as an inline refusal. */
export type QuickActionDisplayRefusal =
  | import('@mailcopilot/types').QuickActionRefusalReason
  | QuickActionLocalRefusalReason

/**
 * Every proofread refusal the renderer renders inline. Identical to the backend
 * union today — B7 has no renderer-only refusal, because the "nothing of your
 * own to check" case is decided by main (which owns the authoritative split)
 * rather than pre-gated in the toolbar. Kept as a named alias so the panel has
 * one symbol to exhaustively switch over, exactly like
 * {@link QuickActionDisplayRefusal}.
 */
export type ProofreadDisplayRefusal = ProofreadRefusalReason

/**
 * i18n key for a proofread edit's category chip.
 *
 * The switch is exhaustive over {@link ProofreadEditCategory} so adding a
 * category to the contract is a compile error here until it gets a label. The
 * `default:` arm exists for a wire value outside the union (a rogue/older main)
 * and falls back to `wording` — the same normalization main applies — rather
 * than rendering a raw key or the model's own English category name.
 */
export function proofreadCategoryKey(category: ProofreadEditCategory): string {
  switch (category) {
    case 'spelling':
    case 'grammar':
    case 'punctuation':
    case 'wording':
    case 'clarity':
      return `ai.quickAction.proofread.category.${category}`
    default:
      return 'ai.quickAction.proofread.category.wording'
  }
}

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

/**
 * Whether a pending preview was computed against a draft the user has since
 * edited (§2.78 AC-h).
 *
 * The rewrite round trip is asynchronous: the user can keep typing while the
 * provider works. "Replace" writes a body derived from the SNAPSHOT taken at
 * click time, so applying it to a draft that changed in the meantime would
 * silently drop whatever was typed during generation. The monotonic request
 * token in `useQuickActions` only guards against a second PRESET click — it
 * cannot see body edits, which is exactly the gap this closes.
 *
 * Deliberately an exact string comparison over the WHOLE body: an edit inside
 * the untouched tail (signature, quoted block) invalidates the snapshot just as
 * much as an edit inside the rewritten part, because the replacement carries
 * the snapshot's tail verbatim.
 */
export function isPreviewStale(preview: { sourceBody: string }, currentBody: string): boolean {
  return preview.sourceBody !== currentBody
}

/**
 * The three AI actions the compose toolbar hosts. Each owns an independent
 * request/refusal/review state machine (`useQuickActions`, `useProofread`,
 * `useDraftTranslation`) and none of them can see the others.
 */
export type ComposeAiAction = 'rewrite' | 'proofread' | 'translate'

/**
 * Which toolbar actions currently occupy the draft: a request of theirs is in
 * flight, or their review panel is on screen awaiting a decision.
 */
export type ComposeAiActivity = Record<ComposeAiAction, boolean>

/**
 * Whether `self` must be disabled because ANOTHER toolbar action occupies the
 * draft (§3.3 B6.f-renderer).
 *
 * The three state machines are independent by construction, so nothing in them
 * prevents a second one from starting: the user could hold an open rewrite diff
 * and click Translate, ending up with two review panels stacked over the same
 * body and two paid requests answering overlapping questions. Whichever panel
 * was applied second would then write a replacement derived from a snapshot the
 * first one had already invalidated — the staleness guard catches that, but
 * only after the money is spent and the second panel is dead on arrival.
 *
 * One owner of "busy or under review" therefore lives at the TOOLBAR level,
 * where all three are visible, rather than as three pairwise checks that would
 * have to be re-derived every time a fourth action is added. The rule is
 * deliberately about OTHER actions only: an action never blocks itself, so
 * re-running a preset while its own diff is open keeps working exactly as
 * before.
 *
 * A refusal line is not occupancy — it is a finished, dismissible message, and
 * blocking the other two behind it would be a regression with no accident to
 * prevent.
 */
export function isBlockedByOtherAction(
  activity: ComposeAiActivity,
  self: ComposeAiAction,
): boolean {
  return (Object.keys(activity) as ComposeAiAction[]).some(
    action => action !== self && activity[action],
  )
}
