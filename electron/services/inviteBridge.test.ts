import { describe, expect, it, vi, beforeEach } from 'vitest'

// metrics.ts pulls in sentry; mock both. The handler tests don't assert on
// metric calls but the fact that recordEvent is reachable inside the
// success branch means the imports must not throw at module load.
const captureExceptionMock = vi.hoisted(() => vi.fn())
vi.mock('../sentry', () => ({
  startInactiveSpan: vi.fn(() => ({
    setAttributes: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  })),
  sentryLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  captureException: captureExceptionMock,
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

const recordEventMock = vi.hoisted(() => vi.fn())
vi.mock('../metrics', () => ({
  recordEvent: recordEventMock,
}))

// Capture the IPC handler registered by registerInviteHandlers so we can
// invoke it directly without spinning up an actual Electron main process.
// handleIpc calls ipcMain.handle internally — we short-circuit both by
// keeping a local registry of (channel → handler) populated at vi.mock time.
const ipcRegistry = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>())
vi.mock('../ipc', () => ({
  handleIpc: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
    ipcRegistry.set(channel, handler)
  }),
}))

import { buildRsvpReply, makeInviteCache, parseCalendarPart, registerInviteHandlers, toPublicInvite } from './inviteBridge'
import type { CalendarInvite, CalendarInvitePublic } from '@mailcopilot/types'

const FIXTURE_REQUEST = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Test Suite//Mail Copilot//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:fixture-uid-1@example.test',
  'DTSTAMP:20260501T100000Z',
  'DTSTART:20260512T140000Z',
  'DTEND:20260512T150000Z',
  'SUMMARY:Quarterly review',
  'LOCATION:Online (Zoom)',
  'DESCRIPTION:Discuss Q2 numbers.',
  'ORGANIZER;CN=Alice Organizer:mailto:alice@example.test',
  'ATTENDEE;CN=Bob Attendee;PARTSTAT=NEEDS-ACTION:mailto:bob@example.test',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

describe('parseCalendarPart', () => {
  it('extracts UID, summary, organiser, location and method from a REQUEST', () => {
    const invite = parseCalendarPart(FIXTURE_REQUEST)
    expect(invite).not.toBeNull()
    expect(invite!.uid).toBe('fixture-uid-1@example.test')
    expect(invite!.summary).toBe('Quarterly review')
    expect(invite!.organizerEmail).toBe('alice@example.test')
    expect(invite!.organizerName).toBe('Alice Organizer')
    expect(invite!.location).toBe('Online (Zoom)')
    expect(invite!.method).toBe('REQUEST')
    // raw must be preserved exactly so downstream REPLY can rebuild
    // VCALENDAR with the original UID/SEQUENCE/DTSTAMP fields.
    expect(invite!.rawIcs).toBe(FIXTURE_REQUEST)
  })

  it('falls back to (no title) when SUMMARY is missing', () => {
    const noSummary = FIXTURE_REQUEST.replace(/SUMMARY:[^\r\n]+\r\n/, '')
    const invite = parseCalendarPart(noSummary)
    expect(invite).not.toBeNull()
    expect(invite!.summary).toBe('(no title)')
  })

  it('returns null when ORGANIZER is missing (cannot RSVP without it)', () => {
    const noOrganizer = FIXTURE_REQUEST.replace(/ORGANIZER[^\r\n]+\r\n/, '')
    expect(parseCalendarPart(noOrganizer)).toBeNull()
  })

  it('returns null when UID is missing', () => {
    const noUid = FIXTURE_REQUEST.replace(/UID:[^\r\n]+\r\n/, '')
    expect(parseCalendarPart(noUid)).toBeNull()
  })

  it('returns null when there is no VEVENT', () => {
    const noEvent = [
      'BEGIN:VCALENDAR',
      'PRODID:-//Test//EN',
      'VERSION:2.0',
      'END:VCALENDAR',
    ].join('\r\n')
    expect(parseCalendarPart(noEvent)).toBeNull()
  })

  it('returns null on completely garbage input without throwing', () => {
    expect(parseCalendarPart('not even close to ical')).toBeNull()
    expect(parseCalendarPart('')).toBeNull()
  })

  it('classifies non-iTIP methods as OTHER', () => {
    const counterMethod = FIXTURE_REQUEST.replace('METHOD:REQUEST', 'METHOD:COUNTER')
    const invite = parseCalendarPart(counterMethod)
    expect(invite).not.toBeNull()
    expect(invite!.method).toBe('OTHER')
  })
})

describe('buildRsvpReply', () => {
  it('produces a METHOD:REPLY with a single self-ATTENDEE carrying PARTSTAT=ACCEPTED', () => {
    const invite = parseCalendarPart(FIXTURE_REQUEST)!
    const { subject, text, icsBody, to } = buildRsvpReply(invite, 'ACCEPTED', 'bob@example.test', 'Bob Attendee')

    expect(to).toBe('alice@example.test')
    expect(subject).toBe('Accepted: Quarterly review')
    expect(text).toContain('accepted')
    expect(text).toContain('Quarterly review')

    // ICS-level invariants
    expect(icsBody).toContain('METHOD:REPLY')
    // RFC 5546 §3.2.3 — UID MUST be preserved
    expect(icsBody).toContain('UID:fixture-uid-1@example.test')
    // Single ATTENDEE must be the responder, not the original Bob/Alice list
    const attendeeMatches = icsBody.match(/^ATTENDEE/gm) ?? []
    expect(attendeeMatches.length).toBe(1)
    expect(icsBody).toMatch(/PARTSTAT=ACCEPTED/)
    expect(icsBody).toMatch(/mailto:bob@example\.test/i)
  })

  it('emits PARTSTAT=TENTATIVE for tentative responses', () => {
    const invite = parseCalendarPart(FIXTURE_REQUEST)!
    const { icsBody, subject } = buildRsvpReply(invite, 'TENTATIVE', 'bob@example.test')
    expect(icsBody).toMatch(/PARTSTAT=TENTATIVE/)
    expect(subject).toBe('Tentative: Quarterly review')
  })

  it('emits PARTSTAT=DECLINED for declines', () => {
    const invite = parseCalendarPart(FIXTURE_REQUEST)!
    const { icsBody, subject } = buildRsvpReply(invite, 'DECLINED', 'bob@example.test')
    expect(icsBody).toMatch(/PARTSTAT=DECLINED/)
    expect(subject).toBe('Declined: Quarterly review')
  })

  it('refreshes DTSTAMP on every REPLY (RFC 5545 §3.8.7.2)', () => {
    const invite = parseCalendarPart(FIXTURE_REQUEST)!
    const { icsBody } = buildRsvpReply(invite, 'ACCEPTED', 'bob@example.test')
    // Original fixture had DTSTAMP:20260501T100000Z; the rebuilt ics must
    // have a fresh stamp. We don't pin it to wall-clock, just assert it
    // is present and not the original.
    const stampMatches = icsBody.match(/DTSTAMP:[^\r\n]+/g) ?? []
    expect(stampMatches.length).toBeGreaterThan(0)
    expect(stampMatches.every(s => s !== 'DTSTAMP:20260501T100000Z')).toBe(true)
  })

  it('encodes DTSTAMP as UTC with trailing Z (RFC 5545 §3.8.7.2)', () => {
    // §2.22 fix iter2A — codex-bg-review HIGH: previously DTSTAMP serialised
    // a floating local-zone time (no Z), violating RFC 5545. Validate that
    // every DTSTAMP in the rebuilt ics matches `YYYYMMDDTHHMMSSZ`.
    const invite = parseCalendarPart(FIXTURE_REQUEST)!
    const { icsBody } = buildRsvpReply(invite, 'ACCEPTED', 'bob@example.test')
    const stamps = icsBody.match(/DTSTAMP:([^\r\n]+)/g) ?? []
    expect(stamps.length).toBeGreaterThan(0)
    for (const stamp of stamps) {
      // Pattern: DTSTAMP:YYYYMMDDTHHMMSSZ
      expect(stamp).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/)
    }
  })

  it('falls back to fromAddress when displayName is omitted', () => {
    const invite = parseCalendarPart(FIXTURE_REQUEST)!
    const { icsBody, text } = buildRsvpReply(invite, 'ACCEPTED', 'bob@example.test')
    // Attendee CN must be present (defaults to address) and the human-
    // readable text must use the address as a stand-in for the name.
    expect(icsBody).toMatch(/CN=bob@example\.test/)
    expect(text).toContain('bob@example.test')
  })
})

// ---------------------------------------------------------------------------
// §2.22 gap coverage — IPC handler (registerInviteHandlers)
// ---------------------------------------------------------------------------

/**
 * Factory that builds a minimal CalendarInvite for use in IPC handler tests.
 * This mirrors the shape of what parseCalendarPart returns for a valid REQUEST.
 */
function makeCalendarInvite(overrides: Partial<CalendarInvite> = {}): CalendarInvite {
  return {
    uid: 'handler-test-uid@example.test',
    summary: 'Handler test meeting',
    dtstart: '20260601T140000Z',
    allDay: false,
    organizerEmail: 'organizer@example.test',
    organizerName: 'Handler Organizer',
    location: 'Room 101',
    method: 'REQUEST',
    rawIcs: FIXTURE_REQUEST,
    ...overrides,
  }
}

describe('registerInviteHandlers — IPC handler mail:rsvpInvite', () => {
  let resolveInvite: ReturnType<typeof vi.fn>
  let resolveFrom: ReturnType<typeof vi.fn>
  let sendRsvp: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ipcRegistry.clear()
    recordEventMock.mockReset()
    captureExceptionMock.mockReset()

    resolveInvite = vi.fn()
    resolveFrom = vi.fn()
    sendRsvp = vi.fn()

    registerInviteHandlers({
      resolveInvite: resolveInvite as unknown as Parameters<typeof registerInviteHandlers>[0]['resolveInvite'],
      resolveFrom: resolveFrom as unknown as Parameters<typeof registerInviteHandlers>[0]['resolveFrom'],
      sendRsvp: sendRsvp as unknown as Parameters<typeof registerInviteHandlers>[0]['sendRsvp'],
    })
  })

  async function callHandler(payload: unknown) {
    const handler = ipcRegistry.get('mail:rsvpInvite')
    if (!handler) throw new Error('mail:rsvpInvite handler was not registered')
    return handler(null, payload)
  }

  it('registers the mail:rsvpInvite channel on setup', () => {
    expect(ipcRegistry.has('mail:rsvpInvite')).toBe(true)
  })

  it('returns ok:true and messageId on a successful ACCEPTED RSVP', async () => {
    resolveInvite.mockResolvedValue(makeCalendarInvite())
    resolveFrom.mockResolvedValue({ email: 'bob@example.test', displayName: 'Bob Test' })
    sendRsvp.mockResolvedValue({ messageId: '<rsvp-accepted@example.test>' })

    const result = await callHandler({
      accountId: 1,
      uid: 42,
      folder: 'INBOX',
      response: 'ACCEPTED',
    })

    expect(result).toEqual({ ok: true, messageId: '<rsvp-accepted@example.test>' })
  })

  it('records mail.invite_rsvp metric with method:accepted on success', async () => {
    resolveInvite.mockResolvedValue(makeCalendarInvite({ location: 'Room 101' }))
    resolveFrom.mockResolvedValue({ email: 'bob@example.test' })
    sendRsvp.mockResolvedValue({ messageId: '<rsvp-x>' })

    await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })

    expect(recordEventMock).toHaveBeenCalledWith('mail.invite_rsvp', {
      method: 'accepted',
      hadLocation: true,
    })
  })

  it('records method:declined when response is DECLINED', async () => {
    resolveInvite.mockResolvedValue(makeCalendarInvite({ location: undefined }))
    resolveFrom.mockResolvedValue({ email: 'bob@example.test' })
    sendRsvp.mockResolvedValue({ messageId: '<rsvp-d>' })

    await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'DECLINED' })

    expect(recordEventMock).toHaveBeenCalledWith('mail.invite_rsvp', {
      method: 'declined',
      hadLocation: false,
    })
  })

  it('records method:tentative when response is TENTATIVE', async () => {
    resolveInvite.mockResolvedValue(makeCalendarInvite())
    resolveFrom.mockResolvedValue({ email: 'bob@example.test' })
    sendRsvp.mockResolvedValue({ messageId: '<rsvp-t>' })

    await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'TENTATIVE' })

    expect(recordEventMock).toHaveBeenCalledWith('mail.invite_rsvp', {
      method: 'tentative',
      hadLocation: true,
    })
  })

  it('returns ok:false with error message when invite is not found in any tier', async () => {
    resolveInvite.mockResolvedValue(null)

    const result = await callHandler({ accountId: 1, uid: 99, folder: 'INBOX', response: 'ACCEPTED' })

    expect(result).toEqual({ ok: false, error: expect.stringContaining('No calendar invite') })
    // Must not attempt to send anything
    expect(sendRsvp).not.toHaveBeenCalled()
    // No metric on failed path (CLAUDE.md §8 — only successful sends are counted)
    expect(recordEventMock).not.toHaveBeenCalled()
  })

  it('returns ok:false and captures Sentry exception when SMTP send throws', async () => {
    resolveInvite.mockResolvedValue(makeCalendarInvite())
    resolveFrom.mockResolvedValue({ email: 'bob@example.test' })
    sendRsvp.mockRejectedValue(new Error('SMTP connection refused'))

    const result = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' }) as { ok: boolean }

    expect(result.ok).toBe(false)
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'InviteBridge.rsvp' }),
    )
    // Metric must NOT be emitted on failure
    expect(recordEventMock).not.toHaveBeenCalled()
  })

  it('returns ok:false with validation error on invalid payload (bad accountId)', async () => {
    const result = await callHandler({ accountId: 'not-a-number', uid: 42, folder: 'INBOX', response: 'ACCEPTED' })

    expect(result).toMatchObject({ ok: false, error: expect.any(String) })
    expect(resolveInvite).not.toHaveBeenCalled()
  })

  it('returns ok:false with validation error on invalid response enum', async () => {
    const result = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'MAYBE' })

    expect(result).toMatchObject({ ok: false, error: expect.any(String) })
    expect(resolveInvite).not.toHaveBeenCalled()
  })

  // §2.22 fix iter2A — codex-bg-review MEDIUM: RSVP only makes sense for
  // method=REQUEST. Renderer hides buttons but a tampered renderer / direct
  // IPC caller could still attempt; reject server-side as defense-in-depth.
  it('refuses to send RSVP for non-REQUEST invites (PUBLISH)', async () => {
    resolveInvite.mockResolvedValue(makeCalendarInvite({ method: 'PUBLISH' }))
    resolveFrom.mockResolvedValue({ email: 'bob@example.test' })

    const result = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })

    expect(result).toEqual({ ok: false, error: 'invite_not_actionable' })
    // Must not attempt to send anything
    expect(sendRsvp).not.toHaveBeenCalled()
    // No metric on rejected path
    expect(recordEventMock).not.toHaveBeenCalled()
    // Sentry capture for visibility (defense-in-depth signal)
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'InviteBridge.rsvp' }),
    )
  })

  it('refuses to send RSVP for METHOD:REPLY invites (RSVP-of-RSVP)', async () => {
    resolveInvite.mockResolvedValue(makeCalendarInvite({ method: 'REPLY' }))
    resolveFrom.mockResolvedValue({ email: 'bob@example.test' })

    const result = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })
    expect(result).toEqual({ ok: false, error: 'invite_not_actionable' })
    expect(sendRsvp).not.toHaveBeenCalled()
  })

  it('refuses to send RSVP for METHOD:OTHER (unknown iTIP method)', async () => {
    resolveInvite.mockResolvedValue(makeCalendarInvite({ method: 'OTHER' }))
    resolveFrom.mockResolvedValue({ email: 'bob@example.test' })

    const result = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })
    expect(result).toEqual({ ok: false, error: 'invite_not_actionable' })
    expect(sendRsvp).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// §2.22 fix iter2A — toPublicInvite + makeInviteCache (privacy boundary)
// ---------------------------------------------------------------------------

describe('toPublicInvite — strips main-only fields before IPC / cache', () => {
  it('drops rawIcs and description but keeps every other field', () => {
    const full: CalendarInvite = {
      uid: 'priv-uid@example.test',
      summary: 'Strategy meeting',
      dtstart: '2026-05-15T14:00:00Z',
      dtend: '2026-05-15T15:00:00Z',
      allDay: false,
      tzid: 'America/New_York',
      organizerEmail: 'alice@example.test',
      organizerName: 'Alice',
      location: 'Room 101',
      description: 'Sensitive notes about Q2 strategy',
      method: 'REQUEST',
      rawIcs: 'BEGIN:VCALENDAR\r\n... full payload ...\r\nEND:VCALENDAR',
    }
    const pub = toPublicInvite(full)
    // Privacy invariants — never cross IPC.
    expect(Object.prototype.hasOwnProperty.call(pub, 'rawIcs')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(pub, 'description')).toBe(false)
    // Other fields preserved.
    expect(pub.uid).toBe(full.uid)
    expect(pub.summary).toBe(full.summary)
    expect(pub.dtstart).toBe(full.dtstart)
    expect(pub.dtend).toBe(full.dtend)
    expect(pub.allDay).toBe(false)
    expect(pub.tzid).toBe('America/New_York')
    expect(pub.organizerEmail).toBe(full.organizerEmail)
    expect(pub.organizerName).toBe(full.organizerName)
    expect(pub.location).toBe(full.location)
    expect(pub.method).toBe(full.method)
  })

  it('preserves allDay=true and undefined tzid for floating dates', () => {
    const allDayInvite: CalendarInvite = {
      uid: 'allday-uid@example.test',
      summary: 'Conference',
      dtstart: '2026-05-15',
      allDay: true,
      organizerEmail: 'alice@example.test',
      method: 'REQUEST',
      rawIcs: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    }
    const pub = toPublicInvite(allDayInvite)
    expect(pub.allDay).toBe(true)
    expect(pub.tzid).toBeUndefined()
    expect(pub.dtstart).toBe('2026-05-15')
  })

  it('JSON.stringify of public DTO never contains rawIcs payload', () => {
    // Defensive coverage: even if someone forgets `toPublicInvite` and
    // serializes the full object, the test below proves the public DTO
    // produced by toPublicInvite is JSON-clean.
    const full = makeCalendarInvite({
      rawIcs: 'BEGIN:VCALENDAR\r\nSECRET-MARKER:do-not-leak\r\nEND:VCALENDAR',
      description: 'Internal-only notes',
    })
    const pubJson = JSON.stringify(toPublicInvite(full))
    expect(pubJson).not.toContain('SECRET-MARKER')
    expect(pubJson).not.toContain('Internal-only notes')
    // Sanity: a non-secret field still made it through.
    expect(pubJson).toContain(full.summary)
  })
})

describe('makeInviteCache — main-only LRU for full invites', () => {
  it('round-trips put/get for the same key', () => {
    const cache = makeInviteCache()
    const invite = makeCalendarInvite({ uid: 'cache-uid' })
    cache.put(1, 'INBOX', 42, invite)
    const hit = cache.get(1, 'INBOX', 42)
    expect(hit).toBeDefined()
    expect(hit!.uid).toBe('cache-uid')
    // Important: the cache returns the FULL invite (with rawIcs) — that's
    // the whole point. RSVP REPLY needs rawIcs to preserve organiser fields.
    expect(hit!.rawIcs).toBe(invite.rawIcs)
  })

  it('returns undefined on miss', () => {
    const cache = makeInviteCache()
    expect(cache.get(1, 'INBOX', 42)).toBeUndefined()
  })

  it('keys are isolated by accountId, folder and uid', () => {
    const cache = makeInviteCache()
    cache.put(1, 'INBOX', 42, makeCalendarInvite({ uid: 'a' }))
    cache.put(2, 'INBOX', 42, makeCalendarInvite({ uid: 'b' }))
    cache.put(1, 'Sent', 42, makeCalendarInvite({ uid: 'c' }))
    cache.put(1, 'INBOX', 43, makeCalendarInvite({ uid: 'd' }))
    expect(cache.get(1, 'INBOX', 42)!.uid).toBe('a')
    expect(cache.get(2, 'INBOX', 42)!.uid).toBe('b')
    expect(cache.get(1, 'Sent', 42)!.uid).toBe('c')
    expect(cache.get(1, 'INBOX', 43)!.uid).toBe('d')
  })

  it('skips put when invite is null (no entry created)', () => {
    const cache = makeInviteCache()
    cache.put(1, 'INBOX', 42, null)
    expect(cache.size()).toBe(0)
    expect(cache.get(1, 'INBOX', 42)).toBeUndefined()
  })

  it('overwrites existing entry on put with the same key', () => {
    const cache = makeInviteCache()
    cache.put(1, 'INBOX', 42, makeCalendarInvite({ summary: 'first' }))
    cache.put(1, 'INBOX', 42, makeCalendarInvite({ summary: 'second' }))
    expect(cache.get(1, 'INBOX', 42)!.summary).toBe('second')
    expect(cache.size()).toBe(1)
  })

  it('evicts oldest entries when cap is exceeded', () => {
    const cache = makeInviteCache(2)
    cache.put(1, 'INBOX', 1, makeCalendarInvite({ uid: 'oldest' }))
    cache.put(1, 'INBOX', 2, makeCalendarInvite({ uid: 'middle' }))
    cache.put(1, 'INBOX', 3, makeCalendarInvite({ uid: 'newest' }))
    // 'oldest' must have been evicted.
    expect(cache.get(1, 'INBOX', 1)).toBeUndefined()
    expect(cache.get(1, 'INBOX', 2)).toBeDefined()
    expect(cache.get(1, 'INBOX', 3)).toBeDefined()
    expect(cache.size()).toBe(2)
  })

  it('get bumps LRU recency (touched entry survives later eviction)', () => {
    const cache = makeInviteCache(2)
    cache.put(1, 'INBOX', 1, makeCalendarInvite({ uid: 'first' }))
    cache.put(1, 'INBOX', 2, makeCalendarInvite({ uid: 'second' }))
    // Touch first → it becomes most-recent.
    cache.get(1, 'INBOX', 1)
    // Insert third → least-recent (`second`) should be evicted, not `first`.
    cache.put(1, 'INBOX', 3, makeCalendarInvite({ uid: 'third' }))
    expect(cache.get(1, 'INBOX', 1)).toBeDefined()
    expect(cache.get(1, 'INBOX', 2)).toBeUndefined()
    expect(cache.get(1, 'INBOX', 3)).toBeDefined()
  })

  it('clear() drops every entry', () => {
    const cache = makeInviteCache()
    cache.put(1, 'INBOX', 1, makeCalendarInvite())
    cache.put(1, 'INBOX', 2, makeCalendarInvite())
    cache.clear()
    expect(cache.size()).toBe(0)
    expect(cache.get(1, 'INBOX', 1)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// §2.22 fix iter2A — type-level guard: CalendarInvitePublic shape
// ---------------------------------------------------------------------------

describe('CalendarInvitePublic — IPC-facing shape is privacy-clean', () => {
  it('does not have rawIcs or description in its declared keys (TS-level smoke)', () => {
    // This is mostly a type-level guarantee enforced by `toPublicInvite`
    // returning `CalendarInvitePublic`. The runtime smoke check below just
    // confirms the projection result has no surprise extra keys; the real
    // enforcement is the codex-bg-review path that checks IPC payload
    // shapes via grep.
    const pub: CalendarInvitePublic = toPublicInvite(makeCalendarInvite())
    const keys = Object.keys(pub).sort()
    expect(keys).not.toContain('rawIcs')
    expect(keys).not.toContain('description')
  })
})

// ---------------------------------------------------------------------------
// §2.22 gap coverage — parseCalendarPart edge cases
// ---------------------------------------------------------------------------

describe('parseCalendarPart — additional edge cases', () => {
  const FIXTURE_NO_DTEND = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:nodtend-uid@example.test',
    'DTSTAMP:20260501T100000Z',
    'DTSTART:20260512T140000Z',
    // No DTEND — valid per RFC 5545 (implies a point-in-time or all-day event)
    'SUMMARY:No end time meeting',
    'ORGANIZER:mailto:alice@example.test',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  const FIXTURE_ALLDAY = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:allday-uid@example.test',
    'DTSTAMP:20260501T100000Z',
    'DTSTART;VALUE=DATE:20260515',
    'SUMMARY:All-day event',
    'ORGANIZER;CN=Alice:mailto:alice@example.test',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  const FIXTURE_ORGANIZER_NO_CN = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:nocn-uid@example.test',
    'DTSTAMP:20260501T100000Z',
    'DTSTART:20260512T140000Z',
    'SUMMARY:Meeting without CN',
    'ORGANIZER:mailto:plain@example.test',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  const FIXTURE_RRULE = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:recurring-uid@example.test',
    'DTSTAMP:20260501T100000Z',
    'DTSTART:20260512T140000Z',
    'DTEND:20260512T150000Z',
    'SUMMARY:Weekly standup',
    'ORGANIZER;CN=Alice:mailto:alice@example.test',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  const FIXTURE_MULTI_VEVENT = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:first-uid@example.test',
    'DTSTAMP:20260501T100000Z',
    'DTSTART:20260512T140000Z',
    'SUMMARY:First event',
    'ORGANIZER;CN=Alice:mailto:alice@example.test',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:second-uid@example.test',
    'DTSTAMP:20260501T120000Z',
    'DTSTART:20260513T140000Z',
    'SUMMARY:Second event',
    'ORGANIZER;CN=Bob:mailto:bob@example.test',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('parses a VEVENT without DTEND — dtend is undefined, does not crash', () => {
    const invite = parseCalendarPart(FIXTURE_NO_DTEND)
    expect(invite).not.toBeNull()
    expect(invite!.uid).toBe('nodtend-uid@example.test')
    expect(invite!.dtend).toBeUndefined()
    expect(invite!.dtstart).toBeTruthy()
  })

  it('parses an all-day DTSTART (VALUE=DATE format) into floating YYYY-MM-DD with allDay=true', () => {
    // §2.22 fix iter2A — codex-bg-review HIGH: previously dtstart serialised
    // as `20260515` (or whatever ical.js stringifies), losing the all-day
    // semantics. Validate the new contract:
    //   - allDay=true on the parsed invite
    //   - dtstart is a floating `YYYY-MM-DD` string (no time/zone)
    const invite = parseCalendarPart(FIXTURE_ALLDAY)
    expect(invite).not.toBeNull()
    expect(invite!.uid).toBe('allday-uid@example.test')
    expect(invite!.allDay).toBe(true)
    // Floating-date format: `YYYY-MM-DD`, no time component.
    expect(invite!.dtstart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Specifically the date from the fixture.
    expect(invite!.dtstart).toBe('2026-05-15')
    // tzid must NOT be set for all-day events — they are zone-floating.
    expect(invite!.tzid).toBeUndefined()
  })

  it('encodes timed events as UTC ISO 8601 instants', () => {
    // §2.22 fix iter2A — timed events with explicit UTC suffix get encoded
    // to a JS-Date-friendly ISO 8601 instant (`...Z`) so the renderer can
    // `new Date(dtstart)` without losing the zone.
    const invite = parseCalendarPart(FIXTURE_REQUEST)!
    expect(invite.allDay).toBe(false)
    // RFC 5545 fixture has DTSTART:20260512T140000Z → 2026-05-12T14:00:00.000Z
    expect(invite.dtstart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    expect(new Date(invite.dtstart).toISOString()).toBe('2026-05-12T14:00:00.000Z')
  })

  it('preserves TZID and emits wall-clock string when no inline VTIMEZONE is present', () => {
    // §2.22 fix iter3A — codex-bg-review iter2 HIGH: Gmail-style minimal
    // invites send `DTSTART;TZID=America/New_York:20260515T140000` WITHOUT an
    // inline VTIMEZONE block. ical.js falls back to its `floating` zone,
    // which makes `toJSDate()` go through the host process TZ and produce a
    // wrong instant. New contract: when the zone is unresolvable, preserve
    // the wall-clock as `YYYY-MM-DDTHH:mm:ss` (no Z, no offset) and rely on
    // `tzid` for downstream rendering.
    const FIXTURE_TZID_NO_VTZ = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:tzid-no-vtz@example.test',
      'DTSTAMP:20260501T100000Z',
      'DTSTART;TZID=America/New_York:20260515T140000',
      'DTEND;TZID=America/New_York:20260515T150000',
      'SUMMARY:NY meeting (no VTIMEZONE)',
      'ORGANIZER;CN=Alice:mailto:alice@example.test',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const invite = parseCalendarPart(FIXTURE_TZID_NO_VTZ)
    expect(invite).not.toBeNull()
    expect(invite!.allDay).toBe(false)
    expect(invite!.tzid).toBe('America/New_York')
    // Wall-clock encoding: zone-less ISO local form, NO trailing Z, no offset.
    expect(invite!.dtstart).toBe('2026-05-15T14:00:00')
    expect(invite!.dtend).toBe('2026-05-15T15:00:00')
    // Critical regression guard: must NOT have been silently shifted through
    // the host process TZ. The presence of `Z` would mean encodeIcalDate
    // called toJSDate() and produced an incorrect instant.
    expect(invite!.dtstart.endsWith('Z')).toBe(false)
  })

  it('encodes timed events as UTC ISO when VTIMEZONE resolves the zone', () => {
    // §2.22 fix iter3A — when an inline VTIMEZONE matches the TZID, ical.js
    // resolves the zone correctly and toJSDate() produces a true UTC instant.
    // EDT in May is UTC-4, so 14:00 NY = 18:00Z.
    const FIXTURE_TZID_WITH_VTZ = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'METHOD:REQUEST',
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:DAYLIGHT',
      'DTSTART:20070311T020000',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0400',
      'TZNAME:EDT',
      'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'DTSTART:20071104T020000',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'TZNAME:EST',
      'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:tzid-with-vtz@example.test',
      'DTSTAMP:20260501T100000Z',
      'DTSTART;TZID=America/New_York:20260515T140000',
      'DTEND;TZID=America/New_York:20260515T150000',
      'SUMMARY:NY meeting (with VTIMEZONE)',
      'ORGANIZER;CN=Alice:mailto:alice@example.test',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const invite = parseCalendarPart(FIXTURE_TZID_WITH_VTZ)
    expect(invite).not.toBeNull()
    expect(invite!.allDay).toBe(false)
    expect(invite!.tzid).toBe('America/New_York')
    // Resolved zone → UTC ISO instant.
    expect(invite!.dtstart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    expect(new Date(invite!.dtstart).toISOString()).toBe('2026-05-15T18:00:00.000Z')
    expect(invite!.dtend).toBeDefined()
    expect(new Date(invite!.dtend!).toISOString()).toBe('2026-05-15T19:00:00.000Z')
  })

  it('encodes UTC-suffixed DTSTART as UTC ISO with no tzid', () => {
    // §2.22 fix iter3A — `DTSTART:20260515T180000Z` resolves to ICAL.Timezone.utcTimezone;
    // toJSDate() gives the correct instant and there's no TZID to preserve.
    const FIXTURE_UTC = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:utc-uid@example.test',
      'DTSTAMP:20260501T100000Z',
      'DTSTART:20260515T180000Z',
      'DTEND:20260515T190000Z',
      'SUMMARY:UTC meeting',
      'ORGANIZER;CN=Alice:mailto:alice@example.test',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const invite = parseCalendarPart(FIXTURE_UTC)
    expect(invite).not.toBeNull()
    expect(invite!.allDay).toBe(false)
    expect(invite!.tzid).toBeUndefined()
    expect(new Date(invite!.dtstart).toISOString()).toBe('2026-05-15T18:00:00.000Z')
    expect(new Date(invite!.dtend!).toISOString()).toBe('2026-05-15T19:00:00.000Z')
  })

  it('parses ORGANIZER without CN parameter — organizerName is undefined', () => {
    const invite = parseCalendarPart(FIXTURE_ORGANIZER_NO_CN)
    expect(invite).not.toBeNull()
    expect(invite!.organizerEmail).toBe('plain@example.test')
    expect(invite!.organizerName).toBeUndefined()
  })

  it('handles RRULE (recurring event) without crashing — parses first DTSTART', () => {
    const invite = parseCalendarPart(FIXTURE_RRULE)
    expect(invite).not.toBeNull()
    expect(invite!.uid).toBe('recurring-uid@example.test')
    expect(invite!.summary).toBe('Weekly standup')
    // RRULE itself is ignored in PR1 (out of scope), but the event must parse
  })

  it('with multiple VEVENTs returns only the first one', () => {
    const invite = parseCalendarPart(FIXTURE_MULTI_VEVENT)
    expect(invite).not.toBeNull()
    // ical.js getFirstSubcomponent('vevent') → first wins
    expect(invite!.uid).toBe('first-uid@example.test')
    expect(invite!.summary).toBe('First event')
  })
})

// ---------------------------------------------------------------------------
// §2.22 gap coverage — buildRsvpReply MIME structure
// ---------------------------------------------------------------------------

describe('buildRsvpReply — MIME structure assertions', () => {
  const FIXTURE_WITH_LOCATION = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Structure Test//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:mime-test-uid@example.test',
    'DTSTAMP:20260501T100000Z',
    'DTSTART:20260612T100000Z',
    'DTEND:20260612T110000Z',
    'SUMMARY:MIME Structure Test',
    'LOCATION:Virtual',
    'ORGANIZER;CN=Org:mailto:org@example.test',
    'ATTENDEE;CN=Att;PARTSTAT=NEEDS-ACTION:mailto:att@example.test',
    'SEQUENCE:2',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('icsBody contains METHOD:REPLY (not REQUEST)', () => {
    const invite = parseCalendarPart(FIXTURE_WITH_LOCATION)!
    const { icsBody } = buildRsvpReply(invite, 'ACCEPTED', 'att@example.test', 'Att')
    expect(icsBody).toContain('METHOD:REPLY')
    expect(icsBody).not.toMatch(/METHOD:REQUEST/)
  })

  it('icsBody contains exactly one ATTENDEE (the responder)', () => {
    const invite = parseCalendarPart(FIXTURE_WITH_LOCATION)!
    const { icsBody } = buildRsvpReply(invite, 'TENTATIVE', 'att@example.test', 'Att')
    const attendees = icsBody.match(/^ATTENDEE/gm) ?? []
    expect(attendees.length).toBe(1)
    expect(icsBody).toMatch(/PARTSTAT=TENTATIVE/)
    expect(icsBody).toContain('att@example.test')
  })

  it('icsBody preserves original UID and SEQUENCE', () => {
    const invite = parseCalendarPart(FIXTURE_WITH_LOCATION)!
    const { icsBody } = buildRsvpReply(invite, 'DECLINED', 'att@example.test')
    expect(icsBody).toContain('UID:mime-test-uid@example.test')
    expect(icsBody).toMatch(/SEQUENCE:2/)
  })

  it('text body uses "has declined" verb for DECLINED response', () => {
    const invite = parseCalendarPart(FIXTURE_WITH_LOCATION)!
    const { text } = buildRsvpReply(invite, 'DECLINED', 'att@example.test', 'Att Person')
    expect(text).toContain('has declined')
    expect(text).toContain('MIME Structure Test')
  })

  it('text body uses "has tentatively accepted" verb for TENTATIVE response', () => {
    const invite = parseCalendarPart(FIXTURE_WITH_LOCATION)!
    const { text } = buildRsvpReply(invite, 'TENTATIVE', 'att@example.test', 'Att Person')
    expect(text).toContain('has tentatively accepted')
  })

  it('returned "to" address is the organizer email', () => {
    const invite = parseCalendarPart(FIXTURE_WITH_LOCATION)!
    const { to } = buildRsvpReply(invite, 'ACCEPTED', 'att@example.test')
    expect(to).toBe('org@example.test')
  })
})

// ---------------------------------------------------------------------------
// §2.22 fix iter4 — codex-security-review findings
// ---------------------------------------------------------------------------

describe('parseCalendarPart — ORGANIZER address validation (security HIGH)', () => {
  // Codex iter1 HIGH: nodemailer's MailComposer parses `to:` as an
  // RFC 5322 address-list / group syntax. A malicious organizer like
  // `victim, attacker` or `Group:a,b;` would otherwise leak the user's
  // RSVP envelope to attacker recipients.
  const baseFixture = (organizerLine: string) => [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:org-validation@example.test',
    'DTSTAMP:20260501T100000Z',
    'DTSTART:20260601T140000Z',
    'SUMMARY:test',
    organizerLine,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('accepts a single canonical addr-spec and lowercases it', () => {
    const invite = parseCalendarPart(baseFixture('ORGANIZER:mailto:Alice@Example.test'))
    expect(invite).not.toBeNull()
    expect(invite!.organizerEmail).toBe('alice@example.test')
  })

  it('rejects multiple comma-separated addresses (recipient injection)', () => {
    // ical.js value-parser may serialize this in various ways; we test the
    // worst-case where a stray comma slips through into the post-mailto value.
    const invite = parseCalendarPart(baseFixture(
      'ORGANIZER:mailto:victim@example.test,attacker@evil.test',
    ))
    expect(invite).toBeNull()
  })

  it('rejects RFC 5322 group syntax `Group:a@x,b@y;`', () => {
    const invite = parseCalendarPart(baseFixture(
      'ORGANIZER:Friends:victim@example.test,attacker@evil.test;',
    ))
    expect(invite).toBeNull()
  })

  it('rejects organizer with embedded angle-bracket / quote (escape primitive)', () => {
    const invite = parseCalendarPart(baseFixture('ORGANIZER:mailto:victim@example.test>'))
    expect(invite).toBeNull()
  })

  it('rejects empty mailto', () => {
    const invite = parseCalendarPart(baseFixture('ORGANIZER:mailto:'))
    expect(invite).toBeNull()
  })

  it('rejects an organizer whose local-part has an unquoted second @', () => {
    // Belt-and-suspenders: the addressparser may pick up `a@b@c`, the strict
    // local@domain regex must still reject it.
    const invite = parseCalendarPart(baseFixture('ORGANIZER:mailto:a@b@evil.test'))
    expect(invite).toBeNull()
  })

  it('rejects organizer whose value contains TLD-less domain', () => {
    const invite = parseCalendarPart(baseFixture('ORGANIZER:mailto:victim@localhost'))
    expect(invite).toBeNull()
  })
})

describe('buildRsvpReply — REPLY relay-attack hardening (security HIGH)', () => {
  // Codex iter1 HIGH: previously buildRsvpReply cloned the entire VCALENDAR
  // and only swapped METHOD/ATTENDEE/DTSTAMP, reflecting back the
  // attacker-chosen DESCRIPTION / LOCATION / URL / ATTACH / VALARM / X-*
  // properties. The user's account became a relay for arbitrary calendar
  // payloads. The fix rebuilds the REPLY from a strict allowlist.
  const FIXTURE_HOSTILE = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Hostile Sender//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'X-EVIL-VENDOR:tracking-pixel-id-12345',
    'BEGIN:VEVENT',
    'UID:hostile-uid@example.test',
    'DTSTAMP:20260501T100000Z',
    'DTSTART:20260612T100000Z',
    'DTEND:20260612T110000Z',
    'SEQUENCE:5',
    'SUMMARY:Innocent looking title',
    'LOCATION:https://attacker.example/click-me',
    'DESCRIPTION:Phishing payload — Click https://attacker.example to confirm',
    'URL:https://attacker.example/track',
    'ATTACH:https://attacker.example/malware.exe',
    'X-MICROSOFT-CDO-INSTTYPE:0',
    'X-CUSTOM-PHISHING-HEADER:do-not-reflect',
    'ORGANIZER;CN=Spoofed Org:mailto:victim@example.test',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    'DESCRIPTION:Reminder — visit attacker.example',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('omits hostile DESCRIPTION / LOCATION / URL / ATTACH from the REPLY', () => {
    const invite = parseCalendarPart(FIXTURE_HOSTILE)!
    const { icsBody } = buildRsvpReply(invite, 'ACCEPTED', 'me@example.test', 'Me')
    expect(icsBody).not.toContain('Phishing payload')
    expect(icsBody).not.toContain('attacker.example')
    expect(icsBody).not.toMatch(/^DESCRIPTION:/m)
    expect(icsBody).not.toMatch(/^LOCATION:/m)
    expect(icsBody).not.toMatch(/^URL:/m)
    expect(icsBody).not.toMatch(/^ATTACH/m)
  })

  it('omits VALARM and any X-* extensions from the REPLY', () => {
    const invite = parseCalendarPart(FIXTURE_HOSTILE)!
    const { icsBody } = buildRsvpReply(invite, 'DECLINED', 'me@example.test')
    expect(icsBody).not.toContain('BEGIN:VALARM')
    expect(icsBody).not.toContain('X-MICROSOFT-CDO-INSTTYPE')
    expect(icsBody).not.toContain('X-CUSTOM-PHISHING-HEADER')
    expect(icsBody).not.toContain('X-EVIL-VENDOR')
  })

  it('keeps only the RFC 5546 §3.2.3 mandatory fields plus PRODID/VERSION/METHOD', () => {
    const invite = parseCalendarPart(FIXTURE_HOSTILE)!
    const { icsBody } = buildRsvpReply(invite, 'TENTATIVE', 'me@example.test')
    // VCALENDAR-level properties:
    expect(icsBody).toContain('VERSION:2.0')
    expect(icsBody).toContain('PRODID:-//MailCopilot//iTIP REPLY//EN')
    expect(icsBody).toContain('METHOD:REPLY')
    // VEVENT — UID, SEQUENCE, DTSTAMP, DTSTART, ORGANIZER, ATTENDEE.
    expect(icsBody).toContain('UID:hostile-uid@example.test')
    expect(icsBody).toMatch(/SEQUENCE:5/)
    expect(icsBody).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/m)
    expect(icsBody).toMatch(/^DTSTART:/m)
    expect(icsBody).toMatch(/^ORGANIZER/m)
    expect(icsBody).toMatch(/^ATTENDEE/m)
    // Single ATTENDEE — the responder, no inherited attendee list.
    const attendees = icsBody.match(/^ATTENDEE/gm) ?? []
    expect(attendees.length).toBe(1)
  })

  it('subject and text body still carry SUMMARY (human-readable, not reflected ics)', () => {
    // SUMMARY is not in the structured ics REPLY, but it does appear in the
    // human-readable Subject and plain-text body — the subject IS the user's
    // own response and is bounded by them clicking the button, so it is not
    // a relay vector in the same way that arbitrary structured ics props are.
    const invite = parseCalendarPart(FIXTURE_HOSTILE)!
    const { subject, text } = buildRsvpReply(invite, 'ACCEPTED', 'me@example.test')
    expect(subject).toContain('Innocent looking title')
    expect(text).toContain('Innocent looking title')
  })

  it('handles malformed rawIcs gracefully — does not throw', () => {
    // If the original rawIcs cannot be re-parsed in buildRsvpReply, the
    // fallback path uses the public DTO's dtstart and synthesizes a fresh
    // ORGANIZER. Happens almost never in practice but must not crash.
    const invite = parseCalendarPart(FIXTURE_HOSTILE)!
    const corrupt = { ...invite, rawIcs: 'GARBAGE NOT ICS' }
    expect(() => buildRsvpReply(corrupt, 'ACCEPTED', 'me@example.test')).not.toThrow()
  })
})

describe('mail:rsvpInvite — Sentry payload sanitisation (security BLOCKER)', () => {
  let resolveInvite: ReturnType<typeof vi.fn>
  let resolveFrom: ReturnType<typeof vi.fn>
  let sendRsvp: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ipcRegistry.clear()
    recordEventMock.mockReset()
    captureExceptionMock.mockReset()
    resolveInvite = vi.fn()
    resolveFrom = vi.fn()
    sendRsvp = vi.fn()
    registerInviteHandlers({
      resolveInvite: resolveInvite as unknown as Parameters<typeof registerInviteHandlers>[0]['resolveInvite'],
      resolveFrom: resolveFrom as unknown as Parameters<typeof registerInviteHandlers>[0]['resolveFrom'],
      sendRsvp: sendRsvp as unknown as Parameters<typeof registerInviteHandlers>[0]['sendRsvp'],
    })
  })

  async function callHandler(payload: unknown) {
    const handler = ipcRegistry.get('mail:rsvpInvite')
    if (!handler) throw new Error('mail:rsvpInvite handler was not registered')
    return handler(null, payload)
  }

  it('Sentry payload uses a synthetic Error, not the raw error message (no PII leak)', async () => {
    // Codex iter1 BLOCKER: nodemailer / SMTP / Outlook Graph errors typically
    // embed recipient addresses, server greeting strings and subject text in
    // their `.message`. We must never forward the raw error to Sentry.
    resolveInvite.mockResolvedValue({
      uid: 'pii@example.test',
      summary: 'Confidential merger discussion',
      dtstart: '20260601T140000Z',
      allDay: false,
      organizerEmail: 'ceo@example.test',
      method: 'REQUEST',
      rawIcs: FIXTURE_REQUEST,
    })
    resolveFrom.mockResolvedValue({ email: 'me@example.test' })
    const piiError = new Error(
      "554 5.7.1 <secret-recipient@partner.test>: Recipient address rejected: " +
      "Subject 'Confidential merger discussion' contains banned phrase",
    )
    sendRsvp.mockRejectedValue(piiError)

    await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })

    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    const [capturedError, capturedContext] = captureExceptionMock.mock.calls[0] as [Error, Record<string, unknown>]

    // The captured error MUST be synthetic. Its message must NOT include the
    // raw recipient / subject / server greeting from the underlying error.
    expect(capturedError.message).toMatch(/^invite_rsvp_failed:/)
    expect(capturedError.message).not.toContain('secret-recipient@partner.test')
    expect(capturedError.message).not.toContain('Confidential merger')
    expect(capturedError.message).not.toContain('554')

    // The context must carry only aggregate fields. Specifically NOT the raw
    // error message and NOT any field whose value matches the original PII.
    const contextJson = JSON.stringify(capturedContext)
    expect(contextJson).not.toContain('secret-recipient@partner.test')
    expect(contextJson).not.toContain('Confidential merger')
    // Source tag must still flow through for Sentry filtering.
    expect(capturedContext).toMatchObject({ source: 'InviteBridge.rsvp' })
    // error_name aggregate field present.
    expect(capturedContext).toMatchObject({ error_name: 'Error' })
  })

  it('forwards SMTP responseCode as smtp_response_code if available, but not as raw message', async () => {
    resolveInvite.mockResolvedValue({
      uid: 'r1@example.test',
      summary: 'meeting',
      dtstart: '20260601T140000Z',
      allDay: false,
      organizerEmail: 'org@example.test',
      method: 'REQUEST',
      rawIcs: FIXTURE_REQUEST,
    })
    resolveFrom.mockResolvedValue({ email: 'me@example.test' })
    const smtpErr = Object.assign(new Error('connection lost mid-DATA — recipient bob@x.test bounced'), {
      responseCode: 421,
      code: 'ECONNRESET',
    })
    sendRsvp.mockRejectedValue(smtpErr)

    await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })

    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    const [, capturedContext] = captureExceptionMock.mock.calls[0] as [Error, Record<string, unknown>]
    // Aggregate fields propagate.
    expect(capturedContext).toMatchObject({
      source: 'InviteBridge.rsvp',
      error_name: 'Error',
      smtp_response_code: 421,
      error_code: 'ECONNRESET',
    })
    // But the raw message must not have leaked into any field.
    expect(JSON.stringify(capturedContext)).not.toContain('bob@x.test')
  })
})

describe('mail:rsvpInvite — inflight duplicate guard (security LOW)', () => {
  let resolveInvite: ReturnType<typeof vi.fn>
  let resolveFrom: ReturnType<typeof vi.fn>
  let sendRsvp: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ipcRegistry.clear()
    recordEventMock.mockReset()
    captureExceptionMock.mockReset()
    resolveInvite = vi.fn()
    resolveFrom = vi.fn()
    sendRsvp = vi.fn()
    registerInviteHandlers({
      resolveInvite: resolveInvite as unknown as Parameters<typeof registerInviteHandlers>[0]['resolveInvite'],
      resolveFrom: resolveFrom as unknown as Parameters<typeof registerInviteHandlers>[0]['resolveFrom'],
      sendRsvp: sendRsvp as unknown as Parameters<typeof registerInviteHandlers>[0]['sendRsvp'],
    })
  })

  async function callHandler(payload: unknown) {
    const handler = ipcRegistry.get('mail:rsvpInvite')
    if (!handler) throw new Error('mail:rsvpInvite handler was not registered')
    return handler(null, payload)
  }

  it('rejects a duplicate concurrent RSVP for the same (account, folder, uid, response)', async () => {
    resolveInvite.mockResolvedValue({
      uid: 'dup@example.test',
      summary: 'meet',
      dtstart: '20260601T140000Z',
      allDay: false,
      organizerEmail: 'org@example.test',
      method: 'REQUEST',
      rawIcs: FIXTURE_REQUEST,
    })
    resolveFrom.mockResolvedValue({ email: 'me@example.test' })

    // Pause the SMTP send so we can fire a second concurrent call.
    let resolveSend: (val: { messageId: string }) => void = () => { /* assigned below */ }
    sendRsvp.mockImplementationOnce(() => new Promise(resolve => { resolveSend = resolve }))

    const first = callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })
    // Second call lands while the first is still in flight.
    const second = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })

    expect(second).toEqual({ ok: false, error: 'rsvp_in_progress' })
    // sendRsvp must have been entered exactly once — the second call short-
    // circuited before reaching the SMTP layer.
    expect(sendRsvp).toHaveBeenCalledTimes(1)

    // Release the first, observe success.
    resolveSend({ messageId: '<ok>' })
    await expect(first).resolves.toEqual({ ok: true, messageId: '<ok>' })
  })

  it('releases the inflight slot after success — next call same key proceeds', async () => {
    resolveInvite.mockResolvedValue({
      uid: 'release@example.test',
      summary: 'meet',
      dtstart: '20260601T140000Z',
      allDay: false,
      organizerEmail: 'org@example.test',
      method: 'REQUEST',
      rawIcs: FIXTURE_REQUEST,
    })
    resolveFrom.mockResolvedValue({ email: 'me@example.test' })
    sendRsvp.mockResolvedValue({ messageId: '<ok-1>' })

    const first = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })
    expect(first).toEqual({ ok: true, messageId: '<ok-1>' })

    // After the first finishes, a second call with the same key must proceed
    // (i.e. the inflight slot was released — this is the "guard, not cooldown"
    // semantic).
    sendRsvp.mockResolvedValueOnce({ messageId: '<ok-2>' })
    const second = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })
    expect(second).toEqual({ ok: true, messageId: '<ok-2>' })
  })

  it('releases the inflight slot after failure — user can retry', async () => {
    resolveInvite.mockResolvedValue({
      uid: 'retry@example.test',
      summary: 'meet',
      dtstart: '20260601T140000Z',
      allDay: false,
      organizerEmail: 'org@example.test',
      method: 'REQUEST',
      rawIcs: FIXTURE_REQUEST,
    })
    resolveFrom.mockResolvedValue({ email: 'me@example.test' })
    sendRsvp.mockRejectedValueOnce(new Error('transient SMTP'))

    const first = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' }) as { ok: boolean }
    expect(first.ok).toBe(false)

    // Slot must be released after error so the user can retry.
    sendRsvp.mockResolvedValueOnce({ messageId: '<ok-after-retry>' })
    const second = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })
    expect(second).toEqual({ ok: true, messageId: '<ok-after-retry>' })
  })

  it('different response values for the same uid use independent inflight slots', async () => {
    // ACCEPTED in flight does not block DECLINED — they are different tuples.
    resolveInvite.mockResolvedValue({
      uid: 'indep@example.test',
      summary: 'meet',
      dtstart: '20260601T140000Z',
      allDay: false,
      organizerEmail: 'org@example.test',
      method: 'REQUEST',
      rawIcs: FIXTURE_REQUEST,
    })
    resolveFrom.mockResolvedValue({ email: 'me@example.test' })

    let resolveAccept: (val: { messageId: string }) => void = () => { /* assigned below */ }
    sendRsvp.mockImplementationOnce(() => new Promise(resolve => { resolveAccept = resolve }))
    sendRsvp.mockImplementationOnce(() => Promise.resolve({ messageId: '<dec-ok>' }))

    const acceptInFlight = callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'ACCEPTED' })
    const decline = await callHandler({ accountId: 1, uid: 42, folder: 'INBOX', response: 'DECLINED' })

    // DECLINED proceeded even though ACCEPTED is still in flight.
    expect(decline).toEqual({ ok: true, messageId: '<dec-ok>' })
    resolveAccept({ messageId: '<acc-ok>' })
    await expect(acceptInFlight).resolves.toEqual({ ok: true, messageId: '<acc-ok>' })
  })
})
