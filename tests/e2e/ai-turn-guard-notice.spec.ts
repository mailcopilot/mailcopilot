/**
 * E2E tests for §2.123 — the `notice` stream event that tells the user a turn
 * armed nothing (`destructive_action_not_prepared`), and its older sibling
 * (`request_budget_exceeded`, §2.51.f2) that shares the same renderer branch.
 *
 * Both codes are emitted by `electron/services/ai.ts` as `{ type: 'notice',
 * requestId, code, message }` over the whitelisted `ai:stream` channel
 * (src/components/AiPanel.tsx `case 'notice'`). Reaching that branch from a
 * live model turn needs a real AI backend and a prompt that reliably steers
 * the model into calling a destructive preview tool and then stalling before
 * confirmation — not reproducible on demand in CI. Instead we inject the
 * event synthetically via `__electronIpcRenderer.emit`, the same technique
 * `ai-internet-gate.spec.ts` uses for `ai:internet-tool-pending`: main sends
 * plain `webContents.send('ai:stream', event)`, and the preload bridge's
 * `on()` wrapper is `(_event, ...args) => listener(...args)`, so
 * `ipc.emit('ai:stream', {}, event)` reproduces exactly what a real send
 * looks like on the listener side.
 *
 * What each test is actually differentiating (CLAUDE.md §7 rule 9 — "what has
 * to break in prod code for this to go red"):
 *   1. Persistence/no-duplication — delete the `if (key) { … addMessage … }`
 *      block in AiPanel.tsx's `notice` case (or fire it twice) and the
 *      poll-for-exactly-one-row assertion goes red; deleting the `noticeKey`
 *      entry for `destructive_action_not_prepared` makes the bubble render
 *      the raw English fallback message instead of the localized string, and
 *      the `not.toContainText(rawFallback)` assertion goes red.
 *   2. Locale overflow — reverting `.ai-message-content` word-wrapping (or
 *      any future markdown-renderer change that stops wrapping long words)
 *      makes `scrollWidth - clientWidth` exceed 0 in the longest-copy locale
 *      (de) at the narrowest window MailCopilot allows.
 *   3. Regression for the older code — deleting or renaming the
 *      `request_budget_exceeded` entry in `noticeKey` is exactly the same
 *      failure mode as (1) for the sibling code; this pins that the new
 *      branch (§2.123) did not crowd out the old one.
 *
 * Companion unit coverage: electron/services/ai.test.ts (notice emission),
 * src/components/AiPanel.test.tsx (the `notice` case in jsdom).
 */
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp, launchAppReuse, cleanupApp, EXPECT_TIMEOUT, type AppContext } from './helpers'

type AiErrorsLocale = {
  ai: { errors: { actionNotPrepared: string; requestBudgetStopped: string } }
}

/**
 * Read the canonical localized copy straight from the locale JSON that the
 * app itself loads, instead of transcribing it by hand into this file. Same
 * pattern and same reason as `rules-i18n.spec.ts` / `QUICK_ACTION_REFUSAL` in
 * `quick-actions-instant-reply.spec.ts`: a hand-copied string pins this spec
 * to today's exact wording, so any future copy edit fails a layout/regression
 * test that has nothing to do with wording. Reading it back out keeps the
 * assertion checking what it exists to check — that the KEY resolves to
 * translated text, not that the translation says something specific.
 */
const aiErrorsLocale = (code: string): AiErrorsLocale =>
  createRequire(import.meta.url)(`../../src/i18n/locales/${code}.json`) as AiErrorsLocale

/** BrowserWindow minWidth/minHeight (electron/main.ts MAIN_WINDOW_MIN_*). */
const MIN_WINDOW = { width: 900, height: 600 }

/** Open the AI panel (sidebar-ai toggles aiPanelOpen, which mounts AiPanel). */
async function openAiPanel(ctx: AppContext): Promise<void> {
  const { page } = ctx
  await page.getByTestId('sidebar-ai').click()
  await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: EXPECT_TIMEOUT })
}

/**
 * Configures a provider that reaches the main chat view (not the onboarding
 * screen) without a live AI backend — same settings `ai-internet-gate.spec.ts`
 * uses.
 *
 * §2.218 — this used to select the (now removed) `subscription` provider,
 * whose auth check passed on local CLI presence alone. The replacement is the
 * OpenAI-compatible provider pinned at a loopback base URL: under
 * `MAILCOPILOT_E2E` the `ai:checkAuth` handler short-circuits to
 * `authenticated` for any configured provider, and none of these specs ever
 * issues a completion, so nothing is dialled and no key is needed. The loopback
 * URL is what keeps it network-independent if a path ever did dial out.
 */
async function configureAiProvider(ctx: AppContext): Promise<void> {
  await ctx.page.evaluate(async () => {
    const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
    await api.invoke('settings:save', {
      aiProvider: 'openai-api',
      aiOpenAiBaseUrl: 'http://127.0.0.1:11434/v1',
      aiPrivacyConsent: true,
    })
  })
}

/**
 * Seeds a chat session directly through the real `aiSession:*` IPC handlers —
 * bypassing `sendMessage()` (which would fire a real `ai:chat` turn) while
 * still exercising the same DB-backed session store the panel reads from.
 * `withBaseline` adds a user/assistant pair so the notice under test lands
 * "after the answer it corrects", matching what a real turn would look like.
 */
async function createSeededSession(
  ctx: AppContext,
  opts: { id: string; title: string; withBaseline: boolean },
): Promise<void> {
  await ctx.page.evaluate(async (o) => {
    const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
    await api.invoke('aiSession:create', { id: o.id, provider: 'openai-api' })
    if (o.withBaseline) {
      await api.invoke('aiSession:addMessage', { sessionId: o.id, role: 'user', content: 'What should I do with this email?' })
      await api.invoke('aiSession:addMessage', { sessionId: o.id, role: 'assistant', content: 'Here is a draft reply.' })
    }
    await api.invoke('aiSession:updateTitle', o.id, o.title)
  }, opts)
}

/** Reads a session's persisted rows through the real IPC path (not the DOM). */
async function readSessionMessages(ctx: AppContext, sessionId: string): Promise<Array<{ role: string; content: string }>> {
  return ctx.page.evaluate(async (id) => {
    const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
    return await api.invoke('aiSession:messages', id) as Array<{ role: string; content: string }>
  }, sessionId)
}

/**
 * Opens the session-history panel and clicks the item matching `title`. This
 * is the ONLY way to change the panel's `activeSessionId` from a test: it is
 * component state, not settable over IPC, and it is what the notice's
 * persistence write path (`sessionWriteQueueRef`) keys off — so switching
 * through the real UI (not by reloading the whole window) is load-bearing,
 * not just convenient.
 */
async function switchToSession(ctx: AppContext, title: string): Promise<void> {
  const { page } = ctx
  await page.getByTestId('ai-sessions-toggle').click()
  await expect(page.getByTestId('ai-session-list')).toBeVisible({ timeout: EXPECT_TIMEOUT })
  await page.getByTestId('ai-session-item').filter({ hasText: title }).click()
  await expect(page.getByTestId('ai-session-list')).toHaveCount(0)
}

/**
 * Emits a synthetic `ai:stream` notice event via the isolated-world IPC stub
 * (see file header). Returns `false` (rather than throwing) when the stub is
 * unavailable, mirroring `ai-internet-gate.spec.ts`'s handling of the same
 * Electron-version dependency, so the whole spec doesn't block CI on a
 * missing test-only bridge.
 */
async function emitAiStreamNotice(
  ctx: AppContext,
  payload: { requestId: string; code: 'request_budget_exceeded' | 'destructive_action_not_prepared'; message: string },
): Promise<boolean> {
  const { page } = ctx
  return page.evaluate(async (p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ipc = (window as any).__electronIpcRenderer as
      | { emit: (channel: string, event: unknown, ...args: unknown[]) => void }
      | undefined
    if (!ipc?.emit) return false
    ipc.emit('ai:stream', {}, { type: 'notice', ...p })
    return true
  }, payload)
}

function skipEmitUnavailable(): void {
  test.info().annotations.push({
    type: 'skip-reason',
    description: '__electronIpcRenderer bridge unavailable in this build; ai:stream emit skipped',
  })
}

/**
 * Seeds a fresh profile with a language before the first launch — same
 * electron-store layout as `telemetryConsent.spec.ts`'s `seedLocale`
 * (`<dataDir>/settings.json` → `{ settings: {…} }`, key `language` not
 * `lang`). `aiProvider` + `aiPrivacyConsent` are seeded too so the panel
 * lands on the main chat view on first open instead of onboarding.
 */
async function seedLocale(lang: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `mailcopilot-e2e-notice-${lang}-`))
  await fs.writeFile(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      settings: {
        language: lang,
        theme: 'light',
        aiProvider: 'openai-api',
        aiOpenAiBaseUrl: 'http://127.0.0.1:11434/v1',
        aiPrivacyConsent: true,
      },
    }),
    'utf8',
  )
  return dir
}

test.describe('§2.123 AI turn-guard notice — persistence across a session switch', () => {
  test('a destructive_action_not_prepared notice is localized, persisted once, and survives switching sessions', async () => {
    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp())
      const appCtx = ctx as AppContext
      await configureAiProvider(appCtx)

      const sidA = 'e2e-notice-persist-a'
      const sidB = 'e2e-notice-persist-b'
      await createSeededSession(appCtx, { id: sidA, title: 'E2E notice persist A', withBaseline: true })
      await createSeededSession(appCtx, { id: sidB, title: 'E2E notice persist B', withBaseline: false })

      await openAiPanel(appCtx)
      await switchToSession(appCtx, 'E2E notice persist A')

      // The event carries a deliberately distinct English fallback message so
      // the assertions below can tell "localized via the code→key map" apart
      // from "whatever main happened to send" (see file header, item 1).
      const rawFallback = 'RAW-FALLBACK-SHOULD-NOT-RENDER-1'
      const emitted = await emitAiStreamNotice(appCtx, {
        requestId: 'e2e-notice-req-1',
        code: 'destructive_action_not_prepared',
        message: rawFallback,
      })
      if (!emitted) { skipEmitUnavailable(); return }

      const expectedText = aiErrorsLocale('en').ai.errors.actionNotPrepared

      const lastBubble = appCtx.page.getByTestId('ai-message-assistant').last()
      await expect(lastBubble).toContainText(expectedText, { timeout: EXPECT_TIMEOUT })
      await expect(lastBubble).not.toContainText(rawFallback)

      // Wait for the async session-write queue to flush to disk, reading
      // through the real IPC path rather than the DOM — this both proves
      // persistence happened at all and that it happened exactly once
      // (a duplicate-write regression would report 2, not 1).
      await expect.poll(async () => {
        const msgs = await readSessionMessages(appCtx, sidA)
        return msgs.filter(m => m.content === expectedText).length
      }, { timeout: EXPECT_TIMEOUT }).toBe(1)

      // Cross a session boundary and back through the real UI. `loadSession`
      // replaces `messages` state entirely from `aiSession:messages` — so
      // finding the notice again on return is a persistence check, not a
      // "React kept it in memory" false positive.
      await switchToSession(appCtx, 'E2E notice persist B')
      await expect(appCtx.page.getByTestId('ai-messages')).not.toContainText(expectedText)

      await switchToSession(appCtx, 'E2E notice persist A')
      const bubblesAfterReturn = appCtx.page.getByTestId('ai-message-assistant')
      await expect(bubblesAfterReturn.filter({ hasText: expectedText })).toHaveCount(1)
      // "After the answer it corrects" — the notice is the LAST assistant
      // bubble, behind the seeded baseline answer.
      await expect(bubblesAfterReturn.last()).toContainText(expectedText)
    } finally {
      await cleanupApp(ctx)
    }
  })
})

test.describe('§2.123 AI turn-guard notice — locale overflow at the minimum window size', () => {
  let dataDir: string | undefined
  let ctx: AppContext | undefined

  test.afterEach(async () => {
    if (ctx) await cleanupApp(ctx)
    ctx = undefined
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true })
    dataDir = undefined
  })

  test('a destructive_action_not_prepared notice does not overflow its bubble in de at the minimum window size', async () => {
    dataDir = await seedLocale('de')
    ctx = await launchAppReuse(dataDir)

    // The seed has to have taken effect, or this silently tests `en` — Root.tsx
    // sets `<html lang>` from the same settings read that drives i18n.
    await expect.poll(async () => ctx!.page.evaluate(() => document.documentElement.lang), {
      timeout: EXPECT_TIMEOUT,
    }).toBe('de')

    await ctx.page.setViewportSize(MIN_WINDOW)

    const sid = 'e2e-notice-overflow-de'
    await createSeededSession(ctx, { id: sid, title: 'DE overflow', withBaseline: false })
    await openAiPanel(ctx)
    await switchToSession(ctx, 'DE overflow')

    const emitted = await emitAiStreamNotice(ctx, {
      requestId: 'e2e-notice-req-de',
      code: 'destructive_action_not_prepared',
      message: 'RAW-FALLBACK-DE',
    })
    if (!emitted) { skipEmitUnavailable(); return }

    const expectedText = aiErrorsLocale('de').ai.errors.actionNotPrepared
    const bubble = ctx.page.getByTestId('ai-message-assistant').last()
    await expect(bubble).toContainText(expectedText, { timeout: EXPECT_TIMEOUT })

    const content = bubble.locator('.ai-message-content')
    await expect.poll(
      async () => content.evaluate(el => el.scrollWidth - el.clientWidth),
      { timeout: EXPECT_TIMEOUT },
    ).toBeLessThanOrEqual(0)

    // Non-vacuity: the de copy has to actually wrap across multiple lines at
    // this width, or the scrollWidth check above passes trivially because
    // there was nothing for a broken wrap to overflow.
    const box = await content.boundingBox()
    expect(box, 'notice bubble has no box').not.toBeNull()
    expect(box!.height, 'de notice rendered on a single line — the overflow check above is vacuous')
      .toBeGreaterThan(30)
  })
})

test.describe('§2.51.f2 AI turn-guard notice — request_budget_exceeded regression', () => {
  test('a request_budget_exceeded notice still renders and localizes (the shared notice case is not broken by §2.123)', async () => {
    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp())
      const appCtx = ctx as AppContext
      await configureAiProvider(appCtx)

      const sid = 'e2e-notice-budget-regression'
      await createSeededSession(appCtx, { id: sid, title: 'E2E notice budget regression', withBaseline: false })
      await openAiPanel(appCtx)
      await switchToSession(appCtx, 'E2E notice budget regression')

      const rawFallback = 'RAW-FALLBACK-SHOULD-NOT-RENDER-BUDGET'
      const emitted = await emitAiStreamNotice(appCtx, {
        requestId: 'e2e-notice-req-budget',
        code: 'request_budget_exceeded',
        message: rawFallback,
      })
      if (!emitted) { skipEmitUnavailable(); return }

      const expectedText = aiErrorsLocale('en').ai.errors.requestBudgetStopped
      const bubble = appCtx.page.getByTestId('ai-message-assistant').last()
      await expect(bubble).toContainText(expectedText, { timeout: EXPECT_TIMEOUT })
      await expect(bubble).not.toContainText(rawFallback)

      await expect.poll(async () => {
        const msgs = await readSessionMessages(appCtx, sid)
        return msgs.filter(m => m.content === expectedText).length
      }, { timeout: EXPECT_TIMEOUT }).toBe(1)
    } finally {
      await cleanupApp(ctx)
    }
  })
})
