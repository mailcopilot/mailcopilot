/**
 * E2E tests for §2.33 PR2b — AI API key storage migrated from direct keytar
 * calls to the injected `secretStore` (electron/services/secretStore.ts),
 * which adds a machine-bound AES-256-GCM disk fallback when the OS keychain
 * (libsecret/Secret Service) is unreachable.
 *
 * §2.132 — under `MAILCOPILOT_E2E=1` that disk fallback is now the ONLY backend:
 * the keychain is off limits by policy, not merely absent by accident. This file
 * is why the rule exists. It saves and deletes keys through the real IPC stack,
 * and a keychain entry is addressed by (service, account) — `mailcopilot` /
 * `openai_api_key` — which belongs to the logged-in USER, while
 * `MAILCOPILOT_DATA_DIR` only isolates disk state. On a headless CI runner the
 * session bus resolves to `disabled:`, so these tests hit the fallback and all
 * looked well; on a developer box `xvfb-run` does NOT disable D-Bus, so the same
 * tests reached the live keyring. On 2026-08-05 a gate run deleted a real
 * `openai_api_key` mid-suite and left a test string in its place, which the next
 * app launch read back as a key the provider then rejected. See
 * electron/services/secretStore.ts (`isE2E`) and the §2.132 unit coverage in
 * electron/services/secretStore.test.ts.
 *
 * Scope: these tests exercise the parts of the AI-key flow that are
 * observable through the REAL preload/IPC/secretStore stack without a live
 * provider session:
 *
 *   1. Saving an API key via `ai:saveApiKey` + `settings:save` persists it,
 *      and the Settings UI reflects "key configured" without `ai:checkAuth`
 *      ever succeeding. §2.122: the masked field is driven by
 *      `settings:get().aiApiKeySaved[provider]` — main's own non-secret record
 *      of having written a key — while the locked provider view still follows
 *      `settings:get().aiProvider`. The two are separate facts: a provider can
 *      be selected with no key stored, and the mask must not claim otherwise
 *      (`isAiKeyFieldMasked` in src/utils, used at Settings.tsx:673).
 *   2. The key round-trips through a full app relaunch with the same
 *      MAILCOPILOT_DATA_DIR — i.e. through the real secretStore backend. On
 *      a CI runner with no reachable Secret Service, this exercises the
 *      §2.33 D-Bus-disabled disk-fallback path end-to-end (probe → fallback
 *      → encrypted disk write → relaunch → decrypt read), not an in-memory
 *      mock: `ai:saveApiKey` must succeed via the fallback rather than
 *      hard-failing when the session bus is unavailable.
 *   3. Deleting the key via `ai:deleteApiKey` + provider reset clears the
 *      "configured" state, observable again after relaunch.
 *   4. §2.122 — that delete is ADDRESSED: resetting one provider leaves the
 *      other providers' keys alone.
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
 *
 * §2.122 — the same reset link then called `ai:deleteApiKey` with NO provider,
 * which the service read as "delete the key of every provider". The channel now
 * REQUIRES a provider (zod, non-optional), so the old bare call would be
 * rejected outright and the reset would abort into the error branch; the tests
 * below exercise the reset link through the real UI, so they cover both the
 * rejection and the addressing.
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
/**
 * §2.122 — the main process's own non-secret record of which providers it has
 * written a key for (`settings.aiApiKeySaved`, main-only writable). The stored
 * key itself is unreadable from the renderer by design, so this marker is the
 * observable that tells a per-provider delete apart from a delete-everything.
 */
async function readSavedKeyMarkers(
  page: import('@playwright/test').Page,
): Promise<Record<string, boolean | undefined>> {
  return await page.evaluate(async () => {
    const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
    const s = await api.invoke('settings:get') as { aiApiKeySaved?: Record<string, boolean> } | undefined
    return s?.aiApiKeySaved ?? {}
  })
}

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

/**
 * §2.132 isolation guard. The unit suite proves the store issues no keychain
 * call under the flag; what this cannot be checked for from here is the
 * developer's real keychain, so it asserts the positive half end-to-end: a key
 * saved through the real IPC stack materializes inside THIS run's data dir.
 * A regression that reverts to the keychain leaves this file absent — the run
 * would then be writing somewhere shared, which is the whole failure mode.
 */
test('AI key: an e2e-mode save lands in the run data dir, not the OS keychain', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const appCtx = ctx as AppContext

    await persistOpenAiKey(appCtx.page, 'sk-e2e-isolation-guard-0001')

    const fallbackFile = path.join(appCtx.dataDir, 'secret-fallback.json')
    await expect
      .poll(() => fs.access(fallbackFile).then(() => true, () => false), { timeout: EXPECT_TIMEOUT })
      .toBe(true)

    // Present AND holding an entry — an empty shell would satisfy the path
    // check while the secret went elsewhere. Values stay encrypted; only the
    // entry count is inspected.
    const parsed = JSON.parse(await fs.readFile(fallbackFile, 'utf8')) as {
      entries?: Record<string, string>
    }
    expect(Object.keys(parsed.entries ?? {}).length).toBeGreaterThan(0)
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

    // Relaunch a fresh Electron process against the SAME data dir. This forces
    // a cold read from the real secretStore backend — since §2.132 always the
    // machine-bound AES-256-GCM disk fallback inside this data dir, on CI and
    // on a developer box alike — rather than any in-process cache.
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

    // Reset provider — this calls ai:deleteApiKey('openai-api') + settings:save({ aiProvider: undefined })
    // through the real UI reset-link handler (window.confirm auto-accepted below).
    // §2.122: the provider argument is mandatory in main; a bare call would be
    // rejected by the zod parse and this step would never reach State 1.
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

// REGRESSION GUARD (§2.122) — resetting ONE provider must not touch the other
// providers' keys. The reset link used to invoke `ai:deleteApiKey` with no
// argument, and the service treated that as "delete all of them": a user lost
// five keys across three providers to a single unconfirmed click. Keys of
// different providers do not conflict, so switching between them has to be
// free; only an explicit, confirmed, per-provider reset may delete anything.
test('AI key: resetting one provider keeps the other provider key', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const appCtx = ctx as AppContext

    // A key for anthropic-api that we are NOT going to reset...
    await appCtx.page.evaluate(async () => {
      const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
      await api.invoke('ai:saveApiKey', 'sk-ant-e2e-keep-this-key-123456', 'anthropic-api')
    })
    // ...and an openai-api key which is the active provider and gets reset.
    await persistOpenAiKey(appCtx.page, 'sk-e2e-delete-only-this-999')

    const before = await readSavedKeyMarkers(appCtx.page)
    expect(before['anthropic-api']).toBe(true)
    expect(before['openai-api']).toBe(true)

    const settings = await openAiSettingsTab(appCtx)
    await expect(settings.getByTestId('settings-ai-apikey')).toHaveValue('••••••••••••••••', {
      timeout: EXPECT_TIMEOUT,
    })
    settings.on('dialog', dialog => void dialog.accept())
    await settings.locator('.ai-reset-link').click()
    await expect(settings.getByTestId('settings-ai-provider')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The delete was addressed: only the reset provider's marker was cleared.
    // (`aiApiKeySaved` is written by the main process on the real save/delete
    // paths — a delete-everything would clear both entries.)
    await expect.poll(async () => (await readSavedKeyMarkers(appCtx.page))['openai-api'], {
      timeout: EXPECT_TIMEOUT,
    }).toBe(false)
    expect((await readSavedKeyMarkers(appCtx.page))['anthropic-api']).toBe(true)

    await settings.evaluate(() => window.close())
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

// Codex cross-family review test-gap (Medium) — the guarantee "the
// `ai:deleteApiKey` channel is closed shut: no provider, no pass" was pinned
// only at the SERVICE level (electron/services/ai.test.ts calls
// `deleteApiKey()` directly). Nothing exercised the REGISTERED IPC handler in
// electron/main.ts, which does its own zod `.enum([...]).parse(...)` gate
// BEFORE the service function is ever reached. This test drives the exact
// whitelisted channel through the real preload bridge (`window.api.invoke`),
// simulating a compromised renderer that calls it bare — the threat model the
// gate exists for — and checks BOTH that the call is rejected and that no
// provider's key was touched (not just the one you might expect: if main ever
// re-defaults a missing provider to e.g. 'anthropic-api', that would reject
// nothing and silently delete a real key — this leaves three keys saved
// beforehand specifically so that regression has something to destroy).
test('AI key: ai:deleteApiKey with no provider is rejected at the IPC gate and touches nothing', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const appCtx = ctx as AppContext

    await appCtx.page.evaluate(async () => {
      const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
      await api.invoke('ai:saveApiKey', 'sk-ant-gate-test-1', 'anthropic-api')
      await api.invoke('ai:saveApiKey', 'sk-openai-gate-test-2', 'openai-api')
      await api.invoke('ai:saveApiKey', 'sk-gemini-gate-test-3', 'gemini-api')
    })

    const before = await readSavedKeyMarkers(appCtx.page)
    expect(before['anthropic-api']).toBe(true)
    expect(before['openai-api']).toBe(true)
    expect(before['gemini-api']).toBe(true)

    // The bare call, exactly as a compromised renderer would make it: no
    // second argument at all. `window.api.invoke` is the real preload bridge
    // (electron/preload.ts) into the real registered `ai:deleteApiKey`
    // handler (electron/main.ts) — nothing here is mocked or mirrored.
    const outcome = await appCtx.page.evaluate(async () => {
      const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
      try {
        await api.invoke('ai:deleteApiKey')
        return { rejected: false }
      } catch (err) {
        return { rejected: true, message: err instanceof Error ? err.message : String(err) }
      }
    })
    expect(outcome.rejected).toBe(true)

    // Nothing was touched: all three markers survive the rejected call.
    const after = await readSavedKeyMarkers(appCtx.page)
    expect(after['anthropic-api']).toBe(true)
    expect(after['openai-api']).toBe(true)
    expect(after['gemini-api']).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})
