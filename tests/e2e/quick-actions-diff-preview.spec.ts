/**
 * E2E spec: §3.3.B4.f5 "Compose Quick Actions — merged diff preview panel"
 * (`src/components/QuickActionDiff.tsx`), positive-path coverage.
 *
 * `tests/e2e/quick-actions-instant-reply.spec.ts` deliberately stops at the
 * `no_provider` refusal — its file header explains why (no AI provider is
 * configured for any e2e fixture account, so a real rewrite never completes).
 * `tests/e2e/typography-baseline.spec.ts` injects `.quick-action-diff-text`
 * raw HTML into an isolated container, never mounting the real component.
 * Neither exercises a real preview→apply round trip: the panel's geometry,
 * backdrop click-outside, Escape handling, fold/collapse, plain-text toggle,
 * and the Replace/Insert body mutations were never driven against a live
 * Electron window.
 *
 * This file closes that gap by running a local HTTP stub inside the spec
 * process, standing in for an OpenAI-compatible `/v1/chat/completions`
 * endpoint, and pointing `aiOpenAiBaseUrl` at it (same address shape as
 * `ai-internet-gate.spec.ts` / `ai-key-persistence.spec.ts`, which point at
 * `127.0.0.1` but never listen there — this file is the first to actually
 * listen). `electron/services/ai.ts` `aiChatSimpleOutcome` posts to
 * `${baseUrl}/v1/chat/completions` with the standard OpenAI chat-completion
 * request shape and reads `choices[0].message.content` from the response, so
 * the stub only needs to speak that one shape (see the `startAiStub` helper).
 * `MAILCOPILOT_E2E=1` already keeps the API key off the OS keychain (§2.132),
 * so `ai:saveApiKey` here lands in the run's own encrypted disk fallback —
 * same guarantee `ai-key-persistence.spec.ts` pins directly.
 *
 * Every test opens a BLANK compose window (`sidebar-compose`) and fills the
 * whole body itself, rather than replying to a fixture email: `fill()` gives
 * full byte-level control over `splitComposeBody()`'s own/tail boundary
 * (§2.78), which several assertions below depend on (e.g. test 10 proves a
 * quoted original AND a signature survive Replace byte-for-byte). Using a
 * reply thread would add an uncontrolled localized attribution line for no
 * benefit — the boundary detector itself is unit-tested in
 * `packages/core/composeBody.test.ts`.
 *
 * The diff SEGMENTATION algorithm (block/word level, fold thresholds,
 * cleanup rules) is unit-tested exhaustively in
 * `packages/core/composeDiff.test.ts`. This file does not re-derive that
 * algorithm; it only proves the panel renders and wires it correctly against
 * a real DOM, real IPC round trip, and real textarea mutations.
 */
import { createRequire } from 'node:module'
import http from 'node:http'
import { test, expect, type Page } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, EXPECT_TIMEOUT, type AppContext } from './helpers'

// ---------------------------------------------------------------------------
// Interface copy, read from the EN locale (the rendered UI is always English
// regardless of the RU mail fixtures — see the note in
// quick-actions-instant-reply.spec.ts for why the two are independent).
// ---------------------------------------------------------------------------

const QUICK_ACTION_COPY = (
  createRequire(import.meta.url)('../../src/i18n/locales/en.json') as {
    ai: {
      quickAction: {
        preset: { improve: string; shorter: string; formal: string; grammar: string }
        diff: { changeCount_one: string; changeCount_other: string; noChanges: string }
      }
    }
  }
).ai.quickAction

const PRESET_LABELS = QUICK_ACTION_COPY.preset

/** Mirrors i18next's English one/other pluralization for `changeCount`. */
function changeCountText(count: number): string {
  const template = count === 1 ? QUICK_ACTION_COPY.diff.changeCount_one : QUICK_ACTION_COPY.diff.changeCount_other
  return template.replace('{{count}}', String(count))
}

// ---------------------------------------------------------------------------
// Local OpenAI-compatible stub
// ---------------------------------------------------------------------------

type ScriptedReply =
  | { kind: 'immediate'; text: string; delayMs?: number }
  | {
      /**
       * Blocks the HTTP response until the test calls `release()`, and
       * resolves `requestReceived` the instant the stub has read the whole
       * request body — i.e. the moment `aiChatSimpleOutcome` has actually
       * dispatched. Lets a test synchronize on the real network round trip
       * instead of guessing a `waitForTimeout` window (Codex Medium finding:
       * a fixed delay + fixed wait race on runner load).
       */
      kind: 'gated'
      text: string
      notifyReceived: () => void
      releasePromise: Promise<void>
    }

type AiStub = {
  url: string
  /** Queue one scripted assistant reply; requests are served FIFO. */
  queueResponse: (text: string, opts?: { delayMs?: number }) => void
  /** Queue a reply gated on an explicit release — see `ScriptedReply`'s `gated` variant. */
  queueGatedResponse: (text: string) => { requestReceived: Promise<void>; release: () => void }
  close: () => Promise<void>
}

/**
 * A minimal stand-in for `POST {baseUrl}/v1/chat/completions`
 * (`aiChatSimpleOutcome`'s `openai-api` branch, electron/services/ai.ts).
 * Reads and discards the request body (the system/user prompt — this file
 * does not assert on prompt content, that is covered by
 * `electron/services/ai.test.ts`'s `generateQuickActionRewrite` suite) and
 * replies with the next queued scripted text in the standard
 * `choices[0].message.content` shape. An empty queue replies with an empty
 * string rather than hanging, so a missing `queueResponse` call fails the
 * test on an assertion instead of a timeout.
 */
async function startAiStub(): Promise<AiStub> {
  const queue: ScriptedReply[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const next = queue.shift() ?? { kind: 'immediate', text: '' }
      const respond = (text: string) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{ message: { content: text } }],
          usage: { prompt_tokens: 12, completion_tokens: 12 },
        }))
      }
      if (next.kind === 'gated') {
        // The request body has been fully read at this point (`req.on('end')`
        // already fired) — that is the earliest observable proof the app's
        // fetch actually dispatched, so signal it before waiting for release.
        next.notifyReceived()
        void next.releasePromise.then(() => respond(next.text))
      } else if (next.delayMs) {
        setTimeout(() => respond(next.text), next.delayMs)
      } else {
        respond(next.text)
      }
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') return reject(new Error('failed to bind the AI stub'))
      resolve(addr.port)
    })
  })

  return {
    url: `http://127.0.0.1:${port}`,
    queueResponse: (text, opts) => queue.push({ kind: 'immediate', text, delayMs: opts?.delayMs }),
    queueGatedResponse: (text) => {
      let notifyReceived!: () => void
      const requestReceived = new Promise<void>(resolve => { notifyReceived = resolve })
      let release!: () => void
      const releasePromise = new Promise<void>(resolve => { release = resolve })
      queue.push({ kind: 'gated', text, notifyReceived, releasePromise })
      return { requestReceived, release }
    },
    // Propagate a `server.close()` failure (e.g. "not running") instead of
    // resolving unconditionally — Codex Medium finding: a swallowed close
    // error looks identical to a clean shutdown, so a leaked listening port
    // would never surface as anything but an unrelated flake in a later run.
    close: () => new Promise((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    }),
  }
}

/**
 * Runs `cleanupApp` and `stub.close()` unconditionally, even if one throws —
 * Codex Medium finding: the previous `finally { await cleanupApp(ctx); await
 * stub.close() }` pattern skipped the stub teardown whenever `cleanupApp`
 * rejected or hung, leaking the stub's listening socket into later test runs
 * (which then fail with an unrelated-looking bind/connect error). Both
 * outcomes are surfaced — a `cleanupApp` failure is the more actionable one
 * (crashed Electron process, stuck window) so it is thrown directly; a
 * `stub.close` failure occurring *in addition* is chained as `cause` rather
 * than dropped.
 */
async function teardown(ctx: Partial<AppContext>, stub: AiStub): Promise<void> {
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

/**
 * Point the app at the stub as its `openai-api` provider. `ai:saveApiKey`
 * writes a fake key through the real secretStore (disk fallback under
 * `MAILCOPILOT_E2E=1`, §2.132) — `generateQuickActionRewrite` requires a
 * truthy key before it will dispatch at all.
 */
async function configureOpenAiStub(page: Page, baseUrl: string): Promise<void> {
  await page.evaluate(async (url) => {
    const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
    await api.invoke('ai:saveApiKey', 'sk-e2e-quickaction-diff-stub', 'openai-api')
    const result = await api.invoke('settings:save', {
      aiProvider: 'openai-api',
      aiOpenAiBaseUrl: url,
      aiModel: 'gpt-4o-mini',
    }) as { ok: boolean; reason?: string }
    if (!result.ok) throw new Error(`settings:save failed: ${result.reason ?? 'unknown'}`)
  }, baseUrl)
}

/** Opens a blank Compose window and fills the whole body with `body`. */
async function openBlankComposeWithBody(ctx: AppContext, body: string): Promise<Page> {
  await ctx.page.getByTestId('sidebar-compose').click()
  const compose = await waitForPage(ctx.browser, p => p.url().includes('#/compose'))
  await compose.waitForLoadState('domcontentloaded')
  compose.on('dialog', d => d.accept())
  await compose.getByTestId('compose-text').fill(body)
  // Waits out the account-id bootstrap effect (canRun requires accountId != null).
  await expect(compose.getByTestId('compose-quick-action-improve')).toBeEnabled({ timeout: EXPECT_TIMEOUT })
  return compose
}

/** Points the real textarea caret at `pos`, bypassing React state entirely
 *  (matches how `getCaret` reads `bodyRef.current.selectionStart` lazily). */
async function setComposeCaret(compose: Page, pos: number): Promise<void> {
  await compose.getByTestId('compose-text').evaluate((el, p) => {
    const ta = el as HTMLTextAreaElement
    ta.focus()
    ta.setSelectionRange(p, p)
  }, pos)
}

/**
 * The real client-area size of `page`. `page.viewportSize()` returns `null`
 * for a window that was never handed an explicit viewport override — which
 * is every window here connected over CDP via `connectOverCDP` and never
 * `setViewportSize()`-ed (see the same fallback pattern in
 * `tests/e2e/tooltip-portal.spec.ts`'s `hoverForPortal`). Reading
 * `window.inner{Width,Height}` works unconditionally, override or not.
 */
async function realViewportSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
}

// ---------------------------------------------------------------------------
// 1. Opening the panel
// ---------------------------------------------------------------------------

test('quick action diff: a rewritten draft opens the panel and its backdrop', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-open-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    stub.queueResponse('Hi team, I wanted to update you on the project status this week.')
    const compose = await openBlankComposeWithBody(
      appCtx,
      'Hello team, I wanted to update you on the project status this week.',
    )
    await compose.getByTestId('compose-quick-action-improve').click()

    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(compose.getByTestId('quick-action-diff-backdrop')).toBeVisible()
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 2. Preset label identifies the clicked preset
// ---------------------------------------------------------------------------

test('quick action diff: the preset label names the clicked preset, not another one', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-preset-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    stub.queueResponse('Please send the report at your earliest convenience.')
    const compose = await openBlankComposeWithBody(appCtx, 'Please send the report soon.')
    await compose.getByTestId('compose-quick-action-formal').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const presetLabel = compose.getByTestId('quick-action-diff-preset')
    await expect(presetLabel).toHaveText(PRESET_LABELS.formal)
    await expect(presetLabel).not.toHaveText(PRESET_LABELS.improve)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 3. Change count — singular and plural forms
// ---------------------------------------------------------------------------

test('quick action diff: change count reads "1 change" for a single edit', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-count1-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    // Two lines, only the first changes — one line-level block, one edit.
    stub.queueResponse('Please review the attached document and share feedback.\nThanks.')
    const compose = await openBlankComposeWithBody(
      appCtx,
      'Please review the attached document and send feedback.\nThanks.',
    )
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await expect(compose.getByTestId('quick-action-diff-count')).toHaveText(changeCountText(1))
  } finally {
    await teardown(ctx, stub)
  }
})

test('quick action diff: change count reads "N changes" for multiple edits', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-count3-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    // Five lines, lines 1/3/5 change and 2/4 stay identical — three separate
    // line-level blocks (adjacent unchanged lines keep the changes apart).
    const original = [
      'Line one begins the draft.',
      'Line two never changes.',
      'Line three needs revision today.',
      'Line four never changes.',
      'Line five wraps up the note.',
    ].join('\n')
    const rewritten = [
      'Line one now begins the draft.',
      'Line two never changes.',
      'Line three needs a revision today.',
      'Line four never changes.',
      'Line five now wraps up the note.',
    ].join('\n')

    stub.queueResponse(rewritten)
    const compose = await openBlankComposeWithBody(appCtx, original)
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await expect(compose.getByTestId('quick-action-diff-count')).toHaveText(changeCountText(3))
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 4. Byte-identical rewrite — "nothing to change"
// ---------------------------------------------------------------------------

test('quick action diff: a byte-identical rewrite shows "nothing to change" and no edit list', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-identical-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const original = 'Nothing needs to change in this message.'
    stub.queueResponse(original)
    const compose = await openBlankComposeWithBody(appCtx, original)
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await expect(compose.getByTestId('quick-action-diff-empty')).toBeVisible()
    await expect(compose.getByTestId('quick-action-diff-empty')).toHaveText(QUICK_ACTION_COPY.diff.noChanges)
    await expect(compose.getByTestId('quick-action-diff-edits')).toHaveCount(0)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 5. Backdrop covers the whole window
// ---------------------------------------------------------------------------

test('quick action diff: the backdrop covers the entire compose viewport', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-backdrop-size-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    stub.queueResponse('Hi there, quick note before the meeting.')
    const compose = await openBlankComposeWithBody(appCtx, 'Hello there, quick note before the meeting.')
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const viewport = await realViewportSize(compose)
    const box = await compose.getByTestId('quick-action-diff-backdrop').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeLessThanOrEqual(0)
    expect(box!.y).toBeLessThanOrEqual(0)
    expect(box!.x + box!.width).toBeGreaterThanOrEqual(viewport.width)
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(viewport.height)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 6. Clicking the backdrop over the (hidden) textarea closes without mutating it
// ---------------------------------------------------------------------------

test('quick action diff: clicking the backdrop over the compose form closes the panel and leaves the draft untouched', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-backdrop-click-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const original = 'Hello there, quick note before the meeting.'
    stub.queueResponse('Hi there, quick note before the meeting.')
    const compose = await openBlankComposeWithBody(appCtx, original)

    // A tall window gives the (short, one-line-diff) panel plenty of headroom
    // above and below it, so a click can target a point that is provably both
    // (a) inside `compose-text`'s own bounding box and (b) above the panel's
    // top edge — unlike the previous y=5, which sat inside the 36px child-
    // window titlebar (`.child-titlebar`, src/App.css:3700-3712). Nothing
    // interactive lives in that titlebar strip, so "the draft stayed
    // untouched" held there even with the backdrop entirely missing; it
    // proved the click landed somewhere harmless, not that the backdrop
    // actually intercepted a click aimed at the compose form.
    await compose.setViewportSize({ width: 900, height: 1100 })
    const textBoxBefore = (await compose.getByTestId('compose-text').boundingBox())!

    // Instrument the textarea itself: a single physical click can only ever
    // hit ONE DOM element (the backdrop's own onClick and this listener are
    // mutually exclusive outcomes of the same click by hit-testing), so this
    // is defense-in-depth rather than a second independent signal — but it
    // makes the panel's actual claim ("the element under the click never saw
    // it") an explicit assertion instead of one the reader has to infer from
    // "the value didn't change."
    await compose.getByTestId('compose-text').evaluate((el) => {
      const ta = el as HTMLTextAreaElement
      ta.dataset.testClickCount = '0'
      ta.addEventListener('click', () => {
        ta.dataset.testClickCount = String(Number(ta.dataset.testClickCount) + 1)
      })
    })

    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Confirm the premise before relying on it: the click point below must
    // sit strictly above the panel's top edge, or this test would pass/fail
    // for the wrong reason (clicking the panel itself, not the backdrop).
    const panelBox = (await compose.getByTestId('quick-action-diff').boundingBox())!
    expect(panelBox.y).toBeGreaterThan(textBoxBefore.y + 20)

    const clickX = textBoxBefore.x + textBoxBefore.width / 2
    const clickY = textBoxBefore.y + 10
    // `page.mouse.click` (not `locator.click`) dispatches at the raw
    // coordinate, so a regression that grows the panel into this point fails
    // the assertion above, not the click itself hanging on actionability.
    await compose.mouse.click(clickX, clickY)

    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)
    await expect(compose.getByTestId('compose-text')).toHaveValue(original)
    await expect(compose.getByTestId('compose-text')).toHaveAttribute('data-test-click-count', '0')
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 7. Escape closes without mutating
// ---------------------------------------------------------------------------

test('quick action diff: Escape closes the panel and leaves the draft untouched', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-escape-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const original = 'Hello there, quick note before the meeting.'
    stub.queueResponse('Hi there, quick note before the meeting.')
    const compose = await openBlankComposeWithBody(appCtx, original)
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The panel focuses itself on mount (`panelRef.current.focus()`) — assert
    // that BEFORE pressing Escape, not just that Escape closed it. A global
    // Escape handler elsewhere in the app (or a future one) could close the
    // panel without the focus transfer ever having worked; without this
    // assertion that regression would stay invisible.
    await expect(compose.getByTestId('quick-action-diff')).toBeFocused()
    await compose.keyboard.press('Escape')

    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)
    await expect(compose.getByTestId('compose-text')).toHaveValue(original)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 8. Cancel button closes without mutating
// ---------------------------------------------------------------------------

test('quick action diff: the Cancel button closes the panel and leaves the draft untouched', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-cancel-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const original = 'Hello there, quick note before the meeting.'
    stub.queueResponse('Hi there, quick note before the meeting.')
    const compose = await openBlankComposeWithBody(appCtx, original)
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await compose.getByTestId('quick-action-diff-cancel').click()

    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)
    await expect(compose.getByTestId('compose-text')).toHaveValue(original)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 9. Header close (X) button closes without mutating
// ---------------------------------------------------------------------------

test('quick action diff: the header close button closes the panel and leaves the draft untouched', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-close-x-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const original = 'Hello there, quick note before the meeting.'
    stub.queueResponse('Hi there, quick note before the meeting.')
    const compose = await openBlankComposeWithBody(appCtx, original)
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await compose.getByTestId('quick-action-diff-close').click()

    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)
    await expect(compose.getByTestId('compose-text')).toHaveValue(original)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 10. Replace — §2.78: the quoted original and the signature survive verbatim
// ---------------------------------------------------------------------------

test('quick action diff: Replace swaps only the own text — the quoted original and signature survive byte-for-byte', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-replace-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const ownText = 'Please review the budget line.\nLet me know your thoughts.'
    // A `>`-quoted correspondent block followed by a `--` signature separator
    // (MailCopilot's own form, no trailing space — see composeBody.ts). Both
    // are structurally recognized tail material and must never reach the
    // model or be overwritten by Replace.
    const tail = '\n\n> Original correspondent line one.\n> Original correspondent line two.\n\n--\nSergey'
    const original = ownText + tail

    const rewrittenOwn = 'Please review the budget figures.\nShare your thoughts when you can.'
    stub.queueResponse(rewrittenOwn)

    const compose = await openBlankComposeWithBody(appCtx, original)
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    await compose.getByTestId('quick-action-diff-replace').click()

    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)
    await expect(compose.getByTestId('compose-text')).toHaveValue(rewrittenOwn + tail)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 11. Insert lands at the end of the user's own text, NOT at the caret
//     (§1.26.1 AC-9 / §2.252) — everything else byte-exact
// ---------------------------------------------------------------------------

test('quick action diff: Insert adds the rewrite below the own text and ignores the caret entirely', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-insert-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const original = 'Alpha.\nBeta.\nGamma.'
    const rewritten = 'Alpha REWRITTEN.\nBeta REWRITTEN.\nGamma REWRITTEN.'
    stub.queueResponse(rewritten)

    const compose = await openBlankComposeWithBody(appCtx, original)
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Put the caret in the MIDDLE of the draft, right after "Alpha.\n". The
    // insert must ignore it: the button now promises "below my text", one
    // behaviour on every draft. Before the fix this decided the landing spot,
    // and on a draft the user had never clicked into it was index 0 — above
    // their own first line, and in a reply above the quote too.
    await setComposeCaret(compose, 'Alpha.\n'.length)
    await compose.getByTestId('quick-action-diff-insert').click()

    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)
    // No tail is recognizable here, so the own text is the whole body and the
    // result lands at its end, separated by a single newline.
    await expect(compose.getByTestId('compose-text')).toHaveValue(original + '\n' + rewritten)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 12. Stale preview (§2.78 AC-h): Replace disabled and inert, Insert still works
// ---------------------------------------------------------------------------

test('quick action diff: editing the draft mid-flight marks the preview stale — Replace is disabled and inert, Insert still works', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-stale-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const original = 'Draft body before any edits.'
    const rewritten = 'Draft body rewritten by the AI.'
    // Gated rather than delayed: the edit below has to land strictly between
    // the request dispatching and the response arriving, and a fixed
    // delay/wait pair races on runner load — under contention the 400ms
    // response could beat the 120ms wait, and the "mid-flight edit" scenario
    // simply never happened while the assertions below still went green
    // (Codex Medium finding).
    const { requestReceived, release } = stub.queueGatedResponse(rewritten)

    const compose = await openBlankComposeWithBody(appCtx, original)
    await compose.getByTestId('compose-quick-action-improve').click()

    // Deterministic sync point: wait until the stub has actually received the
    // rewrite request, THEN edit, THEN let the response through — no timers.
    await requestReceived
    const editedBody = `${original} EXTRA EDIT WHILE PENDING.`
    await compose.getByTestId('compose-text').fill(editedBody)
    release()

    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(compose.getByTestId('quick-action-diff-stale')).toBeVisible()

    const replaceBtn = compose.getByTestId('quick-action-diff-replace')
    await expect(replaceBtn).toBeDisabled()
    // A forced click does NOT exercise `handleReplace`'s own `if (stale)
    // return` guard, and no DOM-level trick can make it: React 18 refuses to
    // invoke a `disabled`-bound element's onClick at the SyntheticEvent
    // dispatch layer itself (`shouldPreventMouseEvent` reading
    // `getFiberCurrentPropsFromNode`, react-dom.development.js) — it reads
    // its OWN last-rendered props, not the live DOM. Confirmed empirically:
    // even after `replaceBtn.evaluate(el => el.removeAttribute('disabled'))`
    // (so the raw DOM node is genuinely enabled and a native `click`
    // demonstrably fires) a real `.click()` still never reaches
    // `handleReplace` — no `ai.quick_action.preview_outcome` `replaced` event
    // is ever emitted. `disabled={stale}` and `if (stale) return` derive from
    // the exact same `stale` value in the exact same render, so they can
    // never diverge through this button: whatever blocks the click always
    // also disables it. This assertion is therefore the only DOM-observable
    // proof available — it holds regardless of `force`.
    await replaceBtn.click({ force: true })
    await expect(compose.getByTestId('compose-text')).toHaveValue(editedBody)
    // Replace refused — the panel is still open.
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible()

    // The insert action is the only way left to use this result, so it stays
    // enabled on a stale preview (§2.78 AC-h) — and it appends to the CURRENT
    // body, so the text typed during generation survives.
    await expect(compose.getByTestId('quick-action-diff-insert')).toBeEnabled()
    await compose.getByTestId('quick-action-diff-insert').click()
    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)
    await expect(compose.getByTestId('compose-text')).toHaveValue(editedBody + '\n' + rewritten)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 13. Folding a long unchanged region between two edits
// ---------------------------------------------------------------------------

const LONG_FILLER = 'Unchanged '.repeat(20).trim()

test('quick action diff: a long unchanged region between two edits folds and unfolds', async () => {
  expect(LONG_FILLER.length).toBeGreaterThan(160)

  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-fold-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const original = ['Opening line changes now.', LONG_FILLER, 'Closing line changes too.'].join('\n')
    const rewritten = ['Opening line has changed now.', LONG_FILLER, 'Closing line has changed too.'].join('\n')
    stub.queueResponse(rewritten)

    const compose = await openBlankComposeWithBody(appCtx, original)
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const fold = compose.getByTestId('quick-action-diff-fold')
    await expect(fold).toBeVisible()
    await expect(fold).toHaveAttribute('aria-expanded', 'false')
    await expect(compose.getByTestId('quick-action-diff-merged')).not.toContainText(LONG_FILLER.slice(0, 40))

    await fold.click()
    await expect(fold).toHaveAttribute('aria-expanded', 'true')
    await expect(compose.getByTestId('quick-action-diff-merged')).toContainText(LONG_FILLER)

    await fold.click()
    await expect(fold).toHaveAttribute('aria-expanded', 'false')
    await expect(compose.getByTestId('quick-action-diff-merged')).not.toContainText(LONG_FILLER.slice(0, 40))
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 14. Plain-text copies toggle and are exact
// ---------------------------------------------------------------------------

test('quick action diff: the plain-text toggle reveals byte-exact before/after copies', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-plaintext-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const original = 'Please review the quarterly numbers before Friday.'
    const rewritten = 'Please review the quarterly figures before Friday.'
    stub.queueResponse(rewritten)

    const compose = await openBlankComposeWithBody(appCtx, original)
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const panes = compose.getByTestId('quick-action-diff-plain-panes')
    await expect(panes).toBeHidden()

    const toggle = compose.getByTestId('quick-action-diff-plain-toggle')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(panes).toBeVisible()

    // Exact string equality, not a substring/normalized-text match — a
    // wrapping-quote or preamble-stripping regression in `cleanRewriteOutput`
    // would still satisfy `toContainText` but must fail this.
    expect(await compose.getByTestId('quick-action-diff-before').textContent()).toBe(original)
    expect(await compose.getByTestId('quick-action-diff-after').textContent()).toBe(rewritten)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(panes).toBeHidden()
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 15. Narrow window — panel width clamps to viewport minus margin
// ---------------------------------------------------------------------------

test('quick action diff: on a narrow window the panel width clamps to the viewport, not the 760px default', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-narrow-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const original = 'Hello there, quick note before the meeting.'
    stub.queueResponse('Hi there, quick note before the meeting.')
    const compose = await openBlankComposeWithBody(appCtx, original)

    const narrowWidth = 500
    await compose.setViewportSize({ width: narrowWidth, height: 700 })

    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const box = (await compose.getByTestId('quick-action-diff').boundingBox())!
    // CSS: width: min(760px, calc(100vw - 32px)) — at 500px viewport the
    // clamp wins: min(760, 468) = 468.
    const expectedWidth = Math.min(760, narrowWidth - 32)
    expect(Math.abs(box.width - expectedWidth)).toBeLessThanOrEqual(2)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(narrowWidth)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 16. Tall content — panel height clamps and the body scrolls internally
// ---------------------------------------------------------------------------

test('quick action diff: tall content clamps the panel height and scrolls inside the body region', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-tall-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const lineCount = 60
    const original = Array.from(
      { length: lineCount },
      (_, i) => `Original content line number ${i} needs a rewrite pass.`,
    ).join('\n')
    const rewritten = Array.from(
      { length: lineCount },
      (_, i) => `Rewritten content line number ${i} after the rewrite pass.`,
    ).join('\n')
    stub.queueResponse(rewritten)

    const compose = await openBlankComposeWithBody(appCtx, original)
    const shortHeight = 500
    await compose.setViewportSize({ width: 900, height: shortHeight })

    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const panelBox = (await compose.getByTestId('quick-action-diff').boundingBox())!
    // CSS: max-height: calc(100vh - 48px).
    expect(panelBox.height).toBeLessThanOrEqual(shortHeight - 48 + 1)

    const scrollMetrics = await compose.getByTestId('quick-action-diff-body').evaluate(el => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight)
  } finally {
    await teardown(ctx, stub)
  }
})

// ---------------------------------------------------------------------------
// 17. Fold/plain-text state resets between previews, never carried over
// ---------------------------------------------------------------------------

test('quick action diff: fold and plain-text state reset on a fresh preview instead of carrying over', async () => {
  const stub = await startAiStub()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-qadiff-reset-'))
    const appCtx = ctx as AppContext
    await configureOpenAiStub(appCtx.page, stub.url)

    const firstFiller = 'FirstFiller '.repeat(20).trim()
    const original1 = ['First opening line changes.', firstFiller, 'First closing line changes.'].join('\n')
    const rewritten1 = ['First opening line has changed.', firstFiller, 'First closing line has changed.'].join('\n')
    stub.queueResponse(rewritten1)

    const compose = await openBlankComposeWithBody(appCtx, original1)
    await compose.getByTestId('compose-quick-action-improve').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Expand both fold and plain text on the FIRST preview.
    await compose.getByTestId('quick-action-diff-fold').click()
    await expect(compose.getByTestId('quick-action-diff-fold')).toHaveAttribute('aria-expanded', 'true')
    await compose.getByTestId('quick-action-diff-plain-toggle').click()
    await expect(compose.getByTestId('quick-action-diff-plain-toggle')).toHaveAttribute('aria-expanded', 'true')

    // Dismiss via Insert (not Replace — avoids any quote/signature bookkeeping)
    // so the panel unmounts and a second, independent preview can be requested.
    await compose.getByTestId('quick-action-diff-insert').click()
    await expect(compose.getByTestId('quick-action-diff')).toHaveCount(0)

    // Overwrite the draft with a SECOND scenario, with its own foldable
    // unchanged region, and run a DIFFERENT preset.
    const secondFiller = 'SecondFiller '.repeat(20).trim()
    const original2 = ['Second opening line changes.', secondFiller, 'Second closing line changes.'].join('\n')
    const rewritten2 = ['Second opening line has changed.', secondFiller, 'Second closing line has changed.'].join('\n')
    stub.queueResponse(rewritten2)
    await compose.getByTestId('compose-text').fill(original2)
    await expect(compose.getByTestId('compose-quick-action-formal')).toBeEnabled({ timeout: EXPECT_TIMEOUT })
    await compose.getByTestId('compose-quick-action-formal').click()
    await expect(compose.getByTestId('quick-action-diff')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The fresh panel must NOT inherit the first preview's expanded state.
    await expect(compose.getByTestId('quick-action-diff-fold')).toHaveAttribute('aria-expanded', 'false')
    await expect(compose.getByTestId('quick-action-diff-plain-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(compose.getByTestId('quick-action-diff-plain-panes')).toBeHidden()
  } finally {
    await teardown(ctx, stub)
  }
})
