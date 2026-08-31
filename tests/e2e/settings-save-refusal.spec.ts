/**
 * §2.167 — `settings:save` refuses one FIELD (`mcpExportWhitelist`) instead of
 * either the whole payload or a silent write of an out-of-domain value.
 *
 * Unit coverage (`electron/settingsSaveRefusal.test.ts`) proves the decision
 * itself against the real schemas — it cannot prove that the wire reply
 * `{ ok: true, refused: [...] }` actually reaches the settings window, that the
 * value on disk is genuinely untouched by a save that failed for one field, or
 * that the renderer's reactive repair (`repairExportWhitelist`) actually stops
 * the permanent-refusal loop it exists to end. Those three are what this file
 * covers, against the real IPC stack and the real Settings component:
 *
 *   1. A pre-seeded persisted `mcpExportWhitelist` survives a save that carries
 *      a stale tool name alongside it — the reply names the offender, the file
 *      on disk is unchanged.
 *   2. A submitted entry that is out of domain for a reason OTHER than the
 *      wire-level enum mismatch (too long to be echoed, per
 *      `MAX_REFUSED_VALUE_LENGTH`) still refuses the field, but names nothing.
 *   3. The real Settings window: load a mixed whitelist, Save once (refused +
 *      repaired in place, window stays open so the notice can be read), Save
 *      again (now valid, window closes) — and the repaired value is what
 *      landed on disk.
 *   4. The notice renders in German (the longest of the six locale strings for
 *      this feature) without clipping — the same defect class
 *      `rules-i18n.spec.ts` guards for the rule editor's dropdown.
 *
 * Case (3)+(4) reuse the electron-store JSON shape documented in
 * electron/sentryPreflight.ts: `MAILCOPILOT_DATA_DIR/settings.json` holds
 * `{ "settings": {...}, "accounts": [...], "account": {...} }`, and only the
 * `settings` key is ever written here. No `accounts`/`account` key is needed —
 * e2e mode serves its mail fixtures from the hardcoded `E2E_ACCOUNTS` in
 * electron/main.ts regardless of what this file contains.
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
  selectMcOption,
  EXPECT_TIMEOUT,
  CLOSE_TIMEOUT,
  type AppContext,
} from './helpers'

type InvokeFn = (ch: string, ...args: unknown[]) => Promise<unknown>

function getInvoke(page: import('@playwright/test').Page) {
  return (channel: string, ...args: unknown[]) =>
    page.evaluate(
      ([ch, a]: [string, unknown[]]) =>
        (window as unknown as { api: { invoke: InvokeFn } }).api.invoke(ch, ...a),
      [channel, args] as [string, unknown[]],
    )
}

/** A stale export tool name — not in `EXPORTABLE_MCP_TOOLS`, same fixture name
 * as electron/settingsSaveRefusal.test.ts so the two suites read as one story. */
const STALE_TOOL = 'legacy_tool_from_an_older_build'

/** Writes `MAILCOPILOT_DATA_DIR/settings.json` before the app ever starts —
 * simulates a persisted record from an older build, which is the only way a
 * stale export-tool name gets onto disk (a live save is refused before it can
 * write one; see the module docstring). */
async function seedSettingsFile(dataDir: string, settings: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ settings }, null, 2),
    'utf8',
  )
}

/** Reads the `settings` key back out of the same file, straight from Node —
 * bypassing the app's own IPC so a persistence claim can't be graded by the
 * same process that might be lying about it. */
async function readPersistedSettings(dataDir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')
  const parsed = JSON.parse(raw) as { settings?: Record<string, unknown> }
  return parsed.settings ?? {}
}

test('settings:save refuses a stale mcpExportWhitelist entry without touching the persisted list', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailcopilot-e2e-save-refusal-'))
  await seedSettingsFile(dataDir, { theme: 'light', language: 'en', mcpExportWhitelist: ['get_email'] })

  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchAppReuse(dataDir))
    const invoke = getInvoke(ctx.page!)

    const resp = await invoke('settings:save', {
      mcpExportWhitelist: ['get_email', STALE_TOOL],
    }) as { ok: boolean; refused?: Array<{ field: string; code: string; values: string[] }> }

    expect(resp.ok).toBe(true)
    expect(resp.refused).toEqual([
      { field: 'mcpExportWhitelist', code: 'unknown_export_tool', values: [STALE_TOOL] },
    ])

    // The reply and the disk must agree: the offending entry never landed,
    // and neither did the in-domain one that rode along with it — the whole
    // FIELD is refused, so the persisted list is exactly what it was before
    // this save, not a cleaned version of what was submitted.
    await expect.poll(
      async () => (await readPersistedSettings(dataDir)).mcpExportWhitelist,
      { timeout: EXPECT_TIMEOUT },
    ).toEqual(['get_email'])

    // Same fact through the app's own read path, for good measure.
    const after = await invoke('settings:get') as { mcpExportWhitelist?: string[] }
    expect(after.mcpExportWhitelist).toEqual(['get_email'])
  } finally {
    await cleanupApp(ctx)
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('settings:save refuses an overlong whitelist entry, naming nothing', async () => {
  // No pre-seeded file: a fresh profile has never had `mcpExportWhitelist`
  // configured, which is the other half of the contract this case checks —
  // the field stays entirely absent, not merely "still the same array".
  const ctx = await launchApp('mailcopilot-e2e-save-refusal-overlong-')
  try {
    const invoke = getInvoke(ctx.page)

    // 201 chars — one past MAX_REFUSED_VALUE_LENGTH (200) in
    // electron/settingsSaveRefusal.ts. Out of domain regardless of length (no
    // 201-character string is a real export tool name), but too long to be
    // echoed back: a truncated echo would equal nothing the sender submitted.
    const overlong = 'x'.repeat(201)
    const resp = await invoke('settings:save', {
      mcpExportWhitelist: [overlong],
    }) as { ok: boolean; refused?: Array<{ field: string; code: string; values: string[] }> }

    expect(resp.ok).toBe(true)
    expect(resp.refused).toEqual([
      { field: 'mcpExportWhitelist', code: 'unknown_export_tool', values: [] },
    ])

    const after = await invoke('settings:get') as { mcpExportWhitelist?: string[] }
    expect(after.mcpExportWhitelist).toBeUndefined()
  } finally {
    await cleanupApp(ctx)
  }
})

test('Settings window: a refused mcpExportWhitelist keeps the window open, repairs itself, then a second Save closes it', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailcopilot-e2e-save-refusal-roundtrip-'))
  await seedSettingsFile(dataDir, {
    theme: 'light',
    language: 'en',
    mcpExportWhitelist: ['get_email', STALE_TOOL],
  })

  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchAppReuse(dataDir))
    const { page, browser } = ctx as AppContext

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })

    // First Save: the window sends the mixed list it loaded from disk
    // unmodified. Main refuses the field whole and names the stale entry;
    // the window reactively repairs its OWN state from that answer.
    await settings.getByTestId('settings-save').click()

    const notice = settings.getByTestId('settings-save-refusal-notice')
    await expect(notice).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(settings.getByTestId('settings-save-refusal-field-mcpExportWhitelist')).toBeVisible()
    // Repaired: the stale name was taken out of the window's own state, and
    // the notice says so — this is the reactive-repair half of §2.167, not
    // merely "the save was refused".
    const repaired = settings.getByTestId('settings-save-refusal-repaired')
    await expect(repaired).toBeVisible()
    await expect(repaired).toContainText(STALE_TOOL)

    // Window must NOT have closed: a refusal is not this window's "saved"
    // signal, and the notice would go unread if it did.
    expect(settings.isClosed()).toBe(false)

    // Second Save: the window now holds the repaired list (['get_email']),
    // which is valid — no refusal, and Save's only "success" signal (closing)
    // fires.
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // The repaired list — not the originally-persisted mixed one, and not a
    // reset to nothing — is what actually landed on disk.
    await page.bringToFront()
    const invoke = getInvoke(page)
    const after = await invoke('settings:get') as { mcpExportWhitelist?: string[] }
    expect(after.mcpExportWhitelist).toEqual(['get_email'])
  } finally {
    await cleanupApp(ctx)
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('Settings window: the refusal notice is not clipped in German', async () => {
  // German carries the longest of the six locale strings for this feature
  // (`settings.mcpExport.refusedTitle` / `refusedUnknownTool` /
  // `repairedTitle`) — the same class of defect `rules-i18n.spec.ts` guards
  // for the rule editor's dropdown options. `.error-banner` (src/App.css) has
  // no `overflow:hidden` / `white-space:nowrap` today; this is the regression
  // guard for that staying true.
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailcopilot-e2e-save-refusal-i18n-'))
  await seedSettingsFile(dataDir, {
    theme: 'light',
    language: 'en',
    mcpExportWhitelist: ['get_email', STALE_TOOL],
  })

  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchAppReuse(dataDir))
    const { page, browser } = ctx as AppContext

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })

    // A fresh seed with no `language` key boots in English — same reasoning
    // as rules-i18n.spec.ts — so the language select's accessible name is
    // reliably "Language" here.
    await selectMcOption(settings.getByRole('combobox', { name: 'Language' }), 'de')

    await settings.getByTestId('settings-save').click()
    const fieldLine = settings.getByTestId('settings-save-refusal-field-mcpExportWhitelist')
    await expect(fieldLine).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const repaired = settings.getByTestId('settings-save-refusal-repaired')
    await expect(repaired).toBeVisible()

    for (const locator of [fieldLine, repaired]) {
      const overflow = await locator.evaluate(el => el.scrollWidth - el.clientWidth)
      expect(overflow).toBeLessThanOrEqual(1)
    }
  } finally {
    await cleanupApp(ctx)
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
