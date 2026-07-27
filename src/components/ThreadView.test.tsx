// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'
import type { MailSummary } from '../../packages/types/mail'
import type { ThreadRow } from '../utils/threading'

// ---------------------------------------------------------------------------
// Stable i18n mock — prevents infinite re-renders (renderer.md convention)
// ---------------------------------------------------------------------------
const i18nMap: Record<string, string> = {
  'mail.thread.expandCard': 'Expand',
  'mail.thread.collapseCard': 'Collapse',
  'mail.thread.snippetEmpty': '(no preview)',
  'ai.threadSummary.title': 'AI Summary',
  'ai.threadSummary.loading': 'Summarizing thread…',
  'ai.threadSummary.expand': 'Show key points',
  'ai.threadSummary.collapse': 'Hide key points',
  'ai.threadSummary.retry': 'Retry',
  'ai.threadSummary.refusal.budget': 'Daily AI budget reached — summary paused until it resets.',
  'ai.threadSummary.refusal.noProvider': 'Configure an AI provider in Settings to summarize threads.',
  'ai.threadSummary.refusal.providerError': "Couldn't summarize this thread right now.",
  'ai.instantReply.trigger': 'Instant Reply',
  'ai.instantReply.useThisDraft': 'Use this draft',
  'ai.instantReply.refusal.budget': 'Daily AI budget reached — instant replies paused until it resets.',
  'ai.instantReply.refusal.noProvider': 'Configure an AI provider in Settings to draft replies.',
  'ai.instantReply.refusal.providerError': "Couldn't draft replies right now.",
}
const stableT = (key: string, opts?: Record<string, unknown>): string => {
  let text = i18nMap[key] ?? key
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
    }
  }
  return text
}
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

vi.mock('./MailAvatar', () => ({
  default: ({ from }: { from: string }) =>
    React.createElement('div', { 'data-testid': 'mail-avatar' }, from),
}))

// Control the summary hook per-test. `useThreadSummary` is unit-tested in its
// own spec; here we assert ThreadView's wiring + the strip's rendering, so we
// stub the hook's output. `active` mirrors the hook's real gate (opt-in ON and
// ≥3 messages) — we drive it via the mock so the tests stay deterministic.
const mockUseThreadSummary = vi.fn()
vi.mock('../hooks/useThreadSummary', () => ({
  useThreadSummary: (args: unknown) => mockUseThreadSummary(args),
  THREAD_SUMMARY_MIN_MESSAGES: 3,
  THREAD_SUMMARY_DEBOUNCE_MS: 300,
}))

function summaryState(overrides: Record<string, unknown> = {}) {
  return {
    active: false,
    status: 'idle',
    summary: null,
    refusal: null,
    retry: vi.fn(),
    ...overrides,
  }
}

vi.mock('../utils/mail', () => ({
  formatSmartDate: () => ({ display: 'Jan 1', full: 'January 1, 2024' }),
}))

const mockInvoke = vi.fn().mockResolvedValue({ conversationOrder: 'oldest-top' })
const mockOn = vi.fn()
const mockOff = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: mockOn, off: mockOff },
  writable: true,
})

import ThreadView from './ThreadView'

function makeMail(uid: number, overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    accountId: 1,
    folder: 'INBOX',
    uid,
    from: `Sender ${uid}`,
    fromAddr: `sender${uid}@example.com`,
    fromName: `Sender ${uid}`,
    subject: `Subject ${uid}`,
    date: `2024-01-0${uid}T10:00:00Z`,
    unread: false,
    flagged: false,
    ...overrides,
  }
}

function makeThread(items: MailSummary[], overrides: Partial<ThreadRow> = {}): ThreadRow {
  const lead = items[0]
  const key = `${lead.accountId}:${lead.folder}:${lead.uid}`
  return { key, lead, items, count: items.length, ...overrides }
}

function defaultProps(
  thread: ThreadRow,
  activeKey: string | null,
  overrides: Partial<React.ComponentProps<typeof ThreadView>> = {},
): React.ComponentProps<typeof ThreadView> {
  return {
    thread,
    activeKey,
    onCardOpen: vi.fn(),
    renderBody: () => React.createElement('div', { 'data-testid': 'body-slot' }, 'mail body'),
    gravatarEnabled: false,
    order: 'oldest-top',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ conversationOrder: 'oldest-top' })
  // Default: strip inert. Individual summary-strip tests override this.
  mockUseThreadSummary.mockReturnValue(summaryState())
})

afterEach(() => {
  cleanup()
})

describe('ThreadView', () => {
  it('renders one card per item in the thread', () => {
    const mails = [makeMail(1), makeMail(2), makeMail(3)]
    const thread = makeThread(mails)
    render(React.createElement(ThreadView, defaultProps(thread, '1:INBOX:3')))
    expect(screen.getAllByTestId('thread-card')).toHaveLength(3)
  })

  it('wraps the stack in [data-testid="thread-view"]', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    render(React.createElement(ThreadView, defaultProps(thread, '1:INBOX:2')))
    expect(screen.getByTestId('thread-view')).toBeInTheDocument()
  })

  it('does NOT render its own action toolbar (single-toolbar UX in App.tsx)', () => {
    // Regression guard: removing the duplicate thread-view-actions toolbar.
    // The viewer in App.tsx is the single source of truth for thread actions
    // when activeThread.count > 1 (Gmail / Spark / Shortwave model). If a
    // future change reintroduces an in-component toolbar, this test fails.
    const mails = [makeMail(1), makeMail(2), makeMail(3)]
    const thread = makeThread(mails)
    const { container } = render(
      React.createElement(ThreadView, defaultProps(thread, '1:INBOX:3')),
    )
    expect(container.querySelector('.thread-view-header')).toBeNull()
    expect(container.querySelector('.thread-view-actions')).toBeNull()
    expect(container.querySelector('[data-testid="thread-action-reply"]')).toBeNull()
    expect(container.querySelector('[data-testid="thread-action-snooze"]')).toBeNull()
  })

  it('renders cards sorted oldest → newest when order is oldest-top', () => {
    const mails = [makeMail(3), makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:3', { renderBody: () => null }),
      ),
    )
    const avatars = screen.getAllByTestId('mail-avatar')
    expect(avatars[0].textContent).toBe('Sender 1')
    expect(avatars[1].textContent).toBe('Sender 2')
    expect(avatars[2].textContent).toBe('Sender 3')
  })

  it('AC1: renders cards newest-top when order prop is newest-top', () => {
    const mails = [makeMail(1), makeMail(2), makeMail(3)]
    const thread = makeThread(mails)
    render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:3', { renderBody: () => null, order: 'newest-top' }),
      ),
    )
    const avatars = screen.getAllByTestId('mail-avatar')
    expect(avatars[0].textContent).toBe('Sender 3')
    expect(avatars[1].textContent).toBe('Sender 2')
    expect(avatars[2].textContent).toBe('Sender 1')
  })

  it('active card has aria-expanded=true', () => {
    const mails = [makeMail(1), makeMail(2), makeMail(3)]
    const thread = makeThread(mails)
    const { container } = render(
      React.createElement(ThreadView, defaultProps(thread, '1:INBOX:3')),
    )
    const cardHeaders = container.querySelectorAll('.thread-card-header')
    const expandedOnes = Array.from(cardHeaders).filter(
      h => h.getAttribute('aria-expanded') === 'true',
    )
    expect(expandedOnes).toHaveLength(1)
  })

  it('non-active cards have aria-expanded=false by default', () => {
    const mails = [makeMail(1), makeMail(2), makeMail(3)]
    const thread = makeThread(mails)
    const { container } = render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:3', { renderBody: () => null }),
      ),
    )
    const cardHeaders = container.querySelectorAll('.thread-card-header')
    const collapsedOnes = Array.from(cardHeaders).filter(
      h => h.getAttribute('aria-expanded') === 'false',
    )
    expect(collapsedOnes).toHaveLength(2)
  })

  it('non-last card is expanded when it is the active one', () => {
    const mails = [makeMail(1), makeMail(2), makeMail(3)]
    const thread = makeThread(mails)
    const { container } = render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:1', { renderBody: () => null }),
      ),
    )
    const cardHeaders = container.querySelectorAll('.thread-card-header')
    expect(cardHeaders[0].getAttribute('aria-expanded')).toBe('true')
    expect(cardHeaders[1].getAttribute('aria-expanded')).toBe('false')
    expect(cardHeaders[2].getAttribute('aria-expanded')).toBe('false')
  })

  it('active card renders the body slot', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    render(React.createElement(ThreadView, defaultProps(thread, '1:INBOX:2')))
    expect(screen.getByTestId('body-slot')).toBeInTheDocument()
  })

  it('non-active cards do NOT render the body slot', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    render(React.createElement(ThreadView, defaultProps(thread, '1:INBOX:2')))
    expect(screen.getAllByTestId('body-slot')).toHaveLength(1)
  })

  it('renders no body slot when activeKey is null', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    render(React.createElement(ThreadView, defaultProps(thread, null)))
    expect(screen.queryByTestId('body-slot')).not.toBeInTheDocument()
  })

  it('active card has class thread-card-active (oldest-top: uid=2 is last=index 1)', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { renderBody: () => null }),
      ),
    )
    const cards = screen.getAllByTestId('thread-card')
    expect(cards[1]).toHaveClass('thread-card-active')
  })

  it('non-active card has class thread-card-collapsed', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { renderBody: () => null }),
      ),
    )
    const cards = screen.getAllByTestId('thread-card')
    expect(cards[0]).toHaveClass('thread-card-collapsed')
    expect(cards[0]).not.toHaveClass('thread-card-active')
  })

  it('unread card has class thread-card-unread', () => {
    const mails = [makeMail(1, { unread: true }), makeMail(2)]
    const thread = makeThread(mails)
    render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { renderBody: () => null }),
      ),
    )
    const cards = screen.getAllByTestId('thread-card')
    expect(cards[0]).toHaveClass('thread-card-unread')
    expect(cards[1]).not.toHaveClass('thread-card-unread')
  })

  it('AC2 scenario 1: clicking a collapsed non-active card calls onCardOpen', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    const onCardOpen = vi.fn()
    const { container } = render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { onCardOpen, renderBody: () => null }),
      ),
    )
    const collapsedButton = Array.from(container.querySelectorAll('.thread-card-header')).find(
      b => b.getAttribute('aria-expanded') === 'false',
    )
    expect(collapsedButton).toBeDefined()
    fireEvent.click(collapsedButton!)
    expect(onCardOpen).toHaveBeenCalledOnce()
    expect(onCardOpen).toHaveBeenCalledWith(mails[0])
  })

  it('AC2 scenario 3: clicking the expanded active card collapses it without calling onCardOpen', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    const onCardOpen = vi.fn()
    const { container } = render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { onCardOpen, renderBody: () => null }),
      ),
    )
    const activeButton = Array.from(container.querySelectorAll('.thread-card-header')).find(
      b => b.getAttribute('aria-expanded') === 'true',
    )
    expect(activeButton).toBeDefined()
    fireEvent.click(activeButton!)
    expect(onCardOpen).not.toHaveBeenCalled()
    expect(activeButton!.getAttribute('aria-expanded')).toBe('false')
  })

  it('AC2 scenario 2: clicking collapsed active card re-expands it', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    const onCardOpen = vi.fn()
    const { container } = render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { onCardOpen, renderBody: () => null }),
      ),
    )
    const activeButton = Array.from(container.querySelectorAll('.thread-card-header')).find(
      b => b.getAttribute('aria-expanded') === 'true',
    )!
    fireEvent.click(activeButton)
    expect(activeButton.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(activeButton)
    expect(activeButton.getAttribute('aria-expanded')).toBe('true')
    expect(onCardOpen).not.toHaveBeenCalled()
  })

  it('body slot disappears when active card is collapsed via toggleCard', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    const { container } = render(
      React.createElement(ThreadView, defaultProps(thread, '1:INBOX:2', {})),
    )
    expect(screen.getByTestId('body-slot')).toBeInTheDocument()
    const activeHeader = Array.from(container.querySelectorAll('.thread-card-header')).find(
      h => h.getAttribute('aria-expanded') === 'true',
    )!
    expect(activeHeader).toBeDefined()
    fireEvent.click(activeHeader)
    expect(screen.queryByTestId('body-slot')).not.toBeInTheDocument()
    const cards = screen.getAllByTestId('thread-card')
    expect(cards[1]).toHaveClass('thread-card-active')
    expect(cards[1]).toHaveClass('thread-card-collapsed')
  })

  it('AC2 scenario 4: header button title is "Collapse" when expanded, "Expand" when collapsed', () => {
    const mails = [makeMail(1), makeMail(2)]
    const thread = makeThread(mails)
    const { container } = render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { renderBody: () => null }),
      ),
    )
    const headers = container.querySelectorAll('.thread-card-header')
    const expandedHeader = Array.from(headers).find(h => h.getAttribute('aria-expanded') === 'true')!
    const collapsedHeader = Array.from(headers).find(h => h.getAttribute('aria-expanded') === 'false')!
    expect(expandedHeader.getAttribute('title')).toBe('Collapse')
    expect(collapsedHeader.getAttribute('title')).toBe('Expand')
  })

  it('useConversationOrder: settings:get returning oldest-top flips card order', async () => {
    const mails = [makeMail(1), makeMail(2), makeMail(3)]
    const thread = makeThread(mails)
    const props: React.ComponentProps<typeof ThreadView> = {
      thread,
      activeKey: '1:INBOX:3',
      onCardOpen: vi.fn(),
      renderBody: () => null,
      gravatarEnabled: false,
    }
    render(React.createElement(ThreadView, props))
    const { waitFor } = await import('@testing-library/react')
    await waitFor(() => {
      const avatars = screen.getAllByTestId('mail-avatar')
      expect(avatars[0].textContent).toBe('Sender 1')
    })
    const avatars = screen.getAllByTestId('mail-avatar')
    expect(avatars[2].textContent).toBe('Sender 3')
  })

  it('useConversationOrder: settings:changed event updates card order at runtime', async () => {
    mockInvoke.mockResolvedValue({ conversationOrder: 'newest-top' })
    const mails = [makeMail(1), makeMail(2), makeMail(3)]
    const thread = makeThread(mails)
    const props: React.ComponentProps<typeof ThreadView> = {
      thread,
      activeKey: '1:INBOX:3',
      onCardOpen: vi.fn(),
      renderBody: () => null,
      gravatarEnabled: false,
    }
    render(React.createElement(ThreadView, props))
    const { waitFor, act: rtlAct } = await import('@testing-library/react')
    await waitFor(() => {
      const avatars = screen.getAllByTestId('mail-avatar')
      expect(avatars[0].textContent).toBe('Sender 3')
    })
    expect(mockOn).toHaveBeenCalledWith('settings:changed', expect.any(Function))
    const listener = mockOn.mock.calls.find(([ch]) => ch === 'settings:changed')?.[1] as (
      s: unknown,
    ) => void
    expect(listener).toBeDefined()
    await rtlAct(async () => {
      listener({ conversationOrder: 'oldest-top' })
    })
    await waitFor(() => {
      const avatars = screen.getAllByTestId('mail-avatar')
      expect(avatars[0].textContent).toBe('Sender 1')
    })
  })

  it('shows matchSnippet text when present on a collapsed card', () => {
    const mails = [
      makeMail(1, { matchSnippet: 'relevant excerpt here' }),
      makeMail(2),
    ]
    const thread = makeThread(mails)
    render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { renderBody: () => null }),
      ),
    )
    expect(screen.getByText('relevant excerpt here')).toBeInTheDocument()
  })

  it('falls back to subject when matchSnippet is empty string', () => {
    const mails = [
      makeMail(1, { matchSnippet: '', subject: 'Fallback subject' }),
      makeMail(2),
    ]
    const thread = makeThread(mails)
    render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { renderBody: () => null }),
      ),
    )
    expect(screen.getByText('Fallback subject')).toBeInTheDocument()
  })

  it('uses mail.thread.snippetEmpty i18n key when matchSnippet and subject are both empty', () => {
    const mails = [
      makeMail(1, { matchSnippet: '', subject: '' }),
      makeMail(2),
    ]
    const thread = makeThread(mails)
    render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { renderBody: () => null }),
      ),
    )
    expect(screen.getByText('(no preview)')).toBeInTheDocument()
  })

  it('uses mail.thread.snippetEmpty i18n key when matchSnippet is null and subject is empty', () => {
    const mails = [
      makeMail(1, { matchSnippet: null, subject: '' }),
      makeMail(2),
    ]
    const thread = makeThread(mails)
    render(
      React.createElement(
        ThreadView,
        defaultProps(thread, '1:INBOX:2', { renderBody: () => null }),
      ),
    )
    expect(screen.getByText('(no preview)')).toBeInTheDocument()
  })

  it('renders empty container without crash when thread has zero items', () => {
    // Defense-in-depth guard: App.tsx currently only renders ThreadView when
    // activeThread.count > 1, so an empty thread does not reach it in normal
    // flow. This test ensures a future caller change does not silently crash
    // the component. useThreadCards returns [] for empty items, so zero
    // thread-card elements are expected.
    const lead = makeMail(1)
    const thread: ThreadRow = { key: '1:INBOX:1', lead, items: [], count: 0 }
    render(
      React.createElement(
        ThreadView,
        defaultProps(thread, null, { order: 'oldest-top' }),
      ),
    )
    expect(screen.getByTestId('thread-view')).toBeInTheDocument()
    expect(screen.queryAllByTestId('thread-card')).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // §3.3 B2 Thread AI Summary strip
  // -------------------------------------------------------------------------
  describe('summary strip (B2)', () => {
    function makeSummaryPayload() {
      return {
        threadHash: 'h1',
        oneLine: 'The team agreed to ship on Friday.',
        bullets: ['point one', 'point two', 'point three', 'point four', 'point five'],
        provider: 'anthropic-api',
        cached: true,
        wasLocal: false,
        createdAt: 1_700_000_000_000,
      }
    }

    it('passes accountId, messages, enabled and threadKey to the hook', () => {
      const mails = [makeMail(1), makeMail(2), makeMail(3)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '1:INBOX:3', { renderBody: () => null, summaryEnabled: true }),
        ),
      )
      expect(mockUseThreadSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: 1,
          enabled: true,
          threadKey: thread.key,
          messages: mails,
        }),
      )
    })

    it('defaults summaryEnabled to false when the prop is omitted', () => {
      const mails = [makeMail(1), makeMail(2), makeMail(3)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '1:INBOX:3', { renderBody: () => null }),
        ),
      )
      expect(mockUseThreadSummary).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      )
    })

    it('does NOT render the strip when the hook reports inactive (toggle OFF / <3 msgs)', () => {
      mockUseThreadSummary.mockReturnValue(summaryState({ active: false }))
      const mails = [makeMail(1), makeMail(2), makeMail(3)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '1:INBOX:3', { renderBody: () => null }),
        ),
      )
      expect(screen.queryByTestId('thread-summary-strip')).not.toBeInTheDocument()
    })

    it('shows the loading affordance while summarizing', () => {
      mockUseThreadSummary.mockReturnValue(summaryState({ active: true, status: 'loading' }))
      const mails = [makeMail(1), makeMail(2), makeMail(3)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '1:INBOX:3', { renderBody: () => null, summaryEnabled: true }),
        ),
      )
      expect(screen.getByTestId('thread-summary-strip')).toBeInTheDocument()
      expect(screen.getByTestId('thread-summary-loading')).toBeInTheDocument()
      expect(screen.getByText('Summarizing thread…')).toBeInTheDocument()
    })

    it('clicking the one-line summary expands to 5 bullets and collapses again', () => {
      mockUseThreadSummary.mockReturnValue(
        summaryState({ active: true, status: 'ready', summary: makeSummaryPayload() }),
      )
      const mails = [makeMail(1), makeMail(2), makeMail(3)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '1:INBOX:3', { renderBody: () => null, summaryEnabled: true }),
        ),
      )
      const oneLine = screen.getByTestId('thread-summary-oneline')
      expect(oneLine).toHaveTextContent('The team agreed to ship on Friday.')
      // The one-line IS the disclosure control: a button, collapsed by default.
      expect(oneLine.tagName).toBe('BUTTON')
      expect(oneLine).toHaveAttribute('aria-expanded', 'false')
      // Bullets hidden until the one-line is clicked.
      expect(screen.queryByTestId('thread-summary-bullets')).not.toBeInTheDocument()
      fireEvent.click(oneLine)
      expect(oneLine).toHaveAttribute('aria-expanded', 'true')
      const bullets = screen.getByTestId('thread-summary-bullets')
      expect(bullets.querySelectorAll('li')).toHaveLength(5)
      // Clicking again collapses.
      fireEvent.click(oneLine)
      expect(oneLine).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByTestId('thread-summary-bullets')).not.toBeInTheDocument()
    })

    it('budget refusal shows a localized inline message, not a crash', () => {
      mockUseThreadSummary.mockReturnValue(
        summaryState({ active: true, status: 'refused', refusal: 'budget' }),
      )
      const mails = [makeMail(1), makeMail(2), makeMail(3)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '1:INBOX:3', { renderBody: () => null, summaryEnabled: true }),
        ),
      )
      expect(screen.getByTestId('thread-summary-refusal')).toBeInTheDocument()
      expect(
        screen.getByText('Daily AI budget reached — summary paused until it resets.'),
      ).toBeInTheDocument()
      // No retry button for budget (only provider_error offers retry).
      expect(screen.queryByTestId('thread-summary-retry')).not.toBeInTheDocument()
    })

    it('no_provider refusal shows the configure-provider hint', () => {
      mockUseThreadSummary.mockReturnValue(
        summaryState({ active: true, status: 'refused', refusal: 'no_provider' }),
      )
      const mails = [makeMail(1), makeMail(2), makeMail(3)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '1:INBOX:3', { renderBody: () => null, summaryEnabled: true }),
        ),
      )
      expect(
        screen.getByText('Configure an AI provider in Settings to summarize threads.'),
      ).toBeInTheDocument()
    })

    it('provider_error refusal shows a retry affordance that calls retry()', () => {
      const retry = vi.fn()
      mockUseThreadSummary.mockReturnValue(
        summaryState({ active: true, status: 'refused', refusal: 'provider_error', retry }),
      )
      const mails = [makeMail(1), makeMail(2), makeMail(3)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '1:INBOX:3', { renderBody: () => null, summaryEnabled: true }),
        ),
      )
      expect(
        screen.getByText("Couldn't summarize this thread right now."),
      ).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('thread-summary-retry'))
      expect(retry).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // §3.3 B4 Instant Reply strip
  // -------------------------------------------------------------------------
  describe('instant reply strip (B4)', () => {
    it('does NOT render the strip when instantReplyEnabled is false (default)', () => {
      const mails = [makeMail(1)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '1:INBOX:1', { renderBody: () => null }),
        ),
      )
      expect(screen.queryByTestId('instant-reply-strip')).not.toBeInTheDocument()
    })

    it('renders the strip on the actively-open card when instantReplyEnabled is true', () => {
      const mails = [makeMail(1)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '1:INBOX:1', { renderBody: () => null, instantReplyEnabled: true }),
        ),
      )
      expect(screen.getByTestId('instant-reply-strip')).toBeInTheDocument()
      expect(screen.getByTestId('instant-reply-trigger')).toBeInTheDocument()
    })

    it('does NOT render the strip on a collapsed (inactive) card even when instantReplyEnabled is true', () => {
      const mails = [makeMail(1), makeMail(2)]
      const thread = makeThread(mails)
      render(
        React.createElement(
          ThreadView,
          // Active card is uid 2; uid 1's card stays collapsed and must not
          // mount the strip (it attaches to the actively-open card only).
          defaultProps(thread, '1:INBOX:2', { renderBody: () => null, instantReplyEnabled: true }),
        ),
      )
      expect(screen.getAllByTestId('instant-reply-strip')).toHaveLength(1)
    })

    it('clicking the trigger fires window.api.invoke(ai:instantReply:generate) with the active card ref — never with body text', async () => {
      const mails = [makeMail(1, { accountId: 5, folder: 'Archive', uid: 77, messageId: '<real@x>' })]
      const thread = makeThread(mails)
      // `order` is passed as an override below, so useConversationOrder never
      // calls settings:get — the only invoke() call this test drives is the
      // instant-reply generate.
      mockInvoke.mockResolvedValue({ ok: true, drafts: [{ text: 'Sounds good.' }, { text: 'Let me check.' }] })
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '5:Archive:77', { renderBody: () => null, instantReplyEnabled: true, order: 'oldest-top' }),
        ),
      )
      fireEvent.click(screen.getByTestId('instant-reply-trigger'))
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('ai:instantReply:generate', {
          accountId: 5,
          folder: 'Archive',
          uid: 77,
          messageId: '<real@x>',
        })
      })
      // The IPC payload never contains a body/text field — only the ref.
      const call = mockInvoke.mock.calls.find(c => c[0] === 'ai:instantReply:generate')
      expect(Object.keys(call![1] as object).sort()).toEqual(['accountId', 'folder', 'messageId', 'uid'])
    })

    it('picking a draft calls onInstantReplyPick with the message ref and the chosen draft — never sends anything itself', async () => {
      const mails = [makeMail(1, { accountId: 5, folder: 'INBOX', uid: 77 })]
      const thread = makeThread(mails)
      // `order` is passed as an override below (see note above).
      mockInvoke.mockResolvedValue({ ok: true, drafts: [{ text: 'Sounds good.' }] })
      const onInstantReplyPick = vi.fn()
      render(
        React.createElement(
          ThreadView,
          defaultProps(thread, '5:INBOX:77', {
            renderBody: () => null,
            instantReplyEnabled: true,
            order: 'oldest-top',
            onInstantReplyPick,
          }),
        ),
      )
      fireEvent.click(screen.getByTestId('instant-reply-trigger'))
      await waitFor(() => expect(screen.getByTestId('instant-reply-options')).toBeInTheDocument())
      fireEvent.click(screen.getAllByTestId('instant-reply-option')[0])
      expect(onInstantReplyPick).toHaveBeenCalledWith(
        { accountId: 5, folder: 'INBOX', uid: 77 },
        { text: 'Sounds good.' },
      )
      // Only the picker callback fired — ThreadView never invokes a send channel.
      expect(mockInvoke).not.toHaveBeenCalledWith('net:sendMail', expect.anything())
      expect(mockInvoke).not.toHaveBeenCalledWith('smtp:send', expect.anything())
    })
  })
})
