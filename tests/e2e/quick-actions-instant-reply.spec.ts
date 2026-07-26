/**
 * E2E spec: §3.3 B4 "Compose Quick Actions + Instant Reply" — toolbar/strip
 * visibility, diff-preview interaction, and per-account opt-in persistence,
 * verified against a live Electron window.
 *
 * NOTE: This spec is written but NOT run by test-gen. Set NEEDS_E2E: yes.
 *       The pre-pr-gate agent executes it via `npm run e2e:bg`.
 *
 * Positive-path (a live IPC round trip landing on a rendered rewrite / draft
 * options) is NOT e2e-reachable, for the SAME two independent reasons
 * documented in `tests/e2e/thread-summary.spec.ts` (§3.3 B2):
 *
 *   1. No AI provider is configured for any e2e fixture account, so
 *      `selectSummaryProvider(getSettings())` always resolves `provider: null`
 *      and BOTH `generateQuickActionRewrite` / `generateInstantReplyDrafts`
 *      deterministically resolve `{ ok:false, reason:'no_provider' }` before
 *      any network call — this is exactly the fixture state test-gen wants:
 *      it lets these specs assert the toolbar/strip render + IPC contract
 *      deterministically WITHOUT touching a real provider network from the
 *      Electron main process (which Playwright's page.route() cannot
 *      intercept — see thread-summary.spec.ts point 2 for the same reasoning
 *      applied to aiChatSimple's real `fetch`).
 *   2. Even with a provider configured, `getMessageByUid()` reads the SQLite
 *      `messages` table via `packages/db`, and `e2e:injectMail` only writes
 *      into the in-memory `e2eBox`/`E2E_BOXES` structure — never persisted to
 *      SQLite — so `generateInstantReplyDrafts`'s cache-body lookup would
 *      always miss regardless of provider config, short-circuiting to a
 *      refusal before ever reaching the model call.
 *
 * The generator/handler behavior for every branch (empty_input, budget,
 * no_provider, provider_error, cache-only body resolution, opt-in gate,
 * messageId-stripping, wrapUntrusted boundary, single-flight, PII-free audit)
 * is thoroughly unit-tested with real deps:
 * `electron/services/ai.test.ts` (generateQuickActionRewrite /
 * generateInstantReplyDrafts / cleanRewriteOutput / parseInstantReplyDrafts),
 * `electron/main.quickActionsInstantReply.test.ts` (zod schema + forward-
 * verbatim handler contract), and `src/components/ComposeQuickActions.test.tsx`
 * / `src/components/QuickActionDiff.test.tsx` /
 * `src/components/InstantReplyStrip.test.tsx` / `src/hooks/useQuickActions.test.ts`
 * / `src/hooks/useInstantReply.test.ts` (hook + component level, IPC mocked).
 *
 * What THIS spec verifies for real, against a live Electron window:
 *   1. The Compose quick-action toolbar renders in a real Compose window and
 *      clicking a preset button reaches the real `no_provider` refusal path
 *      (real IPC round trip, deterministic outcome given no configured
 *      provider) — never a crash, never an auto-substitution of the body.
 *   2. The Instant Reply strip renders on the actively-open card of a real
 *      thread when the per-account toggle is ON, and is entirely absent when
 *      OFF (real negative-path AC, mirrors thread-summary.spec.ts test 1).
 *   3. Clicking Instant Reply's trigger reaches the real `no_provider`
 *      refusal — no crash, no options rendered, no compose window opened
 *      (no-auto-send / no-auto-compose invariant when there is nothing to
 *      pick).
 *   4. The per-account "Instant Reply" Settings toggle persists across a
 *      Settings window close/reopen cycle (UI + settings.json round-trip).
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, waitForPage, EXPECT_TIMEOUT, CLOSE_TIMEOUT, type AppContext } from './helpers'

test('quick actions: toolbar renders in Compose and a preset click reaches a graceful no_provider refusal', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-quickaction-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // The default e2e fixture language is 'ru' (electron/main.ts E2E_LANGUAGE = 'ru'),
    // so the first email's subject is the RU string, not the EN 'E2E1: first email'
    // (same fixture item as mail.flows.spec.ts). The /thread root/i filter the other
    // tests use is locale-independent by coincidence (that subject is not translated);
    // this single-email lookup is not, so it must use the localized subject.
    const baseMail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(baseMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(baseMail)
    await expect(page.getByTestId('mail-action-reply')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.getByTestId('mail-action-reply').click()

    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    compose.on('dialog', d => d.accept())

    // The toolbar renders above the body with all four preset buttons.
    await expect(compose.getByTestId('compose-quick-actions')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(compose.getByTestId('compose-quick-action-improve')).toBeVisible()
    await expect(compose.getByTestId('compose-quick-action-shorter')).toBeVisible()
    await expect(compose.getByTestId('compose-quick-action-formal')).toBeVisible()
    await expect(compose.getByTestId('compose-quick-action-grammar')).toBeVisible()

    const bodyBefore = await compose.getByTestId('compose-text').inputValue()

    // Click "Improve" — reaches the real ai:quickAction:rewrite IPC channel.
    // No AI provider is configured for this e2e fixture account, so the
    // generator deterministically refuses with no_provider (see file header).
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('compose-quick-actions-refusal')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // No diff preview ever appears, and the body is never auto-substituted.
    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)
    await expect(compose.getByTestId('compose-text')).toHaveValue(bodyBefore)
  } finally {
    await cleanupApp(ctx)
  }
})

test('instant reply: strip does NOT render when the per-account toggle is OFF (default)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-instantreply-off-'))
    const page = ctx.page!

    const threadItem = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItem)

    const threadView = page.getByTestId('thread-view')
    await expect(threadView).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(threadView.locator('[data-testid="thread-card"]')).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    // Toggle OFF by default — the strip must be entirely absent.
    await expect(page.getByTestId('instant-reply-strip')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

test('instant reply: strip renders when toggled ON, and the trigger reaches a graceful no_provider refusal (no compose opened)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-instantreply-on-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // -----------------------------------------------------------------------
    // 1. Turn the per-account Instant Reply toggle ON via Settings → AI.
    // -----------------------------------------------------------------------
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-ai').click()

    const toggle = settings.getByTestId('settings-ai-instant-reply-toggle')
    await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(toggle).not.toBeChecked()
    await toggle.check()
    await expect(toggle).toBeChecked()
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // -----------------------------------------------------------------------
    // 2. Open the fixture thread — the strip must now render on the active card.
    // -----------------------------------------------------------------------
    const threadItem = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItem)

    const threadView = page.getByTestId('thread-view')
    await expect(threadView).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('instant-reply-strip')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('instant-reply-trigger')).toBeVisible()

    // -----------------------------------------------------------------------
    // 3. Click the trigger — reaches the real ai:instantReply:generate IPC
    //    channel. No provider configured → deterministic no_provider refusal
    //    (see file header). No draft options render, no Compose window opens
    //    (no-auto-send / no-auto-compose invariant with nothing to pick).
    // -----------------------------------------------------------------------
    await page.getByTestId('instant-reply-trigger').click()
    await expect(page.getByTestId('instant-reply-refusal')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('instant-reply-options')).toHaveCount(0)

    // No Compose child window was opened as a side effect of the refusal.
    const composeWindows = browser.contexts()[0].pages().filter(p => p.url().includes('#/compose'))
    expect(composeWindows).toHaveLength(0)
  } finally {
    await cleanupApp(ctx)
  }
})

test('instant reply: strip renders on a SINGLE (non-thread) message when toggled ON — reading-pane parity (H2)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-instantreply-single-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // -----------------------------------------------------------------------
    // 1. Turn the per-account Instant Reply toggle ON via Settings → AI.
    // -----------------------------------------------------------------------
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-ai').click()

    const toggle = settings.getByTestId('settings-ai-instant-reply-toggle')
    await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(toggle).not.toBeChecked()
    await toggle.check()
    await expect(toggle).toBeChecked()
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // -----------------------------------------------------------------------
    // 2. Open a SINGLE (non-thread) fixture email — default e2e language is
    //    'ru' (electron/main.ts E2E_LANGUAGE = 'ru'), so the subject is the RU
    //    fixture string, not the EN 'E2E1: first email' (mail.flows.spec.ts
    //    uses the same fixture item).
    // -----------------------------------------------------------------------
    const baseMail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(baseMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(baseMail)

    // A single message never renders the multi-card ThreadView — the strip
    // must still appear above the body via SingleMessageInstantReply.
    await expect(page.getByTestId('thread-view')).toHaveCount(0)
    await expect(page.getByTestId('instant-reply-strip')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('instant-reply-trigger')).toBeVisible()

    // -----------------------------------------------------------------------
    // 3. Trigger reaches the real IPC channel; no provider configured for this
    //    e2e fixture account → deterministic no_provider refusal, no crash, no
    //    Compose window opened (same reasoning as the thread-path test above).
    // -----------------------------------------------------------------------
    await page.getByTestId('instant-reply-trigger').click()
    await expect(page.getByTestId('instant-reply-refusal')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('instant-reply-options')).toHaveCount(0)

    const composeWindows = browser.contexts()[0].pages().filter(p => p.url().includes('#/compose'))
    expect(composeWindows).toHaveLength(0)
  } finally {
    await cleanupApp(ctx)
  }
})

test('instant reply: per-account Settings toggle persists across close/reopen', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-instantreply-toggle-'))
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-ai').click()

    const toggle = settings.getByTestId('settings-ai-instant-reply-toggle')
    await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(toggle).not.toBeChecked()

    await toggle.check()
    await expect(toggle).toBeChecked()
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Reopen — the toggle must still be checked (settings.json round-trip,
    // not just React state).
    await page.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    await settings2.getByTestId('settings-tab-ai').click()

    const toggle2 = settings2.getByTestId('settings-ai-instant-reply-toggle')
    await expect(toggle2).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(toggle2).toBeChecked()

    // Restore OFF for hygiene (temp data dir is wiped by cleanupApp anyway).
    await toggle2.uncheck()
    await expect(toggle2).not.toBeChecked()
    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})
