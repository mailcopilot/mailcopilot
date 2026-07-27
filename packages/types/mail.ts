export type MailSummary = {
  accountId: number
  folder: string
  uid: number
  /** Sender name for display (if available), otherwise email */
  from: string
  /** Sender email (for stable color/search/filters). */
  fromAddr?: string
  /** Cached sender name (if present in the From header). */
  fromName?: string
  /** Raw recipients (To) for the to: operator and address book. */
  toAddr?: string
  subject: string
  date: string
  unread: boolean
  flagged: boolean
  hasAttachments?: boolean
  /** Space-separated attachment filenames for search. */
  attachmentFilenames?: string
  /** Whether the message is pinned to the top of the list. */
  pinned?: boolean
  /** RFC822 Message-ID (for Conversation View). */
  messageId?: string
  /** RFC822 In-Reply-To (for Conversation View). */
  inReplyTo?: string
  /** RFC822 References (for Conversation View). */
  references?: string
  /** FTS5 snippet showing the matching context (populated in search results). */
  matchSnippet?: string | null
  /**
   * §2.22 Wave A: true when the message contains a `text/calendar` (or
   * `application/ics`) MIME part. Optional and forward-looking: the field is
   * declared on MailSummary so the mail list can show a calendar-invite glyph
   * once header sync starts populating it. PR1 leaves this `undefined` for
   * existing rows — populating it during header sync requires changes to
   * `packages/net/imap.ts` (BODYSTRUCTURE walk), tracked as a follow-up.
   * The renderer should treat `undefined` as "unknown / not an invite" and
   * fall back to the per-message `MessageDetails.calendarInvite` once the
   * body is opened.
   */
  hasCalendarInvite?: boolean
}

export type MailAddress = {
  name?: string
  address?: string
}

export type MessageEnvelope = {
  date?: string
  subject?: string
  messageId?: string
  inReplyTo?: string
  references?: string
  from?: MailAddress[]
  replyTo?: MailAddress[]
  to?: MailAddress[]
  cc?: MailAddress[]
  bcc?: MailAddress[]
}

export type AttachmentMeta = {
  part: string
  filename?: string
  contentType?: string
  size?: number
  disposition?: string
  cid?: string
}

export type MessageDetails = {
  uid: number
  envelope?: MessageEnvelope
  flags?: string[]
  internalDate?: string
  /** RFC 2369: List-Unsubscribe links (mailto:/https:) */
  listUnsubscribe?: string[]
  /** RFC 8058: one-click marker, usually "List-Unsubscribe=One-Click" */
  listUnsubscribePost?: string
  html?: string
  text?: string
  attachments?: AttachmentMeta[]
  /** MailCopilot draft id (if the message is a draft saved by MailCopilot) */
  draftId?: string
  /** Set when message was loaded from cached headers because IMAP was unavailable */
  offlineFallback?: boolean
  /**
   * §2.22 Wave A: parsed iTIP / iCalendar invite extracted from a `text/calendar`
   * MIME part, when present. Populated by the main process after the body is
   * fetched (or after the on-disk EML is parsed) — the parsing itself lives in
   * `electron/services/inviteBridge.ts` so `packages/net` does not depend on
   * ical.js. The renderer uses this object to render an inline RSVP card and
   * to send the response via the `mail:rsvpInvite` IPC.
   *
   * §2.22 fix iter2A: this is the *public* DTO (no `rawIcs`, no `description`).
   * The full payload — including `rawIcs` required to mint a conforming RFC
   * 5546 REPLY — lives only in main process memory (see
   * `inviteBridge.makeInviteCache()`), so the SQLite `message_details_cache`
   * row, the in-memory LRU JSON, and every IPC envelope crossing to the
   * renderer carry the slimmer `CalendarInvitePublic` shape. Privacy footprint:
   * raw VCALENDAR text (DESCRIPTION, ATTENDEE list, X-* extensions) never
   * touches disk or worker layers.
   */
  calendarInvite?: CalendarInvitePublic
  /**
   * §2.22 Wave A — internal handoff between `packages/net` (which extracts the
   * raw `text/calendar` MIME part) and the main process (which parses it via
   * ical.js into `calendarInvite`). Strictly transient: `electron/main.ts`
   * strips this field before caching/returning to the renderer, so the raw
   * ics never crosses the IPC boundary. Declared on the shared type so the
   * net-layer return value typechecks without leaking ical.js types into the
   * net package.
   */
  calendarInviteRaw?: string
}

/**
 * §2.22 Wave A — RFC 5546 (iTIP) participation status. Limited to the three
 * states the RSVP UI surfaces; the protocol also defines `NEEDS-ACTION`,
 * `DELEGATED`, `COMPLETED`, etc., but those are not user-selectable here.
 */
export type RsvpMethod = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'

/**
 * §2.22 Wave A — parsed iCalendar (RFC 5545) VEVENT extracted from an inbound
 * `text/calendar` MIME part. Renderer-facing DTO — every property in this shape
 * is what the InviteCard / `mail:rsvpInvite` IPC client can rely on.
 *
 * §2.22 fix iter2A — privacy boundary: this DTO deliberately does NOT carry
 * the raw ics payload (`rawIcs`) or the free-form `DESCRIPTION` text. The full
 * VCALENDAR (including ATTENDEE list, X-* extensions, DESCRIPTION, etc.) never
 * crosses IPC and is never persisted to SQLite — it lives only in main process
 * memory keyed by `(accountId, folder, uid)` (see `inviteBridge.makeInviteCache`)
 * for the lifetime of the open mail window, with on-disk EML / IMAP re-fetch
 * as fallback when the user clicks RSVP after a restart.
 */
export interface CalendarInvitePublic {
  /** VEVENT UID — stable identifier used to match the RSVP back to the event. */
  uid: string
  /** SUMMARY (event title). Falls back to '(no title)' if missing. */
  summary: string
  /**
   * Start of the event.
   * - For all-day events (`allDay: true`): floating-date format `YYYY-MM-DD`
   *   (no time, no zone). RFC 5545 calls this `VALUE=DATE`.
   * - For timed events: ISO 8601 instant in UTC (e.g. `2026-05-15T14:00:00Z`).
   *   The original timezone (if specified via `TZID`) is preserved separately
   *   in {@link tzid} so the renderer can label it; the timestamp itself is
   *   already UTC-normalised so `new Date(dtstart)` produces a correct point
   *   in time regardless of the viewer's locale.
   */
  dtstart: string
  /** End of the event, same encoding rules as {@link dtstart}. Optional. */
  dtend?: string
  /**
   * §2.22 fix iter2A — true when the original VEVENT used `VALUE=DATE`
   * (all-day event). The renderer must format such events without a time
   * component and treat the date as floating (display as-is in every TZ).
   */
  allDay: boolean
  /**
   * §2.22 fix iter2A — IANA timezone identifier (e.g. `America/New_York`)
   * extracted from the original `DTSTART;TZID=...` parameter, when present.
   * Undefined for UTC events, all-day events, or events with no zone hint.
   * Renderer uses this to annotate the displayed time (e.g. "14:00 NY time")
   * without relying on the viewer's local zone for interpretation.
   */
  tzid?: string
  /** ORGANIZER mailto address — required for sending the RSVP reply. */
  organizerEmail: string
  /** ORGANIZER CN parameter (display name), when present. */
  organizerName?: string
  /** LOCATION property, when present. */
  location?: string
  /** VCALENDAR METHOD. `OTHER` covers anything outside the standard iTIP set. */
  method: 'REQUEST' | 'CANCEL' | 'REPLY' | 'PUBLISH' | 'OTHER'
}

/**
 * §2.22 fix iter2A — main-process-only invite shape that carries the full
 * VCALENDAR payload. NEVER returned across IPC, NEVER persisted to SQLite.
 *
 * Used by:
 *   - `inviteBridge.parseCalendarPart()` — produces this shape from raw ics;
 *   - `inviteBridge.makeInviteCache()` — keeps the latest invite per
 *     `(accountId, folder, uid)` in a bounded LRU so RSVP clicks can rebuild
 *     a conforming METHOD:REPLY VCALENDAR without re-fetching from IMAP;
 *   - `inviteBridge.buildRsvpReply()` — needs `rawIcs` to preserve the
 *     organiser's UID / SEQUENCE / TZID / X-* extensions per RFC 5546 §3.2.3.
 *
 * `description` is kept here (it occasionally appears in the raw ics that
 * MailComposer rebuilds for the REPLY) but never makes it to the public DTO.
 */
export interface CalendarInvite extends CalendarInvitePublic {
  /** DESCRIPTION property; main-only, intentionally absent from the public DTO. */
  description?: string
  /** Original ics payload — required to mint a conforming METHOD:REPLY response. */
  rawIcs: string
}

/** Per-message result of an auto-unsubscribe attempt */
export type UnsubscribeAttemptResult = {
  ref: { accountId: number; folder: string; uid: number }
  /** Method used or attempted */
  method: 'rfc8058_post' | 'http_get' | 'browser' | 'none'
  /** Whether unsubscribe was handled automatically (no browser) */
  auto: boolean
  ok: boolean
  httpStatus?: number
  detail: string
}

export type ComposeAttachment = {
  filename: string
  contentBase64: string
  contentType?: string
}

/**
 * Product-telemetry hint for compose.opened. Captures the UX path the user
 * took to get into the compose window. Must be a low-cardinality enum — see
 * DOMAINS.compose_source in electron/metricsSchema.ts.
 */
export type ComposeSource = 'new' | 'reply' | 'reply_all' | 'forward' | 'mailto' | 'template' | 'ai_chip' | 'draft'

export type ComposeInit = {
  draftId?: string
  from?: string
  to?: string
  cc?: string
  bcc?: string
  subject?: string
  text?: string
  html?: string
  attachments?: ComposeAttachment[]
  /** Original email reference for Send & Archive (reply only) */
  replyRef?: { accountId: number; folder: string; uid: number }
  /** Original recipients for misdirection check (reply only) */
  originalRecipients?: string[]
  /** Telemetry: where the user came from (reply/forward/template/mailto/...). */
  source?: ComposeSource
  /**
   * 2.3-B: identity used when the draft/queued-send was authored. Preserved
   * through the queue round-trip so editing a cancelled scheduled send keeps
   * the user's original From alias instead of silently falling back to the
   * account default. Compose honours this id on mount when it matches one of
   * the account's `identities[]`; otherwise it falls back to the normal
   * reply-match / default-identity pick.
   */
  identityId?: string
}
