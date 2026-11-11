// @vitest-environment jsdom
/**
 * The tickets of an answer are the `href`s the markdown parser that DRAWS the answer gives its links (same plugins,
 * same url transform), not a second grammar of what a link looks like. The corpus below goes through both sides: the
 * tickets this module finds, and the buttons the real panel markdown draws once every ticket is known. They must be the
 * same set, so a link that is drawn can always be asked about and a link that is not drawn never is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

import AiAnswerMarkdown from '../components/AiAnswerMarkdown'
import { ANSWER_MAX_CHARS } from './answerMarkdown'
import { citationTokensOfAnswer } from './answerCitations'
import type { CitationStatus } from './aiSourceVerdict'

const A = 'k3f2x7ab'
const B = 'bbbbbbbb'

/** Every link form a model might write for a ticket, with the tickets that must come out of it. */
const CORPUS: Array<[string, string, string[]]> = [
  ['plain link', `[Invoice](mailref://c/${A})`, [A]],
  ['double-quoted title', `[Счёт](mailref://c/${A} "Счёт")`, [A]],
  ['single-quoted title', `[Invoice](mailref://c/${A} 'Invoice')`, [A]],
  ['parenthesised title', `[Invoice](mailref://c/${A} (Invoice))`, [A]],
  ['space before the closing parenthesis', `[Invoice](mailref://c/${A} )`, [A]],
  ['spaces after the opening parenthesis', `[Invoice]( mailref://c/${A})`, [A]],
  ['angle-bracket destination', `[Invoice](<mailref://c/${A}>)`, [A]],
  ['autolink', `see <mailref://c/${A}> now`, [A]],
  ['bare link', `look: mailref://c/${A}.`, [A]],
  ['reference-style link', `[Invoice][1]\n\n[1]: mailref://c/${A}`, [A]],
  ['link in a list and a quote', `- [one](mailref://c/${A})\n> [two](mailref://c/${B})`, [A, B]],
  ['link in bold', `**[Invoice](mailref://c/${A})**`, [A]],
  ['the same ticket twice', `[a](mailref://c/${A}) [b](mailref://c/${A})`, [A]],
  ['two tickets in order', `[b](mailref://c/${B}) [a](mailref://c/${A})`, [B, A]],
  ['inside inline code (not a link)', `\`[Invoice](mailref://c/${A})\``, []],
  ['inside a code block (not a link)', `\`\`\`\n[Invoice](mailref://c/${A})\n\`\`\``, []],
  ['an image (not a link)', `![Invoice](mailref://c/${A})`, []],
  ['escaped bracket (not a link)', `\\[Invoice](mailref://c/${A})`, []],
  ['a ticket with a character glued to it', `[x](mailref://c/${A}1)`, []],
  ['a bare ticket with a character glued to it', `mailref://c/${A}1`, []],
  ['a bare ticket with a suffix', `mailref://c/${A}.txt`, []],
  ['too short', '[x](mailref://c/short)', []],
  ['too long', `[x](mailref://c/${A}${A})`, []],
  ['upper case', `[x](mailref://c/${A.toUpperCase()})`, []],
  ['a place link', '[x](mailref://1/INBOX/42)', []],
  ['an https link', '[x](https://example.test/a)', []],
  ['no links', 'just text', []],
]

const known = (tokens: string[]): Map<string, CitationStatus> =>
  new Map(tokens.map(token => [token, { token, status: 'found', subject: 's', from: 'f', date: 'd' } as CitationStatus]))

describe('citationTokensOfAnswer', () => {
  afterEach(() => { cleanup() })

  it.each(CORPUS)('%s', (_name, text, expected) => {
    expect(citationTokensOfAnswer(text)).toEqual(expected)
  })

  it.each(CORPUS)('transition: %s: the tickets found are exactly the links the panel draws as clickable', (_name, text) => {
    const found = citationTokensOfAnswer(text)
    // Every ticket of the corpus is "known", so a drawn citation link is a button; click each and see which ticket it opens.
    const opened: string[] = []
    const { container } = render(React.createElement(AiAnswerMarkdown, {
      content: text, citations: known([A, B]), streaming: false, onOpenCitation: (token: string) => { opened.push(token) },
    }))
    container.querySelectorAll<HTMLButtonElement>('button.ai-inline-mail-link').forEach(button => button.click())
    expect([...new Set(opened)].sort()).toEqual([...found].sort())
  })

  it('a link drawn with a title is clickable once its ticket is known (the review scenario)', () => {
    const text = `[Счёт](mailref://c/${A} "Счёт")`
    expect(citationTokensOfAnswer(text)).toEqual([A])
    const { container } = render(React.createElement(AiAnswerMarkdown, { content: text, citations: known([A]), streaming: false }))
    expect(container.querySelectorAll('button.ai-inline-mail-link')).toHaveLength(1)
  })

  it('takes at most 100 tickets from one answer', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
    const text = Array.from({ length: 130 }, (_, i) => `[m](mailref://c/${alphabet[i % 32]}${alphabet[Math.floor(i / 32)]}aaaaaa)`).join(' ')
    expect(citationTokensOfAnswer(text)).toHaveLength(100)
  })

  it('an image is not a link: its address yields no ticket (it is drawn as text)', () => {
    expect(citationTokensOfAnswer(`![x](mailref://c/${A})`)).toEqual([])
  })

  it('an answer above the length bound is shown as plain text, so it yields no tickets', () => {
    expect(citationTokensOfAnswer(`[Invoice](mailref://c/${A}) ${'x'.repeat(ANSWER_MAX_CHARS)}`)).toEqual([])
  })

  it('a parser failure on a pathological answer yields no tickets rather than throwing', () => {
    expect(() => citationTokensOfAnswer(`[Invoice](mailref://c/${A})\n${'>'.repeat(20_000)}`)).not.toThrow()
  })

  it('is cheap on hostile text', () => {
    const t0 = performance.now()
    citationTokensOfAnswer('['.repeat(20_000))
    citationTokensOfAnswer('[](mailref://c/'.repeat(2_000))
    expect(performance.now() - t0).toBeLessThan(5000)
  })

  it('an empty or non-string answer has no tickets', () => {
    expect(citationTokensOfAnswer('')).toEqual([])
    expect(citationTokensOfAnswer(undefined as unknown as string)).toEqual([])
  })
})
