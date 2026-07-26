// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import type { InstantReplyMessageRef } from '../hooks/useInstantReply'

// ---------------------------------------------------------------------------
// Stable i18n mock — prevents infinite re-renders (renderer.md convention)
// ---------------------------------------------------------------------------
const i18nMap: Record<string, string> = {
  'ai.instantReply.trigger': 'Instant Reply',
  'ai.instantReply.useThisDraft': 'Use this draft',
  'ai.instantReply.refusal.budget': 'Daily AI budget reached — instant replies paused until it resets.',
  'ai.instantReply.refusal.noProvider': 'Configure an AI provider in Settings to draft replies.',
  'ai.instantReply.refusal.providerError': "Couldn't draft replies right now.",
}
const stableT = (key: string): string => i18nMap[key] ?? key
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

import { InstantReplyStrip } from './InstantReplyStrip'

const REF: InstantReplyMessageRef = { accountId: 1, folder: 'INBOX', uid: 42, messageId: '<m@x>' }

function renderStrip(overrides: Partial<React.ComponentProps<typeof InstantReplyStrip>> = {}) {
  const props: React.ComponentProps<typeof InstantReplyStrip> = {
    status: 'idle',
    drafts: [],
    refusal: null,
    messageRef: REF,
    onGenerate: vi.fn(),
    onPick: vi.fn(),
    ...overrides,
  }
  return { ...render(React.createElement(InstantReplyStrip, props)), props }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('InstantReplyStrip', () => {
  it('renders the trigger button', () => {
    renderStrip()
    expect(screen.getByTestId('instant-reply-trigger')).toBeInTheDocument()
  })

  it('calls onGenerate with the message ref when the trigger is clicked', () => {
    const { props } = renderStrip()
    fireEvent.click(screen.getByTestId('instant-reply-trigger'))
    expect(props.onGenerate).toHaveBeenCalledWith(REF)
  })

  it('disables the trigger while loading', () => {
    renderStrip({ status: 'loading' })
    expect(screen.getByTestId('instant-reply-trigger')).toBeDisabled()
  })

  it('renders an inline refusal message and no options when refused', () => {
    renderStrip({ status: 'refused', refusal: 'no_provider' })
    expect(screen.getByTestId('instant-reply-refusal')).toHaveTextContent(
      'Configure an AI provider in Settings to draft replies.',
    )
    expect(screen.queryByTestId('instant-reply-options')).not.toBeInTheDocument()
  })

  it('renders 2-3 draft options when ready', () => {
    renderStrip({
      status: 'ready',
      drafts: [{ text: 'Sounds good.' }, { text: 'Let me check.', tone: 'Cautious' }],
    })
    const options = screen.getAllByTestId('instant-reply-option')
    expect(options).toHaveLength(2)
    expect(options[1]).toHaveTextContent('Cautious')
  })

  it('truncates a long draft preview to 120 chars with an ellipsis', () => {
    const longText = 'x'.repeat(200)
    renderStrip({ status: 'ready', drafts: [{ text: longText }] })
    const preview = screen.getAllByTestId('instant-reply-option')[0]
    expect(preview.textContent?.length).toBeLessThan(200)
    expect(preview.textContent).toMatch(/…$/)
  })

  it('calls onPick with the selected draft when a chip is clicked — and never sends anything itself', () => {
    const { props } = renderStrip({
      status: 'ready',
      drafts: [{ text: 'Sounds good.' }, { text: 'Let me check.' }],
    })
    const options = screen.getAllByTestId('instant-reply-option')
    fireEvent.click(options[0])
    expect(props.onPick).toHaveBeenCalledWith({ text: 'Sounds good.' })
    expect(props.onPick).toHaveBeenCalledOnce()
    // No-auto-send invariant: the component exposes no send affordance at all.
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument()
  })

  it('renders no options and no refusal in the idle state', () => {
    renderStrip({ status: 'idle' })
    expect(screen.queryByTestId('instant-reply-options')).not.toBeInTheDocument()
    expect(screen.queryByTestId('instant-reply-refusal')).not.toBeInTheDocument()
  })
})
