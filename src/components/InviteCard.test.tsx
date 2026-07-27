// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import type { CalendarInvitePublic } from '../../packages/types'

// ---- stable i18n stub -------------------------------------------------------
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

// ---- window.api mock --------------------------------------------------------
const mockInvoke = vi.fn()

Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
  writable: true,
})

// ---- import component after mocks -------------------------------------------
import InviteCard, { type InviteCardProps } from './InviteCard'

// ---- helpers ----------------------------------------------------------------
function makeInvite(overrides: Partial<CalendarInvitePublic> = {}): CalendarInvitePublic {
  return {
    uid: 'event-uid-abc123',
    summary: 'Team Sync',
    dtstart: '2026-05-15T14:00:00+02:00',
    dtend: '2026-05-15T15:30:00+02:00',
    allDay: false,
    organizerEmail: 'boss@example.com',
    organizerName: 'Alice Boss',
    location: 'Conference Room A',
    method: 'REQUEST',
    ...overrides,
  }
}

function makeProps(overrides: Partial<InviteCardProps> = {}): InviteCardProps {
  return {
    invite: makeInvite(),
    messageUid: 42,
    accountId: 1,
    folder: 'INBOX',
    identities: ['user@example.com'],
    ...overrides,
  }
}

// ---- tests ------------------------------------------------------------------
describe('InviteCard', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders summary, date, organizer and location for a full invite', () => {
    render(<InviteCard {...makeProps()} />)

    expect(screen.getByTestId('invite-card')).toBeInTheDocument()
    expect(screen.getByText('Team Sync')).toBeInTheDocument()
    // date is formatted via Intl — just assert the container renders something
    expect(screen.getByText('When')).toBeInTheDocument()
    expect(screen.getByText('Organizer')).toBeInTheDocument()
    // organizer name + email combined
    expect(screen.getByText(/Alice Boss/)).toBeInTheDocument()
    expect(screen.getByText('Location')).toBeInTheDocument()
    expect(screen.getByText('Conference Room A')).toBeInTheDocument()
  })

  it('hides location row when location is not present', () => {
    const props = makeProps({ invite: makeInvite({ location: undefined }) })
    render(<InviteCard {...props} />)

    expect(screen.queryByText('Location')).not.toBeInTheDocument()
    expect(screen.queryByText('Conference Room A')).not.toBeInTheDocument()
  })

  it('shows cancelled badge and hides RSVP buttons when method === CANCEL', () => {
    const props = makeProps({ invite: makeInvite({ method: 'CANCEL' }) })
    render(<InviteCard {...props} />)

    expect(screen.getByTestId('invite-cancelled-badge')).toBeInTheDocument()
    expect(screen.getByText('This event has been cancelled')).toBeInTheDocument()
    expect(screen.queryByTestId('invite-actions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('invite-btn-accept')).not.toBeInTheDocument()
  })

  it('calls window.api.invoke with mail:rsvpInvite and ACCEPTED on Accept click', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, messageId: '<reply-001@example.com>' })

    render(<InviteCard {...makeProps()} />)

    const acceptBtn = screen.getByTestId('invite-btn-accept')
    await act(async () => {
      fireEvent.click(acceptBtn)
    })

    expect(mockInvoke).toHaveBeenCalledWith('mail:rsvpInvite', {
      accountId: 1,
      uid: 42,
      folder: 'INBOX',
      response: 'ACCEPTED',
    })
  })

  it('shows success label and hides buttons after successful RSVP', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, messageId: '<reply-002@example.com>' })

    render(<InviteCard {...makeProps()} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('invite-btn-accept'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('invite-response-status')).toBeInTheDocument()
      expect(screen.getByText('You accepted this invitation')).toBeInTheDocument()
    })

    // RSVP buttons should be gone
    expect(screen.queryByTestId('invite-actions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('invite-btn-accept')).not.toBeInTheDocument()
  })

  it('shows error banner and re-enables buttons after failed RSVP', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, error: 'SMTP connection refused' })

    render(<InviteCard {...makeProps()} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('invite-btn-decline'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('invite-error')).toBeInTheDocument()
      expect(screen.getByText(/SMTP connection refused/)).toBeInTheDocument()
    })

    // Buttons should be visible again for retry
    expect(screen.getByTestId('invite-actions')).toBeInTheDocument()
    expect(screen.getByTestId('invite-btn-accept')).toBeInTheDocument()
  })

  it('handles Cyrillic and emoji in summary and location', () => {
    const props = makeProps({
      invite: makeInvite({
        summary: 'Встреча команды 📅',
        location: 'Переговорка «Синяя»',
      }),
    })
    render(<InviteCard {...props} />)

    expect(screen.getByText('Встреча команды 📅')).toBeInTheDocument()
    expect(screen.getByText('Переговорка «Синяя»')).toBeInTheDocument()
  })

  it('hides RSVP buttons when identities list contains organizer email', () => {
    const props = makeProps({
      invite: makeInvite({ organizerEmail: 'user@example.com' }),
      identities: ['user@example.com'],
    })
    render(<InviteCard {...props} />)

    expect(screen.queryByTestId('invite-actions')).not.toBeInTheDocument()
  })

  it('hides RSVP buttons when method === REPLY', () => {
    const props = makeProps({ invite: makeInvite({ method: 'REPLY' }) })
    render(<InviteCard {...props} />)

    expect(screen.queryByTestId('invite-actions')).not.toBeInTheDocument()
  })

  it('calls invoke with TENTATIVE on Tentative click', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, messageId: '<reply-003@example.com>' })

    render(<InviteCard {...makeProps()} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('invite-btn-tentative'))
    })

    expect(mockInvoke).toHaveBeenCalledWith('mail:rsvpInvite', expect.objectContaining({
      response: 'TENTATIVE',
    }))
  })

  it('displays tentative success label after TENTATIVE response', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, messageId: '<reply-004@example.com>' })

    render(<InviteCard {...makeProps()} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('invite-btn-tentative'))
    })

    await waitFor(() => {
      expect(screen.getByText('You marked this as tentative')).toBeInTheDocument()
    })
  })

  it('shows fallback organizer email when organizerName is absent', () => {
    const props = makeProps({
      invite: makeInvite({ organizerName: undefined, organizerEmail: 'noreply@corp.example' }),
    })
    render(<InviteCard {...props} />)

    expect(screen.getByText('noreply@corp.example')).toBeInTheDocument()
  })

  it('handles very long summary without crashing', () => {
    const longSummary = 'A'.repeat(200)
    render(<InviteCard {...makeProps({ invite: makeInvite({ summary: longSummary }) })} />)
    expect(screen.getByText(longSummary)).toBeInTheDocument()
  })

  // ---------------------------------------------------------------------------
  // §2.22 fix iter2B — new tests
  // ---------------------------------------------------------------------------

  it('renders all-day event date without time component', () => {
    // allDay=true, dtstart='YYYY-MM-DD' — must not produce '00:00' or '03:00'
    const props = makeProps({
      invite: makeInvite({
        allDay: true,
        dtstart: '2026-05-15',
        dtend: undefined,
        method: 'REQUEST',
      }),
    })
    render(<InviteCard {...props} />)

    const whenRow = screen.getByText('When').closest('.invite-meta-row')
    const valueSpan = whenRow?.querySelector('.invite-meta-value')
    const text = valueSpan?.textContent ?? ''

    // Must contain date part ("May" in English locale)
    expect(text).toMatch(/may/i)
    // Must NOT contain a time-like pattern (digits:digits)
    expect(text).not.toMatch(/\d{1,2}:\d{2}/)
  })

  it('renders multi-day all-day event as date range without time', () => {
    const props = makeProps({
      invite: makeInvite({
        allDay: true,
        dtstart: '2026-05-15',
        dtend: '2026-05-17',
        method: 'REQUEST',
      }),
    })
    render(<InviteCard {...props} />)

    const whenRow = screen.getByText('When').closest('.invite-meta-row')
    const valueSpan = whenRow?.querySelector('.invite-meta-value')
    const text = valueSpan?.textContent ?? ''

    // Range separator should be present
    expect(text).toContain('–')
    // No time digits
    expect(text).not.toMatch(/\d{1,2}:\d{2}/)
  })

  it('hides RSVP buttons for PUBLISH method and shows not-actionable notice', () => {
    const props = makeProps({ invite: makeInvite({ method: 'PUBLISH' }) })
    render(<InviteCard {...props} />)

    expect(screen.queryByTestId('invite-actions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('invite-btn-accept')).not.toBeInTheDocument()
    expect(screen.queryByTestId('invite-btn-tentative')).not.toBeInTheDocument()
    expect(screen.queryByTestId('invite-btn-decline')).not.toBeInTheDocument()
    expect(screen.getByTestId('invite-not-actionable')).toBeInTheDocument()
    expect(screen.getByText('This is not an actionable invitation')).toBeInTheDocument()
  })

  it('hides RSVP buttons for OTHER method and shows not-actionable notice', () => {
    const props = makeProps({ invite: makeInvite({ method: 'OTHER' }) })
    render(<InviteCard {...props} />)

    expect(screen.queryByTestId('invite-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('invite-not-actionable')).toBeInTheDocument()
  })

  it('hides RSVP buttons when organizer email matches identity with case difference and trailing space', () => {
    // §2.22 fix iter2B: trim+lowercase normalization
    const props = makeProps({
      invite: makeInvite({ organizerEmail: 'Alias@Example.com ' }),
      identities: ['user@example.com', 'alias@example.com'],
    })
    render(<InviteCard {...props} />)

    expect(screen.queryByTestId('invite-actions')).not.toBeInTheDocument()
  })

  it('shows RSVP buttons when organizer is different from all identities', () => {
    const props = makeProps({
      invite: makeInvite({ organizerEmail: 'boss@other.com' }),
      identities: ['user@example.com', 'alias@example.com'],
    })
    render(<InviteCard {...props} />)

    expect(screen.getByTestId('invite-actions')).toBeInTheDocument()
    expect(screen.getByTestId('invite-btn-accept')).toBeInTheDocument()
  })

  it('shows RSVP buttons when identities is empty (organizer cannot be determined)', () => {
    const props = makeProps({
      invite: makeInvite({ organizerEmail: 'user@example.com' }),
      identities: [],
    })
    render(<InviteCard {...props} />)

    // No identities means we cannot confirm organizer==self, so show buttons
    expect(screen.getByTestId('invite-actions')).toBeInTheDocument()
  })

  // ---------------------------------------------------------------------------
  // §2.22 fix iter3B — TZ rendering + RFC DTEND exclusive tests
  // ---------------------------------------------------------------------------

  describe('TZID rendering — deterministic TZ mock', () => {
    let resolvedOptionsSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      // Mock viewer's TZ to Europe/Berlin for all tests in this suite
      resolvedOptionsSpy = vi.spyOn(
        Intl.DateTimeFormat.prototype,
        'resolvedOptions',
      ).mockImplementation(function () {
        return {
          locale: 'en-US',
          calendar: 'gregory',
          numberingSystem: 'latn',
          timeZone: 'Europe/Berlin',
          hour12: false,
          hourCycle: 'h23',
        } as Intl.ResolvedDateTimeFormatOptions
      })
    })

    afterEach(() => {
      resolvedOptionsSpy.mockRestore()
    })

    it('wall-clock dtstart (no Z) renders time in tzid, not viewer TZ, and shows annotation', () => {
      // '2026-05-15T14:00:00' = wall-clock 14:00 in America/New_York
      // Viewer is Europe/Berlin. We expect the card to show 14:00 (NY wall-clock),
      // NOT 20:00 (which would be the Berlin equivalent of 14:00 NY in May, UTC+2 vs UTC-4).
      // Also, annotation should be present since NY ≠ Berlin.
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-05-15T14:00:00',
          dtend: '2026-05-15T15:30:00',
          tzid: 'America/New_York',
        }),
      })
      render(<InviteCard {...props} />)

      const whenRow = screen.getByText('When').closest('.invite-meta-row')
      const valueSpan = whenRow?.querySelector('.invite-meta-value')
      const text = valueSpan?.textContent ?? ''

      // Wall-clock time 14:00 (NY) must appear — either as 14:00 (24h) or 02:00 PM (12h)
      // JSDOM uses viewer's locale which may produce either format
      expect(text).toMatch(/14[:.]00|02[:.]00\s*pm/i)

      // Annotation element must be present (America/New_York ≠ Europe/Berlin)
      const annotation = screen.getByTestId('invite-tzid-annotation')
      expect(annotation).toBeInTheDocument()
      expect(annotation.textContent).toMatch(/America\/New_York/i)
    })

    it('UTC ISO dtstart with tzid renders in tzid and shows annotation vs viewer Berlin', () => {
      // '2026-05-15T18:00:00.000Z' UTC = 14:00 America/New_York (UTC-4 in May)
      // Viewer is Europe/Berlin (UTC+2 in May = 20:00). The card should display
      // in America/New_York (14:00) since tzid is set.
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-05-15T18:00:00.000Z',
          dtend: '2026-05-15T19:30:00.000Z',
          tzid: 'America/New_York',
        }),
      })
      render(<InviteCard {...props} />)

      const whenRow = screen.getByText('When').closest('.invite-meta-row')
      const valueSpan = whenRow?.querySelector('.invite-meta-value')
      const text = valueSpan?.textContent ?? ''

      // 18:00Z = 14:00 NY — display should show 14:00 (24h) or 02:00 PM (12h)
      expect(text).toMatch(/14[:.]00|02[:.]00\s*pm/i)

      // Annotation must be present (America/New_York ≠ Europe/Berlin)
      const annotation = screen.getByTestId('invite-tzid-annotation')
      expect(annotation).toBeInTheDocument()
      expect(annotation.textContent).toMatch(/America\/New_York/i)
    })

    // §2.22 fix iter5 — Outlook/Exchange RFC 5545 invites carry Windows-style
    // TZIDs (`Russian Standard Time`, `Pacific Standard Time`, …). These are
    // NOT valid IANA zones and `Intl.DateTimeFormat({ timeZone })` throws
    // RangeError. Before the fix this escaped to the Sentry error boundary
    // ("Something went wrong") on every Outlook invite — see incident
    // 2026-05-08. The renderer must (1) NOT crash, (2) still surface the
    // original tzid string via `getTzidAnnotation` so the user sees what zone
    // the event was scheduled in.
    it('UTC ISO dtstart with Windows-style tzid (Outlook) renders without crashing and keeps annotation', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-05-12T06:00:00.000Z',
          dtend: '2026-05-12T06:30:00.000Z',
          tzid: 'Russian Standard Time',
        }),
      })
      // The render call itself is the key assertion — pre-fix this threw
      // RangeError out of formatInviteDateRange.
      render(<InviteCard {...props} />)
      expect(screen.getByTestId('invite-card')).toBeInTheDocument()
      const annotation = screen.getByTestId('invite-tzid-annotation')
      expect(annotation.textContent).toMatch(/Russian Standard Time/i)
    })

    it('UTC ISO dtstart without tzid renders without annotation (viewer TZ used)', () => {
      // No tzid → renderer falls back to viewer's local TZ → no annotation
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-05-15T18:00:00.000Z',
          dtend: '2026-05-15T19:30:00.000Z',
          tzid: undefined,
        }),
      })
      render(<InviteCard {...props} />)

      // No annotation when tzid is absent
      expect(screen.queryByTestId('invite-tzid-annotation')).not.toBeInTheDocument()
      // Card renders fine
      expect(screen.getByTestId('invite-card')).toBeInTheDocument()
    })
  })

  describe('RFC 5545 all-day DTEND exclusive', () => {
    it('treats all-day DTEND as exclusive — May 15→17 displays as May 15–May 16', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: true,
          dtstart: '2026-05-15',
          dtend: '2026-05-17',
          method: 'REQUEST',
        }),
      })
      render(<InviteCard {...props} />)

      const whenRow = screen.getByText('When').closest('.invite-meta-row')
      const valueSpan = whenRow?.querySelector('.invite-meta-value')
      const text = valueSpan?.textContent ?? ''

      // Must show May 15
      expect(text).toMatch(/15/i)
      // Must show May 16 (inclusive last day)
      expect(text).toMatch(/16/i)
      // Must NOT show May 17 (exclusive DTEND)
      expect(text).not.toMatch(/17/i)
    })

    it('treats single-day all-day event (DTEND = DTSTART + 1) as just DTSTART', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: true,
          dtstart: '2026-05-15',
          dtend: '2026-05-16',
          method: 'REQUEST',
        }),
      })
      render(<InviteCard {...props} />)

      const whenRow = screen.getByText('When').closest('.invite-meta-row')
      const valueSpan = whenRow?.querySelector('.invite-meta-value')
      const text = valueSpan?.textContent ?? ''

      // Must show May 15
      expect(text).toMatch(/15/i)
      // Must NOT show "–" range separator (single day)
      expect(text).not.toContain('–')
      // Must NOT show 16 as a second date (no range)
      // The date "May 15" may include "15" but "16" should not appear as a range endpoint
      // We check there's no "16" in the output (DTEND=16 exclusive = same day as DTSTART=15)
      expect(text).not.toMatch(/\b16\b/)
    })

    it('shows only dtstart when DTEND is absent (all-day)', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: true,
          dtstart: '2026-05-20',
          dtend: undefined,
          method: 'REQUEST',
        }),
      })
      render(<InviteCard {...props} />)

      const whenRow = screen.getByText('When').closest('.invite-meta-row')
      const valueSpan = whenRow?.querySelector('.invite-meta-value')
      const text = valueSpan?.textContent ?? ''

      expect(text).toMatch(/20/i)
      expect(text).not.toContain('–')
    })

    it('shows only dtstart when DTEND <= DTSTART (malformed all-day invite)', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: true,
          dtstart: '2026-05-15',
          dtend: '2026-05-14',  // before start — malformed
          method: 'REQUEST',
        }),
      })
      render(<InviteCard {...props} />)

      // Must not crash; shows only start date
      expect(screen.getByTestId('invite-card')).toBeInTheDocument()
      const whenRow = screen.getByText('When').closest('.invite-meta-row')
      const valueSpan = whenRow?.querySelector('.invite-meta-value')
      const text = valueSpan?.textContent ?? ''
      expect(text).not.toContain('–')
    })
  })
})
