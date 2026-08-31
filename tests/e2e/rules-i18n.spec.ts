/**
 * i18n regression for the mail-rules editor's new strings (the `from` →
 * `from_address` / `from_name` split — see ruleFields.ts / RuleConditionRow)
 * in the four longest supported Romance/Germanic languages — German, French,
 * Spanish, Italian. No live IMAP/SMTP account or human judgement needed: this
 * only drives Settings → Rules with a real i18next instance loading the real
 * locale JSON.
 *
 * Russian is deliberately not a fixture here: it is already the e2e default
 * language for mail fixtures elsewhere, and Cyrillic does not produce the same
 * class of dropdown overflow as a long Romance/German compound label — the one
 * defect class this spec exists to catch.
 *
 * Companion to `RuleConditionRow.test.tsx` (jsdom, English-stubbed
 * `useTranslation`). This spec is the one place that actually renders these
 * translations inside the custom `mc-select` portal listbox, whose options
 * carry no `overflow:hidden` / `white-space:nowrap` styling by design (see
 * `.mc-select__option` in `src/App.css` — only the CLOSED trigger's
 * `.mc-select__value` truncates with an ellipsis). If that design regresses
 * and options start clipping, the scrollWidth check below catches it; if a
 * translation key goes missing and i18next falls back to the raw key, the
 * "not a raw key" check catches that.
 */
import { createRequire } from 'node:module'
import { test, expect } from '@playwright/test'
import { launchApp, cleanupApp, selectMcOption, waitForPage, EXPECT_TIMEOUT, type AppContext } from './helpers'

type RulesLocale = {
  settings: {
    rules: {
      conditionField: string
      displayNameCaveat: string
      field: { from_name: string; from: string }
    }
  }
}

/**
 * Fixture copy read straight from the locale JSON instead of transcribed by
 * hand — same pattern and same reason as `quick-actions-instant-reply.spec.ts`
 * (`QUICK_ACTION_REFUSAL`): a hand-copied translation pins this spec to the
 * EXACT wording on the day it was written, so any rewording of
 * `settings.rules.displayNameCaveat` (or of the two field labels) fails the
 * spec regardless of whether the feature still works. That happened for real
 * — the fix-wave that widened the caveat to name archive/mark_spam explicitly
 * (§2.162) broke this spec on DE and FR alone, because only those two
 * transcriptions went stale; the feature itself was fine, and the three
 * `mail-rules-editor.spec.ts` specs (which read `displayNameCaveat`'s value
 * only through the rendered DOM, never a copy of it) stayed green.
 *
 * Reading the value back out of the same JSON the app loads keeps this spec
 * checking exactly what it exists to check — the key resolves to translated
 * text (not English, not a raw `settings.rules.…` key) and that text is not
 * clipped in the `mc-select` dropdown — without also asserting the CONTENT of
 * the translation, which is not this spec's job: wording review belongs to
 * `docs-sync` / `i18n-completeness`, not to an e2e layout regression test.
 */
const rulesLocale = (code: 'de' | 'fr' | 'es' | 'it'): RulesLocale =>
  createRequire(import.meta.url)(`../../src/i18n/locales/${code}.json`) as RulesLocale

type LangFixture = {
  code: 'de' | 'fr' | 'es' | 'it'
  conditionFieldAriaLabel: string
  fromNameLabel: string
  fromLegacyLabel: string
  caveat: string
}

const FIXTURES: LangFixture[] = (['de', 'fr', 'es', 'it'] as const).map((code) => {
  const locale = rulesLocale(code)
  return {
    code,
    conditionFieldAriaLabel: locale.settings.rules.conditionField,
    fromNameLabel: locale.settings.rules.field.from_name,
    fromLegacyLabel: locale.settings.rules.field.from,
    caveat: locale.settings.rules.displayNameCaveat,
  }
})

for (const fx of FIXTURES) {
  test(`i18n (${fx.code}): rule editor field labels and caveat are translated and not clipped in the dropdown`, async () => {
    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp(`mailcopilot-e2e-rules-i18n-${fx.code}-`))
      const page = ctx.page!
      const browser = ctx.browser!

      const ruleName = `E2E i18n Rule ${fx.code} ${Date.now()}`
      await page.evaluate(async (name) => {
        await window.api.invoke('rules:create', {
          name,
          conditions: JSON.stringify([{ field: 'from_name', op: 'contains', value: 'spoof' }]),
          // `mark_read`, not `archive`: since §2.162 a destructive action may
          // not be gated on the sender's own display name, so an `archive`
          // fixture would be refused at save. What this spec checks — the
          // localized field labels and the display-name caveat — is unchanged.
          actions: JSON.stringify([{ type: 'mark_read' }]),
          priority: 0,
          stopProcessing: false,
          accountId: null,
        })
      }, ruleName)

      await page.getByTestId('open-settings').click()
      const settings = await waitForPage(browser, p => p.url().includes('#/settings'))
      await settings.waitForLoadState('domcontentloaded')
      await expect(settings.getByTestId('settings-theme')).toBeVisible({ timeout: 45_000 })

      // A fresh e2e profile always boots in English (§ e2e default language),
      // so the language select's accessible name is always "Language" here —
      // no need to chase a previously-switched label.
      await selectMcOption(settings.getByRole('combobox', { name: 'Language' }), fx.code)

      await settings.getByTestId('settings-tab-rules').click()
      const row = settings.locator('.rule-item').filter({ hasText: ruleName })
      await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT })
      await row.getByTitle('Edit').click()

      // The rule was created on `from_name` — the caveat should already be
      // showing, translated and not horizontally clipped.
      const caveat = settings.getByTestId('rule-display-name-caveat')
      await expect(caveat).toHaveText(fx.caveat)
      const caveatOverflow = await caveat.evaluate(el => el.scrollWidth - el.clientWidth)
      expect(caveatOverflow).toBeLessThanOrEqual(1)

      // Open the field dropdown: every option is real translated text, not a
      // raw i18n key, and not clipped.
      const fieldTrigger = settings.locator('.modal-dialog').getByRole('combobox', { name: fx.conditionFieldAriaLabel })
      await fieldTrigger.click()
      const listbox = settings.locator('[role="listbox"]')
      await expect(listbox).toBeVisible()

      const options = settings.locator('[role="option"]')
      const count = await options.count()
      expect(count).toBeGreaterThan(0)
      for (let i = 0; i < count; i++) {
        const opt = options.nth(i)
        const text = (await opt.textContent())?.trim() ?? ''
        expect(text.length).toBeGreaterThan(0)
        expect(text).not.toMatch(/^settings\.rules\.field\./)
        const overflow = await opt.evaluate(el => el.scrollWidth - el.clientWidth)
        expect(overflow).toBeLessThanOrEqual(1)
      }

      await expect(listbox).toContainText(fx.fromNameLabel)
      // This rule's field is `from_name`, not the deprecated `from` — the
      // legacy option must stay absent (see mail-rules-editor.spec.ts for
      // the case where a rule DOES still use it).
      await expect(listbox).not.toContainText(fx.fromLegacyLabel)

      await settings.keyboard.press('Escape')
    } finally {
      await cleanupApp(ctx)
    }
  })
}
