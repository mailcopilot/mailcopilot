/**
 * §2.218 — the "Claude subscription" AI provider was removed (Anthropic's
 * Consumer Terms do not permit driving a Pro/Max session from a third-party
 * client). Four i18n keys existed only to label that option and its error
 * state: `ai.onboarding.subscription`, `ai.onboarding.subscriptionHint`,
 * `ai.errors.noSubscription`, `ai.settings.providerSubscription`.
 *
 * Nothing in the app reads them anymore (grep confirms zero `t('ai.onboarding
 * .subscription')` etc. call sites), so a stale entry left behind in ANY of
 * the 6 locale files would be silent dead weight — or worse, a half-finished
 * revert that restores the key in one locale but not the others, which no
 * runtime code path would ever surface. This test pins the removal
 * per-locale rather than trusting a single "en is clean" check, because the
 * implementation risk here is exactly a partial revert.
 */
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LANGUAGES } from './index'
import enLocale from './locales/en.json'
import ruLocale from './locales/ru.json'
import frLocale from './locales/fr.json'
import deLocale from './locales/de.json'
import esLocale from './locales/es.json'
import itLocale from './locales/it.json'

const LOCALES: Record<string, unknown> = {
  en: enLocale,
  ru: ruLocale,
  fr: frLocale,
  de: deLocale,
  es: esLocale,
  it: itLocale,
}

function lookup(bundle: unknown, dottedKey: string): unknown {
  let node: unknown = bundle
  for (const segment of dottedKey.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

const REMOVED_KEYS = [
  'ai.onboarding.subscription',
  'ai.onboarding.subscriptionHint',
  'ai.errors.noSubscription',
  'ai.settings.providerSubscription',
] as const

describe('removed AI subscription i18n keys stay removed (§2.218)', () => {
  // Sanity: the locale set this test iterates is the same set the app ships,
  // not a hand-copied subset that could silently drop a locale from coverage.
  it('covers every supported language', () => {
    expect(Object.keys(LOCALES).sort()).toEqual([...SUPPORTED_LANGUAGES].sort())
  })

  for (const lang of SUPPORTED_LANGUAGES) {
    it(`${lang} does not define any of the 4 removed keys`, () => {
      for (const key of REMOVED_KEYS) {
        expect(lookup(LOCALES[lang], key), `${lang}.${key} should not exist`).toBeUndefined()
      }
    })
  }
})
