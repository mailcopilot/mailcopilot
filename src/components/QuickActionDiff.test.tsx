// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import type { QuickActionPreview } from '../hooks/useQuickActions'

// ---------------------------------------------------------------------------
// Stable i18n mock — prevents infinite re-renders (renderer.md convention)
// ---------------------------------------------------------------------------
const i18nMap: Record<string, string> = {
  'ai.quickAction.preset.improve': 'Improve',
  'ai.quickAction.preset.shorter': 'Shorter',
  'ai.quickAction.diff.title': 'Review AI rewrite',
  'ai.quickAction.diff.before': 'Before',
  'ai.quickAction.diff.after': 'After',
  'ai.quickAction.diff.replace': 'Replace',
  'ai.quickAction.diff.insert': 'Insert at cursor',
  'ai.quickAction.diff.cancel': 'Cancel',
  'ai.quickAction.diff.noChanges': 'The rewrite matches your text.',
  'ai.quickAction.diff.changeCount_one': '{{count}} change',
  'ai.quickAction.diff.changeCount_other': '{{count}} changes',
  'ai.quickAction.diff.unchangedLines_one': '{{count}} unchanged line',
  'ai.quickAction.diff.unchangedLines_other': '{{count}} unchanged lines',
  'ai.quickAction.diff.editsHeading': 'Edits',
  'ai.quickAction.diff.plainText': 'Plain text',
  'ai.quickAction.diff.staleWarning': 'You edited the draft while the AI was working.',
  'ai.quickAction.diff.staleReplaceHint': 'Replace is unavailable because the draft changed.',
  'ai.quickAction.translate.diffLabel': 'Translation',
}
/** Mirrors i18next enough for the two counted keys the panel uses. */
const stableT = (key: string, opts?: { count?: number }): string => {
  if (opts && typeof opts.count === 'number') {
    const suffix = opts.count === 1 ? '_one' : '_other'
    const template = i18nMap[key + suffix] ?? `${key}${suffix}`
    return template.replace('{{count}}', String(opts.count))
  }
  return i18nMap[key] ?? key
}
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

import { QuickActionDiff } from './QuickActionDiff'

const recordMetric = vi.fn()

function makePreview(overrides: Partial<QuickActionPreview> = {}): QuickActionPreview {
  return {
    preset: 'improve',
    original: 'raw draft text',
    rewritten: 'a much better draft text',
    sourceBody: 'raw draft text',
    replacement: 'a much better draft text',
    ...overrides,
  }
}

function renderDiff(overrides: Partial<React.ComponentProps<typeof QuickActionDiff>> = {}) {
  const props: React.ComponentProps<typeof QuickActionDiff> = {
    preview: makePreview(),
    onReplace: vi.fn(),
    onInsert: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
  return { ...render(React.createElement(QuickActionDiff, props)), props }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = { recordMetric }
})

describe('QuickActionDiff', () => {
  it('renders the plain before and after copies verbatim', () => {
    renderDiff({ preview: makePreview({ original: 'before text', rewritten: 'after text' }) })
    expect(screen.getByTestId('quick-action-diff-before')).toHaveTextContent('before text')
    expect(screen.getByTestId('quick-action-diff-after')).toHaveTextContent('after text')
  })

  it('renders the plain copies byte-for-byte, not merely a normalized substring match (Low finding)', () => {
    // `toHaveTextContent` collapses whitespace before comparing, so it cannot
    // catch a regression that mangles leading/trailing spaces or blank lines.
    // Compare `.textContent` directly against the exact source string instead.
    const original = '  leading space, blank line below\n\nand a trailing newline\n'
    const rewritten = 'no leading space here\n\tand a tab\t'
    renderDiff({ preview: makePreview({ original, rewritten }) })
    expect(screen.getByTestId('quick-action-diff-before').textContent).toBe(original)
    expect(screen.getByTestId('quick-action-diff-after').textContent).toBe(rewritten)
  })

  it('shows the localized preset label in the header', () => {
    renderDiff({ preview: makePreview({ preset: 'shorter' }) })
    expect(screen.getByText('Shorter')).toBeInTheDocument()
  })

  it('calls onReplace ONLY when the Replace button is clicked (no auto-substitution)', () => {
    const { props } = renderDiff()
    expect(props.onReplace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
    expect(props.onReplace).toHaveBeenCalledOnce()
    expect(props.onInsert).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('calls onInsert ONLY when the Insert button is clicked', () => {
    const { props } = renderDiff()
    fireEvent.click(screen.getByTestId('quick-action-diff-insert'))
    expect(props.onInsert).toHaveBeenCalledOnce()
    expect(props.onReplace).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('calls onCancel when the Cancel button is clicked, leaving the draft untouched', () => {
    const { props } = renderDiff()
    fireEvent.click(screen.getByTestId('quick-action-diff-cancel'))
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(props.onReplace).not.toHaveBeenCalled()
    expect(props.onInsert).not.toHaveBeenCalled()
  })

  it('calls onCancel when the header close (X) button is clicked', () => {
    const { props } = renderDiff()
    fireEvent.click(screen.getByTestId('quick-action-diff-close'))
    expect(props.onCancel).toHaveBeenCalledOnce()
  })

  it('dismisses on Escape and on a click outside the panel', () => {
    const { props } = renderDiff()
    fireEvent.keyDown(screen.getByTestId('quick-action-diff'), { key: 'Escape' })
    expect(props.onCancel).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByTestId('quick-action-diff-backdrop'))
    expect(props.onCancel).toHaveBeenCalledTimes(2)
  })

  it('never mutates the body on its own — no callback fires on render', () => {
    const { props } = renderDiff()
    expect(props.onReplace).not.toHaveBeenCalled()
    expect(props.onInsert).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('renders as an accessible dialog', () => {
    renderDiff()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  describe('inline edit markup (§3.3.B4.f5)', () => {
    it('marks removals with <del> and additions with <ins>, in place', () => {
      renderDiff({
        preview: makePreview({
          original: 'we ship the colour picker on Friday',
          rewritten: 'we ship the color picker on Friday',
        }),
      })
      const merged = screen.getByTestId('quick-action-diff-merged')
      expect(merged.querySelector('del')).toHaveTextContent('colour')
      expect(merged.querySelector('ins')).toHaveTextContent('color')
      // The untouched words are present exactly once, not duplicated across two
      // panes the reader has to compare by eye.
      expect(merged.textContent).toContain('we ship the')
      expect(merged.textContent).toContain('picker on Friday')
    })

    it('marks each edit with a sign as well as a colour', () => {
      renderDiff({
        preview: makePreview({ original: 'ship on Friday', rewritten: 'ship on Monday' }),
      })
      const merged = screen.getByTestId('quick-action-diff-merged')
      expect(merged.querySelector('del')?.textContent).toContain('−')
      expect(merged.querySelector('ins')?.textContent).toContain('+')
    })

    it('lists every edit separately, so each one can be reviewed on its own', () => {
      renderDiff({
        preview: makePreview({
          original: 'Alpha line.\nBeta line.\nGamma line.\n',
          rewritten: 'Alpha line changed.\nBeta line.\nGamma line changed.\n',
        }),
      })
      const items = screen.getAllByTestId('quick-action-diff-edit')
      expect(items).toHaveLength(2)
      expect(within(items[0]).getByText(/Alpha line changed/)).toBeInTheDocument()
      expect(within(items[1]).getByText(/Gamma line changed/)).toBeInTheDocument()
    })

    it('counts the edits in the header', () => {
      renderDiff({
        preview: makePreview({
          original: 'Alpha line.\nBeta line.\nGamma line.\n',
          rewritten: 'Alpha line changed.\nBeta line.\nGamma line changed.\n',
        }),
      })
      expect(screen.getByTestId('quick-action-diff-count')).toHaveTextContent('2')
    })

    it('says so plainly when the rewrite changed nothing', () => {
      renderDiff({ preview: makePreview({ original: 'identical', rewritten: 'identical' }) })
      expect(screen.getByTestId('quick-action-diff-empty')).toHaveTextContent(
        'The rewrite matches your text.',
      )
      expect(screen.queryByTestId('quick-action-diff-edit')).not.toBeInTheDocument()
    })

    it('folds a long untouched stretch and unfolds it on request', () => {
      const filler = Array.from({ length: 8 }, (_, i) => `Untouched line ${i}.`).join('\n')
      renderDiff({
        preview: makePreview({
          original: `Opening line.\n${filler}\nClosing line.`,
          rewritten: `Opening line rewritten.\n${filler}\nClosing line.`,
        }),
      })
      const fold = screen.getByTestId('quick-action-diff-fold')
      expect(fold).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByTestId('quick-action-diff-merged').textContent).not.toContain(
        'Untouched line 4.',
      )

      fireEvent.click(fold)
      expect(screen.getByTestId('quick-action-diff-fold')).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByTestId('quick-action-diff-merged').textContent).toContain(
        'Untouched line 4.',
      )
    })

    it('keeps the plain copies folded away until asked for', () => {
      renderDiff()
      const toggle = screen.getByTestId('quick-action-diff-plain-toggle')
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByTestId('quick-action-diff-before')).not.toBeVisible()

      fireEvent.click(toggle)
      expect(screen.getByTestId('quick-action-diff-before')).toBeVisible()
    })
  })

  describe('outcome telemetry (AC h)', () => {
    it('records the choice with the preset and nothing derived from the text', () => {
      renderDiff({ preview: makePreview({ preset: 'shorter' }) })
      fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
      expect(recordMetric).toHaveBeenCalledWith(
        'ai.quick_action.preview_outcome',
        'event',
        null,
        { preset: 'shorter', outcome: 'replaced' },
      )
    })

    it('distinguishes insert and cancel from replace', () => {
      renderDiff()
      fireEvent.click(screen.getByTestId('quick-action-diff-insert'))
      expect(recordMetric).toHaveBeenLastCalledWith(
        'ai.quick_action.preview_outcome',
        'event',
        null,
        { preset: 'improve', outcome: 'inserted' },
      )

      fireEvent.click(screen.getByTestId('quick-action-diff-cancel'))
      expect(recordMetric).toHaveBeenLastCalledWith(
        'ai.quick_action.preview_outcome',
        'event',
        null,
        { preset: 'improve', outcome: 'cancelled' },
      )
    })

    it('records nothing merely for showing the preview', () => {
      renderDiff()
      expect(recordMetric).not.toHaveBeenCalled()
    })

    it('does not report a replacement that was refused as stale', () => {
      renderDiff({ stale: true })
      fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
      expect(recordMetric).not.toHaveBeenCalled()
    })

    it('records exactly one event per decision — never zero, never twice', () => {
      const actions = [
        'quick-action-diff-replace',
        'quick-action-diff-insert',
        'quick-action-diff-cancel',
      ]
      for (const testId of actions) {
        recordMetric.mockClear()
        const { unmount } = renderDiff()
        fireEvent.click(screen.getByTestId(testId))
        expect(recordMetric).toHaveBeenCalledTimes(1)
        unmount()
      }
    })
  })

  describe('stale preview (draft edited during generation, §2.78 AC-h)', () => {
    it('shows no warning and keeps Replace enabled by default', () => {
      renderDiff()
      expect(screen.queryByTestId('quick-action-diff-stale')).not.toBeInTheDocument()
      expect(screen.getByTestId('quick-action-diff-replace')).toBeEnabled()
    })

    it('warns and disables Replace when stale', () => {
      renderDiff({ stale: true })
      expect(screen.getByTestId('quick-action-diff-stale')).toHaveTextContent(
        'You edited the draft while the AI was working.',
      )
      const replace = screen.getByTestId('quick-action-diff-replace')
      expect(replace).toBeDisabled()
      expect(replace).toHaveAttribute('title', 'Replace is unavailable because the draft changed.')
    })

    it('gives the warning its own styling hook, not the refusal line’s (§2.181)', () => {
      renderDiff({ stale: true })
      const warning = screen.getByTestId('quick-action-diff-stale')
      expect(warning).toHaveClass('quick-action-diff-stale')
      expect(warning).not.toHaveClass('compose-quick-actions-refusal')
    })

    it('does not fire onReplace on a click while stale', () => {
      const { props } = renderDiff({ stale: true })
      fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
      expect(props.onReplace).not.toHaveBeenCalled()
    })

    it('keeps Insert and Cancel usable while stale (non-destructive escape hatches)', () => {
      const { props } = renderDiff({ stale: true })
      fireEvent.click(screen.getByTestId('quick-action-diff-insert'))
      expect(props.onInsert).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByTestId('quick-action-diff-cancel'))
      expect(props.onCancel).toHaveBeenCalledOnce()
    })
  })
})


// ---------------------------------------------------------------------------
// §3.3 B6 draft side: the panel is no longer tied to the four B4 presets. The
// four quick actions must keep rendering EXACTLY as before (the whole existing
// suite above is that proof, driven by a `QuickActionPreview` unchanged), and a
// caller with no preset must get a caption of its own and no preset telemetry.
// ---------------------------------------------------------------------------
describe('QuickActionDiff — callers that are not one of the four presets', () => {
  const translatePreview = {
    original: 'My own reply.',
    rewritten: 'Meine eigene Antwort.',
    labelKey: 'ai.quickAction.translate.diffLabel',
  }

  it('still renders the preset caption for a preset preview (unchanged behaviour)', () => {
    renderDiff({ preview: makePreview({ preset: 'shorter' }) })
    expect(screen.getByTestId('quick-action-diff-preset')).toHaveTextContent('Shorter')
  })

  it('renders an explicit label key instead of a preset label', () => {
    renderDiff({ preview: translatePreview })
    expect(screen.getByTestId('quick-action-diff-preset')).toHaveTextContent('Translation')
  })

  it('offers the same three choices, with no auto-substitution', () => {
    const { props } = renderDiff({ preview: translatePreview })
    expect(props.onReplace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
    expect(props.onReplace).toHaveBeenCalledOnce()
  })

  it('honours the staleness rule for a non-preset preview too', () => {
    const { props } = renderDiff({ preview: translatePreview, stale: true })
    expect(screen.getByTestId('quick-action-diff-replace')).toBeDisabled()
    fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
    expect(props.onReplace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('quick-action-diff-insert'))
    expect(props.onInsert).toHaveBeenCalledOnce()
  })

  it('records NO preset outcome — the tag is a closed four-value enum', () => {
    renderDiff({ preview: translatePreview })
    fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
    expect(recordMetric).not.toHaveBeenCalled()
  })

  it('renders no caption chip at all when neither a preset nor a label is given', () => {
    renderDiff({ preview: { original: 'a', rewritten: 'b' } })
    expect(screen.queryByTestId('quick-action-diff-preset')).not.toBeInTheDocument()
  })
})
