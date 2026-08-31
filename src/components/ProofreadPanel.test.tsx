// @vitest-environment jsdom
/**
 * §3.3 B7 — the proofread review panel (`ProofreadPanel`, declared in
 * `QuickActionDiff.tsx`) and its wiring into the compose toolbar.
 *
 * The panel is where the feature's honesty lives, so that is what is asserted:
 * an empty list reads as "nothing to fix" rather than as a failure, the count
 * of suggestions that could not be placed is SHOWN, the model's explanation is
 * rendered as plain text, and a draft edited mid-check disables Apply instead
 * of writing spans over a string that no longer exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

const i18nMap: Record<string, string> = {
  'ai.quickAction.proofread.button': 'Check writing',
  'ai.quickAction.proofread.checking': 'Checking…',
  'ai.quickAction.proofread.title': 'Suggested corrections',
  'ai.quickAction.proofread.noEdits': 'No mistakes found.',
  'ai.quickAction.proofread.accept': 'Accept',
  'ai.quickAction.proofread.undo': 'Undo',
  'ai.quickAction.proofread.acceptAll': 'Accept all',
  'ai.quickAction.proofread.apply': 'Apply selected',
  'ai.quickAction.proofread.cancel': 'Cancel',
  'ai.quickAction.proofread.category.spelling': 'Spelling',
  'ai.quickAction.proofread.category.wording': 'Wording',
  'ai.quickAction.proofread.staleWarning': 'You edited the draft while the check was running.',
  'ai.quickAction.proofread.refusal.notEnabled': 'Turn on AI proofreading for this account in Settings.',
  'ai.quickAction.proofread.refusal.providerError': "Couldn't check this draft right now.",
}
// Interpolating stub: enough for the count-bearing strings, stable identity so
// the component does not re-render forever (renderer test convention).
const stableT = (key: string, opts?: { count?: number }): string => {
  const base = i18nMap[key] ?? key
  return typeof opts?.count === 'number' ? `${base}:${opts.count}` : base
}
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({ useTranslation: () => stableUseTranslation }))
vi.mock('../sentry', () => ({ captureException: vi.fn() }))
vi.mock('../utils/metrics', () => ({ recordEvent: vi.fn() }))

const mockInvoke = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

import { ProofreadPanel } from './QuickActionDiff'
import { ComposeQuickActions } from './ComposeQuickActions'
import type { ProofreadReview } from '../hooks/useQuickActions'
import type { ProofreadEdit } from '../utils/quickActions'

const TEH: ProofreadEdit = {
  id: 'e0-3-a', offset: 0, length: 3, original: 'teh', replacement: 'the',
  category: 'spelling', message: 'Опечатка в слове.',
}
const SAT: ProofreadEdit = {
  id: 'e8-3-b', offset: 8, length: 3, original: 'sat', replacement: 'slept',
  category: 'wording', message: 'Clearer verb.',
}

const BODY = 'teh cat sat\n\n--\nSergey'

function review(over: Partial<ProofreadReview> = {}): ProofreadReview {
  return {
    own: 'teh cat sat',
    split: { lead: '', own: 'teh cat sat', tail: '\n\n--\nSergey' },
    sourceBody: BODY,
    edits: [TEH, SAT],
    dropped: 0,
    ...over,
  }
}

function renderPanel(over: Partial<React.ComponentProps<typeof ProofreadPanel>> = {}) {
  const props: React.ComponentProps<typeof ProofreadPanel> = {
    review: review(),
    accepted: new Set<string>(),
    onToggleEdit: vi.fn(),
    onAcceptAll: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  }
  return { ...render(<ProofreadPanel {...props} />), props }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockReset()
})
afterEach(() => cleanup())

describe('ProofreadPanel', () => {
  it('renders one independently actionable row per edit', () => {
    renderPanel()
    expect(screen.getAllByTestId('proofread-edit')).toHaveLength(2)
    expect(screen.getByTestId(`proofread-edit-toggle-${TEH.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`proofread-edit-toggle-${SAT.id}`)).toBeInTheDocument()
  })

  it('shows the before/after pair and the model explanation as plain text', () => {
    renderPanel()
    expect(screen.getByText('teh')).toBeInTheDocument()
    expect(screen.getByText('the')).toBeInTheDocument()
    // Third-party free text: displayed verbatim, never interpreted.
    expect(screen.getByText('Опечатка в слове.')).toBeInTheDocument()
  })

  it('marks an accepted row and offers Undo instead of Accept', () => {
    renderPanel({ accepted: new Set([TEH.id]) })
    const rows = screen.getAllByTestId('proofread-edit')
    expect(rows[0]).toHaveAttribute('data-accepted', 'true')
    expect(rows[1]).toHaveAttribute('data-accepted', 'false')
    expect(screen.getByTestId(`proofread-edit-toggle-${TEH.id}`)).toHaveTextContent('Undo')
    expect(screen.getByTestId(`proofread-edit-toggle-${SAT.id}`)).toHaveTextContent('Accept')
  })

  it('toggles exactly the clicked edit', () => {
    const { props } = renderPanel()
    fireEvent.click(screen.getByTestId(`proofread-edit-toggle-${SAT.id}`))
    expect(props.onToggleEdit).toHaveBeenCalledWith(SAT.id)
  })

  it('reads an empty list as "no mistakes", not as a refusal', () => {
    renderPanel({ review: review({ edits: [] }) })
    expect(screen.getByTestId('proofread-no-edits')).toHaveTextContent('No mistakes found.')
    expect(screen.queryByTestId('proofread-edits')).not.toBeInTheDocument()
    // Nothing to accept — no "accept all" affordance either.
    expect(screen.queryByTestId('proofread-accept-all')).not.toBeInTheDocument()
  })

  it('shows how many suggestions could not be placed', () => {
    renderPanel({ review: review({ dropped: 3 }) })
    expect(screen.getByTestId('proofread-dropped')).toHaveTextContent(':3')
  })

  it('says nothing about dropped suggestions when none were dropped', () => {
    renderPanel()
    expect(screen.queryByTestId('proofread-dropped')).not.toBeInTheDocument()
  })

  it('disables Apply until at least one edit is accepted', () => {
    const { unmount } = renderPanel()
    expect(screen.getByTestId('proofread-apply')).toBeDisabled()
    unmount()
    renderPanel({ accepted: new Set([TEH.id]) })
    expect(screen.getByTestId('proofread-apply')).toBeEnabled()
  })

  it('§2.78 AC-h: a draft edited mid-check warns and blocks Apply', () => {
    const { props } = renderPanel({ stale: true, accepted: new Set([TEH.id]) })
    expect(screen.getByTestId('proofread-stale')).toBeInTheDocument()
    const apply = screen.getByTestId('proofread-apply')
    expect(apply).toBeDisabled()
    fireEvent.click(apply)
    expect(props.onApply).not.toHaveBeenCalled()
  })

  it('dismisses on Escape, on the backdrop and on Cancel', () => {
    const { props, unmount } = renderPanel()
    fireEvent.keyDown(screen.getByTestId('proofread-panel'), { key: 'Escape' })
    fireEvent.click(screen.getByTestId('proofread-backdrop'))
    fireEvent.click(screen.getByTestId('proofread-cancel'))
    expect(props.onCancel).toHaveBeenCalledTimes(3)
    unmount()
  })
})

describe('ComposeQuickActions — proofread action', () => {
  function renderToolbar(over: Partial<React.ComponentProps<typeof ComposeQuickActions>> = {}) {
    const props: React.ComponentProps<typeof ComposeQuickActions> = {
      accountId: 1,
      text: BODY,
      proofreadEnabled: true,
      composeGeneration: 0,
      onReplace: vi.fn(),
      onInsert: vi.fn(),
      ...over,
    }
    return { ...render(<ComposeQuickActions {...props} />), props }
  }

  // §1.26.1(2): a switched-off opt-in locks the button, it does not delete it —
  // an absent control reads as a missing feature.
  it('still renders the check button for an account that has not opted in, locked', () => {
    renderToolbar({ proofreadEnabled: false })
    const btn = screen.getByTestId('compose-proofread-run')
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    // Focusable on purpose (W3C ARIA APG): `disabled` would take the button
    // out of the tab order along with the hint that says where to switch it on.
    expect(btn).toBeEnabled()
  })

  it('makes the locked check button inert — no IPC on click (AC-2b)', () => {
    renderToolbar({ proofreadEnabled: false })
    fireEvent.click(screen.getByTestId('compose-proofread-run'))
    fireEvent.click(screen.getByTestId('compose-proofread-run'))
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(screen.queryByTestId('proofread-panel')).not.toBeInTheDocument()
  })

  // §1.26.1(2) — the one behavioural difference `aria-disabled` buys over the
  // `disabled` attribute: a real `disabled` button cannot receive focus at all
  // (jsdom and every browser agree), which would make the "turn it on in
  // Settings" hint unreachable by keyboard. Reintroducing
  // `disabled={proofreadLocked}` here keeps every other assertion in this file
  // green while breaking exactly this one.
  it('stays reachable by keyboard focus while locked', () => {
    renderToolbar({ proofreadEnabled: false })
    const btn = screen.getByTestId('compose-proofread-run')
    btn.focus()
    expect(document.activeElement).toBe(btn)
  })

  it('renders the check button for an opted-in account', () => {
    renderToolbar()
    expect(screen.getByTestId('compose-proofread-run')).toBeInTheDocument()
  })

  it('sends only the own text and applies just the accepted edit back into the draft', async () => {
    mockInvoke.mockResolvedValue({ ok: true, edits: [TEH, SAT], provider: 'p', dropped: 0 })
    const { props } = renderToolbar()

    fireEvent.click(screen.getByTestId('compose-proofread-run'))
    await waitFor(() => expect(screen.getByTestId('proofread-panel')).toBeInTheDocument())
    expect(mockInvoke).toHaveBeenCalledWith('ai:proofread:check', { accountId: 1, text: 'teh cat sat' })

    fireEvent.click(screen.getByTestId(`proofread-edit-toggle-${TEH.id}`))
    fireEvent.click(screen.getByTestId('proofread-apply'))

    // Accepted span applied; the un-accepted one and the signature untouched.
    expect(props.onReplace).toHaveBeenCalledWith('the cat sat\n\n--\nSergey')
    await waitFor(() => expect(screen.queryByTestId('proofread-panel')).not.toBeInTheDocument())
  })

  it('never touches the draft when the panel is cancelled', async () => {
    mockInvoke.mockResolvedValue({ ok: true, edits: [TEH], provider: 'p', dropped: 0 })
    const { props } = renderToolbar()

    fireEvent.click(screen.getByTestId('compose-proofread-run'))
    await waitFor(() => expect(screen.getByTestId('proofread-panel')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId(`proofread-edit-toggle-${TEH.id}`))
    fireEvent.click(screen.getByTestId('proofread-cancel'))

    expect(props.onReplace).not.toHaveBeenCalled()
  })

  it('shows the opt-in refusal with its own actionable copy, not the provider error', async () => {
    mockInvoke.mockResolvedValue({ ok: false, reason: 'not_enabled' })
    renderToolbar()

    fireEvent.click(screen.getByTestId('compose-proofread-run'))
    await waitFor(() => expect(screen.getByTestId('compose-proofread-refusal')).toBeInTheDocument())
    expect(screen.getByTestId('compose-proofread-refusal'))
      .toHaveTextContent('Turn on AI proofreading for this account in Settings.')
  })
})
