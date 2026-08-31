/**
 * Static mail-rules editor (Settings → Rules) — no e2e coverage existed for
 * this screen before. Covers the `from` → `from_address` / `from_name` split
 * documented in `src/components/ruleFields.ts` and exercised at the unit
 * level in `src/components/RuleConditionRow.test.tsx`: this spec is the one
 * place that drives the real Settings window (real i18n, real `mc-select`
 * portal, real IPC round-trip to `packages/db`) rather than a jsdom stub.
 *
 * Rules are seeded through the real `rules:create` IPC (not the UI) so each
 * test starts from a known condition shape; the UI is only used for the
 * behaviour under test (what the editor shows/allows).
 */
import { test, expect } from '@playwright/test'
import {
  launchApp, cleanupApp, waitForPage, selectMcOption, EXPECT_TIMEOUT,
} from './helpers'

/**
 * Seeds the legacy-`from` rule these specs are about.
 *
 * The action is `mark_read`, not `archive`: since §2.162 the save path refuses
 * a rule that gates a DESTRUCTIVE action (move / trash / archive / mark_spam)
 * on the legacy sender field, because the sender writes that value about
 * themselves. `mark_read` is reversible and stays allowed on that field, so
 * this is still a genuine legacy rule — which is all these specs need, since
 * what they exercise is how the editor presents the legacy FIELD.
 */
async function createLegacyFromRule(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.evaluate(async (ruleName) => {
    await window.api.invoke('rules:create', {
      name: ruleName,
      conditions: JSON.stringify([{ field: 'from', op: 'contains', value: 'legacy@example.test' }]),
      actions: JSON.stringify([{ type: 'mark_read' }]),
      priority: 0,
      stopProcessing: false,
      accountId: null,
    })
  }, name)
}

async function openSettingsRulesTab(
  page: import('@playwright/test').Page,
  browser: import('@playwright/test').Browser,
): Promise<import('@playwright/test').Page> {
  await page.getByTestId('open-settings').click()
  const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
  await settings.waitForLoadState('domcontentloaded')
  await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })
  await settings.getByTestId('settings-tab-rules').click()
  return settings
}

test('mail rules editor: legacy `from` field stays visible with the display-name caveat on an existing rule', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-legacy-')
  try {
    const { page, browser } = ctx
    const ruleName = `E2E Legacy Rule ${Date.now()}`
    await createLegacyFromRule(page, ruleName)

    const settings = await openSettingsRulesTab(page, browser)
    const row = settings.locator('.rule-item').filter({ hasText: ruleName })
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await row.getByTitle('Edit').click()

    const fieldTrigger = settings.locator('.modal-dialog').getByRole('combobox', { name: 'Condition field' })
    await expect(fieldTrigger).toHaveAttribute('data-selected-value', 'from')

    // The caveat fires for the legacy field too — it also matches the
    // sender-chosen display name, not just the address.
    await expect(settings.getByTestId('rule-display-name-caveat')).toBeVisible()

    // The deprecated option is still offered while a condition uses it.
    await fieldTrigger.click()
    const listbox = settings.locator('[role="listbox"]')
    await expect(listbox).toContainText('From — name or address (legacy)')
    await settings.keyboard.press('Escape')
  } finally {
    await cleanupApp(ctx)
  }
})

test('mail rules editor: a new rule defaults to from_address and never offers the legacy field', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-new-')
  try {
    const { page, browser } = ctx
    const settings = await openSettingsRulesTab(page, browser)

    await settings.getByRole('button', { name: 'Add Rule' }).click()

    const fieldTrigger = settings.locator('.modal-dialog').getByRole('combobox', { name: 'Condition field' })
    await expect(fieldTrigger).toHaveAttribute('data-selected-value', 'from_address')
    await expect(settings.getByTestId('rule-display-name-caveat')).not.toBeVisible()

    await fieldTrigger.click()
    const listbox = settings.locator('[role="listbox"]')
    await expect(listbox).toContainText('From — address')
    await expect(listbox).toContainText('From — display name')
    await expect(listbox).not.toContainText('From — name or address (legacy)')
    await settings.keyboard.press('Escape')
  } finally {
    await cleanupApp(ctx)
  }
})

test('mail rules editor: switching the legacy field to from_address persists and the legacy option disappears on reopen', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-migrate-')
  try {
    const { page, browser } = ctx
    const ruleName = `E2E Legacy Migrate ${Date.now()}`
    await createLegacyFromRule(page, ruleName)

    const settings = await openSettingsRulesTab(page, browser)
    const row = settings.locator('.rule-item').filter({ hasText: ruleName })
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await row.getByTitle('Edit').click()

    const fieldTrigger = settings.locator('.modal-dialog').getByRole('combobox', { name: 'Condition field' })
    await expect(fieldTrigger).toHaveAttribute('data-selected-value', 'from')

    await selectMcOption(fieldTrigger, 'from_address')
    await expect(fieldTrigger).toHaveAttribute('data-selected-value', 'from_address')

    await settings.locator('.modal-dialog').getByRole('button', { name: 'Save' }).click()
    // The modal is conditionally rendered on `editingRule`; save clears it.
    await expect(settings.locator('.modal-dialog')).toHaveCount(0)

    // Reopen — this is the persistence check, not just in-memory state.
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await row.getByTitle('Edit').click()
    const reopenedTrigger = settings.locator('.modal-dialog').getByRole('combobox', { name: 'Condition field' })
    await expect(reopenedTrigger).toHaveAttribute('data-selected-value', 'from_address')
    await expect(settings.getByTestId('rule-display-name-caveat')).not.toBeVisible()

    await reopenedTrigger.click()
    await expect(settings.locator('[role="listbox"]')).not.toContainText('From — name or address (legacy)')
    await settings.keyboard.press('Escape')
  } finally {
    await cleanupApp(ctx)
  }
})

test('mail rules editor: from_address matches only the real sender address, never a display name that spoofs it (rules:test IPC)', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-test-ipc-')
  try {
    const { page } = ctx

    // Message A: the DISPLAY NAME spoofs the target address; the real
    // envelope address is unrelated. A from_address condition on the target
    // must NOT match this — matching would mean the condition trusts the
    // sender-chosen label, exactly the vulnerability the field split fixes.
    const spoofUid = 9801
    await page.evaluate(async (uid) => {
      await window.api.invoke('e2e:injectMail', {
        accountId: 1,
        folder: 'INBOX',
        uid,
        from: '"attacker@evil.example" <not-attacker@example.test>',
        to: 'e2e1@example.test',
        subject: `E2E rules:test spoof-attempt ${uid}`,
        date: new Date().toISOString(),
        unread: true,
        flagged: false,
        text: 'Display name spoofs the target address; real address differs.',
      })
    }, spoofUid)

    // Message B: the real envelope address IS the target; the display name
    // is unrelated/innocuous. A from_address condition on the target MUST
    // match this one.
    const realUid = 9802
    await page.evaluate(async (uid) => {
      await window.api.invoke('e2e:injectMail', {
        accountId: 1,
        folder: 'INBOX',
        uid,
        from: '"Totally Legit Sender" <attacker@evil.example>',
        to: 'e2e1@example.test',
        subject: `E2E rules:test real-sender ${uid}`,
        date: new Date().toISOString(),
        unread: true,
        flagged: false,
        text: 'Real envelope address is the target; display name is innocuous.',
      })
    }, realUid)

    // Wait for both to land in the DB-backed message store `rules:test`
    // reads from (`net:inboxSummaries` upserts on the `mail:exists` broadcast
    // triggered by each injection).
    await expect(page.getByTestId('mail-item').filter({ hasText: `E2E rules:test spoof-attempt ${spoofUid}` }).first())
      .toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(page.getByTestId('mail-item').filter({ hasText: `E2E rules:test real-sender ${realUid}` }).first())
      .toBeVisible({ timeout: EXPECT_TIMEOUT })

    const matches = await page.evaluate(async () => {
      return await window.api.invoke('rules:test', {
        conditions: JSON.stringify([{ field: 'from_address', op: 'equals', value: 'attacker@evil.example' }]),
        accountId: '1',
      })
    }) as Array<{ uid: number; subject: string; from: string }>

    const matchedUids = matches.map(m => m.uid)
    expect(matchedUids).not.toContain(spoofUid)
    expect(matchedUids).toContain(realUid)
  } finally {
    await cleanupApp(ctx)
  }
})

/**
 * Seeds a rule on `from_name` (the display name only, not the legacy field)
 * with a harmless action — the only shape `rules:create` still allows on that
 * field since §2.162's review closed the gap where a destructive action could
 * be gated on the sender's own display name (the AI tool contract always
 * claimed this was enforced; nothing was, until that review).
 */
async function createFromNameRule(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.evaluate(async (ruleName) => {
    await window.api.invoke('rules:create', {
      name: ruleName,
      conditions: JSON.stringify([{ field: 'from_name', op: 'contains', value: 'Spoofed Support' }]),
      actions: JSON.stringify([{ type: 'mark_read' }]),
      priority: 0,
      stopProcessing: false,
      accountId: null,
    })
  }, name)
}

// ---------------------------------------------------------------------------
// §2.162 — rules whose firing cannot be justified
// ---------------------------------------------------------------------------
//
// `rules:create` now refuses every shape this feature is about (a `cc`
// condition; the legacy `from` or `from_name` next to a destructive action;
// JSON that is not shaped like a rule at all) before anything is persisted —
// see `packages/db/mailRuleGuard.test.ts` and `packages/core/mailRules.test.ts`.
// That is a real gap for e2e coverage of the "already-saved forbidden rule"
// scenarios (a `cc` rule, or a `from`/`from_name`+trash rule created before the
// guard existed): there is no live IPC path left to seed one, only a raw SQL
// insert (`rawSeedRule` in the db test), which e2e cannot reach without a new
// production IPC handler. What e2e CAN drive end-to-end, and what these specs
// cover, is (a) the save path refusing a rule the moment it becomes
// unjustifiable inside the live editor, with the real i18n catalogue turning
// the wire code into the sentence the user sees, and (b) the one patch shape
// the guard deliberately never checks — enable/disable from the rule list —
// which is inline JSX with no hook of its own to unit-test.

test('mail rules editor: pairing the legacy `from` field with a destructive action is refused, not silently saved', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-refuse-')
  try {
    const { page, browser } = ctx
    const ruleName = `E2E Refuse Rule ${Date.now()}`
    // Seeded with `mark_read` — the only destructive-free action §2.162 still
    // lets a `from` condition through `rules:create` with (see the helper's
    // own doc comment above).
    await createLegacyFromRule(page, ruleName)

    const settings = await openSettingsRulesTab(page, browser)
    const row = settings.locator('.rule-item').filter({ hasText: ruleName })
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await row.getByTitle('Edit').click()

    // Starting point: advice, not a refusal — the only action is cosmetic.
    await expect(settings.getByTestId('rule-display-name-caveat')).toBeVisible()
    await expect(settings.getByTestId('rule-unverifiable-sender-caveat')).not.toBeVisible()

    const actionTrigger = settings.locator('.modal-dialog').getByRole('combobox', { name: 'Action type' })
    await selectMcOption(actionTrigger, 'trash')

    // The moment the rule holds a destructive action next to the legacy
    // field, the milder caveat is replaced by the refusal — before Save is
    // even clicked, so the user is warned ahead of the failed attempt.
    await expect(settings.getByTestId('rule-unverifiable-sender-caveat')).toBeVisible()
    await expect(settings.getByTestId('rule-display-name-caveat')).not.toBeVisible()

    let dialogMessage = ''
    settings.on('dialog', d => {
      dialogMessage = d.message()
      void d.accept()
    })
    await settings.locator('.modal-dialog').getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => dialogMessage, { timeout: EXPECT_TIMEOUT }).not.toBe('')

    // The user is told WHY — a decoded, localised sentence naming the field,
    // the action and the fix — never the raw wire code (`MAIL_RULE_REFUSED:…`)
    // and never the generic fallback that would leave them unable to tell a
    // refusal apart from a database error.
    expect(dialogMessage).not.toContain('MAIL_RULE_REFUSED')
    expect(dialogMessage).not.toContain('Please try again')
    expect(dialogMessage).toContain('not saved')
    expect(dialogMessage).toContain('Move to trash')
    expect(dialogMessage).toContain('From — address')

    // The rule was never persisted: the editor stays open on the rejected
    // state rather than discarding the user's edit or silently closing as if
    // the save had gone through.
    await expect(settings.locator('.modal-dialog')).toBeVisible()
    await expect(actionTrigger).toHaveAttribute('data-selected-value', 'trash')
  } finally {
    await cleanupApp(ctx)
  }
})

test('mail rules editor: from_name carries the same refusal as the legacy field, not just advice', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-from-name-')
  try {
    const { page, browser } = ctx
    const ruleName = `E2E FromName Rule ${Date.now()}`
    await createFromNameRule(page, ruleName)

    const settings = await openSettingsRulesTab(page, browser)
    const row = settings.locator('.rule-item').filter({ hasText: ruleName })
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await row.getByTitle('Edit').click()

    const fieldTrigger = settings.locator('.modal-dialog').getByRole('combobox', { name: 'Condition field' })
    await expect(fieldTrigger).toHaveAttribute('data-selected-value', 'from_name')

    // mark_read is reversible, so a display-name match on it is still only
    // advice — the same soft caveat a from_address rule never shows, but not
    // the refusal a destructive action would get.
    await expect(settings.getByTestId('rule-display-name-caveat')).toBeVisible()
    await expect(settings.getByTestId('rule-unverifiable-sender-caveat')).not.toBeVisible()

    const actionTrigger = settings.locator('.modal-dialog').getByRole('combobox', { name: 'Action type' })
    await selectMcOption(actionTrigger, 'archive')

    // §2.162's review found the tool contract had always CLAIMED this was
    // enforced for from_name while nothing in the code did. This is the row
    // that would have stayed silent under the old behaviour.
    await expect(settings.getByTestId('rule-unverifiable-sender-caveat')).toBeVisible()
    await expect(settings.getByTestId('rule-display-name-caveat')).not.toBeVisible()

    let dialogMessage = ''
    settings.on('dialog', d => {
      dialogMessage = d.message()
      void d.accept()
    })
    await settings.locator('.modal-dialog').getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => dialogMessage, { timeout: EXPECT_TIMEOUT }).not.toBe('')

    // Decoded and field-specific — "From — display name", not the legacy
    // field's label, and not the raw wire code or the generic fallback. If the
    // renderer ever hardcoded the legacy field's copy instead of reading
    // `condition.field`, this is the assertion that would catch it.
    expect(dialogMessage).not.toContain('MAIL_RULE_REFUSED')
    expect(dialogMessage).not.toContain('Please try again')
    expect(dialogMessage).toContain('not saved')
    expect(dialogMessage).toContain('From — display name')
    expect(dialogMessage).not.toContain('From — name or address (legacy)')
    expect(dialogMessage).toContain('Archive')
    expect(dialogMessage).toContain('From — address')

    await expect(settings.locator('.modal-dialog')).toBeVisible()
  } finally {
    await cleanupApp(ctx)
  }
})

test('mail rules editor: the list enable/disable toggle patches only `enabled`, bypassing no data', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-toggle-')
  try {
    const { page, browser } = ctx
    const ruleName = `E2E Toggle Rule ${Date.now()}`
    await createLegacyFromRule(page, ruleName)

    const settings = await openSettingsRulesTab(page, browser)
    const row = settings.locator('.rule-item').filter({ hasText: ruleName })
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })

    const toggle = row.locator('input[type="checkbox"]')
    await expect(toggle).toBeChecked()

    // The list toggle sends ONLY `{ enabled }` through `rules:update` — no
    // conditions, no actions — which is the one patch shape §2.162 leaves
    // unchecked on purpose (see `packages/db/mailRuleGuard.test.ts`, "lets the
    // user DISABLE a rule stored before the guard existed"). This is the
    // escape hatch a user is left with for a rule the guard would now refuse
    // to re-save, and unlike the rest of the editor it is inline JSX with no
    // hook of its own — a unit test cannot reach it.
    await toggle.click()
    await expect(toggle).not.toBeChecked()

    // Persisted, not just local React state — leave the tab and come back.
    await settings.getByTestId('settings-tab-templates').click()
    await settings.getByTestId('settings-tab-rules').click()
    const reloadedRow = settings.locator('.rule-item').filter({ hasText: ruleName })
    await expect(reloadedRow).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(reloadedRow.locator('input[type="checkbox"]')).not.toBeChecked()

    // And back on — the identical code path, the identical patch shape.
    await reloadedRow.locator('input[type="checkbox"]').click()
    await expect(reloadedRow.locator('input[type="checkbox"]')).toBeChecked()
  } finally {
    await cleanupApp(ctx)
  }
})

// ---------------------------------------------------------------------------
// §2.203 — a `move` with no target folder is refused, not silently applied
// ---------------------------------------------------------------------------
//
// `rules:create` refuses a folderless `move` outright now (as `malformed_rule`
// — see `packages/core/mailRules.test.ts` "a move action must name where it
// moves mail"), so there is no live path to seed an ALREADY-BROKEN stored move
// rule for e2e either, same limitation as the §2.162 block above. What IS
// reachable live is the one thing the renderer actually built for a human at
// the keyboard: seed a well-formed move rule, then blank the folder field in
// the editor and watch Save refuse to let the user save that.

test('mail rules editor: clearing the target folder of a move action disables Save until it is named again', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-move-folder-')
  try {
    const { page, browser } = ctx
    const ruleName = `E2E Move Folder Rule ${Date.now()}`
    await page.evaluate(async (name) => {
      await window.api.invoke('rules:create', {
        name,
        conditions: JSON.stringify([{ field: 'subject', op: 'contains', value: 'invoice' }]),
        actions: JSON.stringify([{ type: 'move', folder: 'Invoices' }]),
        priority: 0,
        stopProcessing: false,
        accountId: null,
      })
    }, ruleName)

    const settings = await openSettingsRulesTab(page, browser)
    const row = settings.locator('.rule-item').filter({ hasText: ruleName })
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await row.getByTitle('Edit').click()

    const saveButton = settings.getByTestId('rule-editor-save')
    const folderInput = settings.locator('.modal-dialog').getByPlaceholder('Folder name')
    await expect(folderInput).toHaveValue('Invoices')
    await expect(saveButton).toBeEnabled()
    await expect(settings.getByTestId('rule-move-folder-required')).not.toBeVisible()

    // Clear the box, as a user removing the target would.
    await folderInput.fill('')
    await expect(settings.getByTestId('rule-move-folder-required')).toBeVisible()
    await expect(saveButton).toBeDisabled()

    // Whitespace is the same defect, not an escape hatch — IMAP mailbox names
    // may contain spaces, so the check cannot treat "non-empty" as "named".
    await folderInput.fill('   ')
    await expect(settings.getByTestId('rule-move-folder-required')).toBeVisible()
    await expect(saveButton).toBeDisabled()

    // Naming a target folder again lifts both the warning and the block —
    // this is not a one-way trip into a stuck editor.
    await folderInput.fill('Receipts')
    await expect(settings.getByTestId('rule-move-folder-required')).not.toBeVisible()
    await expect(saveButton).toBeEnabled()

    await saveButton.click()
    await expect(settings.locator('.modal-dialog')).toHaveCount(0)

    // Persisted, not just local state — reopen and check the stored value.
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await row.getByTitle('Edit').click()
    await expect(settings.locator('.modal-dialog').getByPlaceholder('Folder name')).toHaveValue('Receipts')
  } finally {
    await cleanupApp(ctx)
  }
})
