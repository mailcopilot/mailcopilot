/**
 * inviteTimeZone — pure wall-clock ↔ instant helpers for calendar invites.
 *
 * Extracted out of InviteCard.tsx so the DST disambiguation policy can be
 * unit-tested directly (see inviteTimeZone.test.ts) instead of being inferred
 * from rendered strings, and so the card component stays a thin renderer.
 *
 * No DOM, no React — only Intl. Safe to import from anywhere in the renderer.
 */

/**
 * The organizer's calendar numbers, with no zone attached to them yet.
 *
 * A wall clock is deliberately NOT a `Date`: a `Date` is an instant, and the
 * only way to build one from bare numbers is to pick a zone to read them in.
 * Picking the viewer's zone (the `Date(y, m-1, d, …)` constructor) silently
 * *changes* the numbers whenever they fall inside the viewer's own spring-forward
 * gap — `new Date(2026, 2, 29, 2, 30)` is 03:30 for a Berlin viewer and 02:30 for
 * a Moscow one. That corruption happens before any conversion and is invisible to
 * the round-trip check in `wallClockToInstant`, because the check only ever sees
 * the already-normalized value.
 *
 * Fields are 1-based for month (unlike `Date`), i.e. exactly the numbers printed
 * in the ICS string.
 */
export interface WallClock {
  year: number
  /** 1-12, as written in the ICS string. */
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/**
 * Parse a wall-clock datetime string 'YYYY-MM-DDTHH:MM:SS' (no Z suffix) into
 * its bare components. Returns null when the string does not yield numbers.
 *
 * No `Date` is constructed here — see `WallClock` for why. The components are
 * the raw material for `wallClockToInstant()` (which reads them in the
 * organizer's zone) and for `wallClockCarrier()` (which shows them verbatim
 * when there is no zone to read them in).
 */
export function parseWallClock(dtstart: string): WallClock | null {
  const tIdx = dtstart.indexOf('T')
  const datePart = tIdx >= 0 ? dtstart.slice(0, tIdx) : dtstart
  const timePart = tIdx >= 0 ? dtstart.slice(tIdx + 1) : '00:00:00'
  const [y, m, d] = datePart.split('-').map(Number)
  const parts = timePart.split(':').map(Number)
  const hh = parts[0] ?? 0
  const mm = parts[1] ?? 0
  const ss = parts[2] ?? 0
  if ([y, m, d, hh, mm, ss].some(n => !Number.isFinite(n))) return null
  return { year: y, month: m, day: d, hour: hh, minute: mm, second: ss }
}

/**
 * The epoch value the wall-clock numbers would denote if read in UTC.
 *
 * Two uses, both of which need the numbers untouched by the viewer's zone:
 * the naive reading `wallClockToInstant` starts from, and the carrier `Date`
 * used to *print* the organizer's numbers verbatim (format it with
 * `timeZone: 'UTC'` — see `inviteTimeFormatOptions`).
 */
function wallClockAsUtcMs(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
}

/**
 * A `Date` that prints as the organizer's numbers when formatted in UTC.
 *
 * This is the last-resort display value when the TZID cannot be resolved to an
 * IANA zone: we promise to show what the organizer wrote, and a UTC carrier
 * keeps that promise for every viewer zone and every date, including the
 * viewer's own DST transition days — unlike a viewer-local `Date`, which has no
 * representation at all for a wall clock inside the viewer's gap.
 */
export function wallClockCarrier(wall: WallClock): Date | null {
  const ms = wallClockAsUtcMs(wall)
  if (!Number.isFinite(ms)) return null
  return new Date(ms)
}

/**
 * Resolve a TZID to its canonical IANA zone id, or null when Intl rejects it.
 *
 * RFC 5545 TZID is an opaque label and does NOT have to be IANA — Outlook /
 * Exchange typically emit Windows-style names like `Russian Standard Time`,
 * `Pacific Standard Time`, `W. Europe Standard Time` which throw RangeError
 * when passed to Intl. Without this guard the InviteCard render escapes to the
 * Sentry error boundary the moment any Outlook invite is opened.
 *
 * Canonicalizing (rather than just answering yes/no) also keeps the zone
 * comparison in `getTzidAnnotation` honest: ICU maps legacy links such as
 * `W-SU` → `Europe/Moscow` and `Etc/UTC` → `UTC`, so a viewer in Moscow does
 * not get told the meeting was "originally scheduled" somewhere else.
 *
 * Cached because the formatter calls it on every render and the set of distinct
 * tzids in a session is tiny (one per open invite).
 */
const ianaZoneCache = new Map<string, string | null>()
export function canonicalIanaZone(tz: string): string | null {
  const cached = ianaZoneCache.get(tz)
  if (cached !== undefined) return cached
  let canonical: string | null = null
  try {
    // RangeError fires at construction, not at format().
    canonical = new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone ?? null
  } catch {
    canonical = null
  }
  ianaZoneCache.set(tz, canonical)
  return canonical
}

/**
 * Formatters are cached per zone: resolving one wall clock probes the zone
 * several times (see `wallClockToInstant`), and constructing an
 * Intl.DateTimeFormat is by far the most expensive part of that.
 * `null` memoizes a zone Intl rejects, so a bad TZID is only paid for once.
 */
const zoneFormatterCache = new Map<string, Intl.DateTimeFormat | null>()
function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  const cached = zoneFormatterCache.get(zone)
  if (cached !== undefined) return cached
  let fmt: Intl.DateTimeFormat | null = null
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    fmt = null
  }
  zoneFormatterCache.set(zone, fmt)
  return fmt
}

/**
 * Offset (ms) of `zone` from UTC at the given instant, or null if the zone is
 * unusable. Derived by formatting the instant in `zone` and reading the wall
 * clock back — the standard trick, since Intl exposes no offset accessor.
 *
 * Identity used throughout this module: for an instant `t`,
 * `wallClockOf(t, zone) === t + zoneOffsetMsAt(t, zone)` (both expressed as
 * "UTC epoch of the printed numbers"). Hence `t` denotes the wall clock `w`
 * in `zone` exactly when `zoneOffsetMsAt(t, zone) === w - t`.
 */
export function zoneOffsetMsAt(instantMs: number, zone: string): number | null {
  const fmt = zoneFormatter(zone)
  if (!fmt) return null
  try {
    const parts = fmt.formatToParts(new Date(instantMs))
    const num = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find(p => p.type === type)?.value)
    const y = num('year')
    const mo = num('month')
    const d = num('day')
    const h = num('hour')
    const mi = num('minute')
    const s = num('second')
    if ([y, mo, d, h, mi, s].some(n => !Number.isFinite(n))) return null
    return Date.UTC(y, mo - 1, d, h, mi, s) - instantMs
  } catch {
    return null
  }
}

/** Probe radius around the wall clock — every real zone has at most one UTC
 *  offset transition inside a 48-hour window, so probing ±24h always yields
 *  both offsets adjacent to a nearby transition and nothing further away. */
const OFFSET_PROBE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Interpret wall-clock numbers as belonging to `zone` and return the instant
 * they denote.
 *
 * Every candidate instant is **verified**: it is read back in `zone` and
 * accepted only when its wall clock equals the organizer's numbers. Nothing is
 * returned on the strength of an offset guess alone.
 *
 * Disambiguation policy (RFC 5545 leaves the choice to the client; this is the
 * `compatible` rule of java.time / Temporal, i.e. what Outlook, Google Calendar
 * and Thunderbird do):
 *
 * - **Unambiguous** wall clock → the single instant that reads back to it.
 * - **Ambiguous** wall clock (autumn fall-back, the numbers occur twice — e.g.
 *   2026-11-01 01:30 America/New_York is both 05:30Z EDT and 06:30Z EST) →
 *   the **first (earlier) occurrence**, i.e. the pre-transition offset.
 * - **Nonexistent** wall clock (spring-forward gap, e.g. 2026-03-08 02:30
 *   America/New_York, a time that never happens) → interpreted with the offset
 *   in force **before** the transition, which places the instant just after the
 *   gap: 02:30 read as EST → 07:30Z → shows as 03:30 EDT locally, one gap-length
 *   later than written. No instant denotes the organizer's literal numbers, so
 *   some shift is unavoidable; shifting forward keeps the event on the correct
 *   side of the transition. The previous two-pass code silently returned 06:30Z
 *   here, which reads back as 01:30 in the organizer's zone — an hour *before*
 *   what the organizer wrote.
 *
 * Returns null when `zone` cannot be used at all — the caller then keeps the
 * organizer's wall clock verbatim rather than inventing a converted time.
 */
export function wallClockToInstant(wall: WallClock, zone: string): Date | null {
  const naiveUtc = wallClockAsUtcMs(wall)
  if (!Number.isFinite(naiveUtc)) return null

  // Offsets that could plausibly be in force for these wall-clock numbers:
  // the one at the naive reading plus the ones on either side of a nearby
  // transition. Duplicates collapse — most zones contribute a single value.
  const offsets: number[] = []
  for (const probe of [
    naiveUtc - OFFSET_PROBE_WINDOW_MS,
    naiveUtc,
    naiveUtc + OFFSET_PROBE_WINDOW_MS,
  ]) {
    const off = zoneOffsetMsAt(probe, zone)
    if (off !== null && !offsets.includes(off)) offsets.push(off)
  }
  if (offsets.length === 0) return null

  // Verification pass: keep only candidates whose wall clock in `zone` really
  // is the organizer's (see the identity documented on zoneOffsetMsAt).
  const verified: number[] = []
  for (const off of offsets) {
    const candidate = naiveUtc - off
    if (zoneOffsetMsAt(candidate, zone) === off) verified.push(candidate)
  }

  const instant = verified.length > 0
    // Ambiguous → earliest candidate = first occurrence. Unambiguous → the one.
    ? Math.min(...verified)
    // Gap → pre-transition offset. A gap always moves the offset forward, so
    // the offset in force before it is the smaller of the two.
    : naiveUtc - Math.min(...offsets)

  const result = new Date(instant)
  return isNaN(result.getTime()) ? null : result
}

/** True when the ICS datetime carries a UTC marker or a numeric UTC offset. */
export function hasExplicitOffset(value: string): boolean {
  return value.endsWith('Z') || value.includes('+') || value.includes('-', 10)
}

/**
 * One resolved ICS datetime, tagged with how it must be rendered.
 *
 * - `instant` — a real point in time. Format it in the viewer's zone (pass no
 *   `timeZone` to Intl); that is what every mainstream client does.
 * - `wallClock` — no zone could be resolved, so there is no instant to speak of:
 *   `date` is a UTC carrier of the organizer's literal numbers and must be
 *   formatted with `timeZone: 'UTC'` to print them back unchanged.
 *
 * The tag exists so the "verbatim" promise cannot be lost at the render site:
 * a bare `Date` would look identical in both cases and get formatted in the
 * viewer's zone, which shifts the organizer's numbers by the viewer's offset.
 */
export type ResolvedInviteTime =
  | { kind: 'instant'; date: Date }
  | { kind: 'wallClock'; date: Date }

/**
 * Resolve one ICS datetime to the value to render.
 *
 * - With an explicit offset the string already *is* an instant — main resolved
 *   the inline VTIMEZONE when it encoded it (electron/services/inviteBridge.ts).
 * - Without one, the numbers are the organizer's wall clock in `zone`; convert
 *   when `zone` is a usable IANA id (DST policy: see `wallClockToInstant`),
 *   otherwise keep the numbers as printed (`kind: 'wallClock'`).
 */
export function resolveInviteTime(value: string, zone: string | null): ResolvedInviteTime | null {
  try {
    if (hasExplicitOffset(value)) {
      const parsed = new Date(value)
      return isNaN(parsed.getTime()) ? null : { kind: 'instant', date: parsed }
    }
    const wall = parseWallClock(value)
    if (!wall) return null
    const carrier = wallClockCarrier(wall)
    if (!carrier) return null
    if (!zone) return { kind: 'wallClock', date: carrier }
    const instant = wallClockToInstant(wall, zone)
    return instant ? { kind: 'instant', date: instant } : { kind: 'wallClock', date: carrier }
  } catch {
    return null
  }
}

/**
 * Intl options for rendering a resolved value: viewer's zone for an instant,
 * UTC for a wall-clock carrier (which makes UTC print the organizer's numbers).
 */
export function inviteTimeFormatOptions(
  resolved: ResolvedInviteTime,
  opts: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatOptions {
  return resolved.kind === 'wallClock' ? { ...opts, timeZone: 'UTC' } : opts
}

/**
 * Calendar-day identity in the zone the value is *rendered* in, for deciding
 * between the same-day and multi-day layouts. Values of different kinds are
 * never equal: their days are counted in different zones, so claiming they fall
 * on the same day would be unfounded (this only arises for malformed invites
 * that mix an explicit-offset DTSTART with a wall-clock DTEND).
 */
export function inviteTimeDayKey(resolved: ResolvedInviteTime): string {
  return resolved.kind === 'wallClock'
    ? `utc:${resolved.date.toISOString().slice(0, 10)}`
    : `local:${resolved.date.toDateString()}`
}
