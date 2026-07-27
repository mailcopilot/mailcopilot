// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

// ---------------------------------------------------------------------------
// Stable i18n mock — prevents infinite re-renders (renderer.md convention)
// ---------------------------------------------------------------------------
const i18nMap: Record<string, string> = {
  'ai.quickAction.preset.improve': 'Improve',
  'ai.quickAction.preset.shorter': 'Shorter',
  'ai.quickAction.preset.formal': 'Formal',
  'ai.quickAction.preset.grammar': 'Fix grammar',
  'ai.quickAction.diff.title': 'Review AI rewrite',
  'ai.quickAction.diff.before': 'Before',
  'ai.quickAction.diff.after': 'After',
  'ai.quickAction.diff.replace': 'Replace',
  'ai.quickAction.diff.insert': 'Insert at cursor',
  'ai.quickAction.diff.cancel': 'Cancel',
  'ai.quickAction.refusal.budget': 'Daily AI budget reached — rewrite paused until it resets.',
  'ai.quickAction.refusal.noProvider': 'Configure an AI provider in Settings to rewrite drafts.',
  'ai.quickAction.refusal.providerError': "Couldn't rewrite this draft right now.",
  'ai.quickAction.refusal.emptyInput': 'Write some text first, then pick a quick action.',
}
const stableT = (key: string): string => i18nMap[key] ?? key
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

vi.mock('../sentry', () => ({ captureException: vi.fn() }))

// window.api mocking (required for ALL renderer tests — renderer.md convention)
const mockInvoke = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

import { ComposeQuickActions } from './ComposeQuickActions'

function renderToolbar(overrides: Partial<React.ComponentProps<typeof ComposeQuickActions>> = {}) {
  const props: React.ComponentProps<typeof ComposeQuickActions> = {
    accountId: 1,
    text: 'raw draft body',
    getCaret: () => 0,
    onReplace: vi.fn(),
    onInsert: vi.fn(),
    ...overrides,
  }
  return { ...render(React.createElement(ComposeQuickActions, props)), props }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('ComposeQuickActions', () => {
  it('renders all four preset buttons', () => {
    renderToolbar()
    expect(screen.getByTestId('compose-quick-action-improve')).toBeInTheDocument()
    expect(screen.getByTestId('compose-quick-action-shorter')).toBeInTheDocument()
    expect(screen.getByTestId('compose-quick-action-formal')).toBeInTheDocument()
    expect(screen.getByTestId('compose-quick-action-grammar')).toBeInTheDocument()
  })

  it('disables all preset buttons when the draft has no rewritable text', () => {
    renderToolbar({ text: '   ' })
    expect(screen.getByTestId('compose-quick-action-improve')).toBeDisabled()
  })

  it('disables all preset buttons when disabled=true (mid-send)', () => {
    renderToolbar({ disabled: true })
    expect(screen.getByTestId('compose-quick-action-improve')).toBeDisabled()
  })

  it('disables all preset buttons when there is no account', () => {
    renderToolbar({ accountId: null })
    expect(screen.getByTestId('compose-quick-action-improve')).toBeDisabled()
  })

  it('fires ai:quickAction:rewrite with the raw draft text and preset on click', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Better draft.', provider: 'anthropic-api' })
    renderToolbar({ text: 'my draft' })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('ai:quickAction:rewrite', { accountId: 1, preset: 'improve', text: 'my draft' })
    })
  })

  it('renders the diff preview on a successful rewrite', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Better draft.', provider: 'anthropic-api' })
    renderToolbar({ text: 'my draft' })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    expect(screen.getByTestId('quick-action-diff-after')).toHaveTextContent('Better draft.')
  })

  it('renders an inline refusal message when the backend refuses (never crashes)', async () => {
    mockInvoke.mockResolvedValue({ ok: false, reason: 'budget' })
    renderToolbar({ text: 'my draft' })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('compose-quick-actions-refusal')).toBeInTheDocument())
    expect(screen.getByTestId('compose-quick-actions-refusal')).toHaveTextContent(
      'Daily AI budget reached — rewrite paused until it resets.',
    )
    expect(screen.queryByTestId('quick-action-diff')).not.toBeInTheDocument()
  })

  it('does NOT replace or mutate the draft body until Replace is explicitly clicked', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Better draft.', provider: 'anthropic-api' })
    const onReplace = vi.fn()
    const onInsert = vi.fn()
    renderToolbar({ text: 'my draft', onReplace, onInsert })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    // The preview is visible but neither mutation callback has fired yet.
    expect(onReplace).not.toHaveBeenCalled()
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('calls onReplace with the rewritten text and dismisses the preview on Replace click', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Better draft.', provider: 'anthropic-api' })
    const onReplace = vi.fn()
    renderToolbar({ text: 'my draft', onReplace })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
    expect(onReplace).toHaveBeenCalledWith('Better draft.')
    expect(screen.queryByTestId('quick-action-diff')).not.toBeInTheDocument()
  })

  it('calls onInsert with the spliced text + post-insert caret on Insert click', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: ' inserted', provider: 'anthropic-api' })
    const onInsert = vi.fn()
    renderToolbar({ text: 'my draft', getCaret: () => 2, onInsert })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('quick-action-diff-insert'))
    expect(onInsert).toHaveBeenCalledWith('my inserted draft', 11)
  })

  it('dismisses the preview without mutating anything on Cancel click', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Better draft.', provider: 'anthropic-api' })
    const onReplace = vi.fn()
    const onInsert = vi.fn()
    renderToolbar({ text: 'my draft', onReplace, onInsert })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('quick-action-diff-cancel'))
    expect(screen.queryByTestId('quick-action-diff')).not.toBeInTheDocument()
    expect(onReplace).not.toHaveBeenCalled()
    expect(onInsert).not.toHaveBeenCalled()
  })
})
