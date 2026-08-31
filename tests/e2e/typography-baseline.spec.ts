/**
 * E2E spec: §2.79 — single typographic baseline.
 *
 * The renderer has exactly ONE base font-size declaration (`body` in
 * src/index.css). Everything that does not set its own size inherits it, and
 * nothing is allowed to fall through to the browser's 16px default again.
 *
 * Why e2e and not a unit test: the defect is a *cascade* property. It only
 * exists in a real engine with the real UA stylesheet — jsdom does not compute
 * inherited font sizes the way Chromium does, and the whole point of the bug
 * was "no rule matched, so the UA default won". So the assertions here read
 * `getComputedStyle` out of live windows.
 *
 * All four shells are checked because they are the same document routed by
 * hash: a base size accidentally re-declared per window (on `#root`, on
 * `.window-container`, ...) would show up as a divergence between them.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, type AppContext } from './helpers'

/** The one baseline. Keep in sync with `body { font-size }` in src/index.css. */
const BASELINE = '13px'

async function bodyFontSize(page: Page): Promise<string> {
  return await page.evaluate(() => getComputedStyle(document.body).fontSize)
}

test('typography: every window shell resolves to the single baseline', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-typo-'))
    const page = ctx.page!
    const browser = ctx.browser!

    // Main window.
    expect(await bodyFontSize(page)).toBe(BASELINE)

    // Compose.
    await page.locator('.sidebar-compose-btn').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    expect(await bodyFontSize(compose)).toBe(BASELINE)
    await compose.close()

    // Settings.
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible()
    expect(await bodyFontSize(settings)).toBe(BASELINE)

    // Account wizard — opened from Settings so the fixture account stays intact.
    await settings.evaluate(() => (window as unknown as {
      api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> }
    }).api.invoke('ui:openAccount', 'new'))
    const account = await waitForPage(browser, p => p.url().includes('#/account'))
    await account.waitForLoadState('domcontentloaded')
    await expect(account.getByTestId('account-wizard-provider')).toBeVisible()
    expect(await bodyFontSize(account)).toBe(BASELINE)
    await account.close()
    await settings.close()
  } finally {
    await cleanupApp(ctx)
  }
})

test('typography: Settings body text inherits the baseline instead of the 16px browser default', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-typo-settings-'))
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible()

    // Settings is where the defect was visible: `.hint` is styled only under
    // `.window-container` (Compose/Account), so inside the Settings shell it
    // matched no size rule at all and rendered at the browser's 16px — larger
    // than the 13px controls it described. Asserted by class, not by copy: e2e
    // fixtures default to Russian, so matching English strings would silently
    // find nothing.
    //
    // Scoped to the General tab and to direct children on purpose — a few
    // hints elsewhere carry an inline font-size, and this assertion is about
    // elements that declare no size of their own.
    await settings.getByTestId('settings-tab-general').click()
    await expect(settings.locator('.settings-content .form-section').first()).toBeVisible()

    const sizes = await settings.evaluate(() =>
      Array.from(document.querySelectorAll('.settings-content .form-section > .hint'))
        .filter(el => (el.textContent || '').trim().length > 0)
        .filter(el => !(el as HTMLElement).style.fontSize)
        .map(el => getComputedStyle(el).fontSize),
    )

    expect(sizes.length).toBeGreaterThan(0)
    for (const size of sizes) expect(size).toBe(BASELINE)

    await settings.close()
  } finally {
    await cleanupApp(ctx)
  }
})

test('typography: `font: inherit` surfaces pin their own size and ignore the ancestor scale', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-typo-inherit-'))
    const page = ctx.page!
    const browser = ctx.browser!

    await page.locator('.sidebar-compose-btn').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    // `.quick-action-diff-text` and `.instant-reply-option` are not reachable
    // through the UI in e2e — no AI provider is configured for any fixture
    // account, so both features short-circuit to a `no_provider` refusal before
    // rendering (the same limitation documented at length in
    // tests/e2e/quick-actions-instant-reply.spec.ts). What this test needs to
    // prove is a pure cascade property of those two classes, so it mounts them
    // under a deliberately oversized ancestor: before §2.79 their `font:
    // inherit` would have adopted the ancestor's 22px (and, with no ancestor
    // size at all, the browser's 16px). They must now hold the baseline.
    const measured = await compose.evaluate(() => {
      const host = document.createElement('div')
      host.style.fontSize = '22px'
      host.innerHTML =
        '<pre class="quick-action-diff-text">x</pre>' +
        '<button class="instant-reply-option">x</button>'
      document.body.appendChild(host)
      const read = (sel: string) =>
        getComputedStyle(host.querySelector(sel) as Element).fontSize
      const out = {
        diff: read('.quick-action-diff-text'),
        option: read('.instant-reply-option'),
        host: getComputedStyle(host).fontSize,
      }
      host.remove()
      return out
    })

    expect(measured.host).toBe('22px') // the ancestor really is oversized
    expect(measured.diff).toBe(BASELINE)
    expect(measured.option).toBe(BASELINE)

    await compose.close()
  } finally {
    await cleanupApp(ctx)
  }
})

test('typography: Settings > Templates heading stays pinned instead of the UA `em` default', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-typo-templates-'))
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible()

    // Templates is the only tab that heads its section with a bare <h2> —
    // every other tab uses `.form-section > h3`, which already carries an
    // explicit size elsewhere in App.css. Without the §2.79 pin, this <h2>
    // falls through to the browser's `h2 { font-size: 1.5em }` UA rule and
    // resolves against the 13px baseline to a fractional 19.5px instead of
    // the 18px every other window header uses. This is the one place the
    // baseline change would have visibly regressed a heading, so it gets its
    // own assertion rather than relying on the generic shell checks above.
    await settings.getByTestId('settings-tab-templates').click()
    const heading = settings.locator('.settings-section h2')
    await expect(heading).toBeVisible()
    expect(await heading.evaluate(el => getComputedStyle(el).fontSize)).toBe('18px')

    await settings.close()
  } finally {
    await cleanupApp(ctx)
  }
})

test('typography: AI provider wizard links hold an integer size, not a fraction of the baseline', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-typo-ai-links-'))
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible()

    // `.ai-back-link` / `.ai-reset-link` used to carry `font-size: 0.85em`.
    // Nothing between them and `body` declares a size, so after §2.79 the
    // relative value resolved to a fractional 11.05px (0.85 × 13) — the exact
    // class of defect the Templates heading above was pinned against. They are
    // now pinned to 12px, and this assertion is what makes that value
    // deliberate rather than incidental.
    await settings.getByTestId('settings-tab-ai').click()
    await expect(settings.getByTestId('settings-ai-provider')).toBeVisible()

    // Picking a provider is a local state change only (no key, no save), which
    // moves the wizard to the step that renders the "back" link.
    await settings.locator('.ai-provider-buttons .btn').first().click()
    const backLink = settings.locator('.ai-back-link')
    await expect(backLink).toBeVisible()
    expect(await backLink.evaluate(el => getComputedStyle(el).fontSize)).toBe('12px')

    // `.ai-reset-link` only renders once a provider is *saved*, which needs a
    // real API key (covered end-to-end in ai-key-persistence.spec.ts). What is
    // asserted here is the same pure cascade property, so the class is mounted
    // under a deliberately oversized ancestor: an `em`-based size would follow
    // that ancestor, an integer pin does not.
    const measured = await settings.evaluate(() => {
      const host = document.createElement('div')
      host.style.fontSize = '22px'
      host.innerHTML = '<button class="btn-link ai-reset-link">x</button>'
      document.body.appendChild(host)
      const out = {
        reset: getComputedStyle(host.querySelector('.ai-reset-link') as Element).fontSize,
        host: getComputedStyle(host).fontSize,
      }
      host.remove()
      return out
    })

    expect(measured.host).toBe('22px') // the ancestor really is oversized
    expect(measured.reset).toBe('12px')

    await settings.close()
  } finally {
    await cleanupApp(ctx)
  }
})
