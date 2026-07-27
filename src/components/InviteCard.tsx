/**
 * InviteCard — inline calendar invitation card rendered inside MailBodyContent
 * when MessageDetails.calendarInvite is defined.
 *
 * Security: all string fields from CalendarInvite (summary, organizerName,
 * organizerEmail, location) are untrusted email content. They are rendered
 * via JSX only — React auto-escapes them. No dangerouslySetInnerHTML anywhere.
 * No URL links from ICS data (SSRF risk).
 *
 * State is local: RSVP status is held in component state, not persisted.
 * Re-opening the message resets the UI to show action buttons again — which is
 * fine for PR1; the actual send is the RSVP REPLY email the backend produces.
 */

import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays, MapPin, User, Loader2, CheckCircle, Clock, XCircle } from 'lucide-react'
import type { CalendarInvitePublic, RsvpMethod } from '../../packages/types'

export interface InviteCardProps {
  /**
   * Parsed calendar invite from MessageDetails.calendarInvite. §2.22 fix
   * iter2A: this is the renderer-facing DTO without `rawIcs` / `description`.
   * The full payload required to mint the RFC 5546 REPLY lives only in main
   * process memory; the renderer triggers the RSVP via the
   * `mail:rsvpInvite` IPC and main re-loads the full invite there.
   */
  invite: CalendarInvitePublic
  /** IMAP UID of the containing message (numeric) — NOT the VEVENT UID */
  messageUid: number
  /** Account ID of the containing message */
  accountId: number
  /** IMAP folder of the containing message */
  folder: string
  /**
   * §2.22 fix iter2B: list of normalized identity emails for the active
   * account (primary email + smtp.user + imap.user + alias identities).
   * Used to detect organizer == self without a case/whitespace-sensitive
   * string comparison. Replaces the single `accountEmail?: string` prop.
   */
  identities?: string[]
}

type RsvpState =
  | { kind: 'idle' }
  | { kind: 'sending'; response: RsvpMethod }
  | { kind: 'done'; response: RsvpMethod }
  | { kind: 'error'; response: RsvpMethod; errorMsg: string }

/**
 * Parse a floating date string 'YYYY-MM-DD' into local midnight without
 * timezone shift. Using the three-argument Date constructor avoids the UTC
 * midnight → local midnight offset that `new Date('YYYY-MM-DD')` introduces.
 */
function parseFloatingDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/**
 * Parse a wall-clock datetime string 'YYYY-MM-DDTHH:MM:SS' (no Z suffix) into
 * a local Date object using the Date(y, m-1, d, h, m, s) constructor.
 * This means the Date represents the given wall-clock numbers as if they were
 * in the viewer's local timezone — which is intentional: we display the original
 * wall-clock time (e.g. "14:00 NY") using plain local formatters (no timeZone
 * override), and annotate with the original TZID separately.
 */
function parseWallClock(dtstart: string): Date {
  const tIdx = dtstart.indexOf('T')
  const datePart = tIdx >= 0 ? dtstart.slice(0, tIdx) : dtstart
  const timePart = tIdx >= 0 ? dtstart.slice(tIdx + 1) : '00:00:00'
  const [y, m, d] = datePart.split('-').map(Number)
  const parts = timePart.split(':').map(Number)
  const hh = parts[0] ?? 0
  const mm = parts[1] ?? 0
  const ss = parts[2] ?? 0
  // Local Date constructor — wall-clock numbers are preserved as viewer-local
  return new Date(y, m - 1, d, hh, mm, ss)
}

/**
 * Format a calendar date range for display. Handles:
 * - All-day events: "Friday, May 15" (or "May 15 – May 16" for multi-day)
 * - Same-day timed: "Friday, May 15 · 14:00–15:30"
 * - Multi-day timed: "Fri May 15, 14:00 – Sat May 16, 09:00"
 * - No end date: shows start only
 *
 * §2.22 fix iter2B:
 * - allDay=true: dtstart is 'YYYY-MM-DD', parsed as local midnight (no UTC shift)
 * - timed with Z suffix: dtstart is ISO UTC; rendered in viewer's local TZ (or tzid).
 * - timed without Z suffix: wall-clock in tzid; rendered via Date.UTC trick +
 *   Intl.DateTimeFormat({ timeZone: tzid }).
 *
 * §2.22 fix iter3B:
 * - RFC 5545 §3.6.1: all-day DTEND is exclusive (DTEND=May 17 → last day is May 16).
 *   DTEND one day after DTSTART = single-day event (show DTSTART only).
 * - Wall-clock dtstart (no Z) supported via parseWallClock + timeZone option.
 */
/**
 * Validate that a TZID string is acceptable as `Intl.DateTimeFormat({ timeZone })`.
 * RFC 5545 TZID is an opaque label and does NOT have to be IANA — Outlook /
 * Exchange typically emit Windows-style names like `Russian Standard Time`,
 * `Pacific Standard Time`, `W. Europe Standard Time` which throw RangeError
 * when passed to Intl. Without this guard the InviteCard render escapes to the
 * Sentry error boundary the moment any Outlook invite is opened.
 *
 * Returning false here means the renderer falls back to viewer-local TZ for
 * formatting and surfaces the original tzid via `getTzidAnnotation`, so the
 * user still sees both the local wall-clock and the originating-zone label.
 *
 * Cached because `formatInviteDateRange` calls it on every render and the set
 * of distinct tzids in a session is tiny (one per open invite).
 */
const ianaZoneCache = new Map<string, boolean>()
function isValidIanaZone(tz: string): boolean {
  const cached = ianaZoneCache.get(tz)
  if (cached !== undefined) return cached
  let ok = false
  try {
    // Construct-only is enough — RangeError fires at construction, not format().
    new Intl.DateTimeFormat('en', { timeZone: tz })
    ok = true
  } catch {
    ok = false
  }
  ianaZoneCache.set(tz, ok)
  return ok
}

function formatInviteDateRange(
  invite: CalendarInvitePublic,
  locale: string,
): string {
  const { dtstart, dtend, allDay, tzid } = invite

  if (allDay) {
    // dtstart is 'YYYY-MM-DD' floating — parse as local midnight
    let start: Date
    try {
      start = parseFloatingDate(dtstart)
      if (isNaN(start.getTime())) return dtstart
    } catch {
      return dtstart
    }

    const dateFmt = new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    })

    if (!dtend) {
      return dateFmt.format(start)
    }

    // RFC 5545 §3.6.1: DTEND for DATE (all-day) events is exclusive.
    // Subtract one day to get the last inclusive day for display.
    let exclusiveEnd: Date
    try {
      exclusiveEnd = parseFloatingDate(dtend)
      if (isNaN(exclusiveEnd.getTime())) return dateFmt.format(start)
    } catch {
      return dateFmt.format(start)
    }

    // Guard: malformed data where DTEND <= DTSTART
    if (exclusiveEnd <= start) {
      return dateFmt.format(start)
    }

    // Convert exclusive DTEND → inclusive last day
    const inclusiveEnd = new Date(exclusiveEnd)
    inclusiveEnd.setDate(inclusiveEnd.getDate() - 1)

    // Same date after subtracting (DTEND = DTSTART + 1 day → single-day event)
    if (start.toDateString() === inclusiveEnd.toDateString()) {
      return dateFmt.format(start)
    }

    // Multi-day range: "May 15 – May 16"
    const shortFmt = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' })
    return `${shortFmt.format(start)} – ${shortFmt.format(inclusiveEnd)}`
  }

  // Timed event — dtstart is either ISO UTC (with Z) or wall-clock (without Z)
  const isUtc = dtstart.endsWith('Z') || dtstart.includes('+') || dtstart.includes('-', 10)
  const isWallClock = !isUtc

  let start: Date
  try {
    start = isWallClock ? parseWallClock(dtstart) : new Date(dtstart)
    if (isNaN(start.getTime())) return dtstart
  } catch {
    return dtstart
  }

  // Wall-clock dtstart: do NOT pass timeZone to Intl — the local Date already
  // holds the correct wall-clock numbers; viewer sees "14:00" with a tzid annotation.
  // UTC dtstart: pass tzid to Intl so the display is in the event's original zone.
  // Outlook/Exchange use Windows-style TZIDs (`Russian Standard Time`, etc.)
  // which Intl rejects with RangeError — only fall back to tzid if it is a
  // valid IANA zone; otherwise format in viewer-local and let
  // `getTzidAnnotation` surface the original-zone label separately.
  const rawDisplayTz: string | undefined = isWallClock
    ? undefined
    : (tzid ?? undefined)
  const displayTz: string | undefined =
    rawDisplayTz && isValidIanaZone(rawDisplayTz) ? rawDisplayTz : undefined

  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(displayTz ? { timeZone: displayTz } : {}),
  }

  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    ...(displayTz ? { timeZone: displayTz } : {}),
  }

  if (!dtend) {
    const datePart = new Intl.DateTimeFormat(locale, dateOpts).format(start)
    const timePart = new Intl.DateTimeFormat(locale, timeOpts).format(start)
    return `${datePart} · ${timePart}`
  }

  // dtend: same wall-clock / UTC logic as dtstart
  let end: Date
  try {
    const dtendIsWallClock = !dtend.endsWith('Z') && !dtend.includes('+') && !dtend.includes('-', 10)
    end = dtendIsWallClock ? parseWallClock(dtend) : new Date(dtend)
    if (isNaN(end.getTime())) {
      const datePart = new Intl.DateTimeFormat(locale, dateOpts).format(start)
      const timePart = new Intl.DateTimeFormat(locale, timeOpts).format(start)
      return `${datePart} · ${timePart}`
    }
  } catch {
    const datePart = new Intl.DateTimeFormat(locale, dateOpts).format(start)
    const timePart = new Intl.DateTimeFormat(locale, timeOpts).format(start)
    return `${datePart} · ${timePart}`
  }

  // Compare start vs end date in the display timezone
  const toDateKey = (d: Date): string => {
    if (displayTz) {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: displayTz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d)
    }
    return d.toDateString()
  }

  if (toDateKey(start) === toDateKey(end)) {
    // Same day: "Friday, May 15 · 14:00–15:30"
    const datePart = new Intl.DateTimeFormat(locale, dateOpts).format(start)
    const startTime = new Intl.DateTimeFormat(locale, timeOpts).format(start)
    const endTime = new Intl.DateTimeFormat(locale, timeOpts).format(end)
    return `${datePart} · ${startTime}–${endTime}`
  }

  // Multi-day: "Fri May 15, 14:00 – Sat May 16, 09:00"
  const shortDateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(displayTz ? { timeZone: displayTz } : {}),
  }
  const startFmt = new Intl.DateTimeFormat(locale, shortDateOpts).format(start)
  const endFmt = new Intl.DateTimeFormat(locale, shortDateOpts).format(end)
  return `${startFmt} – ${endFmt}`
}

/**
 * Returns the IANA timezone annotation string when the event's original TZID
 * differs from the viewer's local timezone. Returns null when no annotation
 * is needed (tzid absent, or matches viewer's TZ, or allDay event).
 *
 * §2.22 fix iter2B: variant A — show local time always + annotate origin TZ.
 * §2.22 fix iter3B: for wall-clock dtstart (no Z), tzid is always shown if
 * it differs from viewer TZ (same logic, but renderer displays in tzid, not
 * viewer local, so the annotation clarifies which zone is displayed).
 */
function getTzidAnnotation(invite: CalendarInvitePublic): string | null {
  if (invite.allDay || !invite.tzid) return null
  try {
    const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (viewerTz === invite.tzid) return null
    return invite.tzid
  } catch {
    return null
  }
}

export default function InviteCard({
  invite,
  messageUid,
  accountId,
  folder,
  identities,
}: InviteCardProps) {
  const { t, i18n } = useTranslation()
  const [rsvpState, setRsvpState] = useState<RsvpState>({ kind: 'idle' })

  const isCancelled = invite.method === 'CANCEL'

  // §2.22 fix iter2B: only REQUEST is actionable — REPLY/CANCEL/PUBLISH/OTHER
  // are info-only or handled server-side.
  const isActionable = invite.method === 'REQUEST'

  // §2.22 fix iter2B: organizer==self detection with trim+lowercase across
  // multiple identity sources (primary, smtp.user, imap.user, aliases).
  const isOrganizer = useMemo(() => {
    if (!invite.organizerEmail || !identities || identities.length === 0) return false
    const orgNorm = invite.organizerEmail.trim().toLowerCase()
    return identities.some(id => id === orgNorm)
  }, [identities, invite.organizerEmail])

  const showRsvpButtons = isActionable && !isOrganizer

  const handleRsvp = useCallback(async (response: RsvpMethod) => {
    setRsvpState({ kind: 'sending', response })
    try {
      const result = await window.api.invoke('mail:rsvpInvite', {
        accountId,
        uid: messageUid,
        folder,
        response,
      }) as { ok: boolean; messageId?: string; error?: string }

      if (result.ok) {
        setRsvpState({ kind: 'done', response })
      } else {
        setRsvpState({ kind: 'error', response, errorMsg: result.error ?? 'Unknown error' })
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setRsvpState({ kind: 'error', response, errorMsg })
    }
  }, [accountId, messageUid, folder])

  const isSending = rsvpState.kind === 'sending'

  // §2.22 fix iter2B: use the corrected formatter that handles allDay/tzid
  const dateRange = formatInviteDateRange(invite, i18n.language)
  const tzidAnnotation = getTzidAnnotation(invite)

  // Render success state
  if (rsvpState.kind === 'done') {
    const { response } = rsvpState
    const labelKey =
      response === 'ACCEPTED' ? 'invite.responseAccepted'
        : response === 'TENTATIVE' ? 'invite.responseTentative'
          : 'invite.responseDeclined'
    const statusClass =
      response === 'ACCEPTED' ? 'invite-status-accepted'
        : response === 'TENTATIVE' ? 'invite-status-tentative'
          : 'invite-status-declined'
    const StatusIcon =
      response === 'ACCEPTED' ? CheckCircle
        : response === 'TENTATIVE' ? Clock
          : XCircle

    return (
      <div className="invite-card" data-testid="invite-card">
        <div className="invite-card-header">
          <CalendarDays size={16} className="invite-card-icon" aria-hidden="true" />
          <span className="invite-card-summary">{invite.summary}</span>
        </div>
        <div className={`invite-response-status ${statusClass}`} data-testid="invite-response-status">
          <StatusIcon size={14} aria-hidden="true" />
          <span>{t(labelKey)}</span>
        </div>
      </div>
    )
  }

  const organizerLabel = invite.organizerName
    ? `${invite.organizerName} <${invite.organizerEmail}>`
    : invite.organizerEmail || t('invite.noOrganizer')

  return (
    <div className="invite-card" data-testid="invite-card">
      <div className="invite-card-header">
        <CalendarDays size={16} className="invite-card-icon" aria-hidden="true" />
        <span
          className={`invite-card-summary${isCancelled ? ' invite-card-summary-cancelled' : ''}`}
        >
          {invite.summary}
        </span>
        {isCancelled && (
          <span className="invite-cancelled-badge" data-testid="invite-cancelled-badge">
            {t('invite.cancelled')}
          </span>
        )}
      </div>

      <div className="invite-card-meta">
        <div className="invite-meta-row">
          <CalendarDays size={13} className="invite-meta-icon" aria-hidden="true" />
          <span className="invite-meta-label">{t('invite.when')}</span>
          <span className="invite-meta-value">
            {dateRange}
            {tzidAnnotation && (
              <span className="invite-tzid-annotation" data-testid="invite-tzid-annotation">
                {t('invite.originalTimezone', { tzid: tzidAnnotation })}
              </span>
            )}
          </span>
        </div>

        <div className="invite-meta-row">
          <User size={13} className="invite-meta-icon" aria-hidden="true" />
          <span className="invite-meta-label">{t('invite.organizer')}</span>
          {/* organizerLabel is JSX text — React escapes it, no XSS risk */}
          <span className="invite-meta-value invite-meta-organizer">{organizerLabel}</span>
        </div>

        {invite.location && (
          <div className="invite-meta-row">
            <MapPin size={13} className="invite-meta-icon" aria-hidden="true" />
            <span className="invite-meta-label">{t('invite.location')}</span>
            {/* Location is plain text only — no link, no URL parsing (SSRF risk) */}
            <span className="invite-meta-value">{invite.location}</span>
          </div>
        )}
      </div>

      {rsvpState.kind === 'error' && (
        <div className="invite-error" data-testid="invite-error">
          {t('invite.responseFailed', { error: rsvpState.errorMsg })}
        </div>
      )}

      {/* §2.22 fix iter2B: info notice for non-actionable methods (PUBLISH, OTHER, REPLY) */}
      {!isActionable && !isCancelled && (
        <div className="invite-not-actionable" data-testid="invite-not-actionable">
          {t('invite.notActionable')}
        </div>
      )}

      {showRsvpButtons && (
        <div className="invite-actions" data-testid="invite-actions">
          {isSending ? (
            <span className="invite-sending">
              <Loader2 size={14} className="spin" aria-hidden="true" />
              {t('invite.responding')}
            </span>
          ) : (
            <>
              <button
                type="button"
                className="btn-primary invite-btn"
                disabled={isSending}
                onClick={() => { void handleRsvp('ACCEPTED') }}
                data-testid="invite-btn-accept"
              >
                {t('invite.accept')}
              </button>
              <button
                type="button"
                className="invite-btn invite-btn-secondary"
                disabled={isSending}
                onClick={() => { void handleRsvp('TENTATIVE') }}
                data-testid="invite-btn-tentative"
              >
                {t('invite.tentative')}
              </button>
              <button
                type="button"
                className="invite-btn invite-btn-decline"
                disabled={isSending}
                onClick={() => { void handleRsvp('DECLINED') }}
                data-testid="invite-btn-decline"
              >
                {t('invite.decline')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
