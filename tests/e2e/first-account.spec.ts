import { test, expect } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { launchAppNoAccounts, cleanupApp, waitForPage, type AppContext } from './helpers'

// Adding the FIRST mailbox through the Account window must put the mailbox in
// the main window without a page reload. Regression: the main window only
// refreshed its account list on `accounts:changed {kind:'saved'}` and never
// chose a current mailbox, so it stayed on "Connect your email" until reloaded.

/** Add a mailbox through the real wizard in the Account window main opens on an empty roster. */
async function addMailboxThroughWizard(browser: Browser, email: string, host: string): Promise<void> {
  const account = await waitForPage(browser, p => p.url().includes('#/account'))
  await account.waitForLoadState('domcontentloaded')
  await account.locator('#provider-card-generic-imap').click()
  await account.getByTestId('account-wizard-imap').click()
  await account.getByTestId('account-wizard-email').fill(email)
  await account.getByTestId('account-wizard-password').fill('secret')
  await account.getByTestId('account-wizard-next').click()
  // Autoconfig finds nothing for this domain: the manual step asks for hosts.
  await account.getByTestId('account-wizard-manual-imap-host').fill(`imap.${host}`)
  await account.getByTestId('account-wizard-manual-smtp-host').fill(`smtp.${host}`)
  await account.getByTestId('account-wizard-connect').click()
}

test('first account: the main window shows the mailbox right after saving, no reload', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchAppNoAccounts())
    const page = ctx.page!

    await expect(page.getByText('Connect your email')).toBeVisible()
    await addMailboxThroughWizard(ctx.browser!, 'first@first-run.example.test', 'first-run.example.test')

    await page.bringToFront()
    await expect(page.getByTestId('folder-INBOX')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Connect your email')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

// The same window state arises WITHOUT a restart when the last mailbox is
// removed: the initial load stops early on an empty list and the window keeps
// the removed mailbox's id, so the next save must not be read as a plain edit.
test('last account removed, another added in the same session: the mailbox shows without reload', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchAppNoAccounts())
    const page = ctx.page!
    const browser = ctx.browser!

    await addMailboxThroughWizard(browser, 'one@first-run.example.test', 'first-run.example.test')
    await page.bringToFront()
    await expect(page.getByTestId('folder-INBOX')).toBeVisible({ timeout: 15_000 })

    // Remove the only mailbox: the window falls back to the empty state and
    // opens the Account window again.
    await page.evaluate(async () => { await window.api.invoke('accounts:remove', 1) })
    await expect(page.getByText('Connect your email')).toBeVisible({ timeout: 15_000 })

    await addMailboxThroughWizard(browser, 'two@second-run.example.test', 'second-run.example.test')
    await page.bringToFront()
    await expect(page.getByTestId('folder-INBOX')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Connect your email')).toHaveCount(0)
    // `folder-INBOX` can be left over from the removed mailbox; only the initial
    // load (the step that opens INBOX and releases the sync) makes the NEW
    // mailbox the current one.
    await expect.poll(
      () => page.evaluate(() => window.api.invoke('accounts:getCurrent')),
      { timeout: 15_000 },
    ).toBe(2)
  } finally {
    await cleanupApp(ctx)
  }
})
