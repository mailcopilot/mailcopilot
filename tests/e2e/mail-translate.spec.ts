/**
 * E2E spec: §3.3 B6 AI Translate (reading pane) — opt-in gate, Settings
 * persistence, per-message reset, the IPC boundary, and (since the §3.3.B6.f1
 * fix wave removed the language-detection gate) a real positive path, all
 * verified against a live Electron window.
 *
 * NOTE: Written/updated by test-gen but NOT run here. NEEDS_E2E: yes.
 *       The pre-pr-gate agent executes it via `npm run e2e:bg`.
 *
 * ## Correction (fix-wave re-review): the "no cached body" premise was wrong
 *
 * An earlier version of this file claimed the positive path could never be
 * e2e-reachable because the fixture inbox carries no `messages.body_text`.
 * That was true of the LISTING handlers (`net:inboxSummaries` /
 * `net:folderPage`, headers only) but not of the READING-PANE one: opening a
 * message (`clickMailItem` + waiting for `mail-subject`, exactly what every
 * test below already does) drives the `messageDetails` IS_E2E branch in
 * `electron/main.ts`, which calls `updateMessageBodyText(...)` with the
 * fixture's own `text` field before the pane ever paints. By the time
 * `mail-subject` is visible, `getMessageByUid().bodyText` is populated — the
 * `empty_input` refusal below is real, but it was never about a missing body;
 * it fires because no AI provider is configured, same as `no_provider` would
 * without a body-independent gate ahead of it in `prepareTranslate`'s order.
 *
 * What remained genuinely unreachable was the PROVIDER call — until this file
 * borrowed the pattern `quick-actions-diff-preview.spec.ts` established: a
 * real `node:http` server on `127.0.0.1`, pointed to by `aiOpenAiBaseUrl`, is
 * a REAL socket the main-process `fetch()` in `aiChatSimpleOutcome` actually
 * connects to — no `page.route()` interception needed, because nothing is
 * being intercepted. `ai:saveApiKey` lands in the run's own encrypted disk
 * fallback (§2.132, `MAILCOPILOT_E2E=1` never touches the OS keychain) — the
 * exact guarantee `ai-key-persistence.spec.ts` pins directly. The fixture RU
 * body (`'Тестовое письмо для e2e (аккаунт 1)...'`) carries under 100 letters
 * (`LANGUAGE_DETECTION_MIN_SCRIPT_CHARS`), so it is ALSO, for free, a message the
 * local trigram detector will not name — the exact case §3.3.B6.f1 stopped
 * gating on. See the last test below.
 *
 * The full refusal ladder, the budget/cache/audit/span bookkeeping, the
 * untrusted-boundary wrapping and the money accounting are unit-tested with
 * fakes in `electron/services/aiTranslate.test.ts`. The client state machine —
 * token discipline, the original/translation switch, the per-message reset,
 * the six refusal reasons as values, and the language picker as an offer
 * rather than a gate — is unit-tested in `src/hooks/useMailTranslation.test.ts`
 * and the bar's own render decisions in `src/components/MailTranslateBar.test.tsx`.
 *
 * What THIS spec proves that no unit test can, against a real window:
 *   1. The bar is entirely ABSENT on a fresh profile (toggle OFF by default) —
 *      the IPC round-trip between App.tsx's settings-load and
 *      `isAiFeatureEnabledForAccount` gating is correct end to end. There is
 *      no button to click, which is the real (mechanical) reason a
 *      disabled account can never reach `ai:translate:message` — see the note
 *      below on why this is asserted structurally and not via an invoke spy.
 *   2. Enabling the per-account Settings toggle and saving makes the bar
 *      appear in the reading pane — the settings.json round-trip and the
 *      App.tsx → useMailTranslation wiring are both real.
 *   3. The Settings toggle persists across a window close/reopen cycle.
 *   4. With the toggle ON but no provider configured, clicking Translate
 *      reaches main for real and comes back as a graceful, localized refusal —
 *      never a crash — and the original body is left exactly as it was.
 *   5. Switching to a DIFFERENT message clears a refusal produced for the
 *      previous one — the toggle-bar state never leaks across messages.
 *   6. With a REAL (stubbed) provider configured, a translation whose source
 *      language the local detector refuses to name still completes end to
 *      end, and the language picker appears as an offer over the
 *      already-visible translation — never as a precondition for it.
 *   7. The SECOND door into the same picker (§3.3.B6.f2): once a translation
 *      carries a caption, restating the source language reaches main again,
 *      changes the caption on screen and — because `ai_translations` is keyed
 *      on the hash of the source text, not the source language — is served
 *      from that cache, provably WITHOUT a second call to the stubbed
 *      provider (`stub.requestCount()` stays at 1 across both requests).
 *
 * NOT attempted here: intercepting the actual `ai:translate:message` IPC call
 * count / payload from the page context. `electron/preload.ts` exposes `api`
 * via `contextBridge.exposeInMainWorld`, which Electron recursively freezes —
 * `window.api.invoke = spy` silently no-ops under `page.evaluate` (sloppy
 * mode, no thrown error). This was verified the hard way: a first version of
 * this spec asserted `expect(calls).toHaveLength(1)` after a click that
 * DEFINITELY reached main (the refusal it produced can only exist if
 * `useMailTranslation`'s `request()` awaited the real `translateRef.current`),
 * and the spy still reported zero captured calls both on the first run and on
 * Playwright's automatic retry — proof the interception itself never attaches,
 * not that the call didn't happen. `thread-summary.spec.ts` asserts the
 * inverse (`calls === 0`) with the same broken mechanism, which makes that
 * assertion vacuously true regardless of production behavior — flagged in the
 * test-gen report as a followup, not fixed here (out of this task's scope).
 * The exact request shape IS proven for real in
 * `useMailTranslation.test.ts` ("sends exactly (accountId, folder, uid,
 * targetLang) and no other field"): the `translate` collaborator there is an
 * injected function (not routed through `contextBridge`), so the spy is the
 * real one this hook calls in production, just swapped via DI instead of
 * frozen-object mutation.
 */
import http from 'node:http'
import { test, expect, type Page } from '@playwright/test'
import {
  launchApp,
  cleanupApp,
  clickMailItem,
  waitForPage,
  EXPECT_TIMEOUT,
  CLOSE_TIMEOUT,
  type AppContext,
} from './helpers'

// ---------------------------------------------------------------------------
// A real local OpenAI-compatible stub — same technique as
// `quick-actions-diff-preview.spec.ts`'s `startAiStub`. `aiChatSimpleOutcome`
// (electron/services/ai.ts) posts to `${baseUrl}/v1/chat/completions` and
// reads `choices[0].message.content`, so the stub only needs that one shape.
// ---------------------------------------------------------------------------

type TranslateStub = {
  url: string
  /** Number of `/v1/chat/completions` requests the stub has actually received
   *  so far — the mechanism the restate-door test below uses to prove a cache
   *  hit never touched the provider (§3.3.B6.f2). */
  requestCount: () => number
  close: () => Promise<void>
}

async function startTranslateStub(replyText: string): Promise<TranslateStub> {
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
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
      if (!addr || typeof addr === 'string') return reject(new Error('failed to bind the translate stub'))
      resolve(addr.port)
    })
  })
  return {
    url: `http://127.0.0.1:${port}`,
    requestCount: () => requests,
    // Propagate a close failure instead of resolving unconditionally — a
    // leaked listening socket would otherwise surface only as an unrelated
    // flake in a later run (same reasoning as the diff-preview stub).
    close: () => new Promise((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    }),
  }
}

/**
 * Point the app at the stub as its `openai-api` provider AND enable the
 * per-account translate opt-in in the same call — bypassing the Settings UI
 * checkbox, which the other tests in this file already exercise on its own.
 * `ai:saveApiKey` writes a fake key through the real secretStore (disk
 * fallback under `MAILCOPILOT_E2E=1`, §2.132); `aiChatSimpleOutcome`'s
 * `openai-api` branch requires a truthy key before it will dispatch at all.
 */
async function configureTranslateStub(page: Page, baseUrl: string): Promise<void> {
  await page.evaluate(async (url) => {
    const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
    await api.invoke('ai:saveApiKey', 'sk-e2e-translate-stub', 'openai-api')
    const result = await api.invoke('settings:save', {
      aiProvider: 'openai-api',
      aiOpenAiBaseUrl: url,
      aiModel: 'gpt-4o-mini',
      aiTranslateEnabled: { '1': true },
    }) as { ok: boolean; reason?: string }
    if (!result.ok) throw new Error(`settings:save failed: ${result.reason ?? 'unknown'}`)
  }, baseUrl)
}

/**
 * Same wire shape as {@link startTranslateStub}, but the (single) response is
 * gated on an explicit `release()` instead of answering immediately. Needed
 * for the in-flight-message-switch test below, which has to land the switch
 * strictly between the request dispatching and the response arriving — a
 * fixed delay/wait pair would race on runner load (identical problem and fix
 * already proven at `quick-actions-diff-preview.spec.ts`'s
 * `queueGatedResponse`).
 */
async function startGatedTranslateStub(
  replyText: string,
): Promise<TranslateStub & { requestReceived: Promise<void>; release: () => void }> {
  let requests = 0
  let notifyReceived!: () => void
  const requestReceived = new Promise<void>(resolve => { notifyReceived = resolve })
  let releaseFn!: () => void
  const releasePromise = new Promise<void>(resolve => { releaseFn = resolve })
  const server = http.createServer((req, res) => {
    requests++
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      // The request body has been fully read at this point — the earliest
      // observable proof the main-process `fetch()` actually dispatched.
      notifyReceived()
      void releasePromise.then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{ message: { content: replyText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }))
      })
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') return reject(new Error('failed to bind the gated translate stub'))
      resolve(addr.port)
    })
  })
  return {
    url: `http://127.0.0.1:${port}`,
    requestCount: () => requests,
    requestReceived,
    release: releaseFn,
    close: () => new Promise((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    }),
  }
}

/** Runs `cleanupApp` and `stub.close()` unconditionally, surfacing either
 *  failure (both, if both fail) instead of silently skipping the stub
 *  teardown whenever `cleanupApp` rejects. */
async function teardownWithStub(ctx: Partial<AppContext>, stub: TranslateStub): Promise<void> {
  let cleanupError: unknown
  try {
    await cleanupApp(ctx)
  } catch (err) {
    cleanupError = err
  }
  try {
    await stub.close()
  } catch (closeErr) {
    if (cleanupError !== undefined) {
      throw new Error('cleanupApp() failed AND stub.close() failed — see cause for the stub error', {
        cause: closeErr,
      })
    }
    throw closeErr
  }
  if (cleanupError !== undefined) throw cleanupError
}

async function openAiSettingsTab(page: import('@playwright/test').Page, browser: import('@playwright/test').Browser) {
  await page.getByTestId('open-settings').click()
  const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
  await settings.waitForLoadState('domcontentloaded')
  await settings.getByTestId('settings-tab-ai').click()
  return settings
}

async function enableTranslateToggle(page: import('@playwright/test').Page, browser: import('@playwright/test').Browser) {
  const settings = await openAiSettingsTab(page, browser)
  const toggle = settings.getByTestId('settings-ai-consent-translate-1')
  await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT })
  await toggle.check()
  await settings.getByTestId('settings-save').click()
  await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  await page.bringToFront()
}

test('B6: translate bar is absent on a fresh profile (toggle OFF by default)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-off-'))
    const page = ctx.page!

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(mail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Removing the `isAiFeatureEnabledForAccount` gate in App.tsx (or the
    // `active && translation` guard in MailBodyContent) → this goes red.
    // The bar is the ONLY surface that can reach `ai:translate:message`
    // (MailTranslateBar performs no IPC of its own — see its own header — and
    // `useMailTranslation` never calls the provider from an effect), so its
    // absence is the real, mechanical proof that opening a message with the
    // opt-in off cannot produce that call: there is no button for it to fire
    // from. `useMailTranslation.test.ts` proves the "no automatic effect" half
    // directly against the real hook.
    await expect(page.getByTestId('mail-translate-bar')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

test('B6: enabling the toggle in Settings makes the translate bar appear in the reading pane', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-on-'))
    const page = ctx.page!
    const browser = ctx.browser!

    const settings = await openAiSettingsTab(page, browser)
    const toggle = settings.getByTestId('settings-ai-consent-translate-1')
    await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // Default: unchecked. Removing the default `{}` normalization in App.tsx's
    // settings apply() → this could read as checked instead.
    await expect(toggle).not.toBeChecked()
    await toggle.check()
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(mail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Removing the App.tsx → useMailTranslation → MailBodyContent wiring →
    // this stays absent even with the setting on.
    await expect(page.getByTestId('mail-translate-bar')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-translate-target')).toBeVisible()
    await expect(page.getByTestId('mail-translate-action')).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('B6: Settings toggle persists across close/reopen (settings.json round-trip)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-persist-'))
    const page = ctx.page!
    const browser = ctx.browser!

    await enableTranslateToggle(page, browser)

    const settings2 = await openAiSettingsTab(page, browser)
    const toggle2 = settings2.getByTestId('settings-ai-consent-translate-1')
    await expect(toggle2).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // Removing `aiTranslateEnabled` from the settings:save payload → reopen
    // shows this unchecked again.
    await expect(toggle2).toBeChecked()

    // Restore for hygiene.
    await toggle2.uncheck()
    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('B6: clicking Translate reaches main for real and surfaces a graceful refusal, not a crash', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-refusal-'))
    const page = ctx.page!
    const browser = ctx.browser!

    await enableTranslateToggle(page, browser)

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(mail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const originalBody = await page.getByTestId('mail-body-text').textContent()

    const action = page.getByTestId('mail-translate-action')
    await expect(action).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await action.click()

    // Opening the message DID cache a body (see the file header correction —
    // `messageDetails` populates `body_text` before the pane paints), but no
    // AI provider is configured in this profile, so `prepareTranslate` /
    // `runTranslate` refuses before any provider is touched either way. Which
    // exact reason fires (`no_provider`, or an earlier gate) is not asserted
    // on — that ladder is exhaustively unit-tested in `aiTranslate.test.ts`.
    // What matters here is that the refusal reaches the UI as a graceful,
    // localized sentence rather than an unhandled rejection or a blank pane.
    const refusal = page.getByTestId('mail-translate-refusal')
    await expect(refusal).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const refusalText = await refusal.textContent()
    expect(refusalText?.trim().length ?? 0).toBeGreaterThan(0)
    // The raw i18n key must never leak onto the screen as if it were copy.
    expect(refusalText).not.toContain('mail.translate.refusal')

    // The original body must be untouched — a refused translation swaps
    // nothing, and there must be no leftover `mail-body-translated` node.
    await expect(page.getByTestId('mail-body-translated')).toHaveCount(0)
    await expect(page.getByTestId('mail-body-text')).toHaveText(originalBody ?? '')
  } finally {
    await cleanupApp(ctx)
  }
})

test('B6: opening a different message clears a refusal produced for the previous one', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-switch-'))
    const page = ctx.page!
    const browser = ctx.browser!

    await enableTranslateToggle(page, browser)

    const first = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(first).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(first)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await page.getByTestId('mail-translate-action').click()
    await expect(page.getByTestId('mail-translate-refusal')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const second = page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' }).first()
    await expect(second).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(second)
    await expect(page.getByTestId('mail-subject')).toHaveText(/второе письмо/i, { timeout: EXPECT_TIMEOUT })

    // The bar must be back to its idle state under the new message — not the
    // refusal produced for the first one. Removing the identity-keyed reset
    // effect in useMailTranslation → the refusal banner would still show here.
    await expect(page.getByTestId('mail-translate-refusal')).toHaveCount(0)
    await expect(page.getByTestId('mail-translate-action')).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

test('B6: a translation completes even though the source language cannot be named — the picker is an offer, not a gate', async () => {
  // §3.3.B6.f1: until the fix wave, a source language the local detector
  // would not name blocked the WHOLE translation (`undetermined_language`).
  // The fixture body below is real production content (not a test-only
  // string) that happens to sit under `LANGUAGE_DETECTION_MIN_SCRIPT_CHARS` —
  // exactly the case that used to refuse. Reintroducing that gate, or the
  // `undetermined_language` refusal reason, makes this test fail: the toggle
  // and the translated text below would never appear.
  const stub = await startTranslateStub('Good afternoon, this is the e2e stub reply.')
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-success-'))
    const page = ctx.page!
    await configureTranslateStub(page, stub.url)

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(mail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const action = page.getByTestId('mail-translate-action')
    await expect(action).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await action.click()

    // A REAL translation, from a REAL (stubbed) provider — not a refusal.
    const translated = page.getByTestId('mail-body-translated')
    await expect(translated).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(translated).toHaveText('Good afternoon, this is the e2e stub reply.')
    await expect(page.getByTestId('mail-translate-refusal')).toHaveCount(0)

    // The switch replaces the pre-translate action button — `ready`, not
    // `loading` or `refused`.
    await expect(page.getByTestId('mail-translate-toggle')).toBeVisible()

    // The picker OFFERS a caption over the translation that is already on
    // screen above. It is not disabled-until-answered gating: the Apply
    // button starts disabled (nothing chosen yet) and the translation is
    // fully readable regardless.
    await expect(page.getByTestId('mail-translate-source-offer')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-translate-source-choice')).toBeVisible()
    const applyButton = page.getByTestId('mail-translate-source-apply')
    await expect(applyButton).toBeVisible()
    await expect(applyButton).toBeDisabled()
  } finally {
    await teardownWithStub(ctx, stub)
  }
})

test('B6: restating an already-captioned translation updates the caption without a second provider call (§3.3.B6.f2)', async () => {
  // Same stub technique as the test above, plus a request counter — the
  // mechanism this test actually depends on: the cache is keyed on the hash
  // of the source text (not the source language), so a second `request()`
  // call for the same message and target must be served from
  // `ai_translations` and must NOT reach `/v1/chat/completions` again.
  const stub = await startTranslateStub('Good afternoon, this is the e2e stub reply.')
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-restate-'))
    const page = ctx.page!
    await configureTranslateStub(page, stub.url)

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(mail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const action = page.getByTestId('mail-translate-action')
    await expect(action).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await action.click()

    // Set-up, not the thing under test: the fixture body sits under
    // `LANGUAGE_DETECTION_MIN_SCRIPT_CHARS`, so the FIRST translation comes back
    // with NO caption — the "offer" door (`needsLanguageChoice`), already
    // covered by the test above. Answering it here is the only UI-reachable
    // way, on this fixture, to reach a translation that DOES carry a caption
    // — the precondition `canRestateSourceLang` (the door actually under
    // test) requires.
    const translated = page.getByTestId('mail-body-translated')
    await expect(translated).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-translate-source-offer')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.getByTestId('mail-translate-source').selectOption('ru')
    await page.getByTestId('mail-translate-source-apply').click()

    await expect(page.getByTestId('mail-translate-source-offer')).toHaveCount(0)
    const notice = page.getByTestId('mail-translate-notice')
    await expect(notice).toContainText('from Russian into', { timeout: EXPECT_TIMEOUT })
    // Answering the offer re-requested, but it is the SAME text and target as
    // the first click, so it must have been a cache hit too — asserted here,
    // before the door under test, so a failure below is unambiguously about
    // THAT door and not about this set-up step.
    expect(stub.requestCount()).toBe(1)

    // --- The door under test (§3.3.B6.f2): a caption that IS there, corrected. ---
    const restate = page.getByTestId('mail-translate-source-restate')
    await expect(restate).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(restate).toHaveAttribute('aria-expanded', 'false')
    await expect(restate).toHaveAttribute('aria-controls', 'mail-translate-source-choice')

    await restate.click()
    await expect(restate).toHaveAttribute('aria-expanded', 'true')

    const choice = page.getByTestId('mail-translate-source-choice')
    await expect(choice).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const sourceSelect = page.getByTestId('mail-translate-source')
    // Seeded with the caption already on screen, not blank — a blank picker
    // would read as a fresh question rather than a correction of the label
    // shown above it. Removing the seeding in `toggleSourceChoice` → this
    // reads '' (the placeholder) instead of 'ru'.
    await expect(sourceSelect).toHaveValue('ru')
    const applyButton = page.getByTestId('mail-translate-source-apply')
    // Nothing has changed yet, so re-running the request would reproduce the
    // identical label — the control must look inert rather than spend a click
    // to prove it. Removing the "already equals the caption" half of
    // `canApplySourceLang` → this reads enabled here.
    await expect(applyButton).toBeDisabled()

    await sourceSelect.selectOption('uk')
    await expect(applyButton).toBeEnabled()
    await applyButton.click()

    // The caption changed to the reader's own statement...
    await expect(notice).toContainText('from Ukrainian into', { timeout: EXPECT_TIMEOUT })
    // ...the translated text on screen is untouched (the same cached answer,
    // not a re-translation)...
    await expect(translated).toHaveText('Good afternoon, this is the e2e stub reply.')
    // ...and restating the caption never asked the provider again — the
    // actual guarantee §3.3.B6.f2 exists to make true. If the restate button
    // dispatched a fresh generation instead of reusing the cache entry, this
    // count would read 2.
    expect(stub.requestCount()).toBe(1)
  } finally {
    await teardownWithStub(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// The four checks below close a manual-QA gap the qa-plan agent flagged as
// Playwright-reachable but not yet automated. Each proves invalidation
// against a REAL DOM in a live window; the state-machine half of each
// guarantee (that `useMailTranslation` actually drops the stale token / view
// on message change, target change, or `enabled` going false) is already
// unit-tested and mutation-checked in `useMailTranslation.test.ts` — see that
// file's own header for the four reset assertions. What only e2e can show is
// that the reset really reaches the painted DOM through the real hook wiring
// in `App.tsx` / `MailBodyContent.tsx`, not a mock.
// ---------------------------------------------------------------------------

test('B6: switching to a different message while a translation request is in flight discards the stale response instead of letting it land on the new message', async () => {
  const STALE_REPLY = 'Stale reply that must never reach the second message.'
  const stub = await startGatedTranslateStub(STALE_REPLY)
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-stale-switch-'))
    const page = ctx.page!
    await configureTranslateStub(page, stub.url)

    const first = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(first).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(first)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const action = page.getByTestId('mail-translate-action')
    await expect(action).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await action.click()
    await expect(action).toBeDisabled()

    // Deterministic sync point: the message switch below has to land strictly
    // between the request dispatching and the response arriving. Waiting on
    // the real network round trip (the stub only answers `req.on('end')`)
    // instead of a fixed delay avoids the exact race
    // `quick-actions-diff-preview.spec.ts` already documents for the same
    // shape of test.
    await stub.requestReceived

    const second = page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' }).first()
    await expect(second).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(second)
    await expect(page.getByTestId('mail-subject')).toHaveText(/второе письмо/i, { timeout: EXPECT_TIMEOUT })

    // The bar under the SECOND message must already read idle — opening it
    // bumped `requestIdRef` synchronously in the reset effect, well before the
    // first message's response can arrive.
    await expect(page.getByTestId('mail-translate-action')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-translate-action')).toBeEnabled()
    await expect(page.getByTestId('mail-body-translated')).toHaveCount(0)

    // NOW let the stale response through. Deleting the
    // `if (requestId !== requestIdRef.current) return` guard in
    // `useMailTranslation.request()`'s success branch is exactly what would
    // make STALE_REPLY appear under the second message a moment after this.
    stub.release()
    await page.waitForTimeout(500)
    await expect(page.getByTestId('mail-body-translated')).toHaveCount(0)
    await expect(page.getByTestId('mail-translate-action')).toBeVisible()
    await expect(page.locator('body')).not.toContainText(STALE_REPLY)
  } finally {
    await teardownWithStub(ctx, stub)
  }
})

test('B6: changing the target language while a translation is showing clears it and returns the button to "Translate"', async () => {
  const REPLY = 'Good afternoon, this is the e2e stub reply.'
  const stub = await startTranslateStub(REPLY)
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-retarget-'))
    const page = ctx.page!
    await configureTranslateStub(page, stub.url)

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(mail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await page.getByTestId('mail-translate-action').click()
    const translated = page.getByTestId('mail-body-translated')
    await expect(translated).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(translated).toHaveText(REPLY)

    // The target select seeds from the interface locale, which the e2e
    // profile runs in English — pick a genuinely DIFFERENT code so the
    // change handler fires at all.
    const targetSelect = page.getByTestId('mail-translate-target')
    await expect(targetSelect).toHaveValue('en')
    await targetSelect.selectOption('de')

    // Deleting the invalidation branch of `setTargetLang`
    // (useMailTranslation.ts — the `requestIdRef.current++` / `setTranslation(null)`
    // block) would leave REPLY on screen under the newly picked target and
    // the two-way switch (`mail-translate-toggle`) still rendered instead of
    // the pre-request action button.
    await expect(page.getByTestId('mail-body-translated')).toHaveCount(0)
    await expect(page.getByTestId('mail-translate-toggle')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText(REPLY)
    const action = page.getByTestId('mail-translate-action')
    await expect(action).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(action).toHaveText('Translate')

    // The reading pane is not left blank — the original body is what shows.
    await expect(page.getByTestId('mail-body-text')).toBeVisible()
  } finally {
    await teardownWithStub(ctx, stub)
  }
})

test('B6: turning the per-account toggle off in Settings while a translation is showing snaps the reading pane back to the original immediately', async () => {
  const REPLY = 'Good afternoon, this is the e2e stub reply.'
  const stub = await startTranslateStub(REPLY)
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-toggleoff-'))
    const page = ctx.page!
    const browser = ctx.browser!
    await configureTranslateStub(page, stub.url)

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(mail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const originalBody = await page.getByTestId('mail-body-text').textContent()

    await page.getByTestId('mail-translate-action').click()
    const translated = page.getByTestId('mail-body-translated')
    await expect(translated).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(translated).toHaveText(REPLY)

    const settings = await openAiSettingsTab(page, browser)
    const toggle = settings.getByTestId('settings-ai-consent-translate-1')
    await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(toggle).toBeChecked()
    await toggle.uncheck()
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Deleting the `enabled` dependency of the reset effect in
    // `useMailTranslation` (or the `active` gate around `MailTranslateBar` in
    // `MailBodyContent`) is exactly what would leave REPLY on screen here even
    // though the account-level setting just went off — this asserts the
    // `settings:save` → `settings:changed` broadcast → App.tsx state →
    // useMailTranslation `enabled` prop chain reaches the DOM without a
    // message reopen or a window reload.
    await expect(page.getByTestId('mail-translate-bar')).toHaveCount(0)
    await expect(page.getByTestId('mail-body-translated')).toHaveCount(0)
    await expect(page.getByTestId('mail-body-text')).toHaveText(originalBody ?? '')
    await expect(page.locator('body')).not.toContainText(REPLY)
  } finally {
    await teardownWithStub(ctx, stub)
  }
})

test('B6: the toggle switch and the source-restate control expose live aria-pressed / aria-expanded state through the accessibility tree', async () => {
  // Role-based locators (`getByRole(..., { pressed, expanded })`) resolve
  // through Playwright's accessibility-tree computation, not a literal
  // `aria-*` attribute string match — `toHaveAttribute('aria-expanded', ...)`
  // (already used above for the same button) only proves the markup carries
  // the right text, not that a real accessibility client would see the right
  // state. This test proves the latter, and additionally proves
  // `aria-controls` really names an element that appears exactly when the
  // control it names reports itself expanded.
  const REPLY = 'Good afternoon, this is the e2e stub reply.'
  const stub = await startTranslateStub(REPLY)
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-translate-a11y-'))
    const page = ctx.page!
    await configureTranslateStub(page, stub.url)

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(mail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await page.getByTestId('mail-translate-action').click()
    await expect(page.getByTestId('mail-body-translated')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // A translation just landed, so the hook already shows it: the switch
    // reads pressed=true, labelled "Show original". Removing
    // `aria-pressed={state.showingTranslation}` in MailTranslateBar does not
    // make this read `pressed: false` — Playwright's role engine excludes an
    // element with no `aria-pressed` from a `pressed`-filtered query
    // entirely, so this locator would resolve to nothing and the assertion
    // below would time out rather than read a stale value.
    const showingOriginalLabel = page.getByRole('button', { name: 'Show original', pressed: true })
    await expect(showingOriginalLabel).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await showingOriginalLabel.click()
    await expect(page.getByRole('button', { name: 'Show translation', pressed: false })).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByRole('button', { name: 'Show original' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Show translation', pressed: false }).click()

    // The restate door requires a translation that IS captioned
    // (`canRestateSourceLang`); this fixture's body sits under
    // `LANGUAGE_DETECTION_MIN_SCRIPT_CHARS`, so the first translation comes back
    // uncaptioned — answer the offer once, exactly as the restate-cache test
    // above does, purely to reach the state this test is actually about.
    await expect(page.getByTestId('mail-translate-source-offer')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await page.getByTestId('mail-translate-source').selectOption('ru')
    await page.getByTestId('mail-translate-source-apply').click()
    await expect(page.getByTestId('mail-translate-source-offer')).toHaveCount(0)

    const restate = page.getByRole('button', { name: 'Not the right language?', expanded: false })
    await expect(restate).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // The controlled region is not rendered AT ALL while collapsed
    // (`sourceChoiceVisible` false) — its absence here is the baseline the
    // next assertion proves against.
    await expect(page.locator('#mail-translate-source-choice')).toHaveCount(0)
    const controlsId = await restate.getAttribute('aria-controls')
    expect(controlsId).toBe('mail-translate-source-choice')

    await restate.click()

    // Removing `aria-expanded={state.sourceChoiceOpen}` has the same failure
    // mode as the toggle above: the role-based locator stops resolving to
    // this element and this assertion times out instead of reading `false`.
    await expect(page.getByRole('button', { name: 'Not the right language?', expanded: true })).toBeVisible({ timeout: EXPECT_TIMEOUT })
    // The id `aria-controls` names is really on screen now, not just a string
    // that happens to match nothing.
    await expect(page.locator(`#${controlsId}`)).toBeVisible()
  } finally {
    await teardownWithStub(ctx, stub)
  }
})
