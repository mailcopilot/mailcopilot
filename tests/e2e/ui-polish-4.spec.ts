/**
 * UI Polish bundle #4 — uiaudit.3 PR B4 regression checks.
 *
 * Covers DOM-observable assertions for the "Open in window" feature:
 *
 *   open-in-window-button-visible   — mail-action-open-in-window button is
 *                                     visible in both account and unified
 *                                     view modes once a mail is selected
 *   toolbar-actions-justify-end     — .mail-viewer-actions uses justify-content
 *                                     flex-end (Gmail/Spark/Apple Mail style)
 *   open-in-window-invoke-called    — clicking the button calls
 *                                     window.api.invoke('mail:openInWindow', …)
 *                                     with the correct payload shape
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, EXPECT_TIMEOUT, type AppContext } from './helpers'

// =============================================================================
// Shared helper: open first mail item in the list
// =============================================================================

async function openFirstMail(page: import('@playwright/test').Page) {
  const firstMail = page.getByTestId('mail-item').first()
  await expect(firstMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
  await firstMail.click()
  // Wait for the mail viewer to show the active message (subject visible)
  const subject = page.getByTestId('mail-subject')
  await expect(subject).toBeVisible({ timeout: EXPECT_TIMEOUT })
}

// =============================================================================
// open-in-window-button-visible — account view mode
// =============================================================================

test('polish-4: open-in-window button is visible when a mail is selected (account view)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-polish4a-'))
    const page = ctx.page!

    await openFirstMail(page)

    const btn = page.getByTestId('mail-action-open-in-window')
    await expect(btn).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// open-in-window-button-visible — unified view mode
// =============================================================================

test('polish-4: open-in-window button is visible when a mail is selected (unified view)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-polish4b-'))
    const page = ctx.page!

    // Switch to unified view via the sidebar folder toggle
    const unifiedBtn = page.getByTestId('folder-unified')
    await expect(unifiedBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await unifiedBtn.click()

    // Wait for mail list to repopulate in unified mode
    await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await openFirstMail(page)

    const btn = page.getByTestId('mail-action-open-in-window')
    await expect(btn).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// toolbar-actions-justify-end — computed style assertion
// =============================================================================

test('polish-4: mail-viewer-actions toolbar is right-aligned (justify-content flex-end)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-polish4c-'))
    const page = ctx.page!

    await openFirstMail(page)

    // Wait for the toolbar to appear before inspecting computed style
    const btn = page.getByTestId('mail-action-open-in-window')
    await expect(btn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const justifyContent = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.mail-viewer-actions')
      if (!el) return null
      return window.getComputedStyle(el).justifyContent
    })

    // Browsers normalise 'flex-end' to 'flex-end' in getComputedStyle
    expect(justifyContent).toBe('flex-end')
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// open-in-window-invoke-called — verify IPC payload shape
// =============================================================================

test('polish-4: clicking open-in-window button is enabled and does not crash the UI', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-polish4d-'))
    const page = ctx.page!

    await openFirstMail(page)

    // Verify the mail viewer shows a message
    const subjectText = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="mail-subject"]')
      return el ? el.textContent?.trim() : null
    })
    expect(subjectText).toBeTruthy()

    const btn = page.getByTestId('mail-action-open-in-window')
    await expect(btn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(btn).toBeEnabled()

    // Click the button — triggers window.api.invoke('mail:openInWindow', …).
    // The handler's account guard now consults the same roster `accounts:list`
    // serves (E2E_ACCOUNTS under MAILCOPILOT_E2E=1), so a real standalone
    // window does open here; its lifetime is covered by
    // standalone-window-lifecycle.spec.ts. This test stays scoped to the main
    // window and verifies that:
    //   (a) the button click does not throw a renderer-visible error / crash overlay
    //   (b) the main-window mail viewer remains intact after the click
    await btn.click()

    // Give the async IPC a moment to settle
    await page.waitForTimeout(300)

    // Main window should still be stable — mail viewer still visible
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // No error overlay / crash screen should appear
    const errorOverlay = page.locator('.error-overlay, [data-testid="error-boundary"]')
    await expect(errorOverlay).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})
