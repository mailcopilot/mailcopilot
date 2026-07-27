/**
 * ThreadSummaryStrip — B2 Thread AI Summary presentation layer.
 *
 * A thin, presentational strip rendered ABOVE the stack-of-cards in ThreadView
 * for the actively-open thread (≥3 messages, account opted in). All logic —
 * debounce, IPC, cache-hit, refusals — lives in `useThreadSummary`; this
 * component only renders the hook's output and owns the local expand/collapse
 * UI state for the 5 bullets. No hardcoded copy: every label is `t('...')`.
 */

import { useState } from 'react'
import { Sparkles, Loader2, RotateCw, ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ThreadSummary, ThreadSummaryRefusalReason } from '@mailcopilot/types'
import type { ThreadSummaryStatus } from '../hooks/useThreadSummary'

export type ThreadSummaryStripProps = {
  status: ThreadSummaryStatus
  summary: ThreadSummary | null
  refusal: ThreadSummaryRefusalReason | null
  /** Re-run generate (provider_error retry affordance). */
  onRetry: () => void
}

/** Map a surfaced refusal reason to its localized inline message key. */
function refusalMessageKey(reason: ThreadSummaryRefusalReason): string | null {
  switch (reason) {
    case 'budget':
      return 'ai.threadSummary.refusal.budget'
    case 'no_provider':
      return 'ai.threadSummary.refusal.noProvider'
    case 'provider_error':
      return 'ai.threadSummary.refusal.providerError'
    // too_short / opt_out never reach the strip (hook leaves them idle), but
    // the exhaustive switch keeps this honest if the contract grows.
    case 'too_short':
    case 'opt_out':
      return null
    default:
      return null
  }
}

export function ThreadSummaryStrip({ status, summary, refusal, onRetry }: ThreadSummaryStripProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="thread-summary-strip" data-testid="thread-summary-strip">
      <div className="thread-summary-header">
        <Sparkles size={14} className="thread-summary-icon" aria-hidden="true" />
        <span className="thread-summary-title">{t('ai.threadSummary.title')}</span>
      </div>

      {status === 'loading' && (
        <div className="thread-summary-loading" data-testid="thread-summary-loading">
          <Loader2 size={14} className="spin" aria-hidden="true" />
          <span>{t('ai.threadSummary.loading')}</span>
        </div>
      )}

      {status === 'refused' && refusal && (() => {
        const key = refusalMessageKey(refusal)
        if (!key) return null
        return (
          <div className="thread-summary-refusal" data-testid="thread-summary-refusal">
            <span className="thread-summary-refusal-text">{t(key)}</span>
            {refusal === 'provider_error' && (
              <button
                type="button"
                className="thread-summary-retry"
                data-testid="thread-summary-retry"
                onClick={onRetry}
              >
                <RotateCw size={12} aria-hidden="true" /> {t('ai.threadSummary.retry')}
              </button>
            )}
          </div>
        )
      })()}

      {status === 'ready' && summary && (
        <div className="thread-summary-body">
          {/*
            The one-line summary IS the expand/collapse control — clicking (or
            keyboard-activating) it toggles the five key points, matching the
            documented fast-email UX. It's a real <button> so it inherits native
            keyboard operability (Enter/Space) and focusability; aria-expanded
            reflects the disclosure state and the chevron gives a visual cue.
            The bullets are the controlled region (aria-controls) so assistive
            tech announces the relationship.
          */}
          <button
            type="button"
            className="thread-summary-oneline"
            data-testid="thread-summary-oneline"
            aria-expanded={expanded}
            aria-controls="thread-summary-bullets"
            title={expanded ? t('ai.threadSummary.collapse') : t('ai.threadSummary.expand')}
            onClick={() => setExpanded(v => !v)}
          >
            <span className="thread-summary-oneline-text">{summary.oneLine}</span>
            {expanded ? (
              <ChevronUp size={12} className="thread-summary-chevron" aria-hidden="true" />
            ) : (
              <ChevronDown size={12} className="thread-summary-chevron" aria-hidden="true" />
            )}
          </button>
          {expanded && (
            <ul
              id="thread-summary-bullets"
              className="thread-summary-bullets"
              data-testid="thread-summary-bullets"
            >
              {summary.bullets.map((bullet, i) => (
                <li key={i}>{bullet}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
