/**
 * QuickActionDiff — B4 Compose Quick Actions before/after preview.
 *
 * A thin, presentational modal-ish panel that shows the current draft ("before")
 * and the AI-rewritten text ("after") as WHOLE blocks (no word-level diff, no
 * external diff library — deliberate per the approved STOP 1 design). The user
 * chooses one of three explicit actions:
 *   - Replace — swap the whole draft body with the rewritten text.
 *   - Insert  — splice the rewritten text at the current caret position.
 *   - Cancel  — discard the preview, leaving the draft untouched.
 *
 * The component NEVER mutates the draft itself — it only invokes the callbacks;
 * the parent owns the textarea state (no auto-substitution invariant). Every
 * label is `t('...')`; no hardcoded copy.
 */

import { useTranslation } from 'react-i18next'
import { Check, CornerDownLeft, X } from 'lucide-react'
import type { QuickActionPreview } from '../hooks/useQuickActions'
import { quickActionLabelKey } from '../utils/quickActions'

export type QuickActionDiffProps = {
  preview: QuickActionPreview
  /** Replace the whole draft body with the rewritten text. */
  onReplace: () => void
  /** Insert the rewritten text at the current caret position. */
  onInsert: () => void
  /** Dismiss without changing the draft. */
  onCancel: () => void
}

export function QuickActionDiff({ preview, onReplace, onInsert, onCancel }: QuickActionDiffProps) {
  const { t } = useTranslation()

  return (
    <div
      className="quick-action-diff"
      data-testid="quick-action-diff"
      role="dialog"
      aria-modal="true"
      aria-label={t('ai.quickAction.diff.title')}
    >
      <div className="quick-action-diff-header">
        <span className="quick-action-diff-title">
          {t('ai.quickAction.diff.title')}
        </span>
        <span className="quick-action-diff-preset">
          {t(quickActionLabelKey(preview.preset))}
        </span>
        <button
          type="button"
          className="btn-icon quick-action-diff-close"
          data-testid="quick-action-diff-close"
          onClick={onCancel}
          title={t('ai.quickAction.diff.cancel')}
          aria-label={t('ai.quickAction.diff.cancel')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="quick-action-diff-panes">
        <div className="quick-action-diff-pane quick-action-diff-before">
          <span className="quick-action-diff-pane-label">
            {t('ai.quickAction.diff.before')}
          </span>
          <pre className="quick-action-diff-text" data-testid="quick-action-diff-before">
            {preview.original}
          </pre>
        </div>
        <div className="quick-action-diff-pane quick-action-diff-after">
          <span className="quick-action-diff-pane-label">
            {t('ai.quickAction.diff.after')}
          </span>
          <pre className="quick-action-diff-text" data-testid="quick-action-diff-after">
            {preview.rewritten}
          </pre>
        </div>
      </div>

      <div className="quick-action-diff-actions">
        <button
          type="button"
          className="btn-primary"
          data-testid="quick-action-diff-replace"
          onClick={onReplace}
        >
          <Check size={14} /> {t('ai.quickAction.diff.replace')}
        </button>
        <button
          type="button"
          data-testid="quick-action-diff-insert"
          onClick={onInsert}
        >
          <CornerDownLeft size={14} /> {t('ai.quickAction.diff.insert')}
        </button>
        <button
          type="button"
          data-testid="quick-action-diff-cancel"
          onClick={onCancel}
        >
          {t('ai.quickAction.diff.cancel')}
        </button>
      </div>
    </div>
  )
}
