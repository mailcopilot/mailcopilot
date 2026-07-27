/**
 * Semi-automated demo video for Google OAuth verification.
 *
 * Records the OAuth consent screen workflow required by Google:
 *   1. Fresh app launch (no accounts configured)
 *   2. Clicking "Google Sign In" -> browser opens Google consent screen
 *   3. [MANUAL] User completes Google OAuth in the browser
 *   4. App connects, syncs and shows inbox
 *   5. Demonstrating scope usage: reading and sending emails
 *
 * Unlike the fully-automated demo-video.spec.ts, this script requires
 * a REAL display (not Xvfb) because the user must manually interact
 * with the Google consent screen in a system browser.
 *
 * Requested scopes:
 *   - https://mail.google.com/  — IMAP/SMTP access (read + send)
 *   - openid                    — authentication
 *   - email                     — user email address
 *   - profile                   — user display name
 *
 * Run:
 *   npm run demo:oauth
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// --- Video configuration ---
const VIDEO_FPS = 30
const VIDEO_OUTPUT = path.join(process.cwd(), 'demo-oauth.mp4')

/** Detect actual screen resolution via xrandr or xdpyinfo. */
function getScreenResolution(): { width: number; height: number } {
  try {
    const xrandr = execSync('xrandr 2>/dev/null', { encoding: 'utf-8' })
    const m = xrandr.match(/(\d+)x(\d+)\+0\+0/)
    if (m) return { width: Number(m[1]), height: Number(m[2]) }
  } catch { /* fallback */ }
  try {
    const xdpy = execSync('xdpyinfo 2>/dev/null', { encoding: 'utf-8' })
    const m = xdpy.match(/dimensions:\s+(\d+)x(\d+)/)
    if (m) return { width: Number(m[1]), height: Number(m[2]) }
  } catch { /* fallback */ }
  return { width: 1920, height: 1080 }
}

// Pause between actions so the viewer can follow along.
const STEP_PAUSE = 2500
const SHORT_PAUSE = 1500

// --- Utilities ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
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

async function waitForPortOpen(port: number, timeoutMs = 15_000): Promise<void> {
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

async function waitForDevToolsWsUrl(port: number, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) {
        const json = (await res.json()) as { webSocketDebuggerUrl?: unknown }
        if (typeof json.webSocketDebuggerUrl === 'string' && json.webSocketDebuggerUrl.startsWith('ws://')) {
          return json.webSocketDebuggerUrl
        }
      }
    } catch { /* retry */ }
    await sleep(200)
  }
  throw new Error(`DevTools endpoint on port ${port} not ready within ${timeoutMs}ms`)
}

/**
 * Waits for a page (BrowserWindow) matching a predicate to appear.
 */
async function waitForPage(
  browser: Browser,
  predicate: (page: Page) => boolean,
  timeoutMs = 30_000,
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
  throw new Error('Failed to find a page matching the predicate')
}

// --- ffmpeg screen recording ---

function startFfmpeg(display: string, outputPath: string, width: number, height: number): ChildProcessWithoutNullStreams {
  const proc = spawn('ffmpeg', [
    '-y',
    '-f', 'x11grab',
    '-video_size', `${width}x${height}`,
    '-framerate', String(VIDEO_FPS),
    '-i', `${display}.0`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ], { stdio: 'pipe' })
  proc.stderr.on('data', (d: Buffer) => {
    const s = d.toString().trimEnd()
    if (s.includes('Error') || s.includes('frame=')) console.log('[ffmpeg]', s)
  })
  return proc
}

async function stopFfmpeg(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise(resolve => {
    proc.on('exit', () => resolve())
    proc.stdin.write('q')
    setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGINT') }, 5000)
  })
}

async function terminateProcess(proc: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const waitExit = () => new Promise<boolean>(resolve => { proc.once('exit', () => resolve(true)) })
  proc.kill('SIGTERM')
  const exited = await Promise.race([waitExit(), sleep(timeoutMs).then(() => false)])
  if (exited) return
  proc.kill('SIGKILL')
  await Promise.race([waitExit(), sleep(timeoutMs)])
}

// --- Demo scenario ---

test('demo: OAuth consent screen workflow for Google verification', async () => {
  // This demo requires manual interaction — allow up to 10 minutes.
  test.setTimeout(600_000)

  // Require a real X11 display (user must see and interact with the Google consent screen).
  const display = process.env.DISPLAY
  if (!display) {
    throw new Error(
      'This demo requires a real X11 display (DISPLAY env var).\n'
      + 'Run it in a graphical session, not in a headless environment.',
    )
  }

  // Detect screen resolution and start recording.
  const { width: screenW, height: screenH } = getScreenResolution()
  console.log(`\nScreen resolution: ${screenW}x${screenH}\n`)
  const ffmpeg = startFfmpeg(display, VIDEO_OUTPUT, screenW, screenH)
  await sleep(1000)
  console.log(`\nRecording started on display ${display}\n`)

  // Launch Electron fresh — NO e2e mode (real OAuth, real IMAP).
  // Default settings: language=en, theme=light (see getSettings() defaults).
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailcopilot-oauth-demo-'))
  const require_ = createRequire(import.meta.url)
  const electronBinary = require_('electron') as string
  const cdpPort = await getFreePort()

  const env = {
    ...process.env,
    MAILCOPILOT_DATA_DIR: dataDir,
    MAILCOPILOT_CDP_PORT: String(cdpPort),
  }
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE

  const electronProc = spawn(electronBinary, ['.', '--no-sandbox', '--disable-gpu'], {
    env,
    stdio: 'pipe',
  })
  electronProc.stdout.on('data', (d: Buffer) => console.log('[electron]', d.toString().trimEnd()))
  electronProc.stderr.on('data', (d: Buffer) => {
    const s = d.toString().trimEnd()
    // Filter noisy Electron/Chromium warnings.
    if (!s.includes('DevTools') && !s.includes('MESA')) console.error('[electron]', s)
  })

  let browser: Browser | undefined
  try {
    // Connect Playwright via CDP.
    await waitForPortOpen(cdpPort)
    const wsUrl = await waitForDevToolsWsUrl(cdpPort)
    browser = await chromium.connectOverCDP(wsUrl)

    const mainPage = browser.contexts()[0].pages()[0]
      ?? await browser.contexts()[0].waitForEvent('page')
    await mainPage.waitForLoadState('domcontentloaded')
    await sleep(SHORT_PAUSE)

    // =========================================================
    // Step 1: Fresh app — Account window opens automatically
    // (No accounts configured -> ui:openAccount is called)
    // =========================================================
    console.log('\n--- Step 1: Waiting for Account window (no accounts configured) ---\n')

    const accountPage = await waitForPage(browser, p => p.url().includes('#/account'), 30_000)
    await accountPage.waitForLoadState('domcontentloaded')
    await sleep(STEP_PAUSE)

    // =========================================================
    // Step 2: Click "Google Sign In"
    // =========================================================
    console.log('\n--- Step 2: Clicking "Google Sign In" ---\n')

    // The Google Sign In button is the first button in account-wizard-type section.
    const wizardSection = accountPage.locator('[data-testid="account-wizard-type"]')
    await expect(wizardSection).toBeVisible({ timeout: 10_000 })
    await sleep(SHORT_PAUSE)

    // Click the Google button (first button; the second is IMAP/SMTP).
    const googleBtn = wizardSection.locator('button').first()
    await expect(googleBtn).toBeVisible()
    await googleBtn.click()

    // =========================================================
    // Step 3: MANUAL — User completes Google OAuth in the browser
    // =========================================================
    console.log('\n' + '='.repeat(64))
    console.log('  MANUAL STEP: Complete the Google OAuth flow')
    console.log('')
    console.log('  A browser window should have opened with Google sign-in.')
    console.log('  Please:')
    console.log('    1. Sign in to your Google account')
    console.log('    2. Review the OAuth consent screen (shows requested scopes)')
    console.log('    3. Make sure the consent screen language is ENGLISH')
    console.log('       (toggle at the bottom-left corner if needed)')
    console.log('    4. Click "Allow" / "Continue" to grant access')
    console.log('    5. Wait for the "Success" page to appear in the browser')
    console.log('')
    console.log('  The video is recording the entire screen, so both the')
    console.log('  application and the browser consent screen are captured.')
    console.log('')
    console.log('  Waiting up to 3 minutes for OAuth to complete...')
    console.log('='.repeat(64) + '\n')

    // =========================================================
    // Step 4: Auto-detect OAuth completion
    // (Account window shows .status-ok when OAuth succeeds)
    // =========================================================
    console.log('\n--- Step 4: Waiting for account connection ---\n')

    await expect(accountPage.locator('.status-ok')).toBeVisible({ timeout: 180_000 })
    await sleep(STEP_PAUSE)

    // Close the Account window — focus returns to the main window.
    const closeBtn = accountPage.locator('.titlebar-btn-close')
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click()
      await sleep(SHORT_PAUSE)
    }

    // =========================================================
    // Step 5: Wait for inbox to sync (real Gmail emails)
    // =========================================================
    console.log('\n--- Step 5: Waiting for inbox to sync ---\n')

    // The main window's initial load returned early (no accounts at startup),
    // so we must reload it to trigger full initialization with the new account.
    await mainPage.bringToFront()
    await mainPage.reload({ waitUntil: 'domcontentloaded' })
    await expect(mainPage.getByTestId('mail-item').first()).toBeVisible({ timeout: 120_000 })
    await sleep(STEP_PAUSE)

    // =========================================================
    // Step 6: Demonstrate READING emails
    //         (uses https://mail.google.com/ scope via IMAP)
    // =========================================================
    console.log('\n--- Step 6: Reading emails (IMAP — mail.google.com scope) ---\n')

    // Click the first email to open it.
    const firstMail = mainPage.getByTestId('mail-item').first()
    await firstMail.click()
    await expect(mainPage.getByTestId('mail-subject')).toBeVisible({ timeout: 15_000 })
    await sleep(STEP_PAUSE)

    // Open a second email if available.
    const secondMail = mainPage.getByTestId('mail-item').nth(1)
    if (await secondMail.isVisible().catch(() => false)) {
      await secondMail.click()
      await expect(mainPage.getByTestId('mail-subject')).toBeVisible()
      await sleep(STEP_PAUSE)
    }

    // =========================================================
    // Step 7: Demonstrate COMPOSING and SENDING
    //         (uses https://mail.google.com/ scope via SMTP)
    // =========================================================
    console.log('\n--- Step 7: Composing and sending email (SMTP — mail.google.com scope) ---\n')

    await mainPage.locator('.sidebar-compose-btn').click()
    const composePage = await waitForPage(browser, p => p.url().includes('#/compose'), 15_000)
    await composePage.waitForLoadState('domcontentloaded')
    await sleep(SHORT_PAUSE)

    // Get the user's own email for a self-send demo.
    const userEmail = await mainPage.evaluate(async () => {
      const w = window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }
      const accounts = await w.api.invoke('accounts:list') as Array<{
        imap: { user: string }; email?: string
      }>
      return accounts[0]?.email || accounts[0]?.imap?.user || ''
    })

    if (userEmail) {
      await composePage.getByTestId('compose-to').fill(userEmail)
      await sleep(500)
    }
    await composePage.getByTestId('compose-subject').fill('MailCopilot — OAuth Demo Test Email')
    await sleep(500)
    await composePage.getByTestId('compose-text').fill(
      'Hello!\n\n'
      + 'This email demonstrates that MailCopilot can send emails\n'
      + 'using the authorized Google OAuth scope (https://mail.google.com/).\n\n'
      + 'Best regards,\nMailCopilot',
    )
    await sleep(STEP_PAUSE)

    // Send the email (SMTP may be unavailable on some networks — handle gracefully).
    await composePage.getByTestId('compose-send').click()
    const composeClosed = await expect.poll(() => composePage.isClosed(), { timeout: 30_000 })
      .toBe(true).then(() => true).catch(() => false)

    if (composeClosed) {
      console.log('  Email sent successfully via SMTP.\n')
      await mainPage.bringToFront()
      await sleep(STEP_PAUSE)

      // =========================================================
      // Step 8: Show Sent folder (proves SMTP send worked)
      // =========================================================
      console.log('\n--- Step 8: Checking Sent folder ---\n')

      const sentFolder = mainPage.getByTestId('folder-Sent')
        .or(mainPage.getByTestId('folder-[Gmail]/Sent Mail'))
        .or(mainPage.locator('[data-testid^="folder-"]', { hasText: /sent/i }))
      if (await sentFolder.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
        await sentFolder.first().click()
        await sleep(STEP_PAUSE)
      }
    } else {
      // SMTP failed — close compose window, demonstrate that compose UI works.
      console.log('  SMTP unavailable — closing compose (UI capability demonstrated).\n')
      await sleep(STEP_PAUSE)
      const composeClose = composePage.locator('.titlebar-btn-close')
      if (await composeClose.isVisible().catch(() => false)) {
        await composeClose.click()
        await sleep(SHORT_PAUSE)
      }
      await mainPage.bringToFront()
      await sleep(SHORT_PAUSE)
    }

    // =========================================================
    // Step 9: Return to Inbox — final frame
    // =========================================================
    console.log('\n--- Step 9: Final frame — Inbox ---\n')

    await mainPage.getByTestId('folder-INBOX').click()
    await expect(mainPage.getByTestId('mail-item').first()).toBeVisible()
    await sleep(STEP_PAUSE)

    console.log('\nDemo recording complete!\n')

  } finally {
    // Cleanup.
    await browser?.close().catch(() => {})
    await terminateProcess(electronProc)
    await stopFfmpeg(ffmpeg)
    await sleep(1000)
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }

  // Verify video was created.
  const stat = await fs.stat(VIDEO_OUTPUT)
  expect(stat.size).toBeGreaterThan(10_000)
  console.log(`\nOAuth demo video: ${VIDEO_OUTPUT} (${(stat.size / 1024 / 1024).toFixed(1)} MB)\n`)
})
