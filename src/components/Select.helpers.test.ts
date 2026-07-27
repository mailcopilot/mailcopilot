// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { makeOptions, optionsFromRecord } from './Select.helpers'
import type { SelectOption } from './Select.helpers'

// ---------------------------------------------------------------------------
// makeOptions
// ---------------------------------------------------------------------------

describe('makeOptions', () => {
  it('builds options with value === label for each string', () => {
    const result = makeOptions(['a', 'b', 'c'])
    expect(result).toEqual<SelectOption<string>[]>([
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b' },
      { value: 'c', label: 'c' },
    ])
  })

  it('returns an empty array for an empty input', () => {
    expect(makeOptions([])).toEqual([])
  })

  it('preserves original input order', () => {
    const values = ['z', 'a', 'm'] as const
    const result = makeOptions(values)
    expect(result.map(o => o.value)).toEqual(['z', 'a', 'm'])
  })

  it('handles a single-element array', () => {
    const result = makeOptions(['only'])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ value: 'only', label: 'only' })
  })

  it('handles strings with special characters', () => {
    const result = makeOptions(['en-US', 'zh-Hant'])
    expect(result[0]).toEqual({ value: 'en-US', label: 'en-US' })
    expect(result[1]).toEqual({ value: 'zh-Hant', label: 'zh-Hant' })
  })

  it('returns a fresh array (not the original reference)', () => {
    const values = ['x'] as const
    const result = makeOptions(values)
    // Mutating the result does not affect future calls.
    result.push({ value: 'y' as 'x', label: 'y' })
    expect(makeOptions(values)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// optionsFromRecord
// ---------------------------------------------------------------------------

describe('optionsFromRecord', () => {
  it('converts a Record<string, string> to SelectOption[]', () => {
    const result = optionsFromRecord({ apple: 'Apple', banana: 'Banana' })
    expect(result).toHaveLength(2)
    // Values and labels must be correct.
    const apple = result.find(o => o.value === 'apple')
    expect(apple).toEqual({ value: 'apple', label: 'Apple' })
    const banana = result.find(o => o.value === 'banana')
    expect(banana).toEqual({ value: 'banana', label: 'Banana' })
  })

  it('returns an empty array for an empty record', () => {
    expect(optionsFromRecord({} as Record<string, string>)).toEqual([])
  })

  it('handles a single-entry record', () => {
    const result = optionsFromRecord({ only: 'Only Label' })
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ value: 'only', label: 'Only Label' })
  })

  it('uses the record value as label, not the key', () => {
    // Distinct key vs label — label must be the record value, not the key.
    const result = optionsFromRecord({ k1: 'Human-readable label' })
    expect(result[0]!.label).toBe('Human-readable label')
    expect(result[0]!.value).toBe('k1')
  })

  it('handles labels that are empty strings', () => {
    const result = optionsFromRecord({ empty: '' })
    expect(result[0]).toEqual({ value: 'empty', label: '' })
  })

  it('preserves declaration order (Object.entries order for string keys)', () => {
    const map = { c: 'C label', a: 'A label', b: 'B label' } as Record<string, string>
    const result = optionsFromRecord(map)
    // Object.entries preserves insertion order for string keys in V8.
    const keys = result.map(o => o.value)
    expect(keys).toEqual(['c', 'a', 'b'])
  })
})
