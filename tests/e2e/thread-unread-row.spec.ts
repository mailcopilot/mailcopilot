/**
 * E2E spec — a conversation row is unread when ANY message inside it is unread,
 * and clicking it opens the oldest unread message (Thunderbird model).
 *
 * Regression this locks down: folder / account / tray counters count MESSAGES
 * (packages/db listFolderStats + countUnreadByFolder), while the list used to
 * bold a row from `row.lead.unread` alone. A thread whose newest message is
 * read but which still holds an older unread one was therefore counted by the
 * badge and rendered as read — and clicking it opened the already-read lead,
 * so ordinary reading could never clear the badge. Reproduced on a live cache
 * (account popovss@mai.ru, INBOX: unread uid 145191 under read lead 146153).
 *
 * The e2e fixture in main.ts seeds account 1 INBOX with one unread message
 * ("E2E1: первое письмо", badge = 1) plus a read 2-message thread
 * (uid=89 "E2E1: thread root", 00:40 — the list lead, since the e2e list is
 * UID-descending; uid=88 "Re: E2E1: thread root", 00:41). The scenario marks
 * that thread unread through the bulk action, then reads it message by
 * message, which is exactly the shape of the bug: after the first open the
 * lead is read while an unread message remains inside.
 */
import { test, expect } from '@playwright/test'
import {
  launchApp,
  cleanupApp,
  clickMailItem,
  EXPECT_TIMEOUT,
  type AppContext,
} from './helpers'

test('mail list: row is unread while any message inside the thread is unread', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-thread-unread-'))
    const page = ctx.page!

    const threadRow = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    const inboxBadge = page.getByTestId('folder-badge-INBOX')

    // -----------------------------------------------------------------------
    // 1. Baseline: one unread message in INBOX, the thread is fully read.
    // -----------------------------------------------------------------------
    await expect(inboxBadge).toHaveText('1', { timeout: EXPECT_TIMEOUT })
    await expect(threadRow).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(threadRow).not.toHaveClass(/mail-unread/)

    // -----------------------------------------------------------------------
    // 2. Ctrl-click selects the row without opening it; the bulk "mark unread"
    //    expands to the whole thread (expandBulkToThreads) → both messages
    //    unread → badge 1 + 2 = 3, row bold.
    // -----------------------------------------------------------------------
    await threadRow.click({ modifiers: ['Control'] })
    await page.getByTestId('bulk-mark-unread').click()

    await expect(inboxBadge).toHaveText('3', { timeout: EXPECT_TIMEOUT })
    await expect(threadRow).toHaveClass(/mail-unread/)

    // -----------------------------------------------------------------------
    // 3. Open the row. Both messages are unread, so the oldest one wins — that
    //    is uid=89 "thread root" (00:40). Opening auto-marks only that message
    //    read: badge 3 → 2, and the row MUST STAY BOLD because the reply
    //    (uid=88) is still unread. This is the assertion the old
    //    `row.lead.unread` rendering failed.
    // -----------------------------------------------------------------------
    await clickMailItem(threadRow)

    await expect(page.getByTestId('mail-subject')).toHaveText(/thread root/i, { timeout: EXPECT_TIMEOUT })
    // Not the reply: "E2E1: thread root" carries no "re:" substring.
    await expect(page.getByTestId('mail-subject')).not.toHaveText(/re:/i)
    await expect(inboxBadge).toHaveText('2', { timeout: EXPECT_TIMEOUT })
    await expect(threadRow).toHaveClass(/mail-unread/)

    // Nothing was bulk-marked behind the user's back: the thread still has an
    // unread message, so the thread-level "mark all read" button is offered.
    await expect(page.getByTestId('mail-action-mark-thread-read')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // -----------------------------------------------------------------------
    // 4. Click the same row again. The lead is read now, so the click must
    //    land on the remaining unread message — the reply (uid=88) — instead
    //    of reopening the lead. Reading it clears the row and the counter.
    // -----------------------------------------------------------------------
    await clickMailItem(threadRow)

    await expect(page.getByTestId('mail-subject')).toHaveText(/re:.*thread root/i, { timeout: EXPECT_TIMEOUT })
    await expect(inboxBadge).toHaveText('1', { timeout: EXPECT_TIMEOUT })
    await expect(threadRow).not.toHaveClass(/mail-unread/)

    // The whole thread is read again → the bulk button disappears.
    await expect(page.getByTestId('mail-action-mark-thread-read')).toHaveCount(0)

    // -----------------------------------------------------------------------
    // 5. A fully-read thread still opens its lead, exactly as before.
    // -----------------------------------------------------------------------
    await clickMailItem(threadRow)
    await expect(page.getByTestId('mail-subject')).toHaveText(/thread root/i, { timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-subject')).not.toHaveText(/re:/i)
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * Regression for the Shift-click anchor: `onMailClick` opens
 * `pickThreadOpenTarget(row)`, which for a thread with an unread reply is a
 * MID-thread message — not a row lead — and opening anchors on the message it
 * opened. The Shift range is walked over the row-lead list (`viewMailsRef`), so
 * the anchor is mapped onto its row lead lazily, in this very click, where the
 * rows certainly exist. Without that mapping `findIndex(anchor)` returns -1, the
 * range degrades to a single selection and the previously-selected thread row is
 * silently dropped.
 */
test('mail list: Shift-click range selection survives opening a mid-thread reply', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-thread-shift-'))
    const page = ctx.page!

    const threadRow = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    // "html" appears only in the html-email fixture subject (EN and RU), and
    // that row sits immediately above the thread row in the uid-descending
    // e2e fixture list (see electron/main.ts buildE2EBoxes).
    const htmlRow = page
      .getByTestId('mail-item')
      .filter({ hasText: /html/i })
      .first()

    await expect(threadRow).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(htmlRow).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Mark the thread unread so both its messages are unread — the shape
    // that makes the second click below land on the reply, not the lead.
    await threadRow.click({ modifiers: ['Control'] })
    await page.getByTestId('bulk-mark-unread').click()
    await expect(threadRow).toHaveClass(/mail-unread/)

    // First click opens the oldest unread message, which happens to be the
    // lead ("thread root") — this click alone would anchor correctly even
    // without the fix, so it does not yet exercise the bug.
    await clickMailItem(threadRow)
    await expect(page.getByTestId('mail-subject')).toHaveText(/thread root/i, { timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-subject')).not.toHaveText(/re:/i)

    // Second click opens the reply — the only remaining unread message, and
    // NOT a row lead. This is the click whose anchor `rowLeadKeyFor` has to
    // map back onto the row lead.
    await clickMailItem(threadRow)
    await expect(page.getByTestId('mail-subject')).toHaveText(/re:.*thread root/i, { timeout: EXPECT_TIMEOUT })

    // Shift-click the adjacent row. With the anchor keyed on the thread row's
    // lead, this selects BOTH rows (a 2-row range). Without the fix,
    // findIndex(anchor) returns -1, the code degrades to selecting only the
    // clicked row, and the thread row's `mail-selected` class disappears.
    await htmlRow.click({ modifiers: ['Shift'] })

    await expect(threadRow).toHaveClass(/mail-selected/, { timeout: EXPECT_TIMEOUT })
    await expect(htmlRow).toHaveClass(/mail-selected/, { timeout: EXPECT_TIMEOUT })
    await expect(page.locator('[data-testid="mail-item"].mail-selected')).toHaveCount(2)
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * Sibling regression to the Shift-click test above, but for Ctrl-click. Opening
 * leaves the reply's OWN key in `selectedKeys` — selection stands for the row,
 * whichever message of it carries the key. Ctrl-click therefore toggles the
 * whole ROW (`toggleRowSelection`): every key of the row goes out. Toggling the
 * lead key alone would ADD it next to the reply's key instead of clearing the
 * selection — the row would stay visually selected and the bulk-action button
 * enabled after what looks like a deselect click.
 */
test('mail list: Ctrl-click deselects the row after opening a mid-thread reply', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-thread-ctrlclick-'))
    const page = ctx.page!

    const threadRow = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    const bulkMarkUnread = page.getByTestId('bulk-mark-unread')

    await expect(threadRow).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Mark the thread unread so both messages are unread — the shape that
    // makes the second open below land on the reply, not the lead.
    await threadRow.click({ modifiers: ['Control'] })
    await bulkMarkUnread.click()
    // The Ctrl-click above selected the row for the bulk action; undo that so
    // the test starts from a clean, unselected state before opening.
    await threadRow.click({ modifiers: ['Control'] })
    await expect(page.locator('[data-testid="mail-item"].mail-selected')).toHaveCount(0)

    // First click opens the oldest unread message — the lead.
    await clickMailItem(threadRow)
    await expect(page.getByTestId('mail-subject')).not.toHaveText(/re:/i)
    // Second click opens the only remaining unread message — the reply, a
    // non-lead message.
    await clickMailItem(threadRow)
    await expect(page.getByTestId('mail-subject')).toHaveText(/re:.*thread root/i, { timeout: EXPECT_TIMEOUT })

    // The row highlight comes from `selectedKeys` alongside the open, and
    // Ctrl-clicking the SAME row must clear it, not add to it.
    await threadRow.click({ modifiers: ['Control'] })

    await expect(threadRow).not.toHaveClass(/mail-selected/)
    await expect(page.locator('[data-testid="mail-item"].mail-selected')).toHaveCount(0)
    await expect(bulkMarkUnread).toBeDisabled()
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * Second entry point into `openMail`: a card inside an already-open
 * `ThreadView` calls `onCardOpen(item)` directly (App.tsx), bypassing the list's
 * `onMailClick` entirely. It is the entry point that makes "the selection may
 * hold any message of the row" ordinary rather than exotic, and the row toggle
 * has to absorb it exactly as it absorbs the list path — this is the gap the
 * codex test-coverage review flagged.
 */
test('mail list: opening a reply via a ThreadView card also anchors selection on the row lead', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-thread-cardopen-'))
    const page = ctx.page!

    const threadRow = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()

    await expect(threadRow).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Mark the thread unread, then deselect the Ctrl-click artifact.
    await threadRow.click({ modifiers: ['Control'] })
    await page.getByTestId('bulk-mark-unread').click()
    await threadRow.click({ modifiers: ['Control'] })
    await expect(page.locator('[data-testid="mail-item"].mail-selected')).toHaveCount(0)

    // Open the thread through the LIST entry point — lands on the lead
    // (oldest unread) and switches the viewer into ThreadView (count > 1).
    await clickMailItem(threadRow)
    await expect(page.getByTestId('mail-subject')).not.toHaveText(/re:/i)
    await expect(page.getByTestId('thread-view')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Open the reply through the THREADVIEW CARD entry point instead of the
    // list row: the collapsed, non-active card's header click calls
    // `onCardOpen`, not `onMailClick`.
    const replyCard = page.getByTestId('thread-card').filter({ hasText: /re:/i })
    await replyCard.locator('.thread-card-header').click()
    await expect(page.getByTestId('mail-subject')).toHaveText(/re:.*thread root/i, { timeout: EXPECT_TIMEOUT })

    // The list's Ctrl-click toggles the whole row (see the sibling Ctrl-click
    // test above), so it clears the selection the card open left on the reply's
    // own key — which is the point: no key of the row may survive.
    await threadRow.click({ modifiers: ['Control'] })

    await expect(threadRow).not.toHaveClass(/mail-selected/)
    await expect(page.locator('[data-testid="mail-item"].mail-selected')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * Regression for the auto-advance lookup in `removeManyFromUi`: `viewMailsRef`
 * holds row LEADS only, while `active` is routinely a mid-thread message once
 * a bold row has been opened once (oldest-unread-first) and clicked again
 * (next-unread). Archiving from here removes the WHOLE thread (Archive is
 * thread-scoped once `activeThread.count > 1`) while `active` is still the
 * reply — a non-lead message. Without indexing through `rowLeadKeyFor`,
 * `findIndex` on the lead-only list never finds it, `activeIdx` stays -1, and
 * `findNextAfterRemoval` bails out immediately, ejecting the user to the empty
 * "select a message" state instead of auto-advancing.
 */
test('mail list: archiving while a mid-thread reply is active auto-advances instead of clearing the viewer', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-thread-archive-'))
    const page = ctx.page!

    const threadRow = page
      .getByTestId('mail-item')
      .filter({ hasText: /thread root/i })
      .first()
    // The html-email fixture sits immediately above the thread row in the
    // uid-descending e2e list (see electron/main.ts buildE2EBoxes) — the
    // default autoAdvance='older' has no row below the (last) thread row, so
    // it must fall back to this one above it.
    const htmlRow = page
      .getByTestId('mail-item')
      .filter({ hasText: /html/i })
      .first()

    await expect(threadRow).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(htmlRow).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Mark the thread unread so both messages are unread, then deselect the
    // Ctrl-click artifact before opening.
    await threadRow.click({ modifiers: ['Control'] })
    await page.getByTestId('bulk-mark-unread').click()
    await threadRow.click({ modifiers: ['Control'] })

    // First click opens the lead; second opens the reply — a non-lead message
    // that stays `active` through the archive below.
    await clickMailItem(threadRow)
    await clickMailItem(threadRow)
    await expect(page.getByTestId('mail-subject')).toHaveText(/re:.*thread root/i, { timeout: EXPECT_TIMEOUT })

    await page.getByTestId('mail-action-archive').click()

    await expect(threadRow).toHaveCount(0)
    await expect(page.locator('.empty-state')).toHaveCount(0)
    await expect(page.getByTestId('mail-subject')).toHaveText(/html/i, { timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})
