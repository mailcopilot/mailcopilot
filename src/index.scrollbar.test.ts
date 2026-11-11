// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (f: string): string => readFileSync(join(__dirname, f), 'utf8')

describe('one scrollbar style for the whole app', () => {
  it('index.css sets the thin bar once, on every element', () => {
    const css = read('index.css')
    expect(css).toMatch(/\n\* \{\s*scrollbar-width: thin;\s*scrollbar-color: var\(--border\) transparent;\s*\}/)
  })

  it('no per-class scrollbar rule or ::-webkit-scrollbar styling is left (Chromium ignores it once the properties are set)', () => {
    const rest = read('index.css').replace(/\n\* \{\s*scrollbar-width[^}]*\}/, '') + read('App.css')
    expect(rest).not.toMatch(/scrollbar-width\s*:/)
    expect(rest).not.toMatch(/scrollbar-color\s*:/)
    expect(rest).not.toMatch(/::-webkit-scrollbar/)
  })
})
