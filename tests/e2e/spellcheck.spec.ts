/**
 * Spell checking — BACKLOG §2.103.
 *
 * What this file proves that a unit test cannot: the WHOLE round trip is real —
 * the picker is rendered from `session.availableSpellCheckerLanguages` as main
 * reported it (not from a list the renderer keeps), the choice travels through
 * the real `settings:save` IPC, and it comes back out of the store when a fresh
 * Settings window loads. A regression that renders the section fine but drops
 * `spellcheckLanguages` from the payload (or from `settingsSnapshot`) passes
 * every unit test in the change and fails here.
 *
 * The first assertion is the load-bearing one for the feature's whole reason to
 * exist: on a fresh profile the switch is OFF and no dictionary is chosen.
 * Electron's own default is the opposite — spellcheck on, language taken from
 * the OS locale, dictionary fetched from a third-party CDN with nothing asked.
 *
 * WHAT E2E CANNOT COVER HERE, stated so nobody assumes it is covered:
 *   - the native consent dialog. It is a real OS dialog drawn by main;
 *     `confirmSpellcheckNatively` short-circuits to ACCEPTED under
 *     `MAILCOPILOT_E2E=1 && !app.isPackaged`, exactly as the AI-destination and
 *     certificate prompts do. The decline path is covered in
 *     electron/services/spellcheck.test.ts.
 *   - Chromium actually underlining a word. The harness never arms the
 *     spellchecker (`SpellcheckDeps.isE2E`), because a test must not make the
 *     machine download dictionaries from a third party — and the quality of
 *     Chromium's suggestions is not ours to assert anyway. The menu section
 *     built from `misspelledWord` / `dictionarySuggestions` is covered as a
 *     pure function in electron/services/contextMenu.test.ts.
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, EXPECT_TIMEOUT, CLOSE_TIMEOUT, type AppContext } from './helpers'

/** Open a fresh Settings window on the General tab. */
async function openGeneralSettings(
  page: import('@playwright/test').Page,
  browser: import('@playwright/test').Browser,
) {
  await page.getByTestId('open-settings').click()
  const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
  await settings.waitForLoadState('domcontentloaded')
  await expect(settings.getByTestId('settings-tab-general')).toBeVisible({ timeout: EXPECT_TIMEOUT })
  await settings.getByTestId('settings-tab-general').click()
  return settings
}

test('§2.103: spell checking is off with no dictionaries on a fresh profile', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const settings = await openGeneralSettings(ctx.page!, ctx.browser!)

    const toggle = settings.getByTestId('settings-spellcheck-enabled')
    await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // The default that the whole feature exists for: nothing armed, nothing
    // downloaded, nothing asked.
    await expect(toggle).not.toBeChecked()
    await expect(settings.getByTestId('settings-spellcheck-none')).toBeVisible()

    await settings.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

test('§2.103: a chosen dictionary survives save, close and reopen', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!
    let settings = await openGeneralSettings(page, browser)

    await expect(settings.getByTestId('settings-spellcheck-enabled')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The picker's options come from main's report of what Chromium offers on
    // THIS machine, so the spec picks whatever the first one is rather than
    // naming a language the runner may not have.
    const picker = settings.getByTestId('settings-spellcheck-add-language')
    const platformOwned = await settings.getByTestId('settings-spellcheck-platform-owned').count()
    test.skip(platformOwned > 0, 'macOS owns the language list — there is no picker to drive')
    await expect(picker).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await picker.click()
    const options = settings.getByRole('option')
    await expect(options.first()).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // Index 0 is the "Add a language…" placeholder; 1 is the first real code.
    const optionCount = await options.count()
    test.skip(optionCount < 2, 'this build reports no spell checking dictionaries')
    const chosenLabel = (await options.nth(1).textContent())?.trim() ?? ''
    await options.nth(1).click()

    // The chosen language now appears in the list, and the "nothing chosen"
    // hint is gone.
    const chosen = settings.getByTestId('settings-spellcheck-languages')
    await expect(chosen).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(chosen).toContainText(chosenLabel)
    await expect(settings.getByTestId('settings-spellcheck-none')).toHaveCount(0)

    await settings.getByTestId('settings-spellcheck-enabled').click()
    await expect(settings.getByTestId('settings-spellcheck-enabled')).toBeChecked()

    // Save persists and closes in one action. Under the harness the native
    // consent dialog short-circuits to accepted, so the language is applied
    // rather than refused — the refusal path is a unit test.
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // A fresh window re-reads the store rather than reusing renderer state.
    settings = await openGeneralSettings(page, browser)
    await expect(settings.getByTestId('settings-spellcheck-enabled')).toBeChecked({ timeout: EXPECT_TIMEOUT })
    await expect(settings.getByTestId('settings-spellcheck-languages')).toContainText(chosenLabel)

    await settings.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})
