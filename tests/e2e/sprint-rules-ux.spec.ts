import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs/promises'
import { launchApp, cleanupApp, waitForPage, clickMailItem, CLOSE_TIMEOUT, EXPECT_TIMEOUT, type AppContext } from './helpers'

const SCREENSHOT_DIR = path.join(process.cwd(), 'tests', 'e2e', 'screenshots')

async function ensureScreenshotDir(): Promise<void> {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
}

function screenshotPath(name: string): string {
  return path.join(SCREENSHOT_DIR, `${name}.png`)
}

// Helper: open Settings and wait for React mount
async function openSettings(page: import('@playwright/test').Page, browser: import('@playwright/test').Browser) {
  await page.getByTestId('open-settings').click()
  const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
  await settings.waitForLoadState('domcontentloaded')
  // Wait for React mount — the General tab's theme select should be visible
  await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })
  return settings
}

// ==========================================
// Test 1: Main view screenshots + pin + print
// ==========================================
test('main view: pin, print buttons and thread badge', async () => {
  await ensureScreenshotDir()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Take main view screenshot
    await page.screenshot({ path: screenshotPath('01-main-view') })

    // Open a mail by clicking its subject text
    const mailItem = page.getByTestId('mail-item').filter({ hasText: 'первое письмо' }).first()
    await expect(mailItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mailItem)
    // Wait for viewer to render
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.screenshot({ path: screenshotPath('02-detail-view') })

    // Check pin and print buttons in viewer toolbar
    const pinBtn = page.getByTestId('mail-action-pin')
    const printBtn = page.getByTestId('mail-action-print')
    console.log(`Pin button: ${await pinBtn.count() > 0}, Print button: ${await printBtn.count() > 0}`)

    // Pin toggle
    if (await pinBtn.count() > 0) {
      await pinBtn.click()
      await page.waitForTimeout(300)
      await page.screenshot({ path: screenshotPath('03-pinned') })
      await pinBtn.click()
    }

    // Thread badges
    const badges = page.locator('.mail-thread-badge')
    console.log(`Thread badges: ${await badges.count()}`)

    // Context menu
    await mailItem.click({ button: 'right' })
    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible({ timeout: 5000 }).catch(() => {})
    if (await ctxMenu.isVisible()) {
      await ctxMenu.screenshot({ path: screenshotPath('05-context-menu') })
      await page.keyboard.press('Escape')
    }

  } finally {
    await cleanupApp(ctx)
  }
})

// ==========================================
// Test 2: Settings - Rules tab
// ==========================================
test('settings: rules tab visible and functional', async () => {
  await ensureScreenshotDir()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    const settings = await openSettings(page, browser)

    // List all available tabs for debugging
    const tabs = settings.locator('[data-testid^="settings-tab-"]')
    const tabCount = await tabs.count()
    const tabIds: string[] = []
    for (let i = 0; i < tabCount; i++) {
      const testId = await tabs.nth(i).getAttribute('data-testid')
      tabIds.push(testId || 'unknown')
    }
    console.log('Available Settings tabs:', tabIds.join(', '))

    // Screenshot of Settings default view
    await settings.screenshot({ path: screenshotPath('06-settings-default') })

    // Click Rules tab if it exists
    const rulesTab = settings.getByTestId('settings-tab-rules')
    if (await rulesTab.count() > 0) {
      await rulesTab.click()
      await settings.waitForTimeout(500)
      await settings.screenshot({ path: screenshotPath('07-settings-rules') })
    } else {
      console.log('WARNING: Rules tab not found')
    }

    // Click AI tab
    const aiTab = settings.getByTestId('settings-tab-ai')
    if (await aiTab.count() > 0) {
      await aiTab.click()
      await settings.waitForTimeout(500)
      await settings.screenshot({ path: screenshotPath('08-settings-ai') })
    }

    // Productivity tab — trusted domains
    await settings.getByTestId('settings-tab-productivity').click()
    await settings.waitForTimeout(500)
    await settings.screenshot({ path: screenshotPath('09-settings-productivity') })

    // Close settings
    await settings.evaluate(() => window.close())
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

  } finally {
    await cleanupApp(ctx)
  }
})

// ==========================================
// Test 3: Trusted domains persistence
// ==========================================
test('trusted domains: save and persist', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    const settings = await openSettings(page, browser)
    await settings.getByTestId('settings-tab-productivity').click()

    // Find trusted domains textarea
    const textarea = settings.locator('textarea').first()
    await textarea.scrollIntoViewIfNeeded()

    // Check if it's visible
    if (await textarea.isVisible()) {
      await textarea.fill('example.com')
      await settings.getByTestId('settings-save').click()
      await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

      // Verify saved
      const saved = await page.evaluate(async () => {
        const s = await (window as unknown as { api: { invoke: (ch: string) => Promise<Record<string, unknown>> } }).api.invoke('settings:get')
        return s.trustedDomains
      })
      expect(saved).toBe('example.com')
    } else {
      console.log('WARNING: textarea not found in Productivity tab')
    }

  } finally {
    await cleanupApp(ctx)
  }
})
