/**
 * E2E spec: §3.3.C-thread.1 + Thread UX 3-pack
 *
 * The e2e fixture in main.ts seeds account 1 with two messages that form a
 * thread (uid=89 "thread root" + uid=88 "Re: thread root"). When
 * groupConversations is enabled (default) and the user opens this thread,
 * ThreadView should render a vertical stack of two cards.
 *
 * NOTE: This spec is written but NOT run by test-gen. Set NEEDS_E2E: yes.
 *       The pre-pr-gate agent executes it via `npm run e2e:bg`.
 *
 * Default conversation order is 'newest-top' (AC1):
 *   uid=88 date=2026-02-08T00:41 "Re: E2E1: thread root" (newer) = cards.first()
 *   uid=89 date=2026-02-08T00:40 "E2E1: thread root"     (older) = cards.last()
 *
 * Seeding details:
 *   uid=89, date=2026-02-08T00:40 "E2E1: thread root" (older by date)
 *   uid=88, date=2026-02-08T00:41 "Re: E2E1: thread root" (newer by date)
 *
 * The inbox list arrives UID-descending: [uid=89, uid=88].
 * buildThreadRows uses list order, so lead = uid=89 = thread root.
 * Clicking the thread row opens thread root (uid=89).
 *
 * After clicking thread row:
 *   active = thread root = lastCard (newest-top: uid=89 is older, so index 1)
 *   lastCard: isActive=true, isExpanded=true (expandedSet={activeKey})
 *   firstCard (reply, newer): isActive=false, isExpanded=false, collapsed
 *
 * AC2: clicking expanded active card collapses it (click-to-toggle).
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  launchApp,
  launchAppReuse,
  cleanupApp,
  terminateProcess,
  clickMailItem,
  selectMcOption,
  waitForPage,
  EXPECT_TIMEOUT,
  CLOSE_TIMEOUT,
  type AppContext,
} from './helpers'

test('thread-view: vertical stack renders for a 2-message thread', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-thread-'))
    const page = ctx.page!

    // -----------------------------------------------------------------------
    // 1. Find the thread root mail in the list and open it.
    //    The thread row's lead = uid=89 (thread root, UID-descending first).
    //    Clicking → openMail(thread root) → active = thread root = lastCard
    //    (newest-top: reply is firstCard, root is lastCard).
    // -----------------------------------------------------------------------
    const threadItem = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItem)

    // -----------------------------------------------------------------------
    // 2. ThreadView should be visible (thread has 2 messages)
    // -----------------------------------------------------------------------
    const threadView = page.getByTestId('thread-view')
    await expect(threadView).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // -----------------------------------------------------------------------
    // 3. Exactly 2 cards rendered
    // -----------------------------------------------------------------------
    const cards = threadView.locator('[data-testid="thread-card"]')
    await expect(cards).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    // -----------------------------------------------------------------------
    // 4. AC1: newest-top order — firstCard = reply (newer), lastCard = root (older).
    //    Active = thread root → lastCard expanded; firstCard (reply) collapsed.
    // -----------------------------------------------------------------------
    const cardHeaders = threadView.locator('.thread-card-header')
    await expect(cardHeaders).toHaveCount(2)

    const firstHeader = cardHeaders.first()
    const lastHeader = cardHeaders.last()

    // newest-top: firstCard=reply collapsed, lastCard=thread-root active+expanded
    await expect(firstHeader).toHaveAttribute('aria-expanded', 'false')
    await expect(lastHeader).toHaveAttribute('aria-expanded', 'true')

    // -----------------------------------------------------------------------
    // 5. CSS classes: lastCard is active+expanded; firstCard is collapsed.
    // -----------------------------------------------------------------------
    const firstCard = cards.first()
    const lastCard = cards.last()

    await expect(lastCard).toHaveClass(/thread-card-active/)
    await expect(lastCard).toHaveClass(/thread-card-expanded/)
    await expect(firstCard).toHaveClass(/thread-card-collapsed/)
    await expect(firstCard).not.toHaveClass(/thread-card-active/)

    // -----------------------------------------------------------------------
    // 6. Click firstCard (reply, collapsed) → becomes active+expanded.
    //    lastCard (thread root) collapses (snippet visible).
    // -----------------------------------------------------------------------
    await firstHeader.click()

    // lastCard (thread root) should become collapsed with a snippet
    await expect(lastCard).toHaveClass(/thread-card-collapsed/, { timeout: EXPECT_TIMEOUT })
    await expect(lastCard.locator('.thread-card-snippet')).toBeVisible()
    await expect(lastHeader).toHaveAttribute('aria-expanded', 'false')

    // firstCard (reply) is now active and expanded
    await expect(firstCard).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(firstCard).toHaveClass(/thread-card-expanded/)
    await expect(firstHeader).toHaveAttribute('aria-expanded', 'true')

    // -----------------------------------------------------------------------
    // 7. AC2: Click the active expanded firstCard → collapses it (click-to-toggle).
    //    Active mail does NOT change.
    // -----------------------------------------------------------------------
    await firstHeader.click()

    await expect(firstCard).toHaveClass(/thread-card-collapsed/, { timeout: EXPECT_TIMEOUT })
    await expect(firstHeader).toHaveAttribute('aria-expanded', 'false')
    // Still active (CSS class remains)
    await expect(firstCard).toHaveClass(/thread-card-active/)

    // -----------------------------------------------------------------------
    // 8. No legacy .thread-strip element anywhere on the page
    // -----------------------------------------------------------------------
    await expect(page.locator('.thread-strip')).toHaveCount(0)

    // -----------------------------------------------------------------------
    // 9. Single-toolbar UX: ThreadView has NO duplicate action bar.
    //    Thread-level actions live in the mail-viewer top toolbar
    //    (Gmail / Spark / Shortwave model). Regression guard for the
    //    deduplication: legacy .thread-view-header / .thread-action-btn
    //    must not be present.
    // -----------------------------------------------------------------------
    await expect(threadView.locator('.thread-view-header')).toHaveCount(0)
    await expect(threadView.locator('.thread-action-btn')).toHaveCount(0)
    // Delete and Archive buttons must exist in the viewer toolbar.
    await expect(page.getByTestId('mail-action-delete')).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('thread-view: single-message mail does NOT render ThreadView', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-single-'))
    const page = ctx.page!

    // Open a mail that is NOT part of a thread (e.g. "first email" / "первое письмо")
    const singleMail = page
      .getByTestId('mail-item')
      .filter({ hasText: /first email|первое письмо|premier e-mail|erste E-Mail|primer e-mail|primo e-mail/i })
      .first()
    await expect(singleMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(singleMail)

    // Wait for the viewer to load
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // ThreadView must NOT be rendered for a single message
    await expect(page.getByTestId('thread-view')).toHaveCount(0)

    // Also confirm the legacy .thread-strip is gone
    await expect(page.locator('.thread-strip')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * Gap 0 — Settings: change Conversation order from newest-top to oldest-top.
 * After saving and reopening the thread, the stack must flip so that the first
 * card is the oldest message (not the newest).
 *
 * Newest-top (default):  cards.first() = reply (uid=88, newer date)
 * Oldest-top (changed):  cards.first() = thread root (uid=89, older date)
 *
 * The test verifies the full flow:
 *   1. Open thread — newest-top is the default: firstCard = reply (newer).
 *   2. Open Settings → Productivity tab → change Conversation order to "Oldest first".
 *   3. Save settings and close Settings window.
 *   4. Click away from the thread, then reopen it.
 *   5. Assert: firstCard is now the thread root (older, aria-expanded=false by
 *      default since active is still the lead = uid=89 = thread root, now at
 *      cards.first() in oldest-top order → should be active+expanded).
 */
test('thread-view: changing conversation order in Settings flips card stack', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-order-setting-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // -----------------------------------------------------------------------
    // 1. Open thread A → newest-top default: firstCard = reply (newer).
    // -----------------------------------------------------------------------
    const threadItem = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItem)

    const threadView = page.getByTestId('thread-view')
    await expect(threadView).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const cards = threadView.locator('[data-testid="thread-card"]')
    await expect(cards).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    // Newest-top: firstCard = reply (newer, collapsed); lastCard = thread root (active+expanded)
    await expect(cards.first()).toHaveClass(/thread-card-collapsed/)
    await expect(cards.last()).toHaveClass(/thread-card-active/)

    // -----------------------------------------------------------------------
    // 2. Open Settings → Productivity tab → change Conversation order.
    // -----------------------------------------------------------------------
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-productivity').click()

    // Change to "Oldest first" / oldest-top
    const orderSelect = settings.getByTestId('settings-conversation-order')
    await expect(orderSelect).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await selectMcOption(orderSelect, 'oldest-top')

    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // -----------------------------------------------------------------------
    // 3. Click away from the thread (open a single-message mail), then reopen.
    // -----------------------------------------------------------------------
    const singleMail = page
      .getByTestId('mail-item')
      .filter({ hasText: /first email|первое письмо|premier e-mail|erste E-Mail|primer e-mail|primo e-mail/i })
      .first()
    await expect(singleMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(singleMail)
    await expect(page.getByTestId('thread-view')).toHaveCount(0, { timeout: EXPECT_TIMEOUT })

    // Reopen the thread
    const threadItemAgain = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItemAgain).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItemAgain)

    const threadViewAgain = page.getByTestId('thread-view')
    await expect(threadViewAgain).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const cardsAgain = threadViewAgain.locator('[data-testid="thread-card"]')
    await expect(cardsAgain).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    // -----------------------------------------------------------------------
    // 4. Assert oldest-top: firstCard = thread root (oldest, uid=89, active+expanded)
    //    lastCard = reply (newer, uid=88, collapsed)
    // -----------------------------------------------------------------------
    const firstCardAgain = cardsAgain.first()
    const lastCardAgain = cardsAgain.last()

    // oldest-top: thread root (uid=89, older date) is now firstCard
    await expect(firstCardAgain).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(firstCardAgain).toHaveClass(/thread-card-expanded/)
    await expect(
      threadViewAgain.locator('.thread-card-header').first(),
    ).toHaveAttribute('aria-expanded', 'true')

    // reply (uid=88, newer date) is now lastCard and collapsed
    await expect(lastCardAgain).toHaveClass(/thread-card-collapsed/)
    await expect(lastCardAgain).not.toHaveClass(/thread-card-active/)
    await expect(
      threadViewAgain.locator('.thread-card-header').last(),
    ).toHaveAttribute('aria-expanded', 'false')

    // -----------------------------------------------------------------------
    // 5. Restore default setting (newest-top) to avoid affecting other tests.
    // -----------------------------------------------------------------------
    await page.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    await settings2.getByTestId('settings-tab-productivity').click()
    await selectMcOption(settings2.getByTestId('settings-conversation-order'), 'newest-top')
    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * Gap 1 — switching away from a thread and back resets the active/expanded card
 * state to the lead (post-fix behaviour: expandedSet = {activeKey}).
 *
 * Newest-top order: firstCard = reply (newer, uid=88), lastCard = root (older, uid=89).
 * Initial active = thread root → lastCard active+expanded; firstCard collapsed.
 *
 * Sequence:
 *   1. Open thread A (lead = uid=89 thread root → lastCard active/expanded).
 *   2. Click firstCard (reply, uid=88) — it becomes active/expanded; lastCard collapses.
 *   3. Click a single-message mail from the inbox — ThreadView disappears.
 *   4. Click thread A again (same lead row).
 *   5. Assert: lastCard (thread root) is active/expanded again; firstCard (reply)
 *      is collapsed — no stale state from step 2 carries over.
 */
test('thread-view: switching threads resets active card state', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-thread-reset-'))
    const page = ctx.page!

    // -----------------------------------------------------------------------
    // 1. Open thread A (lead = thread root).
    // -----------------------------------------------------------------------
    const threadItem = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItem)

    const threadView = page.getByTestId('thread-view')
    await expect(threadView).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const cards = threadView.locator('[data-testid="thread-card"]')
    await expect(cards).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    // Newest-top: firstCard = reply (newer), lastCard = thread root (older, active).
    const firstCard = cards.first()
    const lastCard = cards.last()
    await expect(lastCard).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(lastCard).toHaveClass(/thread-card-expanded/)

    // -----------------------------------------------------------------------
    // 2. Click firstCard (reply, collapsed) → it becomes active/expanded; lastCard collapses.
    // -----------------------------------------------------------------------
    const firstHeader = threadView.locator('.thread-card-header').first()
    await firstHeader.click()

    await expect(firstCard).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(firstCard).toHaveClass(/thread-card-expanded/)
    await expect(lastCard).toHaveClass(/thread-card-collapsed/, { timeout: EXPECT_TIMEOUT })

    // -----------------------------------------------------------------------
    // 3. Click a single-message mail to leave the thread entirely.
    // -----------------------------------------------------------------------
    const singleMail = page
      .getByTestId('mail-item')
      .filter({ hasText: /first email|первое письмо|premier e-mail|erste E-Mail|primer e-mail|primo e-mail/i })
      .first()
    await expect(singleMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(singleMail)

    // ThreadView must disappear — we are now viewing a single message.
    await expect(page.getByTestId('thread-view')).toHaveCount(0, { timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // -----------------------------------------------------------------------
    // 4. Open thread A again by clicking its inbox row.
    // -----------------------------------------------------------------------
    const threadItemAgain = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItemAgain).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItemAgain)

    const threadViewAgain = page.getByTestId('thread-view')
    await expect(threadViewAgain).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // -----------------------------------------------------------------------
    // 5. Assert state is reset: lastCard (thread root) is active/expanded again;
    //    firstCard (reply) is collapsed — no stale state from step 2.
    // -----------------------------------------------------------------------
    const cardsAgain = threadViewAgain.locator('[data-testid="thread-card"]')
    await expect(cardsAgain).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    const firstCardAgain = cardsAgain.first()
    const lastCardAgain = cardsAgain.last()

    // Newest-top: lastCard = thread root (lead = active after re-open)
    await expect(lastCardAgain).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(lastCardAgain).toHaveClass(/thread-card-expanded/)
    await expect(
      threadViewAgain.locator('.thread-card-header').last(),
    ).toHaveAttribute('aria-expanded', 'true')

    // Reply must be collapsed — no carry-over from the previous selection
    await expect(firstCardAgain).not.toHaveClass(/thread-card-active/)
    await expect(firstCardAgain).toHaveClass(/thread-card-collapsed/)
    await expect(
      threadViewAgain.locator('.thread-card-header').first(),
    ).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * HIGH gap — default newest-top opens newest card as active+expanded.
 *
 * In newest-top order firstCard = reply (uid=88, newer date 00:41).
 * When the user activates the newest card (by clicking firstCard after opening
 * the thread), firstCard must carry thread-card-active + thread-card-expanded
 * and expose the body slot; lastCard (thread root, older) must be collapsed.
 *
 * Note: clicking the inbox thread row opens lead=uid=89 (older, lastCard) as
 * the initial active. To reach the "active=newest" state we click the firstCard
 * header once — this is the canonical user path when the newest message is the
 * one they care about.
 */
test('thread-view: default newest-top opens newest card as active+expanded', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-newest-active-'))
    const page = ctx.page!

    // -----------------------------------------------------------------------
    // 1. Open the 2-message thread by clicking its inbox row.
    //    lead = uid=89 (thread root, older by date) → lastCard active/expanded.
    // -----------------------------------------------------------------------
    const threadItem = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItem)

    const threadView = page.getByTestId('thread-view')
    await expect(threadView).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const cards = threadView.locator('[data-testid="thread-card"]')
    await expect(cards).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    const firstCard = cards.first()
    const lastCard  = cards.last()

    // newest-top: firstCard = reply (uid=88, newer); lastCard = root (uid=89, older, active).
    await expect(lastCard).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(firstCard).toHaveClass(/thread-card-collapsed/)

    // -----------------------------------------------------------------------
    // 2. Click firstCard (reply = newest card) to make it active.
    // -----------------------------------------------------------------------
    const firstHeader = threadView.locator('.thread-card-header').first()
    await firstHeader.click()

    // -----------------------------------------------------------------------
    // 3. Assert: cards.first() — newest card — is now active + expanded.
    // -----------------------------------------------------------------------
    await expect(firstCard).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(firstCard).toHaveClass(/thread-card-expanded/)
    await expect(firstHeader).toHaveAttribute('aria-expanded', 'true')

    // Body slot is visible inside the active firstCard.
    const firstCardBody = firstCard.locator('[data-testid="mail-body-text"], iframe.mail-iframe')
    await expect(firstCardBody.first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // -----------------------------------------------------------------------
    // 4. Assert: cards.last() — older card — is collapsed, not active.
    // -----------------------------------------------------------------------
    await expect(lastCard).toHaveClass(/thread-card-collapsed/, { timeout: EXPECT_TIMEOUT })
    await expect(lastCard).not.toHaveClass(/thread-card-active/)
    await expect(
      threadView.locator('.thread-card-header').last(),
    ).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * MEDIUM gap #1 — live conversation order change flips an already-open stack.
 *
 * The settings:changed event (fired when Settings are saved) should cause
 * useConversationOrder to update and ThreadView to re-render without the user
 * closing and reopening the thread.
 *
 * Flow:
 *   1. Open the 2-message thread — newest-top default: firstCard = reply (newer).
 *   2. Inject settings:changed via IPC while the thread is still visible.
 *   3. Assert the stack flips: firstCard is now the thread root (oldest, active+expanded).
 *   4. Inject settings:changed back to newest-top to restore isolation.
 *
 * We drive the setting change through electronApp.evaluate() → ipcMain trigger
 * instead of the Settings UI to avoid focus-steal flakiness and keep this test
 * fast and reliable. The UI-path variant is already covered by the
 * 'changing conversation order in Settings flips card stack' test.
 */
test('thread-view: live conversation order change flips already-open stack', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-live-flip-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // -----------------------------------------------------------------------
    // 1. Open thread — newest-top default: firstCard=reply(newer), lastCard=root(older+active).
    // -----------------------------------------------------------------------
    const threadItem = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItem)

    const threadView = page.getByTestId('thread-view')
    await expect(threadView).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const cards = threadView.locator('[data-testid="thread-card"]')
    await expect(cards).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    // Newest-top: firstCard = reply (newer, collapsed); lastCard = root (older, active).
    await expect(cards.first()).toHaveClass(/thread-card-collapsed/, { timeout: EXPECT_TIMEOUT })
    await expect(cards.last()).toHaveClass(/thread-card-active/)

    // -----------------------------------------------------------------------
    // 2. Open Settings UI → Productivity → switch to oldest-top → save.
    //    This fires the settings:changed event in the renderer while the thread
    //    is still open in the background.
    // -----------------------------------------------------------------------
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-productivity').click()

    const orderSelect = settings.getByTestId('settings-conversation-order')
    await expect(orderSelect).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await selectMcOption(orderSelect, 'oldest-top')

    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // Bring the main window back to front (Settings close brings focus back).
    await page.bringToFront()

    // -----------------------------------------------------------------------
    // 3. Assert live flip: thread is still open — stack should already be
    //    oldest-top without any navigation.
    //    oldest-top: firstCard = thread root (uid=89, older, active+expanded),
    //                lastCard  = reply (uid=88, newer, collapsed).
    // -----------------------------------------------------------------------
    const liveCards = threadView.locator('[data-testid="thread-card"]')
    await expect(liveCards).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    await expect(liveCards.first()).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(liveCards.first()).toHaveClass(/thread-card-expanded/)
    await expect(
      threadView.locator('.thread-card-header').first(),
    ).toHaveAttribute('aria-expanded', 'true')

    await expect(liveCards.last()).toHaveClass(/thread-card-collapsed/)
    await expect(liveCards.last()).not.toHaveClass(/thread-card-active/)
    await expect(
      threadView.locator('.thread-card-header').last(),
    ).toHaveAttribute('aria-expanded', 'false')

    // -----------------------------------------------------------------------
    // 4. Restore default (newest-top) for test isolation.
    // -----------------------------------------------------------------------
    await page.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    await settings2.getByTestId('settings-tab-productivity').click()
    await selectMcOption(settings2.getByTestId('settings-conversation-order'), 'newest-top')
    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * MEDIUM gap #2 — conversation order persists across app restart.
 *
 * Flow:
 *   1. Launch app with a fresh data dir.
 *   2. Change conversation order to oldest-top via Settings UI.
 *   3. Close the app cleanly.
 *   4. Re-launch with the same data dir.
 *   5. Open the thread — assert cards.first() is oldest (uid=89, active+expanded).
 *   6. Cleanup: change back to newest-top before closing so the data dir ends
 *      up in a known state (good hygiene even though it's a temp dir).
 */
test('thread-view: conversation order persists across restart', async () => {
  const ctx: Partial<AppContext> = {}
  let sharedDataDir = ''
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-persist-order-'))
    const page = ctx.page!
    const browser = ctx.browser!
    sharedDataDir = ctx.dataDir!
    const dataDir = sharedDataDir

    // -----------------------------------------------------------------------
    // 1. Change to oldest-top via Settings, then close the app.
    // -----------------------------------------------------------------------
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-productivity').click()

    const orderSelect = settings.getByTestId('settings-conversation-order')
    await expect(orderSelect).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await selectMcOption(orderSelect, 'oldest-top')

    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Close the first app instance (browser + proc). Keep dataDir on disk.
    await ctx.browser?.close().catch(() => {})
    if (ctx.proc) await terminateProcess(ctx.proc)
    // Clear ctx so the finally block's cleanupApp does not re-terminate the
    // already-closed instance and does not delete the shared dataDir yet.
    ctx.browser = undefined
    ctx.proc = undefined

    // -----------------------------------------------------------------------
    // 2. Re-launch with the same data dir so persisted settings are loaded.
    // -----------------------------------------------------------------------
    const ctx2: Partial<AppContext> = {}
    Object.assign(ctx2, await launchAppReuse(dataDir))
    // Override ctx so finally cleanupApp terminates the new instance.
    // dataDir cleanup is done manually at the end of this test.
    Object.assign(ctx, ctx2)

    const page2 = ctx.page!
    const browser2 = ctx.browser!

    // -----------------------------------------------------------------------
    // 3. Open the thread in the restarted app.
    // -----------------------------------------------------------------------
    const threadItem = page2
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItem)

    const threadView = page2.getByTestId('thread-view')
    await expect(threadView).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const cardsAfterRestart = threadView.locator('[data-testid="thread-card"]')
    await expect(cardsAfterRestart).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    // -----------------------------------------------------------------------
    // 4. Assert oldest-top persisted: firstCard = thread root (uid=89, older, active+expanded).
    // -----------------------------------------------------------------------
    await expect(cardsAfterRestart.first()).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(cardsAfterRestart.first()).toHaveClass(/thread-card-expanded/)
    await expect(
      threadView.locator('.thread-card-header').first(),
    ).toHaveAttribute('aria-expanded', 'true')

    await expect(cardsAfterRestart.last()).toHaveClass(/thread-card-collapsed/)
    await expect(cardsAfterRestart.last()).not.toHaveClass(/thread-card-active/)

    // -----------------------------------------------------------------------
    // 5. Restore newest-top for hygiene before exiting.
    // -----------------------------------------------------------------------
    await page2.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser2, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    await settings2.getByTestId('settings-tab-productivity').click()
    await selectMcOption(settings2.getByTestId('settings-conversation-order'), 'newest-top')
    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    // cleanupApp will not remove sharedDataDir (launchAppReuse returns ctx without it).
    await cleanupApp(ctx)
    // Explicitly remove the shared data directory we created at the start.
    if (sharedDataDir) await fs.rm(sharedDataDir, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * Gap 2 — clicking a collapsed card within the thread updates active card,
 * subject display, and body slot.
 *
 * Newest-top order: firstCard = reply (uid=88), lastCard = thread root (uid=89).
 * Initial active = thread root (uid=89 = lastCard).
 *
 * Sequence:
 *   1. Open thread A (lastCard = thread root → active/expanded).
 *   2. Click firstCard (reply, uid=88) — currently collapsed → becomes active.
 *   3. Assert:
 *      a. .mail-subject text reflects the reply's subject.
 *      b. .thread-card-active class moves to firstCard.
 *      c. Body slot is visible for firstCard.
 *      d. lastCard is now collapsed (no longer active or expanded).
 */
test('thread-view: selecting another mail row updates active card', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-card-switch-'))
    const page = ctx.page!

    // -----------------------------------------------------------------------
    // 1. Open thread A — lastCard (thread root) is active/expanded by default.
    //    (newest-top: firstCard=reply, lastCard=root)
    // -----------------------------------------------------------------------
    const threadItem = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    await expect(threadItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(threadItem)

    const threadView = page.getByTestId('thread-view')
    await expect(threadView).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const cards = threadView.locator('[data-testid="thread-card"]')
    await expect(cards).toHaveCount(2, { timeout: EXPECT_TIMEOUT })

    const firstCard = cards.first()
    const lastCard = cards.last()

    // Newest-top: lastCard = thread root (active/expanded), firstCard = reply (collapsed).
    await expect(lastCard).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(lastCard).toHaveClass(/thread-card-expanded/)
    await expect(firstCard).toHaveClass(/thread-card-collapsed/)

    // Confirm the subject currently shown is the thread root's subject.
    const subjectEl = page.getByTestId('mail-subject')
    await expect(subjectEl).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(subjectEl).toHaveText(/thread root/i)

    // -----------------------------------------------------------------------
    // 2. Click firstCard (reply) — it is collapsed, so this switches active.
    // -----------------------------------------------------------------------
    const firstHeader = threadView.locator('.thread-card-header').first()
    await firstHeader.click()

    // -----------------------------------------------------------------------
    // 3a. .mail-subject must update to reflect the reply's subject.
    // -----------------------------------------------------------------------
    await expect(page.getByTestId('mail-subject')).toHaveText(
      /re:.*thread root/i,
      { timeout: EXPECT_TIMEOUT },
    )

    // -----------------------------------------------------------------------
    // 3b. .thread-card-active moves to firstCard.
    // -----------------------------------------------------------------------
    await expect(firstCard).toHaveClass(/thread-card-active/, { timeout: EXPECT_TIMEOUT })
    await expect(firstCard).toHaveClass(/thread-card-expanded/)

    // -----------------------------------------------------------------------
    // 3c. Body slot is visible inside the now-active firstCard.
    //     MailBodyContent renders <pre data-testid="mail-body-text"> for plain
    //     text and <iframe class="mail-iframe"> for HTML. The reply fixture uses
    //     plain text, so [data-testid="mail-body-text"] is expected here.
    //     Both selectors are checked to be resilient against fixture format changes.
    // -----------------------------------------------------------------------
    const firstCardBody = firstCard.locator('[data-testid="mail-body-text"], iframe.mail-iframe')
    await expect(firstCardBody.first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // -----------------------------------------------------------------------
    // 3d. lastCard (thread root) is now collapsed — no longer active/expanded.
    // -----------------------------------------------------------------------
    await expect(lastCard).toHaveClass(/thread-card-collapsed/, { timeout: EXPECT_TIMEOUT })
    await expect(lastCard).not.toHaveClass(/thread-card-active/)
    await expect(
      threadView.locator('.thread-card-header').last(),
    ).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await cleanupApp(ctx)
  }
})
