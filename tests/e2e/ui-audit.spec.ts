/**
 * UI Audit — non-merge spec.
 *
 * Drives every form/window/dialog and saves screenshots into
 * `docs/qa/ui-audit/<date>/<screen>.png`. Read-only with respect to user data
 * (no Send / Delete / Move clicks). Captures both desktop (1280x800) and narrow
 * (1024x640) viewports for layout stress.
 *
 * Run: `xvfb-run -a npx playwright test tests/e2e/ui-audit.spec.ts`
 *
 * NOT a merge gate test — used for UI audit reports only.
 * Skipped automatically unless MAILCOPILOT_UI_AUDIT=1 is set, so
 * normal `npm run e2e:bg` is unaffected.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, cleanupApp, type AppContext, waitForPage } from './helpers'
import path from 'node:path'
import fs from 'node:fs/promises'

const RUN_AUDIT = process.env.MAILCOPILOT_UI_AUDIT === '1'

const OUT_DIR = path.join(
  process.cwd(),
  'docs',
  'qa',
  'ui-audit',
  new Date().toISOString().slice(0, 10),
)

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  narrow: { width: 1024, height: 640 },
} as const

async function ensureDir(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true })
}

async function shoot(page: Page, name: string, viewport: keyof typeof VIEWPORTS = 'desktop'): Promise<void> {
  await page.setViewportSize(VIEWPORTS[viewport])
  await page.waitForTimeout(250) // settle layout
  const file = path.join(OUT_DIR, `${name}.${viewport}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`[ui-audit] ${name}.${viewport}.png`)
}

test.describe('UI audit — main window', () => {
  test.skip(!RUN_AUDIT, 'Set MAILCOPILOT_UI_AUDIT=1 to run')

  let ctx: Partial<AppContext> = {}

  test.beforeAll(async () => {
    await ensureDir()
    ctx = await launchApp('mailcopilot-ui-audit-')
  })

  test.afterAll(async () => {
    await cleanupApp(ctx)
  })

  test('inbox default + sidebar variations', async () => {
    const page = ctx.page!

    await shoot(page, '01-inbox-default', 'desktop')
    await shoot(page, '01-inbox-default', 'narrow')

    // Mail viewer open
    const firstMail = page.getByTestId('mail-item').first()
    if (await firstMail.isVisible()) {
      await firstMail.click()
      await page.waitForTimeout(500)
      await shoot(page, '02-inbox-mail-open', 'desktop')
      await shoot(page, '02-inbox-mail-open', 'narrow')
    }

    // Sidebar collapsed (Sergey's tooltip overlap bug repro)
    const sidebarToggle = page.locator('.sidebar-toggle-btn').first()
    if (await sidebarToggle.isVisible()) {
      await sidebarToggle.click()
      await page.waitForTimeout(300)
      await shoot(page, '03-sidebar-collapsed', 'desktop')
      await shoot(page, '03-sidebar-collapsed', 'narrow')

      // Hover over a sidebar nav item with collapsed sidebar — should show tooltip
      // Sergey's bug: tooltip appears BEHIND the mail-list block.
      const navItem = page.locator('.sidebar-nav button, .sidebar-account-row').first()
      if (await navItem.isVisible()) {
        await navItem.hover()
        await page.waitForTimeout(800) // wait for tooltip CSS animation
        await shoot(page, '04-sidebar-collapsed-tooltip-hover', 'desktop')
      }

      // Restore expanded sidebar
      await sidebarToggle.click()
      await page.waitForTimeout(300)
    }
  })

  test('AI panel — egress blocked state', async () => {
    const page = ctx.page!

    // Try to open AI panel — toolbar button or sidebar entry
    const aiBtn = page.locator('[data-testid="ai-toggle"], .sidebar-ai-btn, [title*="AI"]').first()
    if (await aiBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await aiBtn.click()
      await page.waitForTimeout(500)
      await shoot(page, '05-ai-panel-default', 'desktop')

      // Try common quick-action buttons in AI bar to trigger egress-blocked overlay
      const quickAction = page.locator('button:has-text("Суммируй"), button:has-text("Summarize")').first()
      if (await quickAction.isVisible({ timeout: 1000 }).catch(() => false)) {
        await quickAction.click()
        await page.waitForTimeout(1500)
        await shoot(page, '06-ai-panel-egress-blocked', 'desktop')
      }
    }
  })

  test('search active', async () => {
    const page = ctx.page!
    const searchInput = page.locator('[data-testid="search-input"], input[type="search"]').first()
    if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await searchInput.click()
      await searchInput.fill('test')
      await page.waitForTimeout(500)
      await shoot(page, '07-search-active', 'desktop')
      await searchInput.fill('')
      await page.keyboard.press('Escape')
    }
  })

  test('folder context menu', async () => {
    const page = ctx.page!
    const folder = page.locator('[data-testid^="folder-"]').first()
    if (await folder.isVisible({ timeout: 2000 }).catch(() => false)) {
      await folder.click({ button: 'right' })
      await page.waitForTimeout(400)
      await shoot(page, '08-folder-context-menu', 'desktop')
      await page.keyboard.press('Escape')
    }
  })

  test('mail context menu', async () => {
    const page = ctx.page!
    const mail = page.getByTestId('mail-item').first()
    if (await mail.isVisible({ timeout: 2000 }).catch(() => false)) {
      await mail.click({ button: 'right' })
      await page.waitForTimeout(400)
      await shoot(page, '09-mail-context-menu', 'desktop')
      await page.keyboard.press('Escape')
    }
  })

  test('keyboard shortcuts modal', async () => {
    const page = ctx.page!
    await page.keyboard.press('?')
    await page.waitForTimeout(400)
    // Take screenshot regardless of whether modal opened (capture state)
    await shoot(page, '10-shortcuts-modal', 'desktop')
    await page.keyboard.press('Escape')
  })
})

test.describe('UI audit — Settings window', () => {
  test.skip(!RUN_AUDIT, 'Set MAILCOPILOT_UI_AUDIT=1 to run')

  let ctx: Partial<AppContext> = {}
  let settings: Page

  test.beforeAll(async () => {
    await ensureDir()
    ctx = await launchApp('mailcopilot-ui-audit-settings-')
    const page = ctx.page!
    const browser = ctx.browser!
    await page.getByTestId('open-settings').click()
    settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })
  })

  test.afterAll(async () => {
    if (settings && !settings.isClosed()) await settings.evaluate(() => window.close()).catch(() => {})
    await cleanupApp(ctx)
  })

  const TABS = [
    'general',
    'accounts',
    'productivity',
    'folders',
    'identities',
    'signature',
    'templates',
    'rules',
    'ai',
    'about',
  ] as const

  for (const tab of TABS) {
    test(`settings tab — ${tab}`, async () => {
      const tabBtn = settings.getByTestId(`settings-tab-${tab}`)
      if (await tabBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await tabBtn.click()
        await settings.waitForTimeout(400)
        await shoot(settings, `20-settings-${tab}`, 'desktop')
        await shoot(settings, `20-settings-${tab}`, 'narrow')
      }
    })
  }

  test('settings ai — Privacy & Audit subsection expanded', async () => {
    await settings.getByTestId('settings-tab-ai').click()
    await settings.waitForTimeout(300)
    // Find Privacy & Audit collapsible heading
    const auditHeading = settings.locator('h3:has-text("Privacy"), h3:has-text("Приватность"), [data-testid*="audit"]').first()
    if (await auditHeading.isVisible({ timeout: 2000 }).catch(() => false)) {
      await auditHeading.click()
      await settings.waitForTimeout(500)
      await shoot(settings, '21-settings-ai-privacy-audit-expanded', 'desktop')
    }
  })
})

test.describe('UI audit — Compose window', () => {
  test.skip(!RUN_AUDIT, 'Set MAILCOPILOT_UI_AUDIT=1 to run')

  let ctx: Partial<AppContext> = {}

  test.beforeAll(async () => {
    await ensureDir()
    ctx = await launchApp('mailcopilot-ui-audit-compose-')
  })

  test.afterAll(async () => {
    await cleanupApp(ctx)
  })

  test('compose fresh', async () => {
    const page = ctx.page!
    const browser = ctx.browser!
    await page.getByTestId('sidebar-compose').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    await expect(compose.getByTestId('compose-to')).toBeVisible({ timeout: 30_000 })
    await shoot(compose, '30-compose-fresh', 'desktop')
    await shoot(compose, '30-compose-fresh', 'narrow')

    // Filled state
    await compose.getByTestId('compose-to').fill('test@example.com')
    await compose.getByTestId('compose-subject').fill('UI audit test subject')
    await compose.getByTestId('compose-text').fill('Body line 1\nBody line 2\nBody line 3')
    await compose.waitForTimeout(300)
    await shoot(compose, '31-compose-filled', 'desktop')

    await compose.evaluate(() => window.close()).catch(() => {})
  })
})

test.describe('UI audit — Account wizard', () => {
  test.skip(!RUN_AUDIT, 'Set MAILCOPILOT_UI_AUDIT=1 to run')

  let ctx: Partial<AppContext> = {}

  test.beforeAll(async () => {
    await ensureDir()
    ctx = await launchApp('mailcopilot-ui-audit-account-')
  })

  test.afterAll(async () => {
    await cleanupApp(ctx)
  })

  test('account wizard steps', async () => {
    const page = ctx.page!
    const browser = ctx.browser!

    // Open settings → accounts tab → "Add account"
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-accounts').click()
    await settings.waitForTimeout(300)

    const addBtn = settings.locator('[data-testid="add-account"], button:has-text("Добав"), button:has-text("Add")').first()
    if (await addBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addBtn.click()
      const account = await waitForPage(browser, p => p.url().includes('#/account'))
      await account.waitForLoadState('domcontentloaded')
      await account.waitForTimeout(500)

      // Step 1: provider picker
      await shoot(account, '40-account-step1-provider', 'desktop')

      // Try to advance to step 2 by selecting Generic IMAP
      const genericBtn = account.locator('button:has-text("Generic"), [data-testid="provider-generic-imap"]').first()
      if (await genericBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await genericBtn.click()
        await account.waitForTimeout(500)
        await shoot(account, '41-account-step2-credentials', 'desktop')
      }

      await account.evaluate(() => window.close()).catch(() => {})
    }

    if (!settings.isClosed()) await settings.evaluate(() => window.close()).catch(() => {})
  })
})
