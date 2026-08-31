import { describe, expect, it, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §2.110 — `certCommonName()` joins a certificate RDN attribute (`string |
 * string[] | undefined`, as Node's `tls` module surfaces a repeated CN) into
 * the single display string shown in the cert-recovery dialog. It is a pure,
 * self-contained helper with no free identifiers besides its own parameter,
 * so unlike the other main.ts source-mirror suites in this repo (which can
 * only assert against the source text), this one can actually EXECUTE the
 * extracted function body and pin its real behavior — not just that the
 * right tokens appear in the source.
 *
 * electron/main.ts itself cannot be imported in a unit test (module-level
 * side effects: window creation, IPC registration, DB open).
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

let certCommonName: (cn: string | string[] | undefined) => string | undefined

beforeAll(() => {
  const fnStart = MAIN_TS.indexOf('function certCommonName(')
  expect(fnStart).toBeGreaterThan(-1)
  const braceStart = MAIN_TS.indexOf('{', fnStart)
  const braceEnd = MAIN_TS.indexOf('\n}', braceStart)
  expect(braceEnd).toBeGreaterThan(braceStart)
  const body = MAIN_TS.slice(braceStart + 1, braceEnd)
  certCommonName = new Function('cn', body) as typeof certCommonName
})

describe('main.ts certCommonName()', () => {
  it('passes a single string through unchanged', () => {
    expect(certCommonName('mail.example.com')).toBe('mail.example.com')
  })

  it('joins a repeated RDN array without dropping any value', () => {
    expect(certCommonName(['mail.example.com', 'legacy.example.com'])).toBe(
      'mail.example.com, legacy.example.com',
    )
  })

  it('joins a three-element array in order', () => {
    expect(certCommonName(['a.example.com', 'b.example.com', 'c.example.com'])).toBe(
      'a.example.com, b.example.com, c.example.com',
    )
  })

  it('leaves undefined as undefined rather than stringifying it', () => {
    expect(certCommonName(undefined)).toBeUndefined()
  })

  it('does not throw on an empty array and returns an empty string', () => {
    expect(certCommonName([])).toBe('')
  })

  it('passes a single-element array through as its lone value, not a 1-item join artifact', () => {
    expect(certCommonName(['solo.example.com'])).toBe('solo.example.com')
  })
})

// The dialog shows BOTH the subject and issuer CN through this helper — a
// refactor that routes one of them around it would silently reintroduce the
// array-collapsing bug (`String(['a','b'])` == `'a,b'` with no separator, or
// worse, an object stringifying to `[object Object]`) for just that field.
describe('main.ts cert-recovery payload wiring', () => {
  it('projects both subject and issuer CN through certCommonName', () => {
    const idx = MAIN_TS.indexOf('subject: certCommonName(cert?.subject?.CN)')
    expect(idx).toBeGreaterThan(-1)
    const nextLine = MAIN_TS.slice(idx, MAIN_TS.indexOf('\n', idx + 1) + 60)
    expect(nextLine).toContain('issuer: certCommonName(cert?.issuer?.CN)')
  })
})
