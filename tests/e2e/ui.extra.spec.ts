import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, clickMailItem, selectMcOption, getMcSelectValue, CLOSE_TIMEOUT, EXPECT_TIMEOUT, type AppContext } from './helpers'

// =============================================================================
// High priority
// =============================================================================

test('keyboard: j/k navigation between emails', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Open first email by clicking to set active
    await clickMailItem(page.getByTestId('mail-item').first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    const firstSubject = await page.getByTestId('mail-subject').textContent()

    // j — next email
    await page.keyboard.press('j')
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    const secondSubject = await page.getByTestId('mail-subject').textContent()
    expect(secondSubject).not.toBe(firstSubject)

    // k — previous email (go back)
    await page.keyboard.press('k')
    await expect(page.getByTestId('mail-subject')).toHaveText(firstSubject!)
  } finally {
    await cleanupApp(ctx)
  }
})

test('keyboard: c opens compose', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.keyboard.press('c')
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    await expect(compose.getByTestId('compose-to')).toBeVisible()

    // New email via "c" — fields should be empty (draft is NOT restored)
    await expect(compose.getByTestId('compose-to')).toHaveValue('')
    await expect(compose.getByTestId('compose-subject')).toHaveValue('')

    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('command palette: Ctrl+K opens palette and executes Compose command', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+K`)
    await expect(page.getByTestId('command-palette')).toBeVisible()
    await expect(page.getByTestId('command-palette-input')).toBeVisible()

    await page.getByTestId('command-palette-input').fill('compose')
    await page.keyboard.press('Enter')

    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    await expect(compose.getByTestId('compose-to')).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('conversation view: thread strip opens email from thread and preserves active row', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const threadRow = page.getByTestId('mail-item').filter({ hasText: 'E2E1: thread root' }).first()
    await clickMailItem(threadRow)
    await expect(page.getByTestId('mail-subject')).toHaveText('E2E1: thread root')

    // ThreadView replaces the old horizontal thread-strip: verify container visible
    const threadView = page.getByTestId('thread-view')
    await expect(threadView).toBeVisible()
    const threadCards = page.getByTestId('thread-card')
    await expect(threadCards).toHaveCount(2)

    // Open the reply card (index 0 = newest in newest-top order) by clicking its
    // collapsed header. It is not yet active; clicking it triggers onCardOpen →
    // openMail → changes activeKey to the reply.
    await threadCards.nth(0).locator('.thread-card-header').click()
    await expect(page.getByTestId('mail-subject')).toHaveText('Re: E2E1: thread root')
    // The originating row in the mail list must retain the selected (active) highlight.
    await expect(threadRow).toHaveClass(/mail-active/)

    // Navigation k should correctly move to the previous list row (from thread), not "get stuck".
    await page.keyboard.press('k')
    await expect(page.getByTestId('mail-subject')).not.toHaveText('Re: E2E1: thread root')
  } finally {
    await cleanupApp(ctx)
  }
})

test('command palette: conversation command toggles thread grouping', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const rows = page.getByTestId('mail-item').filter({ hasText: 'E2E1: thread root' })
    await expect(rows).toHaveCount(1)

    await page.keyboard.press(`${mod}+K`)
    await page.getByTestId('command-palette-input').fill('conversation')
    await page.keyboard.press('Enter')
    await expect(rows).toHaveCount(2)

    await page.keyboard.press(`${mod}+K`)
    await page.getByTestId('command-palette-input').fill('conversation')
    await page.keyboard.press('Enter')
    await expect(rows).toHaveCount(1)
  } finally {
    await cleanupApp(ctx)
  }
})

test('mail: privacy banner + inline cid images + show images', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Open HTML email.
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: 'E2E1: html письмо' }).first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    // External images blocked banner.
    const banner = page.getByTestId('images-blocked-banner')
    await expect(banner).toBeVisible()

    // Verify that cid: was replaced with data: in srcdoc (inline images).
    const iframe = page.locator('iframe.mail-iframe')
    await expect(iframe).toBeVisible()
    await expect.poll(async () => await iframe.getAttribute('srcdoc'), { timeout: EXPECT_TIMEOUT }).not.toBeNull()
    const srcdoc = (await iframe.getAttribute('srcdoc')) || ''
    expect(srcdoc).toContain("img-src 'self' data: cid:")
    expect(srcdoc).toContain('data:image/png;base64,')
    expect(srcdoc.toLowerCase()).not.toContain('cid:img1')

    // Link in iframe rewritten to internal protocol.
    const frame = page.frameLocator('iframe.mail-iframe')
    const link = frame.locator('a[href]').first()
    await expect(link).toHaveAttribute('href', /^mailcopilot-link:/)
    await expect(link).toHaveAttribute('title', /^https?:\/\//, { timeout: EXPECT_TIMEOUT })

    // Allow external images: banner click triggers main-process proxy to inline
    // external images as data: URIs. CSP stays hardened (`'self' data: cid:`)
    // regardless — the old behavior of relaxing img-src to `https: http: data: cid:`
    // was an SSRF/tracking vector and is gone. Full pre/post-banner CSP invariant
    // coverage lives in `mail-external-images.spec.ts`; here we only assert the
    // banner UI itself (button click dismisses the banner).
    await banner.locator('button').click()
    await expect(banner).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

// Suspicious link dialog test is skipped: clicking a link with mailcopilot-link:// protocol
// in srcdoc iframe triggers frame navigation, which Electron intercepts (will-frame-navigate),
// but Playwright blocks ALL operations (locators, evaluate, CDP) until navigation completes.
// Link rewriting check is covered by the test above (toHaveAttribute href/title).
// Link analysis logic is covered by unit test mailLinks.test.ts.

test('sidebar: expand/collapse and localStorage persistence', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const sidebar = page.locator('.mailcopilot-sidebar')
    const isExpanded = async () => (await sidebar.getAttribute('class'))?.includes('sidebar-expanded')

    // Default state is expanded for new users (no localStorage yet)
    await expect.poll(isExpanded).toBe(true)
    await expect(page.locator('.sidebar-label').first()).toBeVisible()

    // Click toggle — collapse
    await page.locator('.sidebar-toggle-btn').click()
    await expect.poll(isExpanded).toBe(false)

    // Verify localStorage
    const stored = await page.evaluate(() => localStorage.getItem('mailcopilot:sidebar'))
    expect(stored).toBe('0')

    // Click toggle — expand again
    await page.locator('.sidebar-toggle-btn').click()
    await expect.poll(isExpanded).toBe(true)

    const stored2 = await page.evaluate(() => localStorage.getItem('mailcopilot:sidebar'))
    expect(stored2).toBe('1')

    // Folder labels visible in expanded mode
    await expect(page.locator('.sidebar-label').first()).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('undo bar: archive + undo restores email', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: flagged письмо' }).first()
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    await page.getByTestId('mail-action-archive').click()

    // Email disappears from the list
    await expect(mail).toHaveCount(0)

    // Undo bar appears
    const undoBar = page.locator('.undo-bar')
    await expect(undoBar).toBeVisible()

    // Click "Undo"
    await undoBar.locator('button').click()

    // Undo bar disappears
    await expect(undoBar).toHaveCount(0)

    // Email returns to the list
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: flagged письмо' }).first()).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('undo move: sync race — message does not reappear during undo window', async () => {
  // §2.7: while the 5s undo bar is visible, the optimistic UI move has NOT
  // yet committed via IMAP. If the periodic IDLE/sync poll (or any
  // renderer-issued `net:inboxSummaries` / `cache:inboxPage`) fires in that
  // window, the source folder fetch will still see the message server-side
  // and would otherwise resurrect it into the list — undoing the user's
  // optimistic action visually. The pending-move registry in main filters
  // the fetch result so this race cannot happen.
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Open a known mail and archive it.
    const targetSubject = 'E2E1: flagged письмо'
    const mail = page.getByTestId('mail-item').filter({ hasText: targetSubject }).first()
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    await page.getByTestId('mail-action-archive').click()

    // Optimistic UI move — gone from the list, undo bar visible.
    await expect(mail).toHaveCount(0)
    const undoBar = page.locator('.undo-bar')
    await expect(undoBar).toBeVisible()

    // Race simulation: while undo bar is still visible, force a fresh
    // `net:inboxSummaries` fetch (same call the periodic sync makes). The
    // archived message must NOT come back in the result.
    const summaries = await page.evaluate(async (): Promise<Array<{ subject: string }>> => {
      return await window.api.invoke<Array<{ subject: string }>>('net:inboxSummaries', 1, 'INBOX')
    })
    expect(summaries.find(m => m.subject === targetSubject)).toBeUndefined()

    // And the UI must still not show it (no resurrection from the fetch).
    await expect(undoBar).toBeVisible()
    await expect(page.getByTestId('mail-item').filter({ hasText: targetSubject })).toHaveCount(0)

    // User clicks Undo — message returns to the list and the suppression is
    // dropped immediately so a follow-up fetch sees the UID again.
    await undoBar.locator('button').click()
    await expect(undoBar).toHaveCount(0)
    await expect(page.getByTestId('mail-item').filter({ hasText: targetSubject }).first()).toBeVisible()

    const afterUndo = await page.evaluate(async (): Promise<Array<{ subject: string }>> => {
      return await window.api.invoke<Array<{ subject: string }>>('net:inboxSummaries', 1, 'INBOX')
    })
    expect(afterUndo.find(m => m.subject === targetSubject)).toBeDefined()
  } finally {
    await cleanupApp(ctx)
  }
})

test('delayed send: email goes to Outbox and sends via Send now', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Enable send delay (Undo Send / queue path).
    await page.evaluate(async () => {
      const s = await window.api.invoke('settings:get') as Record<string, unknown>
      await window.api.invoke('settings:save', { ...s, sendDelaySeconds: 10 })
    })

    await page.getByTestId('sidebar-compose').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    const subject = `E2E delayed ${Date.now()}`
    await compose.getByTestId('compose-to').fill('delay@example.test')
    await compose.getByTestId('compose-subject').fill(subject)
    await compose.getByTestId('compose-text').fill('delayed send body')
    await compose.getByTestId('compose-send').click()
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Should not appear in Sent immediately.
    await page.getByTestId('folder-Sent').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: subject })).toHaveCount(0)

    // Should appear in Outbox.
    await page.getByTestId('folder-Outbox').click()
    const outboxItem = page.getByTestId('outbox-item').filter({ hasText: subject }).first()
    await expect(outboxItem).toBeVisible()

    // Force immediate send.
    await outboxItem.getByTestId('outbox-send-now').click()

    // After sync, email appears in Sent.
    await page.getByTestId('folder-Sent').click()
    await page.getByTestId('sidebar-sync').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: subject }).first()).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('delayed send: undo bar cancels queued send and restores compose', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.evaluate(async () => {
      const s = await window.api.invoke('settings:get') as Record<string, unknown>
      await window.api.invoke('settings:save', { ...s, sendDelaySeconds: 10 })
    })

    await page.getByTestId('sidebar-compose').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    const subject = `E2E delayed undo ${Date.now()}`
    await compose.getByTestId('compose-to').fill('undo-delay@example.test')
    await compose.getByTestId('compose-subject').fill(subject)
    await compose.getByTestId('compose-text').fill('undo delayed send body')
    await compose.getByTestId('compose-send').click()
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    const sendUndoBar = page.getByTestId('send-undo-bar')
    await expect(sendUndoBar).toBeVisible()
    await sendUndoBar.getByTestId('send-undo-action').click()
    await expect(sendUndoBar).toHaveCount(0)

    await page.getByTestId('folder-Outbox').click()
    await expect(page.getByTestId('outbox-item').filter({ hasText: subject })).toHaveCount(0)

    const composeRestored = await waitForPage(browser, p => p.url().includes('#/compose') && !p.isClosed())
    await composeRestored.waitForLoadState('domcontentloaded')
    await expect(composeRestored.getByTestId('compose-subject')).toHaveValue(subject)
    await composeRestored.evaluate(() => window.close())
    await expect.poll(() => composeRestored.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('schedule send: custom date/time picker places email in Outbox', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('sidebar-compose').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    const subject = `E2E schedule custom ${Date.now()}`
    await compose.getByTestId('compose-to').fill('schedule-custom@example.test')
    await compose.getByTestId('compose-subject').fill(subject)
    await compose.getByTestId('compose-text').fill('scheduled by custom picker')

    await compose.getByTestId('compose-send-dropdown-toggle').click()
    await compose.getByTestId('compose-schedule-custom-toggle').click()
    const input = compose.getByTestId('compose-schedule-datetime')
    await expect(input).toBeVisible()

    const inTenMinutes = new Date(Date.now() + 10 * 60_000)
    const yyyy = inTenMinutes.getFullYear()
    const mm = String(inTenMinutes.getMonth() + 1).padStart(2, '0')
    const dd = String(inTenMinutes.getDate()).padStart(2, '0')
    const hh = String(inTenMinutes.getHours()).padStart(2, '0')
    const min = String(inTenMinutes.getMinutes()).padStart(2, '0')
    await input.fill(`${yyyy}-${mm}-${dd}T${hh}:${min}`)

    await compose.getByTestId('compose-schedule-apply').click()
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    await page.getByTestId('folder-Outbox').click()
    await expect(page.getByTestId('outbox-item').filter({ hasText: subject }).first()).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('bulk selection: Ctrl+Click selects multiple, bulk delete works', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const items = page.getByTestId('mail-item')
    const count = await items.count()
    expect(count).toBeGreaterThanOrEqual(2)

    // Ctrl+Click on first two emails
    await items.nth(0).click({ modifiers: ['Control'] })
    await items.nth(1).click({ modifiers: ['Control'] })

    // List actions bar should be visible with enabled delete button
    const deleteBtn = page.locator('.list-actions button[title="Delete"]')
    await expect(deleteBtn).toBeVisible()
    await expect(deleteBtn).toBeEnabled()

    // Bulk delete
    await deleteBtn.click()

    // After deletion, items should be reduced
    await expect(items).toHaveCount(count - 2)
  } finally {
    await cleanupApp(ctx)
  }
})

test('star/flag toggle: click star and flagged filter', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const firstItem = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(firstItem).toBeVisible()

    // Click the star
    await firstItem.locator('.star-btn').click()
    await expect(firstItem.locator('.star-btn')).toHaveClass(/star-on/)

    // Flagged filter chip shows the starred email
    await page.getByTestId('filter-flagged').click()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()).toBeVisible()

    // Toggle off flagged filter before removing star (otherwise email disappears from filtered list)
    await page.getByTestId('filter-flagged').click()

    // Remove star
    const item = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await item.locator('.star-btn').click()
    await expect(item.locator('.star-btn')).not.toHaveClass(/star-on/)
  } finally {
    await cleanupApp(ctx)
  }
})

test('context menu: right-click opens menu, reply via context menu', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('mail-item').first().click({ button: 'right' })

    // Context menu appears
    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible()
    await expect(ctxMenu.locator('.ctx-item').first()).toBeVisible()

    // Click Reply (first item)
    await ctxMenu.locator('.ctx-item').first().click()

    // Compose window opens
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    await expect(compose.getByTestId('compose-subject')).toHaveValue(/^Re:/)
    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // Context menu closed
    await expect(ctxMenu).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

test('resize handle: dragging changes list width', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const handle = page.locator('.resize-handle')
    await expect(handle).toBeVisible()

    const initialWidth = await page.locator('.mail-list').evaluate(el => el.getBoundingClientRect().width)

    // Drag handle right by 100px
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()

    const newWidth = await page.locator('.mail-list').evaluate(el => el.getBoundingClientRect().width)
    expect(newWidth).toBeGreaterThan(initialWidth + 50)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Medium priority
// =============================================================================

test('theme: theme change is saved and applied', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Open settings
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')

    // Change theme to dark
    await selectMcOption(settings.getByTestId('settings-theme'), 'dark')
    // Sentinel: verify the trigger shows the user-visible "Dark" label, not just data-selected-value.
    await expect(settings.getByTestId('settings-theme').locator('.mc-select__value')).toHaveText('Dark')
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Theme applied
    await expect.poll(
      async () => page.evaluate(() => document.documentElement.dataset.theme),
      { timeout: EXPECT_TIMEOUT },
    ).toBe('dark')

    // Reopen settings — theme should be dark
    await page.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    expect(await getMcSelectValue(settings2.getByTestId('settings-theme'))).toBe('dark')
    await settings2.evaluate(() => window.close())
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('settings: group conversations is saved and affects list', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!
    const rows = page.getByTestId('mail-item').filter({ hasText: 'E2E1: thread root' })

    await expect(rows).toHaveCount(1)

    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-productivity').click()

    const groupCb = settings.getByTestId('settings-group-conversations')
    await expect(groupCb).toBeVisible()
    if (await groupCb.isChecked()) await groupCb.uncheck()

    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()
    await expect(rows).toHaveCount(2)

    await page.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    await settings2.getByTestId('settings-tab-productivity').click()
    await expect(settings2.getByTestId('settings-group-conversations')).not.toBeChecked()
    await settings2.evaluate(() => window.close())
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('multi-account: switching between accounts', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const acc2 = page.getByTestId('account-2')
    // If there are no 2 accounts — skip
    if (await acc2.count() === 0) {
      test.skip()
      return
    }

    // Switch to account 2
    await acc2.click()
    await expect(page.locator('.mail-list-account')).toContainText('E2E Two')
    await expect(page.getByTestId('folder-INBOX')).toBeVisible()

    // Back to account 1
    await page.getByTestId('account-1').click()
    await expect(page.locator('.mail-list-account')).toContainText('E2E One')
  } finally {
    await cleanupApp(ctx)
  }
})

test('account wizard: fallback to manual when no autoconfig and successful connect', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.evaluate(() => window.api.invoke('ui:openAccount'))
    const account = await waitForPage(browser, p => p.url().includes('#/account'))
    await account.waitForLoadState('domcontentloaded')

    await expect(account.getByTestId('account-wizard-provider')).toBeVisible()
    await account.locator('#provider-card-generic-imap').click()

    await expect(account.getByTestId('account-wizard-type')).toBeVisible()

    await account.getByTestId('account-wizard-imap').click()
    await expect(account.getByTestId('account-wizard-credentials')).toBeVisible()

    await account.getByTestId('account-wizard-email').fill('wizard@example.test')
    await account.getByTestId('account-wizard-password').fill('secret')
    await account.getByTestId('account-wizard-next').click()

    const manual = account.getByTestId('account-wizard-manual')
    await expect(manual).toBeVisible()
    await manual.getByTestId('account-wizard-manual-imap-host').fill('imap.example.test')
    await manual.getByTestId('account-wizard-manual-smtp-host').fill('smtp.example.test')
    await account.getByTestId('account-wizard-connect').click()
    await expect.poll(() => account.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('account wizard: gmail autoconfig shows detected step and connect', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.evaluate(() => window.api.invoke('ui:openAccount'))
    const account = await waitForPage(browser, p => p.url().includes('#/account'))
    await account.waitForLoadState('domcontentloaded')

    await expect(account.getByTestId('account-wizard-provider')).toBeVisible()
    await account.locator('#provider-card-generic-imap').click()

    await expect(account.getByTestId('account-wizard-type')).toBeVisible()
    await account.getByTestId('account-wizard-imap').click()
    await account.getByTestId('account-wizard-email').fill('wizard@gmail.com')
    await account.getByTestId('account-wizard-password').fill('secret')
    await account.getByTestId('account-wizard-next').click()

    await expect(account.getByTestId('account-wizard-detected')).toBeVisible()
    // Detected step shows editable input fields with auto-detected server values
    await expect(account.getByTestId('account-wizard-detected').locator('input[value="imap.gmail.com"]')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await account.getByTestId('account-wizard-connect').click()
    await expect.poll(() => account.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('empty state: empty folder shows message', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Archive is initially empty
    await page.getByTestId('folder-Archive').click()

    // empty-state in mail list section (not in mail-viewer)
    const emptyState = page.locator('[data-testid="inbox-list"] .empty-state')
    await expect(emptyState).toBeVisible()
    await expect(emptyState.locator('p')).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('sort: switch to sort by subject via settings', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Open Settings and switch sort mode to "subject"
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-productivity').click()
    await selectMcOption(settings.getByTestId('settings-sort-mode'), 'subject')
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // Wait for DOM to update after sort change
    await expect(page.getByTestId('mail-item').first()).toBeVisible()

    const subjectsAfter: string[] = []
    const items = page.getByTestId('mail-item')
    const count = await items.count()
    for (let i = 0; i < count; i++) {
      const subj = await items.nth(i).locator('.mail-subject').textContent()
      subjectsAfter.push(subj ?? '')
    }

    // When sorted by subject, order should be lexicographic
    const sorted = [...subjectsAfter].sort((a, b) => a.localeCompare(b))
    expect(subjectsAfter).toEqual(sorted)

    // Restore sort to date
    await page.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    await settings2.getByTestId('settings-tab-productivity').click()
    await selectMcOption(settings2.getByTestId('settings-sort-mode'), 'date')
    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('confirm delete: canceling dialog does not delete email from Trash', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Move email to trash
    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' }).first()
    await clickMailItem(mail)
    await page.getByTestId('mail-action-delete').click()
    await expect(mail).toHaveCount(0)

    // Navigate to Trash
    await page.getByTestId('folder-Trash').click()
    const inTrash = page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' }).first()
    await expect(inTrash).toBeVisible()

    // Attempt to delete permanently
    await clickMailItem(inTrash)
    await page.getByTestId('mail-action-delete').click()

    // Confirmation dialog
    const dialog = page.locator('.confirm-dialog')
    await expect(dialog).toBeVisible()

    // Click "Cancel" (first button in actions — no testId)
    await dialog.locator('.confirm-dialog-actions button').first().click()

    // Dialog closed, email remains
    await expect(dialog).toHaveCount(0)
    await expect(inTrash).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('search clear: X button clears search', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    await page.getByTestId('search-input').fill('flagged')
    await page.getByTestId('search-input').press('Enter')
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: flagged письмо' }).first()).toBeVisible()

    // Click X
    await page.locator('.search-clear').click()

    await expect(page.getByTestId('search-input')).toHaveValue('')
    // All emails return
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('avatar click: from: filter populates search and filters list, Esc resets', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await expect(mail).toBeVisible()

    // Click avatar -> from:...
    await mail.locator('.mail-avatar').click()
    await expect(page.getByTestId('search-input')).toHaveValue('from:alice@example.test')

    // Only emails from Alice remain in the list
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()).toBeVisible()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: html письмо' }).first()).toBeVisible()
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' })).toHaveCount(0)

    // Esc resets search
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search-input')).toHaveValue('')
    await expect(page.getByTestId('mail-item').filter({ hasText: 'E2E1: второе письмо' }).first()).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('compose: attach button visible, fields can be filled', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('sidebar-compose').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    // Attach button visible
    await expect(compose.getByTestId('compose-attach')).toBeVisible()

    // Fill fields — Send button becomes enabled
    await compose.getByTestId('compose-to').fill('test@example.test')
    await compose.getByTestId('compose-subject').fill('Test subject')
    await compose.getByTestId('compose-text').fill('Test body')
    await expect(compose.getByTestId('compose-send')).toBeEnabled()

    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('compose contacts: suggestions and recipient chips work', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await page.getByTestId('sidebar-compose').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    const toInput = compose.getByTestId('compose-to')
    await toInput.fill('ali')

    const suggest = compose.getByTestId('compose-to-suggest')
    await expect(suggest).toBeVisible()
    await expect(suggest.locator('.compose-contact-suggest-item').first()).toContainText('alice@example.test')

    await suggest.locator('.compose-contact-suggest-item').first().click()
    await expect(compose.locator('.compose-address-chip')).toContainText('alice@example.test')
    await expect(toInput).toHaveValue('')

    // Backspace on empty input removes the last chip.
    await toInput.press('Backspace')
    await expect(compose.locator('.compose-address-chip')).toHaveCount(0)

    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('attachment indicator: regular email without attachments does not show attachment chips', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Open a regular email
    await clickMailItem(page.getByTestId('mail-item').first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    // For test emails without attachments — .mail-attachments section should not exist
    const attachments = page.locator('.mail-attachments')
    const itemsWithAttachmentIcon = page.getByTestId('mail-item').filter({ has: page.locator('.mail-attachment-icon') })

    if (await itemsWithAttachmentIcon.count() === 0) {
      // No email has an attachment indicator — section is not displayed
      await expect(attachments).toHaveCount(0)
    } else {
      // If there is an email with attachment — open it and verify attachment chips
      await clickMailItem(itemsWithAttachmentIcon.first())
      await expect(page.getByTestId('mail-subject')).toBeVisible()
      await expect(page.locator('.attachment-chip').first()).toBeVisible()
    }
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Low priority
// =============================================================================

test('shortcuts modal: ? opens, ESC and click close it', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // ? — opens modal
    await page.keyboard.press('?')
    const modal = page.locator('.shortcuts-modal')
    await expect(modal).toBeVisible()

    // Contains 4 groups (navigation, actions, general + context-menu added in polish-bundle-2)
    await expect(modal.locator('.shortcuts-group')).toHaveCount(4)
    await expect(modal.locator('kbd').first()).toBeVisible()

    // ESC — closes
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)

    // Reopen, close with X button
    await page.keyboard.press('?')
    await expect(modal).toBeVisible()
    await page.locator('.shortcuts-close').click()
    await expect(modal).toHaveCount(0)

    // Open, close by clicking overlay
    await page.keyboard.press('?')
    await expect(modal).toBeVisible()
    await page.locator('.shortcuts-overlay').click({ position: { x: 10, y: 10 } })
    await expect(modal).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

test('connection dot: connection indicator on account avatar', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const avatars = page.locator('.account-avatar')
    if (await avatars.count() > 0) {
      const dot = avatars.first().locator('.connection-dot')
      await expect(dot).toBeVisible()

      const classes = await dot.getAttribute('class') ?? ''
      expect(
        classes.includes('connection-dot-ok') ||
        classes.includes('connection-dot-error') ||
        classes.includes('connection-dot-syncing'),
      ).toBe(true)
    }
  } finally {
    await cleanupApp(ctx)
  }
})

test('titlebar badge: unread count in title bar', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const badge = page.locator('.titlebar-badge')

    if (await badge.count() > 0) {
      const text = await badge.textContent()
      expect(Number(text)).toBeGreaterThan(0)
    }

    // Open unread email — badge should decrease
    const unreadItem = page.getByTestId('mail-item').locator('.mail-unread').first()
    if (await unreadItem.count() > 0) {
      const beforeText = (await badge.count() > 0) ? Number(await badge.textContent()) : 0
      await unreadItem.click()
      await expect(page.getByTestId('mail-subject')).toBeVisible()

      // Badge decreased or disappeared
      if (beforeText <= 1) {
        await expect(badge).toHaveCount(0)
      } else {
        await expect.poll(async () => Number(await badge.textContent())).toBeLessThan(beforeText)
      }
    }
  } finally {
    await cleanupApp(ctx)
  }
})

test('draft: after explicit discard, "Compose" button opens blank compose', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // 1) Open compose and enter data
    await page.getByTestId('sidebar-compose').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    const draftSubject = `E2E no-restore ${Date.now()}`
    await compose.getByTestId('compose-to').fill('draft-test@example.test')
    await compose.getByTestId('compose-subject').fill(draftSubject)
    await compose.getByTestId('compose-text').fill('Draft body')

    // Wait for debounce localStorage save (600ms)
    await compose.waitForTimeout(800)

    // Simulate explicit discard: clear per-account "last draft" pointer and
    // the draft body from localStorage. §2.16 behaviour — fresh Compose
    // reuses the last draftId UNLESS the pointer was cleared (i.e. discarded).
    // Without this step the second Compose intentionally restores the draft
    // (that is the new §2.16 default to prevent IMAP Drafts duplicates).
    await compose.evaluate(() => {
      const PREFIX = 'mailcopilot:draft:'
      const LAST_PREFIX = 'mailcopilot:draft:last'
      const toRemove: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && (key.startsWith(PREFIX) || key.startsWith(LAST_PREFIX))) {
          toRemove.push(key)
        }
      }
      toRemove.forEach(k => localStorage.removeItem(k))
    })

    // Close without sending (pointer already cleared — acts as explicit discard)
    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // 2) Click "Compose" again — after discard, draft should NOT be restored
    await page.getByTestId('sidebar-compose').click()
    const compose2 = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose2.waitForLoadState('domcontentloaded')

    // Wait for compose initialization (async calls to accounts, settings)
    await compose2.getByTestId('compose-to').waitFor({ state: 'visible' })

    // Fields should be empty (or contain only signature in text)
    await expect(compose2.getByTestId('compose-to')).toHaveValue('')
    await expect(compose2.getByTestId('compose-subject')).toHaveValue('')
    // compose-text may contain signature (\n\n--\n...) but NOT draft text
    const textVal = await compose2.getByTestId('compose-text').inputValue()
    expect(textVal).not.toContain('Draft body')

    await compose2.evaluate(() => window.close())
    await expect.poll(() => compose2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Additional keyboard shortcut tests
// =============================================================================

test('keyboard: / focuses search', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    await page.keyboard.press('/')
    await expect(page.getByTestId('search-input')).toBeFocused()
  } finally {
    await cleanupApp(ctx)
  }
})

test('keyboard: g,i goes to INBOX, g,s — to Sent', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Navigate to Sent via sidebar
    await page.getByTestId('folder-Sent').click()
    await expect(page.getByTestId('folder-Sent')).toHaveClass(/folder-active/)

    // g,i → INBOX
    await page.keyboard.press('g')
    await page.waitForTimeout(100)
    await page.keyboard.press('i')
    await expect(page.getByTestId('folder-INBOX')).toHaveClass(/folder-active/)

    // g,s → Sent
    await page.keyboard.press('g')
    await page.waitForTimeout(100)
    await page.keyboard.press('s')
    await expect(page.getByTestId('folder-Sent')).toHaveClass(/folder-active/)
  } finally {
    await cleanupApp(ctx)
  }
})

test('keyboard: r opens reply for active email', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await clickMailItem(page.getByTestId('mail-item').first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    await page.keyboard.press('r')
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    await expect(compose.getByTestId('compose-subject')).toHaveValue(/^Re:/)
    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('keyboard: f opens forward for active email', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    await clickMailItem(page.getByTestId('mail-item').first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    await page.keyboard.press('f')
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')
    await expect(compose.getByTestId('compose-subject')).toHaveValue(/^Fwd:/)
    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

test('keyboard: Shift+U/Shift+I toggle unread/read, u returns to list, o opens', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const unread = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await clickMailItem(unread)
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    // Email became read when opened
    await expect(unread).not.toHaveClass(/mail-unread/)

    // Shift+U — mark as unread
    await page.keyboard.press('Shift+U')
    await expect(unread).toHaveClass(/mail-unread/)

    // Shift+I — mark as read again
    await page.keyboard.press('Shift+I')
    await expect(unread).not.toHaveClass(/mail-unread/)

    // u — close reading view (back to list)
    await page.keyboard.press('u')
    await expect(page.getByTestId('mail-subject')).toHaveCount(0)

    // o — open again
    await page.keyboard.press('o')
    await expect(page.getByTestId('mail-subject')).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('keyboard: s toggles star', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    const mail = page.getByTestId('mail-item').filter({ hasText: 'E2E1: первое письмо' }).first()
    await clickMailItem(mail)
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    // s — add star
    await page.keyboard.press('s')
    await expect(mail.locator('.star-btn')).toHaveClass(/star-on/)

    // s — remove star
    await page.keyboard.press('s')
    await expect(mail.locator('.star-btn')).not.toHaveClass(/star-on/)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Send & Archive button visibility
// =============================================================================

test('compose: Send & Archive visible on reply, hidden on new/forward', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Open first email
    await clickMailItem(page.getByTestId('mail-item').first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    // Reply — Send & Archive should be visible in dropdown menu
    await page.getByTestId('mail-action-reply').click()
    const replyCompose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await replyCompose.waitForLoadState('domcontentloaded')
    await expect(replyCompose.getByTestId('compose-send')).toBeVisible()
    // Wait for async account/roles loading so the dropdown toggle becomes enabled
    await expect(replyCompose.getByTestId('compose-send-dropdown-toggle')).toBeEnabled({ timeout: EXPECT_TIMEOUT })
    await replyCompose.getByTestId('compose-send-dropdown-toggle').click()
    await expect(replyCompose.getByTestId('compose-send-archive')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await replyCompose.evaluate(() => window.close())
    await expect.poll(() => replyCompose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // New compose — Send & Archive should NOT be in dropdown menu
    await page.keyboard.press('c')
    const newCompose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await newCompose.waitForLoadState('domcontentloaded')
    await expect(newCompose.getByTestId('compose-send')).toBeVisible()
    // Fill To so canSend becomes true and the dropdown toggle is enabled
    await newCompose.getByTestId('compose-to').fill('dummy@example.test')
    await newCompose.getByTestId('compose-to').press('Tab')
    await expect(newCompose.getByTestId('compose-send-dropdown-toggle')).toBeEnabled({ timeout: EXPECT_TIMEOUT })
    await newCompose.getByTestId('compose-send-dropdown-toggle').click()
    await expect(newCompose.getByTestId('compose-send-archive')).toHaveCount(0)
    await newCompose.evaluate(() => window.close())
    await expect.poll(() => newCompose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    await page.bringToFront()

    // Forward — Send & Archive should NOT be in dropdown menu
    await clickMailItem(page.getByTestId('mail-item').first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()
    await page.getByTestId('mail-action-forward').click()
    const fwdCompose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await fwdCompose.waitForLoadState('domcontentloaded')
    await expect(fwdCompose.getByTestId('compose-send')).toBeVisible()
    // Fill To so canSend becomes true and the dropdown toggle is enabled
    await fwdCompose.getByTestId('compose-to').fill('dummy@example.test')
    await fwdCompose.getByTestId('compose-to').press('Tab')
    await expect(fwdCompose.getByTestId('compose-send-dropdown-toggle')).toBeEnabled({ timeout: EXPECT_TIMEOUT })
    await fwdCompose.getByTestId('compose-send-dropdown-toggle').click()
    await expect(fwdCompose.getByTestId('compose-send-archive')).toHaveCount(0)
    await fwdCompose.evaluate(() => window.close())
    await expect.poll(() => fwdCompose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// GTD chips in AI panel
// =============================================================================

test('AI panel: GTD chips visible in email context', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Configure AI provider so the panel shows the chat UI (not onboarding)
    await page.evaluate(async () => {
      const current = await window.api.invoke('settings:get') as Record<string, unknown>
      await window.api.invoke('settings:save', { ...current, aiProvider: 'subscription', aiPrivacyConsent: true })
    })

    // Open first email
    await clickMailItem(page.getByTestId('mail-item').first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    // Open AI panel (keyboard shortcut Ctrl+Shift+A)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+Shift+a`)
    await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // GTD chips should be visible in email context
    const chips = page.getByTestId('ai-chips')
    await expect(chips).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Check for at least some GTD chip labels
    const chipButtons = chips.locator('.ai-chip')
    const chipTexts = await chipButtons.allTextContents()
    // Should include at least some of: Triage, Snooze, Star/Unstar, Follow-up
    // (locale-independent check — just verify there are multiple chips)
    expect(chipTexts.length).toBeGreaterThanOrEqual(4)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// AI panel: attachment email — no crash / no overflow
// =============================================================================

test('AI panel: responds without error when email has attachments', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Configure AI provider so the panel shows the chat UI (not onboarding)
    await page.evaluate(async () => {
      const current = await window.api.invoke('settings:get') as Record<string, unknown>
      await window.api.invoke('settings:save', { ...current, aiProvider: 'subscription', aiPrivacyConsent: true })
    })

    // Open the HTML email (uid 100) which has an inline image attachment
    await clickMailItem(page.getByTestId('mail-item').filter({ hasText: 'html' }).first())
    await expect(page.getByTestId('mail-subject')).toBeVisible()

    // Open AI panel via sidebar button
    await page.getByTestId('sidebar-ai').click()
    await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Dismiss privacy dialog if present (should not appear since consent is pre-set)
    const privacyDialog = page.getByTestId('ai-privacy-dialog')
    if (await privacyDialog.count()) {
      await privacyDialog.getByRole('button').last().click()
    }

    // Send a prompt about reading attachments
    const aiInput = page.getByTestId('ai-input')
    await expect(aiInput).toBeVisible()
    await aiInput.fill('Read all attachments and summarize their content')
    await aiInput.press('Enter')

    // Verify user message appears
    await expect(page.getByTestId('ai-message-user').last()).toContainText('Read all attachments')

    // Wait for the mock stream's terminal marker — 'uid=101' only appears after
    // the final 1-char chunk arrives (mock splits at 42-char boundaries and the
    // 43-char Sources line crosses one, so 'uid=10' lands in the penultimate
    // chunk and '1' in the final chunk). Matching 'uid=101' guarantees full stream.
    await expect(page.getByTestId('ai-message-assistant').last())
      .toContainText('uid=101', { timeout: EXPECT_TIMEOUT })

    // Verify no error message is visible in the AI panel
    const errorMessages = page.locator('.ai-error')
    await expect(errorMessages).toHaveCount(0)

    // Verify the assistant response contains expected mock content (not an error)
    const assistantText = await page.getByTestId('ai-message-assistant').last().textContent()
    expect(assistantText).toContain('Priority')
    expect(assistantText).not.toContain('context limit')
    expect(assistantText).not.toContain('overflow')
    expect(assistantText).not.toContain('token')
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// AI panel resize: active email must survive drag-resize of the AI panel
// =============================================================================

test('AI panel resize: email stays visible after drag-resize', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Configure AI provider
    await page.evaluate(async () => {
      const current = await window.api.invoke('settings:get') as Record<string, unknown>
      await window.api.invoke('settings:save', {
        ...current,
        aiProvider: 'subscription',
        aiPrivacyConsent: true,
      })
    })

    // Open first email and remember its subject
    await clickMailItem(page.getByTestId('mail-item').first())
    const subjectEl = page.getByTestId('mail-subject')
    await expect(subjectEl).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const subjectBefore = await subjectEl.textContent()

    // Open AI panel via keyboard shortcut
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+Shift+a`)
    await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Email subject must still be visible after AI panel opens
    // Wait a bit for any settings broadcast effects to settle
    await page.waitForTimeout(500)
    // Subject may shrink to 0 width when viewer is narrow — check body instead
    const bodyEl = page.locator('.mail-viewer-body')
    await expect(bodyEl).toBeVisible()

    // Drag the AI panel resize handle to widen the panel
    const handle = page.locator('.ai-drag-handle')
    await expect(handle).toBeVisible()
    const box = (await handle.boundingBox())!
    const startX = box.x + box.width / 2
    const startY = box.y + box.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX - 60, startY, { steps: 10 })
    await page.mouse.up()

    // Email body must still be visible after resize
    await expect(bodyEl).toBeVisible()
    // Subject text remains in the DOM even if squeezed (same email still open)
    const subjectAfter = await subjectEl.textContent()
    expect(subjectAfter).toBe(subjectBefore)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Window focus: active email must survive window blur/focus cycle
// =============================================================================

test('window focus: active email survives blur/focus cycle', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Collect debug traces from setActive(null)
    const traces: string[] = []
    page.on('console', msg => {
      const text = msg.text()
      if (text.includes('[DEBUG] setActive(null)')) traces.push(text)
    })

    // Wait for init setActive(null) to fire
    await page.waitForTimeout(2000)
    const initTraces = traces.length
    console.log(`Init phase: ${initTraces} setActive(null) calls`)
    traces.length = 0 // clear

    // Open first email
    await clickMailItem(page.getByTestId('mail-item').first())
    const subjectEl = page.getByTestId('mail-subject')
    await expect(subjectEl).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const subjectBefore = await subjectEl.textContent()
    console.log(`Email opened: "${subjectBefore}"`)

    // Click on search input
    await page.getByTestId('search-input').click()
    await page.waitForTimeout(500)
    console.log(`After search click: traces=${traces.length}`)
    if (traces.length > 0) console.log('TRACES after search click:', JSON.stringify(traces))

    // Check email still visible
    let stillHasSubject = await subjectEl.textContent()
    console.log(`Subject after search click: "${stillHasSubject}"`)
    expect(stillHasSubject).toBe(subjectBefore)

    // Clear traces and simulate window blur/focus
    traces.length = 0
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'))
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(500)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(2000)

    console.log(`After blur/focus: traces=${traces.length}`)
    if (traces.length > 0) console.log('TRACES after blur/focus:', JSON.stringify(traces))

    // Email must still be visible
    stillHasSubject = await subjectEl.textContent()
    console.log(`Subject after blur/focus: "${stillHasSubject}"`)
    expect(stillHasSubject).toBe(subjectBefore)
    await expect(subjectEl).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})
