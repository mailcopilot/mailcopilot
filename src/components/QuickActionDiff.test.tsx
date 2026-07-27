// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
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
}
const stableT = (key: string): string => i18nMap[key] ?? key
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

import { QuickActionDiff } from './QuickActionDiff'

function makePreview(overrides: Partial<QuickActionPreview> = {}): QuickActionPreview {
  return {
    preset: 'improve',
    original: 'raw draft text',
    rewritten: 'a much better draft text',
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
})

describe('QuickActionDiff', () => {
  it('renders the before and after text blocks verbatim', () => {
    renderDiff({ preview: makePreview({ original: 'before text', rewritten: 'after text' }) })
    expect(screen.getByTestId('quick-action-diff-before')).toHaveTextContent('before text')
    expect(screen.getByTestId('quick-action-diff-after')).toHaveTextContent('after text')
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
})
