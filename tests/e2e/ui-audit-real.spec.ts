/**
 * UI Audit — REAL ACCOUNT variant.
 *
 * Companion to `ui-audit.spec.ts` (mock fixture). Differences:
 *  - Uses the user's real profile dir from `MAILCOPILOT_DATA_DIR_REAL` env.
 *  - Does NOT set `MAILCOPILOT_E2E=1` — no mock data, no e2e fixtures, real
 *    accounts and real folders.
 *  - Does NOT delete the data dir at teardown.
 *  - Uses `MAILCOPILOT_CDP_PORT` (the demo/debug CDP gate), not the
 *    `MAILCOPILOT_E2E_CDP_PORT` E2E-only gate.
 *  - Selectors are looser (real folder names instead of mock fixtures).
 *
 * Run: `MAILCOPILOT_UI_AUDIT_REAL=1 MAILCOPILOT_DATA_DIR_REAL=/home/<user>/.config/mailcopilot \
 *       npm run e2e:bg -- tests/e2e/ui-audit-real.spec.ts`
 *
 * Skipped automatically unless MAILCOPILOT_UI_AUDIT_REAL=1.
 *
 * IMPORTANT: requires the user's MailCopilot to NOT be running (SQLite WAL lock).
 * Caller is responsible for stopping it before and restarting after.
 */
import { test, expect, chromium, type Page, type Browser } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  getFreePort,
  hasDisplayServer,
  terminateProcess,
  waitForDevToolsWsUrl,
  waitForPage,
  waitForPortOpen,
} from './helpers'

const RUN_AUDIT = process.env.MAILCOPILOT_UI_AUDIT_REAL === '1'
const REAL_DATA_DIR = process.env.MAILCOPILOT_DATA_DIR_REAL ?? ''

const OUT_DIR = path.join(
  process.cwd(),
  'docs',
  'qa',
  'ui-audit',
  `${new Date().toISOString().slice(0, 10)}-real`,
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
  await page.waitForTimeout(300)
  const file = path.join(OUT_DIR, `${name}.${viewport}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`[ui-audit-real] ${name}.${viewport}.png`)
}

type RealCtx = {
  proc: ChildProcessWithoutNullStreams
  browser: Browser
  page: Page
}

async function launchReal(): Promise<RealCtx> {
  if (!REAL_DATA_DIR) throw new Error('MAILCOPILOT_DATA_DIR_REAL not set')
  const stat = await fs.stat(REAL_DATA_DIR).catch(() => null)
  if (!stat?.isDirectory()) throw new Error(`Real data dir not found: ${REAL_DATA_DIR}`)

  const require = createRequire(import.meta.url)
  const electronBinary = require('electron') as string
  const cdpPort = await getFreePort()

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MAILCOPILOT_DATA_DIR: REAL_DATA_DIR,
    MAILCOPILOT_CDP_PORT: String(cdpPort),
  }
  delete env.MAILCOPILOT_E2E
  delete env.MAILCOPILOT_E2E_CDP_PORT
  delete env.ELECTRON_RUN_AS_NODE

  const electronArgs = ['.', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  const proc = hasDisplayServer()
    ? spawn(electronBinary, electronArgs, { env, stdio: 'pipe' })
    : spawn('xvfb-run', ['-a', electronBinary, ...electronArgs], { env, stdio: 'pipe' })

  proc.stdout.on('data', (d: Buffer) => console.log('[real:stdout]', d.toString().trimEnd()))
  proc.stderr.on('data', (d: Buffer) => {
    const line = d.toString().trimEnd()
    if (/libva error|dbus.*object_proxy|GetAddrInfoReqWrap|DISPLAY.*not.*set/i.test(line)) return
    console.error('[real:stderr]', line)
  })
  proc.on('exit', (code, signal) => console.log(`[real:exit] code=${code} signal=${signal}`))

  await waitForPortOpen(cdpPort, 60_000)
  const wsUrl = await waitForDevToolsWsUrl(cdpPort, 60_000)
  const browser = await chromium.connectOverCDP(wsUrl)
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? await context.waitForEvent('page')
  await page.waitForLoadState('domcontentloaded')

  // Real app may take longer to settle (IMAP IDLE warmup, body indexer kick).
  await page.waitForTimeout(2_000)
  return { proc, browser, page }
}

async function cleanupReal(ctx: Partial<RealCtx>): Promise<void> {
  await ctx.browser?.close().catch(() => {})
  if (ctx.proc) await terminateProcess(ctx.proc)
  // NOTE: explicitly do NOT delete REAL_DATA_DIR.
}

test.describe('UI audit — real account', () => {
  test.skip(!RUN_AUDIT, 'Set MAILCOPILOT_UI_AUDIT_REAL=1 + MAILCOPILOT_DATA_DIR_REAL to run')

  let ctx: Partial<RealCtx> = {}

  test.beforeAll(async () => {
    await ensureDir()
    ctx = await launchReal()
  })

  test.afterAll(async () => {
    await cleanupReal(ctx)
  })

  test('inbox baseline', async () => {
    const page = ctx.page!
    // Wait for inbox-list (real account always has it after settle).
    await expect(page.getByTestId('inbox-list')).toBeVisible({ timeout: 30_000 })
    await shoot(page, '01-inbox-default', 'desktop')
    await shoot(page, '01-inbox-default', 'narrow')

    // Mail viewer: open a real mail.
    const firstMail = page.getByTestId('mail-item').first()
    if (await firstMail.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await firstMail.click({ force: true })
      await page.waitForTimeout(800)
      await shoot(page, '02-inbox-mail-open', 'desktop')
      await shoot(page, '02-inbox-mail-open', 'narrow')
    }
  })

  test('sidebar collapsed — tooltip overlap repro', async () => {
    const page = ctx.page!
    await page.setViewportSize(VIEWPORTS.desktop)

    const sidebarToggle = page.locator('.sidebar-toggle-btn').first()
    if (!(await sidebarToggle.isVisible().catch(() => false))) {
      console.log('[ui-audit-real] sidebar toggle not found — skipping tooltip repro')
      return
    }
    await sidebarToggle.click()
    await page.waitForTimeout(500)
    await shoot(page, '03-sidebar-collapsed', 'desktop')
    await shoot(page, '03-sidebar-collapsed', 'narrow')

    // Hover a sidebar nav item and CAPTURE while tooltip is showing.
    // Sergey's specific bug: tooltip behind mail-list block when sidebar collapsed.
    const navTargets = [
      '.sidebar-account-row',
      '.sidebar-nav button',
      '.sidebar-folder-item',
      'aside button[aria-label]',
      'aside a[aria-label]',
    ]

    for (const sel of navTargets) {
      const items = page.locator(sel)
      const count = await items.count()
      for (let i = 0; i < Math.min(count, 5); i++) {
        const el = items.nth(i)
        if (!(await el.isVisible().catch(() => false))) continue
        await el.hover()
        await page.waitForTimeout(900) // wait for any CSS-delayed tooltip
        const safeName = sel.replace(/[^a-z0-9]+/gi, '_').toLowerCase()
        await shoot(page, `04-tooltip-hover-${safeName}-${i}`, 'desktop')
      }
    }

    // Restore expanded sidebar.
    await sidebarToggle.click().catch(() => {})
    await page.waitForTimeout(300)
  })

  test('mail row date column / no-hover regression check', async () => {
    const page = ctx.page!
    await page.setViewportSize(VIEWPORTS.desktop)
    const firstMail = page.getByTestId('mail-item').first()
    if (!(await firstMail.isVisible().catch(() => false))) return
    await firstMail.hover()
    await page.waitForTimeout(400)
    await shoot(page, '05-mailrow-date-col', 'desktop')
    await shoot(page, '05-mailrow-date-col', 'narrow')
  })

  test('AI panel + chat input', async () => {
    const page = ctx.page!
    const aiBtn = page.locator('[data-testid="ai-toggle"], [title*="AI" i], aside :text("AI Assistant"), aside :text("AI ассистент")').first()
    if (!(await aiBtn.isVisible({ timeout: 2_000 }).catch(() => false))) {
      console.log('[ui-audit-real] AI button not found — skipping')
      return
    }
    await aiBtn.click({ force: true })
    await page.waitForTimeout(700)
    await shoot(page, '06-ai-panel', 'desktop')
  })

  test('search active — real query', async () => {
    const page = ctx.page!
    const searchInput = page.locator('[data-testid="search-input"], input[type="search"]').first()
    if (!(await searchInput.isVisible({ timeout: 2_000 }).catch(() => false))) return
    await searchInput.click()
    await searchInput.fill('a') // single char — real index will produce results
    await page.waitForTimeout(800)
    await shoot(page, '07-search-active', 'desktop')
    await searchInput.fill('')
    await page.keyboard.press('Escape')
  })

  test('settings tabs — real data', async () => {
    const page = ctx.page!
    const browser = ctx.browser!
    const openBtn = page.getByTestId('open-settings')
    if (!(await openBtn.isVisible({ timeout: 2_000 }).catch(() => false))) return
    await openBtn.click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 30_000 })

    const TABS = ['general', 'accounts', 'productivity', 'folders', 'identities', 'signature', 'templates', 'rules', 'ai', 'about'] as const
    for (const tab of TABS) {
      const tabBtn = settings.getByTestId(`settings-tab-${tab}`)
      if (await tabBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await tabBtn.click()
        await settings.waitForTimeout(500)
        await shoot(settings, `20-settings-${tab}`, 'desktop')
        await shoot(settings, `20-settings-${tab}`, 'narrow')
      }
    }
    if (!settings.isClosed()) await settings.evaluate(() => window.close()).catch(() => {})
  })
})
