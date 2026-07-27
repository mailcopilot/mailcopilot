import { describe, expect, it } from 'vitest'
import { substituteVars } from './templateVars'

describe('substituteVars', () => {
  it('replaces known variables', () => {
    const result = substituteVars('Hello {name}!', { name: 'Alice' })
    expect(result).toBe('Hello Alice!')
  })

  it('replaces multiple variables', () => {
    const result = substituteVars('{name} ({email}) — {date}', {
      name: 'Bob',
      email: 'bob@test.com',
      date: '2026-01-01',
    })
    expect(result).toBe('Bob (bob@test.com) — 2026-01-01')
  })

  it('leaves unknown variables as-is', () => {
    const result = substituteVars('Hi {name}, {unknown}!', { name: 'Alice' })
    expect(result).toBe('Hi Alice, {unknown}!')
  })

  it('works with empty text', () => {
    expect(substituteVars('', { name: 'X' })).toBe('')
  })

  it('works with empty variables', () => {
    expect(substituteVars('No vars here', {})).toBe('No vars here')
  })

  it('replaces the same variable multiple times', () => {
    const result = substituteVars('{name} and {name}', { name: 'X' })
    expect(result).toBe('X and X')
  })
})
