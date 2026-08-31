// Type-only, therefore fully erased at compile time: this is the one edge
// between `mail.ts` and the barrel that re-exports it, and an erased import
// cannot become a runtime cycle. `TranslateLanguageCode` is declared in
// `index.ts` next to the rest of the §3.3 B6 contract and is deliberately not
// duplicated here.
import type { TranslateLanguageCode } from './index'

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

/**
 * §2.145 — evidence that a parse cap shaped this result, and which one.
 *
 * Present only when a cap actually tripped: an ordinary message carries no
 * `parseCap` at all, so "absent" is the third and by far the commonest state
 * and no consumer has to reason about a "none" kind.
 *
 * The two kinds are NOT degrees of the same thing and must not be rendered as
 * such:
 *
 *  - `'hard'` — the raw RFC822 message was too large to hand to the MIME parser
 *    at all (`MAX_EML_PARSE_BYTES`). Nothing was decoded: `html`, `text` and
 *    `attachments` are absent, and the envelope carries only what the header
 *    block gave up. There is no way to see more, by design — `canShowFull` is
 *    never set on this kind. See packages/net/eml.ts for why offering one would
 *    be offering the user a crash.
 *  - `'soft'` — the message parsed normally and the decoded body was cut at
 *    `limitBytes`. Everything else is intact, attachments included. `canShowFull`
 *    says whether a raised (still finite) limit is available, i.e. whether this
 *    result came from the first tier.
 */
type MessageParseCapBase = {
  /** Size of the raw RFC822 message, in bytes. The one fact the hard path can
   *  state about a message it never parsed. */
  rawBytes: number
  /** The limit that tripped, in bytes. Not a constant to the renderer: the soft
   *  cap has two tiers, and the banner should say which one it hit. */
  limitBytes: number
}

export type MessageParseCap =
  | (MessageParseCapBase & {
      kind: 'hard'
      /**
       * Never set on the hard path, and `never` rather than merely absent so
       * the compiler says so. `{ kind: 'hard', canShowFull: true }` is not a
       * state this system has — there is no raised tier above the hard cap —
       * and it must not be constructible, because a renderer reading it would
       * offer a button that asks the application to run out of memory.
       */
      canShowFull?: never
    })
  | (MessageParseCapBase & {
      kind: 'soft'
      /**
       * REQUIRED on the soft path. True when a re-parse at the raised tier
       * would show more, i.e. this result came from the first tier; false when
       * it was already produced at the raised tier, and the banner then offers
       * nothing further.
       *
       * Required rather than optional because "absent" and "false" would render
       * identically while meaning different things — one is "there is no more
       * to get", the other is "nobody decided". A soft cap always knows.
       */
      canShowFull: boolean
    })

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
  /** Set when message was loaded from cached headers because the body could not be fetched */
  offlineFallback?: boolean
  /**
   * §2.17 Phase 1 — WHY the headers-only envelope was produced. The shape is
   * identical in every case (headers, no body), the cause is not, and each
   * cause needs different words. Each value is a claim main.ts is willing to
   * make to the user's face, so there is one value per thing we actually know:
   *
   *  - `'offline'` — reserved for what we know for certain: the user asked for
   *    work-offline mode, so the server was never contacted. "Only headers are
   *    cached" is true here.
   *  - `'timeout'` — OUR OWN fetch budget expired. That is all it means: the
   *    budget is a `setTimeout` racing the fetch and it fires without learning
   *    why the fetch was slow. Saying "not available offline" here is false on
   *    both counts, which is the user-visible half of the §2.17 defect.
   *  - `'unavailable'` — loading the body threw and we do not know more than
   *    that. Auth rejection, TLS trust failure, a mailbox that no longer
   *    exists, a missing credential caught before any socket opened, and a
   *    genuinely dead network all land here, and they are NOT distinguished:
   *    see the comment at the catch site in electron/main.ts for why one honest
   *    sentence beats four heuristic ones. It is not even a claim that the
   *    SERVER failed: the same block covers the work done after the bytes
   *    arrived — writing the EML, parsing it, indexing it — so a full disk
   *    reaches the user through this value too, which is why its wording says
   *    "could not load" rather than "could not fetch from the server". Filing
   *    this bucket under `'offline'` was the fix-wave defect — it told a user
   *    whose password had expired, over a working connection, that they were
   *    offline, while the "sign in again" badge (§2.165) sat above the same
   *    list.
   *
   * Absent is PRESENTED as `'offline'` (see src/utils/mailBodyFallback.ts), and
   * that is a compatibility choice for envelopes cached before this field
   * existed — not a record of what happened to them. The pre-field flag was
   * raised for timeouts and for arbitrary caught failures as well, so an old
   * row genuinely carries no cause; the renderer keeps showing it the sentence
   * it has always been shown with rather than inventing one.
   */
  offlineFallbackReason?: 'offline' | 'timeout' | 'unavailable'
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
   * `inviteBridge.makeInviteCache()`), so the serialized details row
   * (`messages.cached_detail` — there has never been a `message_details_cache`
   * table; see `setCachedDetail` in packages/db/index.ts), the in-memory LRU
   * JSON, and every IPC envelope crossing to the
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
  /**
   * §2.145 — set only when a parse cap shaped this result; see
   * `MessageParseCap`. Crosses IPC to the renderer, which uses it to choose
   * between the hard-cap placeholder and the soft-cap banner.
   */
  parseCap?: MessageParseCap
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
   * Start of the event. **Three encodings** — the consumer must branch on the
   * shape of the string, not assume UTC:
   *
   * 1. All-day (`allDay: true`): floating date `YYYY-MM-DD`, no time, no zone
   *    (RFC 5545 `VALUE=DATE`). Display as-is in every timezone.
   * 2. Timed, instant known: ISO 8601 **with** an explicit offset or `Z`
   *    (e.g. `2026-05-15T14:00:00.000Z`). Main resolved the zone while parsing —
   *    either the event was already UTC or an inline VTIMEZONE / IANA TZID was
   *    applied — so `new Date(dtstart)` is a correct point in time.
   * 3. Timed, instant NOT known: **zone-independent wall clock**
   *    `YYYY-MM-DDTHH:MM:SS`, no offset, no `Z`. Emitted whenever ical.js could
   *    not resolve the zone (`floating` fallback — typically a Windows-style
   *    TZID with no usable VTIMEZONE, or a genuinely floating RFC 5545 time).
   *    These are the organizer's wall-clock numbers, **not** UTC. `new Date()`
   *    on them silently reads them as viewer-local; the renderer instead
   *    re-interprets them against {@link tzid} when that names a zone Intl
   *    accepts, and otherwise prints them verbatim with the tzid as a caption
   *    (see `src/components/inviteTimeZone.ts` for the DST gap / ambiguity
   *    policy applied during that re-interpretation).
   *
   * Encodings 2 and 3 are distinguished by the presence of a trailing `Z` or a
   * numeric offset — there is no separate flag.
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
   * §2.22 fix iter2A — the `DTSTART;TZID=...` parameter, verbatim, when present.
   *
   * **Opaque label, NOT guaranteed to be IANA.** RFC 5545 §3.2.19 lets the
   * organizer put any string here; Outlook / Exchange routinely send Windows
   * names (`Russian Standard Time`, `W. Europe Standard Time`) and some servers
   * send `UTC`. Passing this value to `Intl.DateTimeFormat({ timeZone })`
   * therefore throws `RangeError` for a whole class of real invites — always
   * resolve it through a guard first (renderer: `canonicalIanaZone()` in
   * `src/components/inviteTimeZone.ts`).
   *
   * Undefined for all-day events and for events with no TZID parameter — note
   * that a UTC event carries no TZID, but a `TZID=UTC` event does.
   *
   * Two roles, depending on the {@link dtstart} encoding: for an already
   * resolved instant it is only a caption ("originally scheduled in …"); for a
   * wall-clock `dtstart` it is also the zone those numbers are to be
   * interpreted in — when, and only when, it resolves to a usable IANA zone.
   * It is never the display zone: times render in the viewer's own zone.
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
  /**
   * §3.3 B6 (draft side) — the language this reply is probably meant to be
   * written in, as a SUGGESTION for the compose translate control.
   *
   * ## Minted by main only, and NOT part of `composeInitSchema`
   *
   * The field is absent from the zod schema that validates `ui:openCompose`,
   * and that schema is `.strict()`, so a renderer that sends it gets the WHOLE
   * open request rejected rather than having the value stripped. That is
   * deliberate: main derives this from the canonical text of the message being
   * replied to (local cache, by `replyRef`, the same read the reading-side
   * translation uses) and runs the local trigram detector on it. The renderer
   * never feeds the detector and never states the answer — a renderer-supplied
   * value would be an unverified claim about the correspondent's language
   * riding in on a channel whose whole point is that main owns it.
   *
   * ## It SUGGESTS, it does not decide (CLAUDE.md §5 "who owns the truth")
   *
   * The language a correspondent reads is not a fact this process owns, so it
   * enforces nothing anywhere. It only pre-fills the target picker until the
   * user picks one, and the user's pick wins from then on. It also starts
   * nothing: no translation is ever triggered by the presence of this field.
   *
   * `null` — and it is `null` far more often than not — means "we do not know",
   * never a guess: too little text, candidates too close together, a language
   * outside the sixteen we offer, no `replyRef` at all (a forward, a brand-new
   * message), no cached row, or the translate opt-in being off for the account.
   */
  suggestedTargetLang?: TranslateLanguageCode | null
}
