import { describe, expect, it } from 'vitest'
import { findNextAfterRemoval } from './autoAdvanceNav'

type Item = { id: string }
const keyFn = (item: Item) => item.id

function items(...ids: string[]): Item[] {
  return ids.map(id => ({ id }))
}

describe('findNextAfterRemoval', () => {
  const list = items('a', 'b', 'c', 'd', 'e')

  describe('mode = off', () => {
    it('returns null regardless of position', () => {
      expect(findNextAfterRemoval(list, 2, 'off', new Set(['c']), keyFn)).toBeNull()
    })
  })

  describe('mode = back_to_list', () => {
    it('returns null regardless of position', () => {
      expect(findNextAfterRemoval(list, 2, 'back_to_list', new Set(['c']), keyFn)).toBeNull()
    })
  })

  describe('mode = older (forward in list)', () => {
    it('navigates to next older item (idx+1)', () => {
      const result = findNextAfterRemoval(list, 2, 'older', new Set(['c']), keyFn)
      expect(result).toEqual({ id: 'd' })
    })

    it('falls back to newer item when at end of list', () => {
      const result = findNextAfterRemoval(list, 4, 'older', new Set(['e']), keyFn)
      expect(result).toEqual({ id: 'd' })
    })

    it('skips removed items in primary direction', () => {
      const result = findNextAfterRemoval(list, 1, 'older', new Set(['b', 'c']), keyFn)
      expect(result).toEqual({ id: 'd' })
    })

    it('falls back to opposite direction when all forward items removed', () => {
      const result = findNextAfterRemoval(list, 2, 'older', new Set(['c', 'd', 'e']), keyFn)
      expect(result).toEqual({ id: 'b' })
    })

    it('returns null when all items are removed', () => {
      const all = new Set(['a', 'b', 'c', 'd', 'e'])
      const result = findNextAfterRemoval(list, 2, 'older', all, keyFn)
      expect(result).toBeNull()
    })
  })

  describe('mode = newer (backward in list)', () => {
    it('navigates to next newer item (idx-1)', () => {
      const result = findNextAfterRemoval(list, 2, 'newer', new Set(['c']), keyFn)
      expect(result).toEqual({ id: 'b' })
    })

    it('falls back to older item when at start of list', () => {
      const result = findNextAfterRemoval(list, 0, 'newer', new Set(['a']), keyFn)
      expect(result).toEqual({ id: 'b' })
    })

    it('skips removed items in primary direction', () => {
      const result = findNextAfterRemoval(list, 3, 'newer', new Set(['d', 'c']), keyFn)
      expect(result).toEqual({ id: 'b' })
    })

    it('falls back to opposite direction when all backward items removed', () => {
      const result = findNextAfterRemoval(list, 2, 'newer', new Set(['a', 'b', 'c']), keyFn)
      expect(result).toEqual({ id: 'd' })
    })
  })

  describe('edge cases', () => {
    it('returns null for negative activeIdx', () => {
      expect(findNextAfterRemoval(list, -1, 'older', new Set(['x']), keyFn)).toBeNull()
    })

    it('handles single-item list', () => {
      const single = items('x')
      expect(findNextAfterRemoval(single, 0, 'older', new Set(['x']), keyFn)).toBeNull()
    })

    it('handles two-item list, removing first', () => {
      const two = items('a', 'b')
      expect(findNextAfterRemoval(two, 0, 'older', new Set(['a']), keyFn)).toEqual({ id: 'b' })
    })

    it('handles two-item list, removing last — falls back to newer', () => {
      const two = items('a', 'b')
      const result = findNextAfterRemoval(two, 1, 'older', new Set(['b']), keyFn)
      expect(result).toEqual({ id: 'a' })
    })

    it('empty list returns null', () => {
      expect(findNextAfterRemoval([], 0, 'older', new Set(), keyFn)).toBeNull()
    })

    it('bulk removal: finds first non-removed in primary direction', () => {
      const big = items('a', 'b', 'c', 'd', 'e', 'f', 'g')
      const removed = new Set(['c', 'd', 'e'])
      // Active is 'c' (idx 2), mode 'older' → search forward: d(removed), e(removed), f(ok) → 'f'
      expect(findNextAfterRemoval(big, 2, 'older', removed, keyFn)).toEqual({ id: 'f' })
    })

    it('bulk removal: finds first non-removed in fallback direction', () => {
      const big = items('a', 'b', 'c', 'd', 'e', 'f', 'g')
      const removed = new Set(['c', 'd', 'e', 'f', 'g'])
      // Active is 'c' (idx 2), mode 'older' → forward all removed → fallback: b(ok) → 'b'
      expect(findNextAfterRemoval(big, 2, 'older', removed, keyFn)).toEqual({ id: 'b' })
    })
  })
})
