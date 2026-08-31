import { describe, it, expect } from 'vitest'
import {
  QUICK_ACTION_PRESETS,
  quickActionLabelKey,
  insertAtCaret,
  hasRewritableText,
  isPreviewStale,
  isBlockedByOtherAction,
  type ComposeAiActivity,
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

  describe('isPreviewStale', () => {
    it('is false while the body still matches the snapshot the rewrite used', () => {
      expect(isPreviewStale({ sourceBody: 'Hello\n\n--\nSergey' }, 'Hello\n\n--\nSergey')).toBe(false)
    })

    it('is true after the user typed during generation', () => {
      expect(isPreviewStale({ sourceBody: 'Hello' }, 'Hello and one more thing')).toBe(true)
    })

    it('is true for an edit inside the untouched tail too (the replacement carries it)', () => {
      expect(isPreviewStale({ sourceBody: 'Hello\n\n--\nSergey' }, 'Hello\n\n--\nSergey P.')).toBe(true)
    })

    it('is true for a whitespace-only edit (exact comparison, no normalization)', () => {
      expect(isPreviewStale({ sourceBody: 'Hello' }, 'Hello ')).toBe(true)
    })
  })

  describe('isBlockedByOtherAction', () => {
    const idle: ComposeAiActivity = { rewrite: false, proofread: false, translate: false }

    it('blocks nobody while the draft is free', () => {
      expect(isBlockedByOtherAction(idle, 'rewrite')).toBe(false)
      expect(isBlockedByOtherAction(idle, 'proofread')).toBe(false)
      expect(isBlockedByOtherAction(idle, 'translate')).toBe(false)
    })

    it('never blocks an action with its OWN activity — re-running over one\'s own panel stays allowed', () => {
      expect(isBlockedByOtherAction({ ...idle, rewrite: true }, 'rewrite')).toBe(false)
      expect(isBlockedByOtherAction({ ...idle, proofread: true }, 'proofread')).toBe(false)
      expect(isBlockedByOtherAction({ ...idle, translate: true }, 'translate')).toBe(false)
    })

    it.each([
      ['rewrite', 'proofread'],
      ['rewrite', 'translate'],
      ['proofread', 'rewrite'],
      ['proofread', 'translate'],
      ['translate', 'rewrite'],
      ['translate', 'proofread'],
    ] as const)('blocks %s while %s occupies the draft', (self, other) => {
      expect(isBlockedByOtherAction({ ...idle, [other]: true }, self)).toBe(true)
    })
  })
})
