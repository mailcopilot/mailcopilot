import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, clickMailItem, CLOSE_TIMEOUT, type AppContext } from './helpers'

// A reply saved as a draft and reopened from the Drafts folder must still answer
// its parent: main writes In-Reply-To / References into the saved draft from the
// pointer the compose window sends, and restores the pointer when the draft is
// reopened. The e2e fixture records what a send would put on the wire into Sent.

const PARENT_ID = '<e2e-reply-draft-parent-9702@example.test>'

async function sentRow(page: import('@playwright/test').Page, subject: string) {
  return page.evaluate(async (subj) => {
    const rows = await window.api.invoke('net:folderPage', 1, 'Sent', 50, undefined) as Array<{
      subject: string; inReplyTo?: string; references?: string
    }>
    return rows.find(r => r.subject === subj) ?? null
  }, subject)
}

test('reply draft: reopened from Drafts and sent, the reply still carries In-Reply-To and References', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    const parentSubject = `E2E draft-threading parent ${Date.now()}`
    await page.evaluate(async ({ subject, messageId }) => {
      await window.api.invoke('e2e:injectMail', {
        accountId: 1, folder: 'INBOX', uid: 9702,
        from: 'alice@example.test', to: 'e2e1@example.test',
        subject, date: new Date().toISOString(), unread: true, flagged: false,
        text: 'Parent of the reply draft.', messageId,
      })
    }, { subject: parentSubject, messageId: PARENT_ID })

    const parent = page.getByTestId('mail-item').filter({ hasText: parentSubject }).first()
    await expect(parent).toBeVisible()
    await clickMailItem(parent)
    await page.getByTestId('mail-action-reply').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    compose.on('dialog', d => d.accept())
    await expect(compose.getByTestId('compose-to')).toHaveValue('alice@example.test')
    const replySubject = `Re: E2E draft-threading reply ${Date.now()}`
    await compose.getByTestId('compose-subject').fill(replySubject)
    await compose.getByTestId('compose-text').fill('Draft of my reply')
    // Wait for the draft sync debounce (1500 ms), then close the window without sending.
    await compose.waitForTimeout(1800)
    await expect(compose.getByTestId('compose-status')).toBeVisible()
    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    await page.getByTestId('sidebar-sync').click()
    await page.getByTestId('folder-Drafts').click()
    const draft = page.getByTestId('mail-item').filter({ hasText: replySubject }).first()
    await expect(draft).toBeVisible()
    await clickMailItem(draft)
    await page.getByTestId('mail-action-edit-draft').click()
    const reopened = await waitForPage(browser, p => p.url().includes('#/compose'))
    await reopened.waitForLoadState('domcontentloaded')
    reopened.on('dialog', d => d.accept())
    await expect(reopened.getByTestId('compose-subject')).toHaveValue(replySubject)
    await reopened.getByTestId('compose-send').click()
    await expect.poll(() => reopened.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    await expect.poll(async () => (await sentRow(page, replySubject))?.inReplyTo).toBe(PARENT_ID)
    expect((await sentRow(page, replySubject))?.references).toBe(PARENT_ID)
  } finally {
    await cleanupApp(ctx)
  }
})
