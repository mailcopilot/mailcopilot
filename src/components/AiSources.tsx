/**
 * The "Sources" block under an assistant answer (§3.3 B3). Above
 * `SOURCES_COLLAPSED_COUNT` sources only the first ones are shown behind a
 * toggle, so an answer citing dozens of messages does not fill the panel.
 * The state is per answer and not persisted: each answer mounts its own
 * instance, collapsed.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CitationStatus } from '../utils/aiSourceVerdict'

export const SOURCES_COLLAPSED_COUNT = 3

export type AiSourcesProps = {
  /** Tickets main knows (found or gone), in the order the answer cites them. */
  cited: ReadonlyArray<Exclude<CitationStatus, { status: 'unknown' }>>
  onOpen: (token: string) => void
}

export default function AiSources({ cited, onOpen }: AiSourcesProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const collapsible = cited.length > SOURCES_COLLAPSED_COUNT
  const shown = collapsible && !expanded ? cited.slice(0, SOURCES_COLLAPSED_COUNT) : cited

  return (
    <div className="ai-sources">
      <div className="ai-sources-title">{t('ai.panel.sources')}</div>
      <div className="ai-sources-list" id={listId}>
        {shown.map((c, idx) => {
          const gone = c.status === 'missing'
          const subject = c.status === 'found' ? c.subject : ''
          const from = c.status === 'found' ? c.from : ''
          return (
            <button
              key={`${c.token}:${idx}`}
              type="button"
              className="ai-source-link"
              aria-disabled={gone || undefined}
              onClick={() => onOpen(c.token)}
              title={gone ? t('ai.panel.sourceNotFound') : subject ? `${from || ''} — ${subject}` : t('ai.panel.sourceNoSubject')}
            >
              <span className="ai-source-num">#{idx + 1}</span>
              {gone
                ? <span className="ai-source-fallback">{t('ai.panel.sourceNotFound')}</span>
                : subject
                  ? <span className="ai-source-subject">{subject}</span>
                  : <span className="ai-source-fallback">{t('ai.panel.sourceNoSubject')}</span>}
              {!gone && from && <span className="ai-source-from">{from}</span>}
            </button>
          )
        })}
        {collapsible && (
          <button
            type="button"
            className="ai-sources-toggle"
            data-testid="ai-sources-toggle"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded(e => !e)}
          >
            {expanded ? t('ai.panel.sourcesCollapse') : t('ai.panel.sourcesShowAll', { count: cited.length })}
          </button>
        )}
      </div>
    </div>
  )
}
