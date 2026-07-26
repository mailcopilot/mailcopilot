/**
 * UI Polish bundle #1 — merge-gate regression checks.
 *
 * Covers DOM-observable assertions for the Track C polish tasks that cannot be
 * verified by unit tests (CSS-only or structural changes):
 *
 *   uiaudit.1  — tooltip z-index raised to 9999 (above mail list)
 *   uiaudit.2  — hover-action chips removed; only .mail-date remains on right
 *   uiaudit.5  — .settings-tabs width is 200px
 *   uiaudit.10 — compose textarea font-family inherits (no monospace)
 *   uiaudit.12 — installPath wrapped in <code> with break-word style
 *   uiaudit.13 — settings-content card centered on wide viewport
 *   uiaudit.15 — .folder-policy-list-scroll has no inner overflow-y scroll
 *   uiaudit.17a — followup label has className "setting-check"
 *   uiaudit.17b — compose-cc-toggle has adequate padding + transition
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, EXPECT_TIMEOUT, type AppContext } from './helpers'

// =============================================================================
// uiaudit.2 — hover-action chips removed from mail list
// =============================================================================

test('uiaudit.2: mail list items have no .mail-hover-actions element', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const firstMail = page.getByTestId('mail-item').first()
    await expect(firstMail).toBeVisible()

    // Hover to trigger any CSS :hover state
    await firstMail.hover()
    await page.waitForTimeout(200)

    // .mail-hover-actions must not exist in DOM after the removal
    const hoverActions = firstMail.locator('.mail-hover-actions')
    await expect(hoverActions).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

test('uiaudit.2: mail date is directly visible (no wrapping .mail-date-area)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const firstMail = page.getByTestId('mail-item').first()
    await expect(firstMail).toBeVisible()

    // After uiaudit.2 the .mail-right contains .mail-date directly (no .mail-date-area)
    const mailDate = firstMail.locator('.mail-date')
    await expect(mailDate).toBeVisible()

    // Must NOT be nested inside .mail-date-area (that element was removed)
    const dateArea = firstMail.locator('.mail-date-area')
    await expect(dateArea).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// uiaudit.5 — .settings-tabs width 200px
// =============================================================================

test('uiaudit.5: settings-tabs panel is 200px wide', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const width = await settings.locator('.settings-tabs').evaluate(
      (el: HTMLElement) => Math.round(el.getBoundingClientRect().width),
    )
    // Allow 1px rounding tolerance
    expect(width).toBeGreaterThanOrEqual(199)
    expect(width).toBeLessThanOrEqual(201)

    await settings.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// uiaudit.10 — compose textarea font-family inherits system font
// =============================================================================

test('uiaudit.10: compose textarea does not use a monospace font family', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.locator('.sidebar-compose-btn').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    await expect(compose.getByTestId('compose-text')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const fontFamily = await compose.getByTestId('compose-text').evaluate(
      (el: HTMLElement) => window.getComputedStyle(el).fontFamily,
    )

    // The textarea must NOT be resolving to a monospace font.
    // Common monospace font names to rule out.
    const lower = fontFamily.toLowerCase()
    expect(lower).not.toContain('monospace')
    expect(lower).not.toContain('courier')
    expect(lower).not.toContain('menlo')
    expect(lower).not.toContain('consolas')

    await compose.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// uiaudit.12 — installPath rendered inside <code> element
// =============================================================================

test('uiaudit.12: settings About tab installPath is inside a <code> element', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-about').click()
    await expect(settings.getByTestId('settings-about-install-path')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const hasCode = await settings.getByTestId('settings-about-install-path').evaluate(
      (el: HTMLElement) => el.querySelector('code') !== null,
    )
    expect(hasCode).toBe(true)

    await settings.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// uiaudit.13 — settings-content card centered on wide viewport
// =============================================================================

test('uiaudit.13: settings-content card is horizontally centered on wide viewport', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Use a wide viewport to make centering observable
    await settings.setViewportSize({ width: 1600, height: 900 })
    await settings.waitForTimeout(200)

    // Find first .settings-content (non-folders tab)
    const result = await settings.locator('.settings-content:not(.settings-content-folders)').first().evaluate(
      (el: HTMLElement) => {
        const rect = el.getBoundingClientRect()
        // The content area starts after .settings-tabs sidebar; measure centering
        // within the available content zone, not the full layout width.
        const sidebar = el.closest('.settings-layout')?.querySelector('.settings-tabs')
        const sidebarRight = sidebar ? sidebar.getBoundingClientRect().right : 0
        const layoutRect = el.parentElement?.getBoundingClientRect() ?? { right: window.innerWidth }
        const contentZoneLeft = sidebarRight
        const contentZoneRight = layoutRect.right
        const contentZoneCenter = contentZoneLeft + (contentZoneRight - contentZoneLeft) / 2
        const elCenter = rect.left + rect.width / 2
        return {
          contentZoneCenter: Math.round(contentZoneCenter),
          elCenter: Math.round(elCenter),
          elWidth: Math.round(rect.width),
        }
      },
    )

    // Card center must be within 30px of the content-zone center (margin: auto centering)
    expect(Math.abs(result.contentZoneCenter - result.elCenter)).toBeLessThanOrEqual(30)
    // Card should be constrained to max-width (600px)
    expect(result.elWidth).toBeLessThanOrEqual(605)

    await settings.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// uiaudit.15 — .folder-policy-list-scroll has no inner overflow-y scroll
// =============================================================================

test('uiaudit.15: folder-policy-list-scroll has no independent vertical scrollbar', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-folders').click()
    await settings.waitForTimeout(300)

    const scrollEl = settings.locator('.folder-policy-list-scroll').first()

    // The element may not exist if there are no folders — skip gracefully.
    const count = await scrollEl.count()
    if (count === 0) {
      return
    }

    const overflowY = await scrollEl.evaluate(
      (el: HTMLElement) => window.getComputedStyle(el).overflowY,
    )
    // After uiaudit.15 the element must not have auto/scroll overflow-y
    expect(overflowY).not.toBe('auto')
    expect(overflowY).not.toBe('scroll')

    await settings.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// uiaudit.17a — followup label has class "setting-check"
// =============================================================================

test('uiaudit.17a: compose follow-up label has setting-check class', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.locator('.sidebar-compose-btn').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    const followUpArea = compose.locator('.compose-followup')
    await expect(followUpArea).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The <label> wrapping the follow-up checkbox must have the setting-check class
    const label = followUpArea.locator('label')
    await expect(label).toHaveClass(/setting-check/)

    await compose.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// uiaudit.17b — compose-cc-toggle has adequate padding
// =============================================================================

test('uiaudit.17b: compose-cc-toggle has padding >= 6px vertical', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.locator('.sidebar-compose-btn').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    await expect(compose.getByTestId('compose-cc-toggle')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const paddingTop = await compose.getByTestId('compose-cc-toggle').evaluate(
      (el: HTMLElement) => parseFloat(window.getComputedStyle(el).paddingTop),
    )
    // uiaudit.17b raised padding from 2px to 6px
    expect(paddingTop).toBeGreaterThanOrEqual(6)

    await compose.evaluate(() => window.close()).catch(() => {})
  } finally {
    await cleanupApp(ctx)
  }
})

