/**
 * RecipientList — collapsible recipient chip list for the mail reading pane
 * and standalone MailWindow.
 *
 * §3.3.C-uiaudit.22: Recipients with 10+ addresses were fully inaccessible
 * due to ellipsis cutoff with no expand or tooltip. This component fixes that
 * by rendering the first `maxVisible` addresses inline with a "+N more" toggle
 * button that expands to the full list.
 *
 * Accessibility:
 *   - Tab navigates chips and the "+N more" button.
 *   - Enter/Space on "+N more" toggles expand.
 *   - Esc on an expanded list collapses it.
 *   - Each chip has data-tooltip="Name <email>" for delegation via
 *     useTooltipDelegation (position: fixed, escapes overflow context).
 *
 * Pure presentation — no IPC, no side effects.
 */

import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { MailAddress } from '@mailcopilot/types'
import { addrDisplayName, addrTooltip } from '@mailcopilot/core'
import { useTooltipDelegation } from '../hooks/useTooltipDelegation'

export interface RecipientListProps {
  addresses: MailAddress[]
  /** How many recipients to show before collapsing the rest. Default: 3. */
  maxVisible?: number
}

export default function RecipientList({ addresses, maxVisible = 3 }: RecipientListProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  // stopNativePropagation: prevent mouse events from bubbling to the App-level
  // useTooltipDelegation container (.mailcopilot-app). Without it, hovering a
  // chip would produce two simultaneous .tooltip-portal elements.
  const { tooltipState, containerRef } = useTooltipDelegation({ stopNativePropagation: true })

  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // RefCallback that attaches both our local ref and the tooltip delegation ref.
  const setRef = useCallback((node: HTMLDivElement | null) => {
    wrapperRef.current = node
    containerRef(node)
  }, [containerRef])

  const total = addresses.length
  const overflow = total - maxVisible
  const hasMore = overflow > 0

  const visible = expanded ? addresses : addresses.slice(0, maxVisible)

  const handleToggle = useCallback(() => {
    setExpanded(prev => !prev)
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && expanded) {
      setExpanded(false)
      e.stopPropagation()
    }
  }, [expanded])

  const handleMoreKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleToggle()
    }
  }, [handleToggle])

  if (total === 0) return null

  return (
    <div
      ref={setRef}
      className="recipient-list"
      data-testid="recipient-list"
      // tabIndex={-1} makes the container programmatically focusable so that
      // Playwright's locator.press('Escape') can deliver keyboard events here
      // (unfocusable divs silently drop keyboard events in Chromium).
      // It does NOT enter the tab order (tabIndex < 0).
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      // Stop mouse events from bubbling to the App-level useTooltipDelegation
      // container (.mailcopilot-app). Without this, hovering a chip triggers
      // BOTH the RecipientList hook AND the App hook, producing two
      // .tooltip-portal elements and causing Playwright strict-mode failures.
      onMouseOver={e => { e.stopPropagation() }}
      onMouseOut={e => { e.stopPropagation() }}
    >
      {visible.map((addr, i) => (
        <span
          key={`${addr.address ?? ''}-${i}`}
          className="recipient-chip"
          data-testid="recipient-chip"
          tabIndex={0}
          data-tooltip={addrTooltip(addr) || undefined}
        >
          {addrDisplayName(addr)}
        </span>
      ))}
      {/* Single toggle button node — className and aria-expanded update in
          place so React never unmounts/remounts the DOM element on toggle.
          This avoids any stale-handle timing issues in e2e automation. */}
      {hasMore && (
        <button
          type="button"
          className={`recipient-more-btn${expanded ? ' recipient-more-btn--collapse' : ''}`}
          data-testid="recipient-more-btn"
          onClick={handleToggle}
          onKeyDown={handleMoreKeyDown}
          aria-expanded={expanded}
          aria-label={t('mail.recipients.moreCount', { count: overflow })}
        >
          {t('mail.recipients.moreCount', { count: overflow })}
        </button>
      )}
      {tooltipState && (
        <div
          className="tooltip-portal"
          role="tooltip"
          style={{
            position: 'fixed',
            left: tooltipState.x,
            top: tooltipState.y,
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
          }}
        >
          {tooltipState.text}
        </div>
      )}
    </div>
  )
}
