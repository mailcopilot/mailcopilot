/**
 * E2E tests for §2.33 PR2b — AI API key storage migrated from direct keytar
 * calls to the injected `secretStore` (electron/services/secretStore.ts),
 * which adds a machine-bound AES-256-GCM disk fallback when the OS keychain
 * (libsecret/Secret Service) is unreachable — the normal case on headless
 * xvfb CI runners with no keyring daemon (session bus resolves to
 * `disabled:`, see the §2.33 (dbus-disabled) unit coverage in
 * electron/services/secretStore.test.ts).
 *
 * Scope: these tests exercise the parts of the AI-key flow that are
 * observable through the REAL preload/IPC/secretStore stack without a live
 * provider session:
 *
 *   1. Saving an API key via `ai:saveApiKey` + `settings:save` persists it,
 *      and the Settings UI reflects "key configured" (masked field, locked
 *      provider view) purely from `settings:get().aiProvider` — this signal
 *      does NOT depend on `ai:checkAuth` succeeding.
 *   2. The key round-trips through a full app relaunch with the same
 *      MAILCOPILOT_DATA_DIR — i.e. through the real secretStore backend. On
 *      a CI runner with no reachable Secret Service, this exercises the
 *      §2.33 D-Bus-disabled disk-fallback path end-to-end (probe → fallback
 *      → encrypted disk write → relaunch → decrypt read), not an in-memory
 *      mock: `ai:saveApiKey` must succeed via the fallback rather than
 *      hard-failing when the session bus is unavailable.
 *   3. Deleting the key via `ai:deleteApiKey` + provider reset clears the
 *      "configured" state, observable again after relaunch.
 *
 * Intentionally NOT tested here (requires a live provider session / real
 * network call — see tests/e2e/ai-internet-gate.spec.ts for the established
 * project convention on this boundary):
 *   - Clicking the in-wizard "Save" button end-to-end. `Settings.tsx`'s
 *     `save()` gates on `aiConnectionStatus === 'ok'` before persisting a
 *     NEW (not-yet-saved) provider, and `aiConnectionStatus` can only reach
 *     'ok' via `checkAiConnection()` → `ai:checkAuth`, which unconditionally
 *     calls the real provider API (e.g. `GET {baseUrl}/v1/models` for
 *     openai-api — see `openAiAdapter.checkAuth` in electron/services/ai.ts).
 *     Without a live network + valid upstream key this always resolves
 *     'invalid_key' or 'error', so driving the actual Save button would be
 *     flaky-by-construction. Instead these tests call `ai:saveApiKey` /
 *     `settings:save` directly via `window.api.invoke`, mirroring the same
 *     "bypass network-gated UI, exercise the real IPC/secretStore layer"
 *     pattern already used in ai-internet-gate.spec.ts.
 *   - "Check connection" success/failure UI states — manual QA.
 *
 * These gaps are covered by unit tests in:
 *   - electron/services/secretStore.test.ts
 *   - electron/services/ai.test.ts (saveApiKey/deleteApiKey/checkAuth)
 *
 * REGRESSION GUARD (was a bug found while writing this suite, test-gen,
 * §2.33 PR2b follow-up — now FIXED): the "Reset provider" flow in
 * Settings.tsx (`.ai-reset-link` onClick) used to spread the FULL
 * `settings:get()` result (which includes main-only fields such as
 * `mcpEnableStdio`, zod `.default(false)`-populated) into `settings:save`,
 * whose `rendererWritableSettingsSchema` is `.strict()` and rejects unknown
 * fields with `{ ok: false, reason: 'forbidden_field' }`. The old onClick
 * never checked `.ok`, so the rejection was silently swallowed: the renderer
 * optimistically flipped local React state to "no provider" while
 * `aiProvider` stayed persisted on disk. Fixed in commit 2f9b4d2 — the
 * reset-link now sends only `{ aiProvider: undefined }` (settings:save
 * merges server-side) and throws on a non-ok result. The
 * "deleting via reset link ... stays cleared after relaunch" test below is
 * the regression guard for this fix; it now PASSES and must keep passing —
 * see the inline comment on that test for what a regression would look like.
 */

import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  launchApp,
  launchAppReuse,
  cleanupApp,
  waitForPage,
  EXPECT_TIMEOUT,
  CLOSE_TIMEOUT,
  type AppContext,
} from './helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Opens Settings and switches to the AI tab. Returns the Settings page. */
async function openAiSettingsTab(ctx: AppContext) {
  const { page, browser } = ctx
  await page.getByTestId('open-settings').click()
  const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
  await settings.waitForLoadState('domcontentloaded')
  await settings.getByTestId('settings-tab-ai').click()
  return settings
}

/**
 * Saves an openai-api key through the real IPC layer (secretStore) and marks
 * the provider as active in settings — bypassing the network-gated in-wizard
 * Save button (see file header). This exercises the exact same
 * `ai:saveApiKey` → `secretStore.set` path the real Save-button flow would
 * use post-checkAuth, just without requiring a live network call first.
 *
 * Deliberately does NOT spread the full `settings:get()` result into the
 * `settings:save` payload: `settings:get()` returns the full `Settings`
 * shape, which includes main-only fields (e.g. `mcpEnableStdio`, zod
 * `.default(false)`-populated). `settings:save`'s `rendererWritableSettingsSchema`
 * is `.strict()` and rejects those with `{ ok: false, reason: 'forbidden_field' }`
 * — silently, if the caller doesn't check the response. Passing only the
 * fields this helper actually cares about avoids that trap entirely.
 */
async function persistOpenAiKey(page: import('@playwright/test').Page, apiKey: string): Promise<void> {
  await page.evaluate(async (key) => {
    const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
    await api.invoke('ai:saveApiKey', key, 'openai-api')
    const result = await api.invoke('settings:save', {
      aiProvider: 'openai-api',
      aiModel: 'gpt-4o-mini',
    }) as { ok: boolean; reason?: string }
    if (!result.ok) throw new Error(`settings:save failed: ${result.reason ?? 'unknown'}`)
  }, apiKey)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('AI key: saving via IPC persists and Settings UI reflects configured state without checkAuth', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const appCtx = ctx as AppContext

    await persistOpenAiKey(appCtx.page, 'sk-e2e-test-key-1234567890')

    // Reopen Settings — the "configured" view (State 3: locked provider +
    // masked key field) must render purely from settings:get().aiProvider,
    // with no network call involved.
    const settings = await openAiSettingsTab(appCtx)

    const keyField = settings.getByTestId('settings-ai-apikey')
    await expect(keyField).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(keyField).toHaveValue('••••••••••••••••')

    // The reset/back link that only exists in the "saved provider" locked
    // view confirms we're in State 3, not the unsaved wizard.
    await expect(settings.locator('.ai-reset-link')).toBeVisible()

    await settings.evaluate(() => window.close())
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('AI key: persists across app relaunch with the same data dir (real secretStore round-trip)', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailcopilot-e2e-aikey-'))
  const ctx1: Partial<AppContext> = {}
  const ctx2: Partial<AppContext> = {}
  try {
    Object.assign(ctx1, await launchAppReuse(dataDir))
    const appCtx1 = ctx1 as AppContext

    await persistOpenAiKey(appCtx1.page, 'sk-e2e-persist-key-abcdef123456')

    // Sanity check within the same process before relaunch.
    const settings1 = await openAiSettingsTab(appCtx1)
    await expect(settings1.getByTestId('settings-ai-apikey')).toHaveValue('••••••••••••••••', {
      timeout: EXPECT_TIMEOUT,
    })
    await settings1.evaluate(() => window.close())
    await expect.poll(() => settings1.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    await cleanupApp(ctx1)
    ctx1.dataDir = undefined

    // Relaunch a fresh Electron process against the SAME data dir. This
    // forces a cold read from the real secretStore backend (keytar if a
    // Secret Service is reachable, otherwise the machine-bound AES-256-GCM
    // disk fallback — the expected path on headless xvfb CI with no keyring
    // daemon) rather than any in-process cache.
    Object.assign(ctx2, await launchAppReuse(dataDir))
    const appCtx2 = ctx2 as AppContext

    const settings2 = await openAiSettingsTab(appCtx2)

    // "Configured" state must survive the relaunch: aiProvider was persisted
    // to the DB (settings:get) and the masked key field renders from it.
    await expect(settings2.getByTestId('settings-ai-apikey')).toHaveValue('••••••••••••••••', {
      timeout: EXPECT_TIMEOUT,
    })
    await expect(settings2.locator('.ai-reset-link')).toBeVisible()

    await settings2.evaluate(() => window.close())
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx1)
    await cleanupApp(ctx2)
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

// REGRESSION GUARD — `.ai-reset-link`'s onClick must actually persist the
// reset to disk, not just flip renderer state optimistically. It used to
// spread the FULL `settings:get()` result (including main-only fields like
// `mcpEnableStdio`) into the `.strict()` `settings:save`, which rejected it
// with `{ ok: false, reason: 'forbidden_field' }` — the handler never checked
// `.ok`, so the DB write silently no-oped while the UI cleared. Fixed to send
// only `{ aiProvider: undefined }` (settings:save merges server-side) and to
// throw on a non-ok result. This test proves the provider is cleared AND stays
// cleared across a relaunch; it would fail again if the spread/no-op regressed.
test('AI key: deleting via reset link clears configured state, and stays cleared after relaunch', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailcopilot-e2e-aikeydel-'))
  const ctx1: Partial<AppContext> = {}
  const ctx2: Partial<AppContext> = {}
  try {
    Object.assign(ctx1, await launchAppReuse(dataDir))
    const appCtx1 = ctx1 as AppContext

    await persistOpenAiKey(appCtx1.page, 'sk-e2e-delete-key-000111222')

    const settings1 = await openAiSettingsTab(appCtx1)
    await expect(settings1.getByTestId('settings-ai-apikey')).toHaveValue('••••••••••••••••', {
      timeout: EXPECT_TIMEOUT,
    })

    // Reset provider — this calls ai:deleteApiKey + settings:save({ ...current, aiProvider: undefined })
    // through the real UI reset-link handler (window.confirm auto-accepted below).
    settings1.on('dialog', dialog => void dialog.accept())
    await settings1.locator('.ai-reset-link').click()

    // Renderer state returns to "no provider selected" (State 1) after reset.
    await expect(settings1.getByTestId('settings-ai-provider')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await cleanupApp(ctx1)
    ctx1.dataDir = undefined

    // Relaunch and confirm the reset actually persisted to disk — not just in
    // in-memory renderer state. If the reset write regressed to a silent no-op,
    // the provider would come back configured here (State 2) and this fails.
    Object.assign(ctx2, await launchAppReuse(dataDir))
    const appCtx2 = ctx2 as AppContext

    const settings2 = await openAiSettingsTab(appCtx2)
    await expect(settings2.getByTestId('settings-ai-provider')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await settings2.evaluate(() => window.close())
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx1)
    await cleanupApp(ctx2)
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
