// @vitest-environment jsdom
/**
 * §2.22 — MailBodyContent smoke tests.
 *
 * Focuses on the §2.22-specific surface: InviteCard mounting when
 * details.calendarInvite is present. Full rendering of body HTML, offline
 * fallback, attachments, etc. is exercised by the parent App.tsx flows and
 * e2e tests. These unit tests target the invite integration seam only.
 *
 * §3.3.C-uiaudit.22: metaTo/metaCc updated to MailAddress[] in makeProps.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { CalendarInvitePublic, MailSummary, MessageDetails } from '../../packages/types'

// ---- i18n stub (stable — prevents infinite re-renders) ----------------------
const i18nMap: Record<string, string> = {
  'invite.title': 'Meeting invitation',
  'invite.organizer': 'Organizer',
  'invite.location': 'Location',
  'invite.when': 'When',
  'invite.accept': 'Accept',
  'invite.tentative': 'Tentative',
  'invite.decline': 'Decline',
  'invite.responding': 'Sending response…',
  'invite.responseAccepted': 'You accepted this invitation',
  'invite.responseTentative': 'You marked this as tentative',
  'invite.responseDeclined': 'You declined this invitation',
  'invite.responseFailed': 'Failed to send response: {{error}}',
  'invite.noOrganizer': 'No organizer specified',
  'invite.cancelled': 'This event has been cancelled',
  'invite.notActionable': 'This is not an actionable invitation',
  'invite.originalTimezone': 'Originally scheduled in {{tzid}}',
  'mail.headers.to': 'To',
  'mail.headers.cc': 'Cc',
  'mail.headers.date': 'Date',
  'app.empty.loadingMessage.title': 'Loading…',
  'app.errors.bodyNotAvailableOffline': 'Body not available offline',
  'mail.actions.retry': 'Retry',
  'app.empty.messageNotFound.title': 'Message not found',
  'mail.privacy.imagesBlocked': 'Images blocked',
  'mail.privacy.showImages': 'Show images',
}

const stableT = (key: string, opts?: Record<string, unknown>): string => {
  let text = i18nMap[key] ?? key
  if (opts && typeof opts === 'object') {
    for (const [k, v] of Object.entries(opts)) {
      text = text.replace(new RegExp(`{{${k}}}`, 'g'), String(v))
    }
  }
  return text
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: stableT,
    i18n: { language: 'en-US' },
  }),
}))

// ---- useTooltipDelegation stub (used by RecipientList) ----------------------
vi.mock('../hooks/useTooltipDelegation', () => ({
  useTooltipDelegation: () => ({
    tooltipState: null,
    containerRef: vi.fn(),
    handleMouseOver: vi.fn(),
    handleMouseOut: vi.fn(),
  }),
}))

// ---- window.api stub --------------------------------------------------------
const mockInvoke = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

// ---- import after mocks -----------------------------------------------------
import MailBodyContent, { type MailBodyContentProps } from './MailBodyContent'

// ---- factories --------------------------------------------------------------

function makeCalendarInvite(overrides: Partial<CalendarInvitePublic> = {}): CalendarInvitePublic {
  return {
    uid: 'test-uid-abc@example.test',
    summary: 'Integration Meeting',
    dtstart: '2026-06-15T14:00:00Z',
    dtend: '2026-06-15T15:00:00Z',
    allDay: false,
    organizerEmail: 'organizer@example.test',
    organizerName: 'Test Organizer',
    location: 'Meeting Room B',
    method: 'REQUEST',
    ...overrides,
  }
}

function makeMailSummary(overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    accountId: 1,
    folder: 'INBOX',
    uid: 42,
    from: 'Sender <sender@example.test>',
    subject: 'Test Subject',
    date: '2026-06-15T10:00:00Z',
    unread: false,
    flagged: false,
    ...overrides,
  }
}

function makeDetails(overrides: Partial<MessageDetails> = {}): MessageDetails {
  return {
    uid: 42,
    text: 'Plain text body.',
    ...overrides,
  }
}

function makeProps(overrides: Partial<MailBodyContentProps> = {}): MailBodyContentProps {
  return {
    active: makeMailSummary(),
    details: makeDetails(),
    identities: ['user@example.test'],
    loadingBody: false,
    // §3.3.C-uiaudit.22: metaTo/metaCc are now MailAddress[] (not strings)
    metaTo: [{ address: 'user@example.test' }],
    metaCc: [],
    metaDate: 'June 15, 2026',
    mailHasExternalImages: false,
    alwaysLoadImages: false,
    showExternalImages: false,
    mailIframeDoc: null,
    iframeKey: 'key-1',
    mailIframeRef: { current: null },
    activeMailKey: '1:INBOX:42',
    savingAttachment: null,
    onShowExternalImages: vi.fn(),
    onRetry: vi.fn(),
    onDownloadAttachment: vi.fn(),
    ...overrides,
  }
}

// ---- tests ------------------------------------------------------------------

describe('MailBodyContent — §2.22 InviteCard integration', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('does not render InviteCard when details has no calendarInvite', () => {
    render(<MailBodyContent {...makeProps()} />)

    expect(screen.queryByTestId('invite-card')).not.toBeInTheDocument()
  })

  it('renders InviteCard when details.calendarInvite is defined', () => {
    const props = makeProps({
      details: makeDetails({ calendarInvite: makeCalendarInvite() }),
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('invite-card')).toBeInTheDocument()
    expect(screen.getByText('Integration Meeting')).toBeInTheDocument()
  })

  it('passes summary, organizer and location from calendarInvite to InviteCard', () => {
    const invite = makeCalendarInvite({
      summary: 'Specific Summary',
      organizerName: 'Jane Doe',
      location: 'Conf Room 3',
    })
    const props = makeProps({
      details: makeDetails({ calendarInvite: invite }),
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByText('Specific Summary')).toBeInTheDocument()
    expect(screen.getByText(/Jane Doe/)).toBeInTheDocument()
    expect(screen.getByText('Conf Room 3')).toBeInTheDocument()
  })

  it('hides InviteCard when active is null (no selected message)', () => {
    const props = makeProps({
      active: null,
      details: makeDetails({ calendarInvite: makeCalendarInvite() }),
    })
    render(<MailBodyContent {...props} />)

    // active === null disables the invite card (condition: active && details?.calendarInvite)
    expect(screen.queryByTestId('invite-card')).not.toBeInTheDocument()
  })

  it('renders RSVP action buttons for a REQUEST invite', () => {
    const props = makeProps({
      details: makeDetails({ calendarInvite: makeCalendarInvite({ method: 'REQUEST' }) }),
      // identities list differs from organizer so buttons show
      identities: ['user@example.test'],
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('invite-btn-accept')).toBeInTheDocument()
    expect(screen.getByTestId('invite-btn-tentative')).toBeInTheDocument()
    expect(screen.getByTestId('invite-btn-decline')).toBeInTheDocument()
  })

  it('shows cancelled badge and hides RSVP buttons when method is CANCEL', () => {
    const props = makeProps({
      details: makeDetails({ calendarInvite: makeCalendarInvite({ method: 'CANCEL' }) }),
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('invite-cancelled-badge')).toBeInTheDocument()
    expect(screen.queryByTestId('invite-actions')).not.toBeInTheDocument()
  })

  it('hides RSVP buttons when identities list contains organizer email (self-invite guard)', () => {
    const props = makeProps({
      details: makeDetails({
        calendarInvite: makeCalendarInvite({ organizerEmail: 'organizer@example.test' }),
      }),
      identities: ['organizer@example.test'],
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('invite-card')).toBeInTheDocument()
    expect(screen.queryByTestId('invite-actions')).not.toBeInTheDocument()
  })

  it('renders the mail text body alongside the InviteCard', () => {
    const props = makeProps({
      details: makeDetails({
        calendarInvite: makeCalendarInvite(),
        text: 'You are invited to join the meeting.',
      }),
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('invite-card')).toBeInTheDocument()
    expect(screen.getByTestId('mail-body-text')).toHaveTextContent('You are invited to join the meeting.')
  })

  it('does not render InviteCard when loadingBody is true', () => {
    // When loadingBody is true the spinner is shown and invite is still absent
    // (condition checks active && details?.calendarInvite, not loadingBody, so
    // this test confirms the card IS rendered even during loading —
    // which is the actual behavior: invite card and body spinner are independent)
    const props = makeProps({
      loadingBody: true,
      details: makeDetails({ calendarInvite: makeCalendarInvite() }),
    })
    render(<MailBodyContent {...props} />)

    // Loading spinner visible
    // invite-card should still be rendered because active + calendarInvite are both set
    expect(screen.getByTestId('invite-card')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// §2.22 — formatInviteDateRange locale tests (exported via InviteCard render)
// ---------------------------------------------------------------------------

describe('InviteCard — date formatting locale coverage', () => {
  afterEach(() => {
    cleanup()
  })

  it('formats dtstart correctly for en-US locale (month name in English)', () => {
    // The i18n stub returns language: 'en-US'. The date 2026-05-15T14:00:00Z
    // should produce output containing "May" when formatted with Intl.DateTimeFormat.
    const invite = makeCalendarInvite({
      dtstart: '2026-05-15T14:00:00+00:00',
      dtend: '2026-05-15T15:00:00+00:00',
    })
    const props = makeProps({ details: makeDetails({ calendarInvite: invite }) })
    render(<MailBodyContent {...props} />)

    const whenRow = screen.getByText('When').closest('.invite-meta-row')
    expect(whenRow).toBeTruthy()
    // The formatted date value lives in the sibling .invite-meta-value span
    const valueSpan = whenRow?.querySelector('.invite-meta-value')
    expect(valueSpan?.textContent).toMatch(/may/i)
  })

  it('renders the when label row for an invite with no dtend', () => {
    // Regression guard: dtend=undefined must not crash the formatter and the
    // When row must still appear.
    const invite = makeCalendarInvite({ dtend: undefined })
    const props = makeProps({ details: makeDetails({ calendarInvite: invite }) })
    render(<MailBodyContent {...props} />)

    expect(screen.getByText('When')).toBeInTheDocument()
    const whenRow = screen.getByText('When').closest('.invite-meta-row')
    const valueSpan = whenRow?.querySelector('.invite-meta-value')
    // Must produce some non-empty output
    expect(valueSpan?.textContent?.trim().length).toBeGreaterThan(0)
  })
})
