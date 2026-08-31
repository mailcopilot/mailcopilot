/**
 * §2.99 — Settings → General "tray" toggles (`trayEnabled` / `closeToTray` /
 * `launchAtLogin`), promoted from qa-plan's manual checklist to a permanent
 * e2e spec.
 *
 * Everything DECIDABLE about these toggles is unit-tested already: the
 * subordination rule and status display (TraySection.test.tsx), the schema
 * round trip (packages/net/config.test.ts), and the real-component
 * load/save wiring inside Settings.tsx (Settings.tray.test.tsx, jsdom-mounted
 * but never actually round-tripped through a real `settings:save` /
 * `settings:load` IPC pair or a real window close+reopen). What none of that
 * proves — and what a headless jsdom mount cannot prove — is the thing qa-plan
 * flagged as Playwright-verifiable and currently unautomated:
 *
 *   1. The value SURVIVES an actual window close and a fresh mount of the
 *      Settings component, reading its own persisted state back through the
 *      real `settings:get` IPC round trip main.ts serves it.
 *   2. Two DIFFERENT tabs' fields, both folded into the same single
 *      `settings:save` payload object (Settings.tsx §5 hotspot — one giant
 *      `save()` closure references ~50 pieces of state at once), do not
 *      clobber each other across a reopen — a real risk in a component this
 *      size, where a missing field in either the `apply()` reload function or
 *      the save payload would silently revert whatever the OTHER tab set.
 *
 * Safe under IS_E2E: `applyTrayEnabled` / `applyLaunchAtLoginSetting`
 * (electron/services/backgroundMail.ts) both no-op under `hooks.isE2E` — the
 * actual tray icon / OS autostart registration never fires — but the
 * renderer-writable settings fields themselves persist through the ordinary
 * `settings:save` → electron-store → `settings:get` path regardless, which is
 * exactly what these two cases exercise.
 *
 * `settings-notifications-enabled` testid added to Settings.tsx (Productivity
 * tab checkbox previously had none) — needed for case 2's cross-tab field.
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, EXPECT_TIMEOUT, CLOSE_TIMEOUT, type AppContext } from './helpers'

/** Open Settings from the main window and land on the General tab (the default). */
async function openSettingsGeneral(ctx: AppContext) {
  await ctx.page.getByTestId('open-settings').click()
  const settings = await waitForPage(ctx.browser, p => p.url().includes('#/settings'))
  await settings.waitForLoadState('domcontentloaded')
  await expect(settings.getByTestId('settings-tray-enabled')).toBeVisible({ timeout: 45_000 })
  return settings
}

test('Settings → General: tray/close-to-tray/launch-at-login survive save, close and reopen; closeToTray is disabled+dimmed while the tray icon is off', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-tray-settings-'))
    const app = ctx as AppContext
    const settings1 = await openSettingsGeneral(app)

    const trayBox = settings1.getByTestId('settings-tray-enabled')
    const closeBox = settings1.getByTestId('settings-tray-close-to-tray')
    const loginBox = settings1.getByTestId('settings-tray-launch-at-login')

    // Fresh e2e profile boots on the schema defaults: tray on, the other two off.
    await expect(trayBox).toBeChecked()
    await expect(closeBox).not.toBeChecked()
    await expect(loginBox).not.toBeChecked()

    // Visual guard (cheap here, since we are already on this screen): turning
    // the tray icon off disables AND dims its dependent toggle — a real DOM
    // property + computed style, not just component-level props (that half is
    // already covered by TraySection.test.tsx; this is the same rule wired
    // into the actual browser render).
    await trayBox.uncheck()
    await expect(closeBox).toBeDisabled()
    const dimmedOpacity = await closeBox.evaluate(el => {
      const label = el.closest('label')
      return label ? getComputedStyle(label).opacity : null
    })
    expect(dimmedOpacity).toBe('0.5')

    // Restore the tray icon before making the values we actually intend to
    // persist — closeToTray can only be turned on while it is enabled.
    await trayBox.check()
    await expect(closeBox).toBeEnabled()

    await closeBox.check()
    await loginBox.check()
    await expect(trayBox).toBeChecked()
    await expect(closeBox).toBeChecked()
    await expect(loginBox).toBeChecked()

    await settings1.getByTestId('settings-save').click()
    await expect.poll(() => settings1.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // Reopen: a fresh mount, reading the persisted record back through the
    // real settings:get IPC round trip — not the in-memory state of the
    // window we just closed.
    await app.page.bringToFront()
    const settings2 = await openSettingsGeneral(app)

    await expect(settings2.getByTestId('settings-tray-enabled')).toBeChecked()
    await expect(settings2.getByTestId('settings-tray-close-to-tray')).toBeChecked()
    await expect(settings2.getByTestId('settings-tray-launch-at-login')).toBeChecked()
  } finally {
    await cleanupApp(ctx)
  }
})

test('Settings: a tray toggle (General) and the notifications master switch (Productivity) share one save payload without clobbering each other', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-tray-settings-crosstab-'))
    const app = ctx as AppContext
    const settings1 = await openSettingsGeneral(app)

    // General tab: flip launchAtLogin on (default off). No subordination
    // complication like closeToTray, so this isolates the cross-tab claim.
    const loginBox = settings1.getByTestId('settings-tray-launch-at-login')
    await expect(loginBox).not.toBeChecked()
    await loginBox.check()

    // Productivity tab: flip the notifications master switch off (default on).
    await settings1.getByTestId('settings-tab-productivity').click()
    const notifBox = settings1.getByTestId('settings-notifications-enabled')
    await expect(notifBox).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(notifBox).toBeChecked()
    await notifBox.uncheck()

    // One Save call folds both tabs' state into the same settings:save payload.
    await settings1.getByTestId('settings-save').click()
    await expect.poll(() => settings1.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    await app.page.bringToFront()
    const settings2 = await openSettingsGeneral(app)
    await expect(settings2.getByTestId('settings-tray-launch-at-login')).toBeChecked()
    await settings2.getByTestId('settings-tab-productivity').click()
    await expect(settings2.getByTestId('settings-notifications-enabled')).not.toBeChecked()

    // Flip ONLY the Productivity switch back on. If Settings.tsx's reload
    // (`apply()`) or its save payload ever dropped one of the tray fields,
    // this second, ISOLATED save would silently revert launchAtLogin to its
    // React default (false) even though nobody touched that checkbox —
    // exactly the "one tab's save clobbers the other's fields" regression
    // this test exists to catch.
    await settings2.getByTestId('settings-notifications-enabled').check()
    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    await app.page.bringToFront()
    const settings3 = await openSettingsGeneral(app)
    // The untouched-this-round General field survived the Productivity-only save.
    await expect(settings3.getByTestId('settings-tray-launch-at-login')).toBeChecked()
    await settings3.getByTestId('settings-tab-productivity').click()
    await expect(settings3.getByTestId('settings-notifications-enabled')).toBeChecked()
  } finally {
    await cleanupApp(ctx)
  }
})
