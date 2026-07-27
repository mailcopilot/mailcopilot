import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, CLOSE_TIMEOUT, EXPECT_TIMEOUT, type AppContext } from './helpers'

// =============================================================================
// Snooze UI: hover action → dropdown → virtual folder
// =============================================================================

test('snooze: context menu snooze + cancel flow', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // uiaudit.2 — hover-action chips removed; snooze is now accessible only
    // through the right-click context menu.
    const secondMail = page.getByTestId('mail-item').nth(1)
    await secondMail.click({ button: 'right' })

    // Context menu should appear
    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible()

    // Click the Snooze item
    const snoozeItem = ctxMenu.locator('.ctx-item', { hasText: /snooze|отложить|zurückstellen|posponer|posticipa/i })
    await snoozeItem.click()
    await expect(ctxMenu).toHaveCount(0)

    // Snooze dropdown should appear
    const dropdown = page.locator('.snooze-dropdown')
    await expect(dropdown).toBeVisible()

    // Should have 3 presets + a custom option
    const presets = dropdown.locator('.snooze-preset')
    await expect(presets).toHaveCount(4)

    // Click "Later today" (first preset)
    await presets.first().click()

    // Dropdown should close
    await expect(dropdown).toHaveCount(0)

    // Navigate to Snoozed virtual folder
    await page.getByTestId('folder-Snoozed').click()

    // Snoozed list should contain the snoozed email
    const snoozedList = page.getByTestId('snoozed-list')
    await expect(snoozedList).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // There should be at least 1 snoozed item
    const snoozedItems = snoozedList.locator('.vfolder-item')
    await expect(snoozedItems).toHaveCount(1)

    // Cancel the snooze
    const cancelBtn = snoozedItems.first().locator('button')
    await cancelBtn.click()

    // Snoozed folder should be empty now
    await expect(page.getByTestId('snoozed-empty')).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Snooze: context menu → snooze dropdown
// =============================================================================

test('snooze: context menu opens snooze dropdown', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Right-click on first email
    await page.getByTestId('mail-item').first().click({ button: 'right' })

    // Context menu appears
    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible()

    // Click the Snooze item (6th context item for single-email mode:
    // Reply, ReplyAll, Forward, ---sep---, MarkRead, Snooze)
    // Find by Clock3 icon or text
    const snoozeItem = ctxMenu.locator('.ctx-item', { hasText: /snooze|отложить|reporter|zurückstellen|posponer|posticipa/i })
    await snoozeItem.click()

    // Context menu closes, snooze dropdown appears
    await expect(ctxMenu).toHaveCount(0)
    const dropdown = page.locator('.snooze-dropdown')
    await expect(dropdown).toBeVisible()

    // Close by clicking overlay
    await page.locator('.snooze-dropdown-overlay').click()
    await expect(dropdown).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Read Later: add via context menu → virtual folder → remove
// =============================================================================

test('read later: add via context menu, view in virtual folder, remove', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Right-click on first email
    const firstMail = page.getByTestId('mail-item').first()
    const firstSubject = await firstMail.locator('.mail-subject').textContent()
    await firstMail.click({ button: 'right' })

    // Context menu appears
    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible()

    // Click Read Later item (BookOpen icon)
    const readLaterItem = ctxMenu.locator('.ctx-item', { hasText: /read later|прочитать|lire|lesen|leer|leggere/i })
    await readLaterItem.click()

    // Context menu closes
    await expect(ctxMenu).toHaveCount(0)

    // Navigate to Read Later virtual folder
    await page.getByTestId('folder-ReadLater').click()

    // Read Later list should contain the email
    const readLaterList = page.getByTestId('readlater-list')
    await expect(readLaterList).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const items = readLaterList.locator('.vfolder-item')
    await expect(items).toHaveCount(1)

    // Subject should match
    const itemSubject = await items.first().locator('.vfolder-item-subject').textContent()
    expect(itemSubject).toBe(firstSubject)

    // Remove it
    const removeBtn = items.first().locator('button')
    await removeBtn.click()

    // Read Later folder should be empty now
    await expect(page.getByTestId('readlater-empty')).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Follow-up Reminders: virtual folder displays items
// =============================================================================

test('follow-up: virtual folder shows empty state', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Navigate to Follow-up virtual folder
    await page.getByTestId('folder-FollowUp').click()

    // Should show empty state (no follow-ups configured in e2e mock)
    await expect(page.getByTestId('followup-empty')).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Templates: CRUD in Settings + apply in Compose
// =============================================================================

test('templates: create in Settings, apply in Compose, delete', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Open Settings → Templates tab
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-templates').click()

    // Initially no templates (empty hint)
    const templateList = settings.locator('.settings-template-list')

    // Create a new template
    const form = settings.locator('.settings-template-form')
    await form.locator('input').first().fill('Quick Reply')
    await form.locator('input').nth(1).fill('RE: {name}')
    await form.locator('textarea').fill('Hello {name}, thank you for your email.')
    await form.locator('input').last().fill('/qr')

    // Click Add button
    const addBtn = form.locator('.btn-primary')
    await addBtn.click()

    // Template should appear in the list
    await expect(templateList).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const templateItem = templateList.locator('.settings-template-item')
    await expect(templateItem).toHaveCount(1)
    await expect(templateItem.locator('.settings-template-item-name')).toHaveText('Quick Reply')
    await expect(templateItem.locator('.settings-template-item-shortcut')).toHaveText('/qr')

    // Save settings and close
    await settings.getByTestId('settings-save').click()
    await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // Open Compose and apply the template
    await page.bringToFront()
    await page.locator('.sidebar-compose-btn').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    // Click Templates toggle
    await compose.getByTestId('compose-templates-toggle').click()

    // Template menu should appear with our template
    const templateMenu = compose.getByTestId('compose-template-menu')
    await expect(templateMenu).toBeVisible()
    const tplButton = templateMenu.locator('button')
    await expect(tplButton).toHaveCount(1)
    await expect(tplButton.first().locator('span').first()).toHaveText('Quick Reply')

    // Apply the template
    await tplButton.first().click()

    // Subject should contain the template subject (with variable substitution)
    await expect(compose.getByTestId('compose-subject')).toHaveValue(/RE:/)

    // Close compose
    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)

    // Reopen Settings and delete the template
    await page.bringToFront()
    await page.getByTestId('open-settings').click()
    const settings2 = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings2.waitForLoadState('domcontentloaded')
    await settings2.getByTestId('settings-tab-templates').click()

    // Wait for template list to load
    const templateList2 = settings2.locator('.settings-template-list')
    await expect(templateList2).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Delete the template
    const deleteBtn = templateList2.locator('.settings-template-item-actions button').last()
    await deleteBtn.click()

    // Template should be removed
    await expect(templateList2.locator('.settings-template-item')).toHaveCount(0, { timeout: EXPECT_TIMEOUT })

    await settings2.getByTestId('settings-save').click()
    await expect.poll(() => settings2.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Account wizard: IMAP/SMTP flow
// =============================================================================

test('account wizard: IMAP/SMTP setup flow through wizard steps', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Open Settings → Accounts → Add Account
    await page.getByTestId('open-settings').click()
    const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
    await settings.waitForLoadState('domcontentloaded')
    await settings.getByTestId('settings-tab-accounts').click()

    // Wait for accounts list to load, then click "Add Account"
    await settings.waitForTimeout(500)
    const addAccountBtn = settings.locator('.form-actions button', { hasText: /add|добавить|ajouter|hinzufügen|añadir|aggiungi/i }).first()
    await expect(addAccountBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await addAccountBtn.click()

    // Account wizard window opens
    const account = await waitForPage(browser, p => p.url().includes('#/account'))
    await account.waitForLoadState('domcontentloaded')

    // Step 1: Provider picker (added in task 2.1-C)
    await expect(account.getByTestId('account-wizard-provider')).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await account.locator('#provider-card-generic-imap').click()

    // Step 2: Type selection
    await expect(account.getByTestId('account-wizard-type')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Click IMAP/SMTP button
    await account.getByTestId('account-wizard-imap').click()

    // Step 2: Credentials
    await expect(account.getByTestId('account-wizard-credentials')).toBeVisible()

    // Fill in email and password (use gmail.com for autoconfig mock)
    await account.getByTestId('account-wizard-email').fill('test@gmail.com')
    await account.getByTestId('account-wizard-password').fill('testpassword123')

    // Click Next to auto-detect servers
    await account.getByTestId('account-wizard-next').click()

    // Step 3: Detected (autoconfig returns mock data in e2e)
    await expect(account.getByTestId('account-wizard-detected')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Verify IMAP/SMTP fields are populated
    const imapHostInput = account.locator('input[placeholder*="Host"]').first()
    await expect(imapHostInput).toBeVisible()

    // Can switch to manual mode
    const manualBtn = account.locator('button', { hasText: /manual|ручн|manuel|manuell|manual|manuale/i })
    await manualBtn.click()
    await expect(account.getByTestId('account-wizard-manual')).toBeVisible()

    // Verify manual mode shows IMAP and SMTP sections
    await expect(account.getByTestId('account-wizard-manual-imap-host')).toBeVisible()
    await expect(account.getByTestId('account-wizard-manual-smtp-host')).toBeVisible()

    // Close account and settings windows
    await account.evaluate(() => window.close())
    await expect.poll(() => account.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    if (!settings.isClosed()) {
      await settings.evaluate(() => window.close())
      await expect.poll(() => settings.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
    }
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Filter: attachments filter shows correct results
// =============================================================================

test('filter: attachments filter shows emails with attachments', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Click attachments filter chip
    await page.getByTestId('filter-attachments').click()

    // Should show only emails with attachments
    const items = page.getByTestId('mail-item')
    const count = await items.count()
    expect(count).toBeGreaterThanOrEqual(1)

    // The HTML email (uid 100) has hasAttachments: true
    // Other emails don't — so filtered count should be less than total

    // Toggle off
    await page.getByTestId('filter-attachments').click()
    const allCount = await items.count()
    expect(allCount).toBeGreaterThan(count)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Snooze: snoozed folder badge updates
// =============================================================================

test('snooze: snoozed folder badge updates after snoozing', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Initially snoozed folder should not have a badge
    const badge = page.locator('[data-testid="folder-Snoozed"] .folder-badge')
    await expect(badge).toHaveCount(0)

    // Snooze an email via context menu (stable alternative to hover actions)
    const secondMail = page.getByTestId('mail-item').nth(1)
    await expect(secondMail).toBeVisible()
    await secondMail.click({ button: 'right' })
    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible({ timeout: EXPECT_TIMEOUT })
    const snoozeItem = ctxMenu.locator('.ctx-item', { hasText: /snooze|отложить|reporter|zurückstellen|posponer|posticipa/i })
    await snoozeItem.click()

    // Click first preset
    const dropdown = page.locator('.snooze-dropdown')
    await expect(dropdown).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await dropdown.locator('.snooze-preset').first().click()
    await expect(dropdown).toHaveCount(0, { timeout: EXPECT_TIMEOUT })

    // Badge should appear on Snoozed folder
    await expect(badge).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(badge).toHaveText('1')
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Read Later: badge on virtual folder
// =============================================================================

test('read later: badge updates when adding/removing items', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Initially Read Later folder should not have a badge
    const badge = page.locator('[data-testid="folder-ReadLater"] .folder-badge')
    await expect(badge).toHaveCount(0)

    // Add email to Read Later via context menu
    await page.getByTestId('mail-item').first().click({ button: 'right' })
    const ctxMenu = page.locator('.context-menu')
    await expect(ctxMenu).toBeVisible()

    const readLaterItem = ctxMenu.locator('.ctx-item', { hasText: /read later|прочитать|lire|lesen|leer|leggere/i })
    await readLaterItem.click()

    // Badge should appear
    await expect(badge).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(badge).toHaveText('1')

    // Navigate to Read Later and remove
    await page.getByTestId('folder-ReadLater').click()
    const readLaterList = page.getByTestId('readlater-list')
    await expect(readLaterList).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await readLaterList.locator('.vfolder-item button').first().click()

    // Badge should disappear
    await page.getByTestId('folder-INBOX').click()
    await expect(badge).toHaveCount(0, { timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Compose: follow-up reminder checkbox
// =============================================================================

test('compose: follow-up reminder checkbox and days selector visible', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!
    const browser = ctx.browser!

    // Open compose
    await page.locator('.sidebar-compose-btn').click()
    const compose = await waitForPage(browser, p => p.url().includes('#/compose'))
    await compose.waitForLoadState('domcontentloaded')

    // Follow-up checkbox should be visible
    const followUpArea = compose.locator('.compose-followup')
    await expect(followUpArea).toBeVisible()

    // Checkbox should be visible, select appears only after checking
    const checkbox = followUpArea.locator('input[type="checkbox"]')
    await expect(checkbox).toBeVisible()

    // Check the checkbox — days selector appears
    await checkbox.check()
    await expect(checkbox).toBeChecked()

    // mc-select renders a <button role="combobox"> trigger (uiaudit.11 native select sweep)
    const trigger = followUpArea.locator('.mc-select__trigger')
    await expect(trigger).toBeVisible()

    // Open the listbox and count <li role="option"> items (2/3/7 days).
    // The mc-select listbox is rendered in a React Portal on document.body, so it
    // is NOT a descendant of followUpArea — use a page-level locator instead.
    await trigger.click()
    const options = await compose.locator('[role="option"]').count()
    expect(options).toBeGreaterThanOrEqual(3)
    // Close the listbox
    await trigger.click()

    await compose.evaluate(() => window.close())
    await expect.poll(() => compose.isClosed(), { timeout: CLOSE_TIMEOUT }).toBe(true)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Action toolbar: disabled tooltips
// =============================================================================

test('action toolbar: disabled buttons have explanatory tooltips', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp())
    const page = ctx.page!

    // Ensure no emails are selected (click on folder to deselect)
    await page.getByTestId('folder-INBOX').click()
    await expect(page.getByTestId('mail-item').first()).toBeVisible()

    // All toolbar buttons should be disabled and have the "select to act" tooltip
    const toolbar = page.locator('.list-actions')
    await expect(toolbar).toBeVisible()

    const buttons = toolbar.locator('.btn-icon')
    const count = await buttons.count()
    expect(count).toBeGreaterThanOrEqual(4)

    // All buttons should be disabled
    for (let i = 0; i < count; i++) {
      await expect(buttons.nth(i)).toBeDisabled()
    }

    // Move-to-folder select should also be disabled
    const moveSelect = toolbar.locator('.select-sm')
    await expect(moveSelect).toBeDisabled()
  } finally {
    await cleanupApp(ctx)
  }
})
