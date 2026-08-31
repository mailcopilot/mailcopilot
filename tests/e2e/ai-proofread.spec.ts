/**
 * E2E spec: §3.3 B7 AI Proofread — opt-in gate and Settings persistence.
 *
 * NOTE: Written by test-gen but NOT run here. NEEDS_E2E: yes.
 *       The pre-pr-gate agent executes it via `npm run e2e:bg`.
 *
 * Why the positive path (actual check → panel → accept edit → body changed) is
 * NOT e2e-reachable in the standard harness:
 *
 *   - `ai:proofread:check` delegates to `generateProofreadCheck` which calls
 *     `selectProvider` → real `aiChatSimple` → live network fetch to the AI
 *     provider API. There is no `IS_E2E` stub branch for AI completions in
 *     `composeAi.ts`/`ai.ts`, and the fetch runs in the MAIN process so
 *     Playwright's `page.route()` cannot intercept it.
 *   - No API key is present in the e2e data dir, so the handler always returns
 *     `{ ok: false, reason: 'not_enabled' }` (if toggle is OFF) or
 *     `{ ok: false, reason: 'no_provider' }` (if toggle is ON but no key).
 *
 * The handler behaviour across every branch (budget, provider routing, §2.78
 * boundary, §2.251 edit-id stability, §3.3.B4.f2 span-on-throw) is thoroughly
 * unit-tested in `electron/services/composeAi.test.ts` (21 tests),
 * `src/hooks/useProofread.test.ts` (15 tests), and
 * `src/components/ProofreadPanel.test.tsx` (15 tests).
 *
 * What THIS spec proves that no unit test can:
 *   1. Toggle OFF by default: the "Check writing" button is entirely absent from
 *      the Compose toolbar on a fresh profile — the IPC round-trip between
 *      Compose's settings-load and `proofreadEnabled` prop wiring is correct.
 *   2. Toggle ON: after turning the toggle on and saving, reopening Compose
 *      shows the button — the write round-tripped through settings.json and
 *      the Compose window picks it up on next load.
 *   3. Toggle ON → invoke IPC → refusal surfaces as UI state, not a crash:
 *      the `compose-proofread-refusal` div appears (no_provider because there
 *      is no key in the e2e profile), proving the IPC call was made and the
 *      renderer handled the result gracefully rather than throwing.
 *   4. Settings toggle persists across close/reopen cycle (same pattern as
 *      thread-summary.spec.ts — unit tests only pin the reducer, not the
 *      live IPC + settings.json round-trip).
 */
import { test, expect, type Browser, type Page } from '@playwright/test'
import {
  launchApp,
  cleanupApp,
  waitForPage,
  EXPECT_TIMEOUT,
  CLOSE_TIMEOUT,
  type AppContext,
} from './helpers'

async function openComposeWindow(page: Page, browser: Browser): Promise<Page> {
  await page.locator('.sidebar-compose-btn').click()
  const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
  await compose.waitForLoadState('domcontentloaded')
  return compose
}

async function openAiSettingsTab(page: Page, browser: Browser): Promise<Page> {
  await page.getByTestId('open-settings').click()
  const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
  await settings.waitForLoadState('domcontentloaded')
  await settings.getByTestId('settings-tab-ai').click()
  return settings
}

test('B7: proofread button is visible but LOCKED on a fresh profile (toggle OFF by default)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-proofread-off-'))
    const page = ctx.page!
    const browser = ctx.browser!

    const compose = await openComposeWindow(page, browser)

    // §1.26.1 AC-2: on a fresh profile aiProofreadEnabled defaults to {} (all
    // OFF), and the button is RENDERED in that state — locked, focusable, with
    // a hint saying where to switch it on. It used to be absent, which made a
    // switched-off setting indistinguishable from a missing feature.
    const btn = compose.getByTestId('compose-proofread-run')
    await expect(btn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(btn).toHaveAttribute('aria-disabled', 'true')
    // `aria-disabled`, not the `disabled` attribute — checked by attribute
    // presence, not Playwright's `toBeEnabled()`: that assertion folds
    // `aria-disabled="true"` into its own "disabled" verdict (it walks the
    // ARIA chain, same as real assistive tech), so it would fail here on code
    // that is doing exactly what §1.26.1(2) asks for. The HTML `disabled`
    // attribute — not ARIA — is what removes an element from the tab order,
    // which is the actual guarantee this test exists to pin.
    await expect(btn).not.toHaveAttribute('disabled')
  } finally {
    await cleanupApp(ctx)
  }
})

test('B7: enabling the toggle in Settings makes the proofread button appear in Compose', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-proofread-on-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // 1. Open Settings → AI tab, turn on the toggle and save.
    const settings = await openAiSettingsTab(page, browser)

    const toggle = settings.getByTestId('settings-ai-consent-proofread-1')
    await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // Default: unchecked. Removing the default({}) in settingsSchema → value is
    // undefined, Compose reads it as true (wrong), and the initial state flips.
    await expect(toggle).not.toBeChecked()

    await toggle.check()
    await expect(toggle).toBeChecked()
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // 2. Open Compose — the button must now be unlocked.
    // Removing the `proofreadEnabled` prop wiring in Compose.tsx → it stays
    // aria-disabled.
    const compose = await openComposeWindow(page, browser)
    const btn = compose.getByTestId('compose-proofread-run')
    await expect(btn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(btn).not.toHaveAttribute('aria-disabled', 'true')
  } finally {
    await cleanupApp(ctx)
  }
})

test('B7: Settings toggle persists across close/reopen (settings.json round-trip)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-proofread-persist-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // Turn ON, save.
    const settings = await openAiSettingsTab(page, browser)
    const toggle = settings.getByTestId('settings-ai-consent-proofread-1')
    await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await toggle.check()
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Reopen Settings → AI tab. Toggle must still be ON.
    // Removing the save payload key `aiProofreadEnabled` → reopen shows it OFF.
    const settings2 = await openAiSettingsTab(page, browser)
    const toggle2 = settings2.getByTestId('settings-ai-consent-proofread-1')
    await expect(toggle2).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(toggle2).toBeChecked()

    // Restore for hygiene.
    await toggle2.uncheck()
    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('B7: clicking the check button with no AI provider surfaces a refusal, not a crash', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-proofread-refusal-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // Enable the toggle.
    const settings = await openAiSettingsTab(page, browser)
    await settings.getByTestId('settings-ai-consent-proofread-1').check()
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Open Compose, type a draft body, click Check writing.
    const compose = await openComposeWindow(page, browser)
    await compose.getByTestId('compose-text').fill('Teh qick brwn fox.')

    const btn = compose.getByTestId('compose-proofread-run')
    await expect(btn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await btn.click()

    // With no API key the handler returns a refusal (not_enabled or no_provider).
    // The refusal div must appear — meaning the IPC round-trip completed and
    // the renderer handled the result gracefully.
    // Removing the refusal-display branch in ComposeQuickActions → count stays 0.
    await expect(
      compose.getByTestId('compose-proofread-refusal'),
    ).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The draft body must be unchanged — the corrector NEVER modifies the draft
    // (§3.3 B7 AC-f: informational only, never blocks sending).
    await expect(compose.getByTestId('compose-text')).toHaveValue('Teh qick brwn fox.')
  } finally {
    await cleanupApp(ctx)
  }
})
