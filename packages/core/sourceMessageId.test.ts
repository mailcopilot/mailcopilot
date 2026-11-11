import { describe, expect, it } from 'vitest'
import { normalizeSourceMessageId, SOURCE_MESSAGE_ID_MAX } from './sourceMessageId'

describe('normalizeSourceMessageId', () => {
  it('trims and returns a usable id', () => {
    expect(normalizeSourceMessageId('  <a@x>  ')).toBe('<a@x>')
  })
  it.each([[''], ['   '], [null], [undefined], [42], [{}]])('refuses %j', raw => {
    expect(normalizeSourceMessageId(raw)).toBeNull()
  })
  it('accepts exactly the maximum and refuses one more', () => {
    expect(normalizeSourceMessageId('x'.repeat(SOURCE_MESSAGE_ID_MAX))).toHaveLength(SOURCE_MESSAGE_ID_MAX)
    expect(normalizeSourceMessageId('x'.repeat(SOURCE_MESSAGE_ID_MAX + 1))).toBeNull()
  })
  it('measures the trimmed value, not the padded one', () => {
    expect(normalizeSourceMessageId(` ${'x'.repeat(SOURCE_MESSAGE_ID_MAX)} `)).toHaveLength(SOURCE_MESSAGE_ID_MAX)
  })
})
