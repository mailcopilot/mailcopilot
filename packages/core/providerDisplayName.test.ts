import { describe, it, expect } from 'vitest'
import {
  normalizeProviderDisplayName,
  MAX_PROVIDER_DISPLAY_NAME_LENGTH,
} from './providerDisplayName'

// Characters are built from escapes rather than pasted as literals: they are
// invisible in an editor, and a literal one in a source file is its own hazard.
const CR = String.fromCharCode(0x0d)
const LF = String.fromCharCode(0x0a)
const TAB = String.fromCharCode(0x09)
const NUL = String.fromCharCode(0x00)
const DEL = String.fromCharCode(0x7f)
const NEL = String.fromCharCode(0x85)
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const RLO = String.fromCharCode(0x202e)
const LRI = String.fromCharCode(0x2066)
const ZWNJ = String.fromCharCode(0x200c)
const ZWJ = String.fromCharCode(0x200d)

describe('normalizeProviderDisplayName §2.94', () => {
  describe('accepts ordinary names', () => {
    it('keeps a plain latin name', () => {
      expect(normalizeProviderDisplayName('Ada Lovelace')).toBe('Ada Lovelace')
    })

    it('keeps non-latin scripts', () => {
      expect(normalizeProviderDisplayName('Сергей Попов')).toBe('Сергей Попов')
      expect(normalizeProviderDisplayName('山田 太郎')).toBe('山田 太郎')
    })

    it('trims surrounding whitespace', () => {
      expect(normalizeProviderDisplayName('  Ada Lovelace  ')).toBe('Ada Lovelace')
    })

    it('keeps joiners that are load-bearing in real scripts and emoji', () => {
      // Rejecting these would drop legitimate Persian/Indic names, so they are
      // deliberately outside the disallowed set.
      expect(normalizeProviderDisplayName(`م${ZWNJ}حمد`)).toBe(`م${ZWNJ}حمد`)
      expect(normalizeProviderDisplayName(`A${ZWJ}B`)).toBe(`A${ZWJ}B`)
    })

    it('accepts a name exactly at the length limit', () => {
      const atLimit = 'a'.repeat(MAX_PROVIDER_DISPLAY_NAME_LENGTH)
      expect(normalizeProviderDisplayName(atLimit)).toBe(atLimit)
    })
  })

  describe('rejects anything not a usable string', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['number', 42],
      ['object', { toString: () => 'Ada' }],
      ['array', ['Ada']],
      ['boolean', true],
    ])('rejects %s instead of throwing', (_label, value) => {
      // The pre-fix code cast the claim to string and called .trim() on it,
      // which threw a TypeError *after* the user had already authorized.
      expect(() => normalizeProviderDisplayName(value)).not.toThrow()
      expect(normalizeProviderDisplayName(value)).toBeUndefined()
    })

    it('rejects empty and whitespace-only names', () => {
      expect(normalizeProviderDisplayName('')).toBeUndefined()
      expect(normalizeProviderDisplayName('   ')).toBeUndefined()
      expect(normalizeProviderDisplayName(TAB)).toBeUndefined()
    })

    it('rejects a name one character over the limit', () => {
      expect(normalizeProviderDisplayName('a'.repeat(MAX_PROVIDER_DISPLAY_NAME_LENGTH + 1))).toBeUndefined()
    })

    it('does not truncate an over-long name — a truncated name is a wrong name', () => {
      const long = 'a'.repeat(MAX_PROVIDER_DISPLAY_NAME_LENGTH + 50)
      expect(normalizeProviderDisplayName(long)).toBeUndefined()
    })
  })

  describe('rejects header-hostile and spoofing characters', () => {
    it('rejects CR and LF — the header-injection primitive', () => {
      // This value would otherwise reach `${name} <${email}>` in the From line.
      expect(normalizeProviderDisplayName(`Ada${CR}${LF}Bcc: attacker@evil.test`)).toBeUndefined()
      expect(normalizeProviderDisplayName(`Ada${LF}B`)).toBeUndefined()
      expect(normalizeProviderDisplayName(`Ada${CR}B`)).toBeUndefined()
    })

    it.each([
      ['NUL', NUL],
      ['TAB', TAB],
      ['DEL', DEL],
      ['C1 NEL', NEL],
      ['line separator', LINE_SEPARATOR],
      ['paragraph separator', PARAGRAPH_SEPARATOR],
    ])('rejects %s', (_label, char) => {
      expect(normalizeProviderDisplayName(`Ada${char}B`)).toBeUndefined()
    })

    it.each([
      ['right-to-left override', RLO],
      ['left-to-right isolate', LRI],
    ])('rejects %s — a name must not render as something else', (_label, char) => {
      expect(normalizeProviderDisplayName(`Ada${char}B`)).toBeUndefined()
    })
  })

  // codex-security-review M1: the send path concatenates the name into
  // `${name} <${email}>` and hands the STRING to nodemailer, which parses it
  // as an address list — so mailbox punctuation in a name is not inert.
  describe('rejects mailbox-grammar characters', () => {
    it('rejects a name that would smuggle a second mailbox into From', () => {
      expect(normalizeProviderDisplayName('Ada Mallory <mallory@evil.test>,')).toBeUndefined()
      expect(normalizeProviderDisplayName('Ada, Mallory <mallory@evil.test>')).toBeUndefined()
    })

    it.each([
      ['angle open', '<'],
      ['angle close', '>'],
      ['comma', ','],
      ['semicolon', ';'],
      ['colon', ':'],
      ['double quote', '"'],
      ['backslash', '\\'],
      ['at sign', '@'],
      ['paren open', '('],
      ['paren close', ')'],
      ['bracket open', '['],
      ['bracket close', ']'],
    ])('rejects %s', (_label, char) => {
      expect(normalizeProviderDisplayName(`Ada${char}B`)).toBeUndefined()
    })

    it('accepts punctuation that carries no mailbox meaning', () => {
      // The cost of the guard is bounded: ordinary names still pass.
      expect(normalizeProviderDisplayName("Mary O'Brien-Smith")).toBe("Mary O'Brien-Smith")
      expect(normalizeProviderDisplayName('J. R. Ewing Jr.')).toBe('J. R. Ewing Jr.')
      expect(normalizeProviderDisplayName('Ada & Charles')).toBe('Ada & Charles')
    })
  })
})
