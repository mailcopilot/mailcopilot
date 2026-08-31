import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, clickMailItem, selectMcOption, getMcSelectValue, CLOSE_TIMEOUT, EXPECT_TIMEOUT, type AppContext } from './helpers'

// =============================================================================
// Sidebar: default expanded for new users
// =============================================================================

test('sidebar: starts expanded by default for new users', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const sidebar = page.locator('.mailcopilot-sidebar')
    const classes = await sidebar.getAttribute('class')
    expect(classes).toContain('sidebar-expanded')

    // localStorage should be null (no preference saved yet — fresh install)
    const stored = await page.evaluate(() => localStorage.getItem('mailcopilot:sidebar'))
    expect(stored).toBeNull()

    // Folder labels should be visible in expanded mode
    await expect(page.locator('.sidebar-label').first()).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Auto-advance: Settings UI
// =============================================================================

test('auto-advance: setting persists through save cycle', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Open Settings → Productivity tab
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    // Wait for React to mount before interacting with tabs (prevents "Target crashed" in CI)
    await expect(settings.getByTestId('settings-tab-productivity')).toBeVisible({ timeout: 45_000 })
    await settings.getByTestId('settings-tab-productivity').click()

    // Wait for async settings load to complete, then verify default
    const select = settings.getByTestId('settings-auto-advance')
    await expect(select).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => getMcSelectValue(select), { timeout: EXPECT_TIMEOUT }).toBe('older')

    // Change to 'newer' and verify the DOM change took effect
    await selectMcOption(select, 'newer')
    expect(await getMcSelectValue(select)).toBe('newer')
    // Sentinel: verify user-visible label is rendered correctly, not just data-selected-value.
    await expect(select.locator('.mc-select__value')).toHaveText('Open newer email')
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // Verify the value was persisted in the store
    const saved = await page.evaluate(async () => {
      const s = await window.api.invoke('settings:get') as Record<string, unknown>
      return s.autoAdvance
    })
    expect(saved).toBe('newer')

    // Reopen Settings and verify it persisted
    await page.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    await settings2.getByTestId('settings-tab-productivity').click()
    const select2 = settings2.getByTestId('settings-auto-advance')
    await expect(select2).toBeVisible()
    await expect.poll(() => getMcSelectValue(select2), { timeout: EXPECT_TIMEOUT }).toBe('newer')

    // Restore default
    await selectMcOption(settings2.getByTestId('settings-auto-advance'), 'older')
    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Auto-advance: behavior after archive (default = 'older')
// =============================================================================

test('auto-advance: opens next older email after archive', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Get all mail items and their subjects
    const items = page.getByTestId('mail-item')
    const count = await items.count()
    expect(count).toBeGreaterThanOrEqual(3)

    // Click first mail (most recent in date-desc order)
    await clickMailItem(items.first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    const firstSubject = await page.getByTestId('mail-subject').textContent()

    // Get second mail subject for comparison
    const secondSubject = await items.nth(1).locator('.mail-subject').textContent()

    // Archive the first mail — auto-advance 'older' should open the second
    await page.getByTestId('mail-action-archive').click()

    // The detail pane should show the next (older) email
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    const currentSubject = await page.getByTestId('mail-subject').textContent()
    expect(currentSubject).toBe(secondSubject)
    expect(currentSubject).not.toBe(firstSubject)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Auto-advance: 'back_to_list' clears detail pane
// =============================================================================

test('auto-advance: back_to_list clears detail pane after delete', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Set auto-advance to 'back_to_list'
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-productivity').click()
    const select = settings.getByTestId('settings-auto-advance')
    await expect(select).toBeVisible()
    await selectMcOption(select, 'back_to_list')
    expect(await getMcSelectValue(select)).toBe('back_to_list')
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // Wait for settings to propagate to main window
    await page.waitForTimeout(500)

    // Click first mail
    await clickMailItem(page.getByTestId('mail-item').first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    // Delete it — detail pane should close
    await page.getByTestId('mail-action-delete').click()

    // Detail pane should be gone (no subject visible)
    await expect(page.getByTestId('mail-subject')).toHaveCount(0, { timeout: EXPECT_TIMEOUT })

    // Restore default
    await page.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    await settings2.getByTestId('settings-tab-productivity').click()
    const select2 = settings2.getByTestId('settings-auto-advance')
    await expect(select2).toBeVisible()
    await selectMcOption(select2, 'older')
    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// GTD global chips: visible without email context
// =============================================================================

test('AI panel: global GTD chips visible without email selected', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Pre-configure AI provider
    await page.evaluate(async () => {
      // Only the fields this test needs. `settings:save` merges its payload
      // into the persisted settings, so echoing the whole object back adds
      // nothing — and any MAIN-ONLY field caught in that echo (§2.103
      // `spellcheckAvailable` is one) makes main refuse the WHOLE payload as
      // `forbidden_field`, silently dropping the configuration below.
      await window.api.invoke('settings:save', { aiProvider: 'openai-api',
        aiOpenAiBaseUrl: 'http://127.0.0.1:11434/v1', aiPrivacyConsent: true })
    })

    // Deselect any active email by clicking sidebar folder
    await page.getByTestId('folder-INBOX').click()

    // Open AI panel via sidebar button (without any email selected)
    await page.getByTestId('sidebar-ai').click()
    await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Global chips should be visible (weeklyReview, cleanupAll)
    const chips = page.getByTestId('ai-chips')
    await expect(chips).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const chipButtons = chips.locator('.ai-chip')
    const chipTexts = await chipButtons.allTextContents()
    // Should have at least 2 global chips
    expect(chipTexts.length).toBeGreaterThanOrEqual(2)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Sent folder: refreshes after sending
// =============================================================================

test('sent folder: new email appears after sending', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Open compose
    await page.keyboard.press('c')
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    // Fill in the email
    await compose.getByTestId('compose-to').fill('test@example.com')
    await compose.getByTestId('compose-subject').fill('E2E Sent Refresh Test')
    await compose.getByTestId('compose-send').click()
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // Navigate to Sent folder
    await page.getByTestId('folder-Sent').click()
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The sent email should appear in the Sent folder
    const sentMail = page.getByTestId('mail-item').filter({ hasText: 'E2E Sent Refresh Test' })
    await expect(sentMail.first()).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})
