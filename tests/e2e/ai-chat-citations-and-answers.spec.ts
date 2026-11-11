/**
 * E2E for the unified AI chat panel (§3.3 B3 / sprint ai-chat-unify).
 *
 *  B. What the real IPC channels do with citation tickets: main marks every new assistant answer as written with
 *     tickets (the renderer cannot opt out or in), a ticket is known only to the session it was issued in, and an
 *     unknown or malformed ticket resolves to nothing. Every test goes through the real `window.api` / main / SQLite
 *     path; none injects stream events or stubs a bridge.
 *
 * What is NOT here, and why. An end-to-end answer needs the model path, and in the e2e build `ai:chat` is a canned
 * mock (electron/main.ts, `IS_E2E` branch) that never reaches the provider adapter. It does issue a real ticket for
 * the open message (the same function the live request-start context uses), which `mail-open-during-sync.spec.ts`
 * uses to click a real chat link. What the tools hand the model is proven one level down, against the REAL SDK step
 * loop with a scripted provider: `electron/services/aiCitations.integration.test.ts`.
 *
 * What has to break in production code for each test to go red (CLAUDE.md §7 rule 9):
 *   1. marker (B) — let `aiSession:addMessage` honour a renderer-supplied marker, or leave assistant rows unmarked:
 *      `citationVersion` stops being 1 for the answer written through the IPC.
 *   2. unknown ticket (B) — make `ai:resolveCitations` answer for a ticket the session never got: the status stops
 *      being `unknown`.
 *   3. images from answers (D) — let the answer renderer pass `img` through (drop `BlockedImage` from
 *      `answerMarkdownProps`): the loopback server sees a request and the DOM gets an `<img>` with the external address.
 *      Drop the error boundary around the answer: the `>` run that overflows the parser leaves the panel blank.
 */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, cleanupApp, EXPECT_TIMEOUT, type AppContext } from './helpers'

type Invoke = (ch: string, ...a: unknown[]) => Promise<unknown>

/** Unreachable on purpose: these tests never send anything to a provider. */
async function configureAiProvider(ctx: AppContext): Promise<void> {
  await ctx.page.evaluate(async () => {
    const api = (window as unknown as { api: { invoke: Invoke } }).api
    await api.invoke('settings:save', {
      aiProvider: 'openai-api',
      aiOpenAiBaseUrl: 'http://127.0.0.1:11434/v1',
      aiPrivacyConsent: true,
    })
  })
}

test.describe('AI chat citation tickets, end to end (§3.3 B3)', () => {
  test('B: main marks every new assistant answer; a ticket nobody issued is unknown; a malformed one resolves to nothing', async () => {
    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp())
      const app = ctx as AppContext
      const out = await app.page.evaluate(async () => {
        const api = (window as unknown as { api: { invoke: Invoke } }).api
        await api.invoke('aiSession:create', { id: 'e2e-cite', provider: 'openai-api' })
        await api.invoke('aiSession:addMessage', { sessionId: 'e2e-cite', role: 'user', content: 'q' })
        // the renderer tries to say something about the row's sources and about its own request: neither is a field
        await api.invoke('aiSession:addMessage', { sessionId: 'e2e-cite', role: 'assistant', content: '[x](mailref://c/aaaaaaaa)', requestId: 'r1', sources: [{ ref: { accountId: 1, folder: 'INBOX', uid: 1 } }], citationVersion: 0 })
        const rows = await api.invoke('aiSession:messages', 'e2e-cite') as Array<{ role: string; citationVersion: number | null }>
        const statuses = await api.invoke('ai:resolveCitations', { sessionId: 'e2e-cite', tokens: ['aaaaaaaa', 'short', 'UPPERCAS'] }) as Array<{ token: string; status: string }>
        const opened = await api.invoke('ai:openCitation', { sessionId: 'e2e-cite', token: 'aaaaaaaa' })
        const malformed = await api.invoke('ai:openCitation', { sessionId: 'e2e-cite', token: 'short' })
        return { rows, statuses, opened, malformed }
      })
      expect(out.rows.map(r => r.citationVersion)).toEqual([null, 1])
      expect(out.statuses.map(s => s.status)).toEqual(['unknown', 'unknown', 'unknown'])
      expect(out.opened).toEqual({ found: false })
      expect(out.malformed).toEqual({ found: false })
    } finally {
      await cleanupApp(ctx)
    }
  })
})

test.describe('Images and hostile markup in an AI answer (D)', () => {
  test('D: an image in an answer makes no network request and is no <img>; a `>` run that overflows the parser does not take the panel down', async () => {
    const hits: string[] = []
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'image/gif' })
      res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp())
      const app = ctx as AppContext
      const requested: string[] = []
      app.page.on('request', r => { if (r.url().startsWith(base)) requested.push(r.url()) })
      await configureAiProvider(app)

      // Control: the harness DOES see a request made by the renderer to this server (otherwise "none" proves nothing).
      await app.page.evaluate(src => new Promise<void>(resolve => {
        const img = new Image(); img.onload = img.onerror = () => resolve(); img.src = src
      }), `${base}/control.gif`)
      await expect.poll(() => hits.filter(u => u === '/control.gif').length).toBe(1)
      expect(requested).toContain(`${base}/control.gif`)
      hits.length = 0; requested.length = 0

      await app.page.evaluate(async (b) => {
        const api = (window as unknown as { api: { invoke: Invoke } }).api
        await api.invoke('aiSession:create', { id: 'e2e-img', provider: 'openai-api' })
        await api.invoke('aiSession:addMessage', { sessionId: 'e2e-img', role: 'user', content: 'q' })
        const answer = [
          `![tracking pixel](${b}/leak.gif?d=SECRET)`,
          `[![linked](${b}/linked.gif)](${b}/page)`,
          `![ref][r]`,
          `<img src="${b}/raw.gif">`,
          `[ordinary](${b}/page2)`,
          `[r]: ${b}/ref.gif`,
        ].join('\n\n')
        await api.invoke('aiSession:addMessage', { sessionId: 'e2e-img', role: 'assistant', content: answer })
        await api.invoke('aiSession:updateTitle', 'e2e-img', 'E2E image')
        await api.invoke('aiSession:create', { id: 'e2e-deep', provider: 'openai-api' })
        await api.invoke('aiSession:addMessage', { sessionId: 'e2e-deep', role: 'user', content: 'q' })
        await api.invoke('aiSession:addMessage', { sessionId: 'e2e-deep', role: 'assistant', content: `${'>'.repeat(6000)} deep` })
        await api.invoke('aiSession:updateTitle', 'e2e-deep', 'E2E deep')
      }, base)

      await app.page.getByTestId('sidebar-ai').click()
      await expect(app.page.getByTestId('ai-panel')).toBeVisible({ timeout: EXPECT_TIMEOUT })
      await app.page.getByTestId('ai-sessions-toggle').click()
      await app.page.getByTestId('ai-session-item').filter({ hasText: 'E2E image' }).click()
      const answer = app.page.getByTestId('ai-message-assistant')
      await expect(answer).toContainText('tracking pixel', { timeout: EXPECT_TIMEOUT })
      await expect(answer).toContainText(`${base}/leak.gif?d=SECRET`) // shown as text, address visible to the person
      await expect(answer.locator('img')).toHaveCount(0)
      await expect(app.page.locator(`img[src^="${base}"]`)).toHaveCount(0)
      await expect(answer.locator('a').filter({ hasText: 'ordinary' })).toHaveCount(1) // an ordinary link stays a link
      await app.page.waitForTimeout(1000) // a late load would land by now
      expect(requested).toEqual([])
      expect(hits).toEqual([])

      // A quote run deep enough to overflow the parser: the boundary shows the answer as text and the panel survives.
      await app.page.getByTestId('ai-sessions-toggle').click()
      await app.page.getByTestId('ai-session-item').filter({ hasText: 'E2E deep' }).click()
      await expect(app.page.getByTestId('ai-message-assistant')).toContainText('deep', { timeout: EXPECT_TIMEOUT })
      await expect(app.page.getByTestId('ai-panel')).toBeVisible()
      await expect(app.page.getByTestId('ai-input')).toBeVisible()
    } finally {
      await cleanupApp(ctx)
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
