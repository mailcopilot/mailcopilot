/**
 * E2E regression tests for §3.3.C-uiaudit.22 — RecipientList component.
 *
 * Verifies collapsible recipient chips, "+N more" overflow button, tooltip
 * delegation, keyboard accessibility, and the BCC isSentByMe privacy gate —
 * all in a real Electron window connected via CDP.
 *
 * All tests inject synthetic mail fixtures via e2e:injectMail (preload
 * whitelist) so the specs are self-contained and do not depend on any
 * specific pre-existing seed message having the right recipient count.
 *
 * Run: npm run e2e:bg   (xvfb wrapper required per CLAUDE.md §7)
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, EXPECT_TIMEOUT, type AppContext } from './helpers'

// ---------------------------------------------------------------------------
// Shared UIDs — must not collide with built-in e2e fixture UIDs (89–104, 201)
// ---------------------------------------------------------------------------
const UID_OVERFLOW_TO    = 9901   // 4 To addresses — triggers "+1 more" button
const UID_BCC_SENT       = 9902   // Sent folder mail with BCC populated
const UID_BCC_SPOOFED    = 9904   // Spoofed mail in Sent (attacker From ≠ identity)

// ---------------------------------------------------------------------------
// Helper: inject the "overflow To" fixture and navigate to it
// ---------------------------------------------------------------------------
async function injectOverflowMail(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async (uid) => {
    await window.api.invoke('e2e:injectMail', {
      accountId: 1,
      folder: 'INBOX',
      uid,
      from: 'sender@example.test',
      // 4 To recipients — maxVisible=3 → overflow=1 → "+1 more" button
      to: 'alice@example.test, bob@example.test, carol@example.test, dave@example.test',
      subject: `E2E Recipient Overflow (uid ${uid})`,
      date: new Date().toISOString(),
      unread: true,
      flagged: false,
      text: 'Overflow recipient test body.',
    })
  }, UID_OVERFLOW_TO)

  // Wait for the injected mail to appear in the list
  const injectedItem = page
    .getByTestId('mail-item')
    .filter({ hasText: `E2E Recipient Overflow (uid ${UID_OVERFLOW_TO})` })
    .first()
  await expect(injectedItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
  await injectedItem.click()

  // Confirm mail viewer loaded
  await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })
}

// ---------------------------------------------------------------------------
// Helper: inject a Sent-folder mail with BCC populated
// ---------------------------------------------------------------------------
async function injectSentWithBcc(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async (uid) => {
    await window.api.invoke('e2e:injectMail', {
      accountId: 1,
      folder: 'Sent',
      uid,
      from: 'e2e1@example.test',
      to: 'alice@example.test',
      bcc: 'secret@example.test',
      subject: `E2E BCC Sent (uid ${uid})`,
      date: new Date().toISOString(),
      unread: false,
      flagged: false,
      text: 'Sent mail with BCC for isSentByMe gate test.',
    })
  }, UID_BCC_SENT)
}

// =============================================================================
// Test 1: "+N more" button appears when To count > maxVisible
// =============================================================================

test('uiaudit.22: "+N more" button appears when To has 4 recipients (maxVisible=3)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-recip-overflow-'))
    const page = ctx.page!

    await injectOverflowMail(page)

    // "+1 more" button must be visible
    const moreBtn = page.getByTestId('recipient-more-btn').first()
    await expect(moreBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(moreBtn).toHaveAttribute('aria-expanded', 'false')

    // Only 3 chips initially (first 3 of 4)
    const chips = page.getByTestId('recipient-chip')
    await expect(chips).toHaveCount(3, { timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 2: Click on "+N more" expands the list
// =============================================================================

test('uiaudit.22: clicking "+N more" expands to show all recipients', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-recip-expand-'))
    const page = ctx.page!

    await injectOverflowMail(page)

    const moreBtn = page.getByTestId('recipient-more-btn').first()
    await expect(moreBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Click to expand
    await moreBtn.click()

    // All 4 chips now visible
    const chips = page.getByTestId('recipient-chip')
    await expect(chips).toHaveCount(4, { timeout: EXPECT_TIMEOUT })

    // Button is now in expanded state
    await expect(page.getByTestId('recipient-more-btn').first()).toHaveAttribute('aria-expanded', 'true')
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 3: Second click collapses the list back
// =============================================================================

test('uiaudit.22: second click on toggle button collapses the list', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-recip-collapse-'))
    const page = ctx.page!

    await injectOverflowMail(page)

    const moreBtn = page.getByTestId('recipient-more-btn').first()
    await expect(moreBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Expand
    await moreBtn.click()
    await expect(page.getByTestId('recipient-chip')).toHaveCount(4, { timeout: EXPECT_TIMEOUT })

    // Collapse
    await page.getByTestId('recipient-more-btn').first().click()
    await expect(page.getByTestId('recipient-chip')).toHaveCount(3, { timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('recipient-more-btn').first()).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 4: Chip tooltip — hovering a chip shows .tooltip-portal
// =============================================================================

test('uiaudit.22: hovering a recipient chip shows tooltip-portal with name and email', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-recip-tooltip-'))
    const page = ctx.page!

    await injectOverflowMail(page)

    const firstChip = page.getByTestId('recipient-chip').first()
    await expect(firstChip).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // The chip must carry a data-tooltip attribute
    const tooltipText = await firstChip.getAttribute('data-tooltip')
    expect(tooltipText).toBeTruthy()
    // alice@example.test has no display name in the fixture → tooltip = email
    expect(tooltipText).toContain('@example.test')

    // Hover to trigger tooltip delegation
    await firstChip.hover()

    // tooltip-portal must appear
    const portal = page.locator('.tooltip-portal')
    await expect(portal).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(portal).toContainText(tooltipText!)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 5: Keyboard — Enter on "+N more" button expands the list
// =============================================================================

test('uiaudit.22: pressing Enter on "+N more" button expands the list', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-recip-kbd-enter-'))
    const page = ctx.page!

    await injectOverflowMail(page)

    const moreBtn = page.getByTestId('recipient-more-btn').first()
    await expect(moreBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Focus the button and press Enter
    await moreBtn.focus()
    await page.keyboard.press('Enter')

    await expect(page.getByTestId('recipient-chip')).toHaveCount(4, { timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 6: Keyboard — Escape collapses an expanded list
// =============================================================================

test('uiaudit.22: pressing Escape on expanded recipient list collapses it', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-recip-kbd-esc-'))
    const page = ctx.page!

    await injectOverflowMail(page)

    // Expand via click
    const moreBtn = page.getByTestId('recipient-more-btn').first()
    await expect(moreBtn).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await moreBtn.click()
    await expect(page.getByTestId('recipient-chip')).toHaveCount(4, { timeout: EXPECT_TIMEOUT })

    // Press Escape inside the recipient-list wrapper
    const listWrapper = page.locator('[data-testid="recipient-list"]').first()
    await listWrapper.press('Escape')

    // Collapsed back to 3 chips
    await expect(page.getByTestId('recipient-chip')).toHaveCount(3, { timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 7: BCC row hidden on received mail (isSentByMe=false)
// =============================================================================

test('uiaudit.22: BCC row is NOT shown for received mail (isSentByMe=false)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-recip-bcc-received-'))
    const page = ctx.page!

    // uid=101 is a received mail (INBOX, from alice) with cc but no bcc field
    // It is the default first mail in account 1 INBOX. Select it.
    const firstMail = page.getByTestId('mail-item').first()
    await expect(firstMail).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await firstMail.click()
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // BCC label must not be present for received mail
    const metaSection = page.locator('.mail-viewer-meta')
    await expect(metaSection).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(metaSection.getByText('Bcc')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 8: BCC row IS shown on sent mail (isSentByMe=true) when BCC non-empty
// =============================================================================

test('uiaudit.22: BCC row IS shown for sent mail (isSentByMe=true) when BCC non-empty', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-recip-bcc-sent-'))
    const page = ctx.page!

    // Inject the BCC mail into Sent folder
    await injectSentWithBcc(page)

    // Navigate to Sent folder
    await page.getByTestId('folder-Sent').click()

    // Wait for the injected mail to appear
    const sentItem = page
      .getByTestId('mail-item')
      .filter({ hasText: `E2E BCC Sent (uid ${UID_BCC_SENT})` })
      .first()
    await expect(sentItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await sentItem.click()
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // BCC label must be present for sent mail with bcc populated
    const metaSection = page.locator('.mail-viewer-meta')
    await expect(metaSection).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(metaSection.getByText('Bcc')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // BCC chip shows the secret recipient
    const bccRow = page.locator('.meta-row--recipients').filter({ hasText: 'Bcc' })
    await expect(bccRow.getByTestId('recipient-chip')).toBeVisible({ timeout: EXPECT_TIMEOUT })
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 9: No overflow button when To count equals maxVisible exactly
// =============================================================================

test('uiaudit.22: no "+N more" button when recipient count equals maxVisible', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-recip-exact-'))
    const page = ctx.page!

    // uid=9903 — exactly 3 To recipients = maxVisible → no overflow button
    await page.evaluate(async () => {
      await window.api.invoke('e2e:injectMail', {
        accountId: 1,
        folder: 'INBOX',
        uid: 9903,
        from: 'sender@example.test',
        to: 'alice@example.test, bob@example.test, carol@example.test',
        subject: 'E2E Recipient Exact (uid 9903)',
        date: new Date().toISOString(),
        unread: false,
        flagged: false,
        text: 'Exactly maxVisible recipients — no overflow button.',
      })
    })

    const exactItem = page
      .getByTestId('mail-item')
      .filter({ hasText: 'E2E Recipient Exact (uid 9903)' })
      .first()
    await expect(exactItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await exactItem.click()
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // 3 chips visible, no overflow button
    await expect(page.getByTestId('recipient-chip')).toHaveCount(3, { timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('recipient-more-btn')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

// =============================================================================
// Test 10: BCC NOT shown for spoofed mail in Sent folder (identity mismatch)
//
// Threat model (§3.3.C-uiaudit.22): an attacker injects / IMAP-moves a mail
// with their own From address into the victim's Sent folder.  Folder-match
// alone would pass Gate 1 and show BCC.  The identity-match layer (Gate 2 in
// deriveIsSentByMe) must block the BCC row because attacker@example.test is
// not in account-1's identity list (e2e1@example.test).
// =============================================================================

test('uiaudit.22: BCC is NOT shown for spoofed mail in Sent folder (identity mismatch)', async () => {
  const ctx: Partial<AppContext> = {}
  try {
    Object.assign(ctx, await launchApp('mailcopilot-e2e-recip-bcc-spoofed-'))
    const page = ctx.page!

    // Inject a spoofed mail into account-1 Sent folder.
    // from = attacker@example.test ≠ account-1 identity (e2e1@example.test)
    // → Gate 2 identity check fails → isSentByMe = false → BCC must be hidden.
    await page.evaluate(async (uid) => {
      await window.api.invoke('e2e:injectMail', {
        accountId: 1,
        folder: 'Sent',
        uid,
        from: 'attacker@example.test',
        to: 'victim@example.test',
        bcc: 'secret@example.test',
        subject: `E2E BCC Spoofed Sent (uid ${uid})`,
        date: new Date().toISOString(),
        unread: false,
        flagged: false,
        text: 'Spoofed mail in Sent folder — BCC must remain hidden.',
      })
    }, UID_BCC_SPOOFED)

    // Navigate to Sent folder
    await page.getByTestId('folder-Sent').click()

    // Wait for the injected mail to appear
    const spoofedItem = page
      .getByTestId('mail-item')
      .filter({ hasText: `E2E BCC Spoofed Sent (uid ${UID_BCC_SPOOFED})` })
      .first()
    await expect(spoofedItem).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await spoofedItem.click()
    await expect(page.getByTestId('mail-subject')).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Gate 2 (identity mismatch) must prevent BCC row from appearing.
    const metaSection = page.locator('.mail-viewer-meta')
    await expect(metaSection).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(metaSection.getByText('Bcc')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})
