import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchApp, cleanupApp, type AppContext } from './helpers'

const LANGUAGES = ['en', 'ru', 'fr', 'de', 'es', 'it'] as const
type Language = typeof LANGUAGES[number]

const SCREENSHOT_ROOT = path.join(process.cwd(), 'docs', 'screenshots', 'mailcopilot')

const AI_PROMPT_BY_LANG: Record<Language, string> = {
  en: 'Summarize this email and draft a short professional reply.',
  ru: 'Сделай краткое резюме письма и предложи вежливый ответ.',
  fr: 'Resume cet e-mail et propose une reponse professionnelle courte.',
  de: 'Fasse diese E-Mail kurz zusammen und schlage eine kurze professionelle Antwort vor.',
  es: 'Resume este correo y propone una respuesta profesional breve.',
  it: 'Riassumi questa email e proponi una breve risposta professionale.',
}

const MAIL_SUBJECTS_BY_LANG: Record<Language, { first: string; marketing: string }> = {
  en: { first: 'E2E1: first email', marketing: 'MailCopilot: weekly inbox digest' },
  ru: { first: 'E2E1: первое письмо', marketing: 'MailCopilot: еженедельный дайджест inbox' },
  fr: { first: 'E2E1: premier e-mail', marketing: 'MailCopilot: digest hebdomadaire de la boite de reception' },
  de: { first: 'E2E1: erste E-Mail', marketing: 'MailCopilot: woechentlicher Inbox-Report' },
  es: { first: 'E2E1: primer correo', marketing: 'MailCopilot: resumen semanal de bandeja' },
  it: { first: 'E2E1: prima email', marketing: 'MailCopilot: riepilogo settimanale inbox' },
}

async function applyLanguage(page: Page, lang: Language): Promise<void> {
  await page.evaluate(async (language) => {
    await window.api.invoke('e2e:localizeMails', language)
  }, lang)

  await page.evaluate(async (language) => {
    // Only the fields this test needs. `settings:save` merges its payload
    // into the persisted settings, so echoing the whole object back adds
    // nothing — and any MAIN-ONLY field caught in that echo (§2.103
    // `spellcheckAvailable` is one) makes main refuse the WHOLE payload as
    // `forbidden_field`, silently dropping the configuration below.
    await window.api.invoke('settings:save', {
      language,
      theme: 'light',
      aiProvider: 'openai-api',
      aiOpenAiBaseUrl: 'http://127.0.0.1:11434/v1',
      aiPrivacyConsent: true,
      aiPanelOpen: false,
    })
  }, lang)

  await expect.poll(async () => page.evaluate(() => document.documentElement.lang), { timeout: 10_000 }).toBe(lang)
}

async function ensureSidebarExpanded(page: Page): Promise<void> {
  const expanded = await page.evaluate(() => localStorage.getItem('mailcopilot:sidebar') === '1')
  if (expanded) return
  await page.locator('.sidebar-toggle-btn').click()
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('mailcopilot:sidebar') === '1')).toBe(true)
}

async function captureForLanguage(page: Page, lang: Language): Promise<void> {
  const langDir = path.join(SCREENSHOT_ROOT, lang)
  await fs.mkdir(langDir, { recursive: true })

  await applyLanguage(page, lang)
  await ensureSidebarExpanded(page)
  const subjects = MAIL_SUBJECTS_BY_LANG[lang]

  // 1) Unified Inbox with an open email.
  await page.getByTestId('account-1').click()
  await page.getByTestId('folder-unified').click()
  const firstUnified = page.getByTestId('mail-item').filter({ hasText: subjects.first }).first()
  await expect(firstUnified).toBeVisible()
  await firstUnified.click()
  await expect(page.getByTestId('mail-subject')).toBeVisible()
  await page.screenshot({ path: path.join(langDir, '01-unified-inbox.png') })

  // 2) Presentable HTML email without blocked-images banner.
  await page.getByTestId('account-1').click()
  await page.getByTestId('folder-INBOX').click()
  const marketingMail = page.getByTestId('mail-item').filter({ hasText: subjects.marketing }).first()
  await expect(marketingMail).toBeVisible()
  await marketingMail.click()
  await expect(page.getByTestId('mail-subject')).toHaveText(subjects.marketing)
  await expect(page.getByTestId('images-blocked-banner')).toHaveCount(0)
  await page.screenshot({ path: path.join(langDir, '02-email-view.png') })

  // 3) AI panel with test prompt and test response.
  // Explicitly wait for UI stabilization after language change before clicking
  await expect(page.getByTestId('sidebar-ai')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('sidebar-ai').click()
  await expect(page.getByTestId('ai-panel')).toBeVisible({ timeout: 15_000 })

  const privacyDialog = page.getByTestId('ai-privacy-dialog')
  if (await privacyDialog.count()) {
    await privacyDialog.getByRole('button').last().click()
  }

  const aiInput = page.getByTestId('ai-input')
  await expect(aiInput).toBeVisible()
  const prompt = AI_PROMPT_BY_LANG[lang]
  await aiInput.fill(prompt)
  await aiInput.press('Enter')
  await expect(page.getByTestId('ai-message-user').last()).toContainText(prompt)
  await expect.poll(async () => {
    const texts = await page.getByTestId('ai-message-assistant').allTextContents()
    const last = (texts[texts.length - 1] || '').trim()
    return last.length
  }, { timeout: 15_000 }).toBeGreaterThan(20)
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(langDir, '03-ai-panel.png') })

  await page.getByTestId('sidebar-ai').click()
  await expect(page.getByTestId('ai-panel')).toHaveCount(0)
}

test.describe.serial('marketing screenshots', () => {
  test('generate localized screenshots for all app languages', async () => {
    test.setTimeout(240_000)

    await fs.rm(SCREENSHOT_ROOT, { recursive: true, force: true })

    const ctx: Partial<AppContext> = {}
    try {
      Object.assign(ctx, await launchApp('mailcopilot-e2e-marketing-'))
      const page = ctx.page!

      for (const lang of LANGUAGES) {
        await captureForLanguage(page, lang)
      }
    } finally {
      await cleanupApp(ctx)
    }
  })
})
