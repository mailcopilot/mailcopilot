/**
 * Shared utilities for MailCopilot e2e tests.
 * Extracted into a single module to unify timeouts and eliminate duplication.
 */
import { expect, chromium, type Browser, type Page } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// In CI (Docker) Electron starts slower — increase timeouts.
// Local values are NOT much tighter than CI on purpose: the full `e2e:bg` suite
// launches ~6 Electron instances in parallel under a single software-rendered
// Xvfb, so a cold CDP-port open under launch contention routinely exceeds a 15s
// budget ("CDP port did not open within 15000ms"). The old 15s was tuned for an
// interactive single-spec run, not the contended full suite — do not lower these
// back or the launch-contention flake returns (see playwright.config.ts retries).
export const IS_CI = Boolean(process.env.CI)
const LAUNCH_TIMEOUT = IS_CI ? 60_000 : 40_000
const PAGE_WAIT_TIMEOUT = IS_CI ? 45_000 : 40_000
/** Timeout for expect.poll(() => page.isClosed()) — window closing is slower in Docker. */
export const CLOSE_TIMEOUT = IS_CI ? 45_000 : 10_000
/** CI-aware timeout for expect/expect.poll — matches playwright.config.ts expect.timeout. */
export const EXPECT_TIMEOUT = IS_CI ? 30_000 : 10_000

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function hasDisplayServer(): boolean {
  if (process.platform !== 'linux') return true
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') return reject(new Error('Failed to get a free port'))
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

export async function waitForPortOpen(port: number, timeoutMs = LAUNCH_TIMEOUT): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const sock = net.createConnection({ host: '127.0.0.1', port })
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => resolve(false))
    })
    if (ok) return
    await sleep(200)
  }
  throw new Error(`CDP port ${port} did not open within ${timeoutMs}ms`)
}

export async function waitForDevToolsWsUrl(port: number, timeoutMs = LAUNCH_TIMEOUT): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (!res.ok) { await sleep(200); continue }
      const json = (await res.json()) as { webSocketDebuggerUrl?: unknown }
      if (typeof json.webSocketDebuggerUrl === 'string' && json.webSocketDebuggerUrl.startsWith('ws://')) {
        return json.webSocketDebuggerUrl
      }
    } catch { /* retry */ }
    await sleep(200)
  }
  throw new Error(`DevTools endpoint on port ${port} not ready within ${timeoutMs}ms`)
}

export async function terminateProcess(proc: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const waitExit = () => new Promise<boolean>(resolve => { proc.once('exit', () => resolve(true)) })
  proc.kill('SIGTERM')
  const exited = await Promise.race([waitExit(), sleep(timeoutMs).then(() => false)])
  if (exited) return
  proc.kill('SIGKILL')
  await Promise.race([waitExit(), sleep(timeoutMs)])
}

/**
 * Waits for a page (BrowserWindow) matching a predicate to appear.
 * Polls every 250ms with a CI-aware default timeout.
 */
export async function waitForPage(
  browser: Browser,
  predicate: (page: Page) => boolean,
  timeoutMs = PAGE_WAIT_TIMEOUT,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (!p.isClosed() && predicate(p)) return p
      }
    }
    await sleep(250)
  }
  throw new Error(`Failed to find a page matching the predicate within ${timeoutMs}ms`)
}

export type AppContext = {
  proc: ChildProcessWithoutNullStreams
  browser: Browser
  page: Page
  dataDir: string
}

/**
 * Launches the Electron application in e2e mode and connects via CDP.
 *
 * Optional `extraEnv` is merged on top of the inherited `process.env` before
 * forced e2e keys (MAILCOPILOT_E2E, MAILCOPILOT_DATA_DIR, CDP port). Tests
 * that need to exercise env-gated main-process behavior (e.g. stdio MCP
 * gate via MAILCOPILOT_ENABLE_STDIO_MCP=1) pass it here rather than
 * relying on whatever env the developer happens to have in their shell,
 * which does not reproduce in CI.
 */
export async function launchApp(
  tmpPrefix = 'mailcopilot-e2e-',
  extraEnv?: Record<string, string>,
): Promise<AppContext> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), tmpPrefix))
  const { proc, browser, page } = await spawnAndConnect(dataDir, extraEnv, 'launchApp')
  await waitForMailList(page)
  return { proc, browser, page, dataDir }
}

/**
 * Spawn Electron against `dataDir` and attach over CDP, stopping at
 * `domcontentloaded`.
 *
 * Shared by every launcher in this file. It deliberately does NOT wait for the
 * mail list: `launchApp` / `launchAppReuse` add that wait, while the telemetry
 * consent specs (§2.82) must observe a window where `<App/>` is not mounted at
 * all, so waiting for `inbox-list` there would time out by design.
 */
async function spawnAndConnect(
  dataDir: string,
  extraEnv: Record<string, string> | undefined,
  label: string,
): Promise<{ proc: ChildProcessWithoutNullStreams; browser: Browser; page: Page }> {
  const require = createRequire(import.meta.url)
  const electronBinary = require('electron') as string
  const cdpPort = await getFreePort()

  const env = {
    ...process.env,
    ...(extraEnv ?? {}),
    MAILCOPILOT_E2E: '1',
    MAILCOPILOT_DATA_DIR: dataDir,
    MAILCOPILOT_E2E_CDP_PORT: String(cdpPort),
  }
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE

  // --no-sandbox is required in CI (Docker runs as root).
  // --disable-gpu — software rendering, stabilizes operation in Docker without GPU.
  // --disable-dev-shm-usage — Docker containers have limited /dev/shm (64 MB default),
  //   Chromium uses it for shared memory; insufficient space causes renderer crashes
  //   ("Target crashed" errors). This flag tells Chromium to use /tmp instead.
  const electronArgs = ['.', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  const proc = hasDisplayServer()
    ? spawn(electronBinary, electronArgs, { env, stdio: 'pipe' })
    : spawn('xvfb-run', ['-a', electronBinary, ...electronArgs], { env, stdio: 'pipe' })

  proc.stdout.on('data', (d: Buffer) => console.log('[electron:stdout]', d.toString().trimEnd()))
  proc.stderr.on('data', (d: Buffer) => {
    const line = d.toString().trimEnd()
    // Suppress noisy Chromium/system messages in headless mode
    if (/libva error|dbus.*object_proxy|GetAddrInfoReqWrap|DISPLAY.*not.*set/i.test(line)) return
    console.error('[electron:stderr]', line)
  })
  proc.on('exit', (code, signal) => console.log(`[electron:exit] code=${code} signal=${signal}`))

  await waitForPortOpen(cdpPort)
  const wsUrl = await waitForDevToolsWsUrl(cdpPort)
  // Retry CDP connection — socket hang up is transient in Docker under load
  let browser: Browser | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      browser = await chromium.connectOverCDP(wsUrl)
      break
    } catch (err) {
      if (attempt >= 2) throw err
      console.log(`[${label}] CDP connect attempt ${attempt + 1} failed, retrying in 2s...`)
      await sleep(2000)
    }
  }
  if (!browser) throw new Error('Failed to connect via CDP')
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? await context.waitForEvent('page')
  await page.waitForLoadState('domcontentloaded')

  return { proc, browser, page }
}

/** Wait for the mail list to appear (increased timeout for CI under load). */
async function waitForMailList(page: Page): Promise<void> {
  await expect(page.getByTestId('inbox-list')).toBeVisible({ timeout: IS_CI ? 45_000 : 30_000 })
  await expect(page.getByTestId('mail-item').first()).toBeVisible({ timeout: LAUNCH_TIMEOUT })
}

/**
 * Launch with the §2.82 telemetry consent gate ARMED.
 *
 * The gate is bypassed for the whole e2e suite (`MAILCOPILOT_E2E=1` +
 * unpackaged build, see electron/services/telemetryConsentService.ts); setting
 * `MAILCOPILOT_E2E_CONSENT=1` opts a single spec back into the real screen so
 * the consent flow itself can be tested. Returns as soon as the page loads —
 * the caller decides whether it expects the consent screen or the mail list.
 *
 * `dataDir`: pass an existing directory to exercise the restart path (AC7); the
 * returned context then omits `dataDir` so `cleanupApp` leaves it in place and
 * the caller owns its lifecycle.
 */
export async function launchAppWithConsentGate(
  options: { dataDir?: string; tmpPrefix?: string } = {},
): Promise<AppContext> {
  const reuse = Boolean(options.dataDir)
  const dataDir = options.dataDir
    ?? await fs.mkdtemp(path.join(os.tmpdir(), options.tmpPrefix ?? 'mailcopilot-e2e-consent-'))
  const { proc, browser, page } = await spawnAndConnect(
    dataDir,
    { MAILCOPILOT_E2E_CONSENT: '1' },
    'launchAppWithConsentGate',
  )
  return { proc, browser, page, dataDir: (reuse ? undefined : dataDir) as unknown as string }
}

/**
 * Re-launches the app with an existing data directory (no mkdtemp).
 * Use this for restart-persistence tests where you need the same dataDir
 * across two app instances. The caller is responsible for the directory's
 * lifecycle — `cleanupApp` will NOT delete it (dataDir is set to undefined
 * on the returned context so the caller can manage deletion explicitly).
 */
export async function launchAppReuse(
  dataDir: string,
  extraEnv?: Record<string, string>,
): Promise<AppContext> {
  const { proc, browser, page } = await spawnAndConnect(dataDir, extraEnv, 'launchAppReuse')
  await waitForMailList(page)
  // Return context without dataDir so cleanupApp skips directory removal.
  // The caller manages the shared dataDir lifecycle.
  return { proc, browser, page, dataDir: undefined as unknown as string }
}

/**
 * Clicks a mail item. The hover quick-action chip overlay was removed in
 * uiaudit.2, so a plain click is now safe everywhere.
 */
export async function clickMailItem(item: import('@playwright/test').Locator): Promise<void> {
  await item.click()
}

export async function cleanupApp(ctx: Partial<AppContext>): Promise<void> {
  await ctx.browser?.close().catch(() => {})
  if (ctx.proc) await terminateProcess(ctx.proc)
  if (ctx.dataDir) await fs.rm(ctx.dataDir, { recursive: true, force: true })
}

/**
 * Selects an option in a custom mc-select combobox by value.
 *
 * The mc-select component (uiaudit.11) renders a <button role="combobox"> trigger
 * instead of a native <select>. Playwright's .selectOption() only works on
 * native <select> elements. This helper clicks the trigger to open the listbox,
 * then clicks the <li data-value="..."> option matching the given value string.
 *
 * Usage (replaces .selectOption(value)):
 *   await selectMcOption(page.getByTestId('settings-theme'), 'dark')
 */
export async function selectMcOption(
  trigger: import('@playwright/test').Locator,
  value: string,
): Promise<void> {
  await trigger.click()
  // The listbox is rendered into a React Portal on document.body (position:fixed).
  // Use page-relative locator so we find the portal element regardless of DOM ancestry.
  const page = trigger.page()
  const option = page.locator(`[role="option"][data-value="${value}"]`)
  await option.click()
  // Wait for the listbox to disappear before returning — the mc-select component
  // closes on onMouseDown (commit path), but callers that immediately click other
  // elements (e.g. Settings save button) need the listbox fully gone to avoid
  // outside-click races that keep the listbox open and block subsequent interactions.
  await expect(page.locator('[role="listbox"]')).toHaveCount(0, { timeout: 5_000 })
}

/**
 * Returns the currently selected value string from a mc-select trigger.
 * The trigger carries a data-selected-value attribute that mirrors the value prop.
 *
 * Usage (replaces .inputValue() or .evaluate() on a native <select>):
 *   const val = await getMcSelectValue(page.getByTestId('settings-theme'))
 *   expect(val).toBe('dark')
 */
export async function getMcSelectValue(
  trigger: import('@playwright/test').Locator,
): Promise<string> {
  return (await trigger.getAttribute('data-selected-value')) ?? ''
}
