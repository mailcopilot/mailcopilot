import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  EMAIL_ADDRESS_MAX_LENGTH,
  EMAIL_ADDRESS_PATTERN,
  PREFILL_ADDRESS_LIST_MAX,
  emailAddressSchema,
  isEmailAddress,
  prefillAddressListSchema,
  trimmedEmailAddressSchema,
} from './emailAddress'

/**
 * The addresses that used to be rejected. Kept in one list so every schema in
 * this module is proven against the same set, and so a future reader sees the
 * bug rather than a bare regex.
 */
const PREVIOUSLY_REJECTED = [
  // Punycode `.рф` — the form an IMAP header actually carries.
  'info@xn--80a1acny.xn--p1ai',
  // Its unicode spelling, the form a user types into the account wizard.
  'user@почта.рф',
  // Plain ASCII: `=` is RFC 5322 atext, used routinely by list software.
  'a=b@example.com',
  // Cyrillic local part (needs SMTPUTF8 to SEND, but must not block a reply).
  'почта@example.com',
]

describe('the defect this module exists to fix', () => {
  // This is the "reproduce first" half. It does not test our code — it pins
  // the zod behaviour that made the fix necessary, so that if a future zod
  // release changes `z.email()` the reason for this module is re-examined
  // rather than silently kept forever.
  it.each(PREVIOUSLY_REJECTED)('zod\'s default email validator rejects %s', (address) => {
    expect(z.string().email().safeParse(address).success).toBe(false)
  })

  it.each(PREVIOUSLY_REJECTED)('the shared schema accepts %s', (address) => {
    expect(emailAddressSchema.safeParse(address).success).toBe(true)
  })
})

describe('emailAddressSchema', () => {
  it.each([
    'test@example.com',
    'user+tag@sub.domain.org',
    "o'brien@example.com",
    'a@b.co',
  ])('accepts the ordinary address %s', (address) => {
    expect(emailAddressSchema.safeParse(address).success).toBe(true)
  })

  it.each([
    ['no at sign', 'bad'],
    ['empty', ''],
    ['local part only', 'user@'],
    ['domain only', '@example.com'],
    ['two at signs', 'a@b@c.com'],
  ])('rejects %s', (_label, address) => {
    expect(emailAddressSchema.safeParse(address).success).toBe(false)
  })

  // The header-injection half of the guarantee. CR/LF are `\s`, which the
  // library pattern excludes — nothing accepted here can open a second header
  // line in a From/To we compose.
  it.each([
    ['carriage return', 'a@b.com\r\nBcc: victim@example.com'],
    ['line feed', 'a@b.com\nBcc: victim@example.com'],
    ['space', 'a b@example.com'],
    ['tab', 'a\tb@example.com'],
    ['double quote', '"quoted"@example.com'],
  ])('rejects %s', (_label, address) => {
    expect(emailAddressSchema.safeParse(address).success).toBe(false)
  })

  // One address means ONE address. The library pattern permits these; the
  // refinement on top does not, because the account/identity address these
  // schemas guard is what builds the From header.
  // The library pattern lets all of these through (measured on zod 4.4.3):
  // it excludes `"` only in the local part and excludes non-whitespace control
  // characters nowhere. FORBIDDEN_ADDRESS_CHARS puts them back out.
  it.each([
    ['a quote in the domain', 'a@ex"ample.com'],
    ['a C0 control in the domain', 'a@b\u0001c.com'],
    ['a NUL in the local part', 'abc\u0000d@e.com'],
    ['a zero-width space', 'a@b​c.com'],
    ['a bidi override', 'a‮b@example.com'],
    ['a DEL character', 'a\u007fb@example.com'],
  ])('rejects %s', (_label, address) => {
    expect(emailAddressSchema.safeParse(address).success).toBe(false)
  })

  it.each([
    ['comma-separated list', 'a@x.com,b@y.com'],
    ['semicolon-separated list', 'a@x.com;b@y.com'],
    ['group syntax', 'Label:a@x.com'],
    ['angle brackets', '<a@x.com>'],
    ['display name form', 'Name <a@x.com>'],
  ])('rejects %s', (_label, address) => {
    expect(emailAddressSchema.safeParse(address).success).toBe(false)
  })

  it('rejects an address longer than the pattern can ever match', () => {
    const tooLong = `${'a'.repeat(64)}@${'b'.repeat(300)}.com`
    expect(tooLong.length).toBeGreaterThan(EMAIL_ADDRESS_MAX_LENGTH)
    expect(emailAddressSchema.safeParse(tooLong).success).toBe(false)
  })

  it('uses the pattern zod ships, not one written here', () => {
    expect(EMAIL_ADDRESS_PATTERN).toBe(z.regexes.unicodeEmail)
  })
})

describe('trimmedEmailAddressSchema', () => {
  it('strips surrounding whitespace before validating', () => {
    expect(trimmedEmailAddressSchema.parse('  user@почта.рф \n')).toBe('user@почта.рф')
  })

  it('still rejects an address that is only whitespace around junk', () => {
    expect(trimmedEmailAddressSchema.safeParse('   bad   ').success).toBe(false)
  })

  it('rejects a non-string', () => {
    expect(trimmedEmailAddressSchema.safeParse(42).success).toBe(false)
  })
})

describe('isEmailAddress', () => {
  it('accepts a punycode IDN address', () => {
    expect(isEmailAddress('info@xn--80a1acny.xn--p1ai')).toBe(true)
  })

  it.each([undefined, null, 42, {}, [], 'bad'])('rejects %s', (value) => {
    expect(isEmailAddress(value)).toBe(false)
  })
})

describe('prefillAddressListSchema', () => {
  // The regression that started this: one odd address in the replied-to
  // message's Cc rejected the whole `ui:openCompose` payload, so "Reply"
  // opened no window at all.
  it('keeps the good addresses and drops the junk instead of failing', () => {
    const result = prefillAddressListSchema.safeParse([
      'info@xn--80a1acny.xn--p1ai',
      'not-an-address',
      'user@почта.рф',
      'a@x.com,b@y.com',
      'friend@example.com',
    ])
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual([
      'info@xn--80a1acny.xn--p1ai',
      'user@почта.рф',
      'friend@example.com',
    ])
  })

  it('never fails on a list of entries that are not strings', () => {
    const result = prefillAddressListSchema.safeParse([null, 42, {}, ['a@b.com'], undefined])
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual([])
  })

  it('truncates an oversized list rather than rejecting it', () => {
    const huge = Array.from({ length: PREFILL_ADDRESS_LIST_MAX + 50 }, (_, i) => `u${i}@example.com`)
    const result = prefillAddressListSchema.safeParse(huge)
    expect(result.success).toBe(true)
    expect(result.success && result.data).toHaveLength(PREFILL_ADDRESS_LIST_MAX)
  })

  it('accepts an empty list', () => {
    expect(prefillAddressListSchema.parse([])).toEqual([])
  })

  it('drops an entry carrying a control character', () => {
    const result = prefillAddressListSchema.safeParse(['a\u0000b@example.com', 'ok@example.com'])
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual(['ok@example.com'])
  })

  it.each([
    ['a bare string', 'a@b.com'],
    ['an object', { 0: 'a@b.com' }],
    ['null', null],
  ])('still rejects %s — the guarantee covers entries, not the shape', (_label, value) => {
    expect(prefillAddressListSchema.safeParse(value).success).toBe(false)
  })
})

describe('bundle hygiene', () => {
  // Same rule as language.ts: the core barrel is pulled into the RENDERER
  // bundle, which carries no zod today. Re-exporting this module from the
  // barrel would add it for a validator only the main process uses.
  it('is not re-exported from the core barrel', () => {
    const barrel = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
    expect(barrel).not.toContain('emailAddress')
  })
})
