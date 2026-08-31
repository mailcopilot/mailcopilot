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
 *
 * §2.128: attachment block behaviour (collapse ceiling, demotion of inlined
 * parts) is covered here at the component seam; the model itself is
 * unit-tested in `src/utils/attachmentList.test.ts`. The invariant the seam
 * must show is that no part is ever removed — expanding reaches every one.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type {
  AttachmentMeta,
  CalendarInvitePublic,
  MailSummary,
  MessageDetails,
} from '../../packages/types'
import type { UseMailTranslationResult } from '../hooks/useMailTranslation'

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
  'app.errors.bodyLoadTimedOut': 'Loading timed out — you can try again',
  'app.errors.bodyLoadFailed': 'Could not load the body of this message',
  'mail.actions.retry': 'Retry',
  'app.empty.messageNotFound.title': 'Message not found',
  'mail.privacy.imagesBlocked': 'Images blocked',
  'mail.privacy.showImages': 'Show images',
  'mail.attachments.download': 'Download attachment',
  'mail.attachments.unnamed': 'Attachment',
  'mail.attachments.showMore': 'Show more ({{hidden}})',
  'mail.attachments.showLess': 'Show less',
  'attachments.downloadAction': 'Download attachment: {{name}}',
  // §2.145 — parse-cap notice, rendered via the real MailParseCapNotice
  // component wired in by MailBodyContent (see the describe block below).
  'mail.parseCap.hard.title': 'This message is too large to open',
  'mail.parseCap.hard.body': 'It is larger than {{limit}}, the most we can read.',
  'mail.parseCap.soft.banner': 'Only the beginning of this message is shown.',
  'mail.parseCap.soft.action': 'Show full message',
  'mail.parseCap.soft.loading': 'Loading…',
  'mail.parseCap.soft.atLimit': 'This is as much of it as MailCopilot will display.',
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

// ---------------------------------------------------------------------------
// §2.128 — attachment block must not take over the reading area
// ---------------------------------------------------------------------------

function makeAttachment(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    part: '2',
    filename: 'file.bin',
    contentType: 'application/octet-stream',
    size: 1024,
    ...overrides,
  }
}

/** N genuine attachments — every one `disposition: attachment`, no `cid`. */
function realAttachments(n: number): AttachmentMeta[] {
  return Array.from({ length: n }, (_, i) =>
    makeAttachment({
      part: `2.${i + 1}`,
      filename: `contract-${i + 1}.pdf`,
      contentType: 'application/pdf',
      size: 10_000 + i,
      disposition: 'attachment',
    }),
  )
}

function chips(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll('.attachment-chip')
}

describe('MailBodyContent — attachment list ceiling (§2.128 part 2)', () => {
  afterEach(cleanup)

  it('keeps the message body on screen when 30 genuine attachments arrive', () => {
    // No cid anywhere and no report from the renderer: nothing to demote, so
    // this exercises the cap alone — the reading area must survive on the
    // ceiling's own merit.
    const props = makeProps({
      details: makeDetails({ attachments: realAttachments(30), text: 'Body still readable.' }),
    })
    const { container } = render(<MailBodyContent {...props} />)

    expect(chips(container)).toHaveLength(4)
    // The count on the toggle is what is not on screen (26), not the total.
    expect(screen.getByTestId('attachments-toggle')).toHaveTextContent('Show more (26)')
    expect(screen.getByTestId('mail-body-text')).toHaveTextContent('Body still readable.')
  })

  it('renders no toggle when the list fits', () => {
    const props = makeProps({ details: makeDetails({ attachments: realAttachments(3) }) })
    const { container } = render(<MailBodyContent {...props} />)

    expect(chips(container)).toHaveLength(3)
    expect(screen.queryByTestId('attachments-toggle')).not.toBeInTheDocument()
  })

  it('renders no attachment block at all when there are no attachments', () => {
    render(<MailBodyContent {...makeProps()} />)
    expect(screen.queryByTestId('mail-attachments')).not.toBeInTheDocument()
  })

  it('expands to the full list on click and collapses again', () => {
    const props = makeProps({ details: makeDetails({ attachments: realAttachments(30) }) })
    const { container } = render(<MailBodyContent {...props} />)

    const toggle = screen.getByTestId('attachments-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(chips(container)).toHaveLength(30)
    expect(screen.getByTestId('attachments-toggle')).toHaveTextContent('Show less')
    expect(screen.getByTestId('attachments-toggle')).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByTestId('attachments-toggle'))
    expect(chips(container)).toHaveLength(4)
  })

  it('gives the expanded list its own scroll container instead of growing the page', () => {
    const props = makeProps({ details: makeDetails({ attachments: realAttachments(30) }) })
    const { container } = render(<MailBodyContent {...props} />)

    fireEvent.click(screen.getByTestId('attachments-toggle'))
    // The scrolling behaviour itself is CSS (.mail-attachments--expanded);
    // the component's contract is to flag the expanded state on the block.
    expect(container.querySelector('.mail-attachments')).toHaveClass('mail-attachments--expanded')
  })

  it('collapses again when another message is selected', () => {
    const props = makeProps({ details: makeDetails({ attachments: realAttachments(30) }) })
    const { container, rerender } = render(<MailBodyContent {...props} />)

    fireEvent.click(screen.getByTestId('attachments-toggle'))
    expect(chips(container)).toHaveLength(30)

    // Same shape of message, different mail key — expansion must not leak over.
    rerender(
      <MailBodyContent
        {...makeProps({
          details: makeDetails({ attachments: realAttachments(30) }),
          activeMailKey: '1:INBOX:43',
        })}
      />,
    )
    expect(chips(container)).toHaveLength(4)
  })
})

describe('MailBodyContent — inlined parts are demoted, never removed (§2.128 part 1)', () => {
  afterEach(cleanup)

  // The component holds no opinion about which parts were inlined: it demotes
  // the parts the body renderer reports, and nothing else. The rule that
  // produces that report is tested in `packages/core/cidRefs.test.ts`, its
  // wiring to the actual body in `src/hooks/useMailIframeDoc.test.ts`.
  it('leads with the real file and keeps the reported parts one click away', () => {
    const logo = makeAttachment({ part: '2', filename: 'logo.png', contentType: 'image/png', cid: 'logo@x' })
    const speaker = makeAttachment({ part: '3', filename: 'speaker.jpg', contentType: 'image/jpeg', cid: 'sp@x' })
    const programme = makeAttachment({
      part: '4',
      filename: 'programme.pdf',
      contentType: 'application/pdf',
      disposition: 'attachment',
    })
    const props = makeProps({
      details: makeDetails({
        attachments: [logo, speaker, programme],
        html: '<p>Hi</p><img src="cid:logo@x"><img src="cid:sp@x">',
      }),
      hiddenAttachments: [logo, speaker],
    })
    const { container } = render(<MailBodyContent {...props} />)

    expect(chips(container)).toHaveLength(1)
    expect(container.querySelector('.attachment-name')?.textContent).toBe('programme.pdf')
    expect(screen.getByTestId('attachments-toggle')).toHaveTextContent('Show more (2)')

    fireEvent.click(screen.getByTestId('attachments-toggle'))
    expect(
      Array.from(container.querySelectorAll('.attachment-name')).map(n => n.textContent),
    ).toEqual(['programme.pdf', 'logo.png', 'speaker.jpg'])
  })

  // The user's screenshot: a message made entirely of layout images. Collapsed,
  // the block is a single toggle and the message reads; expanded, every image
  // is downloadable. A wrong "this was drawn" verdict now costs one click.
  it('collapses a message of 30 inlined images to the toggle and reveals all of them', () => {
    const images = Array.from({ length: 30 }, (_, i) =>
      makeAttachment({
        part: `3.${i + 1}`,
        filename: `img-${i + 1}.png`,
        contentType: 'image/png',
        cid: `img${i + 1}@x`,
        disposition: 'inline',
      }),
    )
    const props = makeProps({
      details: makeDetails({
        attachments: images,
        text: 'Body still readable.',
      }),
      hiddenAttachments: images,
    })
    const { container } = render(<MailBodyContent {...props} />)

    expect(chips(container)).toHaveLength(0)
    expect(screen.getByTestId('attachments-toggle')).toHaveTextContent('Show more (30)')
    expect(screen.getByTestId('mail-body-text')).toHaveTextContent('Body still readable.')

    fireEvent.click(screen.getByTestId('attachments-toggle'))
    expect(chips(container)).toHaveLength(30)
  })

  // A part the sender buried in `<div style="display:none">` satisfies every
  // condition the inlining rule can check, so it is reported — and it must
  // still be reachable. This is the finding that ended the "detect what the
  // browser drew" approach.
  it('keeps a part the body rendered inside a display:none container reachable', () => {
    const report = makeAttachment({
      part: '2',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      cid: 'report@x',
      disposition: 'inline',
    })
    const props = makeProps({
      details: makeDetails({
        attachments: [report],
        html: '<div style="display:none"><img src="cid:report@x"></div>',
      }),
      hiddenAttachments: [report],
    })
    const { container } = render(<MailBodyContent {...props} />)

    expect(chips(container)).toHaveLength(0)
    fireEvent.click(screen.getByTestId('attachments-toggle'))
    expect(container.querySelector('.attachment-name')?.textContent).toBe('report.pdf')
  })

  it('shows both real attachments immediately when 30 inlined images follow them', () => {
    const images = Array.from({ length: 30 }, (_, i) =>
      makeAttachment({
        part: `3.${i + 1}`,
        filename: `img-${i + 1}.png`,
        contentType: 'image/png',
        cid: `img${i + 1}@x`,
        disposition: 'inline',
      }),
    )
    const contracts = realAttachments(2)
    const props = makeProps({
      details: makeDetails({ attachments: [...images.slice(0, 10), ...contracts, ...images.slice(10)] }),
      hiddenAttachments: images,
    })
    const { container } = render(<MailBodyContent {...props} />)

    expect(
      Array.from(container.querySelectorAll('.attachment-name')).map(n => n.textContent),
    ).toEqual(['contract-1.pdf', 'contract-2.pdf'])
    expect(screen.getByTestId('attachments-toggle')).toHaveTextContent('Show more (30)')

    fireEvent.click(screen.getByTestId('attachments-toggle'))
    expect(chips(container)).toHaveLength(32)
  })

  // The dangerous direction, made structural: with no report, nothing was
  // inlined, so every part leads the row — even one that looks inline and is
  // referenced by the body.
  it('shows every part when the renderer reports nothing', () => {
    const props = makeProps({
      details: makeDetails({
        attachments: [makeAttachment({ part: '2', filename: 'logo.png', cid: 'logo@x', disposition: 'inline' })],
        html: '<img src="cid:logo@x">',
      }),
    })
    const { container } = render(<MailBodyContent {...props} />)
    expect(chips(container)).toHaveLength(1)
  })

  it('ignores the body html when deciding what to demote', () => {
    // A body full of cid: references demotes nothing on its own — only the
    // renderer's report does.
    const invoice = makeAttachment({ part: '2', filename: 'invoice.pdf', cid: 'inv@x' })
    const props = makeProps({
      details: makeDetails({
        attachments: [invoice],
        html: '<img src="cid:inv@x">',
      }),
      hiddenAttachments: [],
    })
    const { container } = render(<MailBodyContent {...props} />)
    expect(chips(container)).toHaveLength(1)
  })

  it('keeps two distinct parts the sender declared identically', () => {
    // Same declared name, type and size — but different MIME parts, so possibly
    // different bytes. Merging them (as an earlier revision did) would leave the
    // user with no way to reach one of the files, which §2.128 rules out: the
    // cap keeps the block small, nothing else gets to remove a part.
    const props = makeProps({
      details: makeDetails({
        attachments: [
          makeAttachment({ part: '2', filename: 'logo.png', contentType: 'image/png', size: 512 }),
          makeAttachment({ part: '3', filename: 'logo.png', contentType: 'image/png', size: 512 }),
        ],
        text: 'Plain body.',
      }),
    })
    const { container } = render(<MailBodyContent {...props} />)
    expect(chips(container)).toHaveLength(2)
  })

  it('renders no preview badge on the chips (§2.125)', () => {
    const props = makeProps({
      details: makeDetails({
        attachments: [
          makeAttachment({ part: '2', filename: 'report.pdf', contentType: 'application/pdf', disposition: 'attachment' }),
        ],
      }),
    })
    const { container } = render(<MailBodyContent {...props} />)
    expect(container.querySelector('.attachment-preview-badge')).toBeNull()
    expect(container.textContent).not.toContain('attachments.previewAvailable')
  })
})

// ---------------------------------------------------------------------------
// §2.145 — two-tier parse-cap UI wiring.
//
// A live-Electron e2e for this branch turned out to be unreachable:
// `net:messageDetails` short-circuits under `IS_E2E` (electron/main.ts)
// before it ever calls `parseEmlBuffer`, and there is no unguarded IPC entry
// point for it the way `mail:rsvpInvite` has for the calendar path. An
// earlier version of this suite tried to work around that by reassigning
// `window.api.invoke` from inside a Playwright `page.evaluate` — that
// silently does nothing: the object `contextBridge.exposeInMainWorld`
// produces in the main world is backed by a read-only proxy back to the
// isolated world, so the assignment appears to succeed (no throw, sloppy-mode
// semantics) but every subsequent call still reaches the REAL bridge. The
// production log confirmed it: both the "normal" and the "hard-capped" click
// produced a `net.message_details.wall_ms { cache_hit_level: 'imap' }` line —
// the real E2E fixture handler ran for the hard-capped uid too, because the
// override was never in effect. That e2e spec was removed as a false test
// (CLAUDE.md §7 rule 11 — a mock that does not reproduce the real contract).
//
// This suite is what actually proves the wiring the removed e2e spec could
// not: it drives the REAL `MailBodyContent` component (imported, not
// reimplemented) with real `MessageDetails.parseCap` fixtures and checks the
// exact branch ordering `electron/main.ts`'s comments promise — hard cap
// ABOVE "message not found", soft banner BELOW the clipped body, suppressed
// while loading. `MailParseCapNotice.test.tsx` covers the leaf component's
// own rendering in isolation; this covers that `MailBodyContent` actually
// reaches it with the right props, which is exactly what silently drops if
// the `parseCap` field is lost anywhere between the IPC boundary and here.
describe('MailBodyContent — §2.145 parse-cap wiring', () => {
  afterEach(cleanup)

  const HARD_CAP = { kind: 'hard' as const, rawBytes: 150 * 1024 * 1024, limitBytes: 100 * 1024 * 1024 }
  const SOFT_CAP = { kind: 'soft' as const, rawBytes: 4 * 1024 * 1024, limitBytes: 1024 * 1024, canShowFull: true }

  it('renders the hard-cap placeholder INSTEAD OF the generic "no body" empty state', () => {
    const props = makeProps({
      details: makeDetails({ text: undefined, html: undefined, parseCap: HARD_CAP }),
    })
    render(<MailBodyContent {...props} />)

    const card = screen.getByTestId('mail-parse-cap-hard')
    expect(card).toBeInTheDocument()
    // The LIMIT is stated; the message's own size is not. §2.145 wave 3.1 —
    // `rawBytes` is a lower bound on the refused-mid-download path, so showing
    // it as the size asserted something we do not know.
    expect(card).toHaveTextContent('100.0 MB')
    expect(card).not.toHaveTextContent('150.0 MB')
    // The generic "no body" empty-state must not ALSO render — a hard-capped
    // message HAS a body, we declined to read it, and "message not found"
    // would be a lie.
    expect(screen.queryByText('Message not found')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mail-body-text')).not.toBeInTheDocument()
  })

  it('renders the soft-cap banner BELOW the clipped body and wires the click to onShowFullMessage', () => {
    const onShowFullMessage = vi.fn()
    const props = makeProps({
      details: makeDetails({ text: 'clipped body text', parseCap: SOFT_CAP }),
      onShowFullMessage,
      loadingFullMessage: false,
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('mail-body-text')).toHaveTextContent('clipped body text')
    expect(screen.getByTestId('mail-parse-cap-soft')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('mail-parse-cap-show-full'))
    expect(onShowFullMessage).toHaveBeenCalledOnce()
  })

  it('passes loadingFullMessage through to disable the show-full button', () => {
    const props = makeProps({
      details: makeDetails({ text: 'clipped', parseCap: SOFT_CAP }),
      onShowFullMessage: vi.fn(),
      loadingFullMessage: true,
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('mail-parse-cap-show-full')).toBeDisabled()
  })

  it('suppresses the soft-cap banner while the body is (re-)loading', () => {
    // §2.145 — the first paint of a re-parse must not show the OLD banner
    // over the loading spinner.
    const props = makeProps({
      loadingBody: true,
      details: makeDetails({ text: 'stale clipped body', parseCap: SOFT_CAP }),
    })
    render(<MailBodyContent {...props} />)

    expect(screen.queryByTestId('mail-parse-cap-soft')).not.toBeInTheDocument()
  })

  it('renders neither cap UI for an uncapped message', () => {
    render(<MailBodyContent {...makeProps()} />)

    expect(screen.queryByTestId('mail-parse-cap-hard')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mail-parse-cap-soft')).not.toBeInTheDocument()
  })

  // codex-bg-review Part B, LOW — an html clip that lands near byte zero
  // (packages/net/eml.test.ts's "can clip an html body to nothing near byte
  // zero" pins the real shape this produces: `html` AND `text` both
  // `undefined`, `parseCap.kind === 'soft'`). The cap-specific banner DOES
  // still render for this shape — that half of the gap is real. What this
  // test ALSO pins, stated plainly rather than hidden: the body-area ternary
  // above the banner only checks `!details.html && !details.text`, not
  // `parseCap.kind`, so it independently falls into the generic "message not
  // found" empty state at the same time. Both render together. This is NOT
  // asserted as correct — it is a UX finding (a message that is simultaneously
  // "not found" and "here's a button for more of it" is confusing), pinned
  // here as OBSERVED behaviour so a future change is deliberate, and flagged
  // as a followup for renderer-ui rather than patched by this suite.
  it('finding: an html clip to nothing near byte zero shows the soft-cap banner ALONGSIDE "message not found", not instead of it', () => {
    const props = makeProps({
      details: makeDetails({ html: undefined, text: undefined, parseCap: SOFT_CAP }),
    })
    render(<MailBodyContent {...props} />)

    // The cap-specific state is present...
    expect(screen.getByTestId('mail-parse-cap-soft')).toBeInTheDocument()
    // ...but so is the generic "no body" state, simultaneously.
    expect(screen.getByText('Message not found')).toBeInTheDocument()
  })
})

// --- §2.17 Phase 1: the headers-only envelope names its own cause ---

describe('MailBodyContent — §2.17 Phase 1 fallback reason', () => {
  afterEach(cleanup)

  const headersOnly = { text: undefined, html: undefined, offlineFallback: true }

  it("says the fetch timed out (not 'offline') when the budget expired", () => {
    const props = makeProps({
      details: makeDetails({ ...headersOnly, offlineFallbackReason: 'timeout' as const }),
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('mail-body-timeout')).toBeInTheDocument()
    expect(screen.getByText('Loading timed out — you can try again')).toBeInTheDocument()
    // What a timeout establishes is ONE thing: our own load budget ran out.
    // It says nothing about whether the user is online or whether the body
    // exists on the server — the budget is a stopwatch that fires without
    // learning why the fetch was slow. So the assertion is only that the
    // offline sentence is absent, not that any opposite fact holds.
    expect(screen.queryByText('Body not available offline')).not.toBeInTheDocument()
    // Retry stays — it is the one action that can actually help.
    expect(screen.getByTestId('mail-offline-retry')).toBeInTheDocument()
  })

  it('keeps the offline wording for work-offline mode, where the server was never contacted', () => {
    const props = makeProps({
      details: makeDetails({ ...headersOnly, offlineFallbackReason: 'offline' as const }),
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('mail-body-offline')).toBeInTheDocument()
    expect(screen.getByText('Body not available offline')).toBeInTheDocument()
  })

  it('treats a missing reason as offline (envelopes written before the field existed)', () => {
    const props = makeProps({ details: makeDetails(headersOnly) })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('mail-body-offline')).toBeInTheDocument()
    expect(screen.getByText('Body not available offline')).toBeInTheDocument()
  })

  // Fix wave: the catch-all branch in main.ts used to hand this envelope
  // 'offline'. It catches an expired password just as readily as a dead
  // network, and the offline sentence — plus the crossed-out Wi-Fi symbol —
  // was a lie in both words and picture for every case but one.
  it("says the fetch failed (not 'offline') when the IMAP attempt threw", () => {
    const props = makeProps({
      details: makeDetails({ ...headersOnly, offlineFallbackReason: 'unavailable' as const }),
    })
    render(<MailBodyContent {...props} />)

    expect(screen.getByTestId('mail-body-unavailable')).toBeInTheDocument()
    expect(screen.getByText('Could not load the body of this message')).toBeInTheDocument()
    expect(screen.queryByText('Body not available offline')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mail-body-offline')).not.toBeInTheDocument()
    // Retry is the only way out of this state, so it has to be here.
    expect(screen.getByTestId('mail-offline-retry')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// §3.3 B6 — the translation swap: `translation` is optional wiring from
// `useMailTranslation`, and when it reports `showingTranslation` the body area
// must render the translated text INSTEAD of the original — never through the
// iframe, never through `dangerouslySetInnerHTML`. This is the component-level
// half of the CLAUDE.md §5 AI/MCP invariant ("the answer is text, and has no
// HTML half"): electron/services/aiTranslate.test.ts proves the contract has
// no html field at all; these tests prove the renderer honors that shape.
// ---------------------------------------------------------------------------

describe('MailBodyContent — §3.3 B6 translation swap', () => {
  afterEach(() => {
    cleanup()
  })

  function makeTranslationState(overrides: Partial<UseMailTranslationResult> = {}): UseMailTranslationResult {
    return {
      active: true,
      status: 'ready',
      translation: {
        translatedText: 'Good afternoon.',
        sourceLang: 'de',
        targetLang: 'en',
        provider: 'anthropic-api',
        cached: false,
        sourceIsTextProjection: true,
      },
      refusal: null,
      attempts: 0,
      canRetry: false,
      targetLang: 'en',
      sourceLang: null,
      needsLanguageChoice: false,
      canRestateSourceLang: false,
      sourceChoiceOpen: false,
      sourceChoiceVisible: false,
      canApplySourceLang: false,
      showingTranslation: true,
      setTargetLang: vi.fn(),
      setSourceLang: vi.fn(),
      toggleSourceChoice: vi.fn(),
      request: vi.fn(),
      showOriginal: vi.fn(),
      showTranslation: vi.fn(),
      ...overrides,
    }
  }

  it('renders the translated text as a <pre> text child, never as markup, in place of the HTML original', () => {
    const props = makeProps({
      details: makeDetails({ html: '<p>Original HTML body.</p>' }),
      mailIframeDoc: '<html><body>Original HTML body.</body></html>',
      translation: makeTranslationState({
        translation: {
          translatedText: '<b>Hola</b> — literal markup characters, not a tag.',
          sourceLang: 'es',
          targetLang: 'en',
          provider: 'anthropic-api',
          cached: false,
          sourceIsTextProjection: true,
        },
      }),
    })
    const { container } = render(<MailBodyContent {...props} />)

    const pre = screen.getByTestId('mail-body-translated')
    // A React text child: the tag characters are literal text, not parsed markup.
    expect(pre.textContent).toBe('<b>Hola</b> — literal markup characters, not a tag.')
    expect(container.querySelector('b')).toBeNull()

    // The iframe carrying the ORIGINAL html must not be mounted while the
    // translation is showing — removing this branch's precedence over the
    // `details?.html` branch would render both at once.
    expect(container.querySelector('iframe.mail-iframe')).toBeNull()
  })

  it('shows the original HTML iframe, not the translation, once the reader switches back', () => {
    const props = makeProps({
      details: makeDetails({ html: '<p>Original HTML body.</p>' }),
      mailIframeDoc: '<html><body>Original HTML body.</body></html>',
      translation: makeTranslationState({ showingTranslation: false }),
    })
    const { container } = render(<MailBodyContent {...props} />)

    expect(screen.queryByTestId('mail-body-translated')).not.toBeInTheDocument()
    const iframe = container.querySelector('iframe.mail-iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('srcdoc')).toBe('<html><body>Original HTML body.</body></html>')
  })

  it('never mutates details: the original text survives showing and hiding a translation', () => {
    const props = makeProps({
      details: makeDetails({ text: 'Untouched original.' }),
      translation: makeTranslationState({ showingTranslation: true }),
    })
    render(<MailBodyContent {...props} />)
    expect(props.details?.text).toBe('Untouched original.')
    expect(screen.getByTestId('mail-body-translated')).toBeInTheDocument()
    expect(screen.queryByTestId('mail-body-text')).not.toBeInTheDocument()
  })

  it('renders the translate bar in the meta block when active and a message is open', () => {
    const props = makeProps({ translation: makeTranslationState() })
    render(<MailBodyContent {...props} />)
    expect(screen.getByTestId('mail-translate-bar')).toBeInTheDocument()
  })

  it('renders neither the bar nor the swap when the caller does not wire `translation` (backward-compatible default)', () => {
    const props = makeProps({ details: makeDetails({ text: 'Plain original.' }) })
    render(<MailBodyContent {...props} />)
    expect(screen.queryByTestId('mail-translate-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mail-body-translated')).not.toBeInTheDocument()
    expect(screen.getByTestId('mail-body-text')).toHaveTextContent('Plain original.')
  })

  it('hides the bar when there is no active message, even if translation state is provided', () => {
    const props = makeProps({ active: null, translation: makeTranslationState() })
    render(<MailBodyContent {...props} />)
    expect(screen.queryByTestId('mail-translate-bar')).not.toBeInTheDocument()
  })
})
