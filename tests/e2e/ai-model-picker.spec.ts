/**
 * E2E for the Settings -> AI model picker (ai:listModels).
 *
 * Under the e2e gate main serves a fixed per-provider model list and never
 * contacts a provider (E2E_AI_MODEL_LIST in electron/main.ts), so these tests
 * are deterministic and need no network or real key. As in
 * ai-key-persistence.spec.ts, the saved-provider state is set up through the
 * real IPC layer instead of the network-gated in-wizard Save button.
 */

import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, EXPECT_TIMEOUT, type AppContext } from './helpers'

const SAVED_MODEL = 'gemini-2.0-flash'

test('AI model picker: lists the provider models, keeps a saved unlisted model, accepts a custom id', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const { page, browser } = ctx as AppContext

    // A saved gemini-api provider with a stored key marker and a model that is NOT in the fixed list.
    await page.evaluate(async (model) => {
      const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
      await api.invoke('ai:saveApiKey', 'gemini-e2e-model-picker-key', 'gemini-api')
      const result = await api.invoke('settings:save', { aiProvider: 'gemini-api', aiModel: model }) as { ok: boolean; reason?: string }
      if (!result.ok) throw new Error(`settings:save failed: ${result.reason ?? 'unknown'}`)
    }, SAVED_MODEL)

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-ai').click()

    // (2) The saved model is not in the list but stays visible as the selected value.
    const picker = settings.getByTestId('settings-ai-model')
    await expect(picker).toContainText(SAVED_MODEL, { timeout: EXPECT_TIMEOUT })

    // (1) The dropdown offers this provider's models and none of another provider's.
    await picker.click()
    const options = settings.locator('[role="option"]')
    await expect(settings.locator('[role="option"][data-value="gemini-3.8-flash"]')).toHaveCount(1, { timeout: EXPECT_TIMEOUT })
    await expect(settings.locator('[role="option"][data-value="gemini-3.6-flash"]')).toHaveCount(1)
    await expect(settings.locator(`[role="option"][data-value="${SAVED_MODEL}"]`)).toHaveCount(1)
    await expect(options.filter({ hasText: /claude/i })).toHaveCount(0)

    // (3) "Other model…" turns the field into a text input that takes any id.
    await options.filter({ hasText: 'Other model' }).click()
    const textInput = settings.locator('input[data-testid="settings-ai-model"]')
    await expect(textInput).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await textInput.fill('my-custom-model-id')
    await expect(textInput).toHaveValue('my-custom-model-id')
  } finally {
    await cleanupApp(ctx)
  }
})
