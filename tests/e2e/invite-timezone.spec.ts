/**
 * §2.22 E2E — invite time is rendered in the VIEWER's timezone, never the
 * organizer's, through the real render pipeline (not just the unit-level
 * `formatInviteDateRange` logic).
 *
 * ── Regression this closes ──────────────────────────────────────────────
 * Before this fix, `InviteCard` formatted the meeting in the ORGANIZER's zone
 * whenever the TZID happened to be one `Intl` understood. The same Exchange
 * server that sends Windows-style TZIDs (`Russian Standard Time` — Intl
 * rejects it, so the code accidentally fell back to viewer-local and was
 * right) also sends `TZID=UTC` for updates of the same meeting (Intl accepts
 * it, so a 15:00 Moscow meeting rendered as 12:00). A user arrived three
 * hours early on a real mailbox (2026-08). `src/components/InviteCard.test.tsx`
 * pins the fixed formatting logic directly; this spec proves the SAME bug
 * class does not resurface anywhere between the e2e-injected mail fixture and
 * the rendered DOM — main → IPC → `net:messageDetails` → `toPublicInvite` →
 * InviteCard, with a REAL Chromium `Intl`/`Date` implementation rather than
 * jsdom.
 *
 * ── Why the viewer zone is overridden via CDP, not `TZ` env ────────────────
 * `launchApp()` spawns the Electron MAIN process with a chosen env; the
 * renderer's `Intl.DateTimeFormat().resolvedOptions().timeZone` — what
 * `InviteCard` actually reads — comes from Chromium's own ICU state in the
 * renderer process, which does not reliably follow a `TZ` var forwarded
 * through Electron's multi-process bootstrapping. `Emulation.setTimezoneOverride`
 * is the standard CDP mechanism Playwright itself uses for
 * `contextOptions.timezoneId` and works directly on the connected page,
 * independent of process env plumbing — the only way to pin this deterministically
 * for a CDP-attached Electron page (`chromium.connectOverCDP`, not
 * `browser.newContext()`, so the context-option form is not available).
 * ──────────────────────────────────────────────────────────────────────
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, EXPECT_TIMEOUT, type AppContext } from './helpers'

/** Pin the renderer's Intl/Date timezone via CDP. Must be called before the
 *  invite is rendered — `InviteCard` reads the viewer zone on every render,
 *  not once at module load, so "before open" is sufficient; "before launch"
 *  is not necessary. */
async function setViewerTimezone(page: Page, timezoneId: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId })
}

/** Text of the "When" row's value span, including the original-zone caption. */
function whenRowText(page: Page) {
  return page.locator('.invite-meta-row', { has: page.getByText('When', { exact: true }) })
    .locator('.invite-meta-value')
}

/**
 * Every clock reading in a "When" row string, normalized to 24h `HH:MM`.
 *
 * Mirrors `whenRowClockTimes()` in `src/components/InviteCard.test.tsx` exactly
 * (same regex, same AM/PM folding). It exists for the same reason there: the
 * renderer's `i18n.language` is hardcoded to `'en'` at boot (`src/i18n/index.ts`
 * `DEFAULT_LANGUAGE`, only overridden once a persisted `settings.language`
 * loads — see `Root.tsx` `applySettings`, which never fires for a fresh e2e
 * data dir with no saved settings), and `formatInviteDateRange` feeds that
 * locale straight into `Intl.DateTimeFormat`. `en` renders
 * `hour: '2-digit'` as `03:00 PM`, so a raw substring match against `15:00`
 * fails even though the underlying instant — the only thing this spec is
 * actually about — is correct. Normalizing keeps the assertion about the
 * instant, not about the locale's clock convention.
 */
function normalizeClockTimes(text: string): string[] {
  const out: string[] = []
  const re = /(\d{1,2})[:.](\d{2})(?:\s*([ap])\.?m\.?)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let hour = Number(m[1])
    const meridiem = m[3]?.toLowerCase()
    if (meridiem === 'p' && hour < 12) hour += 12
    if (meridiem === 'a' && hour === 12) hour = 0
    out.push(`${String(hour).padStart(2, '0')}:${m[2]}`)
  }
  return out
}

async function injectInvite(
  page: Page,
  overrides: { uid: number; summary: string; dtstart: string; dtend: string; tzid?: string },
): Promise<void> {
  const rawIcs = [
    'BEGIN:VCALENDAR',
    'PRODID:-//MailCopilot E2E//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:tz-${overrides.uid}@example.test`,
    'DTSTAMP:20260601T100000Z',
    `SUMMARY:${overrides.summary}`,
    `ORGANIZER;CN=E2E Organizer:mailto:organizer@example.test`,
    'SEQUENCE:0',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  await page.evaluate(
    async (payload) => {
      await window.api.invoke('e2e:injectCalendarMail', payload)
    },
    {
      accountId: 1,
      folder: 'INBOX',
      uid: overrides.uid,
      from: 'E2E Organizer <organizer@example.test>',
      to: 'e2e1@example.test',
      subject: `Invitation: ${overrides.summary}`,
      date: new Date().toISOString(),
      text: `You are invited to: ${overrides.summary}`,
      calendarInvite: {
        uid: `tz-${overrides.uid}@example.test`,
        summary: overrides.summary,
        dtstart: overrides.dtstart,
        dtend: overrides.dtend,
        allDay: false,
        tzid: overrides.tzid,
        organizerEmail: 'organizer@example.test',
        organizerName: 'E2E Organizer',
        method: 'REQUEST',
        rawIcs,
      },
    },
  )
}

async function openInvite(page: Page, summary: string): Promise<void> {
  await page.getByTestId('folder-INBOX').click()
  await page.waitForTimeout(500)
  const mail = page.getByTestId('mail-item').filter({ hasText: summary }).first()
  await expect(mail).toBeVisible({ timeout: EXPECT_TIMEOUT })
  await clickMailItem(mail)
  await expect(page.getByTestId('invite-card')).toBeVisible({ timeout: EXPECT_TIMEOUT })
}

test('invite-timezone: TZID=UTC invite renders in the viewer zone (Moscow), not at the UTC numbers — regression anchor', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-tz-utc-'))
    const page = ctx.page!
    await setViewerTimezone(page, 'Europe/Moscow')

    // Same instant as the unit-test regression anchor
    // (InviteCard.test.tsx "renders a TZID=UTC invite in Moscow time"):
    // 12:00–13:00 UTC = 15:00–16:00 Moscow (UTC+3, no DST).
    await injectInvite(page, {
      uid: 9001,
      summary: 'E2E TZ Regression — UTC organizer label',
      dtstart: '2026-07-30T12:00:00.000Z',
      dtend: '2026-07-30T13:00:00.000Z',
      tzid: 'UTC',
    })

    await openInvite(page, 'E2E TZ Regression — UTC organizer label')

    const text = (await whenRowText(page).textContent()) ?? ''
    const times = normalizeClockTimes(text)
    // The bug: showing 12:00-13:00 (the organizer/UTC reading) instead of the
    // viewer's 15:00-16:00. Assert both directions so a partial fix (right
    // hour, wrong minute normalization, etc.) cannot slip through. Both sides
    // compare the normalized 24h reading — comparing the positive case
    // normalized but the negative case as a raw locale-formatted substring
    // would make the negative assertion vacuously true (`/12:00/` never
    // literally appears in a `12:00 PM`-style string for a 15:00 reading, so
    // it would "pass" regardless of whether the bug is actually fixed).
    expect(times).toEqual(['15:00', '16:00'])
    expect(times).not.toEqual(['12:00', '13:00'])

    // Original zone still captioned — the fix removes the MIS-USE of tzid as
    // a display zone, not the informational label.
    const annotation = page.getByTestId('invite-tzid-annotation')
    await expect(annotation).toBeVisible()
    await expect(annotation).toContainText('UTC')
  } finally {
    await cleanupApp(ctx)
  }
})

test('invite-timezone: Windows-style Outlook TZID does not crash the render and still shows viewer-zone time', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-tz-win-'))
    const page = ctx.page!
    await setViewerTimezone(page, 'Europe/Moscow')

    // Same instant as InviteCard.test.tsx "keeps the Windows-TZID invite
    // correct" regression anchor: 10:30-11:00 UTC = 13:30-14:00 Moscow.
    // `Intl.DateTimeFormat({ timeZone: 'Russian Standard Time' })` throws
    // RangeError — pre-fix this escaped to the Sentry error boundary on every
    // Outlook invite (incident 2026-05-08). Render succeeding at all is part
    // of the assertion.
    await injectInvite(page, {
      uid: 9002,
      summary: 'E2E TZ Regression — Windows TZID',
      dtstart: '2026-08-10T10:30:00.000Z',
      dtend: '2026-08-10T11:00:00.000Z',
      tzid: 'Russian Standard Time',
    })

    await openInvite(page, 'E2E TZ Regression — Windows TZID')

    const text = (await whenRowText(page).textContent()) ?? ''
    const times = normalizeClockTimes(text)
    expect(times).toEqual(['13:30', '14:00'])

    const annotation = page.getByTestId('invite-tzid-annotation')
    await expect(annotation).toBeVisible()
    await expect(annotation).toContainText('Russian Standard Time')
  } finally {
    await cleanupApp(ctx)
  }
})

// ─────────────────────────────────────────────────────────────────────────
// DST edge cases in the ORGANIZER zone — exercises the disambiguation policy
// documented on `wallClockToInstant` (src/components/inviteTimeZone.ts)
// through the real render pipeline, mirroring the fixtures already pinned in
// `inviteTimeZone.test.ts`. Unlike the two tests above, `dtstart`/`dtend` here
// carry NO `Z` suffix — `hasExplicitOffset` is false, so `resolveInviteTime`
// takes the wall-clock branch and `wallClockToInstant` does the actual DST
// resolution against `tzid` at render time (this is also the real shape
// `inviteBridge.ts` produces for a TZID Intl can resolve — see its "Floating
// wall-clock encoding" comment — the Z-suffixed shape above is what it
// produces once it has already resolved an inline VTIMEZONE).
// ─────────────────────────────────────────────────────────────────────────

test('invite-timezone: DST spring-forward gap in the organizer zone shifts forward by the gap length (Europe/Berlin)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-tz-gap-'))
    const page = ctx.page!
    // Viewer == organizer zone on purpose: this test is about the
    // organizer-zone gap policy itself, not about a viewer/organizer offset
    // difference — see the ambiguous-hour test below for that case.
    await setViewerTimezone(page, 'Europe/Berlin')

    // 2026-03-29 02:30 Europe/Berlin never happens: 02:00 CET jumps straight
    // to 03:00 CEST. Policy: interpret with the pre-transition (CET) offset,
    // which lands just after the gap — same fixture as inviteTimeZone.test.ts
    // "shifts a nonexistent wall clock forward past the gap (Europe/Berlin)".
    await injectInvite(page, {
      uid: 9003,
      summary: 'E2E TZ Regression — Berlin spring-forward gap',
      dtstart: '2026-03-29T02:30:00',
      dtend: '2026-03-29T04:00:00',
      tzid: 'Europe/Berlin',
    })

    await openInvite(page, 'E2E TZ Regression — Berlin spring-forward gap')

    const text = (await whenRowText(page).textContent()) ?? ''
    const times = normalizeClockTimes(text)
    // The organizer's literal 02:30 never happened. The fixed policy shows
    // one gap-length later (03:30) — not the pre-fix reading an hour BEFORE
    // what the organizer wrote (01:30), and not the literal, nonexistent
    // 02:30 either.
    expect(times).toEqual(['03:30', '04:00'])
    expect(times).not.toContain('02:30')
    expect(times).not.toContain('01:30')
  } finally {
    await cleanupApp(ctx)
  }
})

test('invite-timezone: ambiguous DST fall-back hour resolves to the EARLIER occurrence, observable from a fixed-offset viewer', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-tz-fallback-'))
    const page = ctx.page!
    // The viewer is deliberately in a zone WITHOUT DST (Moscow, UTC+3
    // year-round) and different from the organizer's zone. The two candidate
    // instants for an ambiguous America/New_York wall clock (05:30Z EDT vs
    // 06:30Z EST) read back to the SAME wall-clock string in New_York itself
    // — an organizer-zone-only check cannot distinguish "picked the earlier
    // occurrence" from "picked the later one". A fixed-offset viewer can.
    await setViewerTimezone(page, 'Europe/Moscow')

    // 2026-11-01 01:30 America/New_York happens twice: 05:30Z (EDT, first)
    // and 06:30Z (EST, second) — same fixture as inviteTimeZone.test.ts
    // "picks the first occurrence of an ambiguous wall clock (America/New_York)".
    await injectInvite(page, {
      uid: 9004,
      summary: 'E2E TZ Regression — NY fall-back ambiguous hour',
      dtstart: '2026-11-01T01:30:00',
      dtend: '2026-11-01T02:00:00',
      tzid: 'America/New_York',
    })

    await openInvite(page, 'E2E TZ Regression — NY fall-back ambiguous hour')

    const text = (await whenRowText(page).textContent()) ?? ''
    const times = normalizeClockTimes(text)
    // Earlier occurrence (05:30Z) → 08:30 Moscow. The later occurrence
    // (06:30Z) would show 09:30 — asserting both directions so a policy flip
    // (picking the last occurrence instead of the first) cannot slip through
    // as a coincidental pass.
    expect(times).toEqual(['08:30', '10:00'])
    expect(times).not.toContain('09:30')

    const annotation = page.getByTestId('invite-tzid-annotation')
    await expect(annotation).toBeVisible()
    await expect(annotation).toContainText('America/New_York')
  } finally {
    await cleanupApp(ctx)
  }
})

test('invite-timezone: an unresolvable TZID does not crash the card and shows the organizer wall clock verbatim', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-tz-bogus-'))
    const page = ctx.page!
    // Viewer zone differs from the (garbage) tzid on purpose — proves the
    // literal numbers are shown regardless of viewer zone, i.e. this is the
    // wallClock-carrier path (`kind: 'wallClock'`, formatted with
    // `timeZone: 'UTC'`), not a silently-wrong conversion.
    await setViewerTimezone(page, 'Europe/Moscow')

    await injectInvite(page, {
      uid: 9005,
      summary: 'E2E TZ Regression — garbage TZID label',
      dtstart: '2026-06-15T14:00:00',
      dtend: '2026-06-15T14:30:00',
      tzid: 'Definitely/Not-A-Real-Zone-E2E',
    })

    // The card must render at all — a bad TZID crashing the render was the
    // original Windows-TZID incident (2026-05-08, see the test above). This
    // fixture is not even a legacy Windows name, just noise, to widen
    // coverage beyond that one known-bad string.
    await openInvite(page, 'E2E TZ Regression — garbage TZID label')

    const text = (await whenRowText(page).textContent()) ?? ''
    const times = normalizeClockTimes(text)
    expect(times).toEqual(['14:00', '14:30'])

    const annotation = page.getByTestId('invite-tzid-annotation')
    await expect(annotation).toBeVisible()
    await expect(annotation).toContainText('Definitely/Not-A-Real-Zone-E2E')
  } finally {
    await cleanupApp(ctx)
  }
})
