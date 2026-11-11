/**
 * The Cc/Bcc toggle sits beside the To field, not on top of it: there is a gap
 * between the field and the button, and the button is centred on the field's
 * first line. Checked in both themes, in the longest locales and in a narrow
 * window. Set COMPOSE_LAYOUT_SHOTS=<dir> to also write a screenshot per case.
 */
import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs/promises'
import { launchApp, cleanupApp, waitForPage, EXPECT_TIMEOUT, type AppContext } from './helpers'

const CASES = [
  { lang: 'ru', theme: 'dark', width: 900 },
  { lang: 'ru', theme: 'light', width: 900 },
  { lang: 'de', theme: 'dark', width: 900 },
  { lang: 'fr', theme: 'light', width: 900 },
  { lang: 'ru', theme: 'dark', width: 420 },
  { lang: 'de', theme: 'light', width: 420 },
] as const

async function openCompose(app: AppContext): Promise<Page> {
  await app.page.locator('.sidebar-compose-btn').click()
  const compose = await waitForPage(app.browser, p => p.url().includes('#/compose'))
  await compose.waitForLoadState('domcontentloaded')
  return compose
}

test('compose: the Cc/Bcc toggle keeps a gap from the To field and is aligned with it', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-cc-layout-'))
    const app = ctx as AppContext
    const shots = process.env.COMPOSE_LAYOUT_SHOTS
    if (shots) await fs.mkdir(shots, { recursive: true })

    for (const c of CASES) {
      await app.page.evaluate(async ([language, theme]) => {
        await window.api.invoke('settings:save', { language, theme })
      }, [c.lang, c.theme])
      await expect.poll(() => app.page.evaluate(() => document.documentElement.lang)).toBe(c.lang)

      const compose = await openCompose(app)
      await compose.setViewportSize({ width: c.width, height: 700 })
      const toggle = compose.getByTestId('compose-cc-toggle')
      await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT })

      const m = await compose.evaluate(() => {
        const rect = (el: Element | null) => el!.getBoundingClientRect()
        const row = rect(document.querySelector('.compose-to-row'))
        const field = rect(document.querySelector('.compose-to-row .compose-address-chips'))
        const btn = document.querySelector('[data-testid="compose-cc-toggle"]') as HTMLElement
        const b = btn.getBoundingClientRect()
        return {
          gap: b.left - field.right,
          overflowRight: b.right - row.right,
          centreDelta: (b.top + b.bottom) / 2 - (field.top + field.bottom) / 2,
          clipped: btn.scrollWidth > btn.clientWidth,
        }
      })
      const label = `${c.lang}/${c.theme}/${c.width}`
      expect(m.gap, `gap ${label}`).toBeGreaterThanOrEqual(8)
      expect(m.overflowRight, `inside the row ${label}`).toBeLessThanOrEqual(0.5)
      expect(Math.abs(m.centreDelta), `vertical alignment ${label}`).toBeLessThanOrEqual(2)
      expect(m.clipped, `label not clipped ${label}`).toBe(false)

      if (shots) await compose.screenshot({ path: path.join(shots, `compose-cc-${c.lang}-${c.theme}-${c.width}.png`) })
      await compose.evaluate(() => window.close()).catch(() => {})
    }
  } finally {
    await cleanupApp(ctx)
  }
})
