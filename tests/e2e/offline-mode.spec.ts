import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, EXPECT_TIMEOUT } from './helpers'

test('offline mode: synced emails open without network', async () => {
  const ctx = await launchApp()
  try {
    const { page } = ctx

    // 1. Open an email first (online) to ensure EML is cached
    const mailItem = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(mailItem).toBeVisible()
    await clickMailItem(mailItem)
    await expect(page.getByTestId('mail-body-text')).toBeVisible()

    // Navigate back to another email, then back
    const secondMail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' }).first()
    await clickMailItem(secondMail)
    await expect(page.getByTestId('mail-body-text')).toBeVisible()

    // 2. Enable Work Offline mode
    const offlineBtn = page.getByTestId('sidebar-work-offline')
    await expect(offlineBtn).toBeVisible()
    await offlineBtn.click()
    // Button should become active (highlighted)
    await expect(offlineBtn).toHaveClass(/sidebar-btn-active/)

    // 3. Open the first email again — should still work from EML cache
    await clickMailItem(mailItem)
    await expect(page.getByTestId('mail-body-text')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // 4. Verify offline toggle is visible and active
    await expect(offlineBtn).toHaveClass(/sidebar-btn-active/)

    // 5. Toggle off
    await offlineBtn.click()
    await expect(offlineBtn).not.toHaveClass(/sidebar-btn-active/)

  } finally {
    await cleanupApp(ctx)
  }
})
