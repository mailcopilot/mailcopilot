import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, clickMailItem, CLOSE_TIMEOUT, type AppContext } from './helpers'

// A reply must reach the server with In-Reply-To / References (RFC 5322
// §3.6.4). The renderer only points at the parent; main derives both headers
// from its own copy of the parent's Message-ID. The e2e fixture records what
// the send path would have put on the wire into the Sent box.

const PARENT_ID = '<e2e-reply-parent-9701@example.test>'

async function sentRow(page: import('@playwright/test').Page, subject: string) {
  return page.evaluate(async (subj) => {
    const rows = await window.api.invoke('net:folderPage', 1, 'Sent', 50, undefined) as Array<{
      subject: string; inReplyTo?: string; references?: string
    }>
    return rows.find(r => r.subject === subj) ?? null
  }, subject)
}

test('reply: sent message carries In-Reply-To and References of its parent', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    const parentSubject = `E2E threading parent ${Date.now()}`
    await page.evaluate(async ({ subject, messageId }) => {
      await window.api.invoke('e2e:injectMail', {
        accountId: 1, folder: 'INBOX', uid: 9701,
        from: 'alice@example.test', to: 'e2e1@example.test',
        subject, date: new Date().toISOString(), unread: true, flagged: false,
        text: 'Parent of the reply.', messageId,
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
    const replySubject = `Re: E2E threading reply ${Date.now()}`
    await compose.getByTestId('compose-subject').fill(replySubject)
    await compose.getByTestId('compose-send').click()
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    await expect.poll(async () => (await sentRow(page, replySubject))?.inReplyTo).toBe(PARENT_ID)
    expect((await sentRow(page, replySubject))?.references).toBe(PARENT_ID)
  } finally {
    await cleanupApp(ctx)
  }
})
