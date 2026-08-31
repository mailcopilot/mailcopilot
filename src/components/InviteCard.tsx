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
import { ERROR_PRESENTATION_I18N_KEYS, decodeErrorPresentation } from '@mailcopilot/core'
import type { CalendarInvitePublic, RsvpMethod } from '../../packages/types'
import {
  canonicalIanaZone,
  inviteTimeDayKey,
  inviteTimeFormatOptions,
  resolveInviteTime,
  type ResolvedInviteTime,
} from './inviteTimeZone'

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
 * Format a calendar date range for display. Handles:
 * - All-day events: "Friday, May 15" (or "May 15 – May 16" for multi-day)
 * - Same-day timed: "Friday, May 15 · 14:00–15:30"
 * - Multi-day timed: "Fri May 15, 14:00 – Sat May 16, 09:00"
 * - No end date: shows start only
 *
 * Timed events are rendered in the viewer's own timezone whenever they denote a
 * real instant, and the originating zone is surfaced as a caption by
 * `getTzidAnnotation`. This matches Gmail, Outlook, Thunderbird and Apple Mail.
 * The one exception is an invite whose TZID cannot be resolved: there is no
 * instant to convert, so the organizer's numbers are printed verbatim through a
 * UTC carrier (`resolveInviteTime` tags this case; see `inviteTimeZone`).
 *
 * Turning an organizer wall clock into an instant (including the DST gap /
 * ambiguity policy) lives in `./inviteTimeZone`.
 *
 * The previous behaviour formatted in the organizer's zone whenever the TZID
 * happened to be one Intl accepted, which silently produced wrong times: the
 * same Exchange server sends `TZID=Russian Standard Time` (a Windows label,
 * rejected by Intl, so the code accidentally fell back to viewer-local and was
 * right) and `TZID=UTC` for updates of the same meeting (accepted by Intl, so a
 * 15:00 Moscow meeting rendered as 12:00). A user acted on the 12:00 reading.
 *
 * §2.22 fix iter2B:
 * - allDay=true: dtstart is 'YYYY-MM-DD', parsed as local midnight (no UTC shift)
 *
 * §2.22 fix iter3B:
 * - RFC 5545 §3.6.1: all-day DTEND is exclusive (DTEND=May 17 → last day is May 16).
 *   DTEND one day after DTSTART = single-day event (show DTSTART only).
 */

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

  // Timed event. The organizer's zone is only ever a hint for interpreting a
  // wall-clock string — never the display zone.
  const sourceZone = tzid ? canonicalIanaZone(tzid) : null

  const start = resolveInviteTime(dtstart, sourceZone)
  if (!start) return dtstart

  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }

  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
  }

  /**
   * Instants render in the viewer's zone; an unresolvable TZID leaves us with
   * the organizer's bare numbers, which `inviteTimeFormatOptions` prints
   * verbatim via a UTC carrier instead of re-reading them as viewer-local.
   */
  const fmt = (value: ResolvedInviteTime, opts: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(locale, inviteTimeFormatOptions(value, opts)).format(value.date)

  const startOnly = (): string => `${fmt(start, dateOpts)} · ${fmt(start, timeOpts)}`

  if (!dtend) return startOnly()

  // dtend: same resolution as dtstart
  const end = resolveInviteTime(dtend, sourceZone)
  if (!end) return startOnly()

  if (inviteTimeDayKey(start) === inviteTimeDayKey(end)) {
    // Same day: "Friday, May 15 · 14:00–15:30"
    return `${fmt(start, dateOpts)} · ${fmt(start, timeOpts)}–${fmt(end, timeOpts)}`
  }

  // Multi-day: "Fri May 15, 14:00 – Sat May 16, 09:00"
  const shortDateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }
  return `${fmt(start, shortDateOpts)} – ${fmt(end, shortDateOpts)}`
}

/**
 * Returns the original-zone caption when the event's TZID names a zone other
 * than the viewer's own. Returns null when no caption is needed (tzid absent,
 * same zone as the viewer, or an all-day event, which carries no zone).
 *
 * Times themselves are always shown in the viewer's zone (see
 * `formatInviteDateRange`), so this caption is the only place the organizer's
 * zone appears — and for a TZID Intl cannot resolve (Windows-style Outlook
 * labels) it is also the signal that the printed wall clock is the
 * organizer's, not a converted one.
 *
 * Comparison is done on canonical zone ids so that ICU links (`W-SU` →
 * `Europe/Moscow`, `Etc/UTC` → `UTC`) do not produce a caption claiming a
 * different zone. An unresolvable TZID never compares equal, so it is always
 * captioned — which is exactly the case where the user needs it most.
 */
function getTzidAnnotation(invite: CalendarInvitePublic): string | null {
  if (invite.allDay || !invite.tzid) return null
  try {
    const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (viewerTz === invite.tzid) return null
    const canonical = canonicalIanaZone(invite.tzid)
    if (canonical && canonical === canonicalIanaZone(viewerTz)) return null
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
      // §2.127 — the IPC rejection path (SMTP unreachable, credentials
      // rejected) reads as one of four sentences; the raw text was the
      // "Error invoking remote method 'mail:rsvpInvite'" wrapper. The
      // `result.error` branch above is a different channel — a structured
      // envelope, not a rejection — and is left as-is.
      setRsvpState({
        kind: 'error',
        response,
        errorMsg: t(ERROR_PRESENTATION_I18N_KEYS[decodeErrorPresentation(err)]),
      })
    }
  }, [accountId, messageUid, folder, t])

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
