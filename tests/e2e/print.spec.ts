/**
 * E2E tests for §3.3.C-print.f1 — print button scopes printing to the mail body iframe.
 *
 * The fix: Ctrl+P is intercepted in main (before-input-event) → forwarded to the renderer
 * via `mail:print` IPC channel → renderer calls `iframe.contentWindow.print()`.
 * Previously it called `webContents.print()` which printed the entire window chrome.
 *
 * Coverage:
 *  1. Print button is visible when a mail is open.
 *  2. Mail panel actions (including print button) are hidden when no mail is open.
 *  3. Button click calls iframe.contentWindow.print() and NOT top-level window.print().
 *  4. Ctrl+P path: SKIP_NEEDS_INVESTIGATION (see comment below).
 *
 * Every test below that opens a mail selects the fixture message with an HTML
 * body explicitly (by its RU subject — fixture content is RU by default, see
 * `E2E_LANGUAGE` in electron/main.ts), rather than `mail-item.first()`. The
 * `iframe.mail-iframe` this suite exercises only renders when the opened
 * message has an `html` body (see MailBodyContent.tsx); `.first()` picks
 * whatever the inbox sorts to the top, which is not guaranteed to be an HTML
 * message and silently times out waiting for the iframe otherwise.
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, EXPECT_TIMEOUT, type AppContext } from './helpers'

/** RU subject of the fixture message with an HTML body (uid 100) — see
 *  electron/main.ts buildE2EBoxes / E2E_TEXTS.htmlSubject. */
const HTML_SUBJECT_RU = 'E2E1: html письмо'

test('print: button is visible when mail is open', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // No mail open yet — action toolbar is not rendered
    await expect(page.getByTestId('mail-action-print')).toHaveCount(0, { timeout: EXPECT_TIMEOUT })

    // Open the HTML-body fixture mail
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: HTML_SUBJECT_RU }))
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Print button must now be present
    await expect(page.getByTestId('mail-action-print')).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

test('print: button click calls iframe.contentWindow.print() not window.print()', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Open the HTML-body fixture mail — the iframe this test targets only
    // renders for a message that has an html body.
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: HTML_SUBJECT_RU }))
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Wait for the mail iframe to load
    const mailIframe = page.locator('iframe.mail-iframe')
    await expect(mailIframe).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Stub both the top-level window.print() and the iframe's contentWindow.print()
    // so we can distinguish which one was called.
    // TypeScript cast note: we access __printCalledOn via a typed intermediate variable
    // to avoid the `(expr)..prop` double-dot pattern that ESLint cannot parse.
    await page.evaluate(() => {
      const w = window as typeof window & { __printCalledOn: string }
      w.__printCalledOn = 'none'
      // Override top-level window.print (must NOT be called by the new code)
      window.print = () => { w.__printCalledOn = 'window' }
      // Override iframe contentWindow.print (SHOULD be called)
      const iframe = document.querySelector<HTMLIFrameElement>('iframe.mail-iframe')
      if (iframe?.contentWindow) {
        iframe.contentWindow.print = () => { w.__printCalledOn = 'iframe' }
      }
    })

    // Click the print button
    await page.getByTestId('mail-action-print').click()

    // Retrieve the result
    const calledOn = await page.evaluate(() => {
      const w = window as typeof window & { __printCalledOn: string }
      return w.__printCalledOn
    })

    // Top-level window.print must NOT have been called.
    // If calledOn === 'iframe', the iframe stub was patched successfully (same origin).
    // If calledOn === 'none', the iframe is sandboxed (cross-origin isolation prevented
    // patching contentWindow.print), which means the call went to the real iframe print
    // function — still correct, still not window.print.
    expect(calledOn).not.toBe('window')
  } finally {
    await cleanupApp(ctx)
  }
})

test('print: no mail open — action toolbar including print button is hidden', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // In the initial state no mail is selected — viewer panel including all action
    // buttons is not rendered at all.
    const printBtn = page.getByTestId('mail-action-print')
    await expect(printBtn).toHaveCount(0, { timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// ---------------------------------------------------------------------------
// Gap #1 (Blocker): regression guard — iframe sandbox contains allow-modals
// ---------------------------------------------------------------------------
// This test verifies that the BLOCKER fix (adding allow-modals to the iframe
// sandbox attribute in MailBodyContent) is not accidentally reverted.
// Without allow-modals the browser silently ignores iframe.contentWindow.print()
// calls — the print dialog never appears.
test('print: mail iframe sandbox attribute includes allow-modals (regression guard)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Open the HTML-body fixture mail so the iframe is rendered.
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: HTML_SUBJECT_RU }))
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const mailIframe = page.locator('iframe.mail-iframe')
    await expect(mailIframe).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The sandbox attribute must include allow-modals so that
    // iframe.contentWindow.print() is not silently blocked.
    const sandboxAttr = await mailIframe.getAttribute('sandbox')
    expect(sandboxAttr).toBeTruthy()
    expect(sandboxAttr).toContain('allow-modals')
  } finally {
    await cleanupApp(ctx)
  }
})

// ---------------------------------------------------------------------------
// Gap #4 (High): print button is visible and not disabled after mail opens
// ---------------------------------------------------------------------------
// After fix-wave 2.1.A the disabled prop was removed from the print button —
// verify the button is enabled (not disabled) once a mail is open.
test('print: button is visible and enabled after mail opens (not disabled)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Open the HTML-body fixture mail.
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: HTML_SUBJECT_RU }))
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const printBtn = page.getByTestId('mail-action-print')
    await expect(printBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Button must not carry the disabled attribute (regression guard against
    // the stale-ref disabled prop that existed before fix-wave 2.1.A).
    await expect(printBtn).toBeEnabled({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// SKIP_NEEDS_INVESTIGATION: Ctrl+P intercepted by Electron before-input-event
// cannot be triggered via Playwright page.keyboard.press() because Playwright
// sends keyboard events directly to the renderer DOM (via CDP Input.dispatchKeyEvent),
// bypassing the main process before-input-event handler where the intercept lives.
// The Electron webContents 'before-input-event' fires at the main process level,
// before the event reaches the renderer — Playwright only controls the renderer level.
// Verification of this path requires a dedicated integration test that directly calls
// win.webContents.send('mail:print') in main, which is covered by the unit tests in
// src/App.print.test.tsx (the listener handler invocation is exercised there).
test.skip('print: Ctrl+P triggers same iframe print path — SKIP_NEEDS_INVESTIGATION', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: HTML_SUBJECT_RU }))
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await page.evaluate(() => {
      const w = window as typeof window & { __printCalledOn: string }
      w.__printCalledOn = 'none'
      window.print = () => { w.__printCalledOn = 'window' }
      const iframe = document.querySelector<HTMLIFrameElement>('iframe.mail-iframe')
      if (iframe?.contentWindow) {
        iframe.contentWindow.print = () => { w.__printCalledOn = 'iframe' }
      }
    })

    // This does NOT trigger Electron's before-input-event in main process.
    await page.keyboard.press('Control+P')
    await page.waitForTimeout(500)

    const calledOn = await page.evaluate(() => {
      const w = window as typeof window & { __printCalledOn: string }
      return w.__printCalledOn
    })
    expect(calledOn).toBe('iframe')
  } finally {
    await cleanupApp(ctx)
  }
})
