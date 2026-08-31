/**
 * §2.127 — drift guard between the closed error vocabulary and the locales.
 *
 * `ERROR_PRESENTATION_I18N_KEYS` in packages/core/errorPresentation.ts is the
 * only thing the renderer is allowed to show for a failed IPC call. If a key is
 * added to that enum without a translation, the user gets the raw key on screen
 * ("app.errors.presented.throttled") — which is exactly the class of nonsense
 * this task removed. i18n-completeness catches missing keys at merge time; this
 * test catches them at `npm test` time, and specifically ties the enum to the
 * files rather than comparing locales to each other.
 */
import { describe, expect, it } from 'vitest'
import { ERROR_PRESENTATION_I18N_KEYS, ERROR_PRESENTATION_KEYS } from '@mailcopilot/core'
import enLocale from './locales/en.json'
import ruLocale from './locales/ru.json'
import frLocale from './locales/fr.json'
import deLocale from './locales/de.json'
import esLocale from './locales/es.json'
import itLocale from './locales/it.json'

const LOCALES: Array<[string, unknown]> = [
  ['en', enLocale],
  ['ru', ruLocale],
  ['fr', frLocale],
  ['de', deLocale],
  ['es', esLocale],
  ['it', itLocale],
]

function lookup(bundle: unknown, dottedKey: string): unknown {
  let node: unknown = bundle
  for (const segment of dottedKey.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

describe('error presentation vocabulary — locale coverage (§2.127)', () => {
  it('maps every vocabulary entry to an i18n key', () => {
    expect(Object.keys(ERROR_PRESENTATION_I18N_KEYS).sort()).toEqual(
      [...ERROR_PRESENTATION_KEYS].sort(),
    )
  })

  for (const [language, bundle] of LOCALES) {
    it(`${language} translates every vocabulary entry to a non-empty sentence`, () => {
      for (const key of ERROR_PRESENTATION_KEYS) {
        const value = lookup(bundle, ERROR_PRESENTATION_I18N_KEYS[key])
        expect(typeof value, `${language} is missing ${ERROR_PRESENTATION_I18N_KEYS[key]}`).toBe(
          'string',
        )
        expect((value as string).trim().length).toBeGreaterThan(0)
      }
    })
  }

  it('keeps the sentences free of interpolation placeholders', () => {
    // These sentences are substituted INTO other keys ("Sync error: {{error}}"),
    // so they must be terminal text. A nested {{...}} would render literally.
    for (const [language, bundle] of LOCALES) {
      for (const key of ERROR_PRESENTATION_KEYS) {
        const value = lookup(bundle, ERROR_PRESENTATION_I18N_KEYS[key]) as string
        expect(value, `${language}.${key} must not interpolate`).not.toMatch(/\{\{/)
      }
    }
  })
})
