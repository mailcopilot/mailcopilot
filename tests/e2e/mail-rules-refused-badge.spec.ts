/**
 * §2.202 — the rules list marks a rule the client refuses to run.
 *
 * What this spec can and cannot reach. Since §2.162 the refusal is enforced on
 * every write path, and the last of them is `assertMailRuleAllowed` inside
 * `packages/db` — so in a fresh e2e profile there is NO way to store a
 * policy-refused rule: `rules:create` and `rules:update` both throw, and no
 * e2e-only channel writes `mail_rules` directly. A refused row can only exist
 * because it was stored before that check existed (or by an assistant against
 * an older build), which is exactly the population the badge is for.
 *
 * The positive case — badge shown, reason attached, click opens the editor — is
 * therefore covered where the row can be handed to the screen directly, in
 * `src/windows/Settings.test.tsx` (Part C), which mounts the real Settings
 * component and drives the real branch.
 *
 * What is left for e2e is the half that IS reachable and that no jsdom test can
 * prove: against the real IPC, the real i18n catalogue and real stored rules,
 * a healthy rule carries no such badge. That is the assertion that fails if the
 * renderer ever grows its own, wider copy of the policy — the drift this design
 * exists to prevent, and the failure mode with the higher cost (a badge on
 * working rules teaches the user to ignore all of them).
 */
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, waitForPage, EXPECT_TIMEOUT } from './helpers'

/** Stores a rule through the real IPC, failing loudly if the save is refused. */
async function createRule(
  page: import('@playwright/test').Page,
  name: string,
  conditions: unknown[],
  actions: unknown[],
): Promise<void> {
  await page.evaluate(async ({ ruleName, ruleConditions, ruleActions }) => {
    await window.api.invoke('rules:create', {
      name: ruleName,
      conditions: JSON.stringify(ruleConditions),
      actions: JSON.stringify(ruleActions),
      priority: 0,
      stopProcessing: false,
      accountId: null,
    })
  }, { ruleName: name, ruleConditions: conditions, ruleActions: actions })
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

test('mail rules list: an applicable rule carries no refusal badge', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-badge-clean-')
  try {
    const { page, browser } = ctx
    const ruleName = `E2E Applicable Rule ${Date.now()}`
    await createRule(
      page,
      ruleName,
      [{ field: 'from_address', op: 'contains', value: 'news@example.test' }],
      [{ type: 'archive' }],
    )

    const settings = await openSettingsRulesTab(page, browser)
    const row = settings.locator('.rule-item').filter({ hasText: ruleName })
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })

    // Neither badge: the rule is readable AND its firing is justifiable.
    await expect(row.getByTestId('rule-refused-badge')).toHaveCount(0)
    await expect(row.getByTestId('rule-malformed-badge')).toHaveCount(0)
    // The row shows its counts instead, which is the "nothing is wrong" state.
    await expect(row).toContainText('1 condition')
  } finally {
    await cleanupApp(ctx)
  }
})

test('mail rules list: the display name stays unmarked when it gates a reversible action', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-badge-reversible-')
  try {
    const { page, browser } = ctx
    const ruleName = `E2E Display Name Rule ${Date.now()}`
    // The policy refuses the display name only where it must justify a
    // DESTRUCTIVE action. `mark_read` is reversible, so this rule is legal and
    // must look ordinary — a renderer-side approximation of the rule would
    // mark it and be wrong.
    await createRule(
      page,
      ruleName,
      [{ field: 'from_name', op: 'contains', value: 'Newsletter' }],
      [{ type: 'mark_read' }],
    )

    const settings = await openSettingsRulesTab(page, browser)
    const row = settings.locator('.rule-item').filter({ hasText: ruleName })
    await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })
    await expect(row.getByTestId('rule-refused-badge')).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})

test('mail rules list: a destructive rule on the display name cannot be stored at all', async () => {
  const ctx = await launchApp('mailcopilot-e2e-rules-badge-refused-')
  try {
    const { page, browser } = ctx
    const ruleName = `E2E Refused Rule ${Date.now()}`

    // The premise of the badge, stated as a test: a rule that would earn it
    // cannot be created by this build. If this save ever starts succeeding, the
    // §2.162 guard has regressed — and the badge below would be the only thing
    // telling the user their rule silently does nothing.
    const saved = await page.evaluate(async (name) => {
      try {
        await window.api.invoke('rules:create', {
          name,
          conditions: JSON.stringify([{ field: 'from_name', op: 'contains', value: 'Bank' }]),
          actions: JSON.stringify([{ type: 'trash' }]),
          priority: 0,
          stopProcessing: false,
          accountId: null,
        })
        return { ok: true, message: '' }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }, ruleName)

    expect(saved.ok).toBe(false)
    expect(saved.message).toContain('MAIL_RULE_REFUSED')

    const settings = await openSettingsRulesTab(page, browser)
    await expect(settings.locator('.rule-item').filter({ hasText: ruleName })).toHaveCount(0)
  } finally {
    await cleanupApp(ctx)
  }
})
