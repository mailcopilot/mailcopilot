import { describe, it, expect } from 'vitest'
import {
  QUICK_ACTION_PRESETS,
  quickActionLabelKey,
  insertAtCaret,
  hasRewritableText,
} from './quickActions'

describe('quickActions pure helpers', () => {
  describe('QUICK_ACTION_PRESETS', () => {
    it('exposes exactly the four B4 presets in toolbar order', () => {
      expect([...QUICK_ACTION_PRESETS]).toEqual(['improve', 'shorter', 'formal', 'grammar'])
    })
  })

  describe('quickActionLabelKey', () => {
    it('maps each preset to its i18n label key', () => {
      expect(quickActionLabelKey('improve')).toBe('ai.quickAction.preset.improve')
      expect(quickActionLabelKey('grammar')).toBe('ai.quickAction.preset.grammar')
    })
  })

  describe('hasRewritableText', () => {
    it('is false for empty / whitespace-only bodies', () => {
      expect(hasRewritableText('')).toBe(false)
      expect(hasRewritableText('   \n\t ')).toBe(false)
    })
    it('is true once there is any non-whitespace content', () => {
      expect(hasRewritableText('hi')).toBe(true)
      expect(hasRewritableText('  hi  ')).toBe(true)
    })
  })

  describe('insertAtCaret', () => {
    it('splices insert at the caret and returns the post-insert caret', () => {
      const r = insertAtCaret('Hello world', 'brave ', 6)
      expect(r.text).toBe('Hello brave world')
      expect(r.caret).toBe(12)
    })

    it('inserts at the start when caret is 0', () => {
      const r = insertAtCaret('world', 'hello ', 0)
      expect(r.text).toBe('hello world')
      expect(r.caret).toBe(6)
    })

    it('appends at the end when caret is at length', () => {
      const r = insertAtCaret('hello', '!', 5)
      expect(r.text).toBe('hello!')
      expect(r.caret).toBe(6)
    })

    it('clamps a caret past the end (stale selection) without throwing', () => {
      const r = insertAtCaret('abc', 'X', 999)
      expect(r.text).toBe('abcX')
      expect(r.caret).toBe(4)
    })

    it('clamps a negative caret to 0', () => {
      const r = insertAtCaret('abc', 'X', -5)
      expect(r.text).toBe('Xabc')
      expect(r.caret).toBe(1)
    })
  })
})
