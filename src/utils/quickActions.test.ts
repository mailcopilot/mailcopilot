import { describe, it, expect } from 'vitest'
import {
  QUICK_ACTION_PRESETS,
  quickActionLabelKey,
  insertAtOwnTextEnd,
  hasRewritableText,
  isPreviewStale,
  isBlockedByOtherAction,
  type ComposeAiActivity,
} from './quickActions'

describe('quickActions pure helpers', () => {
  describe('QUICK_ACTION_PRESETS', () => {
    it('exposes exactly the three tone presets in toolbar order', () => {
      expect([...QUICK_ACTION_PRESETS]).toEqual(['improve', 'shorter', 'formal'])
    })

    it('does NOT offer `grammar` — the B7 check owns mistakes (§1.26.1 AC-1)', () => {
      expect(QUICK_ACTION_PRESETS).not.toContain('grammar')
    })

    it('keeps `grammar` a live contract value with a label of its own', () => {
      // The preset type and the main-side prompt catalogue are unchanged; only
      // the toolbar stopped offering it. A label key that stopped resolving
      // would turn a contract value into a rendering bug.
      expect(quickActionLabelKey('grammar')).toBe('ai.quickAction.preset.grammar')
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

  // §1.26.1 AC-9 / §2.252 — the insert action lands at the END OF THE USER'S OWN
  // TEXT, never at a caret index. The old `insertAtCaret` read
  // `textarea.selectionStart` while an OVERLAY had focus; on a pre-filled draft
  // the textarea had never been focused, so that index was 0 and the generated
  // text was spliced above everything, quote included.
  describe('insertAtOwnTextEnd', () => {
    it('lands above a recognized quote, not at the top of the body', () => {
      const body = 'My answer.\n\n> quoted line one\n> quoted line two'
      const r = insertAtOwnTextEnd(body, 'Added paragraph.')
      expect(r.text).toBe('My answer.\nAdded paragraph.\n\n> quoted line one\n> quoted line two')
      expect(r.text.startsWith('Added paragraph.')).toBe(false)
      // Caret sits immediately after the inserted text.
      expect(r.text.slice(0, r.caret).endsWith('Added paragraph.')).toBe(true)
    })

    it('lands above a recognized signature', () => {
      const r = insertAtOwnTextEnd('Hello.\n\n--\nSergey', 'Regards.')
      expect(r.text).toBe('Hello.\nRegards.\n\n--\nSergey')
    })

    it('lands above a forwarded-message banner', () => {
      const body = 'FYI.\n\n---------- Forwarded message ----------\nFrom: a@b.test'
      const r = insertAtOwnTextEnd(body, 'See below.')
      expect(r.text).toBe('FYI.\nSee below.\n\n---------- Forwarded message ----------\nFrom: a@b.test')
    })

    it('appends at the very end when no tail is recognized (own text IS the body)', () => {
      const r = insertAtOwnTextEnd('Just a plain draft.', 'One more line.')
      expect(r.text).toBe('Just a plain draft.\nOne more line.')
      expect(r.caret).toBe(r.text.length)
    })

    it('adds exactly one newline, and none when the own part already ends with one', () => {
      expect(insertAtOwnTextEnd('Hello.', 'X').text).toBe('Hello.\nX')
      expect(insertAtOwnTextEnd('Hello.\n', 'X').text).toBe('Hello.\nX')
    })

    it('does not fuse onto a tail that starts on the same line', () => {
      // Unreachable from the toolbar (an empty own part is refused as
      // `no_own_text` before anything is generated), but the helper must not
      // produce `My reply.> only a quote` if a future caller reaches it.
      const r = insertAtOwnTextEnd('> only a quote', 'My reply.')
      expect(r.text).toBe('My reply.\n> only a quote')
      expect(r.caret).toBe('My reply.'.length)
    })

    it('carries the recognized tail through byte-identically', () => {
      const tail = '\n\n> quoted\n\n--\nSergey'
      const r = insertAtOwnTextEnd(`Body.${tail}`, 'Added.')
      expect(r.text.endsWith(tail)).toBe(true)
    })

    it('preserves leading blank lines above the own text', () => {
      const r = insertAtOwnTextEnd('\n\nHello.\n\n> quoted', 'Added.')
      expect(r.text.startsWith('\n\n')).toBe(true)
      expect(r.text).toBe('\n\nHello.\nAdded.\n\n> quoted')
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
