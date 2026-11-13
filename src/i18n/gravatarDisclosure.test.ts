import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { SUPPORTED_LANGUAGES } from './index'

const LOCALES = ['en', 'ru', 'fr', 'de', 'es', 'it'] as const

function lookup(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj)
}

describe('Gravatar disclosure', () => {
  it('covers every supported locale', () => {
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual([...LOCALES].sort())
  })

  for (const loc of LOCALES) {
    it(`${loc}: setting hints stay short and name the service`, () => {
      const json = JSON.parse(readFileSync(`src/i18n/locales/${loc}.json`, 'utf8'))
      const mail = String(lookup(json, 'settings.privacy.gravatarInMailHint'))
      const acct = String(lookup(json, 'settings.accounts.gravatarHint'))
      for (const s of [mail, acct]) {
        expect(s).toContain('gravatar.com')
        // Details (algorithm, IP address, defaults, upgrade note) belong to the documentation.
        expect(s).not.toContain('SHA-256')
        expect(s).not.toContain('1.27.2')
        expect(s.length).toBeLessThan(120)
      }
      expect(acct).toContain('{{email}}')
    })

    it(`${loc}: documentation names the hash, the IP address and the upgrade behaviour`, () => {
      const base = loc === 'en'
        ? 'docs/docs'
        : `docs/i18n/${loc}/docusaurus-plugin-content-docs/current`
      for (const f of ['privacy/sender-photos.md', 'legal/privacy-policy.md', 'settings/productivity.md']) {
        const p = `${base}/${f}`
        expect(existsSync(p), p).toBe(true)
        const text = readFileSync(p, 'utf8')
        expect(text, p).toContain('Gravatar')
        expect(text, p).toContain('SHA-256')
        expect(text, p).toMatch(/\bIP\b/)
      }
      // The upgrade behaviour (stored value kept) must be stated wherever the default is.
      for (const f of ['privacy/sender-photos.md', 'legal/privacy-policy.md', 'settings/productivity.md']) {
        expect(readFileSync(`${base}/${f}`, 'utf8'), f).toContain('1.27.2')
      }
    })

    it(`${loc}: installer notice states the new default and what is sent`, () => {
      const text = readFileSync(`build/license_${loc}.txt`, 'utf8')
      expect(text).toContain('Gravatar')
      expect(text).toContain('SHA-256')
      expect(text).toMatch(/\bIP\b/)
      expect(text).toContain('1.27.2')
    })
  }
})
