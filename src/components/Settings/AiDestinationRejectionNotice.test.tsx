// @vitest-environment jsdom
/**
 * Component tests for src/components/Settings/AiDestinationRejectionNotice.tsx
 * — BACKLOG §2.119.
 *
 * What each test protects:
 *   - the sentence shown is MAIN'S, verbatim (a renderer re-wording would
 *     disagree with the native dialog the person just answered);
 *   - the affected field is named (both inputs are on screen at once);
 *   - the save's other edits are reported as saved (they were applied);
 *   - the three reasons are presented differently: calm for a decline, an
 *     alert for an unusable value, a retry for the transient case.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { AiDestinationRejection } from '../../hooks/useAiDestinationRejection'

const i18nMap: Record<string, string> = {
  'aiDestination.endpointLabel': 'AI endpoint address',
  'aiDestination.proxyLabel': 'Proxy for AI requests',
  'settings.aiDestination.declinedTitle': 'Address left unchanged',
  'settings.aiDestination.invalidTitle': 'Address not accepted',
  'settings.aiDestination.busyTitle': 'Address change not applied',
  'settings.aiDestination.unchangedFields': 'Still using the previous value for: {{fields}}.',
  'settings.aiDestination.otherSettingsSaved': 'Other accepted changes on this screen were saved.',
  'settings.aiDestination.retry': 'Try again',
}
const stableT = (key: string, opts?: Record<string, unknown>): string => {
  const value = i18nMap[key] ?? key
  if (!opts) return value
  return value.replace(/\{\{(\w+)\}\}/g, (_, k) => (opts[k] !== undefined ? String(opts[k]) : `{{${k}}}`))
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: stableT }) }))

const { default: AiDestinationRejectionNotice } = await import('./AiDestinationRejectionNotice')

function rejection(patch: Partial<AiDestinationRejection> = {}): AiDestinationRejection {
  return {
    reason: 'declined',
    fields: ['aiOpenAiBaseUrl'],
    message: 'The new address for AI requests was not confirmed.',
    ...patch,
  }
}

afterEach(cleanup)

describe('§2.119 AiDestinationRejectionNotice — nothing to say', () => {
  it('renders nothing when there is no rejection', () => {
    render(<AiDestinationRejectionNotice rejection={null} onRetry={vi.fn()} />)
    expect(screen.queryByTestId('settings-ai-destination-notice')).toBeNull()
  })
})

describe('§2.119 AiDestinationRejectionNotice — what every reason must state', () => {
  const reasons = ['declined', 'invalid', 'busy'] as const

  // REGRESSION GUARD — the message is main's, rendered as given. If this ever
  // starts coming from a renderer-side lookup, the notice and the native dialog
  // will describe the same event in two different wordings.
  it.each(reasons)('%s shows the message main localized, verbatim', reason => {
    render(
      <AiDestinationRejectionNotice
        rejection={rejection({ reason, message: `sentence for ${reason}` })}
        onRetry={vi.fn()}
      />,
    )
    const line = screen.getByTestId('settings-ai-destination-message')
    expect(line).toHaveTextContent(`sentence for ${reason}`)
    expect(line).toBeVisible()
  })

  it.each(reasons)('%s names the field that did not change', reason => {
    render(
      <AiDestinationRejectionNotice rejection={rejection({ reason })} onRetry={vi.fn()} />,
    )
    const line = screen.getByTestId('settings-ai-destination-fields')
    expect(line).toHaveTextContent('Still using the previous value for: AI endpoint address.')
    expect(line).toBeVisible()
  })

  it.each(reasons)('%s says the rest of the save landed', reason => {
    render(
      <AiDestinationRejectionNotice rejection={rejection({ reason })} onRetry={vi.fn()} />,
    )
    const line = screen.getByTestId('settings-ai-destination-other-saved')
    expect(line).toHaveTextContent('Other accepted changes on this screen were saved.')
    // Visible, not merely present: the person changed several things and only
    // one was held back, so hiding this line is the same failure as omitting it.
    expect(line).toBeVisible()
  })

  it('names the proxy field when that is the one held back', () => {
    render(
      <AiDestinationRejectionNotice
        rejection={rejection({ fields: ['aiProxyUrl'] })}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId('settings-ai-destination-fields'))
      .toHaveTextContent('Proxy for AI requests')
  })

  it('names both fields when both were held back', () => {
    render(
      <AiDestinationRejectionNotice
        rejection={rejection({ fields: ['aiOpenAiBaseUrl', 'aiProxyUrl'] })}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId('settings-ai-destination-fields'))
      .toHaveTextContent('AI endpoint address, Proxy for AI requests')
  })

  it('omits the field line rather than printing an empty list', () => {
    render(
      <AiDestinationRejectionNotice rejection={rejection({ fields: [] })} onRetry={vi.fn()} />,
    )
    expect(screen.queryByTestId('settings-ai-destination-fields')).toBeNull()
    // The notice itself is still there — the window stayed open for a reason.
    expect(screen.getByTestId('settings-ai-destination-notice')).toBeInTheDocument()
  })
})

describe('§2.119 AiDestinationRejectionNotice — the three reasons are treated differently', () => {
  it('presents a decline calmly: no alert role, no error styling, no retry', () => {
    render(<AiDestinationRejectionNotice rejection={rejection()} onRetry={vi.fn()} />)
    const notice = screen.getByTestId('settings-ai-destination-notice')
    expect(notice).toHaveAttribute('role', 'status')
    expect(notice).not.toHaveClass('error-banner')
    expect(screen.getByTestId('settings-ai-destination-title'))
      .toHaveTextContent('Address left unchanged')
    expect(screen.queryByTestId('settings-ai-destination-retry')).toBeNull()
  })

  it('presents an unusable address as an alert the person must correct', () => {
    render(
      <AiDestinationRejectionNotice rejection={rejection({ reason: 'invalid' })} onRetry={vi.fn()} />,
    )
    const notice = screen.getByTestId('settings-ai-destination-notice')
    expect(notice).toHaveAttribute('role', 'alert')
    expect(notice).toHaveClass('error-banner')
    expect(screen.getByTestId('settings-ai-destination-title'))
      .toHaveTextContent('Address not accepted')
    expect(screen.queryByTestId('settings-ai-destination-retry')).toBeNull()
  })

  it('offers a retry for the transient case, without alarming', () => {
    const onRetry = vi.fn()
    render(
      <AiDestinationRejectionNotice rejection={rejection({ reason: 'busy' })} onRetry={onRetry} />,
    )
    const notice = screen.getByTestId('settings-ai-destination-notice')
    expect(notice).toHaveAttribute('role', 'status')
    expect(notice).not.toHaveClass('error-banner')
    expect(screen.getByTestId('settings-ai-destination-title'))
      .toHaveTextContent('Address change not applied')
    fireEvent.click(screen.getByTestId('settings-ai-destination-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('exposes the reason so it can be told apart in the DOM', () => {
    render(
      <AiDestinationRejectionNotice rejection={rejection({ reason: 'busy' })} onRetry={vi.fn()} />,
    )
    expect(screen.getByTestId('settings-ai-destination-notice'))
      .toHaveAttribute('data-reason', 'busy')
  })
})
