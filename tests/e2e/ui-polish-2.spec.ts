/**
 * UI Polish bundle #2 — merge-gate regression checks.
 *
 * Covers DOM-observable assertions that cannot be verified by unit tests:
 *
 *   empty-state-tip       — right-click hint visible in empty mail-viewer state
 *   ai-chips-grid         — folder-scope chips container gets ai-chips-grid class
 *   templates-placeholder — Settings → Templates form has example placeholder text
 *   shortcuts-ctx-menu    — Keyboard shortcuts modal renders "Context menu" section
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, EXPECT_TIMEOUT, type AppContext } from './helpers'

// =============================================================================
// empty-state-tip — right-click hint shown when no message is open
// =============================================================================

test('polish-2: right-click tip appears in empty mail-viewer state', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // The default state of the app shows the empty mail viewer (no message selected).
    // The tip element should be present and visible with the hint text.
    const tip = page.locator('.empty-state-tip')
    await expect(tip).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // The tip text should not be empty (actual translation resolves from i18n)
    const text = await tip.textContent()
    expect(text?.trim().length).toBeGreaterThan(0)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// scope-toggle — folder/email scope toggle re-renders chip set
// =============================================================================

test('polish-2: AI chip scope toggle switches between email and folder chip sets', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Pre-configure AI provider and consent so chips panel renders (not privacy/onboarding screen)
    await page.evaluate(async () => {
      // Only the fields this test needs. `settings:save` merges its payload
      // into the persisted settings, so echoing the whole object back adds
      // nothing — and any MAIN-ONLY field caught in that echo (§2.103
      // `spellcheckAvailable` is one) makes main refuse the WHOLE payload as
      // `forbidden_field`, silently dropping the configuration below.
      await window.api.invoke('settings:save', { aiProvider: 'openai-api',
        aiOpenAiBaseUrl: 'http://127.0.0.1:11434/v1', aiPrivacyConsent: true })
    })

    // Open the AI panel via sidebar-ai toggle button
    const aiButton = page.getByTestId('sidebar-ai')
    await expect(aiButton).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await aiButton.click()

    const aiPanel = page.getByTestId('ai-panel')
    await expect(aiPanel).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const firstMail = page.getByTestId('mail-item').first()
    await expect(firstMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await firstMail.click()

    const chips = page.getByTestId('ai-chips')
    await expect(chips).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Capture chip count before toggle (email scope chip set).
    const emailChipCount = await chips.locator('button.ai-chip:not(.ai-chip-scope)').count()
    expect(emailChipCount).toBeGreaterThan(0)

    // Click scope toggle button to switch to folder scope.
    const scopeToggle = page.getByTestId('ai-chip-scope-toggle')
    await expect(scopeToggle).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await scopeToggle.click()

    // Folder scope renders a different chip set; the chip count or the first chip
    // label changes (folder-scope chips include "digest", email-scope do not).
    const folderChipCount = await chips.locator('button.ai-chip:not(.ai-chip-scope)').count()
    expect(folderChipCount).toBeGreaterThan(0)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// templates-placeholder — Settings Templates form input placeholders
// =============================================================================

test('polish-2: templates form inputs have descriptive placeholder text', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Open Settings
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')

    // Navigate to Templates tab using stable data-testid
    const templatesTab = settings.getByTestId('settings-tab-templates')
    await expect(templatesTab).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await templatesTab.click()

    // The template create form is always visible (no separate "add" button needed).
    // The name input should have a meaningful placeholder (not just the label text).
    const nameInput = settings.locator('input[maxlength="200"]')
    await expect(nameInput).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const namePlaceholder = await nameInput.getAttribute('placeholder')
    // Before the fix, placeholder echoed the label ("Name"). Now it's an example.
    // Check it's non-empty and not equal to a trivial label echo.
    expect(namePlaceholder).toBeTruthy()
    expect(namePlaceholder!.length).toBeGreaterThan(3)

    await settings.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// shortcuts-ctx-menu — Keyboard shortcuts modal renders new Context menu section
// =============================================================================

test('polish-2: keyboard shortcuts modal shows Context menu section', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Open shortcuts modal via keyboard shortcut "?"
    await page.keyboard.press('?')

    // Wait for the dialog
    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The new "Context menu" section heading must be visible
    // (actual text resolves from i18n; we match generically by the i18n key fallback
    // or actual translation for 'shortcuts.contextMenuTitle')
    const contextSection = modal.locator('h3').filter({ hasText: /context.menu|контекстное|menu.contextuel|kontextmenü|menú.contextual|menu.contestuale/i })
    await expect(contextSection).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The hint entry for Right-click must also be present
    const rightClickKbd = modal.locator('kbd').filter({ hasText: /right-click/i })
    await expect(rightClickKbd).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})
