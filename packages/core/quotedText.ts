/**
 * Quoted-text collapse utilities for the mail viewer.
 *
 * Wraps quoted content in native `<details>`/`<summary>` elements so the
 * browser renders them collapsed by default without any JavaScript injection.
 * The label string is supplied by the caller (renderer hook) so that this
 * module stays i18n-free.
 *
 * Note: the HTML path uses `DOMParser` when available; the module has no
 * renderer/i18n dependencies beyond that.
 */

export interface CollapseOptions {
  /** Localised label shown inside the `<summary>` toggle. */
  label: string
}

// ---------------------------------------------------------------------------
// HTML path
// ---------------------------------------------------------------------------

/**
 * Pattern that matches an Outlook-style "original message" separator line.
 * The separator appears as a paragraph or a `<div>`/`<p>` with content like
 * "-----Original Message-----" or "--- original message ---".
 */
const OUTLOOK_SEP_LINE_RE = /^-{3,}\s*original message\s*-{3,}$/i

/**
 * Pattern that matches an "On … wrote:" attribution line that Outlook,
 * Gmail and other clients insert before the quoted block.
 * Example: "On Mon, 12 Apr 2026, at 10:00, Alice <a@example.com> wrote:"
 *
 * To avoid false positives on prose like "On the whiteboard we wrote:", this
 * regex is only trusted when the next non-empty sibling element is a
 * `<blockquote>` or a `<details>` we already inserted (see usage in
 * `collapseHtmlBlockquotes`).
 */
const ON_WROTE_RE = /^on\s+.{0,200}wrote\s*:$/is

/** Returns the nesting depth of an element within the document tree. */
function getDepth(el: Element): number {
  let depth = 0
  let node: Element | null = el
  while (node) {
    depth++
    node = node.parentElement
  }
  return depth
}

/**
 * Wrap every `<blockquote>` element — at any nesting depth — in a
 * `<details>/<summary>` pair.  Processes deepest-first so inner blockquotes
 * are wrapped before their ancestors, preventing double-wrapping.  Blockquotes
 * that are already inside a `<details>` we just inserted are skipped.
 *
 * This approach correctly handles the common Gmail pattern:
 *   `<div class="gmail_quote"><blockquote>…</blockquote></div>`
 * where the blockquote is NOT a direct child of `<body>`.
 *
 * The function also scans direct children of `<body>` for Outlook-style
 * separator paragraphs (`-----Original Message-----` / `On … wrote:`) and
 * wraps everything from that separator to the end of the container in a
 * `<details>` block.
 *
 * Operates on a parsed DOM document (created by the caller) so no additional
 * HTML parsing is required. Mutates the document in-place and returns the
 * updated `body.innerHTML`.
 */
function collapseHtmlBlockquotes(doc: Document, label: string): string {
  // Step 1 — wrap every <blockquote> in the document, deepest-first.
  // Collecting all blockquotes up-front (snapshot) avoids live-collection
  // mutation issues; sorting deepest-first ensures inner wrappers are created
  // before outer ones so we never wrap already-wrapped content.
  const allQuotes = Array.from(doc.querySelectorAll('blockquote'))
  allQuotes.sort((a, b) => getDepth(b) - getDepth(a))

  for (const bq of allQuotes) {
    // Skip if this blockquote is already inside a <details> we inserted.
    if (bq.closest('details')) continue

    const details = doc.createElement('details')
    // Default: collapsed (no `open` attribute).
    const summary = doc.createElement('summary')
    summary.textContent = label
    details.appendChild(summary)

    // Replace the blockquote in-place with <details> containing it, so
    // existing email styling on the blockquote is preserved.
    bq.parentNode!.insertBefore(details, bq)
    details.appendChild(bq)
  }

  // Step 2 — Outlook / attribution-line detection.
  // Scan every direct child of <body> for text-only paragraphs / divs that
  // look like "-----Original Message-----" or "On … wrote:".
  // When found, wrap that node and all subsequent siblings in a <details>.
  const children = Array.from(doc.body.children)
  let separatorIndex = -1
  for (let i = 0; i < children.length; i++) {
    const el = children[i]
    // Only act on block-level text containers, not on <details> we already
    // inserted or on structural table/image elements.
    const tag = el.tagName.toLowerCase()
    if (!['p', 'div', 'span'].includes(tag)) continue

    const text = (el.textContent || '').trim()

    if (OUTLOOK_SEP_LINE_RE.test(text)) {
      separatorIndex = i
      break
    }

    // HIGH 3 fix: "On … wrote:" is only treated as a separator when the next
    // non-empty sibling is a <blockquote> or a <details> (already wrapped).
    // This prevents false positives on prose like "On the whiteboard we wrote:".
    if (ON_WROTE_RE.test(text)) {
      let nextEl: Element | null = null
      for (let j = i + 1; j < children.length; j++) {
        const candidate = children[j]
        if ((candidate.textContent || '').trim() !== '' || candidate.tagName.toLowerCase() === 'details') {
          nextEl = candidate
          break
        }
      }
      if (!nextEl) break // no next element — likely end of body
      const nextTag = nextEl.tagName.toLowerCase()
      if (nextTag === 'blockquote' || nextTag === 'details') {
        separatorIndex = i
        break
      }
      // Otherwise — prose, not a real attribution line; continue scanning.
    }
  }

  if (separatorIndex >= 0) {
    const trailing = children.slice(separatorIndex)
    // M2 fix: only wrap if there is actual non-empty content after the
    // separator itself (trailing.length > 1 OR at least one element beyond
    // the separator has non-empty text content).
    const hasContent =
      trailing.length > 1 ||
      (trailing.length === 1 && (trailing[0].textContent || '').trim() !== '')
    if (hasContent) {
      // M1 fix: if the attribution line is immediately followed by a <details>
      // we already inserted (wrapping the blockquote), skip creating a second
      // <details> around it — that would require two expansions to see the
      // quote.  The existing <details> already collapses the quoted region.
      // Check: is the first trailing element the separator AND the second is
      // already a <details>?
      if (
        trailing.length >= 2 &&
        trailing[1].tagName.toLowerCase() === 'details'
      ) {
        // Move the attribution line inside the existing <details> before the
        // blockquote so it reads naturally when expanded.
        const existingDetails = trailing[1]
        const summaryEl = existingDetails.querySelector('summary')
        if (summaryEl && summaryEl.nextSibling) {
          existingDetails.insertBefore(trailing[0], summaryEl.nextSibling)
        } else {
          existingDetails.appendChild(trailing[0])
        }
      } else {
        const details = doc.createElement('details')
        const summary = doc.createElement('summary')
        summary.textContent = label
        details.appendChild(summary)

        // Insert <details> at the position of the first separator sibling.
        doc.body.insertBefore(details, trailing[0])
        for (const node of trailing) {
          details.appendChild(node)
        }
      }
    }
  }

  return doc.body.innerHTML
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collapse quoted text in an email body.
 *
 * @param input  - Raw HTML body.
 * @param format - Must be `'html'`.
 * @param opts   - Options; `label` is the localised toggle text.
 * @returns      The transformed HTML string.
 *
 * The function relies on a browser `DOMParser` (or jsdom in tests) being
 * available in the calling environment. When `DOMParser` is not available
 * (bare Node without jsdom) the function returns the input unchanged — this
 * is a safe no-op, not an error.
 *
 * Plain-text collapse was removed; plain-text bodies are rendered as-is
 * inside a `<pre>` element.
 */
export function collapseQuotedText(
  input: string,
  _format: 'html',
  opts: CollapseOptions,
): string {
  if (!input) return input

  const { label } = opts

  // HTML path — requires DOMParser.
  if (typeof DOMParser === 'undefined') {
    // Safe no-op in bare Node environments.
    return input
  }

  // Quick pre-check: if the HTML contains no blockquote elements and no
  // Outlook separator patterns, bail out early without a full parse.
  // Use substring checks instead of anchored regexes here — the full anchored
  // regexes are for per-element text matching after DOM parsing.
  const hasBlockquote = /<blockquote[\s>]/i.test(input)
  const hasOutlookSep = /original message/i.test(input) || /\bwrote\s*:/i.test(input)
  if (!hasBlockquote && !hasOutlookSep) return input

  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body>${input}</body></html>`,
    'text/html',
  )

  return collapseHtmlBlockquotes(doc, label)
}
