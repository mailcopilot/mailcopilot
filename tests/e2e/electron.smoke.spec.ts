import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, clickMailItem, selectMcOption } from './helpers'

test('smoke: app launch and basic UI actions', async () => {
  const ctx = await launchApp()
  try {
    const { browser, page } = ctx

    // Verify that the unread badge on folders is displayed (and will update instantly).
    await expect(page.getByTestId('folder-badge-INBOX')).toHaveText('1')

    // Open an unread email in INBOX (and verify instant badge update).
    const unreadItem = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(unreadItem).toBeVisible()
    await expect(unreadItem).toHaveClass(/mail-unread/)
    await clickMailItem(unreadItem)
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    await expect(page.getByTestId('mail-body-text')).toBeVisible()
    await expect(unreadItem).not.toHaveClass(/mail-unread/)

    // INBOX badge should update immediately (before the next sync).
    await expect(page.getByTestId('folder-badge-INBOX')).toHaveCount(0)

    // Navigate away from folder and return: email should remain read.
    const sameMail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(sameMail).toBeVisible()
    await expect(sameMail).not.toHaveClass(/mail-unread/)
    await expect(page.getByTestId('folder-badge-INBOX')).toHaveCount(0)

    // Mark email as unread: badge should increase instantly.
    await clickMailItem(sameMail)
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    await page.getByTestId('mail-action-toggle-seen').click()
    await expect(page.getByTestId('folder-badge-INBOX')).toHaveText('1')

    // Reply should open compose with prefilled fields
    await page.getByTestId('mail-action-reply').click()
    const replyCompose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await replyCompose.waitForLoadState('domcontentloaded')
    await expect(replyCompose.getByTestId('compose-to')).toHaveValue('alice@example.test')
    await expect(replyCompose.getByTestId('compose-subject')).toHaveValue(/^Re:/)
    await replyCompose.evaluate(() => window.close())
    await expect.poll(() => replyCompose.isClosed(), { timeout: 10_000 }).toBe(true)
    await page.bringToFront()

    // Open settings
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    // Wait for React to mount and IPC settings:get to complete (renders form fields).
    // In CI/Docker the renderer may be slow to start; use generous timeout.
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })
    await selectMcOption(settings.getByTestId('settings-theme'), 'dark')
    // Sentinel: verify the trigger shows the user-visible "Dark" label, not just data-selected-value.
    await expect(settings.getByTestId('settings-theme').locator('.mc-select__value')).toHaveText('Dark')
    // §2.15-ter: cacheDays UI was replaced with a body retention enum select.
    // Pick a representative non-default value to exercise the persist path.
    await selectMcOption(settings.getByTestId('settings-body-retention-days'), '365')
    // Folder roles are located on the "Folders" tab.
    await settings.getByTestId('settings-tab-folders').click()
    // Folders load asynchronously via IPC — wait with explicit timeout.
    await expect(settings.getByTestId('settings-role-trash')).toBeVisible({ timeout: 30_000 })
    await selectMcOption(settings.getByTestId('settings-role-trash'), 'Trash')
    await expect(settings.getByTestId('settings-role-archive')).toBeVisible({ timeout: 10_000 })
    await selectMcOption(settings.getByTestId('settings-role-archive'), 'Archive')
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: 10_000 }).toBe(true)
    // Theme should be applied in the main window after closing the settings window.
    await page.bringToFront()
    await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.theme), { timeout: 10_000 }).toBe('dark')

    // Send email via separate compose window
    await page.locator('.sidebar-compose-btn').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    await compose.getByTestId('compose-to').fill('bob@example.test')
    await compose.getByTestId('compose-subject').fill('E2E тема')
    await compose.getByTestId('compose-text').fill('E2E текст')
    await compose.getByTestId('compose-send').click()
    await expect.poll(() => compose.isClosed(), { timeout: 10_000 }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})
