import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, clickMailItem, CLOSE_TIMEOUT, type AppContext } from './helpers'

// =============================================================================
// Test 1: Unified Inbox + Search + Filters
// =============================================================================

test('flows: unified inbox + search + filters', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // --- Unified Inbox ---
    await page.getByTestId('folder-unified').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()).toBeVisible()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E2: первое письмо' }).first()).toBeVisible()

    // Quick jump to the source account/folder via sidebar account click.
    const acc2Mail = page.getByTestId('mail-item').filter({ hasText: 'E2E2: первое письмо' }).first()
    await clickMailItem(acc2Mail)
    await expect(page.getByTestId('mail-action-open-in-account')).toBeVisible()
    await page.getByTestId('mail-action-open-in-account').click()
    await expect(page.locator('.mail-list-account')).toContainText('E2E Two')

    // Return to account 1 for the remaining scenario.
    await page.getByTestId('account-1').click()
    await expect(page.locator('.mail-list-account')).toContainText('E2E One')
    await page.getByTestId('folder-INBOX').click()
    await expect(page.getByTestId('mail-item').first()).toBeVisible()

    // --- Search ---
    await page.getByTestId('search-input').fill('flagged')
    await page.getByTestId('search-input').press('Enter')
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: flagged письмо' }).first()).toBeVisible()

    // Clear search back to normal sync.
    await page.getByTestId('search-input').fill('')
    await page.getByTestId('search-input').press('Enter')
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()).toBeVisible()

    // --- Filters (chip buttons) ---
    await page.getByTestId('filter-unread').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()).toBeVisible()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' })).toHaveCount(0)

    // Toggle off unread, toggle on flagged
    await page.getByTestId('filter-unread').click()
    await page.getByTestId('filter-flagged').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: flagged письмо' }).first()).toBeVisible()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' })).toHaveCount(0)

    // Toggle off flagged -> all
    await page.getByTestId('filter-flagged').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' }).first()).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 2: Reply + Reply All + Forward
// =============================================================================

test('flows: reply + reply-all + forward', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    const baseMail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await clickMailItem(baseMail)
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    await expect(page.getByTestId('mail-body-text')).toBeVisible()

    // Reply
    await page.getByTestId('mail-action-reply').click()
    const replyCompose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await replyCompose.waitForLoadState('domcontentloaded')
    // Auto-accept misdirection warnings (window.confirm) in compose child window
    replyCompose.on('dialog', d => d.accept())
    await expect(replyCompose.getByTestId('compose-to')).toHaveValue('alice@example.test')
    await expect(replyCompose.getByTestId('compose-subject')).toHaveValue(/^Re:/)
    // Regression: prefilled fields should not "flash then clear".
    // Wait for async effects to settle, then verify stability.
    await replyCompose.waitForTimeout(2000)
    await expect(replyCompose.getByTestId('compose-to')).toHaveValue('alice@example.test')
    await expect(replyCompose.getByTestId('compose-subject')).toHaveValue(/^Re:/)
    await replyCompose.getByTestId('compose-to').fill('test2@example.com')
    await replyCompose.getByTestId('compose-cc-toggle').click()
    await replyCompose.getByTestId('compose-cc').fill('test1@example.com')
    const replySubject = `E2E reply ${Date.now()}`
    await replyCompose.getByTestId('compose-subject').fill(replySubject)
    await replyCompose.getByTestId('compose-send').click()
    await expect.poll(() => replyCompose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Sent should contain our reply.
    await page.getByTestId('folder-Sent').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: replySubject }).first()).toBeVisible()
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: replySubject }).first())
    await expect(page.getByTestId('mail-subject')).toHaveText(replySubject)

    // Reply All (checks computed CC from envelope.to + envelope.cc)
    await page.getByTestId('folder-INBOX').click()
    await expect(baseMail).toBeVisible()
    await clickMailItem(baseMail)
    await expect(page.getByTestId('mail-body-text')).toBeVisible()
    await page.getByTestId('mail-action-reply-all').click()
    const replyAllCompose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await replyAllCompose.waitForLoadState('domcontentloaded')
    replyAllCompose.on('dialog', d => d.accept())
    await expect(replyAllCompose.getByTestId('compose-to')).toHaveValue('alice@example.test')
    await expect(replyAllCompose.getByTestId('compose-cc')).toHaveValue(/bob@example\.test/)
    await expect(replyAllCompose.getByTestId('compose-cc')).toHaveValue(/carol@example\.test/)
    await replyAllCompose.waitForTimeout(2000)
    await expect(replyAllCompose.getByTestId('compose-to')).toHaveValue('alice@example.test')
    await replyAllCompose.getByTestId('compose-to').fill('test2@example.com')
    await replyAllCompose.getByTestId('compose-cc').fill('test1@example.com')
    const replyAllSubject = `E2E reply-all ${Date.now()}`
    await replyAllCompose.getByTestId('compose-subject').fill(replyAllSubject)
    await replyAllCompose.getByTestId('compose-send').click()
    await expect.poll(() => replyAllCompose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Forward
    await page.getByTestId('folder-INBOX').click()
    await clickMailItem(baseMail)
    await expect(page.getByTestId('mail-body-text')).toBeVisible()
    await page.getByTestId('mail-action-forward').click()
    const forwardCompose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await forwardCompose.waitForLoadState('domcontentloaded')
    forwardCompose.on('dialog', d => d.accept())
    await expect(forwardCompose.getByTestId('compose-subject')).toHaveValue(/^Fwd:/)
    await expect(forwardCompose.getByTestId('compose-text')).toHaveValue(/-{5,}/)
    await forwardCompose.waitForTimeout(2000)
    await expect(forwardCompose.getByTestId('compose-subject')).toHaveValue(/^Fwd:/)
    await forwardCompose.getByTestId('compose-to').fill('test2@example.com')
    await forwardCompose.getByTestId('compose-cc-toggle').click()
    await forwardCompose.getByTestId('compose-cc').fill('test1@example.com')
    const forwardSubject = `E2E forward ${Date.now()}`
    await forwardCompose.getByTestId('compose-subject').fill(forwardSubject)
    await forwardCompose.getByTestId('compose-send').click()
    await expect.poll(() => forwardCompose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 3: Draft sync + restore + send
// =============================================================================

test('flows: draft sync + restore + send', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('sidebar-compose').click()
    const draftCompose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await draftCompose.waitForLoadState('domcontentloaded')
    draftCompose.on('dialog', d => d.accept())
    await draftCompose.getByTestId('compose-to').fill('test2@example.com')
    await draftCompose.getByTestId('compose-cc-toggle').click()
    await draftCompose.getByTestId('compose-cc').fill('test1@example.com')
    const draftSubject = `E2E draft ${Date.now()}`
    await draftCompose.getByTestId('compose-subject').fill(draftSubject)
    await draftCompose.getByTestId('compose-text').fill('E2E draft body')
    // Wait for IMAP draft sync debounce (1500ms).
    await draftCompose.waitForTimeout(1800)
    await expect(draftCompose.getByTestId('compose-status')).toBeVisible()
    await draftCompose.evaluate(() => window.close())
    await expect.poll(() => draftCompose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Sync and navigate to Drafts.
    await page.getByTestId('sidebar-sync').click()
    await page.getByTestId('folder-Drafts').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: draftSubject }).first()).toBeVisible()
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: draftSubject }).first())
    // Draft opens in reading pane, click the button to edit.
    await expect(page.getByTestId('mail-subject')).toHaveText(draftSubject)
    await expect(page.getByTestId('mail-action-edit-draft')).toBeVisible()
    // Reply/Forward should not be displayed for drafts.
    await expect(page.getByTestId('mail-action-reply')).toHaveCount(0)
    await page.getByTestId('mail-action-edit-draft').click()
    const restoredDraft = await waitForPage(browser, p => p.url().includes('#/compose'))
    await restoredDraft.waitForLoadState('domcontentloaded')
    restoredDraft.on('dialog', d => d.accept())
    await expect(restoredDraft.getByTestId('compose-to')).toHaveValue('test2@example.com')
    await expect(restoredDraft.getByTestId('compose-cc')).toHaveValue('test1@example.com')
    await expect(restoredDraft.getByTestId('compose-subject')).toHaveValue(draftSubject)
    await restoredDraft.getByTestId('compose-send').click()
    await expect.poll(() => restoredDraft.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Draft sent — folder should be empty after sync.
    await page.getByTestId('sidebar-sync').click()
    await page.getByTestId('folder-Drafts').click()
    await expect(page.getByTestId('mail-item')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 4: Archive + Spam + Delete + Delete forever
// =============================================================================

test('flows: archive + spam + delete + delete-forever', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Archive flagged message -> Archive
    const flagged = page.getByTestId('mail-item').filter({ hasText: 'E2E1: flagged письмо' }).first()
    await clickMailItem(flagged)
    await page.getByTestId('mail-action-archive').click()
    await expect(flagged).toHaveCount(0)
    await page.getByTestId('folder-Archive').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: flagged письмо' }).first()).toBeVisible()

    // Spam second message -> Junk
    await page.getByTestId('folder-INBOX').click()
    const second = page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' }).first()
    await clickMailItem(second)
    await page.getByTestId('mail-action-spam').click()
    await expect(second).toHaveCount(0)
    await page.getByTestId('folder-Junk').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' }).first()).toBeVisible()

    // Delete first message -> Trash, then delete forever in Trash.
    await page.getByTestId('folder-INBOX').click()
    const first = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await clickMailItem(first)
    await page.getByTestId('mail-action-delete').click()
    await expect(first).toHaveCount(0)
    await page.getByTestId('folder-Trash').click()
    const inTrash = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(inTrash).toBeVisible()
    await clickMailItem(inTrash)
    await page.getByTestId('mail-action-delete').click()
    // Deleting from trash requires confirmation
    await page.getByTestId('confirm-delete-yes').click()
    await expect(inTrash).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})
