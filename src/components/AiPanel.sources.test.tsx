// @vitest-environment jsdom
/**
 * AiPanel with the REAL markdown renderer: the panel's judgement of `mailref://` links in an answer
 * (§3.3 B3): a link is a source only if main says its citation ticket is registered for this chat.
 * `AiPanel.test.tsx` mocks react-markdown into a plain div, which cannot show whether a link is
 * clickable, so the link-level behaviour lives here.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

const i18nMap: Record<string, string> = {
  'ai.panel.send': 'Send',
  'ai.panel.stop': 'Stop',
  'ai.panel.sources': 'Sources',
  'ai.panel.sourcesShowAll': 'All sources ({{count}})',
  'ai.panel.sourcesCollapse': 'Collapse',
  'ai.panel.sourceUnconfirmed': 'unconfirmed',
  'ai.panel.sourceNotFound': 'message not found',
  'ai.panel.sourceUnconfirmedTooltip': 'The assistant did not receive this message',
  'ai.sessions.history': 'History',
}
const stableT = (key: string, opts?: Record<string, unknown>) =>
  (i18nMap[key] ?? key).replace('{{count}}', String(opts?.count))
const stableUseTranslation = { t: stableT, i18n: { exists: () => false } }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

const mockInvoke = vi.fn()
const mockOn = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: mockInvoke, on: mockOn, off: vi.fn(), removeAll: vi.fn() },
  writable: true,
  configurable: true,
})

import AiPanel from './AiPanel'
import type { AiPanelProps } from './AiPanel'
import { __resetForTests as resetSingleFlight } from '../utils/ipcSingleFlight'

const KNOWN = 'aaaaaaaa'
const UNKNOWN = 'bbbbbbbb'
const GONE = 'cccccccc'
const LINK_OPEN = `[the invoice](mailref://c/${KNOWN})`
const LINK_OTHER = `[the contract](mailref://c/${UNKNOWN})`
const LINK_GONE = `[the old mail](mailref://c/${GONE})`
const PLACE_LINK = '[the invoice](mailref://1/INBOX/101)'

/** What main says about the tickets of the test chat: one is a source, one is not, one is a source whose message is gone. */
const resolveReply = (tokens: string[]) => tokens.map(token => (
  token.startsWith('many') ? { token, status: 'found', subject: `Mail ${token}`, from: 'x@example.test', date: 'd' }
  : token === KNOWN ? { token, status: 'found', subject: 'Invoice 101', from: 'anna@example.test', date: 'd' }
    : token === GONE ? { token, status: 'missing' }
      : { token, status: 'unknown' }
))

function renderPanel(props: Partial<AiPanelProps> = {}) {
  const defaults: AiPanelProps = {
    open: true,
    onClose: vi.fn(),
    contextType: null,
    contextData: null,
    aiProvider: 'anthropic-api',
    aiPrivacyConsent: true,
    aiSendOnEnter: true,
    onSettingsChange: vi.fn(),
    ...props,
  }
  return render(React.createElement(AiPanel, defaults))
}

const streamHandler = (): ((event: Record<string, unknown>) => void) => {
  const call = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'ai:stream')
  if (!call) throw new Error('ai:stream handler not found')
  return call[1] as (event: Record<string, unknown>) => void
}

async function ask(text: string): Promise<string> {
  await act(async () => { fireEvent.change(screen.getByTestId('ai-input'), { target: { value: text } }) })
  await act(async () => { fireEvent.click(screen.getByTitle('Send')) })
  const ids = mockInvoke.mock.calls.filter(c => c[0] === 'ai:chat').map(c => c[1] as string)
  return ids[ids.length - 1]!
}

const emit = (event: Record<string, unknown>) => act(async () => { streamHandler()(event) })

describe('AiPanel — judging mailref links in an answer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSingleFlight()
    Element.prototype.scrollIntoView = vi.fn()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('test-session-uuid' as `${string}-${string}-${string}-${string}-${string}`)
    mockInvoke.mockImplementation((channel: string, arg?: { tokens?: string[] }) => {
      if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
      if (channel === 'aiSession:list') return Promise.resolve([])
      if (channel === 'aiSession:create') return Promise.resolve({ id: 'test-session-uuid', title: '', provider: 'anthropic-api' })
      if (channel === 'aiSession:addMessage') return Promise.resolve({ id: 1 })
      if (channel === 'aiSession:messages') return Promise.resolve([])
      if (channel === 'ai:resolveCitations') return Promise.resolve(resolveReply(arg?.tokens ?? []))
      return Promise.resolve()
    })
  })

  afterEach(() => { cleanup() })

  it('after the result: a link whose ticket main knows is a button that opens its message, an unknown ticket is not clickable', async () => {
    const onOpenCitation = vi.fn()
    await act(async () => { renderPanel({ aiShowSources: true, onOpenCitation }) })
    const requestId = await ask('Find')
    await emit({ type: 'text_delta', requestId, text: `${LINK_OPEN} and ${LINK_OTHER}` })
    await emit({ type: 'result', requestId, text: `${LINK_OPEN} and ${LINK_OTHER}`, sessionId: 'sid' })

    expect(mockInvoke).toHaveBeenCalledWith('ai:resolveCitations', { sessionId: 'test-session-uuid', tokens: [KNOWN, UNKNOWN] })
    const inline = document.querySelector('.ai-message-content .ai-inline-mail-link') as HTMLElement
    expect(inline).toHaveTextContent('the invoice')
    fireEvent.click(inline)
    expect(onOpenCitation).toHaveBeenCalledWith('test-session-uuid', KNOWN)

    expect(document.querySelectorAll('.ai-inline-mail-link')).toHaveLength(1)
    const flagged = screen.getByTestId('ai-inline-mail-unconfirmed')
    expect(flagged).toHaveTextContent('the contract')
    expect(flagged).toHaveTextContent('unconfirmed')
    expect(screen.queryByRole('button', { name: 'the contract' })).toBeNull()
  })

  it('lists under Sources only the tickets main knows, with the caption main gives', async () => {
    const onOpenCitation = vi.fn()
    await act(async () => { renderPanel({ aiShowSources: true, onOpenCitation }) })
    const requestId = await ask('Find')
    await emit({ type: 'text_delta', requestId, text: `${LINK_OPEN} and ${LINK_OTHER}` })
    await emit({ type: 'result', requestId, text: `${LINK_OPEN} and ${LINK_OTHER}`, sessionId: 'sid' })
    const listed = document.querySelectorAll('.ai-sources .ai-source-link')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toHaveTextContent('Invoice 101')
    expect(listed[0]).toHaveTextContent('anna@example.test')
    expect(screen.getByText('Sources')).toBeInTheDocument()
    fireEvent.click(listed[0] as HTMLElement)
    expect(onOpenCitation).toHaveBeenCalledWith('test-session-uuid', KNOWN)
  })

  it('collapses a long source list under the answer and expands it on demand', async () => {
    await act(async () => { renderPanel({ aiShowSources: true }) })
    const requestId = await ask('Find')
    const text = ['manyaaaa', 'manyaaab', 'manyaaac', 'manyaaad', 'manyaaae']
      .map(t => `[m](mailref://c/${t})`).join(' ')
    await emit({ type: 'text_delta', requestId, text })
    await emit({ type: 'result', requestId, text, sessionId: 'sid' })
    expect(document.querySelectorAll('.ai-sources .ai-source-link')).toHaveLength(3)
    fireEvent.click(screen.getByTestId('ai-sources-toggle'))
    expect(document.querySelectorAll('.ai-sources .ai-source-link')).toHaveLength(5)
  })

  it('a source whose message is gone says "message not found", with no subject, sender or number', async () => {
    await act(async () => { renderPanel({ aiShowSources: true }) })
    const requestId = await ask('Find')
    await emit({ type: 'text_delta', requestId, text: LINK_GONE })
    await emit({ type: 'result', requestId, text: LINK_GONE, sessionId: 'sid' })
    const button = document.querySelector('.ai-sources .ai-source-link') as HTMLElement
    expect(button).toHaveTextContent('message not found')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button.textContent).not.toMatch(/account\s*\d|\b1\/INBOX/i)
  })

  it('an answer that links nothing has no Sources list and asks main nothing', async () => {
    await act(async () => { renderPanel({ aiShowSources: true }) })
    const requestId = await ask('Find')
    await emit({ type: 'text_delta', requestId, text: 'no links here' })
    await emit({ type: 'result', requestId, text: 'no links here', sessionId: 'sid' })
    expect(document.querySelector('.ai-sources')).toBeNull()
    expect(mockInvoke.mock.calls.some(c => c[0] === 'ai:resolveCitations')).toBe(false)
  })

  it('a place link the model composed itself is never a source in an answer written with tickets', async () => {
    await act(async () => { renderPanel({ aiShowSources: true }) })
    const requestId = await ask('Find')
    await emit({ type: 'text_delta', requestId, text: PLACE_LINK })
    await emit({ type: 'result', requestId, text: PLACE_LINK, sessionId: 'sid' })
    expect(document.querySelector('.ai-inline-mail-link')).toBeNull()
    expect(screen.getByTestId('ai-inline-mail-unconfirmed')).toBeInTheDocument()
    expect(document.querySelector('.ai-sources')).toBeNull()
  })

  it('a link is plain text while the answer is still streaming, and main is not asked yet', async () => {
    await act(async () => { renderPanel() })
    const requestId = await ask('Find')
    await emit({ type: 'text_delta', requestId, text: `See ${LINK_OPEN}` })
    expect(document.querySelector('.ai-inline-mail-link')).toBeNull()
    expect(screen.queryByTestId('ai-inline-mail-unconfirmed')).toBeNull()
    expect(document.querySelector('.ai-inline-mail-pending')).toHaveTextContent('the invoice')
    expect(mockInvoke.mock.calls.some(c => c[0] === 'ai:resolveCitations')).toBe(false)
  })

  it('a stopped answer judges its tickets like any other: a ticket main issued is a source, an unknown one is not', async () => {
    await act(async () => { renderPanel() })
    const requestId = await ask('Find')
    await emit({ type: 'text_delta', requestId, text: `Partial: ${LINK_OPEN} ${LINK_OTHER}` })
    await act(async () => { fireEvent.click(screen.getByTitle('Stop')) })
    expect(mockInvoke).toHaveBeenCalledWith('ai:stop', requestId)
    expect(screen.getByRole('button', { name: 'the invoice' })).toBeInTheDocument()
    expect(screen.getByTestId('ai-inline-mail-unconfirmed')).toHaveTextContent('the contract')
  })

  it('aiShowSources=false hides the Sources list but not the unconfirmed marks', async () => {
    await act(async () => { renderPanel({ aiShowSources: false }) })
    const requestId = await ask('Find')
    await emit({ type: 'text_delta', requestId, text: `${LINK_OPEN} and ${LINK_OTHER}` })
    await emit({ type: 'result', requestId, text: `${LINK_OPEN} and ${LINK_OTHER}`, sessionId: 'sid' })
    expect(document.querySelector('.ai-sources')).toBeNull()
    expect(screen.getByTestId('ai-inline-mail-unconfirmed')).toHaveTextContent('the contract')
    expect(document.querySelectorAll('.ai-inline-mail-link')).toHaveLength(1)
  })

  it('while main has not answered yet, a ticket is neither a source nor flagged', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'ai:resolveCitations') return new Promise(() => {})
      if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
      if (channel === 'aiSession:create') return Promise.resolve({ id: 'test-session-uuid', title: '', provider: 'anthropic-api' })
      return Promise.resolve([])
    })
    await act(async () => { renderPanel({ aiShowSources: true }) })
    const requestId = await ask('Find')
    await emit({ type: 'result', requestId, text: LINK_OPEN, sessionId: 'sid' })
    expect(document.querySelector('.ai-inline-mail-link')).toBeNull()
    expect(screen.queryByTestId('ai-inline-mail-unconfirmed')).toBeNull()
    expect(document.querySelector('.ai-sources')).toBeNull()
  })

  it('every new answer is stored without any statement about its sources (main marks it)', async () => {
    await act(async () => { renderPanel() })
    const requestId = await ask('Find')
    await emit({ type: 'result', requestId, text: LINK_OPEN, sessionId: 'sid', costUsd: 0.01 })
    const stored = mockInvoke.mock.calls.filter(c => c[0] === 'aiSession:addMessage' && (c[1] as { role: string }).role === 'assistant')
    expect(stored).toHaveLength(1)
    expect(Object.keys(stored[0]![1] as object).sort()).toEqual(['content', 'costUsd', 'role', 'sessionId'])
  })

  describe('a result belongs to the request that produced it', () => {
    it('a late result of a request from an earlier chat (stopped by opening a new chat) reaches nobody in the new chat', async () => {
      const uuid = vi.spyOn(crypto, 'randomUUID')
      uuid.mockReturnValueOnce('session-one' as `${string}-${string}-${string}-${string}-${string}`)
        .mockReturnValueOnce('session-two' as `${string}-${string}-${string}-${string}-${string}`)
      await act(async () => { renderPanel({ aiShowSources: true }) })
      const first = await ask('first question')
      // The user starts a new chat while the first request is still running (which stops it), then asks again.
      await act(async () => { fireEvent.click(screen.getByTitle('ai.panel.newChat')) })
      expect(mockInvoke).toHaveBeenCalledWith('ai:stop', first)
      const second = await ask('second question')
      expect(second).not.toBe(first)
      await emit({ type: 'text_delta', requestId: second, text: `Second answer ${LINK_OTHER}` })

      // A result of the FIRST request still arrives (it was already on its way).
      await emit({ type: 'result', requestId: first, text: `First answer ${LINK_OPEN}`, sessionId: 'sid', costUsd: 0.5 })

      // Nothing of it reaches the second answer: no Sources list, no clickable link, no cost badge, and the
      // second request is still running: another request's result did not end it.
      expect(document.querySelector('.ai-sources')).toBeNull()
      expect(document.querySelector('.ai-inline-mail-link')).toBeNull()
      expect(document.querySelector('.ai-cost-badge')).toBeNull()
      expect(screen.getByTitle('Stop')).toBeInTheDocument()
      expect(mockInvoke).not.toHaveBeenCalledWith('aiSession:addMessage', expect.objectContaining({ role: 'assistant', content: 'First answer ' + LINK_OPEN }))

      // The second request's own result then judges ITS links: its ticket is not one main knows.
      await emit({ type: 'result', requestId: second, text: `Second answer ${LINK_OTHER}`, sessionId: 'sid' })
      expect(document.querySelector('.ai-inline-mail-link')).toBeNull()
      expect(screen.getByTestId('ai-inline-mail-unconfirmed')).toBeInTheDocument()
      expect(mockInvoke).toHaveBeenCalledWith('aiSession:addMessage', expect.objectContaining({ sessionId: 'session-two', role: 'assistant' }))
    })

    it('a result for a request this panel never started is ignored altogether', async () => {
      await act(async () => { renderPanel({ aiShowSources: true }) })
      const requestId = await ask('Find')
      await emit({ type: 'text_delta', requestId, text: `Answer ${LINK_OPEN}` })
      await emit({ type: 'result', requestId: 'someone-elses-request', text: 'x', sessionId: 'sid' })
      expect(document.querySelector('.ai-sources')).toBeNull()
      expect(screen.getByTitle('Stop')).toBeInTheDocument()
      expect(mockInvoke).not.toHaveBeenCalledWith('aiSession:addMessage', expect.objectContaining({ content: 'x' }))
    })
  })

  describe('every stream event belongs to the request that produced it', () => {
    const FAKE = '[forged](mailref://c/dddddddd)'

    it('a request still waiting for its session writes when the user opens another chat is never sent, and cannot touch that chat', async () => {
      let releaseUserWrite: () => void = () => {}
      const userWrite = new Promise<void>(resolve => { releaseUserWrite = resolve })
      mockInvoke.mockImplementation((channel: string, arg?: { role?: string }) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([{ id: 'saved', title: 'Saved chat', updatedAt: Date.now(), provider: 'anthropic-api' }])
        if (channel === 'aiSession:create') return Promise.resolve({ id: 'test-session-uuid' })
        if (channel === 'aiSession:addMessage' && arg?.role === 'user') return userWrite
        if (channel === 'aiSession:messages') {
          return Promise.resolve([
            { role: 'user', content: 'old question', costUsd: null, citationVersion: null },
            { role: 'assistant', content: 'Old answer, saved before verdicts existed.', costUsd: null, citationVersion: null },
          ])
        }
        return Promise.resolve()
      })
      await act(async () => { renderPanel({ aiShowSources: true }) })
      // Ask A: its first session write has not finished, so main has not been asked anything yet.
      await act(async () => { fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'new question' } }) })
      await act(async () => { fireEvent.click(screen.getByTitle('Send')) })
      expect(mockInvoke.mock.calls.some(c => c[0] === 'ai:chat')).toBe(false)

      // Meanwhile the user opens the saved chat B.
      await act(async () => { fireEvent.click(screen.getByTitle('History')) })
      await act(async () => { fireEvent.click(screen.getByText('Saved chat')) })
      expect(screen.getByText('Old answer, saved before verdicts existed.')).toBeInTheDocument()

      // The write finishes. A must not be sent now: its chat is no longer the one on screen.
      await act(async () => { releaseUserWrite() })
      expect(mockInvoke.mock.calls.some(c => c[0] === 'ai:chat')).toBe(false)

      // Even if a stream event of that request did arrive, it belongs to nothing on screen.
      await emit({ type: 'text_delta', requestId: 'ai-whatever', text: `Hijacked ${FAKE}` })
      expect(screen.getByText('Old answer, saved before verdicts existed.')).toBeInTheDocument()
      expect(document.querySelector('.ai-inline-mail-link')).toBeNull()
      expect(screen.queryByText(/Hijacked/)).toBeNull()
    })

    it('events of a request this panel never started change nothing: text, status, error and notice', async () => {
      await act(async () => { renderPanel() })
      const mine = await ask('Find')
      await emit({ type: 'text_delta', requestId: mine, text: 'My answer' })
      await emit({ type: 'text_delta', requestId: 'someone-elses', text: ' HIJACK' })
      await emit({ type: 'status', requestId: 'someone-elses', status: 'done' })
      await emit({ type: 'error', requestId: 'someone-elses', message: 'boom' })
      await emit({ type: 'notice', requestId: 'someone-elses', code: 'request_budget_exceeded', message: 'x' })
      expect(screen.getByText('My answer')).toBeInTheDocument()
      expect(screen.queryByText(/HIJACK|boom/)).toBeNull()
      // my request is still the one running: a stranger's `done` did not end it
      expect(screen.getByTitle('Stop')).toBeInTheDocument()
    })

    it('the text of a request in an earlier chat is not added to the answer on screen', async () => {
      const uuid = vi.spyOn(crypto, 'randomUUID')
      uuid.mockReturnValueOnce('s1' as `${string}-${string}-${string}-${string}-${string}`).mockReturnValueOnce('s2' as `${string}-${string}-${string}-${string}-${string}`)
      await act(async () => { renderPanel() })
      const first = await ask('first')
      await act(async () => { fireEvent.click(screen.getByTitle('ai.panel.newChat')) })
      const second = await ask('second')
      await emit({ type: 'text_delta', requestId: second, text: 'Second answer' })
      await emit({ type: 'text_delta', requestId: first, text: ' from the first chat' })
      expect(screen.getByText('Second answer')).toBeInTheDocument()
      expect(screen.queryByText(/from the first chat/)).toBeNull()
    })
  })

  describe('answers loaded from a saved session', () => {
    async function openSavedSession(rows: Array<Record<string, unknown>>, props: Partial<AiPanelProps> = {}) {
      mockInvoke.mockImplementation((channel: string, arg?: { tokens?: string[] }) => {
        if (channel === 'ai:checkAuth') return Promise.resolve({ status: 'authenticated' })
        if (channel === 'aiSession:list') return Promise.resolve([{ id: 'saved', title: 'Saved chat', updatedAt: Date.now(), provider: 'anthropic-api' }])
        if (channel === 'aiSession:messages') return Promise.resolve(rows)
        if (channel === 'ai:resolveCitations') return Promise.resolve(resolveReply(arg?.tokens ?? []))
        return Promise.resolve()
      })
      await act(async () => { renderPanel(props) })
      await act(async () => { fireEvent.click(screen.getByTitle('History')) })
      await act(async () => { fireEvent.click(screen.getByText('Saved chat')) })
    }

    it('an answer saved before citation tickets (no marker) keeps its place links working, unflagged, and asks main nothing', async () => {
      const onOpenSource = vi.fn()
      await openSavedSession([
        { role: 'user', content: 'q', costUsd: null, citationVersion: null },
        { role: 'assistant', content: `Old answer ${PLACE_LINK}`, costUsd: null, citationVersion: null },
      ], { onOpenSource })
      const button = screen.getByRole('button', { name: 'the invoice' })
      fireEvent.click(button)
      expect(onOpenSource).toHaveBeenCalledWith({ accountId: 1, folder: 'INBOX', uid: 101 })
      expect(screen.queryByTestId('ai-inline-mail-unconfirmed')).toBeNull()
      expect(mockInvoke.mock.calls.some(c => c[0] === 'ai:resolveCitations')).toBe(false)
    })

    it('an answer saved with tickets resolves them for ITS chat: a known one is clickable, a place link and an unknown ticket are flagged', async () => {
      const onOpenCitation = vi.fn()
      await openSavedSession([
        { role: 'user', content: 'q', costUsd: null, citationVersion: null },
        { role: 'assistant', content: `${LINK_OPEN} ${LINK_OTHER} [composed](mailref://1/INBOX/5)`, costUsd: null, citationVersion: 1 },
      ], { onOpenCitation, aiShowSources: true })
      expect(mockInvoke).toHaveBeenCalledWith('ai:resolveCitations', { sessionId: 'saved', tokens: [KNOWN, UNKNOWN] })
      fireEvent.click(screen.getByRole('button', { name: 'the invoice' }))
      expect(onOpenCitation).toHaveBeenCalledWith('saved', KNOWN)
      expect(screen.queryByRole('button', { name: 'the contract' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'composed' })).toBeNull()
      expect(screen.getAllByTestId('ai-inline-mail-unconfirmed')).toHaveLength(2)
    })
  })
})
