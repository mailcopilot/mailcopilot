/**
 * E2E smoke tests for the custom <Select> component in Settings and Compose.
 *
 * Background: uiaudit.11 replaced all native <select> elements with a custom
 * accessible <Select> component. Playwright's `.selectOption()` / `.toHaveValue()`
 * APIs only work with native <select>; this spec verifies the equivalent
 * interactions against the new component using `.getByRole('combobox')` /
 * `.getByRole('listbox')` / `.getByRole('option')` patterns.
 *
 * Tests are intentionally narrow (Settings General tab only — one dropdown
 * per trigger for fast signal) to keep e2e cost low while covering the most
 * critical regression path: persisted Settings dropdowns.
 *
 * NOTE: Existing tests in electron.smoke.spec.ts, new-features.spec.ts, and
 * ui.extra.spec.ts still use `.selectOption()` on testId-located elements.
 * Those will fail because the elements are now role=combobox buttons, not
 * native <select>. They require a separate migration (out of scope for this
 * spec). This file provides green coverage for the new interaction pattern.
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, EXPECT_TIMEOUT, CLOSE_TIMEOUT, type AppContext } from './helpers'

// ---------------------------------------------------------------------------
// Helper: interact with a custom <Select> by testId
// ---------------------------------------------------------------------------

/**
 * Opens the custom <Select> listbox identified by `testId`, then clicks the
 * option whose visible text matches `optionLabel`.
 *
 * The trigger has role=combobox; the popup has role=listbox; each entry has
 * role=option. This replaces `.selectOption(value)` for native <select>.
 */
async function pickSelectOption(
  page: import('@playwright/test').Page,
  testId: string,
  optionLabel: string,
): Promise<void> {
  const trigger = page.getByTestId(testId)
  await expect(trigger).toBeVisible({ timeout: EXPECT_TIMEOUT })
  // Open the dropdown.
  await trigger.click()
  // Wait for the listbox to appear.
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible({ timeout: 5_000 })
  // Click the option by visible text.
  await page.getByRole('option', { name: optionLabel }).click()
  // Listbox should close after selection.
  await expect(listbox).toHaveCount(0, { timeout: 5_000 })
}

/**
 * Returns the visible label text currently shown in a custom <Select> trigger.
 * The trigger button has role=combobox; its first child <span> carries the label.
 */
async function getSelectValue(
  page: import('@playwright/test').Page,
  testId: string,
): Promise<string | null> {
  const trigger = page.getByTestId(testId)
  await expect(trigger).toBeVisible({ timeout: EXPECT_TIMEOUT })
  // The value span is the first child of the trigger button.
  const valueSpan = trigger.locator('.mc-select__value').first()
  return valueSpan.textContent()
}

// ---------------------------------------------------------------------------
// Test: Settings → General tab → theme dropdown persists selection
// ---------------------------------------------------------------------------

test('select-component: Settings theme dropdown opens, picks dark, persists after reopen', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-select-theme-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // Open Settings window.
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')

    // Wait for the theme trigger to appear (settings loaded from IPC).
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })

    // The trigger must be a combobox, not a native select.
    const trigger = settings.getByTestId('settings-theme')
    await expect(trigger).toHaveAttribute('role', 'combobox')

    // Pick "dark" by clicking the option.
    await pickSelectOption(settings, 'settings-theme', 'Dark')

    // Save and close Settings.
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // The main window should now be in dark theme.
    await page.bringToFront()
    await expect.poll(
      async () => page.evaluate(() => document.documentElement.dataset.theme),
      { timeout: EXPECT_TIMEOUT },
    ).toBe('dark')

    // Reopen Settings and verify the theme dropdown still shows "Dark".
    await page.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    await expect(settings2.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })

    const persisted = await getSelectValue(settings2, 'settings-theme')
    // The label for "dark" theme may be translated; verify it contains "dark" case-insensitively
    // or matches the exact i18n string. In e2e mode i18n falls back to English keys.
    expect(persisted?.toLowerCase()).toContain('dark')

    await settings2.evaluate(() => window.close())
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

// ---------------------------------------------------------------------------
// Test: custom <Select> keyboard navigation inside Settings
// ---------------------------------------------------------------------------

test('select-component: Settings sort-mode dropdown responds to ArrowDown + Enter keyboard nav', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-select-kbd-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // Open Settings → Productivity tab.
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-tab-productivity')).toBeVisible({ timeout: 45_000 })
    await settings.getByTestId('settings-tab-productivity').click()

    const trigger = settings.getByTestId('settings-sort-mode')
    await expect(trigger).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Open via Enter key.
    await trigger.press('Enter')
    const listbox = settings.getByRole('listbox')
    await expect(listbox).toBeVisible({ timeout: 5_000 })

    // Press ArrowDown once to move to the next option.
    await trigger.press('ArrowDown')
    // Press Enter to commit.
    await trigger.press('Enter')

    // Listbox must close.
    await expect(listbox).toHaveCount(0, { timeout: 5_000 })

    // The trigger must now show a different value (navigated away from default "Date").
    // We don't assert the exact label since i18n may vary; just verify it changed.
    const newLabel = await getSelectValue(settings, 'settings-sort-mode')
    // Default is "Date"; after one ArrowDown it should be "From" or "Subject".
    expect(newLabel?.toLowerCase()).not.toBe('date')

    await settings.evaluate(() => window.close())
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

// ---------------------------------------------------------------------------
// Test: custom <Select> inside a modal dialog opens ABOVE the modal overlay
// ---------------------------------------------------------------------------
//
// Regression for the z-index bug where the portal listbox (.mc-select__listbox)
// rendered behind .modal-overlay: inside the mail-rule editor modal the dropdown
// options were hidden by the backdrop and could not be clicked. The earlier tests
// only exercise Selects on Settings tabs (no modal), so they never caught it.
//
// The signal that fails before the fix is the option `.click()` below: when the
// overlay (z-index 10000) covers the listbox (was 9999), the option never becomes
// the pointer-event hit target and Playwright's actionability check times out.

test('select-component: rules-modal dropdown opens above overlay and is clickable', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-select-modal-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // Open Settings → Rules tab.
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })
    await settings.getByTestId('settings-tab-rules').click()

    // Open the rule editor modal (button label falls back to English in e2e i18n).
    await settings.getByRole('button', { name: 'Add Rule' }).click()
    await expect(settings.locator('.modal-overlay')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The account Select lives inside the modal — locate it by its aria-label.
    const accountTrigger = settings.getByRole('combobox', { name: 'Account' })
    await expect(accountTrigger).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await accountTrigger.click()

    // Listbox must render (it did even with the bug — DOM presence isn't the issue).
    const listbox = settings.getByRole('listbox')
    await expect(listbox).toBeVisible({ timeout: 5_000 })

    // The load-bearing assertion: the option must receive the click. With the old
    // z-index the overlay intercepted pointer events here and this timed out.
    await settings.getByRole('option', { name: 'All accounts' }).click()
    await expect(listbox).toHaveCount(0, { timeout: 5_000 })
    await expect(accountTrigger.locator('.mc-select__value')).toHaveText('All accounts')

    await settings.evaluate(() => window.close())
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

// ---------------------------------------------------------------------------
// Test: custom <Select> closes on Escape key inside Settings
// ---------------------------------------------------------------------------

test('select-component: Settings dropdown closes on Escape without changing value', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-select-escape-'))
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })

    const trigger = settings.getByTestId('settings-theme')
    const valueBefore = await getSelectValue(settings, 'settings-theme')

    // Open listbox.
    await trigger.click()
    await expect(settings.getByRole('listbox')).toBeVisible({ timeout: 5_000 })

    // Press Escape — listbox should close without changing the value.
    await settings.keyboard.press('Escape')
    await expect(settings.getByRole('listbox')).toHaveCount(0, { timeout: 5_000 })

    const valueAfter = await getSelectValue(settings, 'settings-theme')
    expect(valueAfter).toBe(valueBefore)

    await settings.evaluate(() => window.close())
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})
