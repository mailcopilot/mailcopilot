/**
 * E2E spec: §3.3 B6 part 2 — AI Translate in the COMPOSE window.
 *
 * `electron/services/composeTranslate.test.ts`, `src/hooks/useDraftTranslation.test.ts`
 * and `src/components/ComposeQuickActions.test.tsx` cover the refusal ladder, the
 * priority rule (`chosen ?? suggested`), the draft-scoped reset and the render
 * decisions with fakes. Nothing there drives a real Electron window, so none of
 * it proves: the control is actually invisible when the opt-in is off, a real
 * IPC round trip through `ai:translate:draft` paints the shared diff panel, the
 * §2.78 quote/signature carry-through survives Replace against a real textarea,
 * or that `ui:openCompose` really mints a suggestion from a cached message body
 * on Reply and really omits it on Forward (`replyRef` is absent on that path —
 * see `replyMail('forward')` in `src/App.tsx`).
 *
 * Reuses the local `node:http` stub pattern from `mail-translate.spec.ts` /
 * `quick-actions-diff-preview.spec.ts`: a real socket on `127.0.0.1`, no
 * `page.route()` interception (frozen `contextBridge` objects make renderer-side
 * IPC spies silently no-op — see the note in `mail-translate.spec.ts`).
 *
 * The suggestion test replies to/forwards a message injected via
 * `e2e:injectMail` (preload whitelist, `assertE2EHandlerAllowed`-gated) rather
 * than a built-in RU fixture: `packages/core/language.test.ts` — this feature's
 * OWN calibration suite — documents real franc as unable to reliably name
 * ordinary Russian business prose ("is honest about the Cyrillic confusion the
 * docblock records": one natural RU sample is refused as `undetermined`, a
 * second is confidently misnamed `bul`). Relying on RU source text here would
 * make the suggestion assertion depend on an already-documented coin flip.
 * German clears the SAME calibration suite's "✓" transcript instead (`DE_LONG`,
 * `detectTextLanguage(DE_LONG, realScorer) === { ok: true, iso6393: 'deu' }`),
 * so the injected body below is that exact calibrated string. `e2e:injectMail`
 * writes into the in-memory `e2eBox` only (see the note in
 * `quick-actions-instant-reply.spec.ts`), but opening the injected message
 * (click + wait for `mail-subject`) drives the same `messageDetails` IS_E2E
 * branch `mail-translate.spec.ts`'s header explains, which DOES write the body
 * into SQLite — the store `getMessageByUid` (and so `suggestReplyTargetLang`)
 * actually reads.
 */
import http from 'node:http'
import { test, expect, type Page } from '@playwright/test'
import {
  launchApp,
  cleanupApp,
  clickMailItem,
  waitForPage,
  EXPECT_TIMEOUT,
  type AppContext,
} from './helpers'

// Must not collide with built-in e2e fixture UIDs (89–104, 201) — see the
// convention note in `recipient-list.spec.ts`.
const SUGGESTION_MAIL_UID = 9910

// The exact `DE_LONG` calibration string from `packages/core/language.test.ts`
// — real franc names it `deu` without ambiguity (part of that suite's own "✓"
// transcript), unlike natural Russian prose (see the file header above).
const DE_SUGGESTION_BODY = 'Guten Tag, anbei finden Sie die Rechnung für den letzten Monat sowie den Leistungsnachweis. '
  + 'Bitte bestätigen Sie den Erhalt der Unterlagen und melden Sie sich bei Rückfragen.'

type Stub = { url: string; close: () => Promise<void> }

/** One immediate reply for every request — sufficient for these tests, which
 *  never need to synchronize on an in-flight request. */
async function startStub(replyText: string): Promise<Stub> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { content: replyText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }))
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') return reject(new Error('failed to bind the stub'))
      resolve(addr.port)
    })
  })
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    }),
  }
}

/** Runs `cleanupApp` and `stub.close()` unconditionally, surfacing either
 *  failure (matches the teardown pattern in the two files cited above). */
async function teardown(ctx: Partial<AppContext>, stub: Stub): Promise<void> {
  let cleanupError: unknown
  try { await cleanupApp(ctx) } catch (err) { cleanupError = err }
  try {
    await stub.close()
  } catch (closeErr) {
    if (cleanupError !== undefined) {
      throw new Error('cleanupApp() failed AND stub.close() failed', { cause: closeErr })
    }
    throw closeErr
  }
  if (cleanupError !== undefined) throw cleanupError
}

/** Points the app at the stub AND flips the per-account opt-in in one call —
 *  the Settings checkbox round trip is already covered in `mail-translate.spec.ts`. */
async function configureStubAndEnable(page: Page, baseUrl: string): Promise<void> {
  await page.evaluate(async (url) => {
    const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
    await api.invoke('ai:saveApiKey', 'sk-e2e-compose-translate-stub', 'openai-api')
    const result = await api.invoke('settings:save', {
      aiProvider: 'openai-api',
      aiOpenAiBaseUrl: url,
      aiModel: 'gpt-4o-mini',
      aiTranslateEnabled: { '1': true },
    }) as { ok: boolean; reason?: string }
    if (!result.ok) throw new Error(`settings:save failed: ${result.reason ?? 'unknown'}`)
  }, baseUrl)
}

/** Same opt-in flip, no provider — used by the suggestion tests, which never
 *  reach a provider (local franc detection only). */
async function enableTranslateOnly(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
    const result = await api.invoke('settings:save', { aiTranslateEnabled: { '1': true } }) as { ok: boolean; reason?: string }
    if (!result.ok) throw new Error(`settings:save failed: ${result.reason ?? 'unknown'}`)
  })
}

/** Opens a blank Compose window and fills the whole body — mirrors
 *  `openBlankComposeWithBody` in `quick-actions-diff-preview.spec.ts`. */
async function openBlankCompose(ctx: AppContext, body: string): Promise<Page> {
  await ctx.page.getByTestId('sidebar-compose').click()
  const compose = await waitForPage(ctx.browser, p => p.url().includes('#/compose'))
  await compose.waitForLoadState('domcontentloaded')
  await compose.getByTestId('compose-text').fill(body)
  return compose
}

test('compose translate: the picker and button are absent when the per-account opt-in is off', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-composetr-off-'))
    const compose = await openBlankCompose(ctx as AppContext, 'Hello there.')
    // Sibling controls (Improve/Shorter/Formal/Grammar) DO render — only the
    // opt-in-gated translate control must be missing. Confirms the toolbar
    // itself mounted, so an empty result below is the gate, not a dead window.
    await expect(compose.getByTestId('compose-quick-action-improve')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(compose.getByTestId('compose-translate-target')).toHaveCount(0)
    await expect(compose.getByTestId('compose-translate-run')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

test('compose translate: picking a language and running opens the diff preview; Cancel leaves the draft untouched', async () => {
  const stub = await startStub('Bonjour, ceci est une reponse traduite.')
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-composetr-cancel-'))
    const appCtx = ctx as AppContext
    await configureStubAndEnable(appCtx.page, stub.url)

    const original = 'Hello, this is my draft body.'
    const compose = await openBlankCompose(appCtx, original)
    const target = compose.getByTestId('compose-translate-target')
    await expect(target).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const runBtn = compose.getByTestId('compose-translate-run')
    // No target chosen yet — nothing to run into.
    await expect(runBtn).toBeDisabled()
    await target.selectOption('fr')
    await expect(runBtn).toBeEnabled()
    await runBtn.click()

    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // The shared panel's header caption identifies THIS as a translation, not
    // one of the four rewrite presets — `labelKey: 'ai.quickAction.translate.diffLabel'`.
    await expect(compose.getByTestId('quick-action-diff-preset')).toHaveText('Translation')

    await compose.getByTestId('quick-action-diff-cancel').click()
    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)
    await expect(compose.getByTestId('compose-text')).toHaveValue(original)
  } finally {
    await teardown(ctx, stub)
  }
})

test('compose translate: Replace swaps only the translated own text — the quote and signature survive byte-for-byte', async () => {
  const stub = await startStub('Please review the budget figures. Share your thoughts when you can.')
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-composetr-replace-'))
    const appCtx = ctx as AppContext
    await configureStubAndEnable(appCtx.page, stub.url)

    const ownText = 'Please review the budget line.\nLet me know your thoughts.'
    // MailCopilot's own quote/signature form (no trailing space after `--`) —
    // structurally recognized tail material that must never reach the model or
    // be overwritten by Replace (§2.78, mirrors quick-actions-diff-preview.spec.ts #10).
    const tail = '\n\n> Original correspondent line one.\n> Original correspondent line two.\n\n--\nSergey'
    const compose = await openBlankCompose(appCtx, ownText + tail)

    const target = compose.getByTestId('compose-translate-target')
    await expect(target).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await target.selectOption('fr')
    await compose.getByTestId('compose-translate-run').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await compose.getByTestId('quick-action-diff-replace').click()
    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)
    await expect(compose.getByTestId('compose-text')).toHaveValue(
      'Please review the budget figures. Share your thoughts when you can.' + tail,
    )
  } finally {
    await teardown(ctx, stub)
  }
})

test('compose translate: Reply carries a suggested target language that the user\'s own pick beats and survives further edits; Forward carries none', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-composetr-suggest-'))
    const appCtx = ctx as AppContext
    await enableTranslateOnly(appCtx.page)

    const subject = `E2E DE suggestion (uid ${SUGGESTION_MAIL_UID})`
    await appCtx.page.evaluate(async ({ uid, subject, text }) => {
      const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
      await api.invoke('e2e:injectMail', {
        accountId: 1,
        folder: 'INBOX',
        uid,
        from: 'sender@example.test',
        to: 'e2e1@example.test',
        subject,
        date: new Date().toISOString(),
        unread: true,
        flagged: false,
        text,
      })
    }, { uid: SUGGESTION_MAIL_UID, subject, text: DE_SUGGESTION_BODY })

    const mail = appCtx.page.getByTestId('mail-item').filter({ hasText: subject }).first()
    await expect(mail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mail)
    await expect(appCtx.page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await appCtx.page.getByTestId('mail-action-reply').click()
    const compose = await waitForPage(appCtx.browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    const target = compose.getByTestId('compose-translate-target')
    await expect(target).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // The injected body is the calibrated `DE_LONG` string, well over the
    // 80-char detection floor and named `deu` without ambiguity — main minted
    // a real suggestion from it via `suggestReplyTargetLang`. Removing
    // `withSuggestedTargetLang` in `ui:openCompose`, or the `replyRef` on the
    // reply path in `App.tsx`, empties this instead.
    await expect(target).toHaveValue('de', { timeout: EXPECT_TIMEOUT })

    // Property 2: the user's own pick beats the suggestion irreversibly for
    // this draft (`chosen ?? suggested`) — never reverts on a later re-render.
    await target.selectOption('en')
    await compose.getByTestId('compose-text').fill('Reply body, still being edited.')
    await expect(target).toHaveValue('en')

    // Forward the SAME message. `composeWin` is already open, so `ui:openCompose`
    // resets it via `compose:init` (window-reuse path) instead of opening a
    // second window — the other delivery path through `withSuggestedTargetLang`.
    await appCtx.page.bringToFront()
    await appCtx.page.getByTestId('mail-action-forward').click()
    await expect(compose.getByTestId('compose-subject')).toHaveValue(/^Fwd:/, { timeout: EXPECT_TIMEOUT })

    // No `replyRef` on a forward (`replyMail('forward')` never sets one) —
    // `startTargetLangSuggestion` short-circuits to nothing without even
    // loading the detector, so the picker resets to no selection at all.
    await expect(target).toHaveValue('', { timeout: EXPECT_TIMEOUT })
    await expect(compose.getByTestId('compose-translate-run')).toBeDisabled()
  } finally {
    await cleanupApp(ctx)
  }
})
