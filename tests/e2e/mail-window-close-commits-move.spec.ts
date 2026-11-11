/**
 * The deferred Archive/Delete in the standalone message window (MailWindow)
 * must survive the WINDOW closing, not just React unmounting: React's cleanup
 * runs on unmount, and a closing window does not unmount anything.
 *
 * This spec is the only place that tests the real thing. The jsdom suites
 * (`src/windows/MailWindow.test.tsx`, `src/hooks/useUndoSystem.test.ts`) pin
 * the wiring against synthetic events; they cannot say what a real Electron
 * window does on its way out.
 *
 * What the first run of this spec established, and what the code now relies
 * on: a RENDERER-initiated close is not the same path as
 * `BrowserWindow.close()`. Electron documents the DOM unload sequence only for
 * the latter (electron.d.ts, BrowserWindow 'close': "emitted before the
 * `beforeunload` and `unload` event of the DOM"); the renderer-side form is
 * "closes the page, as if the web content had called `window.close()`", with
 * `beforeunload` skipped unless `CloseOpts.waitForBeforeUnload` asks for it.
 * Closing the page with `window.close()` here left the message in INBOX on two
 * consecutive runs, so the window no longer defers its commit to the unload
 * sequence: the titlebar Close button flushes first and closes after. The
 * `pagehide` listener stays as a backstop for teardowns this window does not
 * originate.
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, waitForPage, CLOSE_TIMEOUT, EXPECT_TIMEOUT, type AppContext } from './helpers'

/**
 * Everything between the Delete click and the Close click has to fit inside
 * the window's undo budget (`UNDO_WINDOW_MS` = 3000 in
 * `src/windows/MailWindow.tsx`). Otherwise the 3s timer commits the move by
 * itself, Trash fills up for a reason that has nothing to do with closing, and
 * this spec passes on a build without the fix.
 *
 * 2000 ms is the guard, not the expectation: the sequence takes ~200 ms, so
 * there is an order of magnitude of headroom, and a machine slow enough to
 * blow through it has made the run inconclusive rather than green.
 */
const CLOSE_MUST_HAPPEN_WITHIN_MS = 2000

test('mail window: Delete then immediately closing the window still moves the message to Trash', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // A message NOT part of the thread fixture, so its subject is unambiguous
    // in both INBOX and Trash.
    const subject = 'E2E1: первое письмо'
    const row = page.getByTestId('mail-item').filter({ hasText: subject }).first()
    await clickMailItem(row)
    await expect(page.getByTestId('mail-subject')).toHaveText(subject)

    // Open it in its own standalone window (same button
    // standalone-window-lifecycle.spec.ts uses).
    const openBtn = page.getByTestId('mail-action-open-in-window')
    await expect(openBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await openBtn.click()
    const mailWindow = await waitForPage(browser, p => p.url().includes('#/mail-window'))
    await mailWindow.waitForLoadState('domcontentloaded')
    // MailWindow has no `mail-subject` testid of its own (unlike the main
    // window's reading pane) — it renders the subject in `.mail-viewer-subject`.
    await expect(mailWindow.locator('.mail-viewer-subject')).toHaveText(subject, { timeout: EXPECT_TIMEOUT })

    // Delete starts the 3s deferred-commit timer and shows the undo banner —
    // net:move has NOT fired yet.
    //
    // The button stays disabled until the window knows this account's folder
    // roles: without a Trash role, Delete means PERMANENT deletion behind a
    // confirm dialog, and there would be no deferred move to test. Under e2e
    // the roles never reach `cached_roles` (main's E2E branch of
    // `computeMailboxesAndRoles` returns before `cacheFolderRoles`), so this
    // window gets them from `net:mailboxesAndRoles` — the same authoritative
    // channel the main window uses. Waiting for `toBeEnabled` is what makes
    // that visible as "roles arrived" instead of as a mystery timeout.
    const deleteBtn = mailWindow.getByTestId('toolbar-delete')
    await expect(deleteBtn).toBeEnabled({ timeout: EXPECT_TIMEOUT })
    const deleteClickedAt = Date.now()
    await deleteBtn.click()
    // Guard with a clear failure: if roles were missing, this window would show
    // the permanent-delete confirmation instead of the undo banner.
    await expect(mailWindow.getByTestId('confirm-permanent-delete-overlay')).toHaveCount(0)
    await expect(mailWindow.getByTestId('undo-banner')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Close the window well within the 3s undo window — no click on Undo, no
    // wait for the timer — through the button the user actually presses. The
    // titlebar Close button is the only way out of this frameless window, and
    // the path matters: the first run of this spec closed the page with a bare
    // `window.close()` and the message stayed on the server (see the
    // `handleTitlebarClose` comment in MailWindow.tsx).
    //
    // The rejection is swallowed the way marketing.gallery.spec.ts swallows it
    // for Compose: the click destroys the page it was performed on, so
    // Playwright's post-click bookkeeping can lose its target. The assertion
    // that the close really happened is the poll below, not the click.
    await mailWindow.getByTestId('window-titlebar-close').click().catch(() => {})
    // The commit happens inside that click's handler, so this is the number
    // that decides whether the run means anything: if the Close came later
    // than the undo budget, the 3s timer may have issued the move and the
    // assertions below would hold on an unfixed build too.
    const closeRequestedAfterMs = Date.now() - deleteClickedAt
    expect(
      closeRequestedAfterMs,
      'inconclusive run: the window was closed after the undo window had already elapsed, so the 3s timer — not the close — could have issued the move',
    ).toBeLessThan(CLOSE_MUST_HAPPEN_WITHIN_MS)
    await expect.poll(() => mailWindow.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // The move already happened in the main process — it does not need a
    // live push to the main window, only a fresh list request, exactly like
    // the archive/delete assertions in mail.flows.spec.ts's own flow test.
    await page.getByTestId('folder-Trash').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: subject }).first())
      .toBeVisible({ timeout: EXPECT_TIMEOUT })

    await page.getByTestId('folder-INBOX').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: subject })).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})
