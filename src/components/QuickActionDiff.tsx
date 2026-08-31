/**
 * QuickActionDiff — B4 Compose Quick Actions rewrite review panel (§3.3.B4.f5).
 *
 * An overlay that shows the user's OWN draft text with the AI rewrite marked up
 * IN PLACE — removals struck through, additions highlighted — plus a list of
 * the individual edits. It replaced a pair of independent before/after boxes,
 * which forced the reader to spot the differences themselves and, being fixed
 * at 180px each, showed a couple of lines of a long draft.
 *
 * A RECOGNIZED quoted original, forwarded message or signature is part of
 * neither side: it is not sent to the model and not replaced (§2.78). The
 * boundary is decided upstream by `splitComposeBody()`; nothing here re-derives
 * it. That splitter is best-effort over flat text (§2.173): a quoting style it
 * does not recognize is classified as own text and IS sent and rewritten. Read
 * the guarantee as "the recognized tail stays out", not as "no quoted text ever
 * leaves". The user chooses one of three explicit actions:
 *   - Replace — swap the user's own part with the rewritten text, tail intact.
 *   - Insert  — splice the rewritten text at the current caret position.
 *   - Cancel  — discard the preview, leaving the draft untouched.
 *
 * When `stale` is set (the draft changed while the rewrite was in flight) the
 * panel shows a warning and disables Replace, because applying it would drop
 * whatever was typed during generation (§2.78 AC-h). Insert stays enabled — it
 * splices into the current body and loses nothing.
 *
 * The component NEVER mutates the draft itself — it only invokes the callbacks;
 * the parent owns the textarea state (no auto-substitution invariant). Every
 * label is `t('...')`; no hardcoded copy.
 *
 * ## What lives here and what does not
 *
 * Nothing in this file decides what changed. The segmentation is
 * `diffComposeText()` in `@mailcopilot/core` — pure, DOM-free, unit-tested, and
 * shared with the per-edit corrector (B7). This component maps blocks and
 * segments onto markup and owns exactly two pieces of local state: which
 * unchanged regions the user expanded, and whether the plain-text copies are
 * shown. Any new rule about WHICH words are highlighted belongs in core.
 *
 * ## Why `<ins>` / `<del>` and why the signs
 *
 * The markup is semantic, not decorative: the HTML standard defines `<ins>` as
 * "an addition to the document" and `<del>` as "a removal from the document"
 * (https://html.spec.whatwg.org/multipage/edits.html), so a screen reader
 * announces the edit rather than reading a colour it cannot see. The leading
 * `−` / `+` sign covers the same ground for sighted users who cannot rely on
 * hue; it is `aria-hidden` precisely because the element already says it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronUp, CornerDownLeft, Undo2, X } from 'lucide-react'
import {
  changedBlockIds,
  diffComposeText,
  summarizeEqualBlock,
  type ComposeDiffBlock,
  type ComposeDiffSegment,
} from '@mailcopilot/core'
import type { ProofreadReview } from '../hooks/useQuickActions'
import type { QuickActionPreset } from '../utils/quickActions'
import { proofreadCategoryKey, quickActionLabelKey } from '../utils/quickActions'
import { recordEvent } from '../utils/metrics'

/** The three explicit endings a shown preview can have (telemetry domain). */
type PreviewOutcome = 'replaced' | 'inserted' | 'cancelled'

/**
 * The material this panel renders, generalized past the four B4 presets
 * (§3.3 B6 draft side reuses it for a draft translation).
 *
 * Both preset-derived things are now optional and independent: `preset` is the
 * telemetry tag — a closed four-value enum, so a panel that is not a preset
 * rewrite records NO outcome rather than inventing a fifth value — and
 * `labelKey` is the header caption. A `QuickActionPreview` from `useQuickActions`
 * satisfies this shape unchanged (its `preset` is required and its extra fields
 * are ignored), so the four quick actions render byte-identically to before.
 */
export type QuickActionDiffPreview = {
  /** The "before" side: the user's own text at request time. */
  original: string
  /** The "after" side: the produced replacement for exactly that string. */
  rewritten: string
  /** B4 preset when this IS one of the four rewrites; absent otherwise. */
  preset?: QuickActionPreset | null
  /** Header caption key. Defaults to the preset's own label. */
  labelKey?: string
}

export type QuickActionDiffProps = {
  preview: QuickActionDiffPreview
  /**
   * The draft body changed after this rewrite was requested, so Replace would
   * discard the user's newer edits. Disables Replace and shows the warning.
   */
  stale?: boolean
  /** Replace the user's own part with the rewritten text (tail preserved). */
  onReplace: () => void
  /** Insert the rewritten text at the current caret position. */
  onInsert: () => void
  /** Dismiss without changing the draft. */
  onCancel: () => void
}

/** One `<ins>` / `<del>` / plain run inside the marked-up text. */
function Segment({ segment }: { segment: ComposeDiffSegment }) {
  if (segment.op === 'equal') return <span className="quick-action-diff-same">{segment.text}</span>
  if (segment.op === 'insert') {
    return (
      <ins className="quick-action-diff-ins">
        <span className="quick-action-diff-sign" aria-hidden="true">+</span>
        {segment.text}
      </ins>
    )
  }
  return (
    <del className="quick-action-diff-del">
      <span className="quick-action-diff-sign" aria-hidden="true">{'−'}</span>
      {segment.text}
    </del>
  )
}

export function QuickActionDiff({ preview, stale = false, onReplace, onInsert, onCancel }: QuickActionDiffProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)

  const diff = useMemo(
    () => diffComposeText(preview.original, preview.rewritten),
    [preview.original, preview.rewritten],
  )
  // Caption: an explicit key wins, else the preset's own label, else nothing —
  // a chip with no honest text is not rendered rather than rendered empty.
  const captionKey = preview.labelKey ?? (preview.preset ? quickActionLabelKey(preview.preset) : null)
  const editIds = useMemo(() => changedBlockIds(diff.blocks), [diff.blocks])

  // Which unchanged regions the user chose to unfold. Keyed by block id, which
  // is only meaningful within one diff — so the set is reset whenever the diff
  // is recomputed rather than carried across previews.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [showPlain, setShowPlain] = useState(false)
  useEffect(() => {
    setExpanded(new Set())
    setShowPlain(false)
  }, [preview.original, preview.rewritten])

  const toggleExpanded = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // A modal panel takes the keyboard: Escape has to dismiss it, so it needs
  // focus. Focusing the container (rather than a button) avoids implying that
  // any one of the three choices is the default.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  /**
   * Record what the user did with the preview, then run the choice.
   *
   * Two closed enums and nothing derived from the draft — see
   * `ai.quick_action.preview_outcome` in electron/metricsSchema.ts for the full
   * privacy note, including why an unmount without a choice records nothing.
   */
  const finish = useCallback((outcome: PreviewOutcome, run: () => void) => {
    // Only a preset rewrite has an outcome to record: the tag is a closed
    // four-value enum, and a panel opened by another feature has no honest
    // member of it. Silence beats a fabricated value.
    if (preview.preset) recordEvent('ai.quick_action.preview_outcome', { preset: preview.preset, outcome })
    run()
  }, [preview.preset])

  const cancel = useCallback(() => finish('cancelled', onCancel), [finish, onCancel])

  const handleReplace = useCallback(() => {
    // §2.78 AC-h: the button is disabled while stale, and this guard covers a
    // programmatic click. It sits BEFORE the counter so a refused click is not
    // reported as a replacement that happened.
    if (stale) return
    finish('replaced', onReplace)
  }, [stale, finish, onReplace])

  const renderBlock = (block: ComposeDiffBlock) => {
    if (block.kind === 'equal') {
      const summary = summarizeEqualBlock(block.before)
      const isExpanded = expanded.has(block.id)
      if (!summary.collapsible) {
        return <span key={block.id} className="quick-action-diff-same">{block.before}</span>
      }
      return (
        <span key={block.id} className="quick-action-diff-fold">
          <button
            type="button"
            className="quick-action-diff-fold-toggle"
            data-testid="quick-action-diff-fold"
            aria-expanded={isExpanded}
            onClick={() => toggleExpanded(block.id)}
          >
            {isExpanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
            {t('ai.quickAction.diff.unchangedLines', { count: summary.lines })}
          </button>
          {isExpanded && <span className="quick-action-diff-same">{block.before}</span>}
        </span>
      )
    }
    return (
      <span key={block.id} className="quick-action-diff-change" data-block-kind={block.kind}>
        {block.segments.map((segment, i) => (
          <Segment key={`${block.id}-${i}`} segment={segment} />
        ))}
      </span>
    )
  }

  return (
    <>
      {/*
        The backdrop is the click-outside target and the visual separation from
        the draft underneath. It carries no label of its own — the dialog next
        to it is what assistive technology should announce.
      */}
      <div
        className="quick-action-diff-backdrop"
        data-testid="quick-action-diff-backdrop"
        aria-hidden="true"
        onClick={cancel}
      />
      <div
        ref={panelRef}
        className="quick-action-diff"
        data-testid="quick-action-diff"
        role="dialog"
        aria-modal="true"
        aria-label={t('ai.quickAction.diff.title')}
        tabIndex={-1}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            cancel()
          }
        }}
      >
        <div className="quick-action-diff-header">
          <span className="quick-action-diff-title">
            {t('ai.quickAction.diff.title')}
          </span>
          {captionKey !== null && (
            <span className="quick-action-diff-preset" data-testid="quick-action-diff-preset">
              {t(captionKey)}
            </span>
          )}
          <span className="quick-action-diff-count" data-testid="quick-action-diff-count">
            {t('ai.quickAction.diff.changeCount', { count: diff.changeCount })}
          </span>
          <button
            type="button"
            className="btn-icon quick-action-diff-close"
            data-testid="quick-action-diff-close"
            onClick={cancel}
            title={t('ai.quickAction.diff.cancel')}
            aria-label={t('ai.quickAction.diff.cancel')}
          >
            <X size={14} />
          </button>
        </div>

        {/*
          One scrolling area, sized by the space the overlay has — not two
          fixed boxes. Everything the reader compares lives in it, in reading
          order: the marked-up text, then the edit list, then the plain copies.
        */}
        <div className="quick-action-diff-body" data-testid="quick-action-diff-body">
          {diff.identical ? (
            <p className="quick-action-diff-empty" data-testid="quick-action-diff-empty">
              {t('ai.quickAction.diff.noChanges')}
            </p>
          ) : null}

          <div className="quick-action-diff-merged" data-testid="quick-action-diff-merged">
            {diff.blocks.map(renderBlock)}
          </div>

          {editIds.length > 0 && (
            <div className="quick-action-diff-edits">
              <span className="quick-action-diff-pane-label">
                {t('ai.quickAction.diff.editsHeading')}
              </span>
              <ol className="quick-action-diff-edit-list" data-testid="quick-action-diff-edits">
                {diff.blocks
                  .filter(block => block.kind !== 'equal')
                  .map(block => (
                    <li key={block.id} className="quick-action-diff-edit" data-testid="quick-action-diff-edit">
                      {block.before !== '' && (
                        <del className="quick-action-diff-del">
                          <span className="quick-action-diff-sign" aria-hidden="true">{'−'}</span>
                          {block.before}
                        </del>
                      )}
                      {block.after !== '' && (
                        <ins className="quick-action-diff-ins">
                          <span className="quick-action-diff-sign" aria-hidden="true">+</span>
                          {block.after}
                        </ins>
                      )}
                    </li>
                  ))}
              </ol>
            </div>
          )}

          {/*
            The two plain copies stay reachable — for copying the rewrite out,
            and for reading it as prose rather than as marked-up text. Folded by
            default and stacked, never side by side: a two-column line-by-line
            comparison is a code-review primitive, and no prose editor uses one.
          */}
          <div className="quick-action-diff-plain">
            <button
              type="button"
              className="quick-action-diff-plain-toggle"
              data-testid="quick-action-diff-plain-toggle"
              aria-expanded={showPlain}
              onClick={() => setShowPlain(v => !v)}
            >
              {showPlain ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
              {t('ai.quickAction.diff.plainText')}
            </button>
            <div
              className="quick-action-diff-plain-panes"
              data-testid="quick-action-diff-plain-panes"
              hidden={!showPlain}
            >
              <span className="quick-action-diff-pane-label">{t('ai.quickAction.diff.before')}</span>
              <pre className="quick-action-diff-text" data-testid="quick-action-diff-before">
                {preview.original}
              </pre>
              <span className="quick-action-diff-pane-label">{t('ai.quickAction.diff.after')}</span>
              <pre className="quick-action-diff-text" data-testid="quick-action-diff-after">
                {preview.rewritten}
              </pre>
            </div>
          </div>
        </div>

        {stale && (
          <div
            className="quick-action-diff-stale"
            data-testid="quick-action-diff-stale"
            role="status"
          >
            {t('ai.quickAction.diff.staleWarning')}
          </div>
        )}

        <div className="quick-action-diff-actions">
          <button
            type="button"
            className="btn-primary"
            data-testid="quick-action-diff-replace"
            disabled={stale}
            title={stale ? t('ai.quickAction.diff.staleReplaceHint') : undefined}
            onClick={handleReplace}
          >
            <Check size={14} /> {t('ai.quickAction.diff.replace')}
          </button>
          <button
            type="button"
            data-testid="quick-action-diff-insert"
            onClick={() => finish('inserted', onInsert)}
          >
            <CornerDownLeft size={14} /> {t('ai.quickAction.diff.insert')}
          </button>
          <button
            type="button"
            data-testid="quick-action-diff-cancel"
            onClick={cancel}
          >
            {t('ai.quickAction.diff.cancel')}
          </button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// §3.3 B7 — ProofreadPanel: the per-edit corrector's review panel.
//
// Same overlay shell and the same visual language as the rewrite panel above
// (semantic <del>/<ins> with a colour-independent −/+ sign), but a different
// decision for the user: instead of ONE all-or-nothing substitution, each
// suggestion is accepted or left alone on its own, and only the accepted ones
// are written back.
//
// Honesty rules this panel is bound by:
//   - `edits: []` is the "nothing to fix" answer, not a failure — it gets its
//     own copy, not a refusal line;
//   - `dropped` is SHOWN. A list quietly shortened by suggestions main could
//     not anchor would read as a clean draft;
//   - `edit.message` is model-authored third-party text in the DRAFT's
//     language. It is rendered and nothing else — never logged, never parsed,
//     never used to decide anything;
//   - the panel never claims the quoted material is protected by a guarantee.
//     The own/quote/signature boundary is an estimate over flat text (§2.173);
//     the copy talks about checking "your text", which is what was sent.
//
// Nothing here computes or adjusts an offset: spans come from main already
// verified against the exact string that was sent, and applying them is
// `applyComposeEdits` in core, called by the hook.
// ---------------------------------------------------------------------------

export type ProofreadPanelProps = {
  review: ProofreadReview
  /** Ids of the edits the user has accepted. */
  accepted: ReadonlySet<string>
  /**
   * The draft body changed after the check was requested, so every offset now
   * points into a string that no longer exists. Disables Apply (§2.78 AC-h);
   * unlike the rewrite panel there is no caret-insert fallback, because a
   * suggestion is only meaningful at its own span.
   */
  stale?: boolean
  onToggleEdit: (id: string) => void
  onAcceptAll: () => void
  /** Write the accepted edits back into the draft. */
  onApply: () => void
  /** Dismiss without changing the draft. */
  onCancel: () => void
}

export function ProofreadPanel({
  review,
  accepted,
  stale = false,
  onToggleEdit,
  onAcceptAll,
  onApply,
  onCancel,
}: ProofreadPanelProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)

  // A modal panel takes the keyboard, so it needs focus for Escape to work.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  const acceptedCount = review.edits.reduce((n, e) => (accepted.has(e.id) ? n + 1 : n), 0)
  const canApply = !stale && acceptedCount > 0

  const apply = useCallback(() => {
    // The button is disabled in both blocking states; this guard covers a
    // programmatic click, exactly as in the rewrite panel.
    if (stale) return
    onApply()
  }, [stale, onApply])

  return (
    <>
      <div
        className="quick-action-diff-backdrop"
        data-testid="proofread-backdrop"
        aria-hidden="true"
        onClick={onCancel}
      />
      <div
        ref={panelRef}
        className="quick-action-diff proofread-panel"
        data-testid="proofread-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('ai.quickAction.proofread.title')}
        tabIndex={-1}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
      >
        <div className="quick-action-diff-header">
          <span className="quick-action-diff-title">{t('ai.quickAction.proofread.title')}</span>
          <span className="quick-action-diff-count" data-testid="proofread-count">
            {t('ai.quickAction.proofread.editCount', { count: review.edits.length })}
          </span>
          <button
            type="button"
            className="btn-icon quick-action-diff-close"
            data-testid="proofread-close"
            onClick={onCancel}
            title={t('ai.quickAction.proofread.cancel')}
            aria-label={t('ai.quickAction.proofread.cancel')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="quick-action-diff-body">
          {review.edits.length === 0 ? (
            <p className="quick-action-diff-empty" data-testid="proofread-no-edits">
              {t('ai.quickAction.proofread.noEdits')}
            </p>
          ) : (
            <ul className="proofread-edit-list" data-testid="proofread-edits">
              {review.edits.map(edit => {
                const isAccepted = accepted.has(edit.id)
                return (
                  <li
                    key={edit.id}
                    className="proofread-edit"
                    data-testid="proofread-edit"
                    data-accepted={isAccepted ? 'true' : 'false'}
                  >
                    <div className="proofread-edit-texts">
                      <del className="quick-action-diff-del">
                        <span className="quick-action-diff-sign" aria-hidden="true">{'−'}</span>
                        {edit.original}
                      </del>
                      <ins className="quick-action-diff-ins">
                        <span className="quick-action-diff-sign" aria-hidden="true">+</span>
                        {edit.replacement}
                      </ins>
                    </div>
                    <div className="proofread-edit-meta">
                      <span className="proofread-edit-category">
                        {t(proofreadCategoryKey(edit.category))}
                      </span>
                      {/* Model-authored explanation: display-only (see the
                          docblock). Rendered as text, never as markup. */}
                      {edit.message ? (
                        <span className="proofread-edit-message" data-testid="proofread-edit-message">
                          {edit.message}
                        </span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="proofread-edit-accept"
                      data-testid={`proofread-edit-toggle-${edit.id}`}
                      aria-pressed={isAccepted}
                      onClick={() => onToggleEdit(edit.id)}
                    >
                      {isAccepted ? <Undo2 size={13} /> : <Check size={13} />}
                      {isAccepted
                        ? t('ai.quickAction.proofread.undo')
                        : t('ai.quickAction.proofread.accept')}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {review.dropped > 0 && (
            <p className="proofread-dropped" data-testid="proofread-dropped">
              {t('ai.quickAction.proofread.dropped', { count: review.dropped })}
            </p>
          )}
        </div>

        {stale && (
          <div className="quick-action-diff-stale" data-testid="proofread-stale" role="status">
            {t('ai.quickAction.proofread.staleWarning')}
          </div>
        )}

        <div className="quick-action-diff-actions">
          <button
            type="button"
            className="btn-primary"
            data-testid="proofread-apply"
            disabled={!canApply}
            onClick={apply}
          >
            <Check size={14} /> {t('ai.quickAction.proofread.apply')}
          </button>
          {review.edits.length > 0 && (
            <button
              type="button"
              data-testid="proofread-accept-all"
              disabled={acceptedCount === review.edits.length}
              onClick={onAcceptAll}
            >
              {t('ai.quickAction.proofread.acceptAll')}
            </button>
          )}
          <button type="button" data-testid="proofread-cancel" onClick={onCancel}>
            {t('ai.quickAction.proofread.cancel')}
          </button>
        </div>
      </div>
    </>
  )
}
