/**
 * §3.3.B4.f6 — lifetime of the standalone (unparented) windows.
 *
 * Compose and the standalone message window are created WITHOUT a WM `parent`
 * so GNOME/Mutter keeps their maximize function (see
 * electron/childWindowOptions.ts). Unparenting removed Electron's automatic
 * teardown of children, so `main.ts` reproduces it explicitly with the
 * `standaloneChildWindows` registry, swept from the main window's `closed`
 * event. This spec is the end-to-end half of that contract — the unit suites
 * (`childWindowOptions.test.ts`, `main.standaloneWindows.test.ts`) pin the
 * decision and the source wiring, but only a real run proves that closing the
 * main window actually takes both window kinds down and lets the app quit.
 *
 * The sweep destroys rather than closes (see `closeStandaloneChildWindows`):
 * the WM teardown it stands in for was not cancellable, and a compromised
 * renderer must not be able to refuse the end of the session. That is why the
 * assertions below are unconditional — no window kind is allowed a say.
 *
 * What is deliberately NOT asserted here: maximize. The regression that
 * motivated the unparenting is a GNOME/Mutter behaviour
 * (`has_maximize_func` cleared on transient windows); the suite runs under
 * Xvfb with no window manager at all, where `maximize()` succeeds regardless
 * of `WM_TRANSIENT_FOR` and the assertion would pass on the broken build too.
 * That check stays manual (qa-plan).
 */
import { test, expect, type Browser, type Page } from '@playwright/test'
import {
  launchApp,
  cleanupApp,
  waitForPage,
  CLOSE_TIMEOUT,
  EXPECT_TIMEOUT,
  IS_CI,
  type AppContext,
} from './helpers'

/** App quit runs the async before-quit flush (telemetry + Sentry). */
const QUIT_TIMEOUT = IS_CI ? 60_000 : 30_000

async function openCompose(page: Page, browser: Browser): Promise<Page> {
  await page.locator('.sidebar-compose-btn').click()
  const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
  await compose.waitForLoadState('domcontentloaded')
  return compose
}

/**
 * Opens the first message of the list in a standalone window, via the same
 * toolbar button the user clicks (`mail-action-open-in-window`, see
 * ui-polish-4.spec.ts).
 */
async function openMailInWindow(page: Page, browser: Browser): Promise<Page> {
  const firstMail = page.getByTestId('mail-item').first()
  await expect(firstMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
  await firstMail.click()
  await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

  const btn = page.getByTestId('mail-action-open-in-window')
  await expect(btn).toBeVisible({ timeout: EXPECT_TIMEOUT })
  await btn.click()

  const mailWindow = await waitForPage(browser, p => p.url().includes('#/mail-window'))
  await mailWindow.waitForLoadState('domcontentloaded')
  return mailWindow
}

test('standalone windows: a manually closed window leaves the registry intact', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-standalone-lifecycle-a-'))
    const page = ctx.page!
    const browser = ctx.browser!

    const compose = await openCompose(page, browser)
    const mailWindow = await openMailInWindow(page, browser)

    // Close ONE standalone window the way a user would. Its `closed` listener
    // must remove only its own entry from `standaloneChildWindows`.
    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // The sibling standalone window is untouched...
    expect(mailWindow.isClosed()).toBe(false)
    // ...and the main window still works (no crash overlay, list still live).
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // ...and the registry still accepts new windows after the removal — a
    // sweep-time exception or a clobbered Set would show up as the second
    // Compose window never appearing.
    const compose2 = await openCompose(page, browser)
    expect(compose2.isClosed()).toBe(false)
  } finally {
    await cleanupApp(ctx)
  }
})

test('standalone windows: closing the main window destroys both and the app quits', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-standalone-lifecycle-b-'))
    const page = ctx.page!
    const browser = ctx.browser!
    const proc = ctx.proc!

    const compose = await openCompose(page, browser)
    const mailWindow = await openMailInWindow(page, browser)
    expect(compose.isClosed()).toBe(false)
    expect(mailWindow.isClosed()).toBe(false)

    // The evaluate itself may reject: closing the main window tears down the
    // execution context it is running in. The assertions below are the check.
    await page.evaluate(() => window.close()).catch(() => {})

    // Both unparented windows must go down with the main window. Before the
    // registry existed they survived it, which on Linux/Windows kept
    // `window-all-closed` from firing. The teardown is terminal (`destroy()`),
    // so a page that wanted to stay — an honest one with unsaved state, or a
    // compromised one holding on to its preload bridge — has no way to.
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await expect.poll(() => mailWindow.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await expect.poll(() => page.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // ...and with no window left, `window-all-closed` reaches `app.quit()`:
    // the process itself must exit. This is the assertion an orphaned window
    // would fail — the app would sit there forever with no visible UI.
    // macOS is excluded because `window-all-closed` deliberately does not quit
    // there (main.ts mirrors the platform convention); the window assertions
    // above still run on every platform.
    if (process.platform !== 'darwin') {
      await expect
        .poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: QUIT_TIMEOUT })
        .toBe(true)
    }
  } finally {
    await cleanupApp(ctx)
  }
})
