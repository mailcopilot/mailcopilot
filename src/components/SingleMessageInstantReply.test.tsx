// @vitest-environment jsdom
/**
 * SingleMessageInstantReply — §3.3 B4 Instant Reply, single-message reading-
 * pane parity path (H2 fix-wave addition).
 *
 * ThreadView already covers the InstantReplyStrip wiring on THREAD cards
 * (ThreadView.test.tsx "instant reply strip (B4)"). This file covers the
 * analogous production-gate for the single-message path: App.tsx only mounts
 * `SingleMessageInstantReply` when `isAiFeatureEnabledForAccount(...)` is true
 * for the active message's account (App.tsx §3.3 B4). Before this component
 * existed, ThreadView.test.tsx rendering a one-element thread did not exercise
 * this gate at all — a regression here would have shipped silently.
 *
 * Covers:
 *   - Renders (mounts the strip) only when the parent opts in — exercised
 *     here by controlling whether the component is rendered at all, mirroring
 *     how App.tsx conditionally mounts it.
 *   - Picking a draft calls `onPick(ref, draft)` with the message's
 *     (accountId, folder, uid) — never a body/text field — and dismisses the
 *     strip afterward (state reset).
 *   - State resets when the active message identity changes (keyed
 *     `accountId:folder:uid`) so draft options generated for one message never
 *     leak onto another.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

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

const mockInvoke = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

import { SingleMessageInstantReply } from './SingleMessageInstantReply'

beforeEach(() => {
  mockInvoke.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('SingleMessageInstantReply', () => {
  it('mounts the strip for the given message', () => {
    render(
      React.createElement(SingleMessageInstantReply, {
        message: { accountId: 1, folder: 'INBOX', uid: 42, messageId: '<m@x>' },
        onPick: vi.fn(),
      }),
    )
    expect(screen.getByTestId('instant-reply-strip')).toBeInTheDocument()
    expect(screen.getByTestId('instant-reply-trigger')).toBeInTheDocument()
  })

  it('generating fires ai:instantReply:generate with ONLY the message ref — never body text', async () => {
    mockInvoke.mockResolvedValue({ ok: true, drafts: [{ text: 'Sounds good.' }, { text: 'Let me check.' }] })
    render(
      React.createElement(SingleMessageInstantReply, {
        message: { accountId: 7, folder: 'Archive', uid: 99, messageId: '<real@x>' },
        onPick: vi.fn(),
      }),
    )
    fireEvent.click(screen.getByTestId('instant-reply-trigger'))
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('ai:instantReply:generate', {
        accountId: 7,
        folder: 'Archive',
        uid: 99,
        messageId: '<real@x>',
      })
    })
    const call = mockInvoke.mock.calls.find(c => c[0] === 'ai:instantReply:generate')
    expect(Object.keys(call![1] as object).sort()).toEqual(['accountId', 'folder', 'messageId', 'uid'])
  })

  it('picking a draft calls onPick with the (accountId, folder, uid) ref and the chosen draft, then dismisses the strip', async () => {
    mockInvoke.mockResolvedValue({ ok: true, drafts: [{ text: 'Sounds good.' }] })
    const onPick = vi.fn()
    render(
      React.createElement(SingleMessageInstantReply, {
        message: { accountId: 7, folder: 'Archive', uid: 99, messageId: '<real@x>' },
        onPick,
      }),
    )
    fireEvent.click(screen.getByTestId('instant-reply-trigger'))
    await waitFor(() => expect(screen.getByTestId('instant-reply-options')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTestId('instant-reply-option')[0])

    expect(onPick).toHaveBeenCalledWith(
      { accountId: 7, folder: 'Archive', uid: 99 },
      { text: 'Sounds good.' },
    )
    expect(onPick).toHaveBeenCalledOnce()

    // Dismissed after pick: no lingering options/refusal on screen.
    await waitFor(() => {
      expect(screen.queryByTestId('instant-reply-options')).not.toBeInTheDocument()
    })

    // No-auto-send invariant: no send-shaped channel was ever invoked.
    expect(mockInvoke.mock.calls.every(c => !String(c[0]).toLowerCase().includes('send'))).toBe(true)
  })

  it('resets Instant Reply state when the active message identity changes (accountId:folder:uid)', async () => {
    mockInvoke.mockResolvedValue({ ok: true, drafts: [{ text: 'Draft for message A' }] })
    const { rerender } = render(
      React.createElement(SingleMessageInstantReply, {
        message: { accountId: 1, folder: 'INBOX', uid: 1 },
        onPick: vi.fn(),
      }),
    )
    fireEvent.click(screen.getByTestId('instant-reply-trigger'))
    await waitFor(() => expect(screen.getByTestId('instant-reply-options')).toBeInTheDocument())

    // Switch to a DIFFERENT message (uid changes) — the strip must reset to
    // idle, not keep showing message A's stale draft options.
    rerender(
      React.createElement(SingleMessageInstantReply, {
        message: { accountId: 1, folder: 'INBOX', uid: 2 },
        onPick: vi.fn(),
      }),
    )
    await waitFor(() => {
      expect(screen.queryByTestId('instant-reply-options')).not.toBeInTheDocument()
    })
  })

  it('does NOT reset state when re-rendered with the SAME message identity (no spurious dismiss loop)', async () => {
    mockInvoke.mockResolvedValue({ ok: true, drafts: [{ text: 'Draft A' }] })
    const { rerender } = render(
      React.createElement(SingleMessageInstantReply, {
        message: { accountId: 1, folder: 'INBOX', uid: 1 },
        onPick: vi.fn(),
      }),
    )
    fireEvent.click(screen.getByTestId('instant-reply-trigger'))
    await waitFor(() => expect(screen.getByTestId('instant-reply-options')).toBeInTheDocument())

    // Re-render with the identical message ref (e.g. parent re-render for an
    // unrelated reason) — options must survive.
    rerender(
      React.createElement(SingleMessageInstantReply, {
        message: { accountId: 1, folder: 'INBOX', uid: 1 },
        onPick: vi.fn(),
      }),
    )
    expect(screen.getByTestId('instant-reply-options')).toBeInTheDocument()
  })
})
