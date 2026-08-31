/**
 * Sender misdirection regression: a sender fully controls the DISPLAY NAME
 * of their own message. `packages/net/imap.ts` (§ "from_address") — and,
 * for e2e fixtures, the `senderPartsFromHeader()` wrapper in
 * `electron/e2eSenderParts.ts` that delegates to it (§2.172) — split the
 * parsed sender into
 * `fromAddr` (envelope address) and `fromName` (display label) so that every
 * place addressing decisions get made — reply, contact capture, static mail
 * rules (see mail-rules-editor.spec.ts for the `from_address` rule-matching
 * side of this) — uses the real address, never the attacker-chosen label.
 *
 * This spec injects a message whose display name IS a real address (spoofing
 * a victim) while the envelope address is the attacker's own, and checks the
 * real address surfaces everywhere addressing matters, through the real
 * IPC → renderer pipeline (not a unit-level parse check).
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, waitForPage, EXPECT_TIMEOUT, type AppContext } from './helpers'

const SPOOFED_UID = 9970
const REAL_ADDRESS = 'attacker@evil.example'
const SPOOFED_DISPLAY_NAME = 'victim@example.com'
const SUBJECT = `E2E Misdirection Display-Name Spoof ${Date.now()}`

async function injectSpoofedMail(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async (args) => {
    await window.api.invoke('e2e:injectMail', {
      accountId: 1,
      folder: 'INBOX',
      uid: args.uid,
      from: `"${args.displayName}" <${args.realAddress}>`,
      to: 'e2e1@example.test',
      subject: args.subject,
      date: new Date().toISOString(),
      unread: true,
      flagged: false,
      text: 'Body irrelevant — this fixture only exercises From parsing.',
    })
  }, { uid: SPOOFED_UID, subject: SUBJECT, realAddress: REAL_ADDRESS, displayName: SPOOFED_DISPLAY_NAME })
}

test('sender parsing: a display name that spoofs an email address never substitutes for the real one', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-misdirection-'))
    const page = ctx.page!
    const browser = ctx.browser!

    await injectSpoofedMail(page)

    const mailItem = page.getByTestId('mail-item').filter({ hasText: SUBJECT }).first()
    await expect(mailItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mailItem)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // Full details (envelope + body) loaded — `.mail-viewer-from` reflects
    // `details.envelope.from`, not just the list-derived fallback label,
    // only once this is visible (mail.flows.spec.ts uses the same signal
    // before relying on envelope-derived reply data).
    await expect(page.getByTestId('mail-body-text')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Detail header shows the real envelope address, not just the forged
    // display name (it legitimately shows both — "Name <address>" — like any
    // mail client; the requirement is that the real address is present).
    await expect(page.locator('.mail-viewer-from')).toContainText(REAL_ADDRESS, { timeout: EXPECT_TIMEOUT })

    // Reply targets the real address — computeReplyRecipients() extracts
    // `.address`, never `.name`, from the envelope.
    await page.getByTestId('mail-action-reply').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    await expect(compose.getByTestId('compose-to')).toHaveValue(REAL_ADDRESS)
    await expect(compose.getByTestId('compose-to')).not.toHaveValue(SPOOFED_DISPLAY_NAME)

    // The captured contact (net:inboxSummaries → upsertContactsIncoming) is
    // keyed by the real address. Querying by the forged display-name string
    // may still surface the row (contacts:search also prefix-matches on
    // `name`), but its `email` column must never be the forged string.
    const byRealAddress = await page.evaluate(async (q) => {
      return await window.api.invoke('contacts:search', q, 10)
    }, REAL_ADDRESS) as Array<{ email: string; name?: string }>
    expect(byRealAddress.some(c => c.email === REAL_ADDRESS)).toBe(true)
    expect(byRealAddress.every(c => c.email !== SPOOFED_DISPLAY_NAME)).toBe(true)

    const byForgedName = await page.evaluate(async (q) => {
      return await window.api.invoke('contacts:search', q, 10)
    }, SPOOFED_DISPLAY_NAME) as Array<{ email: string; name?: string }>
    expect(byForgedName.every(c => c.email !== SPOOFED_DISPLAY_NAME)).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})
