/**
 * §3.3.C-thread.4 — keyboard navigation inside an open conversation, end to
 * end. `packages/core/threadKeyboard.test.ts` pins the pure grammar,
 * `src/hooks/useThreadKeyboard.test.ts` pins the cursor mechanics, and
 * `src/components/ThreadView.test.tsx` pins the wiring with a mocked
 * `onCardAction`. None of those mount a real Electron IPC round trip: this
 * spec is the one place that proves a real keystroke on a real card reaches
 * real `ui:openCompose` and opens a real Compose window scoped to the card
 * the CURSOR sat on, not the card that happened to be open.
 *
 * Fixture: account 1 INBOX carries a two-message thread under the grouped
 * subject `E2E1: thread root` (see electron/main.ts E2E fixtures). Cards
 * render newest-top by default, so index 0 is the reply, index 1 is the root.
 * Opening the thread row activates the root (index 1) — the same starting
 * point `ui.extra.spec.ts`'s conversation-view test uses.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, clickMailItem, CLOSE_TIMEOUT, EXPECT_TIMEOUT, type AppContext } from './helpers'

async function openThread(page: Page) {
  const threadRow = page.getByTestId('mail-item').filter({ hasText: 'E2E1: thread root' }).first()
  await clickMailItem(threadRow)
  await expect(page.getByTestId('mail-subject')).toHaveText('E2E1: thread root')
  const cards = page.getByTestId('thread-card')
  await expect(cards).toHaveCount(2)
  return cards
}

test('thread keyboard: j/k move the cursor between cards without opening them', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const cards = await openThread(page)

    // Root (index 1) is active; no cursor placed yet.
    await expect(cards.nth(0)).not.toHaveAttribute('data-focused')
    await expect(cards.nth(1)).not.toHaveAttribute('data-focused')

    // k walks the cursor up to the reply card (index 0) — it must NOT open it
    // (that is Enter's job) and must NOT move the message list behind it.
    await page.keyboard.press('k')
    await expect(cards.nth(0)).toHaveAttribute('data-focused', 'true')
    await expect(cards.nth(1)).not.toHaveAttribute('data-focused')
    await expect(page.getByTestId('mail-subject')).toHaveText('E2E1: thread root')

    // j walks it back down to the root card.
    await page.keyboard.press('j')
    await expect(cards.nth(1)).toHaveAttribute('data-focused', 'true')
    await expect(cards.nth(0)).not.toHaveAttribute('data-focused')
  } finally {
    await cleanupApp(ctx)
  }
})

test('thread keyboard: Enter on the focused card opens it, not the active one', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const cards = await openThread(page)

    // Move the cursor onto the reply card (collapsed, not active) without
    // opening it.
    await page.keyboard.press('k')
    await expect(cards.nth(0)).toHaveAttribute('data-focused', 'true')
    await expect(page.getByTestId('mail-subject')).toHaveText('E2E1: thread root')

    // Enter raises exactly the card under the cursor.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('mail-subject')).toHaveText('Re: E2E1: thread root')
    await expect(cards.nth(0)).toHaveClass(/thread-card-active/)
    await expect(cards.nth(0)).toHaveClass(/thread-card-expanded/)
  } finally {
    await cleanupApp(ctx)
  }
})

test('thread keyboard: r on the focused card opens Compose scoped to that card, not the open message', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!
    const cards = await openThread(page)

    // Cursor on the reply card (index 0); the ACTIVE/open card is still the
    // root (index 1) — nobody clicked or Entered the reply card.
    await page.keyboard.press('k')
    await expect(cards.nth(0)).toHaveAttribute('data-focused', 'true')
    await expect(page.getByTestId('mail-subject')).toHaveText('E2E1: thread root')

    await page.keyboard.press('r')
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    // The quoted body proves WHICH message was replied to: the reply card's
    // own text ("Thread reply message"), not the root's ("Thread root
    // message") — the two fixture bodies are deliberately distinct so a
    // wiring bug that targets the open message instead of the focused one
    // shows up here, not just in the mocked component test.
    await expect(compose.getByTestId('compose-text')).toHaveValue(/Thread reply message/)
    await expect(compose.getByTestId('compose-text')).not.toHaveValue(/Thread root message/)

    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('thread keyboard: Escape drops the cursor and hands j/k back to the message list', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const cards = await openThread(page)

    await page.keyboard.press('k')
    await expect(cards.nth(0)).toHaveAttribute('data-focused', 'true')

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('thread-view').locator('[data-focused]')).toHaveCount(0)

    // With no cursor left inside the thread, the keystroke must move the
    // MESSAGE LIST — off the thread's own subject entirely, the same
    // regression the `k`-after-Escape assertion in ui.extra.spec.ts guards
    // from the other direction (list "stuck" on a non-lead thread message).
    //
    // The direction is `k`, not `j`, and that is a property of the fixture,
    // not a preference: account 1's INBOX is ordered uid DESC and the thread
    // carries the two lowest uids (89 / 88), so its row is the LAST one.
    // `j` there is a no-op by design — `useKeyboardShortcuts` returns without
    // moving when the next index equals the current one — and asserting on it
    // would test the clamp, not the handover.
    await page.keyboard.press('k')
    await expect(page.getByTestId('mail-subject')).not.toHaveText('E2E1: thread root', { timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-subject')).not.toHaveText('Re: E2E1: thread root', { timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

test('thread keyboard: Escape works before the cursor was ever placed', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const cards = await openThread(page)

    // Nothing focused inside the stack yet — and the cards already own j / k,
    // so the way out has to work from here. Requiring a cursor first meant the
    // user had to go IN (press j) before being allowed OUT.
    await expect(cards.nth(0)).not.toHaveAttribute('data-focused')
    await expect(cards.nth(1)).not.toHaveAttribute('data-focused')

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('thread-view').locator('[data-focused]')).toHaveCount(0)

    // `k` (not `j` — the thread row is the last one, see the test above) now
    // belongs to the message list again.
    await page.keyboard.press('k')
    await expect(page.getByTestId('mail-subject')).not.toHaveText('E2E1: thread root', { timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-subject')).not.toHaveText('Re: E2E1: thread root', { timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})
