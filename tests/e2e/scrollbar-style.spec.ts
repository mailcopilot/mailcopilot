/**
 * E2E: one scrollbar style for every scrollable area (index.css `* { scrollbar-width: thin }`).
 *
 * The thin bar used to be declared on four unrelated containers (chat body, folder list, select
 * listbox, mail body iframe); the message list and the settings pages had no rule and showed the
 * wide system bar next to them. The assertions read computed style from the live engine because the
 * defect is "no rule matched": jsdom does not resolve `scrollbar-width`.
 *
 * What has to break for this to go red: remove the `*` rule from src/index.css (the list and the
 * settings content fall back to `auto`) or give any scroll container its own width/colour.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, cleanupApp, clickMailItem, waitForPage, EXPECT_TIMEOUT, type AppContext } from './helpers'

interface ScrollStyle { width: string; color: string }

/** Computed scrollbar style of the nearest scrollable ancestor (or the element itself). */
async function scrollAncestorStyle(page: Page, testId: string): Promise<ScrollStyle> {
  return await page.evaluate((id) => {
    let el: HTMLElement | null = document.querySelector(`[data-testid="${id}"]`)
    while (el) {
      const oy = getComputedStyle(el).overflowY
      if (oy === 'auto' || oy === 'scroll') {
        const cs = getComputedStyle(el)
        return { width: cs.scrollbarWidth, color: cs.scrollbarColor }
      }
      el = el.parentElement
    }
    throw new Error(`no scrollable ancestor for ${id}`)
  }, testId)
}

test('scrollbars: list, reader, chat and settings share one thin style', async () => {
  const testInfo = test.info()
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-scrollbar-'))
    const page = ctx.page!
    await page.setViewportSize({ width: 1400, height: 900 })

    const firstMail = page.getByTestId('mail-item').first()
    await expect(firstMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const list = await scrollAncestorStyle(page, 'mail-item')
    expect(list.width).toBe('thin')

    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: /html/i }).first())
    const frame = page.locator('iframe.mail-iframe')
    await expect(frame).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const reader = await frame.evaluate((f) => {
      const cs = getComputedStyle((f as HTMLIFrameElement).contentDocument!.documentElement)
      return { width: cs.scrollbarWidth, color: cs.scrollbarColor }
    })
    expect(reader.width).toBe('thin')

    // Past the privacy screen, so the chat body (the scroll container) exists. Nothing is ever sent.
    await page.evaluate(async () => {
      const api = (window as unknown as { api: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }).api
      await api.invoke('settings:save', {
        aiProvider: 'openai-api',
        aiOpenAiBaseUrl: 'http://127.0.0.1:11434/v1',
        aiPrivacyConsent: true,
      })
    })
    await page.getByTestId('sidebar-ai').click()
    await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const chat = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('[data-testid="ai-body"]')!)
      return { width: cs.scrollbarWidth, color: cs.scrollbarColor }
    })
    expect(chat.width).toBe('thin')
    // The fixture mailbox is too short to scroll. For the screenshots only (every assertion above and
    // below reads computed style), pad each area so a bar is actually drawn.
    await page.evaluate(() => {
      const pad = (el: Element | null | undefined) => {
        if (!el) return
        const d = document.createElement('div')
        d.style.cssText = 'height:3000px;flex:none'
        el.appendChild(d)
      }
      let scroller: Element | null = document.querySelector('[data-testid="mail-item"]')
      while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
      pad(scroller)
      pad(document.querySelector('[data-testid="ai-body"]'))
      const doc = (document.querySelector('iframe.mail-iframe') as HTMLIFrameElement | null)?.contentDocument
      if (doc) { const d = doc.createElement('div'); d.style.height = '3000px'; doc.body.appendChild(d) }
    })

    // Both themes: the bar follows --border, so the list and the chat agree in each one.
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
      const pair = await page.evaluate(() => {
        const colorOf = (el: Element) => getComputedStyle(el).scrollbarColor
        const listEl = document.querySelector('[data-testid="mail-item"]')!.closest('[class]')!
        let scroller: Element | null = listEl
        while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
        return { list: colorOf(scroller!), chat: colorOf(document.querySelector('[data-testid="ai-body"]')!) }
      })
      expect(pair.list).toBe(pair.chat)
      await page.screenshot({ path: testInfo.outputPath(`scrollbars-main-${theme}.png`) })
    }

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(ctx.browser!, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const settingsStyle = await settings.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.settings-content')!)
      return { width: cs.scrollbarWidth, color: cs.scrollbarColor }
    })
    expect(settingsStyle.width).toBe('thin')
    await settings.screenshot({ path: testInfo.outputPath('scrollbars-settings.png') })

    // Same colour everywhere in the main document (the iframe resolves it from its own literal).
    expect(chat.color).toBe(list.color)
    expect(settingsStyle.color).toBe(list.color)
  } finally {
    await cleanupApp(ctx)
  }
})
