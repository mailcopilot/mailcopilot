import { test, expect } from '@playwright/test'
import {
  launchApp,
  cleanupApp,
  waitForPage,
  EXPECT_TIMEOUT,
  type AppContext,
} from './helpers'

// Covers 2.2-E un-hide of Outlook provider in the account wizard:
// - All three provider cards are present and layout-consistent.
// - Outlook card carries an SVG logo (brand asset, not a generic icon).
// - Keyboard navigation between cards works.
// - Clicking Outlook in e2e mode does NOT crash the renderer — the
//   OAuth service throws "not available in e2e mode", we surface a
//   recoverable error, wizard stays usable.
//
// Graph send path and real OAuth browser flow cannot be exercised in e2e
// (MAILCOPILOT_E2E=1 gates OAuth and stubs IMAP/SMTP); those require
// manual QA per docs/qa/*.

test.describe('account wizard: Outlook provider card (2.2-E)', () => {
  test('all three provider cards render with the Outlook card visible', async () => {
    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp())
      const page = ctx.page!
      const browser = ctx.browser!

      await page.evaluate(() => window.api.invoke('ui:openAccount'))
      const account = await waitForPage(browser, p => p.url().includes('#/account'))
      await account.waitForLoadState('domcontentloaded')

      await expect(account.getByTestId('account-wizard-provider')).toBeVisible({ timeout: EXPECT_TIMEOUT })

      const gmailCard = account.locator('#provider-card-gmail')
      const outlookCard = account.locator('#provider-card-outlook')
      const imapCard = account.locator('#provider-card-generic-imap')

      await expect(gmailCard).toBeVisible()
      await expect(outlookCard).toBeVisible()
      await expect(imapCard).toBeVisible()

      // Each card carries a brand/icon SVG (GmailLogo / OutlookLogo / Plug).
      await expect(gmailCard.locator('svg')).toHaveCount(1)
      await expect(outlookCard.locator('svg')).toHaveCount(1)
      await expect(imapCard.locator('svg')).toHaveCount(1)

      // Layout parity: cards share the same rendered width (no lone
      // oversized card after re-adding Outlook).
      const widths = await Promise.all([gmailCard, outlookCard, imapCard].map(async loc => {
        const box = await loc.boundingBox()
        return box?.width ?? -1
      }))
      expect(widths.every(w => w > 0)).toBe(true)
      const minW = Math.min(...widths)
      const maxW = Math.max(...widths)
      // Allow 2px drift for sub-pixel layout; any wider and we've regressed.
      expect(maxW - minW).toBeLessThanOrEqual(2)
    } finally {
      await cleanupApp(ctx)
    }
  })

  test('keyboard navigation moves focus across all three cards including Outlook', async () => {
    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp())
      const page = ctx.page!
      const browser = ctx.browser!

      await page.evaluate(() => window.api.invoke('ui:openAccount'))
      const account = await waitForPage(browser, p => p.url().includes('#/account'))
      await account.waitForLoadState('domcontentloaded')
      await expect(account.getByTestId('account-wizard-provider')).toBeVisible({ timeout: EXPECT_TIMEOUT })

      // Focus gmail card as the starting anchor.
      await account.locator('#provider-card-gmail').focus()
      await expect(account.locator('#provider-card-gmail')).toBeFocused()

      // ArrowDown: gmail → outlook (regression guard — in the hidden phase
      // ArrowDown went straight to generic-imap and skipped outlook).
      await account.keyboard.press('ArrowDown')
      await expect(account.locator('#provider-card-outlook')).toBeFocused()

      // ArrowDown: outlook → generic-imap.
      await account.keyboard.press('ArrowDown')
      await expect(account.locator('#provider-card-generic-imap')).toBeFocused()

      // Wrap-around: generic-imap → gmail.
      await account.keyboard.press('ArrowDown')
      await expect(account.locator('#provider-card-gmail')).toBeFocused()

      // ArrowUp: gmail → generic-imap (wrap back).
      await account.keyboard.press('ArrowUp')
      await expect(account.locator('#provider-card-generic-imap')).toBeFocused()

      // ArrowUp: generic-imap → outlook.
      await account.keyboard.press('ArrowUp')
      await expect(account.locator('#provider-card-outlook')).toBeFocused()
    } finally {
      await cleanupApp(ctx)
    }
  })

  test('Outlook card is enabled (not marked coming-soon) and clickable', async () => {
    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp())
      const page = ctx.page!
      const browser = ctx.browser!

      await page.evaluate(() => window.api.invoke('ui:openAccount'))
      const account = await waitForPage(browser, p => p.url().includes('#/account'))
      await account.waitForLoadState('domcontentloaded')
      await expect(account.getByTestId('account-wizard-provider')).toBeVisible({ timeout: EXPECT_TIMEOUT })

      const outlookCard = account.locator('#provider-card-outlook')
      // `aria-disabled` should be false/unset (the hidden phase used an
      // explicit disabled flag; re-enabling must not leave stray aria state).
      const ariaDisabled = await outlookCard.getAttribute('aria-disabled')
      expect(ariaDisabled === null || ariaDisabled === 'false').toBe(true)
      // The "Coming soon" badge is only rendered for disabled cards.
      await expect(outlookCard.locator('.provider-card__badge')).toHaveCount(0)
      // tabIndex must be 0 (keyboard-focusable).
      await expect(outlookCard).toHaveAttribute('tabindex', '0')
    } finally {
      await cleanupApp(ctx)
    }
  })

  test('clicking Outlook card in e2e mode surfaces a recoverable error, wizard stays usable', async () => {
    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp())
      const page = ctx.page!
      const browser = ctx.browser!

      await page.evaluate(() => window.api.invoke('ui:openAccount'))
      const account = await waitForPage(browser, p => p.url().includes('#/account'))
      await account.waitForLoadState('domcontentloaded')
      await expect(account.getByTestId('account-wizard-provider')).toBeVisible({ timeout: EXPECT_TIMEOUT })

      // In e2e mode, `connectOutlookAccount` throws "not available in e2e
      // mode". We want this to surface as a recoverable UI state — the
      // wizard should not crash, stuck spin, or navigate into an invalid
      // step. Acceptable end-states: (a) same provider step, (b) an
      // inline error banner, (c) a notification, (d) the window closed
      // by the caller — all are non-crashing. Reject only on renderer
      // crash (page closed unexpectedly before our assertions run) or
      // the wizard getting stuck on a blank/broken step.
      await account.locator('#provider-card-outlook').click()

      // Give the main process a moment to reject and the renderer to
      // surface the error.
      await account.waitForTimeout(500)

      // The page must not have crashed (Electron renderer still alive).
      expect(account.isClosed()).toBe(false)

      // The provider-picker or some subsequent valid wizard step should
      // still be visible — the renderer must not be blank.
      const stillHasProviderOrWizard = await account.evaluate(() => {
        return Boolean(
          document.querySelector('[data-testid="account-wizard-provider"]')
          || document.querySelector('[data-testid="account-wizard-type"]')
          || document.querySelector('[data-testid="account-wizard-credentials"]'),
        )
      })
      expect(stillHasProviderOrWizard).toBe(true)
    } finally {
      await cleanupApp(ctx)
    }
  })

  // §2.94 — the picker is now replaced by a waiting step for the duration of
  // the flow, so a failed connect must hand the picker back. Without the
  // restore the wizard would strand the user on a spinner that never resolves
  // (in e2e the connect rejects immediately, which is exactly the case that
  // exercises the restore path).
  test('a failed OAuth connect returns the wizard to the provider picker', async () => {
    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp())
      const page = ctx.page!
      const browser = ctx.browser!

      await page.evaluate(() => window.api.invoke('ui:openAccount'))
      const account = await waitForPage(browser, p => p.url().includes('#/account'))
      await account.waitForLoadState('domcontentloaded')
      await expect(account.getByTestId('account-wizard-provider')).toBeVisible({ timeout: EXPECT_TIMEOUT })

      await account.locator('#provider-card-outlook').click()

      // The picker comes back...
      await expect(account.getByTestId('account-wizard-provider')).toBeVisible({ timeout: EXPECT_TIMEOUT })
      // ...and the waiting step is gone, so nothing spins forever.
      await expect(account.getByTestId('account-wizard-oauth-waiting')).toHaveCount(0)
      // Retry must be possible: the provider cards are interactive again.
      await expect(account.locator('#provider-card-gmail')).toBeEnabled()
      await expect(account.locator('#provider-card-outlook')).toBeEnabled()
    } finally {
      await cleanupApp(ctx)
    }
  })
})
