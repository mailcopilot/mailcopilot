// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import fs from 'node:fs'
import path from 'node:path'

import type { CalendarInvitePublic } from '../../packages/types'

/**
 * Pin the viewer's timezone for a whole describe block.
 *
 * The invite card renders times in the *viewer's* zone, so a test that does not
 * pin `process.env.TZ` asserts nothing: CI runs under UTC while the developer
 * machine runs under Europe/Moscow, and the same expectation would be either
 * trivially true or trivially false depending on the host. Node re-reads
 * `process.env.TZ` on assignment (v16.2+) and resets the ICU default zone, so
 * both `Date` and `Intl` follow.
 */
function useViewerTimezone(tz: string): void {
  let previous: string | undefined
  beforeAll(() => {
    previous = process.env.TZ
    process.env.TZ = tz
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  })
}

/**
 * Absolute path to the renderer stylesheet. jsdom never loads it, so the only
 * way to guard a purely visual rule is to assert on the file itself; vitest runs
 * with the repository root as cwd.
 */
function appCssPath(): string {
  return path.resolve(process.cwd(), 'src/App.css')
}

/** Text content of the "When" row, including the original-zone caption. */
function whenRowText(): string {
  const whenRow = screen.getByText('When').closest('.invite-meta-row')
  return whenRow?.querySelector('.invite-meta-value')?.textContent ?? ''
}

/**
 * Every clock reading in the "When" row, normalized to 24h `HH:MM`.
 *
 * `en-US` renders `hour: '2-digit'` as `02:00 PM`, so raw substring matching on
 * `14:00` would silently pass on a wrong time. Normalizing keeps the assertions
 * about the actual instant rather than about the locale's clock convention.
 */
function whenRowClockTimes(): string[] {
  const out: string[] = []
  const re = /(\d{1,2})[:.](\d{2})(?:\s*([ap])\.?m\.?)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(whenRowText())) !== null) {
    let hour = Number(m[1])
    const meridiem = m[3]?.toLowerCase()
    if (meridiem === 'p' && hour < 12) hour += 12
    if (meridiem === 'a' && hour === 12) hour = 0
    out.push(`${String(hour).padStart(2, '0')}:${m[2]}`)
  }
  return out
}

/**
 * Reverse check for the DST tests: take a clock time as the card rendered it
 * for the viewer, rebuild the instant it denotes (the viewer's UTC offset at
 * that moment is passed in explicitly, so this stays independent of the code
 * under test), and print that instant back in the organizer's zone. Asserting
 * on this catches an instant that displays plausibly for the viewer while
 * denoting a different wall clock than the one the organizer typed.
 */
function clockBackInZone(
  isoDate: string,
  clock: string,
  viewerOffsetHours: number,
  zone: string,
): string {
  const [y, mo, d] = isoDate.split('-').map(Number)
  const [hh, mi] = clock.split(':').map(Number)
  const instant = new Date(Date.UTC(y, mo - 1, d, hh - viewerOffsetHours, mi))
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** Europe/Moscow is a fixed UTC+3 zone with no DST, so the offset is exact. */
function moscowClockBackInZone(isoDate: string, clock: string, zone: string): string {
  return clockBackInZone(isoDate, clock, 3, zone)
}

/** Europe/Berlin after the spring-forward transition: CEST, UTC+2. */
function berlinClockBackInZone(isoDate: string, clock: string, zone: string): string {
  return clockBackInZone(isoDate, clock, 2, zone)
}

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
  // §2.127 closed error vocabulary.
  'app.errors.presented.offline': 'No connection to the mail server. MailCopilot will keep retrying.',
  'app.errors.presented.timeout': 'The mail server did not respond in time. MailCopilot will keep retrying.',
  'app.errors.presented.auth': 'Sign-in was rejected. Check the account password, or re-authorize the account in Settings.',
  'app.errors.presented.unknown': 'Could not complete the request. Please try again.',
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

  describe('TZID rendering — viewer TZ pinned to Europe/Berlin', () => {
    useViewerTimezone('Europe/Berlin')

    it('wall-clock dtstart (no Z) in an IANA tzid is converted into the viewer TZ', () => {
      // '2026-05-15T14:00:00' = wall-clock 14:00 in America/New_York (EDT, UTC-4)
      // = 18:00Z = 20:00 in Europe/Berlin (CEST, UTC+2). Every mainstream client
      // (Gmail, Outlook, Thunderbird, Apple Mail) shows the viewer's own zone and
      // captions the original one — so the card must show 20:00, not 14:00.
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-05-15T14:00:00',
          dtend: '2026-05-15T15:30:00',
          tzid: 'America/New_York',
        }),
      })
      render(<InviteCard {...props} />)

      // 14:00 NY → 20:00–21:30 Berlin, NOT the organizer's 14:00–15:30
      expect(whenRowClockTimes()).toEqual(['20:00', '21:30'])

      // Annotation element must be present (America/New_York ≠ Europe/Berlin)
      const annotation = screen.getByTestId('invite-tzid-annotation')
      expect(annotation).toBeInTheDocument()
      expect(annotation.textContent).toMatch(/America\/New_York/i)
    })

    it('ISO instant dtstart with an IANA tzid renders in the viewer TZ, not the organizer TZ', () => {
      // '2026-05-15T18:00:00.000Z' = 14:00 America/New_York = 20:00 Europe/Berlin.
      // The tzid must NOT be used as the display zone — only as the caption.
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-05-15T18:00:00.000Z',
          dtend: '2026-05-15T19:30:00.000Z',
          tzid: 'America/New_York',
        }),
      })
      render(<InviteCard {...props} />)

      // 18:00Z = 14:00 NY = 20:00 Berlin — the viewer's zone wins
      expect(whenRowClockTimes()).toEqual(['20:00', '21:30'])

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
    it('ISO instant dtstart with a Windows-style tzid (Outlook) renders in the viewer TZ and keeps the caption', () => {
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
      // 06:00Z = 08:00 Europe/Berlin (CEST)
      expect(whenRowClockTimes()).toEqual(['08:00', '08:30'])
      const annotation = screen.getByTestId('invite-tzid-annotation')
      expect(annotation.textContent).toMatch(/Russian Standard Time/i)
    })

    it('ISO instant dtstart without tzid renders without annotation (viewer TZ used)', () => {
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
      expect(whenRowClockTimes()).toEqual(['20:00', '21:30'])
    })

    // -----------------------------------------------------------------------
    // The viewer's own DST transition must never touch the organizer's numbers.
    // 2026-03-29 02:30 does not exist in Europe/Berlin (02:00 CET → 03:00 CEST),
    // and the card used to build the organizer's wall clock with
    // `new Date(y, m-1, d, hh, mm)` — a viewer-local constructor that silently
    // normalizes that reading to 03:30 before anything is converted.
    // -----------------------------------------------------------------------

    it('converts a wall clock that lands in the VIEWER gap using the organizer zone only', () => {
      // 02:30 in America/New_York on 2026-03-29 is plain EDT (the US switched
      // three weeks earlier) = 06:30Z = 08:30 Berlin. The pre-fix code read the
      // Berlin-normalized 03:30 as the organizer's time and showed 09:30.
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-03-29T02:30:00',
          dtend: '2026-03-29T03:30:00',
          tzid: 'America/New_York',
        }),
      })
      render(<InviteCard {...props} />)

      expect(whenRowClockTimes()).toEqual(['08:30', '09:30'])
      // Reverse check in the ORGANIZER's zone: 08:30 Berlin = 06:30Z = 02:30 NY,
      // exactly what the organizer wrote.
      expect(berlinClockBackInZone('2026-03-29', '08:30', 'America/New_York'))
        .toBe('2026-03-29 02:30')
    })

    it('prints an unresolvable-TZID wall clock verbatim on the viewer transition date', () => {
      // Windows label → no zone to convert from, so the promise is to show the
      // organizer's numbers as printed. 02:30 has no viewer-local instant at
      // all on this date, so a viewer-local Date could not carry it: pre-fix the
      // card showed 03:30–04:30, i.e. numbers the organizer never wrote.
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-03-29T02:30:00',
          dtend: '2026-03-29T03:30:00',
          tzid: 'Russian Standard Time',
        }),
      })
      render(<InviteCard {...props} />)

      expect(whenRowClockTimes()).toEqual(['02:30', '03:30'])
      expect(whenRowText()).toMatch(/29/)
      expect(screen.getByTestId('invite-tzid-annotation').textContent)
        .toMatch(/Russian Standard Time/)
    })

    it('prints a zone-less wall clock verbatim on the viewer fall-back date', () => {
      // 2026-10-25 02:30 exists twice in Europe/Berlin. Without a zone there is
      // nothing to disambiguate — the numbers are shown as written.
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-10-25T02:30:00',
          dtend: '2026-10-25T03:15:00',
          tzid: undefined,
        }),
      })
      render(<InviteCard {...props} />)

      expect(whenRowClockTimes()).toEqual(['02:30', '03:15'])
    })
  })

  // ---------------------------------------------------------------------------
  // Regression: the card used to format the meeting in the ORGANIZER's zone
  // whenever the TZID happened to be one Intl understands. Reproduced on real
  // invites from the user's mailbox (2026-08): the same Exchange server emits
  // `TZID=Russian Standard Time` for most invites (Windows label → Intl throws →
  // accidental fall back to viewer-local → correct time) and `TZID=UTC` for
  // updates (Intl accepts it → 12:00 shown for a 15:00 Moscow meeting). The user
  // arrived three hours early. Time is now ALWAYS the viewer's zone.
  // ---------------------------------------------------------------------------
  describe('viewer TZ pinned to Europe/Moscow — real mailbox invites', () => {
    useViewerTimezone('Europe/Moscow')

    it('renders a TZID=UTC invite in Moscow time (15:00–16:00), not in UTC', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-07-30T12:00:00.000Z',
          dtend: '2026-07-30T13:00:00.000Z',
          tzid: 'UTC',
        }),
      })
      render(<InviteCard {...props} />)

      // The organizer-zone reading (12:00–13:00) is the bug; Moscow is the truth.
      expect(whenRowClockTimes()).toEqual(['15:00', '16:00'])
      // Original zone still captioned.
      expect(screen.getByTestId('invite-tzid-annotation').textContent).toMatch(/UTC/)
    })

    it('keeps the Windows-TZID invite correct (13:30–14:00) — regression anchor', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-08-10T10:30:00.000Z',
          dtend: '2026-08-10T11:00:00.000Z',
          tzid: 'Russian Standard Time',
        }),
      })
      render(<InviteCard {...props} />)

      expect(whenRowClockTimes()).toEqual(['13:30', '14:00'])
      expect(screen.getByTestId('invite-tzid-annotation').textContent)
        .toMatch(/Russian Standard Time/)
    })

    it('converts a wall-clock dtstart in an IANA tzid into Moscow time', () => {
      // 09:00 wall-clock in America/New_York (EDT, UTC-4) = 13:00Z = 16:00 Moscow
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-08-10T09:00:00',
          dtend: '2026-08-10T10:00:00',
          tzid: 'America/New_York',
        }),
      })
      render(<InviteCard {...props} />)

      expect(whenRowClockTimes()).toEqual(['16:00', '17:00'])
    })

    it('resolves a wall-clock time that falls just after a DST transition', () => {
      // 2026-03-08 is the US spring-forward date. 03:30 wall-clock in New York
      // is already EDT (UTC-4) = 07:30Z = 10:30 Moscow. A single-pass offset
      // lookup would read the offset at 03:30Z (still EST, UTC-5) and land an
      // hour off, so this pins the second pass in `wallClockToInstant`.
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-03-08T03:30:00',
          dtend: '2026-03-08T04:30:00',
          tzid: 'America/New_York',
        }),
      })
      render(<InviteCard {...props} />)

      expect(whenRowClockTimes()).toEqual(['10:30', '11:30'])
    })

    // Nonexistent wall clock — 2026-03-08 02:30 America/New_York is inside the
    // spring-forward gap (02:00 EST jumps straight to 03:00 EDT). Policy
    // (documented on `wallClockToInstant`): interpret with the offset in force
    // BEFORE the transition, so the instant lands just after the gap. The old
    // two-pass code produced 06:30Z, which reads back as 01:30 in New York —
    // an hour EARLIER than the organizer wrote.
    it('renders a nonexistent (DST gap) wall-clock time shifted forward, never backward', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-03-08T02:30:00',
          dtend: '2026-03-08T04:30:00',
          tzid: 'America/New_York',
        }),
      })
      render(<InviteCard {...props} />)

      // Viewer (Moscow, UTC+3): 07:30Z → 10:30, 08:30Z → 11:30.
      expect(whenRowClockTimes()).toEqual(['10:30', '11:30'])
      // Reverse check in the organizer's zone: 03:30, i.e. the gap-length-later
      // reading — and specifically NOT the pre-fix 01:30.
      expect(moscowClockBackInZone('2026-03-08', '10:30', 'America/New_York'))
        .toBe('2026-03-08 03:30')
    })

    // Ambiguous wall clock — 2026-11-01 01:30 America/New_York happens twice
    // (05:30Z EDT and 06:30Z EST). Policy: first (earlier) occurrence.
    it('renders an ambiguous (DST fall-back) wall-clock time as the first occurrence', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-11-01T01:30:00',
          dtend: '2026-11-01T01:45:00',
          tzid: 'America/New_York',
        }),
      })
      render(<InviteCard {...props} />)

      // First occurrence 05:30Z → 08:30 Moscow (the second one would be 09:30).
      expect(whenRowClockTimes()).toEqual(['08:30', '08:45'])
      // Reverse check: reads back as the organizer's 01:30 either way — that is
      // what makes the time ambiguous — so the wall clock is honoured.
      expect(moscowClockBackInZone('2026-11-01', '08:30', 'America/New_York'))
        .toBe('2026-11-01 01:30')
    })

    it('keeps organizer wall-clock verbatim when the tzid is a Windows label (nothing to convert from)', () => {
      // No inline VTIMEZONE resolved and no IANA zone to interpret the numbers
      // in: inventing a converted time would be a lie, so the organizer's
      // wall-clock stays as printed and the caption names the zone.
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-08-10T13:30:00',
          dtend: '2026-08-10T14:00:00',
          tzid: 'Russian Standard Time',
        }),
      })
      render(<InviteCard {...props} />)

      expect(whenRowClockTimes()).toEqual(['13:30', '14:00'])
      expect(screen.getByTestId('invite-tzid-annotation').textContent)
        .toMatch(/Russian Standard Time/)
    })

    it('omits the caption when the invite zone equals the viewer zone', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-07-30T12:00:00.000Z',
          dtend: '2026-07-30T13:00:00.000Z',
          tzid: 'Europe/Moscow',
        }),
      })
      render(<InviteCard {...props} />)

      expect(screen.queryByTestId('invite-tzid-annotation')).not.toBeInTheDocument()
      expect(whenRowClockTimes()).toEqual(['15:00', '16:00'])
    })

    it('omits the caption when the invite zone is an alias of the viewer zone', () => {
      // Europe/Moscow has no alias in wide use; W-SU is the canonical example.
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-07-30T12:00:00.000Z',
          dtend: '2026-07-30T13:00:00.000Z',
          tzid: 'W-SU',
        }),
      })
      render(<InviteCard {...props} />)

      expect(screen.queryByTestId('invite-tzid-annotation')).not.toBeInTheDocument()
    })

    it('renders an all-day event unchanged under a non-UTC viewer zone', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: true,
          dtstart: '2026-05-15',
          dtend: undefined,
          tzid: 'UTC',
        }),
      })
      render(<InviteCard {...props} />)

      const text = whenRowText()
      expect(text).toMatch(/may/i)
      expect(text).toMatch(/15/)
      expect(text).not.toMatch(/\d{1,2}:\d{2}/)
      // all-day events carry no zone caption
      expect(screen.queryByTestId('invite-tzid-annotation')).not.toBeInTheDocument()
    })
  })

  // ---------------------------------------------------------------------------
  // Defect 2 — the caption element existed in the JSX but `.invite-tzid-annotation`
  // had no rule in App.css at all, so it rendered inline, glued to the time:
  // "10 August · 13:30–14:00Originally scheduled in Russian Standard Time".
  // jsdom does not load App.css, so the guard is on the stylesheet itself.
  // ---------------------------------------------------------------------------
  describe('original-zone caption styling', () => {
    it('renders the caption as its own element inside the When value', () => {
      const props = makeProps({
        invite: makeInvite({
          allDay: false,
          dtstart: '2026-07-30T12:00:00.000Z',
          dtend: '2026-07-30T13:00:00.000Z',
          tzid: 'Some/Other_Zone',
        }),
      })
      render(<InviteCard {...props} />)

      const annotation = screen.getByTestId('invite-tzid-annotation')
      expect(annotation.className).toContain('invite-tzid-annotation')
      expect(annotation.parentElement?.className).toContain('invite-meta-value')
    })

    it('App.css styles .invite-tzid-annotation as a separated, secondary line', () => {
      const css = fs.readFileSync(appCssPath(), 'utf8')
      const rule = /\.invite-tzid-annotation\s*\{([^}]*)\}/.exec(css)
      expect(rule, '.invite-tzid-annotation rule missing from src/App.css').not.toBeNull()
      const body = rule?.[1] ?? ''
      // Own line, not glued to the time
      expect(body).toMatch(/display:\s*block/)
      // Visually secondary to the time itself
      expect(body).toMatch(/color:\s*var\(--muted\)/)
      // CLAUDE.md §5 — whole pixels, never a fraction of the 13px base
      expect(body).not.toMatch(/font-size:\s*[\d.]+(em|%|rem)/)
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

  // §2.127 — an RSVP send crosses the SMTP path, so the interesting failure
  // modes are exactly the ones the closed vocabulary names. The rejection text
  // is attacker-influenceable (it can quote an SMTP server response) and is no
  // longer rendered.
  describe('RSVP failure presentation (§2.127)', () => {
    it('shows the offline sentence when the IPC rejection carries the offline tag', async () => {
      mockInvoke.mockRejectedValueOnce(
        new Error("[mcerr:offline] Error invoking remote method 'mail:rsvpInvite': AggregateError"),
      )
      render(<InviteCard {...makeProps()} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('invite-btn-accept'))
      })

      const banner = screen.getByTestId('invite-error')
      expect(banner).toHaveTextContent('No connection to the mail server')
      expect(banner.textContent).not.toContain('mcerr')
      expect(banner.textContent).not.toContain('AggregateError')
    })

    it('shows the auth sentence when the rejection carries the auth tag', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('[mcerr:auth] 535 5.7.8 Bad credentials'))
      render(<InviteCard {...makeProps()} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('invite-btn-decline'))
      })

      const banner = screen.getByTestId('invite-error')
      expect(banner).toHaveTextContent('Sign-in was rejected')
      expect(banner.textContent).not.toContain('Bad credentials')
    })

    it('falls back to the generic sentence for an untagged rejection', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('something went sideways'))
      render(<InviteCard {...makeProps()} />)

      await act(async () => {
        fireEvent.click(screen.getByTestId('invite-btn-accept'))
      })

      const banner = screen.getByTestId('invite-error')
      expect(banner).toHaveTextContent('Could not complete the request')
      expect(banner.textContent).not.toContain('sideways')
    })
  })
})
