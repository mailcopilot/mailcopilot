/**
 * E2E spec — a sync of the folder on screen must not orphan an in-flight
 * message open (§2.308).
 *
 * Regression: `syncFolder` bumped the same generation counter that
 * `openMail` used to decide whether its response was still wanted, so a sync
 * that started while the message details were in flight made the response look
 * stale. It was dropped, and the `finally` that clears the loading flag was
 * guarded by the same condition: the pane stayed on "Loading message..."
 * although the details had arrived. Reproduced for real by following an AI-chat
 * source link into another folder (the folder switch starts an auto-sync) and,
 * with the same mechanism, by periodic and manual sync.
 *
 * The race is made deterministic without any main-process hook: both clicks are
 * dispatched in ONE renderer task. The row click starts `openMail` (the details
 * request is issued and can only be answered on a later turn of the event
 * loop); the sync click then runs `syncFolder` synchronously up to its first
 * await, which is where the list generation moves. By the time the details
 * response is delivered the sync is in flight, exactly as in the field.
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, EXPECT_TIMEOUT, type AppContext } from './helpers'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

test('mail open: a sync of the same folder during the pending details does not leave the pane loading', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-open-during-sync-'))
    const page = ctx.page!

    const row = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // The initial auto-sync of the folder must be over: a disabled button ignores the click below.
    await expect(page.getByTestId('sidebar-sync')).toBeEnabled({ timeout: EXPECT_TIMEOUT })

    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="mail-item"]'))
      const target = rows.find(el => el.textContent?.includes('E2E1: первое письмо'))
      const sync = document.querySelector<HTMLButtonElement>('[data-testid="sidebar-sync"]')
      if (!target || !sync) throw new Error('mail row or sync button not found')
      target.click() // openMail: details requested
      sync.click() // syncFolder: list generation moves while the request is in flight
    })

    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-body-text')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // The sync itself finished too, and the open message is still the one on screen.
    await expect(page.getByTestId('sidebar-sync')).toBeEnabled({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-body-text')).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * The mandatory scenario of §2.308: a source link in the AI chat points at a
 * message in ANOTHER folder. The click goes through the real `openMessageRef`
 * (cache lookup, `selectAccount` into the target folder, `openMail`); the folder
 * switch starts the auto-sync of that folder while the details are still being
 * requested. The target message must render, with its own content.
 *
 * The assistant message carrying the `mailref://` link is stored through the
 * real `aiSession:*` IPC (no AI provider is called) and the session is opened
 * through the session list, so the link is clicked in the real panel.
 *
 * The link must carry a citation ticket of the chat, or the panel renders it as plain text with an "unconfirmed" mark
 * and there is nothing to click. Tickets can only come from main: the e2e `ai:chat` mock issues one for the open
 * message of the request context (the same function the live request-start context uses) and links it in its answer,
 * and the spec stores that answer through the real `aiSession:addMessage`. The click then goes through the real path
 * of a chat link: `ai:openCitation` (main finds the message by its Message-ID and returns where it is now), then
 * `openMessageRef` and `openMail` exactly as a click in the list does. The fixture therefore has a Message-ID in its
 * cache row (and in its EML header). */
test('mail open: an AI-chat link into another folder renders the target message despite the auto-sync it starts', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-open-ai-link-'))
    const page = ctx.page!
    const TARGET_BODY = 'OPEN-RACE-TARGET-BODY-7f3a'
    const TARGET_SUBJECT = 'E2E open race target'

    // the fixture's Message-ID: a ticket is issued only for a message that has one
    const MESSAGE_ID = '<open-race-target@example.test>'

    await page.evaluate(async ({ body, subject, messageId }) => {
      const invoke = (window as unknown as { api: { invoke: Invoke } }).api.invoke
      // A real, large message served by the production parse pipeline (`emlBase64`),
      // so that its details take long enough for the auto-sync of the target
      // folder to start while they are still in flight; without it the response
      // beats the sync and the race is not exercised. The target text opens the
      // body, so it survives the soft cap that clips the tail.
      const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor\r\n'.repeat(60_000)
      const eml = [
        'From: carol@example.test', 'To: e2e1@example.test', `Subject: ${subject}`, 'Date: Mon, 09 Feb 2026 00:00:00 +0000',
        `Message-ID: ${messageId}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
        `${body}\r\n${filler}`,
      ].join('\r\n')
      await invoke('e2e:injectMail', {
        accountId: 1, folder: 'Archive', uid: 777, from: 'carol@example.test', to: 'e2e1@example.test',
        subject, date: '2026-02-09T00:00:00.000Z', unread: false, text: body, emlBase64: btoa(eml), messageId,
      })
      await invoke('settings:save', { aiProvider: 'openai-api', aiOpenAiBaseUrl: 'http://127.0.0.1:11434/v1', aiPrivacyConsent: true })
    }, { body: TARGET_BODY, subject: TARGET_SUBJECT, messageId: MESSAGE_ID })

    // Visit the target folder once, so the message is in the local cache, as it is
    // for any message an assistant answer can cite; then return to INBOX. Without
    // this `openMessageRef` would fetch the details itself before navigating and
    // `openMail` would be answered from memory at once, never exercising the race.
    await page.getByTestId('folder-Archive').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: TARGET_SUBJECT })).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.getByTestId('folder-INBOX').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The assistant answer with a real ticket (see the header). Done after the folder visit: the message must be in
    // the local cache for main to issue a ticket for it.
    await page.evaluate(async () => {
      const api = (window as unknown as { api: { invoke: Invoke; on: (ch: string, cb: (e: { type: string; requestId?: string; text?: string }) => void) => void; off: (ch: string, cb: (e: { type: string; requestId?: string; text?: string }) => void) => void } }).api
      const requestId = 'e2e-open-race-req'
      await api.invoke('aiSession:create', { id: 'e2e-open-race', provider: 'openai-api' })
      await api.invoke('aiSession:addMessage', { sessionId: 'e2e-open-race', role: 'user', content: 'Find the message' })
      const answer = await new Promise<string>((resolve) => {
        const onEvent = (e: { type: string; requestId?: string; text?: string }) => {
          if (e.requestId === requestId && e.type === 'result') { api.off('ai:stream', onEvent); resolve(e.text ?? '') }
        }
        api.on('ai:stream', onEvent)
        void api.invoke('ai:chat', requestId, 'Find the message', { type: 'email', data: { accountId: 1, folder: 'Archive', uid: 777 } }, 'e2e-open-race')
      })
      await api.invoke('aiSession:addMessage', { sessionId: 'e2e-open-race', role: 'assistant', content: answer })
      await api.invoke('aiSession:updateTitle', 'e2e-open-race', 'E2E open race')
    })

    await page.getByTestId('sidebar-ai').click()
    await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.getByTestId('ai-sessions-toggle').click()
    await page.getByTestId('ai-session-item').filter({ hasText: 'E2E open race' }).click()

    // The app starts in INBOX; the link points into Archive.
    await page.locator('.ai-inline-mail-link').filter({ hasText: TARGET_SUBJECT }).click()

    await expect(page.getByTestId('mail-subject')).toContainText(TARGET_SUBJECT, { timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-body-text')).toContainText(TARGET_BODY, { timeout: EXPECT_TIMEOUT })
    // The auto-sync of the new folder has run its course and the message is still the open one.
    await expect(page.getByTestId('sidebar-sync')).toBeEnabled({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-body-text')).toContainText(TARGET_BODY)
  } finally {
    await cleanupApp(ctx)
  }
})
