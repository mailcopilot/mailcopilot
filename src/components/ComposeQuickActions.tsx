/**
 * ComposeQuickActions — B4 Compose Quick Actions toolbar.
 *
 * A thin toolbar rendered above the compose body: four preset buttons
 * (Improve / Shorter / Formal / Grammar), an inline loading/refusal status, and
 * the before/after diff preview. All logic lives in `useQuickActions`; this
 * component wires the current draft text + caret in, and applies the user's
 * Replace/Insert choice out via callbacks the parent owns. No hardcoded copy.
 *
 * The parent (Compose) keeps ownership of the textarea state and passes:
 *   - `text` — current draft body (captured at click time to send to backend);
 *   - `getCaret` — current caret index (read lazily on Insert);
 *   - `onReplace(next)` / `onInsert(rewritten, caret)` — mutation callbacks.
 * This keeps the "no auto-substitution" invariant: the body only changes when
 * the parent's callback runs after an explicit Replace/Insert.
 */

import { useTranslation } from 'react-i18next'
import { Sparkles, Loader2 } from 'lucide-react'
import {
  QUICK_ACTION_PRESETS,
  quickActionLabelKey,
  hasRewritableText,
  insertAtCaret,
  type QuickActionRefusalReason,
} from '../utils/quickActions'
import { useQuickActions } from '../hooks/useQuickActions'
import { QuickActionDiff } from './QuickActionDiff'

export type ComposeQuickActionsProps = {
  /** Account authoring the draft; `null` disables the toolbar. */
  accountId: number | null
  /** Current draft body text. */
  text: string
  /** Whether the compose is mid-send (disables the toolbar). */
  disabled?: boolean
  /** Lazily read the current caret index in the body textarea. */
  getCaret: () => number
  /** Replace the whole draft body with `next`. */
  onReplace: (next: string) => void
  /** Insert `text` at `caret`, returning the new body + caret to the parent. */
  onInsert: (next: string, caret: number) => void
}

/** Map a surfaced refusal reason to its localized inline message key. */
function refusalMessageKey(reason: QuickActionRefusalReason): string {
  switch (reason) {
    case 'budget':
      return 'ai.quickAction.refusal.budget'
    case 'no_provider':
      return 'ai.quickAction.refusal.noProvider'
    case 'provider_error':
      return 'ai.quickAction.refusal.providerError'
    case 'empty_input':
      return 'ai.quickAction.refusal.emptyInput'
    default:
      return 'ai.quickAction.refusal.providerError'
  }
}

export function ComposeQuickActions({
  accountId,
  text,
  disabled = false,
  getCaret,
  onReplace,
  onInsert,
}: ComposeQuickActionsProps) {
  const { t } = useTranslation()
  const qa = useQuickActions({ accountId })

  const canRun = accountId != null && !disabled && hasRewritableText(text)

  return (
    <div className="compose-quick-actions" data-testid="compose-quick-actions">
      <div className="compose-quick-actions-bar">
        <Sparkles size={14} className="compose-quick-actions-icon" aria-hidden="true" />
        {QUICK_ACTION_PRESETS.map(preset => {
          const isRunning = qa.status === 'loading' && qa.activePreset === preset
          return (
            <button
              key={preset}
              type="button"
              className="compose-quick-action-btn"
              data-testid={`compose-quick-action-${preset}`}
              disabled={!canRun || qa.status === 'loading'}
              aria-busy={isRunning}
              onClick={() => qa.run(preset, text)}
              title={t(quickActionLabelKey(preset))}
            >
              {isRunning ? (
                <Loader2 size={13} className="spin" aria-hidden="true" />
              ) : null}
              {t(quickActionLabelKey(preset))}
            </button>
          )
        })}
      </div>

      {qa.status === 'refused' && qa.refusal && (
        <div className="compose-quick-actions-refusal" data-testid="compose-quick-actions-refusal">
          {t(refusalMessageKey(qa.refusal))}
        </div>
      )}

      {qa.status === 'ready' && qa.preview && (
        <QuickActionDiff
          preview={qa.preview}
          onReplace={() => {
            onReplace(qa.preview!.rewritten)
            qa.dismiss()
          }}
          onInsert={() => {
            const { text: next, caret } = insertAtCaret(text, qa.preview!.rewritten, getCaret())
            onInsert(next, caret)
            qa.dismiss()
          }}
          onCancel={qa.dismiss}
        />
      )}
    </div>
  )
}
