/**
 * §2.58 — Settings → About → auto-update checkbox regression coverage.
 *
 * `resolveSelfUpdateSupport()` replaced `canWriteAppDir(process.execPath)` as
 * the predicate behind `canSelfUpdate`, and SystemInfo.tsx stopped disabling
 * the "Automatically download updates" checkbox — it now shows a warning
 * next to an operable control instead of locking the preference away.
 *
 * What this file can and cannot prove, given e2e always runs unpackaged
 * (`vite build --mode e2e`, no electron-builder pack step):
 *   - `app.isPackaged` is false, so `update:systemInfo` always resolves
 *     `blockedReason: 'not-packaged'` and the component renders its
 *     dedicated "unsupported" state instead of the new warning paragraph.
 *     The warning-text branch is covered at the unit level
 *     (SystemInfo.test.tsx) where `isPackaged` is mocked to `true`.
 *   - What IS observable end-to-end, through the real IPC round trip
 *     (renderer → preload → main's `update:systemInfo` handler), is that the
 *     checkbox is no longer disabled. Before this change, dev/e2e builds hit
 *     the exact same `canSelfUpdate=false` path and the old
 *     `disabled={!canSelfUpdate}` prop made the checkbox permanently
 *     unusable here too — so this is a real regression check, not a mirror.
 *
 * qa-plan follow-up (post §2.58 manual checklist): a save → close → reopen
 * round trip for the checkbox, exercising the real `settings:save` /
 * `settings:load` persistence path (not just in-memory renderer state).
 *
 * Deliberately NOT covered here: forcing `update:systemInfo` to resolve
 * `null` because the IPC sender isn't the settings window
 * (`isSettingsWindowSender` in electron/main.ts). `SystemInfo.tsx` only ever
 * renders inside the settings window, so there is no naturally reachable
 * e2e path that calls this handler from a different sender and still mounts
 * the component to observe its reaction — reaching that branch would need
 * stubbing `window.api.invoke` inside the settings renderer, which replaces
 * the real IPC round trip with a fake one and stops testing the gate at all.
 * The "does not crash, falls back to a static version string" behavior is
 * already covered at the unit level (SystemInfo.test.tsx, `isPackaged`
 * mocked / `update:systemInfo` rejected).
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, EXPECT_TIMEOUT, CLOSE_TIMEOUT, type AppContext } from './helpers'

test('§2.58: auto-update checkbox is not disabled in Settings → About', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-about').click()

    const checkbox = settings.getByTestId('settings-about-auto-update')
    await expect(checkbox).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // Real regression check: before §2.58 this was `disabled={!canSelfUpdate}`,
    // and canSelfUpdate is false in every unpackaged (dev/e2e) run — so the
    // old code disabled this exact checkbox in this exact environment.
    await expect(checkbox).toBeEnabled()

    await settings.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

// qa-plan follow-up for §2.58: the two tests above only prove the checkbox is
// live and reflects the in-memory `SystemInfo.test.tsx` unsupported-vs-warning
// branch. Neither round-trips the value through `settings:save` + a fresh
// `settings:load` on reopen, so a bug that toggles the checkbox visually but
// never persists `autoUpdateEnabled` (e.g. a missing field in the save
// payload or the settingsSnapshot list at Settings.tsx) would pass both.
test('§2.58: auto-update checkbox value survives save, close, and reopen', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    let settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-tab-about')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await settings.getByTestId('settings-tab-about').click()

    const checkbox = settings.getByTestId('settings-about-auto-update')
    await expect(checkbox).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const before = await checkbox.isChecked()
    await checkbox.click()
    await expect(checkbox).toBeChecked({ checked: !before })

    // The Save button in this window persists and closes in one action (see
    // telemetryConsent.spec.ts for the same pattern) — waiting for the window
    // to actually close rules out reading stale renderer state on reopen.
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // Reopen a fresh Settings window — this re-runs `settings:load` from
    // disk/electron-store rather than reusing any in-memory renderer state.
    await page.getByTestId('open-settings').click()
    settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-tab-about')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await settings.getByTestId('settings-tab-about').click()

    const reopened = settings.getByTestId('settings-about-auto-update')
    await expect(reopened).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(reopened).toBeChecked({ checked: !before })

    await settings.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

test('§2.58: auto-update checkbox stays togglable and dev builds show the unsupported hint, not the warning', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-about').click()

    const checkbox = settings.getByTestId('settings-about-auto-update')
    await expect(checkbox).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const before = await checkbox.isChecked()
    await checkbox.click()
    await expect(checkbox).toBeChecked({ checked: !before })

    // Dev/e2e builds are 'not-packaged' — the component renders the
    // dedicated unsupported-state hint, and the §2.58 warning paragraph
    // (which is gated on `info.isPackaged === true`) must not appear.
    await expect(settings.getByTestId('settings-about-update-unsupported')).toBeVisible()
    await expect(settings.getByTestId('settings-about-self-update-warning')).toHaveCount(0)

    await settings.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})
