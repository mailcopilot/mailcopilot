// @vitest-environment jsdom
/**
 * §2.17 Phase 1 fix wave — the shared headers-only placeholder.
 *
 * Two properties are pinned here rather than in the two window suites, because
 * they are properties of the MAPPING and not of either window:
 *
 *  1. Each reason gets its own words, icon and test id, and none of them falls
 *     through to the offline wording. Fall-through is how the defect survived:
 *     the branch was `reason === 'timeout' ? … : offline`, so every value that
 *     was not 'timeout' — including one that did not exist yet — silently
 *     claimed the user was offline.
 *  2. Retry renders when, and only when, a handler was supplied. The
 *     standalone message window rendered this block WITHOUT a button, which
 *     made a failed load a dead end there; the button must not be optional by
 *     accident again.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import React from 'react'
import MailBodyFallbackNotice from './MailBodyFallbackNotice'
import {
  MAIL_BODY_FALLBACK_PRESENTATION,
  presentationForReason,
} from '../utils/mailBodyFallback'

const T_MAP: Record<string, string> = {
  'app.errors.bodyNotAvailableOffline': 'Body not available offline',
  'app.errors.bodyLoadTimedOut': 'Loading timed out — you can try again',
  'app.errors.bodyLoadFailed': 'Could not load the body of this message',
  'mail.actions.retry': 'Retry',
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => T_MAP[key] ?? key }),
}))

vi.mock('lucide-react', () => ({
  WifiOff: () => React.createElement('span', { 'data-testid': 'icon-wifioff' }),
  Timer: () => React.createElement('span', { 'data-testid': 'icon-timer' }),
  CloudOff: () => React.createElement('span', { 'data-testid': 'icon-cloudoff' }),
}))

afterEach(cleanup)

describe('MailBodyFallbackNotice — reason to presentation', () => {
  it('work-offline mode keeps the offline wording and the crossed-out Wi-Fi symbol', () => {
    render(<MailBodyFallbackNotice reason="offline" />)
    expect(screen.getByTestId('mail-body-offline')).toBeInTheDocument()
    expect(screen.getByText('Body not available offline')).toBeInTheDocument()
    expect(screen.getByTestId('icon-wifioff')).toBeInTheDocument()
  })

  it('an expired budget says so, and does NOT draw a crossed-out Wi-Fi symbol', () => {
    render(<MailBodyFallbackNotice reason="timeout" />)
    expect(screen.getByTestId('mail-body-timeout')).toBeInTheDocument()
    expect(screen.getByText('Loading timed out — you can try again')).toBeInTheDocument()
    expect(screen.getByTestId('icon-timer')).toBeInTheDocument()
    // The icon has to agree with the sentence — a crossed-out Wi-Fi symbol on
    // a working connection is the same lie in picture form.
    expect(screen.queryByTestId('icon-wifioff')).not.toBeInTheDocument()
  })

  it('a failed fetch says the fetch failed, and claims nothing about the network', () => {
    render(<MailBodyFallbackNotice reason="unavailable" />)
    expect(screen.getByTestId('mail-body-unavailable')).toBeInTheDocument()
    expect(screen.getByText('Could not load the body of this message')).toBeInTheDocument()
    expect(screen.getByTestId('icon-cloudoff')).toBeInTheDocument()
    expect(screen.queryByTestId('icon-wifioff')).not.toBeInTheDocument()
    expect(screen.queryByText('Body not available offline')).not.toBeInTheDocument()
  })

  it('an absent reason reads as offline — envelopes cached before the field existed', () => {
    render(<MailBodyFallbackNotice reason={undefined} />)
    expect(screen.getByTestId('mail-body-offline')).toBeInTheDocument()
    expect(screen.getByText('Body not available offline')).toBeInTheDocument()
  })

  it('every reason has its own entry — no two share a message key or a test id', () => {
    // The table, not the renders, is what stops a future reason from being
    // added and quietly inheriting the offline sentence.
    const entries = Object.values(MAIL_BODY_FALLBACK_PRESENTATION)
    expect(new Set(entries.map(e => e.messageKey)).size).toBe(entries.length)
    expect(new Set(entries.map(e => e.testId)).size).toBe(entries.length)
    // Only work-offline mode — the one case we know for certain — is allowed
    // to use the offline sentence.
    const offlineSentence = entries.filter(
      e => e.messageKey === 'app.errors.bodyNotAvailableOffline',
    )
    expect(offlineSentence).toHaveLength(1)
    expect(presentationForReason('offline')).toBe(offlineSentence[0])
    expect(presentationForReason(undefined)).toBe(offlineSentence[0])
  })
})

describe('MailBodyFallbackNotice — retry', () => {
  it.each(['offline', 'timeout', 'unavailable'] as const)(
    'renders Retry for reason %s when a handler is supplied, and calls it once',
    reason => {
      const onRetry = vi.fn()
      render(<MailBodyFallbackNotice reason={reason} onRetry={onRetry} />)
      const button = screen.getByTestId('mail-offline-retry')
      expect(button).toHaveTextContent('Retry')
      fireEvent.click(button)
      expect(onRetry).toHaveBeenCalledTimes(1)
    },
  )

  it('renders no button at all when no handler was supplied', () => {
    // A button that does nothing is worse than no button: it says the state is
    // recoverable and then is not.
    render(<MailBodyFallbackNotice reason="timeout" />)
    expect(screen.queryByTestId('mail-offline-retry')).not.toBeInTheDocument()
  })
})
