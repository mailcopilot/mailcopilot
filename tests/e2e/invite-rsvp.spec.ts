/**
 * §2.22 E2E — ICS / iTIP invite bridge RSVP flow.
 *
 * Tests the full path: email with a calendar invite → InviteCard visible →
 * user clicks Accept/Decline → RSVP reply sent (mocked in e2e mode) →
 * success state shown in UI.
 *
 * Architecture notes:
 * - Mail fixtures are injected via the e2e-only `e2e:injectCalendarMail` IPC
 *   channel (IS_E2E guard, main.ts §2.22 e2e helper). This avoids a real IMAP
 *   server while exercising the full renderer → IPC → inviteBridge path.
 * - In e2e mode the `mail:rsvpInvite` IPC handler (registerInviteHandlers) is
 *   still registered but `resolveInvite` resolves from the in-memory e2e box,
 *   and `sendRsvp` routes through the mock SMTP (stub returns ok:true).
 * - Because `resolveInvite` in production falls through a 4-tier cache and the
 *   e2e box is not a real cache tier, the main-process e2e handler for
 *   `net:messageDetails` now propagates `calendarInvite` directly from the
 *   injected fixture. The `resolveInviteForRsvp` function's tier (a)
 *   — in-memory LRU — is populated after `net:messageDetails` is called.
 */

import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, EXPECT_TIMEOUT, type AppContext } from './helpers'

// ---------------------------------------------------------------------------
// ICS fixture — minimal valid RFC 5545 VCALENDAR REQUEST
// ---------------------------------------------------------------------------

const INVITE_UID = 'e2e-invite-001@example.test'
const INVITE_SUMMARY = 'E2E: Team Quarterly Review'
const INVITE_ORGANIZER_EMAIL = 'organizer@example.test'
const INVITE_ORGANIZER_NAME = 'E2E Organizer'
const INVITE_LOCATION = 'Virtual Room 1'
const INVITE_UID_E2E_MAIL = 500 // numeric IMAP UID for the injected mail

const ICS_FIXTURE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//MailCopilot E2E//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  `UID:${INVITE_UID}`,
  'DTSTAMP:20260601T100000Z',
  'DTSTART:20260615T140000Z',
  'DTEND:20260615T150000Z',
  `SUMMARY:${INVITE_SUMMARY}`,
  `LOCATION:${INVITE_LOCATION}`,
  'DESCRIPTION:E2E test event for RSVP flow.',
  `ORGANIZER;CN=${INVITE_ORGANIZER_NAME}:mailto:${INVITE_ORGANIZER_EMAIL}`,
  'ATTENDEE;CN=E2E User;PARTSTAT=NEEDS-ACTION:mailto:e2e1@example.test',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const CALENDAR_INVITE_FIXTURE = {
  uid: INVITE_UID,
  summary: INVITE_SUMMARY,
  dtstart: '2026-06-15T14:00:00Z',
  dtend: '2026-06-15T15:00:00Z',
  organizerEmail: INVITE_ORGANIZER_EMAIL,
  organizerName: INVITE_ORGANIZER_NAME,
  location: INVITE_LOCATION,
  description: 'E2E test event for RSVP flow.',
  method: 'REQUEST' as const,
  rawIcs: ICS_FIXTURE,
}

// ---------------------------------------------------------------------------
// Helper: inject the invite mail into the e2e app via IPC
// ---------------------------------------------------------------------------

async function injectInviteMail(page: import('@playwright/test').Page) {
  await page.evaluate(
    async (payload) => {
      await window.api.invoke('e2e:injectCalendarMail', payload)
    },
    {
      accountId: 1,
      folder: 'INBOX',
      uid: INVITE_UID_E2E_MAIL,
      from: `${INVITE_ORGANIZER_NAME} <${INVITE_ORGANIZER_EMAIL}>`,
      to: 'e2e1@example.test',
      subject: `Invitation: ${INVITE_SUMMARY}`,
      date: new Date().toISOString(),
      text: `You are invited to: ${INVITE_SUMMARY}`,
      calendarInvite: CALENDAR_INVITE_FIXTURE,
    },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('invite-rsvp: InviteCard renders with summary, organizer and location', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-'))
    const page = ctx.page!

    await injectInviteMail(page)

    // Navigate to INBOX and open the injected invite mail
    await page.getByTestId('folder-INBOX').click()
    await page.waitForTimeout(500) // allow list refresh

    const inviteMail = page.getByTestId('mail-item').filter({ hasText: INVITE_SUMMARY }).first()
    await expect(inviteMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(inviteMail)

    // InviteCard should appear in the message body
    await expect(page.getByTestId('invite-card')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Summary should be visible — scope to invite-card to avoid strict mode violation (subject/body also contain the text)
    await expect(page.getByTestId('invite-card').getByText(INVITE_SUMMARY)).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Organizer name should appear in the card — scope to invite-card
    await expect(page.getByTestId('invite-card').getByText(new RegExp(INVITE_ORGANIZER_NAME, 'i'))).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Location should appear in the invite-card
    await expect(page.getByTestId('invite-card').getByText(INVITE_LOCATION)).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

test('invite-rsvp: RSVP action buttons are visible for a REQUEST invite', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-btn-'))
    const page = ctx.page!

    await injectInviteMail(page)

    await page.getByTestId('folder-INBOX').click()
    await page.waitForTimeout(500)

    const inviteMail = page.getByTestId('mail-item').filter({ hasText: INVITE_SUMMARY }).first()
    await expect(inviteMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(inviteMail)

    await expect(page.getByTestId('invite-card')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // All three RSVP buttons must be present (organizer != e2e1 account)
    await expect(page.getByTestId('invite-btn-accept')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('invite-btn-tentative')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('invite-btn-decline')).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

test('invite-rsvp: Accept click shows success state and hides buttons', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-accept-'))
    const page = ctx.page!

    await injectInviteMail(page)

    await page.getByTestId('folder-INBOX').click()
    await page.waitForTimeout(500)

    const inviteMail = page.getByTestId('mail-item').filter({ hasText: INVITE_SUMMARY }).first()
    await expect(inviteMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(inviteMail)

    await expect(page.getByTestId('invite-btn-accept')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.getByTestId('invite-btn-accept').click()

    // Success state: invite-response-status visible, action buttons gone
    await expect(page.getByTestId('invite-response-status')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('invite-actions')).not.toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('invite-btn-accept')).not.toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

test('invite-rsvp: Decline click shows declined success state', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-decline-'))
    const page = ctx.page!

    await injectInviteMail(page)

    await page.getByTestId('folder-INBOX').click()
    await page.waitForTimeout(500)

    const inviteMail = page.getByTestId('mail-item').filter({ hasText: INVITE_SUMMARY }).first()
    await expect(inviteMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(inviteMail)

    await expect(page.getByTestId('invite-btn-decline')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.getByTestId('invite-btn-decline').click()

    await expect(page.getByTestId('invite-response-status')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // RSVP buttons must be hidden after any response
    await expect(page.getByTestId('invite-btn-decline')).not.toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

test('invite-rsvp: organizer-self guard — no RSVP buttons when account is the organizer', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-self-'))
    const page = ctx.page!

    // Inject a mail where the organizer email matches the e2e account (e2e1@example.test)
    await page.evaluate(
      async (payload) => {
        await window.api.invoke('e2e:injectCalendarMail', payload)
      },
      {
        accountId: 1,
        folder: 'INBOX',
        uid: INVITE_UID_E2E_MAIL + 1,
        from: 'e2e1@example.test',
        to: 'alice@example.test',
        subject: 'Self-organized event',
        date: new Date().toISOString(),
        text: 'You organized this.',
        calendarInvite: {
          ...CALENDAR_INVITE_FIXTURE,
          uid: 'e2e-self-invite@example.test',
          summary: 'E2E: Self-Organized Event',
          // Organizer email matches the e2e1 account — buttons must be hidden
          organizerEmail: 'e2e1@example.test',
          organizerName: 'E2E One',
        },
      },
    )

    await page.getByTestId('folder-INBOX').click()
    await page.waitForTimeout(500)

    // Filter by mail subject (the summary lives in InviteCard body, not in the list item).
    const selfMail = page.getByTestId('mail-item').filter({ hasText: 'Self-organized event' }).first()
    await expect(selfMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(selfMail)

    await expect(page.getByTestId('invite-card')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // No RSVP buttons — organizer == self
    await expect(page.getByTestId('invite-actions')).not.toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('invite-btn-accept')).not.toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

test('invite-rsvp: re-opening the message resets RSVP state (PR1 by-design)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-invite-reset-'))
    const page = ctx.page!

    await injectInviteMail(page)

    await page.getByTestId('folder-INBOX').click()
    await page.waitForTimeout(500)

    const inviteMail = page.getByTestId('mail-item').filter({ hasText: INVITE_SUMMARY }).first()
    await expect(inviteMail).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // First open: accept
    await clickMailItem(inviteMail)
    await expect(page.getByTestId('invite-btn-accept')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.getByTestId('invite-btn-accept').click()
    await expect(page.getByTestId('invite-response-status')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Click another mail to deselect, then re-open the invite mail
    // Use nth(1) to pick the second mail-item (Playwright Locator has no .not() method; filter by position instead)
    const anotherMail = page.getByTestId('mail-item').nth(1)
    if (await anotherMail.isVisible()) {
      await clickMailItem(anotherMail)
      await page.waitForTimeout(300)
    }

    await clickMailItem(inviteMail)

    // After re-opening, RSVP state must be reset — action buttons visible again
    await expect(page.getByTestId('invite-btn-accept')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('invite-response-status')).not.toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})
