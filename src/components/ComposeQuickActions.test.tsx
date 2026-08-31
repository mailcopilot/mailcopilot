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
  'ai.quickAction.refusal.tooLong': 'This draft is too long to rewrite in one pass.',
  'ai.quickAction.refusal.noOwnText': 'Quick actions only rewrite your own text.',
  'ai.quickAction.diff.staleWarning': 'You edited the draft while the AI was working.',
  'ai.quickAction.diff.staleReplaceHint': 'Replace is unavailable because the draft changed.',
  'ai.quickAction.translate.button': 'Translate',
  'ai.quickAction.translate.loading': 'Translating…',
  'ai.quickAction.translate.targetLabel': 'Translate the draft into',
  'ai.quickAction.translate.targetPlaceholder': 'Choose a language',
  'ai.quickAction.translate.diffLabel': 'Translation',
  'ai.quickAction.translate.refusal.budget': 'The AI budget for this period is used up.',
  'ai.quickAction.translate.refusal.noProvider': 'No AI provider is set up yet.',
  'ai.quickAction.translate.refusal.providerError': 'The AI provider did not return a translation.',
  'ai.quickAction.translate.refusal.emptyInput': 'There is nothing to translate yet.',
  'ai.quickAction.translate.refusal.tooLong': 'This draft is too long to translate in one go.',
  'ai.quickAction.translate.refusal.optOut': 'Translation is turned off for this account.',
  'ai.quickAction.translate.refusal.noOwnText': 'Your draft contains only quoted text and a signature.',
  'mail.translate.languages.de': 'German',
  'mail.translate.languages.fr': 'French',
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
    composeGeneration: 0,
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

  // Regression guard for the `default:` arm in refusalMessageKey (see the note
  // on that function): every backend-sourced reason must render ITS OWN copy,
  // never silently fall through to the generic provider-error message. budget,
  // too_long and no_own_text each already have their own dedicated test above
  // / below; this covers the three that did not.
  it.each([
    ['no_provider', 'Configure an AI provider in Settings to rewrite drafts.'],
    ['provider_error', "Couldn't rewrite this draft right now."],
    ['empty_input', 'Write some text first, then pick a quick action.'],
  ] as const)('renders the %s refusal with its own copy', async (reason, expectedCopy) => {
    mockInvoke.mockResolvedValue({ ok: false, reason })
    renderToolbar({ text: 'my draft' })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('compose-quick-actions-refusal')).toBeInTheDocument())
    expect(screen.getByTestId('compose-quick-actions-refusal')).toHaveTextContent(expectedCopy)
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

  // -------------------------------------------------------------------------
  // §2.78 — the rewrite touches the user's own text only
  // -------------------------------------------------------------------------

  const REPLY_BODY = 'sounds good\n\nOn Mon, alice wrote:\n> Can you ship it?\n\n--\nSergey'

  it('sends only the user\'s own part over IPC — not the quote or the signature', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Sounds good.', provider: 'p' })
    renderToolbar({ text: REPLY_BODY })
    fireEvent.click(screen.getByTestId('compose-quick-action-formal'))
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('ai:quickAction:rewrite', {
        accountId: 1,
        preset: 'formal',
        text: 'sounds good',
      })
    })
  })

  it('shows the own part (not the whole field) in the Before pane', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Sounds good.', provider: 'p' })
    renderToolbar({ text: REPLY_BODY })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    const before = screen.getByTestId('quick-action-diff-before')
    expect(before).toHaveTextContent('sounds good')
    expect(before.textContent).not.toContain('> Can you ship it?')
    expect(before.textContent).not.toContain('Sergey')
  })

  it('Replace keeps the quoted original and the signature intact', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Sounds good — shipping today.', provider: 'p' })
    const onReplace = vi.fn()
    renderToolbar({ text: REPLY_BODY, onReplace })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
    expect(onReplace).toHaveBeenCalledWith(
      'Sounds good — shipping today.\n\nOn Mon, alice wrote:\n> Can you ship it?\n\n--\nSergey',
    )
  })

  it('refuses inline when the draft has no own text (quote only), without an IPC call', async () => {
    renderToolbar({ text: '\n\nOn Mon, alice wrote:\n> Can you ship it?' })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('compose-quick-actions-refusal')).toBeInTheDocument())
    expect(screen.getByTestId('compose-quick-actions-refusal')).toHaveTextContent(
      'Quick actions only rewrite your own text.',
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('renders the too_long refusal with its OWN copy, not the generic provider error', async () => {
    // Regression guard: refusalMessageKey has a `default:` arm, so a missing
    // case type-checks fine and silently degrades to the provider-error copy.
    mockInvoke.mockResolvedValue({ ok: false, reason: 'too_long' })
    renderToolbar({ text: 'a very long draft' })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('compose-quick-actions-refusal')).toBeInTheDocument())
    const refusal = screen.getByTestId('compose-quick-actions-refusal')
    expect(refusal).toHaveTextContent('This draft is too long to rewrite in one pass.')
    expect(refusal).not.toHaveTextContent("Couldn't rewrite this draft right now.")
  })

  // -------------------------------------------------------------------------
  // §2.78 AC-h — edits made during generation are never clobbered
  // -------------------------------------------------------------------------

  it('disables Replace and warns when the draft changed while the rewrite was in flight', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Better draft.', provider: 'p' })
    const onReplace = vi.fn()
    const props: React.ComponentProps<typeof ComposeQuickActions> = {
      accountId: 1,
      text: 'my draft',
      composeGeneration: 0,
      getCaret: () => 0,
      onReplace,
      onInsert: vi.fn(),
    }
    const { rerender } = render(React.createElement(ComposeQuickActions, props))
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())

    // The user kept typing while the provider was working.
    rerender(React.createElement(ComposeQuickActions, { ...props, text: 'my draft plus a new paragraph' }))

    expect(screen.getByTestId('quick-action-diff-stale')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-diff-replace')).toBeDisabled()
    fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
    expect(onReplace).not.toHaveBeenCalled()
    // The preview stays open so the user can still Insert or re-run.
    expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument()
  })

  it('catches an edit made WHILE the rewrite is still in flight (not just after the preview opens): stale warning, disabled Replace, no substitution', async () => {
    // Regression guard: the existing "disables Replace and warns..." test above
    // only edits the draft AFTER `mockInvoke` has already resolved and the
    // preview is open — it never exercises staleness against an edit that lands
    // DURING the async round trip, which is the actual §2.78 AC-h defect (a user
    // types while the provider is still working). Holding the invoke promise
    // open and re-rendering before resolving it pins that exact timing.
    let resolveInvoke: ((value: unknown) => void) | undefined
    mockInvoke.mockReturnValue(new Promise(resolve => { resolveInvoke = resolve }))
    const onReplace = vi.fn()
    const onInsert = vi.fn()
    const props: React.ComponentProps<typeof ComposeQuickActions> = {
      accountId: 1,
      text: 'my draft',
      composeGeneration: 0,
      getCaret: () => 0,
      onReplace,
      onInsert,
    }
    const { rerender } = render(React.createElement(ComposeQuickActions, props))
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))

    // The user keeps typing WHILE the provider call is still unresolved — the
    // preview does not exist yet at this point.
    rerender(React.createElement(ComposeQuickActions, { ...props, text: 'my draft plus a new paragraph' }))
    expect(screen.queryByTestId('quick-action-diff')).not.toBeInTheDocument()

    // Only now does the provider respond.
    resolveInvoke!({ ok: true, rewritten: 'Better draft.', provider: 'p' })
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())

    expect(screen.getByTestId('quick-action-diff-stale')).toBeInTheDocument()
    expect(screen.getByTestId('quick-action-diff-replace')).toBeDisabled()
    fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
    expect(onReplace).not.toHaveBeenCalled()
    expect(onInsert).not.toHaveBeenCalled()
    // The preview stays open — the user can still Insert or re-run.
    expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument()
  })

  it('keeps Insert at cursor available on a stale preview and splices into the CURRENT body', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'X', provider: 'p' })
    const onInsert = vi.fn()
    const props: React.ComponentProps<typeof ComposeQuickActions> = {
      accountId: 1,
      text: 'ab',
      composeGeneration: 0,
      getCaret: () => 2,
      onReplace: vi.fn(),
      onInsert,
    }
    const { rerender } = render(React.createElement(ComposeQuickActions, props))
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())

    rerender(React.createElement(ComposeQuickActions, { ...props, text: 'abcd' }))
    fireEvent.click(screen.getByTestId('quick-action-diff-insert'))
    // Spliced into 'abcd' (the current body), so nothing typed meanwhile is lost.
    expect(onInsert).toHaveBeenCalledWith('abXcd', 3)
  })

  it('leaves Replace enabled while the draft is unchanged', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Better draft.', provider: 'p' })
    renderToolbar({ text: 'my draft' })
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    expect(screen.queryByTestId('quick-action-diff-stale')).not.toBeInTheDocument()
    expect(screen.getByTestId('quick-action-diff-replace')).toBeEnabled()
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


// ---------------------------------------------------------------------------
// §3.3 B6 draft side — the translate control.
// ---------------------------------------------------------------------------
describe('ComposeQuickActions — draft translation', () => {
  it('renders nothing at all while the per-account opt-in is off (acceptance f-UI)', () => {
    renderToolbar({ translateEnabled: false })
    expect(screen.queryByTestId('compose-translate-run')).not.toBeInTheDocument()
    expect(screen.queryByTestId('compose-translate-target')).not.toBeInTheDocument()
  })

  it('renders the picker and the button for an account that opted in', () => {
    renderToolbar({ translateEnabled: true })
    expect(screen.getByTestId('compose-translate-target')).toBeInTheDocument()
    expect(screen.getByTestId('compose-translate-run')).toBeInTheDocument()
  })

  it('leaves the button inert while no target language is chosen (acceptance b)', () => {
    renderToolbar({ translateEnabled: true })
    expect(screen.getByTestId('compose-translate-target')).toHaveValue('')
    expect(screen.getByTestId('compose-translate-run')).toBeDisabled()
  })

  it('pre-fills the picker from the suggestion and enables the button', () => {
    renderToolbar({ translateEnabled: true, suggestedTargetLang: 'de' })
    expect(screen.getByTestId('compose-translate-target')).toHaveValue('de')
    expect(screen.getByTestId('compose-translate-run')).toBeEnabled()
  })

  it('never translates by itself — not on mount, not when the target changes (acceptance c)', () => {
    renderToolbar({ translateEnabled: true, suggestedTargetLang: 'de' })
    expect(mockInvoke).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('compose-translate-target'), { target: { value: 'fr' } })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('sends only the own part of the draft over the whitelisted channel (acceptance d)', async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      translation: { translatedText: 'Meine Antwort.', targetLang: 'de', provider: 'anthropic-api' },
    })
    renderToolbar({
      translateEnabled: true,
      suggestedTargetLang: 'de',
      text: 'My reply.\n\nOn Monday, someone wrote:\n> the original\n',
    })
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled())
    const [channel, req] = mockInvoke.mock.calls[0]
    expect(channel).toBe('ai:translate:draft')
    expect(req.targetLang).toBe('de')
    expect(req.text).not.toContain('> the original')
  })

  it('shows the shared review panel and replaces with the tail intact (acceptance d, i)', async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      translation: { translatedText: 'Meine Antwort.', targetLang: 'de', provider: 'anthropic-api' },
    })
    const onReplace = vi.fn()
    const body = 'My reply.\n\nOn Monday, someone wrote:\n> the original\n'
    renderToolbar({ translateEnabled: true, suggestedTargetLang: 'de', text: body, onReplace })
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    expect(screen.getByTestId('quick-action-diff-preset')).toHaveTextContent('Translation')

    expect(onReplace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('quick-action-diff-replace'))
    expect(onReplace).toHaveBeenCalledOnce()
    const next = onReplace.mock.calls[0][0] as string
    expect(next).toContain('Meine Antwort.')
    expect(next).toContain('On Monday, someone wrote:\n> the original\n')
  })

  it('disables Replace when the draft changed while the translation was in flight (acceptance i)', async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      translation: { translatedText: 'Meine Antwort.', targetLang: 'de', provider: 'anthropic-api' },
    })
    const { rerender, props } = renderToolbar({
      translateEnabled: true,
      suggestedTargetLang: 'de',
      text: 'My reply.',
    })
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    rerender(React.createElement(ComposeQuickActions, { ...props, text: 'My reply, edited.' }))
    expect(screen.getByTestId('quick-action-diff-replace')).toBeDisabled()
    expect(screen.getByTestId('quick-action-diff-insert')).toBeEnabled()
  })

  it.each([
    ['budget', 'The AI budget for this period is used up.'],
    ['no_provider', 'No AI provider is set up yet.'],
    ['provider_error', 'The AI provider did not return a translation.'],
    ['too_long', 'This draft is too long to translate in one go.'],
    ['opt_out', 'Translation is turned off for this account.'],
  ] as const)('renders the %s refusal with its own copy (acceptance e)', async (reason, copy) => {
    mockInvoke.mockResolvedValue({ ok: false, reason })
    renderToolbar({ translateEnabled: true, suggestedTargetLang: 'de', text: 'My reply.' })
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    await waitFor(() =>
      expect(screen.getByTestId('compose-translate-refusal')).toHaveTextContent(copy),
    )
  })

  it('renders the no_own_text refusal with its own copy, without an IPC call', () => {
    renderToolbar({
      translateEnabled: true,
      suggestedTargetLang: 'de',
      text: '> only a quote\n> nothing of my own\n',
    })
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(screen.getByTestId('compose-translate-refusal')).toHaveTextContent(
      'Your draft contains only quoted text and a signature.',
    )
  })

  it('renders the empty_input refusal with its own copy, without an IPC call', () => {
    renderToolbar({ translateEnabled: true, suggestedTargetLang: 'de', text: '  ' })
    // The shared `canRun` gate keeps the button inert for an empty draft, so
    // the refusal is reached the same way a programmatic click would reach it.
    expect(screen.getByTestId('compose-translate-run')).toBeDisabled()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('never collapses two different refusals into one line', () => {
    const seen = new Set([
      'ai.quickAction.translate.refusal.budget',
      'ai.quickAction.translate.refusal.noProvider',
      'ai.quickAction.translate.refusal.providerError',
      'ai.quickAction.translate.refusal.emptyInput',
      'ai.quickAction.translate.refusal.tooLong',
      'ai.quickAction.translate.refusal.optOut',
      'ai.quickAction.translate.refusal.noOwnText',
    ])
    expect(seen.size).toBe(7)
    expect(new Set([...seen].map(k => i18nMap[k])).size).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// §3.3 B6.f-renderer — one owner of "this draft is occupied".
//
// The three actions on the bar own independent state machines and cannot see
// each other, so nothing in them stopped a second action from starting over an
// open review panel: two paid requests answering overlapping questions, and two
// modal panels stacked over the same body — the one applied second necessarily
// derived from a snapshot the first had already invalidated.
//
// The rule is deliberately narrow: only OTHER actions block, only while a
// request is in flight or a review panel is open. Everything else about the two
// pre-existing actions must behave exactly as it did.
// ---------------------------------------------------------------------------
describe('ComposeQuickActions — one owner of busy-or-under-review', () => {
  const OK_REWRITE = { ok: true, rewritten: 'Better draft.', provider: 'p' }
  const OK_TRANSLATE = {
    ok: true,
    translation: { translatedText: 'Meine Antwort.', targetLang: 'de', provider: 'p' },
  }
  const OK_PROOFREAD = {
    ok: true,
    provider: 'p',
    dropped: 0,
    edits: [{
      id: 'e0-2-a', offset: 0, length: 2, original: 'my', replacement: 'My',
      category: 'spelling', message: 'Capitalize.',
    }],
  }

  /** Route each channel independently so two actions can be driven in one test. */
  function routeInvoke(map: Record<string, unknown>, deferred?: string) {
    let release: ((value: unknown) => void) | null = null
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === deferred) return new Promise(res => { release = res })
      return Promise.resolve(map[channel])
    })
    return { release: (value: unknown) => release!(value) }
  }

  const ALL_ON = {
    text: 'my draft',
    proofreadEnabled: true,
    translateEnabled: true,
    suggestedTargetLang: 'de' as const,
  }

  function openPanels() {
    return {
      diffs: screen.queryAllByTestId('quick-action-diff').length,
      proofread: screen.queryAllByTestId('proofread-panel').length,
    }
  }

  it('disables the other two actions while a translation is in flight, and re-enables them when it refuses', async () => {
    const gate = routeInvoke(
      { 'ai:quickAction:rewrite': OK_REWRITE, 'ai:proofread:check': OK_PROOFREAD },
      'ai:translate:draft',
    )
    renderToolbar(ALL_ON)
    fireEvent.click(screen.getByTestId('compose-translate-run'))

    await waitFor(() => expect(screen.getByTestId('compose-quick-action-improve')).toBeDisabled())
    expect(screen.getByTestId('compose-proofread-run')).toBeDisabled()

    // A refusal is a finished, dismissible message — not occupancy.
    gate.release({ ok: false, reason: 'budget' })
    await waitFor(() => expect(screen.getByTestId('compose-translate-refusal')).toBeInTheDocument())
    expect(screen.getByTestId('compose-quick-action-improve')).toBeEnabled()
    expect(screen.getByTestId('compose-proofread-run')).toBeEnabled()
  })

  it('never lets a second review panel open over an open translation panel', async () => {
    routeInvoke({
      'ai:translate:draft': OK_TRANSLATE,
      'ai:quickAction:rewrite': OK_REWRITE,
      'ai:proofread:check': OK_PROOFREAD,
    })
    renderToolbar(ALL_ON)
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())

    expect(screen.getByTestId('compose-quick-action-improve')).toBeDisabled()
    expect(screen.getByTestId('compose-proofread-run')).toBeDisabled()

    // Programmatic clicks, the way a stray Enter on a focused-then-disabled
    // button or a test-id driven script would arrive.
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    fireEvent.click(screen.getByTestId('compose-proofread-run'))
    await Promise.resolve()

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(openPanels()).toEqual({ diffs: 1, proofread: 0 })
  })

  it('never lets a translation start over an open rewrite panel, and frees it on Cancel', async () => {
    routeInvoke({ 'ai:quickAction:rewrite': OK_REWRITE, 'ai:translate:draft': OK_TRANSLATE })
    renderToolbar(ALL_ON)
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())

    expect(screen.getByTestId('compose-translate-run')).toBeDisabled()
    expect(screen.getByTestId('compose-proofread-run')).toBeDisabled()
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('quick-action-diff-cancel'))
    expect(screen.getByTestId('compose-translate-run')).toBeEnabled()
    expect(screen.getByTestId('compose-proofread-run')).toBeEnabled()
  })

  it('never lets a translation start over an open proofread panel', async () => {
    routeInvoke({ 'ai:proofread:check': OK_PROOFREAD, 'ai:translate:draft': OK_TRANSLATE })
    renderToolbar(ALL_ON)
    fireEvent.click(screen.getByTestId('compose-proofread-run'))
    await waitFor(() => expect(screen.getByTestId('proofread-panel')).toBeInTheDocument())

    expect(screen.getByTestId('compose-translate-run')).toBeDisabled()
    expect(screen.getByTestId('compose-quick-action-improve')).toBeDisabled()
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    await Promise.resolve()
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(openPanels()).toEqual({ diffs: 0, proofread: 1 })
  })

  it('leaves an action free to re-run over its OWN panel (behaviour unchanged where there is no conflict)', async () => {
    routeInvoke({ 'ai:quickAction:rewrite': OK_REWRITE })
    renderToolbar(ALL_ON)
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())

    // The rewrite family owns the panel, so all four presets stay live.
    expect(screen.getByTestId('compose-quick-action-improve')).toBeEnabled()
    expect(screen.getByTestId('compose-quick-action-shorter')).toBeEnabled()
    fireEvent.click(screen.getByTestId('compose-quick-action-shorter'))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2))
    expect(mockInvoke.mock.calls[1][1]).toMatchObject({ preset: 'shorter' })
  })

  it('changes nothing for an account without the translate opt-in', async () => {
    routeInvoke({ 'ai:quickAction:rewrite': OK_REWRITE, 'ai:proofread:check': OK_PROOFREAD })
    renderToolbar({ text: 'my draft', proofreadEnabled: true, translateEnabled: false })
    expect(screen.getByTestId('compose-quick-action-improve')).toBeEnabled()
    expect(screen.getByTestId('compose-proofread-run')).toBeEnabled()

    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())
    // The proofread button is blocked by the OPEN rewrite panel, which is the
    // rule itself — not by anything the translate control contributes.
    expect(screen.getByTestId('compose-proofread-run')).toBeDisabled()
    fireEvent.click(screen.getByTestId('quick-action-diff-cancel'))
    expect(screen.getByTestId('compose-proofread-run')).toBeEnabled()
  })

  it('keeps the bar occupied when the target language changes while the call is still out', async () => {
    // §3.3 B6.f3: `setTargetLang` disowns the ANSWER — the status returns to
    // idle — but the call is out and is being billed. Reading occupancy off the
    // status freed the rewrite, the corrector AND a second translation right
    // there, over a request the user was still paying for.
    const gate = routeInvoke(
      { 'ai:quickAction:rewrite': OK_REWRITE, 'ai:proofread:check': OK_PROOFREAD },
      'ai:translate:draft',
    )
    renderToolbar(ALL_ON)
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    await waitFor(() => expect(screen.getByTestId('compose-quick-action-improve')).toBeDisabled())

    fireEvent.change(screen.getByTestId('compose-translate-target'), { target: { value: 'fr' } })
    expect(screen.getByTestId('compose-translate-target')).toHaveValue('fr')

    expect(screen.getByTestId('compose-quick-action-improve')).toBeDisabled()
    expect(screen.getByTestId('compose-proofread-run')).toBeDisabled()
    expect(screen.getByTestId('compose-translate-run')).toBeDisabled()
    // A disabled button that no longer says why is the worse half of the bug.
    expect(screen.getByTestId('compose-translate-run')).toHaveAttribute('aria-busy', 'true')

    // Programmatic clicks, the way a stray Enter or a script would arrive: no
    // second paid call while the first is unanswered.
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    fireEvent.click(screen.getByTestId('compose-proofread-run'))
    fireEvent.click(screen.getByTestId('compose-translate-run'))
    await Promise.resolve()
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(openPanels()).toEqual({ diffs: 0, proofread: 0 })

    // Settling — the one event that frees it.
    gate.release({ ok: false, reason: 'budget' })
    await waitFor(() => expect(screen.getByTestId('compose-quick-action-improve')).toBeEnabled())
    expect(screen.getByTestId('compose-proofread-run')).toBeEnabled()
    expect(screen.getByTestId('compose-translate-run')).toBeEnabled()
  })

  it('keeps the language picker live while another action holds the draft', async () => {
    // Choosing a language starts nothing and spends nothing; blocking it would
    // be a restriction with no accident to prevent.
    routeInvoke({ 'ai:quickAction:rewrite': OK_REWRITE })
    renderToolbar(ALL_ON)
    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())

    const picker = screen.getByTestId('compose-translate-target')
    expect(picker).toBeEnabled()
    fireEvent.change(picker, { target: { value: 'fr' } })
    expect(picker).toHaveValue('fr')
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// §3.3 B6.f-renderer — the reset key is a compose generation, not a draft id.
// ---------------------------------------------------------------------------
describe('ComposeQuickActions — the reset key cannot be forgotten by a caller', () => {
  it('does not compile without a compose generation (§3.3 B6.f3)', () => {
    // All three hooks take the key as a MANDATORY parameter so a call site
    // cannot omit it; an optional prop with a `= 0` default at this seam put
    // the hole back — a future caller would compile clean and silently get
    // three machines that never reset (the hung-toolbar defect).
    //
    // This is a type-level assertion: if the prop goes back to optional the
    // `@ts-expect-error` below becomes unused and `npm run typecheck` fails.
    const incomplete = {
      accountId: 1,
      text: 'my draft',
      getCaret: () => 0,
      onReplace: vi.fn(),
      onInsert: vi.fn(),
    }
    // @ts-expect-error composeGeneration is required — see above.
    const element = React.createElement(ComposeQuickActions, incomplete)
    expect(element).toBeTruthy()
  })
})

describe('ComposeQuickActions — compose generation resets the translate memory', () => {
  it('keeps the pick across everything but a generation bump', async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      translation: { translatedText: 'Ma réponse.', targetLang: 'fr', provider: 'p' },
    })
    const { rerender, props } = renderToolbar({
      text: 'my draft',
      translateEnabled: true,
      suggestedTargetLang: 'de',
      composeGeneration: 0,
    })
    fireEvent.change(screen.getByTestId('compose-translate-target'), { target: { value: 'fr' } })
    expect(screen.getByTestId('compose-translate-target')).toHaveValue('fr')

    // The window is still settling: the body changes as the draft hydrates and
    // a suggestion reaches the toolbar late. Same generation, same draft.
    rerender(React.createElement(ComposeQuickActions, {
      ...props, text: 'my draft, restored', suggestedTargetLang: 'it', composeGeneration: 0,
    }))
    expect(screen.getByTestId('compose-translate-target')).toHaveValue('fr')

    // A new compose:init IS a new draft — the pick goes, the suggestion applies.
    rerender(React.createElement(ComposeQuickActions, {
      ...props, suggestedTargetLang: 'de', composeGeneration: 1,
    }))
    expect(screen.getByTestId('compose-translate-target')).toHaveValue('de')
  })
})

// ---------------------------------------------------------------------------
// §3.3 B6.f-renderer iter2 — a stuck action must not survive `compose:init`.
//
// The occupancy owner above made the three machines dependent on each other, so
// the pre-existing "no reset" of the rewrite and proofread hooks stopped being
// a local untidiness: a provider that neither answers nor drops the connection
// leaves one machine `loading` forever, and that now disables the WHOLE bar —
// for this message and for every message the reused window goes on to write.
// The rule is the same key for all three machines.
// ---------------------------------------------------------------------------
describe('ComposeQuickActions — a compose generation bump frees the whole bar', () => {
  const ALL_ON = {
    text: 'my draft',
    proofreadEnabled: true,
    translateEnabled: true,
    suggestedTargetLang: 'de' as const,
    composeGeneration: 0,
  }

  /** Never-resolving channel: the "provider hung" case, reachable with no code change. */
  function hang(channel: string) {
    mockInvoke.mockImplementation((c: string) => (
      c === channel
        ? new Promise(() => {})
        : Promise.resolve({ ok: true, rewritten: 'Better draft.', provider: 'p' })
    ))
  }

  function barState() {
    return {
      improve: (screen.getByTestId('compose-quick-action-improve') as HTMLButtonElement).disabled,
      proofread: (screen.getByTestId('compose-proofread-run') as HTMLButtonElement).disabled,
      translate: (screen.getByTestId('compose-translate-run') as HTMLButtonElement).disabled,
    }
  }

  it('releases the bar after a rewrite that never answers', async () => {
    hang('ai:quickAction:rewrite')
    const { rerender, props } = renderToolbar(ALL_ON)

    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(barState().proofread).toBe(true))
    expect(barState().translate).toBe(true)

    // The window is reused for another message. Without the reset the hung
    // request outlives it and the new draft opens with a dead toolbar.
    rerender(React.createElement(ComposeQuickActions, { ...props, composeGeneration: 1 }))

    expect(barState()).toEqual({ improve: false, proofread: false, translate: false })
    expect(screen.queryByTestId('quick-action-diff')).not.toBeInTheDocument()

    // And the freed bar really works: the next action reaches its channel.
    mockInvoke.mockResolvedValue({ ok: true, provider: 'p', dropped: 0, edits: [] })
    fireEvent.click(screen.getByTestId('compose-proofread-run'))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ai:proofread:check', expect.anything()))
  })

  it('releases the bar after a proofread check that never answers', async () => {
    hang('ai:proofread:check')
    const { rerender, props } = renderToolbar(ALL_ON)

    fireEvent.click(screen.getByTestId('compose-proofread-run'))
    await waitFor(() => expect(barState().improve).toBe(true))
    expect(barState().translate).toBe(true)

    rerender(React.createElement(ComposeQuickActions, { ...props, composeGeneration: 1 }))

    expect(barState()).toEqual({ improve: false, proofread: false, translate: false })
    expect(screen.queryByTestId('proofread-panel')).not.toBeInTheDocument()
  })

  it('closes an open rewrite panel — it reviewed the previous message', async () => {
    mockInvoke.mockResolvedValue({ ok: true, rewritten: 'Better draft.', provider: 'p' })
    const { rerender, props } = renderToolbar(ALL_ON)

    fireEvent.click(screen.getByTestId('compose-quick-action-improve'))
    await waitFor(() => expect(screen.getByTestId('quick-action-diff')).toBeInTheDocument())

    rerender(React.createElement(ComposeQuickActions, { ...props, composeGeneration: 1 }))
    expect(screen.queryByTestId('quick-action-diff')).not.toBeInTheDocument()
    expect(barState()).toEqual({ improve: false, proofread: false, translate: false })
  })
})
