/**
 * §2.22 Wave A — ICS / iTIP invite bridge.
 *
 * Single owner of:
 *   - parsing inbound `text/calendar` MIME parts into the strongly-typed
 *     {@link CalendarInvite} shape (RFC 5545);
 *   - generating METHOD:REPLY VCALENDAR payloads (RFC 5546 §3.2.3) for the
 *     RSVP flow (Accept / Tentative / Decline);
 *   - registering the `mail:rsvpInvite` IPC handler that the renderer's
 *     InviteCard calls.
 *
 * Layering: this module is the only place in the codebase that imports
 * `ical.js`. `packages/net/message.ts` extracts the raw ics string but never
 * parses it, so the net package stays free of ical.js. The renderer never
 * sees `rawIcs` either — it only receives the parsed `CalendarInvite` via
 * `MessageDetails.calendarInvite`, and triggers RSVP via IPC by passing the
 * `(accountId, uid, folder, response)` quadruple back to main, which
 * re-parses from the on-disk EML / IMAP body.
 *
 * SMTP path: RSVP replies are sent through the same per-account transport
 * the user configured (re-uses `sendMailWithAccountConfig` in main.ts). The
 * RSVP is a side-effect operation triggered by an explicit user click, not a
 * compose draft, so it does NOT go through the `send_queue` retry pipeline —
 * a failed RSVP surfaces immediately to the renderer where the user can
 * retry. nodemailer's `alternatives` field is used to attach the REPLY ics
 * as a `text/calendar; method=REPLY` part inside `multipart/alternative`,
 * which Outlook / Apple Calendar / Google Calendar require for automatic
 * RSVP recognition.
 */

import ICAL from 'ical.js'
import addressparser from 'nodemailer/lib/addressparser/index.js'
import { z } from 'zod'
import { handleIpc } from '../ipc'
import { createLogger } from '../logger'
import { recordEvent } from '../metrics'
import { captureException } from '../sentry'
import type { CalendarInvite, CalendarInvitePublic, RsvpMethod } from '@mailcopilot/types'

const log = createLogger('InviteBridge')

const VALID_METHODS = new Set(['REQUEST', 'CANCEL', 'REPLY', 'PUBLISH'])

/**
 * §2.22 fix iter4 — codex-security-review HIGH: validate that a free-form
 * ORGANIZER value is a single, well-formed addr-spec.
 *
 * Threat model: nodemailer's MailComposer escapes raw CRLF in headers, but
 * parses `to:` as a full RFC 5322 address-list / group syntax. A malicious
 * organizer like `victim@example.com, attacker@evil.com` or
 * `Group:victim@example.com,attacker@evil.com;` would cause the RSVP REPLY
 * envelope to silently include an attacker recipient, leaking the user's
 * participation status (and combined with the REPLY-relay finding below,
 * potentially the full event metadata) to a third party.
 *
 * Defense: we re-use nodemailer's own addressparser (already a transitive
 * dep, no new install) to canonicalise the value and then enforce four
 * invariants:
 *
 *   1. No control characters / CRLF — even if addressparser tolerates them,
 *      they have no place in an addr-spec and are the simplest header-
 *      injection primitive.
 *   2. Exactly ONE parsed entry — multiple `,`-separated addresses must
 *      reject (the whole point of this guard).
 *   3. No group syntax — `Group:a@x,b@y;` parses to a single entry whose
 *      `.group` is an array; reject.
 *   4. The local@domain shape itself must match a strict regex —
 *      addressparser is permissive; weird quoted local-parts that contain
 *      a stray `@` could otherwise still slip through.
 *
 * Returns the lowercased canonical address, or null on rejection. Caller
 * (`parseCalendarPart`) maps null to "no actionable invite" so the renderer
 * never sees the RSVP buttons in the first place.
 */
function validateSingleAddress(input: string): string | null {
  if (!input) return null
  // (1) Reject control chars (incl. CRLF) and the typical RFC 5322 separators
  // we never want in an addr-spec context. `<>` are rejected because once we
  // wrap the value into `mailto:<addr>`, an embedded `>` would let the
  // attacker close our mailto and inject arbitrary URI components. The
  // no-control-regex eslint rule is disabled deliberately: rejecting C0
  // controls is the *whole point* of this guard.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f<>"]/.test(input)) return null
  let parsed: ReturnType<typeof addressparser>
  try {
    parsed = addressparser(input)
  } catch {
    return null
  }
  // (2) Exactly one parsed entry.
  if (!Array.isArray(parsed) || parsed.length !== 1) return null
  const single = parsed[0] as { address?: string; group?: unknown }
  // (3) No group syntax — if addressparser returned a `.group` field it means
  // the input was `Label:a@x,b@y;` form, which can carry multiple recipients.
  if (single.group !== undefined) return null
  const addr = single.address
  if (!addr || typeof addr !== 'string') return null
  // Belt-and-suspenders: reject anything addressparser somehow let through that
  // contains list/group separators.
  if (/[,;:<>"\s]/.test(addr)) return null
  // (4) Strict local@domain shape. `dot-atom @ dot-atom` only — no quoted
  // local parts, no IP-literal domains. RFC 5322 allows weirder forms, but
  // for an outbound RSVP we only support the canonical form; rejection here
  // is the safer default than minting a REPLY to a malformed envelope.
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(addr)) return null
  return addr.toLowerCase()
}

/**
 * Parse a raw `text/calendar` payload into a {@link CalendarInvite}.
 *
 * Returns `null` when the ics is unparseable, missing a VEVENT, or missing
 * any of the fields the RSVP flow depends on (UID, DTSTART, ORGANIZER).
 * Privacy-safe: corrupted / malicious ics never throws — we log a warning
 * and short-circuit so a single bad invite cannot block message rendering.
 */
export function parseCalendarPart(rawIcs: string): CalendarInvite | null {
  try {
    const jcal = ICAL.parse(rawIcs)
    const vcalendar = new ICAL.Component(jcal)
    const methodRaw = vcalendar.getFirstPropertyValue('method')
    const methodStr = typeof methodRaw === 'string' ? methodRaw.toUpperCase() : ''
    const method: CalendarInvite['method'] = VALID_METHODS.has(methodStr)
      ? (methodStr as CalendarInvite['method'])
      : 'OTHER'

    const vevent = vcalendar.getFirstSubcomponent('vevent')
    if (!vevent) return null

    const uid = vevent.getFirstPropertyValue('uid')
    if (typeof uid !== 'string' || !uid) return null

    const summaryRaw = vevent.getFirstPropertyValue('summary')
    const summary = typeof summaryRaw === 'string' && summaryRaw.length > 0
      ? summaryRaw
      : '(no title)'

    // §2.22 fix iter3A — DTSTART encoding rules:
    //   - VALUE=DATE all-day events ⇒ floating `YYYY-MM-DD` (no time/zone),
    //     `allDay: true`. Renderer must NOT new Date(dtstart) and treat as
    //     midnight in viewer's locale (would slide into wrong day in -TZ
    //     offsets).
    //   - Timed events whose zone ical.js could resolve (matching VTIMEZONE in
    //     scope OR explicit UTC suffix) ⇒ ISO 8601 instant in UTC. `tzid` (when
    //     present as a parameter) is preserved separately so the renderer can
    //     label the time with the original zone instead of the viewer's locale.
    //   - Timed events with `TZID=` parameter but NO inline VTIMEZONE block
    //     (ical.js falls back to its `floating` zone) ⇒ wall-clock string in
    //     `YYYY-MM-DDTHH:mm:ss` form (no `Z`, no offset). Calling `toJSDate()`
    //     here would mis-convert through process-local TZ — see codex iter2
    //     finding. The renderer then re-interprets the wall-clock against
    //     `tzid` via Intl.DateTimeFormat / Temporal.
    //   - Timed events with no TZID and no `Z` (true floating per RFC 5545)
    //     ⇒ wall-clock string, `tzid` undefined; renderer treats as floating.
    const dtstartProp = vevent.getFirstProperty('dtstart')
    const dtstart = vevent.getFirstPropertyValue('dtstart')
    if (!dtstart) return null
    const isIcalTime = typeof dtstart !== 'string' && typeof (dtstart as { isDate?: unknown }).isDate !== 'undefined'
    const allDay = isIcalTime ? Boolean((dtstart as { isDate?: boolean }).isDate) : false
    const tzidParamRaw = dtstartProp?.getParameter('tzid')
    const tzid = typeof tzidParamRaw === 'string' && tzidParamRaw.length > 0 ? tzidParamRaw : undefined
    const dtstartIso = encodeIcalDate(dtstart, tzid)
    if (!dtstartIso) return null

    const dtendProp = vevent.getFirstProperty('dtend')
    const dtendTzidRaw = dtendProp?.getParameter('tzid')
    const dtendTzid = typeof dtendTzidRaw === 'string' && dtendTzidRaw.length > 0 ? dtendTzidRaw : undefined
    const dtend = vevent.getFirstPropertyValue('dtend')
    const dtendIso = dtend ? (encodeIcalDate(dtend, dtendTzid) ?? undefined) : undefined

    const organizerProp = vevent.getFirstProperty('organizer')
    if (!organizerProp) return null
    const organizerValueRaw = organizerProp.getFirstValue()
    const organizerValue = typeof organizerValueRaw === 'string' ? organizerValueRaw : ''
    // §2.22 fix iter4 — codex-security-review HIGH: gate ORGANIZER through a
    // strict single-address validator so a malicious `victim@x, attacker@y`
    // organizer cannot redirect / multiply RSVP envelopes. See
    // `validateSingleAddress` for the threat model.
    const organizerEmail = validateSingleAddress(
      organizerValue.replace(/^mailto:/i, '').trim(),
    )
    if (!organizerEmail) return null

    const cnRaw = organizerProp.getParameter('cn')
    const organizerName = typeof cnRaw === 'string' && cnRaw.length > 0 ? cnRaw : undefined

    const locationRaw = vevent.getFirstPropertyValue('location')
    const location = typeof locationRaw === 'string' && locationRaw.length > 0
      ? locationRaw
      : undefined

    const descriptionRaw = vevent.getFirstPropertyValue('description')
    const description = typeof descriptionRaw === 'string' && descriptionRaw.length > 0
      ? descriptionRaw
      : undefined

    return {
      uid,
      summary,
      dtstart: dtstartIso,
      dtend: dtendIso,
      allDay,
      tzid,
      organizerEmail,
      organizerName,
      location,
      description,
      method,
      rawIcs,
    }
  } catch (err) {
    // Malformed ics — keep going. The renderer simply won't show the card.
    log.warn('parseCalendarPart failed', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * §2.22 fix iter3A — convert an ICAL.Time (or already-stringified value) into
 * the canonical encoding the renderer relies on:
 *
 *   - `isDate: true` (VALUE=DATE) → `YYYY-MM-DD` floating date.
 *   - timed event with a resolved zone (inline VTIMEZONE matching the TZID,
 *     or explicit UTC `Z` suffix) → ISO 8601 UTC instant (`...Z`).
 *   - timed event with `TZID=` parameter but no resolvable zone (ical.js falls
 *     back to its `floating` placeholder) → preserve wall-clock as
 *     `YYYY-MM-DDTHH:mm:ss` (no `Z`, no offset). Calling `toJSDate()` here
 *     would silently shift the value through the host's process TZ — see
 *     codex-bg-review iter2 HIGH finding. The IANA zone is preserved
 *     separately on the public DTO via `tzid`.
 *   - timed event with no TZID and a floating zone → wall-clock string with
 *     `tzid` undefined (true RFC 5545 floating semantics).
 *
 * Floating-zone detection. `val.zone` is set to `ICAL.Timezone.localTimezone`
 * (which is the singleton with `tzid === 'floating'`) whenever ical.js cannot
 * resolve the value's zone — including the bug-prone case where DTSTART
 * carries `TZID=America/New_York` but the VCALENDAR has no inline VTIMEZONE
 * block for that zone (common in Gmail-style minimal invites). UTC-suffixed
 * values get `val.zone === ICAL.Timezone.utcTimezone`. Properly-resolved zones
 * get a non-floating, non-UTC Timezone instance whose `tzid` matches the
 * parameter. We use object identity (`===`) against the two singletons rather
 * than reading `tzid` strings to stay robust against future ical.js refactors
 * of how zone metadata is exposed.
 *
 * Returns null on inputs we cannot meaningfully encode (defensive — every
 * real `dtstart` we have seen yields either an ICAL.Time or a string).
 */
function encodeIcalDate(value: unknown, tzidParam?: string): string | null {
  if (value == null) return null
  if (typeof value === 'string') {
    return value.length > 0 ? value : null
  }
  // Heuristic shape-check for ICAL.Time without importing the type.
  const candidate = value as {
    isDate?: boolean
    toJSDate?: () => Date
    toString?: () => string
    year?: number
    month?: number
    day?: number
    hour?: number
    minute?: number
    second?: number
    zone?: unknown
  }
  if (candidate.isDate === true) {
    const year = typeof candidate.year === 'number' ? candidate.year : null
    const month = typeof candidate.month === 'number' ? candidate.month : null
    const day = typeof candidate.day === 'number' ? candidate.day : null
    if (year != null && month != null && day != null) {
      const mm = String(month).padStart(2, '0')
      const dd = String(day).padStart(2, '0')
      return `${year}-${mm}-${dd}`
    }
    return typeof candidate.toString === 'function' ? candidate.toString() : null
  }

  // Floating-zone detection: when ical.js cannot resolve the value's zone (no
  // matching VTIMEZONE in scope, or DTSTART without a `Z` suffix), it falls
  // back to its `localTimezone` singleton (tzid === 'floating'). In that
  // branch toJSDate() goes through the host process TZ and silently produces
  // a wrong instant — preserve wall-clock instead.
  const zone = candidate.zone
  // Guarded read; we don't import ICAL types in this file. The two ICAL
  // Timezone singletons are stable across the ical.js versions we ship.
  const isFloatingZone = !!zone
    && (zone === ICAL.Timezone.localTimezone
      || (typeof (zone as { tzid?: unknown }).tzid === 'string' && (zone as { tzid: string }).tzid === 'floating'))
  const shouldPreserveWallClock = isFloatingZone

  if (shouldPreserveWallClock) {
    const year = typeof candidate.year === 'number' ? candidate.year : null
    const month = typeof candidate.month === 'number' ? candidate.month : null
    const day = typeof candidate.day === 'number' ? candidate.day : null
    const hour = typeof candidate.hour === 'number' ? candidate.hour : 0
    const minute = typeof candidate.minute === 'number' ? candidate.minute : 0
    const second = typeof candidate.second === 'number' ? candidate.second : 0
    if (year != null && month != null && day != null) {
      const mm = String(month).padStart(2, '0')
      const dd = String(day).padStart(2, '0')
      const hh = String(hour).padStart(2, '0')
      const mi = String(minute).padStart(2, '0')
      const ss = String(second).padStart(2, '0')
      // Floating wall-clock encoding: no `Z`, no offset. Renderer interprets
      // the value against `tzidParam` (when provided) via Intl.DateTimeFormat.
      // Touching tzidParam here just to keep the parameter live for callers
      // that pass it; the encoded string itself is intentionally zone-less.
      void tzidParam
      return `${year}-${mm}-${dd}T${hh}:${mi}:${ss}`
    }
    // Fall through to toString if structural fields are missing.
  }

  if (typeof candidate.toJSDate === 'function') {
    try {
      const js = candidate.toJSDate()
      if (js instanceof Date && Number.isFinite(js.getTime())) {
        return js.toISOString()
      }
    } catch {
      /* fall through to toString */
    }
  }
  return typeof candidate.toString === 'function' ? candidate.toString() : null
}

/**
 * §2.22 fix iter2A — strip the main-only fields (`rawIcs`, `description`)
 * before the invite crosses any IPC / disk-cache boundary.
 *
 * Centralised in this module so every code path that exposes the renderer
 * shape goes through the same projection — eliminates the chance of a future
 * call site accidentally JSON.stringify'ing the full payload.
 */
export function toPublicInvite(invite: CalendarInvite): CalendarInvitePublic {
  return {
    uid: invite.uid,
    summary: invite.summary,
    dtstart: invite.dtstart,
    dtend: invite.dtend,
    allDay: invite.allDay,
    tzid: invite.tzid,
    organizerEmail: invite.organizerEmail,
    organizerName: invite.organizerName,
    location: invite.location,
    method: invite.method,
  }
}

/**
 * Build the email payload for an RSVP reply.
 *
 * The returned object mirrors `SendMailOptions` so the caller can hand it
 * straight to the existing send pipeline. Two ics surfaces are produced:
 *
 *   - `icsBody`         — the rebuilt VCALENDAR with METHOD:REPLY and one
 *                         ATTENDEE (the responder) carrying the chosen
 *                         PARTSTAT. Goes both into the
 *                         `multipart/alternative` body (Outlook / Apple) and
 *                         as a regular `invite.ics` attachment (clients that
 *                         only inspect attachments). nodemailer combines
 *                         both via the `alternatives` + `attachments` slots.
 *
 * RFC 5546 §3.2.3 — REPLY MUST preserve the originator's UID, SEQUENCE,
 * DTSTAMP, and DTSTART; replacing the ATTENDEE list with a single self-entry
 * is the canonical pattern for participation status updates.
 */
export function buildRsvpReply(
  invite: CalendarInvite,
  response: RsvpMethod,
  fromAddress: string,
  fromName?: string,
): { subject: string; text: string; icsBody: string; to: string } {
  // §2.22 fix iter4 — codex-security-review HIGH: build a fresh REPLY from a
  // strict allowlist of properties instead of cloning the original VCALENDAR.
  //
  // Threat model: the previous implementation kept the original VCALENDAR /
  // VEVENT structure and only swapped METHOD + ATTENDEE + DTSTAMP. That meant
  // arbitrary fields the organizer chose to pack into the REQUEST —
  // DESCRIPTION, LOCATION, URL, ATTACH, VALARM, X-* extensions — were
  // reflected back verbatim in the user's REPLY. Combined with the (now-
  // fixed) recipient-injection vector on ORGANIZER, this turned the user's
  // own SMTP account into a mass-relay for attacker-controlled calendar
  // payloads: a phishing DESCRIPTION or malicious URL/ATTACH could ride a
  // REPLY out to a spoofed organizer.
  //
  // RFC 5546 §3.2.3 — REPLY only requires UID, SEQUENCE, DTSTAMP, DTSTART,
  // ORGANIZER, ATTENDEE. SUMMARY/LOCATION/DESCRIPTION are NOT mandatory in
  // a REPLY; the receiving calendar matches by UID. Stripping the optional
  // fields is therefore both safe and the canonical defensive pattern.
  const vcal = new ICAL.Component(['vcalendar', [], []])
  vcal.addPropertyWithValue('version', '2.0')
  vcal.addPropertyWithValue('prodid', '-//MailCopilot//iTIP REPLY//EN')
  vcal.addPropertyWithValue('method', 'REPLY')

  // Carefully pick *only* UID / SEQUENCE / RECURRENCE-ID / DTSTART / ORGANIZER
  // out of the original by name. We deliberately avoid `getFirstSubcomponent`
  // / `addProperty` of the original VEVENT itself — that would re-emit every
  // X-* and unknown property we don't want.
  let originalSequence: number | undefined
  let originalRecurrenceId: ICAL.Property | undefined
  let originalDtstart: ICAL.Property | undefined
  let originalOrganizer: ICAL.Property | undefined
  try {
    const original = ICAL.parse(invite.rawIcs)
    const origCal = new ICAL.Component(original)
    const origEvent = origCal.getFirstSubcomponent('vevent')
    if (origEvent) {
      const seqVal = origEvent.getFirstPropertyValue('sequence')
      if (typeof seqVal === 'number') originalSequence = seqVal
      const recIdProp = origEvent.getFirstProperty('recurrence-id')
      if (recIdProp) originalRecurrenceId = recIdProp
      const dtstartProp = origEvent.getFirstProperty('dtstart')
      if (dtstartProp) originalDtstart = dtstartProp
      const organizerProp = origEvent.getFirstProperty('organizer')
      if (organizerProp) originalOrganizer = organizerProp
    }
  } catch {
    // Malformed original — fall back to fields preserved on the parsed DTO.
    // We never throw out of buildRsvpReply itself: the RSVP path is meant
    // to be best-effort with a graceful renderer error on failure.
  }

  const vevent = new ICAL.Component('vevent')
  // RFC 5546 §3.2.3 mandatory fields:
  vevent.addPropertyWithValue('uid', invite.uid)
  if (originalSequence !== undefined) {
    vevent.addPropertyWithValue('sequence', originalSequence)
  }
  if (originalRecurrenceId) vevent.addProperty(originalRecurrenceId)

  // RFC 5545 §3.8.7.2 — DTSTAMP MUST be in UTC (Z-suffixed) for every REPLY
  // so calendaring clients can sequence concurrent responses correctly.
  // `fromJSDate(date, true)` constructs a UTC time so `.toString()` yields
  // `YYYYMMDDTHHMMSSZ`.
  const nowStamp = ICAL.Time.fromJSDate(new Date(), true)
  nowStamp.isDate = false
  vevent.addPropertyWithValue('dtstamp', nowStamp.toString())

  // DTSTART — preserve from original (with TZID parameter if present).
  if (originalDtstart) {
    vevent.addProperty(originalDtstart)
  } else {
    // Fallback when the original could not be re-parsed: rebuild from the
    // public DTO. This branch is unreachable in normal flow because parse
    // succeeded once already in parseCalendarPart, but keep it defensive.
    vevent.addPropertyWithValue('dtstart', invite.dtstart)
  }

  // ORGANIZER — required for REPLY (RFC 5546 §3.2.3 says REPLY must echo it).
  // Preserve the original property to keep CN parameter etc. — it has already
  // been validated by `validateSingleAddress` in `parseCalendarPart`, so we
  // know the underlying address is a single canonical addr-spec.
  if (originalOrganizer) {
    vevent.addProperty(originalOrganizer)
  } else {
    vevent.addPropertyWithValue('organizer', `mailto:${invite.organizerEmail}`)
  }

  // ATTENDEE — single self-entry carrying the chosen PARTSTAT.
  const attendee = new ICAL.Property('attendee', vevent)
  attendee.setParameter('partstat', response)
  attendee.setParameter('cn', fromName ?? fromAddress)
  attendee.setValue(`mailto:${fromAddress}`)
  vevent.addProperty(attendee)

  vcal.addSubcomponent(vevent)
  const icsBody = vcal.toString()

  const verbBySubject: Record<RsvpMethod, string> = {
    ACCEPTED: 'Accepted',
    TENTATIVE: 'Tentative',
    DECLINED: 'Declined',
  }
  const verbByText: Record<RsvpMethod, string> = {
    ACCEPTED: 'has accepted',
    TENTATIVE: 'has tentatively accepted',
    DECLINED: 'has declined',
  }
  const subject = `${verbBySubject[response]}: ${invite.summary}`
  const displayName = fromName ?? fromAddress
  const text = `${displayName} ${verbByText[response]} the invitation: ${invite.summary}.`

  return { subject, text, icsBody, to: invite.organizerEmail }
}

// --- Main-only invite cache -------------------------------------------------

/**
 * §2.22 fix iter2A — bounded LRU cache of full {@link CalendarInvite} payloads
 * keyed by `(accountId, folder, uid)`.
 *
 * Lives only in main process memory: it is the storage tier that holds the
 * raw ics payload required to mint a conforming RFC 5546 REPLY. Renderer-
 * facing surfaces (IPC, SQLite cache, in-memory `MessageDetails` LRU) carry
 * only {@link CalendarInvitePublic}, so the privacy footprint of the original
 * VCALENDAR (DESCRIPTION, ATTENDEE list, X-* extensions) is bounded to this
 * map for the lifetime of the open mail window.
 *
 * On cache miss (e.g. after restart, or after eviction under memory pressure)
 * the caller is expected to re-extract from the on-disk EML or IMAP body —
 * see `resolveInviteForRsvp` in main.ts for the tier list.
 */
export interface InviteCache {
  /** Store the full invite for later RSVP minting. No-op if invite is null. */
  put(accountId: number, folder: string, uid: number, invite: CalendarInvite | null): void
  /** Look up the full invite. Returns undefined on miss / eviction. */
  get(accountId: number, folder: string, uid: number): CalendarInvite | undefined
  /** Clear all entries — primarily for tests. */
  clear(): void
  /** Current size — for diagnostics / tests. */
  size(): number
}

const DEFAULT_INVITE_CACHE_LIMIT = 256

/**
 * Build a fresh {@link InviteCache} backed by a plain `Map` with insertion-
 * order LRU semantics: when the cache exceeds `limit`, the oldest entry (the
 * first key Map iterates over) is dropped. On every `get`/`put`, the entry is
 * re-inserted to bump it to the most-recent end.
 *
 * Limit chosen to comfortably cover a user's open invite-bearing windows
 * across multiple accounts without growing unboundedly during a long-running
 * Electron session. ~256 invites at ~10KB raw ics each ≈ 2.5MB worst case.
 */
export function makeInviteCache(limit: number = DEFAULT_INVITE_CACHE_LIMIT): InviteCache {
  const store = new Map<string, CalendarInvite>()
  const key = (accountId: number, folder: string, uid: number) => `${accountId}\x00${folder}\x00${uid}`
  return {
    put(accountId, folder, uid, invite) {
      if (!invite) return
      const k = key(accountId, folder, uid)
      if (store.has(k)) store.delete(k)
      store.set(k, invite)
      while (store.size > limit) {
        const oldest = store.keys().next().value
        if (oldest === undefined) break
        store.delete(oldest)
      }
    },
    get(accountId, folder, uid) {
      const k = key(accountId, folder, uid)
      const hit = store.get(k)
      if (!hit) return undefined
      // Bump LRU recency so frequently-RSVPed invites stay warm.
      store.delete(k)
      store.set(k, hit)
      return hit
    },
    clear() { store.clear() },
    size() { return store.size },
  }
}

// --- IPC wiring ------------------------------------------------------------

/**
 * Resolves the current user's `(email, displayName?)` for an account so the
 * RSVP can populate the ATTENDEE entry correctly. Provided as a dependency
 * (not imported directly) so this module stays decoupled from the heavy
 * `electron/main.ts` imports — same pattern other services use to avoid
 * pulling main into their unit tests.
 */
export type RsvpFromResolver = (accountId: number) => Promise<{
  email: string
  displayName?: string
}>

/**
 * Loads the parsed CalendarInvite for a given message reference. Implementations
 * in `electron/main.ts` route through the same memory / DB / EML / IMAP cache
 * tiers that `net:messageDetails` uses, so an RSVP click never causes a fresh
 * IMAP roundtrip when the body is already cached.
 */
export type InviteResolver = (
  accountId: number,
  folder: string,
  uid: number,
) => Promise<CalendarInvite | null>

/**
 * Sends the RSVP message through the same transport the user configured
 * (per-account SMTP / Outlook Graph). Accepts a flexible payload shape so the
 * caller can wire in the raw `sendMailWithAccountConfig` helper in main.ts
 * without leaking its internals.
 */
export type RsvpSender = (
  accountId: number,
  payload: {
    from: string
    to: string
    subject: string
    text: string
    icsBody: string
  },
) => Promise<{ messageId: string }>

const rsvpRequestSchema = z.object({
  accountId: z.number().int().positive(),
  uid: z.number().int().positive(),
  folder: z.string().min(1).max(1024),
  response: z.enum(['ACCEPTED', 'TENTATIVE', 'DECLINED']),
})

export type RsvpRequest = z.infer<typeof rsvpRequestSchema>

export type RsvpResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string }

/**
 * Register the `mail:rsvpInvite` IPC handler. Idempotent in the sense that
 * the wrapper goes through `handleIpc`, so the standard inflight tracking,
 * slow-IPC warnings, and error funnel apply automatically.
 *
 * Telemetry: emits `mail.invite_rsvp` once per *successful* send. We
 * deliberately do not emit on failure so the metric reflects user-visible
 * success only — failures are already captured via Sentry.
 */
export function registerInviteHandlers(deps: {
  resolveInvite: InviteResolver
  resolveFrom: RsvpFromResolver
  sendRsvp: RsvpSender
}): void {
  // §2.22 fix iter4 — codex-security-review LOW: in-memory inflight guard so
  // a compromised renderer (or a buggy double-click) cannot fire duplicate
  // RSVP envelopes for the same `(account, folder, uid, response)` tuple.
  // Strictly per-tuple — the user is still allowed to legitimately switch
  // Accept→Decline, the guard only blocks parallel duplicates.
  const inflightRsvp = new Set<string>()

  handleIpc('mail:rsvpInvite', async (_event, payload: unknown): Promise<RsvpResult> => {
    let parsed: RsvpRequest
    try {
      parsed = rsvpRequestSchema.parse(payload)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid RSVP request'
      log.warn('rsvpInvite rejected: invalid payload', msg)
      return { ok: false, error: msg }
    }

    const inflightKey = `${parsed.accountId}\x00${parsed.folder}\x00${parsed.uid}\x00${parsed.response}`
    if (inflightRsvp.has(inflightKey)) {
      log.warn(
        `rsvpInvite: duplicate in-flight rejected account=${parsed.accountId} ` +
        `uid=${parsed.uid} folder=${parsed.folder} response=${parsed.response}`,
      )
      return { ok: false, error: 'rsvp_in_progress' }
    }
    inflightRsvp.add(inflightKey)

    try {
      const invite = await deps.resolveInvite(parsed.accountId, parsed.folder, parsed.uid)
      if (!invite) {
        log.warn(`rsvpInvite: no invite found for account=${parsed.accountId} uid=${parsed.uid}`)
        return { ok: false, error: 'No calendar invite found for this message' }
      }

      // §2.22 fix iter2A — RFC 5546 REPLY only makes sense for REQUEST.
      // Renderer hides RSVP buttons for PUBLISH / REPLY / CANCEL / OTHER, but
      // a programmatic IPC caller (or a tampered renderer) could still
      // attempt to send. Reject server-side as defense-in-depth so we never
      // mint a meaningless REPLY at calendar feeds (PUBLISH) or bounce REPLY
      // chains.
      if (invite.method !== 'REQUEST') {
        log.warn(
          `rsvpInvite: refusing non-REQUEST invite (method=${invite.method}) ` +
          `account=${parsed.accountId} uid=${parsed.uid}`,
        )
        captureException(
          new Error(`rsvp_not_actionable: method=${invite.method}`),
          { source: 'InviteBridge.rsvp' },
        )
        return { ok: false, error: 'invite_not_actionable' }
      }

      const fromInfo = await deps.resolveFrom(parsed.accountId)
      const { subject, text, icsBody, to } = buildRsvpReply(
        invite,
        parsed.response,
        fromInfo.email,
        fromInfo.displayName,
      )

      const fromHeader = fromInfo.displayName
        ? `${fromInfo.displayName} <${fromInfo.email}>`
        : fromInfo.email

      const result = await deps.sendRsvp(parsed.accountId, {
        from: fromHeader,
        to,
        subject,
        text,
        icsBody,
      })

      // Fire-and-forget telemetry — never block the user's success path on
      // metrics. `recordEvent` itself is non-throwing, but the wrapper guards
      // against future regressions and stays consistent with other call sites.
      try {
        const methodTag: 'accepted' | 'tentative' | 'declined' =
          parsed.response === 'ACCEPTED' ? 'accepted'
            : parsed.response === 'TENTATIVE' ? 'tentative'
              : 'declined'
        recordEvent('mail.invite_rsvp', {
          method: methodTag,
          hadLocation: Boolean(invite.location),
        })
      } catch { /* telemetry must never break the RSVP path */ }

      return { ok: true, messageId: result.messageId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Local diagnostic sink — the user's electron-log on disk preserves the
      // full message (including provider/SMTP detail) for support.
      log.error('rsvpInvite failed', msg)
      // §2.22 fix iter4 — codex-security-review BLOCKER: the original
      // implementation passed `err` straight to Sentry. nodemailer / SMTP /
      // Outlook Graph errors typically embed recipient addresses, server
      // greeting strings, subject text and other PII inside their `.message`,
      // so a raw forward would violate the CLAUDE.md §8 "no PII in Sentry"
      // invariant. Replace with a synthetic, sanitized Error whose message is
      // a stable category string and whose extra fields are aggregate-only:
      // `error_name`, optional SMTP `responseCode`, optional Node syscall
      // `code`. The renderer-facing `error: msg` stays untouched — that is
      // local UI, not telemetry.
      const errorName = err instanceof Error ? err.name : 'UnknownError'
      const errLike = err as { responseCode?: unknown; code?: unknown }
      const responseCode = typeof errLike.responseCode === 'number' ? errLike.responseCode : undefined
      const errorCode = typeof errLike.code === 'string' ? errLike.code : undefined
      captureException(new Error(`invite_rsvp_failed: ${errorName}`), {
        source: 'InviteBridge.rsvp',
        error_name: errorName,
        ...(responseCode != null ? { smtp_response_code: responseCode } : {}),
        ...(errorCode ? { error_code: errorCode } : {}),
      })
      return { ok: false, error: msg }
    } finally {
      // Always release the inflight slot so a transient SMTP error doesn't
      // permanently lock out the user's next attempt.
      inflightRsvp.delete(inflightKey)
    }
  })
}
