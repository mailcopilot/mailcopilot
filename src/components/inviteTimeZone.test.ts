import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  canonicalIanaZone,
  hasExplicitOffset,
  inviteTimeFormatOptions,
  parseWallClock,
  resolveInviteTime,
  wallClockCarrier,
  wallClockToInstant,
  zoneOffsetMsAt,
  type ResolvedInviteTime,
} from './inviteTimeZone'

const HOUR = 60 * 60 * 1000

/** Wall clock an instant reads back as in `zone`, as 'YYYY-MM-DD HH:MM'. */
function wallClockIn(instant: Date, zone: string): string {
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

/**
 * Pin the *viewer's* zone for a describe block.
 *
 * The organizer's zone is an argument, but the viewer's zone used to leak into
 * the maths through `new Date(y, m-1, d, …)`: for a Berlin viewer on 2026-03-29
 * the constructor normalizes 02:30 to 03:30 before anything is converted. Node
 * re-reads `process.env.TZ` on assignment (v16.2+) and resets the ICU default
 * zone, so both `Date` and `Intl` follow.
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
 * How the card prints a resolved value — viewer's zone for an instant, UTC
 * carrier for an unresolvable TZID. Mirrors `formatInviteDateRange`.
 */
function renderClock(resolved: ResolvedInviteTime): string {
  const parts = new Intl.DateTimeFormat(
    'en-US',
    inviteTimeFormatOptions(resolved, {
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
  ).formatToParts(resolved.date)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** Organizer wall clock string → instant, as `resolveInviteTime` does it. */
function resolve(wall: string, zone: string): Date {
  const parsed = parseWallClock(wall)
  expect(parsed).not.toBeNull()
  const instant = wallClockToInstant(parsed!, zone)
  expect(instant).not.toBeNull()
  return instant!
}

describe('inviteTimeZone — wallClockToInstant', () => {
  it('resolves an unambiguous wall clock and round-trips back to it', () => {
    // 09:00 in New York on a plain summer day = EDT (UTC-4) = 13:00Z.
    const instant = resolve('2026-08-10T09:00:00', 'America/New_York')
    expect(instant.toISOString()).toBe('2026-08-10T13:00:00.000Z')
    expect(wallClockIn(instant, 'America/New_York')).toBe('2026-08-10 09:00')
  })

  it('resolves a wall clock just after a spring-forward transition', () => {
    // 03:30 on the US spring-forward date is already EDT (UTC-4) = 07:30Z.
    const instant = resolve('2026-03-08T03:30:00', 'America/New_York')
    expect(instant.toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(wallClockIn(instant, 'America/New_York')).toBe('2026-03-08 03:30')
  })

  // -- Nonexistent wall clock (spring-forward gap) ---------------------------
  // Policy: interpret with the offset in force BEFORE the transition, which
  // lands the instant just after the gap. The old two-pass code returned
  // 06:30Z, which reads back as 01:30 in the organizer's own zone — an hour
  // before what the organizer wrote.

  it('shifts a nonexistent wall clock forward past the gap (America/New_York)', () => {
    // 2026-03-08 02:30 America/New_York never happens: 02:00 EST jumps to
    // 03:00 EDT. Pre-transition offset (EST, UTC-5) → 07:30Z → 03:30 EDT.
    const instant = resolve('2026-03-08T02:30:00', 'America/New_York')
    expect(instant.toISOString()).toBe('2026-03-08T07:30:00.000Z')
    // Reverse check in the organizer's zone: never 01:30 (before the written
    // time), always the gap-length-later reading.
    expect(wallClockIn(instant, 'America/New_York')).toBe('2026-03-08 03:30')
    // The bug this pins: 06:30Z reads back as 01:30 in New York.
    expect(instant.getTime()).not.toBe(Date.parse('2026-03-08T06:30:00.000Z'))
  })

  it('shifts a nonexistent wall clock forward past the gap (Europe/Berlin)', () => {
    // 2026-03-29 02:30 Europe/Berlin never happens: 02:00 CET → 03:00 CEST.
    const instant = resolve('2026-03-29T02:30:00', 'Europe/Berlin')
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(wallClockIn(instant, 'Europe/Berlin')).toBe('2026-03-29 03:30')
  })

  it('never resolves a nonexistent wall clock to an instant before it', () => {
    // Whatever the policy, the result must not land earlier than the naive
    // reading interpreted with the post-transition offset.
    const instant = resolve('2026-03-08T02:30:00', 'America/New_York')
    const postTransition = Date.parse('2026-03-08T06:30:00.000Z')
    expect(instant.getTime()).toBeGreaterThan(postTransition)
    expect(instant.getTime() - postTransition).toBe(HOUR)
  })

  // -- Ambiguous wall clock (autumn fall-back) ------------------------------
  // Policy: first (earlier) occurrence, i.e. the pre-transition offset.

  it('picks the first occurrence of an ambiguous wall clock (America/New_York)', () => {
    // 2026-11-01 01:30 America/New_York happens twice: 05:30Z (EDT, UTC-4)
    // and 06:30Z (EST, UTC-5). First occurrence wins.
    const instant = resolve('2026-11-01T01:30:00', 'America/New_York')
    expect(instant.toISOString()).toBe('2026-11-01T05:30:00.000Z')
    // Both occurrences read back as 01:30 — that is what "ambiguous" means —
    // so the reverse check confirms the wall clock is honoured either way.
    expect(wallClockIn(instant, 'America/New_York')).toBe('2026-11-01 01:30')
    // …and the offset proves it is the earlier one (EDT, not EST).
    expect(zoneOffsetMsAt(instant.getTime(), 'America/New_York')).toBe(-4 * HOUR)
  })

  it('picks the first occurrence of an ambiguous wall clock (Europe/Berlin)', () => {
    // 2026-10-25 02:30 Europe/Berlin happens twice: 00:30Z (CEST, UTC+2) and
    // 01:30Z (CET, UTC+1). This is the case the naive probe gets wrong: the
    // offset at the naive reading is already the post-transition one.
    const instant = resolve('2026-10-25T02:30:00', 'Europe/Berlin')
    expect(instant.toISOString()).toBe('2026-10-25T00:30:00.000Z')
    expect(wallClockIn(instant, 'Europe/Berlin')).toBe('2026-10-25 02:30')
    expect(zoneOffsetMsAt(instant.getTime(), 'Europe/Berlin')).toBe(2 * HOUR)
  })

  it('round-trips wall clocks on both sides of every transition it is given', () => {
    const cases: Array<[string, string]> = [
      ['2026-03-08T01:30:00', 'America/New_York'], // last EST half hour
      ['2026-03-08T04:30:00', 'America/New_York'], // first full EDT hour
      ['2026-11-01T00:30:00', 'America/New_York'], // before the fall-back
      ['2026-11-01T03:30:00', 'America/New_York'], // after the fall-back
      ['2026-10-25T00:30:00', 'Europe/Berlin'],
      ['2026-10-25T04:30:00', 'Europe/Berlin'],
      ['2026-08-10T13:30:00', 'Europe/Moscow'], // zone without DST
    ]
    for (const [wall, zone] of cases) {
      const instant = resolve(wall, zone)
      expect(wallClockIn(instant, zone)).toBe(wall.replace('T', ' ').slice(0, 16))
    }
  })

  it('returns null for a zone Intl rejects', () => {
    expect(wallClockToInstant(parseWallClock('2026-08-10T13:30:00')!, 'Russian Standard Time'))
      .toBeNull()
  })
})

describe('inviteTimeZone — parseWallClock', () => {
  it('keeps the printed numbers exactly, with no zone applied', () => {
    expect(parseWallClock('2026-03-29T02:30:00')).toEqual({
      year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0,
    })
  })

  it('defaults a missing time part to midnight', () => {
    expect(parseWallClock('2026-03-29')).toEqual({
      year: 2026, month: 3, day: 29, hour: 0, minute: 0, second: 0,
    })
  })

  it('returns null when the string yields no numbers', () => {
    expect(parseWallClock('not-a-date')).toBeNull()
  })
})

describe('inviteTimeZone — resolveInviteTime', () => {
  it('takes an explicit-offset string as an instant verbatim', () => {
    const resolved = resolveInviteTime('2026-05-15T18:00:00.000Z', 'America/New_York')
    expect(resolved?.kind).toBe('instant')
    expect(resolved?.date.toISOString()).toBe('2026-05-15T18:00:00.000Z')
  })

  it('applies the gap policy to a wall-clock string', () => {
    const resolved = resolveInviteTime('2026-03-08T02:30:00', 'America/New_York')
    expect(resolved?.kind).toBe('instant')
    expect(resolved?.date.toISOString()).toBe('2026-03-08T07:30:00.000Z')
  })

  it('keeps the organizer wall clock, tagged, when there is no usable zone', () => {
    const resolved = resolveInviteTime('2026-03-08T02:30:00', null)
    expect(resolved?.kind).toBe('wallClock')
    expect(renderClock(resolved!)).toBe('2026-03-08 02:30')
  })

  it('falls back to the verbatim wall clock when the zone is a Windows label', () => {
    const resolved = resolveInviteTime('2026-08-10T13:30:00', 'Russian Standard Time')
    expect(resolved?.kind).toBe('wallClock')
    expect(renderClock(resolved!)).toBe('2026-08-10 13:30')
  })

  it('returns null for an unparsable value', () => {
    expect(resolveInviteTime('not-a-date', 'America/New_York')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The viewer's own zone must not participate in the maths. It used to: the
// organizer's numbers were first fed to `new Date(y, m-1, d, hh, mm)`, i.e.
// read in the VIEWER's zone, and JavaScript silently normalizes a wall clock
// that falls in the viewer's spring-forward gap — for a Berlin viewer,
// `new Date(2026, 2, 29, 2, 30)` is 03:30 CEST. Everything downstream, the
// round-trip verification included, then worked on numbers the organizer never
// wrote. Each suite below runs the same battery under a different viewer zone;
// results must be identical.
// ---------------------------------------------------------------------------
function viewerZoneIndependenceSuite(): void {
  it('resolves a wall clock that falls in the VIEWER gap but is plain in the organizer zone', () => {
    // 2026-03-29 02:30 is unambiguous in America/New_York (the US transition was
    // three weeks earlier, so this is plain EDT, UTC-4) → 06:30Z. It is exactly
    // the nonexistent hour in Europe/Berlin, which is the viewer's problem and
    // must not touch the conversion.
    const instant = resolve('2026-03-29T02:30:00', 'America/New_York')
    expect(instant.toISOString()).toBe('2026-03-29T06:30:00.000Z')
    // Reverse check in the ORGANIZER's zone: exactly what was written.
    expect(wallClockIn(instant, 'America/New_York')).toBe('2026-03-29 02:30')
    // The pre-fix value: Berlin normalized 02:30 → 03:30, read as 03:30 EDT.
    expect(instant.getTime()).not.toBe(Date.parse('2026-03-29T07:30:00.000Z'))
  })

  it('resolves a wall clock in the viewer fall-back hour without picking a viewer occurrence', () => {
    // 2026-10-25 02:30 happens twice in Europe/Berlin (the viewer) but exactly
    // once in America/New_York (the organizer) → 06:30Z.
    const instant = resolve('2026-10-25T02:30:00', 'America/New_York')
    expect(instant.toISOString()).toBe('2026-10-25T06:30:00.000Z')
    expect(wallClockIn(instant, 'America/New_York')).toBe('2026-10-25 02:30')
  })

  it('keeps the organizer gap policy (shift forward past the gap)', () => {
    const instant = resolve('2026-03-08T02:30:00', 'America/New_York')
    expect(instant.toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(wallClockIn(instant, 'America/New_York')).toBe('2026-03-08 03:30')
  })

  it('keeps the organizer ambiguity policy (first occurrence)', () => {
    const instant = resolve('2026-11-01T01:30:00', 'America/New_York')
    expect(instant.toISOString()).toBe('2026-11-01T05:30:00.000Z')
    expect(zoneOffsetMsAt(instant.getTime(), 'America/New_York')).toBe(-4 * HOUR)
  })

  it('resolves a Berlin gap wall clock written by a Berlin organizer the same way everywhere', () => {
    const instant = resolve('2026-03-29T02:30:00', 'Europe/Berlin')
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(wallClockIn(instant, 'Europe/Berlin')).toBe('2026-03-29 03:30')
  })

  it('prints an unresolvable TZID verbatim, even on the viewer transition date', () => {
    // Windows label → no zone to convert from. The promise is "show what the
    // organizer wrote"; 02:30 on 2026-03-29 does not exist for a Berlin viewer,
    // so a viewer-local Date could not carry it at all.
    const resolved = resolveInviteTime('2026-03-29T02:30:00', 'Russian Standard Time')
    expect(resolved?.kind).toBe('wallClock')
    expect(renderClock(resolved!)).toBe('2026-03-29 02:30')
  })

  it('prints a zone-less wall clock verbatim on the viewer fall-back date', () => {
    const resolved = resolveInviteTime('2026-10-25T02:30:00', null)
    expect(resolved?.kind).toBe('wallClock')
    expect(renderClock(resolved!)).toBe('2026-10-25 02:30')
  })

  it('carries the organizer numbers through wallClockCarrier untouched', () => {
    const carrier = wallClockCarrier(parseWallClock('2026-03-29T02:30:00')!)
    expect(carrier?.toISOString()).toBe('2026-03-29T02:30:00.000Z')
  })
}

describe('inviteTimeZone — viewer TZ pinned to Europe/Berlin (DST)', () => {
  useViewerTimezone('Europe/Berlin')
  viewerZoneIndependenceSuite()
})

describe('inviteTimeZone — viewer TZ pinned to Europe/Moscow (no DST)', () => {
  useViewerTimezone('Europe/Moscow')
  viewerZoneIndependenceSuite()
})

describe('inviteTimeZone — helpers', () => {
  it('canonicalises IANA links and rejects Windows labels', () => {
    expect(canonicalIanaZone('Etc/UTC')).toBe('UTC')
    expect(canonicalIanaZone('America/New_York')).toBe('America/New_York')
    expect(canonicalIanaZone('Russian Standard Time')).toBeNull()
  })

  it('detects explicit offsets without tripping on the date separator', () => {
    expect(hasExplicitOffset('2026-05-15T18:00:00Z')).toBe(true)
    expect(hasExplicitOffset('2026-05-15T18:00:00+02:00')).toBe(true)
    expect(hasExplicitOffset('2026-05-15T18:00:00-05:00')).toBe(true)
    expect(hasExplicitOffset('2026-05-15T18:00:00')).toBe(false)
  })
})
