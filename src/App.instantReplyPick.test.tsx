// @vitest-environment jsdom
/**
 * Unit tests for §3.3 B4 `instantReplyPick` — the App.tsx callback that fires
 * when the user picks one of the AI-generated Instant Reply draft options
 * (via `InstantReplyStrip` on a thread card, or `SingleMessageInstantReply`
 * on a single open message).
 *
 * Because App.tsx is a monolithic component with dozens of IPC calls and
 * sub-hooks (CLAUDE.md §5 hotspot policy), `instantReplyPick` is not exported
 * and cannot be unit-tested directly. Following the SAME deliberate mirror
 * pattern as `App.print.test.tsx`, this file replicates the EXACT logic of
 * `instantReplyPick` (App.tsx, §3.3 B4 Instant Reply section) in a minimal
 * fixture component, using the REAL production helpers it calls
 * (`computeReplyRecipients` / `prefixSubject`, re-exported from
 * `./utils/mail` — same import App.tsx itself uses, source of truth
 * `@mailcopilot/core/mail`) — not hand-rolled substitutes. This tests the
 * *behaviour contract* (which `window.api.invoke` channels are called, with
 * what payload) that the production code implements, not the surrounding
 * App scaffolding.
 *
 * This is the HT3 no-auto-send invariant pin for B4: picking a draft must
 * result in EXACTLY ONE `ui:openCompose` call carrying the draft's raw text
 * as the compose body, and MUST NOT touch any send channel — the user still
 * has to press Send in the opened Compose window.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useCallback, useState } from 'react'
import React from 'react'
import { computeReplyRecipients, prefixSubject } from './utils/mail'
import type { ComposeInit, MessageDetails } from '../packages/types'

// ---------------------------------------------------------------------------
// window.api mock — set before any import that might read it
// ---------------------------------------------------------------------------
const mockInvoke = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

/**
 * Mirrors App.tsx's `instantReplyPick` (§3.3 B4 Instant Reply section)
 * VERBATIM in shape:
 *   1. Resolve MessageDetails — from the `detailsRef`-equivalent cache when it
 *      matches the full (accountId, folder, uid) of the picked ref, otherwise
 *      via `net:messageDetails`.
 *   2. Compute Reply (not Reply-All) recipients from the envelope via the
 *      REAL `computeReplyRecipients` core helper.
 *   3. Build ComposeInit with `text: draft.text` VERBATIM (no quoting, no
 *      original body prepended — the draft IS the message) and
 *      `source: 'ai_chip'`.
 *   4. `ui:openCompose(ref.accountId, init)` — and nothing else. No send
 *      channel is ever touched.
 */
function InstantReplyPickFixture({
  cachedDetails,
  activeRef,
}: {
  cachedDetails: { accountId: number; folder: string; uid: number; details: MessageDetails } | null
  activeRef: { accountId: number; folder: string; uid: number } | null
}) {
  const [lastError, setLastError] = useState('')

  const instantReplyPick = useCallback(async (
    ref: { accountId: number; folder: string; uid: number },
    draft: { text: string; tone?: string },
  ) => {
    try {
      setLastError('')
      const cached = cachedDetails
      const d = cached && activeRef && activeRef.accountId === ref.accountId && activeRef.folder === ref.folder && cached.details.uid === ref.uid
        ? cached.details
        : await window.api.invoke('net:messageDetails', ref.accountId, ref.folder, ref.uid) as MessageDetails
      const env = d.envelope
      const subj = (env?.subject || '').trim()
      const me = 'me@example.test'
      const { to: replyTo, cc, originalRecipients } = computeReplyRecipients(env, 'reply', me)
      const init: ComposeInit = {
        to: replyTo,
        cc,
        subject: prefixSubject('Re', subj),
        text: draft.text,
        replyRef: { accountId: ref.accountId, folder: ref.folder, uid: ref.uid },
        originalRecipients,
        source: 'ai_chip',
      }
      await window.api.invoke('ui:openCompose', ref.accountId, init)
    } catch (e) {
      setLastError(String(e))
    }
  }, [cachedDetails, activeRef])

  return React.createElement(
    'button',
    {
      'data-testid': 'pick-draft',
      onClick: () => {
        void instantReplyPick(
          { accountId: 5, folder: 'INBOX', uid: 77 },
          { text: 'Sounds good, see you Friday.', tone: 'concise' },
        )
      },
    },
    lastError || 'pick',
  )
}

function envelopeFor(from: string, subject: string) {
  return {
    from: [{ address: from, name: '' }],
    to: [{ address: 'me@example.test', name: '' }],
    subject,
  }
}

describe('instantReplyPick — §3.3 B4 no-auto-send contract', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('picking a draft results in EXACTLY ONE ui:openCompose call with text === draft.text, and no send channel is ever touched', async () => {
    const cachedDetails = {
      accountId: 5, folder: 'INBOX', uid: 77,
      details: { uid: 77, envelope: envelopeFor('alice@example.test', 'Project update') } as MessageDetails,
    }
    mockInvoke.mockResolvedValue(undefined)

    const { getByTestId } = render(
      React.createElement(InstantReplyPickFixture, {
        cachedDetails,
        activeRef: { accountId: 5, folder: 'INBOX', uid: 77 },
      }),
    )
    fireEvent.click(getByTestId('pick-draft'))

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('ui:openCompose', 5, expect.objectContaining({
        text: 'Sounds good, see you Friday.',
      }))
    })

    // Exactly one openCompose call, and it is the ONLY invoke() call — no
    // messageDetails fetch was needed (cache hit) and no send channel fired.
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const call = mockInvoke.mock.calls.find(c => c[0] === 'ui:openCompose')
    expect(call).toBeDefined()
    const init = call![2] as ComposeInit
    expect(init.text).toBe('Sounds good, see you Friday.')
    expect(init.source).toBe('ai_chip')
    expect(init.subject).toBe('Re: Project update')
    expect(init.replyRef).toEqual({ accountId: 5, folder: 'INBOX', uid: 77 })

    // No auto-send: zero calls to any send-shaped channel.
    expect(mockInvoke).not.toHaveBeenCalledWith('mail:send', expect.anything())
    expect(mockInvoke).not.toHaveBeenCalledWith('net:sendMail', expect.anything())
    expect(mockInvoke).not.toHaveBeenCalledWith('smtp:send', expect.anything())
    expect(mockInvoke).not.toHaveBeenCalledWith(expect.stringMatching(/scheduleSend/i), expect.anything())
    expect(mockInvoke.mock.calls.every(c => !String(c[0]).toLowerCase().includes('send'))).toBe(true)
  })

  it('falls back to net:messageDetails when the cache does not match the picked ref, then still fires exactly one ui:openCompose', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'net:messageDetails') {
        return { uid: 77, envelope: envelopeFor('bob@example.test', 'Deadline') } as MessageDetails
      }
      return undefined
    })

    const { getByTestId } = render(
      React.createElement(InstantReplyPickFixture, {
        // Cache belongs to a DIFFERENT account — must not be trusted.
        cachedDetails: { accountId: 9, folder: 'INBOX', uid: 77, details: { uid: 77 } as MessageDetails },
        activeRef: { accountId: 9, folder: 'INBOX', uid: 77 },
      }),
    )
    fireEvent.click(getByTestId('pick-draft'))

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('ui:openCompose', 5, expect.objectContaining({
        text: 'Sounds good, see you Friday.',
        subject: 'Re: Deadline',
      }))
    })

    expect(mockInvoke).toHaveBeenCalledWith('net:messageDetails', 5, 'INBOX', 77)
    const openComposeCalls = mockInvoke.mock.calls.filter(c => c[0] === 'ui:openCompose')
    expect(openComposeCalls).toHaveLength(1)
  })
})
