/**
 * Markdown of an assistant answer, with `mailref://` links judged against the citation tickets main issued in this
 * session (§3.3 B3). A link whose ticket the session does not know (the model composed or miscopied it) renders as
 * plain text with an "unconfirmed" mark: it is not a button, not an anchor and does not look like one.
 */
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Component, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import { answerMarkdownProps, prepareAnswerMarkdown } from '../utils/answerMarkdown'
import { captureException } from '../sentry'
import { judgeMailref, type CitationStatus } from '../utils/aiSourceVerdict'

export interface AiAnswerMarkdownProps {
  content: string
  /** What main said about the tickets of this session's answers, by ticket. */
  citations: ReadonlyMap<string, CitationStatus>
  /** The answer is still being generated. */
  streaming: boolean
  /** Loaded from a session saved before citation tickets: its place links stay clickable, unflagged. */
  legacyLinks?: boolean
  /** A citation link opens the message its ticket names (main finds it by Message-ID). */
  onOpenCitation?: (token: string) => void | Promise<void>
  /** An old answer's place link opens that place, as it always did. */
  onOpenSource?: (ref: { accountId: number; folder: string; uid: number }) => void | Promise<void>
}

/**
 * A failure while an answer is drawn (a parser bug, a pathological shape the bounds did not foresee) must never take the
 * panel, let alone the app, down: that one answer falls back to its plain text. It is reported without the text.
 */
export class AnswerMarkdownBoundary extends Component<
  { text: string; resetKey: string; children: ReactNode },
  { failed: boolean; key: string }
> {
  state = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null
  }

  componentDidCatch(error: unknown): void {
    captureException(new Error(`answer markdown failed: ${error instanceof Error ? error.name : 'error'}`), { source: 'ai.answer_markdown' })
  }

  render(): ReactNode {
    return this.state.failed ? <div className="ai-answer-plain">{this.props.text}</div> : this.props.children
  }
}

export default function AiAnswerMarkdown({ content, citations, streaming, legacyLinks = false, onOpenCitation, onOpenSource }: AiAnswerMarkdownProps) {
  const { t } = useTranslation()
  const prepared = useMemo(() => prepareAnswerMarkdown(content), [content])
  // The callbacks are read through refs: the panel passes fresh closures on every render (each keystroke in the input),
  // and a changed `components` would re-parse every answer on screen.
  const onOpenCitationRef = useRef(onOpenCitation)
  const onOpenSourceRef = useRef(onOpenSource)
  onOpenCitationRef.current = onOpenCitation
  onOpenSourceRef.current = onOpenSource
  const components = useMemo(() => ({
    ...answerMarkdownProps.components,
    a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
      if (href?.startsWith('mailref://')) {
        const verdict = judgeMailref(href, { citations, streaming, legacyLinks })
        switch (verdict.kind) {
          case 'citation':
            return (
              <button type="button" className="ai-inline-mail-link" onClick={() => { void onOpenCitationRef.current?.(verdict.token) }}>
                {children}
              </button>
            )
          case 'legacy':
            return (
              <button type="button" className="ai-inline-mail-link" onClick={() => { void onOpenSourceRef.current?.(verdict.target) }}>
                {children}
              </button>
            )
          case 'pending':
            return <span className="ai-inline-mail-pending">{children}</span>
          case 'unconfirmed':
            return (
              <span
                className="ai-inline-mail-unconfirmed"
                data-testid="ai-inline-mail-unconfirmed"
                title={t('ai.panel.sourceUnconfirmedTooltip')}
              >
                {children}
                <span className="ai-unconfirmed-mark">{t('ai.panel.sourceUnconfirmed')}</span>
              </span>
            )
          default:
            // Malformed reference: show its text, never a link.
            return <span>{children}</span>
        }
      }
      return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    },
  }), [citations, streaming, legacyLinks, t])

  // The parse runs while React renders the element, so the element is memoised: a render that changes neither the text nor
  // the judgement inputs (typing in the chat input, a sibling answer streaming) hands React the SAME element and the
  // answer is not parsed again.
  const rendered = useMemo(() => (
    prepared.kind === 'plain' ? null : (
      <AnswerMarkdownBoundary text={content} resetKey={content}>
        <ReactMarkdown {...answerMarkdownProps} components={components}>
          {prepared.text}
        </ReactMarkdown>
      </AnswerMarkdownBoundary>
    )
  ), [prepared, content, components])
  // Beyond a bound the answer is plain text (see `prepareAnswerMarkdown`): no markdown, no links.
  if (prepared.kind === 'plain') return <div className="ai-answer-plain">{prepared.text}</div>
  return rendered
}
