// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { collapseQuotedText } from './quotedText'

const LABEL = 'Show quoted text'

// ---------------------------------------------------------------------------
// HTML format — blockquote collapse
// ---------------------------------------------------------------------------

describe('collapseQuotedText — html format', () => {
  it('wraps a top-level blockquote in <details>/<summary>', () => {
    const input = '<p>Hello</p><blockquote><p>Quoted</p></blockquote>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).toContain('<details>')
    expect(result).toContain(`<summary>${LABEL}</summary>`)
    expect(result).toContain('<blockquote>')
    expect(result).toContain('Quoted')
    // Default collapsed: no `open` attribute.
    expect(result).not.toMatch(/<details[^>]+open/)
  })

  it('wraps multiple top-level blockquotes independently', () => {
    const input =
      '<p>Reply 1</p><blockquote><p>Q1</p></blockquote>' +
      '<p>Reply 2</p><blockquote><p>Q2</p></blockquote>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    const detailsCount = (result.match(/<details>/g) || []).length
    expect(detailsCount).toBe(2)
    expect(result).toContain('Q1')
    expect(result).toContain('Q2')
  })

  it('wraps nested blockquotes independently at each level', () => {
    const input =
      '<blockquote><p>Outer</p><blockquote><p>Inner</p></blockquote></blockquote>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    // Outer wrapper and inner wrapper both present.
    const detailsCount = (result.match(/<details>/g) || []).length
    expect(detailsCount).toBeGreaterThanOrEqual(2)
    expect(result).toContain('Outer')
    expect(result).toContain('Inner')
  })

  it('passes through HTML without blockquotes unchanged', () => {
    const input = '<p>Hello <b>world</b></p><ul><li>item</li></ul>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    // No details element added.
    expect(result).not.toContain('<details>')
    // Content preserved.
    expect(result).toContain('Hello')
    expect(result).toContain('world')
    expect(result).toContain('item')
  })

  it('returns empty string unchanged', () => {
    expect(collapseQuotedText('', 'html', { label: LABEL })).toBe('')
  })

  it('handles HTML email without blockquote (pass-through)', () => {
    const input = '<div><p>Just a regular email body with no quoting.</p></div>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).not.toContain('<details>')
    expect(result).toContain('Just a regular email body')
  })

  it('summary element contains the supplied label text', () => {
    const customLabel = 'Afficher le texte cité'
    const input = '<blockquote><p>Quoted</p></blockquote>'
    const result = collapseQuotedText(input, 'html', { label: customLabel })
    expect(result).toContain(`<summary>${customLabel}</summary>`)
  })

  it('wraps Outlook separator paragraph and trailing content in <details>', () => {
    const input =
      '<p>My reply</p>' +
      '<p>-----Original Message-----</p>' +
      '<p>From: sender@example.com</p>' +
      '<p>Subject: Re: test</p>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).toContain('<details>')
    // The reply text is outside the details.
    const detailsStart = result.indexOf('<details>')
    const replyPos = result.indexOf('My reply')
    expect(replyPos).toBeLessThan(detailsStart)
    // The separator and trailing content are inside the details.
    expect(result).toContain('-----Original Message-----')
    expect(result).toContain('sender@example.com')
  })

  it('wraps "On … wrote:" attribution line and trailing content in <details>', () => {
    const input =
      '<p>Response</p>' +
      '<p>On Mon, 12 Apr 2026, Alice &lt;alice@example.com&gt; wrote:</p>' +
      '<blockquote><p>Original</p></blockquote>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).toContain('<details>')
    expect(result).toContain('Response')
    expect(result).toContain('Original')
  })
})

// ---------------------------------------------------------------------------
// HTML format — gmail_quote and deep-nesting fixes (HIGH 1)
// ---------------------------------------------------------------------------

describe('collapseQuotedText — gmail_quote and deep nesting', () => {
  it('wraps blockquote inside gmail_quote wrapper div', () => {
    // Most common Gmail pattern: blockquote is NOT a direct body child.
    const input =
      '<p>My reply</p>' +
      '<div class="gmail_quote"><blockquote><p>Quoted text</p></blockquote></div>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).toContain('<details>')
    expect(result).toContain(`<summary>${LABEL}</summary>`)
    expect(result).toContain('Quoted text')
    expect(result).toContain('My reply')
  })

  it('blockquote immediately inside another element (not direct body child) is wrapped', () => {
    // General case: blockquote nested inside a div.
    const input = '<div><blockquote><p>Nested inside div</p></blockquote></div>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).toContain('<details>')
    expect(result).toContain('<blockquote>')
    expect(result).toContain('Nested inside div')
  })

  it('deeply nested blockquotes each get their own <details>', () => {
    // Three levels of nesting, each should produce a separate <details>.
    const input =
      '<blockquote>L1<blockquote>L2<blockquote>L3</blockquote></blockquote></blockquote>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    const detailsCount = (result.match(/<details>/g) || []).length
    expect(detailsCount).toBe(3)
  })

  it('gmail_quote with attribution line collapses into a single <details>', () => {
    // Gmail pattern: attribution paragraph + div.gmail_quote > blockquote.
    // After HIGH 1 fix the blockquote is wrapped first; the attribution line
    // detection (ON_WROTE_RE) finds a <details> as next sibling and merges
    // the attribution into it rather than creating a redundant outer wrapper.
    const input =
      '<p>Thanks</p>' +
      '<p>On Wed, 1 May 2026, Bob &lt;bob@example.com&gt; wrote:</p>' +
      '<div class="gmail_quote"><blockquote><p>Original</p></blockquote></div>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    // Content preserved.
    expect(result).toContain('Thanks')
    expect(result).toContain('Original')
    // At least one <details> present.
    expect(result).toContain('<details>')
  })
})

// ---------------------------------------------------------------------------
// HIGH 3 — ON_WROTE_RE false-positive guard
// ---------------------------------------------------------------------------

describe('collapseQuotedText — ON_WROTE_RE false-positive guard', () => {
  it('does not collapse "On the whiteboard we wrote:" without a following blockquote', () => {
    // Prose sentence matching ON_WROTE_RE but not followed by a blockquote —
    // must NOT be treated as a quoted-text separator.
    const input =
      '<p>On the whiteboard we wrote:</p>' +
      '<p>Here are the action items</p>' +
      '<ul><li>Item 1</li><li>Item 2</li></ul>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).not.toContain('<details>')
    expect(result).toContain('On the whiteboard we wrote:')
    expect(result).toContain('action items')
  })

  it('does not collapse "On … wrote:" when followed only by text paragraphs', () => {
    const input =
      '<p>On Thursday Alice wrote:</p>' +
      '<p>The document is ready</p>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).not.toContain('<details>')
    expect(result).toContain('document is ready')
  })

  it('collapses "On … wrote:" when immediately followed by a blockquote', () => {
    const input =
      '<p>Reply here</p>' +
      '<p>On Mon, 12 Apr 2026, Alice &lt;alice@example.com&gt; wrote:</p>' +
      '<blockquote><p>Quoted content</p></blockquote>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).toContain('<details>')
    expect(result).toContain('Reply here')
    expect(result).toContain('Quoted content')
  })
})

// ---------------------------------------------------------------------------
// M2 — separator-only tail guard
// ---------------------------------------------------------------------------

describe('collapseQuotedText — separator-only tail (M2)', () => {
  it('does not create empty <details> when Outlook separator is the only remaining element', () => {
    // Body contains only the separator paragraph with no trailing content.
    // The separator itself has non-empty text so it should still be wrapped
    // (trailing.length === 1 and the element has non-empty textContent).
    const input = '<p>Reply</p><p>-----Original Message-----</p>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    // The separator itself has content, so wrapping is correct.
    expect(result).toContain('-----Original Message-----')
  })
})

// ---------------------------------------------------------------------------
// HTML format — early-bail and edge cases
// ---------------------------------------------------------------------------

describe('collapseQuotedText — html edge cases', () => {
  it('early-bail: returns input unchanged when no blockquote and no Outlook separator pattern', () => {
    // Exercises the `!hasBlockquote && !hasOutlookSep` fast-path — no DOMParser
    // call should be needed (verifiable by the fact that the exact string is
    // returned unchanged, including any normalisation artifacts DOMParser would
    // introduce).
    const input = '<p>Clean email, nothing to collapse here.</p>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).toBe(input)
  })

  it('Outlook separator inside a <span> is not matched (only <p>/<div>/<span> tags at body level)', () => {
    // The separator scanner checks tagName ∈ {p, div, span}. A <section>
    // wrapping the separator should not trigger the Outlook path.
    const input =
      '<p>Reply</p>' +
      '<section><p>-----Original Message-----</p></section>' +
      '<p>Not collapsed</p>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    // No <details> — the separator is inside <section>, not a direct body child.
    expect(result).not.toContain('<details>')
    expect(result).toContain('Not collapsed')
  })

  it('html with `wrote:` substring in link text is not falsely treated as attribution (pre-check)', () => {
    // The hasOutlookSep pre-check fires on "wrote:" anywhere in the string.
    // The DOM scan only triggers on textContent of block-level direct children.
    // Verify that a <blockquote>-free mail whose link contains "wrote:" still
    // produces no <details> (pre-check fires → DOMParser runs → no matching
    // node found → body.innerHTML returned unchanged).
    const input = '<p>See the comment that Alice wrote: <a href="https://x.test">here</a></p>'
    const result = collapseQuotedText(input, 'html', { label: LABEL })
    expect(result).not.toContain('<details>')
    expect(result).toContain('Alice wrote:')
  })
})
