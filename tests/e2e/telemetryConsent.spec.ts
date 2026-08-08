/**
 * E2E tests for §2.82 — first-run telemetry consent screen.
 *
 * These specs are the only ones in the suite that run with the consent gate
 * ARMED. The rest of the suite is bypassed by
 * `electron/services/telemetryConsentService.ts` (MAILCOPILOT_E2E=1 on an
 * unpackaged build); `launchAppWithConsentGate` sets MAILCOPILOT_E2E_CONSENT=1
 * to opt back in, which is why it must not wait for the mail list — with the
 * screen up, `<App/>` is not mounted at all.
 *
 * Covered here (the parts that only exist end-to-end):
 *   - AC (c)/AC4: the screen precedes the app — no mail list, no account wizard
 *     behind it on a fresh profile
 *   - AC5: two equally-weighted buttons, nothing focused, no checkbox, and
 *     Escape producing the exact same stored record as "don't allow"
 *   - AC7: a refusal survives a restart — the screen does not come back and
 *     telemetry stays off
 *   - the grant path flips both the record and the About switch, without a
 *     restart
 *   - both answers are actually ON SCREEN, in all six locales, down to the
 *     minimum window size — a layout property that only real rendering can
 *     decide (jsdom has no layout, so no unit test can catch it)
 *
 * Markup-level dark-pattern assertions and every failure branch live in the
 * unit tests (src/components/TelemetryConsentDialog.test.tsx,
 * src/hooks/useTelemetryConsent.test.ts).
 */

import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  launchAppWithConsentGate,
  cleanupApp,
  waitForPage,
  EXPECT_TIMEOUT,
  CLOSE_TIMEOUT,
  type AppContext,
} from './helpers'

type StoredSettings = {
  sentryEnabled?: boolean
  telemetryConsent?: { granted: boolean; version: number; at: string }
}

/** Read the persisted settings through the real preload bridge. */
async function readSettings(ctx: AppContext): Promise<StoredSettings> {
  return await ctx.page.evaluate(async () =>
    await (window as unknown as { api: { invoke: (c: string) => Promise<StoredSettings> } })
      .api.invoke('settings:get'))
}

test.describe('§2.82 telemetry consent — first run', () => {
  let ctx: AppContext | undefined

  test.afterEach(async () => {
    if (ctx) await cleanupApp(ctx)
    ctx = undefined
  })

  test('asks before the app renders, and neither answer is pre-selected', async () => {
    ctx = await launchAppWithConsentGate()
    const { page } = ctx

    const dialog = page.getByTestId('telemetry-consent-dialog')
    await expect(dialog).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // AC (c)/AC4 — `<App/>` is not mounted while the screen is up, and its load
    // effect is the ONLY caller of `ui:openAccount` on an empty roster
    // (src/App.tsx). So: no mail list, and no second window was opened. (The
    // empty-roster branch itself cannot be reproduced here — `accounts:list`
    // returns the fixed E2E roster in IS_E2E mode — which is exactly why the
    // gate is placed in Root.tsx rather than inside App.)
    await expect(page.getByTestId('inbox-list')).toHaveCount(0)
    expect(ctx.browser.contexts().flatMap(c => c.pages()).filter(p => !p.isClosed())).toHaveLength(1)

    // The main window is frameless (`frame: false`), and Root renders this
    // screen instead of `<App/>` — which owns the app's only drag region. The
    // screen therefore carries its own titlebar; without it the first window a
    // new user ever sees cannot be moved and shows no way to close it.
    await expect(page.getByTestId('telemetry-consent-titlebar')).toBeVisible()
    await expect(page.getByTestId('window-titlebar-close')).toBeVisible()

    // AC5 — equal weight, no autofocus, no checkbox.
    const allow = page.getByTestId('telemetry-consent-allow')
    const deny = page.getByTestId('telemetry-consent-deny')
    await expect(allow).toBeVisible()
    await expect(deny).toBeVisible()
    expect(await allow.getAttribute('class')).toBe(await deny.getAttribute('class'))
    expect(await dialog.locator('input').count()).toBe(0)
    const focusedTestId = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid') ?? null)
    expect(focusedTestId).not.toBe('telemetry-consent-allow')
    expect(focusedTestId).not.toBe('telemetry-consent-deny')

    // AC2 — the renderer was started with telemetry off: main derives
    // `--sentry-enabled=` from the consent record, and preload fails closed on
    // anything but an explicit `true`. Nothing may be recorded either.
    const rendererSentryEnabled = await page.evaluate(() =>
      (window as unknown as { api?: { sentryEnabled?: boolean } }).api?.sentryEnabled)
    expect(rendererSentryEnabled).toBe(false)

    // No record until the user actually answers — and `settings:get` must not
    // hand the window the raw persisted field either. On a fresh profile the
    // stored value is still the schema default `true`, while nobody has been
    // asked; publishing that verbatim is a pre-ticked box, and src/App.tsx
    // starts the renderer's own Sentry client from it (§2.82 iter2 finding 1).
    // Main clamps every outgoing copy to the effective permission.
    const before = await readSettings(ctx)
    expect(before.telemetryConsent).toBeUndefined()
    expect(before.sentryEnabled).toBe(false)
  })

  test('Escape records a refusal identical to the "don\'t allow" button', async () => {
    // Two profiles, two exits, one comparison — the records must match except
    // for the timestamp.
    ctx = await launchAppWithConsentGate()
    await expect(ctx.page.getByTestId('telemetry-consent-dialog')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await ctx.page.keyboard.press('Escape')
    await expect(ctx.page.getByTestId('inbox-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const byEscape = await readSettings(ctx)
    await cleanupApp(ctx)

    ctx = await launchAppWithConsentGate()
    await expect(ctx.page.getByTestId('telemetry-consent-dialog')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await ctx.page.getByTestId('telemetry-consent-deny').click()
    await expect(ctx.page.getByTestId('inbox-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const byButton = await readSettings(ctx)

    expect(byEscape.telemetryConsent?.granted).toBe(false)
    expect(byButton.telemetryConsent?.granted).toBe(false)
    expect(byEscape.telemetryConsent?.version).toBe(byButton.telemetryConsent?.version)
    expect(byEscape.sentryEnabled).toBe(false)
    expect(byButton.sentryEnabled).toBe(false)
  })

  test('allowing turns telemetry on without a restart', async () => {
    ctx = await launchAppWithConsentGate()
    const { page } = ctx

    await expect(page.getByTestId('telemetry-consent-dialog')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.getByTestId('telemetry-consent-allow').click()
    await expect(page.getByTestId('inbox-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await expect.poll(async () => (await readSettings(ctx!)).telemetryConsent?.granted, {
      timeout: EXPECT_TIMEOUT,
    }).toBe(true)
    expect((await readSettings(ctx)).sentryEnabled).toBe(true)
  })
})

test.describe('§2.82 telemetry consent — Settings → About switch (AC8)', () => {
  let ctx: AppContext | undefined

  test.afterEach(async () => {
    if (ctx) await cleanupApp(ctx)
    ctx = undefined
  })

  // GDPR art. 7(3): withdrawing must be as easy as giving. The About switch is
  // that path (electron/telemetryConsent.ts:applyAboutToggle), and the
  // reverse direction (re-granting after a revoke) is the one a clamp bug
  // tends to break silently — the pure-function unit tests already cover the
  // decision logic in isolation; this proves the full IPC round trip through
  // Settings does not diverge from it.
  test('revoking and re-granting through the switch round-trips without a restart', async () => {
    ctx = await launchAppWithConsentGate()
    const { page, browser } = ctx

    // Grant on the first-run screen so the switch starts in the "on" state.
    await expect(page.getByTestId('telemetry-consent-dialog')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.getByTestId('telemetry-consent-allow').click()
    await expect(page.getByTestId('inbox-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect.poll(async () => (await readSettings(ctx!)).telemetryConsent?.granted, {
      timeout: EXPECT_TIMEOUT,
    }).toBe(true)

    // Open Settings → About and revoke via the switch.
    await page.getByTestId('open-settings').click()
    let settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-tab-about')).toBeVisible({ timeout: 45_000 })
    await settings.getByTestId('settings-tab-about').click()

    const toggleOff = settings.getByTestId('settings-about-sentry')
    await expect(toggleOff).toBeChecked()
    await expect(toggleOff).toBeEnabled()
    await toggleOff.uncheck()
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    await expect.poll(async () => (await readSettings(ctx!)).telemetryConsent?.granted, {
      timeout: EXPECT_TIMEOUT,
    }).toBe(false)
    expect((await readSettings(ctx)).sentryEnabled).toBe(false)

    // Reopen and re-grant — the reverse path is the one most likely to be
    // left one-way by a clamp bug (applyAboutToggle §2.82).
    await page.getByTestId('open-settings').click()
    settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-tab-about')).toBeVisible({ timeout: 45_000 })
    await settings.getByTestId('settings-tab-about').click()

    const toggleOn = settings.getByTestId('settings-about-sentry')
    await expect(toggleOn).not.toBeChecked()
    await toggleOn.check()
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    await expect.poll(async () => (await readSettings(ctx!)).telemetryConsent?.granted, {
      timeout: EXPECT_TIMEOUT,
    }).toBe(true)
    expect((await readSettings(ctx)).sentryEnabled).toBe(true)
  })
})

/**
 * Layout regression sweep — the answers have to be VISIBLE, not merely present.
 *
 * The screen shipped with `maxHeight: 80vh; overflowY: auto` on the whole
 * dialog, so the answer row scrolled with the prose. The disclosure renders
 * 1031px tall in en and 1206px in fr against 638px of visible dialog at the
 * default 1200x800 window: both buttons sat below the fold in every locale, and
 * in fr the "never sent" list did too — the first thing a new user saw was what
 * we collect, with no way to answer. Nothing in the suite noticed, because
 * `toBeVisible()` is satisfied by an element parked outside the viewport and
 * jsdom (where the markup-level consent rules are tested) has no layout at all.
 *
 * Hence: geometry, in every shipped locale, at the smallest window the app
 * allows. `toBeInViewport({ ratio: 1 })` is the assertion that matters — it
 * intersects through ancestor clips, so it fails both when a button is pushed
 * past the window edge and when the dialog's own `overflow: hidden` cuts it.
 */
test.describe('§2.82 telemetry consent — both answers stay on screen', () => {
  const LOCALES = ['en', 'ru', 'fr', 'de', 'es', 'it'] as const
  /** BrowserWindow minWidth/minHeight and the default size (electron/main.ts). */
  const MIN_WINDOW = { width: 900, height: 600 }
  const DEFAULT_WINDOW = { width: 1200, height: 800 }

  let dataDir: string | undefined
  let ctx: AppContext | undefined

  test.afterEach(async () => {
    if (ctx) await cleanupApp(ctx)
    ctx = undefined
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true })
    dataDir = undefined
  })

  /**
   * Seeds the profile with a language before the first launch.
   *
   * electron-store layout: `<dataDir>/settings.json` holding `{ settings: {…} }`,
   * and the key is `language` (not `lang`). `sentryEnabled` is deliberately
   * absent — its absence is what leaves the consent verdict at "needed", i.e.
   * what keeps the screen up at all.
   */
  async function seedLocale(lang: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `mailcopilot-e2e-consent-${lang}-`))
    await fs.writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ settings: { language: lang, theme: 'light' } }),
      'utf8',
    )
    return dir
  }

  /** Asserts the geometry of the answer row at the current viewport size. */
  async function expectAnswersOnScreen(
    page: AppContext['page'],
    where: string,
  ): Promise<void> {
    const allow = page.getByTestId('telemetry-consent-allow')
    const deny = page.getByTestId('telemetry-consent-deny')

    await expect(allow, `allow button off screen ${where}`)
      .toBeInViewport({ ratio: 1, timeout: EXPECT_TIMEOUT })
    await expect(deny, `deny button off screen ${where}`)
      .toBeInViewport({ ratio: 1, timeout: EXPECT_TIMEOUT })

    // Visible without scrolling ANYTHING: the dialog box itself must have no
    // overflow left to scroll, so the buttons cannot be reached-by-scrolling
    // rather than shown.
    await expect
      .poll(async () => await page.getByTestId('telemetry-consent-dialog')
        .evaluate(el => el.scrollHeight - el.clientHeight), { timeout: EXPECT_TIMEOUT })
      .toBeLessThanOrEqual(1)

    // Same row, same height. The unit tests pin identical markup; this pins the
    // rendered result of it, which is what the user actually compares
    // (GDPR art. 4(11) — a freely given choice needs two equal-looking options).
    const [a, d] = [await allow.boundingBox(), await deny.boundingBox()]
    expect(a, `allow has no box ${where}`).not.toBeNull()
    expect(d, `deny has no box ${where}`).not.toBeNull()
    expect(Math.abs(a!.height - d!.height), `unequal button heights ${where}`).toBeLessThanOrEqual(1)
    expect(Math.abs(a!.y - d!.y), `buttons not on one row ${where}`).toBeLessThanOrEqual(1)
  }

  for (const lang of LOCALES) {
    test(`answers stay in the viewport in ${lang}, from the default window down to the minimum`, async () => {
      dataDir = await seedLocale(lang)
      ctx = await launchAppWithConsentGate({ dataDir })
      const { page } = ctx

      await expect(page.getByTestId('telemetry-consent-dialog')).toBeVisible({ timeout: EXPECT_TIMEOUT })

      // The seed has to have taken effect, or the sweep silently tests `en` six
      // times: Root.tsx sets `<html lang>` from the same settings read that
      // drives i18n.changeLanguage.
      await expect.poll(async () => await page.evaluate(() => document.documentElement.lang), {
        timeout: EXPECT_TIMEOUT,
      }).toBe(lang)

      await page.setViewportSize(DEFAULT_WINDOW)
      await expectAnswersOnScreen(page, `in ${lang} at ${DEFAULT_WINDOW.width}x${DEFAULT_WINDOW.height}`)

      await page.setViewportSize(MIN_WINDOW)
      await expectAnswersOnScreen(page, `in ${lang} at ${MIN_WINDOW.width}x${MIN_WINDOW.height}`)

      // Non-vacuity: at the minimum size the prose genuinely does not fit, so
      // the assertions above are exercising the overflow case rather than a
      // screen that happens to be short enough. This is also the invariant
      // itself — the text is what scrolls, and only the text.
      await expect
        .poll(async () => await page.getByTestId('telemetry-consent-body')
          .evaluate(el => el.scrollHeight - el.clientHeight), { timeout: EXPECT_TIMEOUT })
        .toBeGreaterThan(0)

      // And scrolling the prose to its end does not move the answer row.
      const before = await page.getByTestId('telemetry-consent-allow').boundingBox()
      await page.getByTestId('telemetry-consent-body').evaluate(el => { el.scrollTop = el.scrollHeight })
      await expectAnswersOnScreen(page, `in ${lang} after scrolling the disclosure`)
      const after = await page.getByTestId('telemetry-consent-allow').boundingBox()
      expect(Math.abs(after!.y - before!.y), `answer row moved while the text scrolled in ${lang}`)
        .toBeLessThanOrEqual(1)

      // The disclosure itself is untouched by the layout fix: both lists are
      // still complete (seven sent categories — §2.122 added `aiKeyStore` — and
      // five never), just inside the scroller now. A future "make it fit"
      // temptation lands here first.
      expect(await page.getByTestId('telemetry-consent-sent').locator('li').count()).toBe(7)
      expect(await page.getByTestId('telemetry-consent-never').locator('li').count()).toBe(5)
      await expect(page.getByTestId('telemetry-consent-change-later')).not.toBeEmpty()
      await expect(page.getByTestId('telemetry-consent-privacy-link')).not.toBeEmpty()
    })
  }
})

test.describe('§2.82 telemetry consent — persistence across restarts (AC7)', () => {
  let dataDir: string | undefined
  let ctx: AppContext | undefined

  test.afterEach(async () => {
    if (ctx) await cleanupApp(ctx)
    ctx = undefined
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true })
    dataDir = undefined
  })

  test('a refusal is not asked again on the next start', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailcopilot-e2e-consent-restart-'))

    ctx = await launchAppWithConsentGate({ dataDir })
    await expect(ctx.page.getByTestId('telemetry-consent-dialog')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await ctx.page.getByTestId('telemetry-consent-deny').click()
    await expect(ctx.page.getByTestId('inbox-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await cleanupApp(ctx)
    ctx = undefined

    // Same profile, gate still armed: the answer is on record, so the app must
    // come straight up with telemetry off.
    ctx = await launchAppWithConsentGate({ dataDir })
    await expect(ctx.page.getByTestId('inbox-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(ctx.page.getByTestId('telemetry-consent-dialog')).toHaveCount(0)

    const settings = await readSettings(ctx)
    expect(settings.telemetryConsent?.granted).toBe(false)
    expect(settings.sentryEnabled).toBe(false)
  })
})

/**
 * §2.122 — TELEMETRY_CONSENT_VERSION bumped 1 -> 2 when the AI-key-store
 * category (`ai.api_key_store_op`) was added to what is disclosed.
 *
 * `evaluateConsent` (electron/telemetryConsent.ts) already has a unit test for
 * "version < TELEMETRY_CONSENT_VERSION collapses to needed"; what that test
 * cannot see is the consequence a real upgrading installation experiences: a
 * profile that has a v1 record on disk — from BEFORE this feature existed —
 * must show the real first-run screen again on next launch, with the new
 * category on it, and the fresh answer must stick (no third ask). That chain
 * only exists once main, preload and the renderer are wired together, hence
 * e2e rather than another unit test.
 *
 * Differentiation check performed for this file (not encoded as an assertion,
 * since TELEMETRY_CONSENT_VERSION is a source constant, not runtime state):
 * with `electron/telemetryConsent.ts` temporarily reverted to
 * `TELEMETRY_CONSENT_VERSION = 1`, `evaluateConsent` reads the seeded v1
 * record as `granted`/`denied` (not `needed`), so `telemetry-consent-dialog`
 * never mounts and every test below times out waiting for it. Restoring `2`
 * makes them pass again. See the test-gen report for the actual run log.
 */
test.describe('§2.122 telemetry consent — version bump re-ask (AI key store category)', () => {
  let dataDir: string | undefined
  let ctx: AppContext | undefined

  test.afterEach(async () => {
    if (ctx) await cleanupApp(ctx)
    ctx = undefined
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true })
    dataDir = undefined
  })

  /**
   * Seeds a profile as if a user had answered the FIRST-VERSION disclosure —
   * the exact shape `makeConsentRecord`/`applyAboutToggle` would have written
   * before the AI-key-store category existed.
   *
   * `theme` is required (no `.default()` in `settingsSchema`, packages/net/
   * config.ts) — omitting it fails the whole settings load with a ZodError
   * and the app never gets past bootstrap, which is why `seedLocale` above
   * sets it too.
   */
  async function seedV1Consent(granted: boolean): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailcopilot-e2e-consent-v1-'))
    await fs.writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        settings: {
          theme: 'light',
          telemetryConsent: { granted, version: 1, at: '2020-01-01T00:00:00.000Z' },
          sentryEnabled: granted,
        },
      }),
      'utf8',
    )
    return dir
  }

  test('a v1 grant is re-asked, shows the AI-key-store item among seven, and the fresh answer is not re-asked', async () => {
    dataDir = await seedV1Consent(true)

    // AC1 — a pre-existing v1 "allow" does not exempt this profile: the
    // disclosure changed, so the gate treats it exactly like an unanswered one.
    ctx = await launchAppWithConsentGate({ dataDir })
    const dialog = ctx.page.getByTestId('telemetry-consent-dialog')
    await expect(dialog).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // AC3 — the "sent" list now has seven items (six pre-existing categories
    // plus aiKeyStore), not six. Catches a future locale edit dropping a
    // <li>, not just this feature's own addition.
    const sentItems = ctx.page.getByTestId('telemetry-consent-sent').locator('li')
    await expect(sentItems).toHaveCount(7)

    // AC2 — the new item is present and its own text says the key VALUE is
    // never part of what is sent (electron/telemetryConsent.ts history entry
    // 2 / src/i18n/locales/*.json `telemetryConsent.sent.aiKeyStore`).
    const aiKeyStoreItem = sentItems.filter({ hasText: 'AI keys are kept' })
    await expect(aiKeyStoreItem).toHaveCount(1)
    await expect(aiKeyStoreItem).toContainText('The key itself is never sent')

    // Answer again under the new disclosure.
    await ctx.page.getByTestId('telemetry-consent-allow').click()
    await expect(ctx.page.getByTestId('inbox-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // AC4 — the record now carries the CURRENT version, not the one that was
    // seeded.
    const afterAnswer = await readSettings(ctx)
    expect(afterAnswer.telemetryConsent?.granted).toBe(true)
    expect(afterAnswer.telemetryConsent?.version).toBe(2)
    expect(afterAnswer.telemetryConsent?.version).not.toBe(1)
    expect(afterAnswer.sentryEnabled).toBe(true)

    // Same profile, one more launch: must come straight up with no dialog —
    // the re-ask happens exactly once, not on every start.
    await cleanupApp(ctx)
    ctx = await launchAppWithConsentGate({ dataDir })
    await expect(ctx.page.getByTestId('inbox-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(ctx.page.getByTestId('telemetry-consent-dialog')).toHaveCount(0)

    const afterRestart = await readSettings(ctx)
    expect(afterRestart.telemetryConsent?.version).toBe(2)
    expect(afterRestart.telemetryConsent?.granted).toBe(true)
  })

  test('a v1 refusal is re-asked, and a fresh refusal under the new version is not re-asked', async () => {
    dataDir = await seedV1Consent(false)

    // AC1, for the "denied" branch — refusal alone does not exempt a profile
    // from the re-ask either; only the composition version does.
    ctx = await launchAppWithConsentGate({ dataDir })
    await expect(ctx.page.getByTestId('telemetry-consent-dialog')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await ctx.page.getByTestId('telemetry-consent-deny').click()
    await expect(ctx.page.getByTestId('inbox-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // AC5 — the refusal is recorded under the new version, not silently
    // dropped or left at the old one.
    const afterAnswer = await readSettings(ctx)
    expect(afterAnswer.telemetryConsent?.granted).toBe(false)
    expect(afterAnswer.telemetryConsent?.version).toBe(2)
    expect(afterAnswer.sentryEnabled).toBe(false)

    // AC5 — and it is not asked a third time.
    await cleanupApp(ctx)
    ctx = await launchAppWithConsentGate({ dataDir })
    await expect(ctx.page.getByTestId('inbox-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(ctx.page.getByTestId('telemetry-consent-dialog')).toHaveCount(0)

    const afterRestart = await readSettings(ctx)
    expect(afterRestart.telemetryConsent?.version).toBe(2)
    expect(afterRestart.telemetryConsent?.granted).toBe(false)
  })
})
