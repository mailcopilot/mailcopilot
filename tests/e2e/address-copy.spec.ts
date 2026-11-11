/**
 * Right-click on a sender or recipient address in the reading pane offers
 * "Copy address", and the clipboard receives the bare address. The sender uses
 * a display name that imitates another address, so the test also pins that the
 * copied value is the real envelope address, not the label.
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, EXPECT_TIMEOUT, type AppContext } from './helpers'

const REAL_SENDER = 'attacker@evil.example'
const RECIPIENT = 'carol@example.test'
const SUBJECT = `E2E Copy Address ${Date.now()}`

test('address context menu copies the bare sender and recipient address', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-addr-copy-'))
    const page = ctx.page!
    await page.evaluate(async (a) => {
      await window.api.invoke('e2e:injectMail', {
        accountId: 1, folder: 'INBOX', uid: 9980,
        from: `"victim@example.com" <${a.sender}>`,
        // The e2e fixture does not parse `Name <addr>` in `to`: use a bare address.
        to: a.to,
        subject: a.subject, date: new Date().toISOString(),
        unread: true, flagged: false, text: 'Body.',
      })
    }, { sender: REAL_SENDER, to: RECIPIENT, subject: SUBJECT })

    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: SUBJECT }).first())
    await expect(page.getByTestId('mail-body-text')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const readClipboard = async () => {
      await page.bringToFront()
      return page.evaluate(() => navigator.clipboard.readText())
    }
    const copyVia = async (target: import('@playwright/test').Locator) => {
      await target.click({ button: 'right' })
      await expect(page.getByTestId('address-context-menu')).toBeVisible({ timeout: EXPECT_TIMEOUT })
      await page.getByTestId('address-context-copy').click()
      await expect(page.getByTestId('address-context-menu')).toHaveCount(0)
    }

    await copyVia(page.locator('.mail-viewer-from').getByTestId('mail-address').first())
    await expect.poll(readClipboard, { timeout: EXPECT_TIMEOUT }).toBe(REAL_SENDER)

    await copyVia(page.getByTestId('recipient-chip').first())
    await expect.poll(readClipboard, { timeout: EXPECT_TIMEOUT }).toBe(RECIPIENT)
  } finally {
    await cleanupApp(ctx)
  }
})
