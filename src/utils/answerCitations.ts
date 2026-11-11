import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { CITATION_MAX_PER_ANSWER, parseCitationHref } from '@mailcopilot/core'
import { answerMarkdownProps, prepareAnswerMarkdown } from './answerMarkdown'

/**
 * The citation tickets an answer links to, in order of first appearance, without repeats (at most
 * `CITATION_MAX_PER_ANSWER`). The links are read from the SAME markdown parse that draws the answer (the shared
 * settings and the shared `prepareAnswerMarkdown`): a link with a title, a space before the closing
 * parenthesis, an angle-bracket destination or a reference-style link is a link here exactly when the answer shows it
 * as one, text inside code and images are not, and an answer beyond the length bound is plain text with no links at all.
 */
export function citationTokensOfAnswer(text: string): string[] {
  const prepared = prepareAnswerMarkdown(text)
  if (prepared.kind !== 'markdown' || prepared.text.length === 0) return []
  const hrefs: string[] = []
  const Capture = ({ href }: { href?: string }) => { if (href) hrefs.push(href); return null }
  try {
    renderToStaticMarkup(createElement(
      ReactMarkdown,
      { ...answerMarkdownProps, components: { ...answerMarkdownProps.components, a: Capture } },
      prepared.text,
    ))
  } catch {
    return []
  }
  const seen = new Set<string>()
  for (const href of hrefs) {
    const token = parseCitationHref(href)
    if (token) seen.add(token)
    if (seen.size >= CITATION_MAX_PER_ANSWER) break
  }
  return [...seen]
}

export interface AnswerTokenCache {
  tokensOf(text: string): string[]
}

/**
 * A cache of `citationTokensOfAnswer`, so a long chat is not re-parsed on every streamed delta. A real LRU (a hit
 * refreshes the entry), bounded by the number of entries AND by the total characters it holds (its keys are whole
 * answers); an answer larger than the character bound is simply not cached. One cache belongs to one chat: the caller
 * makes a new one when the chat changes, so nothing of a closed chat stays alive.
 */
export function createAnswerTokenCache(limits: { maxEntries: number; maxChars: number } = { maxEntries: 128, maxChars: 600_000 }): AnswerTokenCache {
  const entries = new Map<string, string[]>()
  let chars = 0
  return {
    tokensOf(text: string): string[] {
      const hit = entries.get(text)
      if (hit) {
        entries.delete(text)
        entries.set(text, hit)
        return hit
      }
      const tokens = citationTokensOfAnswer(text)
      if (text.length <= limits.maxChars) {
        entries.set(text, tokens)
        chars += text.length
        while (entries.size > limits.maxEntries || chars > limits.maxChars) {
          const oldest = entries.keys().next().value as string
          chars -= oldest.length
          entries.delete(oldest)
        }
      }
      return tokens
    },
  }
}
