/**
 * UI Polish bundle #3 — merge-gate regression checks.
 *
 * Covers DOM-observable assertions for layout polish tasks that require
 * a real Electron instance to verify:
 *
 *   uiaudit.7  — AI panel input always visible regardless of body content height
 *   uiaudit.14 — Sidebar compact mode triggered at narrow viewport (< 720px height)
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, EXPECT_TIMEOUT, type AppContext } from './helpers'

// =============================================================================
// uiaudit.7 — AI panel input is always visible (sticky-bottom outside .ai-body)
// =============================================================================

test('uiaudit.7: AI panel input is visible when panel has no content (empty state)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Configure AI provider and consent so the full panel renders (not onboarding)
    await page.evaluate(async () => {
      const current = await window.api.invoke('settings:get') as Record<string, unknown>
      await window.api.invoke('settings:save', {
        ...current,
        aiProvider: 'subscription',
        aiPrivacyConsent: true,
      })
    })

    // Open AI panel via sidebar toggle
    const aiButton = page.getByTestId('sidebar-ai')
    await expect(aiButton).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await aiButton.click()

    // Panel must open
    const aiPanel = page.getByTestId('ai-panel')
    await expect(aiPanel).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // In empty state (no messages, no chips — no mail selected), input must be visible
    const inputArea = page.locator('.ai-input-area')
    await expect(inputArea).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Verify the textarea within input-area is visible and not clipped below panel
    const aiInput = page.getByTestId('ai-input')
    await expect(aiInput).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Ensure input-area is not overflowing outside panel bounds
    const panelBox = await aiPanel.boundingBox()
    const inputBox = await inputArea.boundingBox()
    expect(panelBox).not.toBeNull()
    expect(inputBox).not.toBeNull()
    // Input bottom must be within panel bottom (with 2px rounding tolerance)
    expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 2)
  } finally {
    await cleanupApp(ctx)
  }
})

test('uiaudit.7: AI panel input remains visible when body has many messages', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Configure AI with consent
    await page.evaluate(async () => {
      const current = await window.api.invoke('settings:get') as Record<string, unknown>
      await window.api.invoke('settings:save', {
        ...current,
        aiProvider: 'subscription',
        aiPrivacyConsent: true,
      })
    })

    // Open AI panel
    const aiButton = page.getByTestId('sidebar-ai')
    await expect(aiButton).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await aiButton.click()

    const aiPanel = page.getByTestId('ai-panel')
    await expect(aiPanel).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Inject many synthetic user messages directly into the DOM by simulating
    // textarea input + send button clicks to build up conversation history.
    // We inject text via JS and click send multiple times to fill the messages area.
    const aiInput = page.getByTestId('ai-input')
    await expect(aiInput).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Send several messages to accumulate content in .ai-body
    for (let i = 1; i <= 5; i++) {
      await aiInput.fill(`Test message ${i} — filling the AI panel body with content to trigger scroll`)
      // Ctrl+Enter or send button — use the button for reliability
      const sendBtn = page.locator('.ai-send-btn').first()
      if (await sendBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await sendBtn.click()
      } else {
        await aiInput.press('Control+Enter')
      }
      // Brief pause between sends so React can re-render
      await page.waitForTimeout(200)
    }

    // After filling body: .ai-input-area must still be visible (not scrolled away)
    const inputArea = page.locator('.ai-input-area')
    await expect(inputArea).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Input area must remain within panel bounds
    const panelBox = await aiPanel.boundingBox()
    const inputBox = await inputArea.boundingBox()
    expect(panelBox).not.toBeNull()
    expect(inputBox).not.toBeNull()
    expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 2)

    // .ai-body must be above input area (layout order: body above, input below)
    const aiBody = page.getByTestId('ai-body')
    const bodyBox = await aiBody.boundingBox()
    expect(bodyBox).not.toBeNull()
    // Body bottom must not exceed input top (body scrolls, input stays fixed at bottom)
    expect(bodyBox!.y + bodyBox!.height).toBeLessThanOrEqual(inputBox!.y + 2)
  } finally {
    await cleanupApp(ctx)
  }
})

test('uiaudit.7: .ai-input-area is a direct child of .ai-panel, not inside .ai-body', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Configure AI with consent so full panel renders
    await page.evaluate(async () => {
      const current = await window.api.invoke('settings:get') as Record<string, unknown>
      await window.api.invoke('settings:save', {
        ...current,
        aiProvider: 'subscription',
        aiPrivacyConsent: true,
      })
    })

    // Open AI panel
    await page.getByTestId('sidebar-ai').click()
    await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Assert structural invariant: .ai-input-area must NOT be nested inside .ai-body
    const inputInsideBody = page.locator('.ai-body .ai-input-area')
    await expect(inputInsideBody).toHaveCount(0)

    // And it must exist as a sibling to .ai-body (child of .ai-panel)
    const inputDirectChild = page.locator('.ai-panel > .ai-input-area')
    await expect(inputDirectChild).toHaveCount(1)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// uiaudit.14 — Sidebar compact mode at narrow viewport height
// =============================================================================

test('uiaudit.14: sidebar gets sidebar-compact class at 1024x640 viewport', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Resize to narrow height (640px < 720px threshold)
    await page.setViewportSize({ width: 1024, height: 640 })
    // Allow resize event to propagate and React to re-render
    await page.waitForTimeout(300)

    // The sidebar aside element must have the sidebar-compact class
    const sidebar = page.locator('aside.mailcopilot-sidebar')
    await expect(sidebar).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(sidebar).toHaveClass(/sidebar-compact/, { timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

test('uiaudit.14: sidebar bottom buttons are all visible in compact mode (not clipped)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Narrow viewport to trigger compact mode
    await page.setViewportSize({ width: 1024, height: 640 })
    await page.waitForTimeout(300)

    // Verify compact class applied
    const sidebar = page.locator('aside.mailcopilot-sidebar')
    await expect(sidebar).toHaveClass(/sidebar-compact/, { timeout: EXPECT_TIMEOUT })

    // All bottom action buttons must be visible (not clipped below viewport)
    const settingsBtn = page.getByTestId('open-settings')
    const aiBtn = page.getByTestId('sidebar-ai')
    const syncBtn = page.getByTestId('sidebar-sync')

    await expect(settingsBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(aiBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(syncBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Verify none of them are clipped below viewport bottom
    const viewportHeight = 640
    for (const [label, btn] of [['settings', settingsBtn], ['ai', aiBtn], ['sync', syncBtn]] as const) {
      const box = await btn.boundingBox()
      expect(box, `${label} button bounding box must exist`).not.toBeNull()
      expect(
        box!.y + box!.height,
        `${label} button must not be clipped below viewport (height=${viewportHeight})`,
      ).toBeLessThanOrEqual(viewportHeight + 1)
    }

    // Sidebar toggle button (collapse) must also be visible
    const toggleBtn = page.locator('.sidebar-toggle-btn')
    await expect(toggleBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const toggleBox = await toggleBtn.boundingBox()
    expect(toggleBox).not.toBeNull()
    expect(toggleBox!.y + toggleBox!.height).toBeLessThanOrEqual(viewportHeight + 1)
  } finally {
    await cleanupApp(ctx)
  }
})

test('uiaudit.14: sidebar compact class is removed when viewport height returns above threshold', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Start at a height that exceeds the threshold — no compact mode
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(300)

    const sidebar = page.locator('aside.mailcopilot-sidebar')
    await expect(sidebar).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // At 800px: sidebar-compact must NOT be present
    const classAtWide = await sidebar.getAttribute('class')
    expect(classAtWide).not.toContain('sidebar-compact')

    // Resize below threshold (700px < 720px)
    await page.setViewportSize({ width: 1280, height: 700 })
    await page.waitForTimeout(300)

    // Now compact class must be added
    await expect(sidebar).toHaveClass(/sidebar-compact/, { timeout: EXPECT_TIMEOUT })

    // Resize back above threshold (800px >= 720px)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(300)

    // Compact class must be removed
    const classAfterExpand = await sidebar.getAttribute('class')
    expect(classAfterExpand).not.toContain('sidebar-compact')
  } finally {
    await cleanupApp(ctx)
  }
})

test('uiaudit.14: sidebar-compact reduces folder-btn height (DOM style check)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // First measure at tall viewport (no compact)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(300)

    const folderBtn = page.locator('.folder-btn').first()
    await expect(folderBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const normalHeight = await folderBtn.evaluate(
      (el: HTMLElement) => el.getBoundingClientRect().height,
    )

    // Resize to compact height
    await page.setViewportSize({ width: 1280, height: 640 })
    await page.waitForTimeout(300)

    await expect(page.locator('aside.mailcopilot-sidebar')).toHaveClass(/sidebar-compact/, { timeout: EXPECT_TIMEOUT })

    const compactHeight = await folderBtn.evaluate(
      (el: HTMLElement) => el.getBoundingClientRect().height,
    )

    // In compact mode folder-btn height should be 28px (per CSS) — less than normal
    expect(compactHeight).toBeLessThan(normalHeight)
    expect(compactHeight).toBeLessThanOrEqual(28 + 1) // 1px tolerance
  } finally {
    await cleanupApp(ctx)
  }
})
