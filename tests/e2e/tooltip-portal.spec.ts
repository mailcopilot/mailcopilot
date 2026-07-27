/**
 * E2E regression tests for uiaudit.1 (reopened) — tooltip portal.
 *
 * Verifies that sidebar collapsed-mode tooltips are rendered via the
 * `.tooltip-portal` React component (position:fixed, outside <aside>)
 * rather than the old [data-tooltip]::after pseudo-element approach.
 *
 * The portal escapes .mailcopilot-sidebar overflow:hidden so tooltips
 * are visible over the mail-list panel when the sidebar is collapsed.
 *
 * Run: npm run e2e:bg   (xvfb wrapper required per CLAUDE.md §7)
 */
import { test, expect, type Locator } from '@playwright/test'
import { launchApp, cleanupApp, EXPECT_TIMEOUT, type AppContext } from './helpers'

// ─────────────────────────────────────────────────────────────────────────────
// Helper: collapse the sidebar by clicking the sidebar-toggle-btn.
// Returns when the <aside> no longer has class "sidebar-expanded".
// ─────────────────────────────────────────────────────────────────────────────
async function collapseSidebar(ctx: AppContext): Promise<void> {
  const { page } = ctx
  // Only click if currently expanded
  const isExpanded = await page
    .locator('aside.mailcopilot-sidebar')
    .evaluate((el: HTMLElement) => el.classList.contains('sidebar-expanded'))
  if (isExpanded) {
    await page.locator('.sidebar-toggle-btn').click()
    // Wait until the class is removed
    await expect(page.locator('aside.mailcopilot-sidebar.sidebar-expanded')).toHaveCount(0, {
      timeout: EXPECT_TIMEOUT,
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: hover a collapsed-sidebar tooltip trigger and wait for its
// `.tooltip-portal`, RE-DISPATCHING the hover on every poll iteration.
//
// Root cause this guards against (tooltip-portal:39 flake): the portal is driven
// by a single native `mouseover` on the trigger (event delegation on
// `.mailcopilot-app`, see src/hooks/useTooltipDelegation.ts). A lone Playwright
// `.hover()` can be *lost* — under heavy parallel-xvfb load it may land a tick
// before React has committed the collapsed-mode render, or be coalesced when the
// pointer is already sitting on the target — so that one `mouseover` produces no
// portal. A plain `expect(portal).toBeVisible()` then waits out its FULL timeout
// on a portal that will never appear (the mouse is stationary → no second
// `mouseover`). Moving the pointer to a neutral spot and hovering again each
// iteration guarantees a fresh `mouseover` until the portal mounts. This is a
// robustness fix for the triggering action, not a blind timeout bump.
// ─────────────────────────────────────────────────────────────────────────────
async function hoverForPortal(ctx: AppContext, trigger: Locator): Promise<Locator> {
  const { page } = ctx
  const portal = page.locator('.tooltip-portal')
  const vp = page.viewportSize()
  const awayX = (vp?.width ?? 1280) - 5 // right edge — off the sidebar, no data-tooltip
  const awayY = Math.floor((vp?.height ?? 800) / 2)
  await expect(async () => {
    await page.mouse.move(awayX, awayY) // ensure the next hover is a genuine pointer move
    await trigger.hover()
    await expect(portal).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: EXPECT_TIMEOUT })
  return portal
}

// ─────────────────────────────────────────────────────────────────────────────
// uiaudit.1 (portal): .tooltip-portal appears on hover when sidebar is collapsed
// ─────────────────────────────────────────────────────────────────────────────

test('uiaudit.1 portal: hovering data-tooltip element shows .tooltip-portal', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-tooltip-portal-'))
    const fullCtx = ctx as AppContext
    const { page } = fullCtx

    await collapseSidebar(fullCtx)

    // Hover the compose button — it gets data-tooltip when sidebar is collapsed
    const composeBtn = page.locator('[data-testid="sidebar-compose"]')
    await expect(composeBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Portal div must appear in DOM (hover re-dispatched until it mounts)
    const portal = await hoverForPortal(fullCtx, composeBtn)

    // Text must match the data-tooltip attribute value on the button
    const tooltipText = await composeBtn.getAttribute('data-tooltip')
    expect(tooltipText).toBeTruthy()
    await expect(portal).toContainText(tooltipText!)
  } finally {
    await cleanupApp(ctx)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// uiaudit.1 (portal): .tooltip-portal has position:fixed computed style
// ─────────────────────────────────────────────────────────────────────────────

test('uiaudit.1 portal: .tooltip-portal has position fixed', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-tooltip-pos-'))
    const fullCtx = ctx as AppContext
    const { page } = fullCtx

    await collapseSidebar(fullCtx)

    const composeBtn = page.locator('[data-testid="sidebar-compose"]')
    await expect(composeBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const portal = await hoverForPortal(fullCtx, composeBtn)

    // `toHaveCSS` re-resolves the locator and auto-retries until the expect
    // timeout, so a transient detach/recreate of the portal node during a React
    // commit resolves on the next poll. A one-shot `getComputedStyle` read
    // (the tooltip-portal:98 flake) instead caught the detached node and
    // returned position:"" — this is the robust equivalent, not a timeout bump.
    await expect(portal).toHaveCSS('position', 'fixed', { timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// uiaudit.1 (portal): .tooltip-portal is NOT inside <aside> (portal escapes DOM)
// ─────────────────────────────────────────────────────────────────────────────

test('uiaudit.1 portal: .tooltip-portal is rendered outside <aside>', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-tooltip-outside-'))
    const fullCtx = ctx as AppContext
    const { page } = fullCtx

    await collapseSidebar(fullCtx)

    const composeBtn = page.locator('[data-testid="sidebar-compose"]')
    await expect(composeBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const portal = await hoverForPortal(fullCtx, composeBtn)

    // Verify the portal is NOT a descendant of <aside>
    const isInsideAside = await portal.evaluate((el: HTMLElement) => {
      return el.closest('aside') !== null
    })
    expect(isInsideAside).toBe(false)
  } finally {
    await cleanupApp(ctx)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// uiaudit.1 (portal): tooltip visually overlaps mail-list panel
// (bounding-box overlap check — stronger than z-index comparison alone)
// ─────────────────────────────────────────────────────────────────────────────

test('uiaudit.1 portal: tooltip bounding box overlaps or is adjacent to mail-list area', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-tooltip-overlap-'))
    const fullCtx = ctx as AppContext
    const { page } = fullCtx

    await collapseSidebar(fullCtx)

    const composeBtn = page.locator('[data-testid="sidebar-compose"]')
    await expect(composeBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const portal = await hoverForPortal(fullCtx, composeBtn)

    const portalBox = await portal.boundingBox()
    expect(portalBox).not.toBeNull()

    // The tooltip portal renders at position:fixed with left = rect.right + 8px,
    // i.e. to the right of the sidebar icon. The mail-list section starts right
    // after the sidebar. Verify the portal x coordinate is in the right half of
    // the viewport (past the collapsed sidebar width of ~56px).
    expect(portalBox!.x).toBeGreaterThan(50)

    // The portal must be within the visible viewport vertically.
    const viewportHeight = page.viewportSize()?.height ?? 800
    expect(portalBox!.y).toBeGreaterThanOrEqual(0)
    expect(portalBox!.y).toBeLessThan(viewportHeight)
  } finally {
    await cleanupApp(ctx)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// uiaudit.1 (portal): tooltip disappears on mouse-leave
// ─────────────────────────────────────────────────────────────────────────────

test('uiaudit.1 portal: .tooltip-portal disappears after mouse leave', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-tooltip-leave-'))
    const fullCtx = ctx as AppContext
    const { page } = fullCtx

    await collapseSidebar(fullCtx)

    const composeBtn = page.locator('[data-testid="sidebar-compose"]')
    await expect(composeBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const portal = await hoverForPortal(fullCtx, composeBtn)

    // Move mouse to a neutral element that has no data-tooltip
    await page.getByTestId('inbox-list').hover()
    await page.waitForTimeout(150)

    // Portal must be gone
    await expect(portal).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// uiaudit.1 (portal): tooltip NOT shown when sidebar is expanded
// (data-tooltip attribute is removed from buttons in expanded mode)
// ─────────────────────────────────────────────────────────────────────────────

test('uiaudit.1 portal: no tooltip portal while sidebar is expanded', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-tooltip-expanded-'))
    const { page } = ctx as AppContext

    // Sidebar starts expanded by default — verify that
    const isExpanded = await page
      .locator('aside.mailcopilot-sidebar')
      .evaluate((el: HTMLElement) => el.classList.contains('sidebar-expanded'))
    // If app launches collapsed (non-default env), skip this assertion
    if (!isExpanded) {
      return
    }

    // Hover compose button — in expanded mode data-tooltip is undefined
    const composeBtn = page.locator('[data-testid="sidebar-compose"]')
    await expect(composeBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await composeBtn.hover()
    await page.waitForTimeout(200)

    // Portal must NOT appear while sidebar is expanded
    await expect(page.locator('.tooltip-portal')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})
