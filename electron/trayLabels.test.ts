import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  TRAY_LABELS,
  trayLabels,
  truncateForNotification,
  buildNewMailNotification,
  NOTIFICATION_SUBJECT_MAX,
  NOTIFICATION_SENDER_MAX,
} from './trayLabels'

/**
 * Locale coverage — same construction as aiDestinationGuard.test.ts: the i18n
 * merge gate only walks src/i18n/locales/*.json, so a seventh shipped language
 * would silently get an English tray menu unless something reads the directory.
 */
const LOCALE_DIR = fileURLToPath(new URL('../src/i18n/locales', import.meta.url))
const SHIPPED_LOCALES = readdirSync(LOCALE_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.slice(0, -'.json'.length))
  .sort()

describe('trayLabels', () => {
  it('covers every locale that ships in src/i18n/locales', () => {
    expect(SHIPPED_LOCALES.length).toBeGreaterThanOrEqual(6)
    for (const lang of SHIPPED_LOCALES) {
      expect(Object.keys(TRAY_LABELS), `${lang} is missing from TRAY_LABELS`).toContain(lang)
    }
  })

  it('leaves no key empty in any language', () => {
    const enKeys = Object.keys(TRAY_LABELS.en).sort()
    for (const lang of Object.keys(TRAY_LABELS) as Array<keyof typeof TRAY_LABELS>) {
      expect(Object.keys(TRAY_LABELS[lang]).sort(), `${lang} key set`).toEqual(enKeys)
      for (const [key, value] of Object.entries(TRAY_LABELS[lang])) {
        expect(value.trim(), `${lang}.${key}`).not.toBe('')
      }
    }
  })

  it('keeps the {{count}} placeholder in every translation that needs it', () => {
    for (const lang of Object.keys(TRAY_LABELS) as Array<keyof typeof TRAY_LABELS>) {
      expect(TRAY_LABELS[lang].unreadCount, `${lang}.unreadCount`).toContain('{{count}}')
      expect(TRAY_LABELS[lang].newMailCount, `${lang}.newMailCount`).toContain('{{count}}')
    }
  })

  it('falls back to English for unknown or absent codes', () => {
    expect(trayLabels('xx')).toEqual(TRAY_LABELS.en)
    expect(trayLabels(undefined)).toEqual(TRAY_LABELS.en)
    expect(trayLabels('ru')).toEqual(TRAY_LABELS.ru)
  })
})

describe('truncateForNotification', () => {
  it('collapses whitespace and trims', () => {
    expect(truncateForNotification('  hello\n\tworld  ', 50)).toBe('hello world')
  })

  it('hard-truncates hostile lengths with an ellipsis', () => {
    const out = truncateForNotification('x'.repeat(5000), NOTIFICATION_SUBJECT_MAX)
    expect(out.length).toBe(NOTIFICATION_SUBJECT_MAX)
    expect(out.endsWith('…')).toBe(true)
  })

  it('maps null/undefined to an empty string', () => {
    expect(truncateForNotification(null, 10)).toBe('')
    expect(truncateForNotification(undefined, 10)).toBe('')
  })
})

describe('buildNewMailNotification', () => {
  it('shows subject + sender for a single message', () => {
    expect(buildNewMailNotification({ lang: 'en', count: 1, subject: 'Invoice', from: 'Ann' }))
      .toEqual({ title: 'Invoice', body: 'Ann' })
  })

  it('falls back to the localized "new mail" title when the subject is empty', () => {
    expect(buildNewMailNotification({ lang: 'ru', count: 1, subject: '   ', from: 'Ann' }).title)
      .toBe(TRAY_LABELS.ru.newMail)
  })

  it('aggregates a multi-message pass into one localized title', () => {
    const out = buildNewMailNotification({ lang: 'de', count: 12, subject: 'Rechnung', from: 'Ann' })
    expect(out.title).toBe('12 neue Nachrichten')
    expect(out.body).toBe('Rechnung')
  })

  it('truncates both mail-derived parts', () => {
    const out = buildNewMailNotification({
      lang: 'en',
      count: 1,
      subject: 's'.repeat(1000),
      from: 'f'.repeat(1000),
    })
    expect(out.title.length).toBe(NOTIFICATION_SUBJECT_MAX)
    expect(out.body.length).toBe(NOTIFICATION_SENDER_MAX)
  })
})
