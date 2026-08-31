/**
 * §2.128 — the two `cid:` rules.
 *
 * The suite mirrors the asymmetry the module exists for:
 *
 *  - `selectCidPartsToInline` guards RENDERING. Missing a part there leaves a
 *    broken image in the body, so the rule is broad and the tests check that
 *    unusual positions (CSS backgrounds, srcset, media queries) still get their
 *    bytes.
 *  - `selectPartsToHide` guards the user's ACCESS TO FILES. Inventing an answer
 *    there hides an attachment for good, so the tests are mostly a list of
 *    bodies a sender could write to make a real file disappear — every one of
 *    them must leave the chip alone.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_INLINE_CID_PARTS,
  extractImageSrcCids,
  selectCidPartsToInline,
  selectPartsToHide,
} from './cidRefs'

type TestPart = { part: string; cid?: string; disposition?: string }

function part(overrides: Partial<TestPart> = {}): TestPart {
  return { part: '2', cid: 'logo@x', disposition: 'inline', ...overrides }
}

function inlinedParts(atts: TestPart[], html: string, limit?: number): string[] {
  return selectCidPartsToInline(atts, html, limit === undefined ? {} : { limit }).map(e => e.attachment.part)
}

/** Wire both rules the way the hook wires them, assuming every fetch succeeded. */
function hiddenParts(atts: TestPart[], html: string): string[] {
  return selectPartsToHide(selectCidPartsToInline(atts, html), html).map(a => a.part)
}

// ---------------------------------------------------------------------------
// 1. Rendering: which parts the body inlines.
// ---------------------------------------------------------------------------

describe('selectCidPartsToInline', () => {
  it('resolves a part the body mentions', () => {
    const atts = [part()]
    expect(selectCidPartsToInline(atts, '<img src="cid:logo@x">')).toEqual([
      { cid: 'logo@x', attachment: atts[0] },
    ])
  })

  // The rendering rule is position-blind on purpose: `replaceCidImages`
  // substitutes the token wherever it stands, so anything narrower would leave
  // images that render today with a dead `cid:` URL.
  it.each([
    ['a CSS background in a <style> block', '<style>.hero{background:url(cid:logo@x)}</style>'],
    ['a CSS background behind a media query', '<style>@media (min-width:1px){.h{background:url(cid:logo@x)}}</style>'],
    ['a style attribute', '<div style="background:url(cid:logo@x)"></div>'],
    ['a srcset candidate', '<img srcset="cid:logo@x 2x" src="other.png">'],
    ['a <source> inside a picture', '<picture><source srcset="cid:logo@x"></picture>'],
    ['an angle-bracketed reference', '<img src="cid:<logo@x>">'],
    ['a differently-cased reference', '<img src="CID:LOGO@X">'],
  ])('inlines a part referenced from %s', (_label, html) => {
    expect(inlinedParts([part()], html)).toEqual(['2'])
  })

  it('never inlines a part the sender marked as an attachment', () => {
    expect(inlinedParts([part({ disposition: 'attachment' })], '<img src="cid:logo@x">')).toEqual([])
    expect(inlinedParts([part({ disposition: 'ATTACHMENT; filename="logo.png"' })], '<img src="cid:logo@x">')).toEqual([])
  })

  it('never inlines a part the body does not mention, or one without a cid', () => {
    expect(inlinedParts([part({ cid: 'orphan@x' })], '<img src="cid:other@x">')).toEqual([])
    expect(inlinedParts([part()], '<p>plain body</p>')).toEqual([])
    expect(inlinedParts([part({ cid: undefined })], '<img src="cid:logo@x">')).toEqual([])
    expect(inlinedParts([part({ cid: '' })], '<img src="cid:logo@x">')).toEqual([])
  })

  it('binds a repeated cid to the first eligible part, once', () => {
    const atts = [
      part({ part: '2', disposition: 'attachment' }),
      part({ part: '3' }),
      part({ part: '4' }),
    ]
    expect(inlinedParts(atts, '<img src="cid:logo@x"><img src="cid:LOGO@X">')).toEqual(['3'])
  })

  it('reports the normalized cid, which is the key replaceCidImages matches on', () => {
    expect(selectCidPartsToInline([part({ cid: '<LOGO@X>' })], '<img src="cid:logo@x">').map(e => e.cid))
      .toEqual(['LOGO@X'])
  })

  it('stops at the ceiling', () => {
    const atts = Array.from({ length: MAX_INLINE_CID_PARTS + 5 }, (_, i) =>
      part({ part: `2.${i}`, cid: `img${i}@x` }),
    )
    const html = atts.map(a => `<img src="cid:${a.cid}">`).join('')
    const resolved = selectCidPartsToInline(atts, html)
    expect(resolved).toHaveLength(MAX_INLINE_CID_PARTS)
    expect(resolved[resolved.length - 1].attachment.part).toBe(`2.${MAX_INLINE_CID_PARTS - 1}`)
  })

  it('honours an explicit limit and ignores a nonsensical one', () => {
    const atts = [part({ part: '2', cid: 'a@x' }), part({ part: '3', cid: 'b@x' })]
    const html = '<img src="cid:a@x"><img src="cid:b@x">'
    expect(inlinedParts(atts, html, 1)).toEqual(['2'])
    expect(inlinedParts(atts, html, 0)).toEqual(['2', '3'])
    expect(inlinedParts(atts, html, -3)).toEqual(['2', '3'])
  })

  it('is total on missing input', () => {
    expect(selectCidPartsToInline(null, '<img src="cid:logo@x">')).toEqual([])
    expect(selectCidPartsToInline(undefined, '<img src="cid:logo@x">')).toEqual([])
    expect(selectCidPartsToInline([], '<img src="cid:logo@x">')).toEqual([])
    expect(selectCidPartsToInline([part()], null)).toEqual([])
    expect(selectCidPartsToInline([part()], undefined)).toEqual([])
    expect(selectCidPartsToInline([part()], '')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Access to files: which parts lose their chip.
// ---------------------------------------------------------------------------

describe('extractImageSrcCids', () => {
  it('reads an img src in every quoting style, including angle brackets', () => {
    const html = `<img src="cid:one@x"><img src='cid:two@x'><img src=cid:three@x><img src="cid:<four@x>">`
    expect(extractImageSrcCids(html)).toEqual(['one@x', 'two@x', 'three@x', 'four@x'])
  })

  it('reads an image input but no other input type', () => {
    expect(extractImageSrcCids('<input type="image" src="cid:btn@x">')).toEqual(['btn@x'])
    expect(extractImageSrcCids('<input type="text" src="cid:btn@x">')).toEqual([])
    expect(extractImageSrcCids('<input src="cid:btn@x">')).toEqual([])
  })

  it('reads the src attribute only, never srcset', () => {
    expect(extractImageSrcCids('<img srcset="cid:cand@x 2x">')).toEqual([])
    expect(extractImageSrcCids('<img srcset="cid:cand@x 2x" src="cid:real@x">')).toEqual(['real@x'])
    expect(extractImageSrcCids('<source srcset="cid:cand@x"><source src="cid:also@x">')).toEqual([])
  })

  it('is not confused by a > inside a quoted attribute', () => {
    expect(extractImageSrcCids('<img alt="a>b" src="cid:after@x">')).toEqual(['after@x'])
  })

  it('skips ignored regions without swallowing the markup that follows them', () => {
    // A <style> / comment / textarea block hides its own content from the scan,
    // and nothing else: an image after it is a real image.
    expect(extractImageSrcCids('<style>p{background:url(cid:victim@x)}</style><img src="cid:real@x">'))
      .toEqual(['real@x'])
    expect(extractImageSrcCids('<style><img src="cid:victim@x"></style><img src="cid:real@x">'))
      .toEqual(['real@x'])
    expect(extractImageSrcCids('<!-- <img src="cid:victim@x"> --><img src="cid:real@x">'))
      .toEqual(['real@x'])
    expect(extractImageSrcCids('<textarea><img src="cid:victim@x"></textarea><img src="cid:real@x">'))
      .toEqual(['real@x'])
  })

  it('does not read an <img> written inside another element attribute', () => {
    // A parser sees one <p> with a title, not an image.
    expect(extractImageSrcCids(`<p title="<img src=cid:victim@x>">text</p>`)).toEqual([])
  })

  it('returns unique cids in first-seen order, preserving case', () => {
    const html = '<img src="cid:Dup@X"><img src="cid:dup@x"><img src="cid:second@x">'
    expect(extractImageSrcCids(html)).toEqual(['Dup@X', 'second@x'])
  })

  it('handles empty, missing and malformed input without throwing', () => {
    expect(extractImageSrcCids('')).toEqual([])
    expect(extractImageSrcCids(null)).toEqual([])
    expect(extractImageSrcCids(undefined)).toEqual([])
    expect(extractImageSrcCids('<img src="cid:open@x"')).toEqual([])
    expect(extractImageSrcCids('<<<>>> cid: <img')).toEqual([])
  })
})

describe('selectPartsToHide', () => {
  it('hides a part that satisfies all four conditions', () => {
    expect(hiddenParts([part()], '<p>hi</p><img src="cid:logo@x">')).toEqual(['2'])
    expect(hiddenParts([part({ disposition: 'inline; filename="logo.png"' })], '<img src="cid:logo@x">')).toEqual(['2'])
    expect(hiddenParts([part({ disposition: 'INLINE ; filename=logo.png' })], '<img src="cid:logo@x">')).toEqual(['2'])
    expect(hiddenParts([part()], '<input type="image" src="cid:logo@x">')).toEqual(['2'])
  })

  // Condition 2. Content-Disposition is optional (RFC 2183) and a part without
  // it may well be a file the sender simply did not label; we no longer guess.
  it('keeps a part whose disposition is not explicitly inline', () => {
    expect(hiddenParts([part({ disposition: undefined })], '<img src="cid:logo@x">')).toEqual([])
    expect(hiddenParts([part({ disposition: '' })], '<img src="cid:logo@x">')).toEqual([])
    expect(hiddenParts([part({ disposition: 'attachment' })], '<img src="cid:logo@x">')).toEqual([])
  })

  // Condition 3 — the whole point of iteration 4. Each of these bodies was a
  // way to make a real attachment vanish: the `cid` sits somewhere a browser
  // may well never draw, and deciding otherwise cost the user the file.
  it.each([
    ['a media query that never applies', '<style>@media not all{.x{background:url(cid:logo@x)}}</style>'],
    ['an unused custom property', '<style>:root{--unused:url(cid:logo@x)}</style>'],
    ['a CDATA section in a stylesheet', '<style><![CDATA[url(cid:logo@x)]]></style>'],
    ['an escaped @import prelude', '<style>@\\69 mport url(cid:logo@x);</style>'],
    ['a <source> the browser may skip', '<picture><source media="not all" srcset="cid:logo@x"><img src="other.png"></picture>'],
    ['a srcset with no src at all', '<img srcset="cid:logo@x 2x">'],
    ['a plain CSS background', '<style>.hero{background:url(cid:logo@x)}</style>'],
    ['a style attribute', '<div style="background:url(cid:logo@x)"></div>'],
    ['markup inside a CSS comment', '<style>/* <img src="cid:logo@x"> */</style>'],
    ['markup inside a stylesheet', '<style><img src="cid:logo@x"></style>'],
    ['an HTML comment', '<!-- <img src="cid:logo@x"> -->'],
    ['an unterminated HTML comment', '<p>hi</p><!-- <img src="cid:logo@x">'],
    ['prose', '<p>see cid:logo@x</p>'],
    ['a link target', '<a href="cid:logo@x">open</a>'],
    ['a non-resource attribute', '<img alt="cid:logo@x" title="cid:logo@x" data-ref="cid:logo@x">'],
    ['script, noscript or textarea content', '<textarea><img src="cid:logo@x"></textarea>'],
    ['a legacy background attribute the sanitizer drops', '<td background="cid:logo@x">'],
  ])('keeps a part referenced only from %s', (_label, html) => {
    // The part IS fetched and substituted — the body may well draw it — but the
    // chip stays, because we cannot prove the browser drew it.
    expect(inlinedParts([part()], html)).toEqual(['2'])
    expect(hiddenParts([part()], html)).toEqual([])
  })

  // srcset picks one candidate out of several, and which one is the browser's
  // decision, not ours. Only the plain `src` counts.
  it('keeps srcset candidates and hides only the src', () => {
    const atts = [
      part({ part: '2', cid: 'a@x' }),
      part({ part: '3', cid: 'b@x' }),
      part({ part: '4', cid: 'c@x' }),
    ]
    const html = '<img srcset="cid:a@x 1x, cid:b@x 2x" src="cid:c@x">'
    expect(inlinedParts(atts, html)).toEqual(['2', '3', '4'])
    expect(hiddenParts(atts, html)).toEqual(['4'])
  })

  // Condition 4: the caller reports what it substituted. A part whose bytes
  // never arrived is absent from that report, so it keeps its chip even though
  // the body references it from a real image position.
  it('hides nothing when nothing was substituted', () => {
    expect(selectPartsToHide([], '<img src="cid:logo@x">')).toEqual([])
    expect(selectPartsToHide(null, '<img src="cid:logo@x">')).toEqual([])
    expect(selectPartsToHide(undefined, '<img src="cid:logo@x">')).toEqual([])
  })

  it('hides nothing when the html is missing', () => {
    const inlined = selectCidPartsToInline([part()], '<img src="cid:logo@x">')
    expect(selectPartsToHide(inlined, null)).toEqual([])
    expect(selectPartsToHide(inlined, '')).toEqual([])
  })

  it('matches cid case-insensitively on both sides', () => {
    expect(hiddenParts([part({ cid: '<LOGO@X>' })], '<img src="cid:logo@x">')).toEqual(['2'])
    expect(hiddenParts([part({ cid: 'logo@x' })], '<img src="cid:<LOGO@X>">')).toEqual(['2'])
  })

  it('hides only the part the reference resolved to, not a twin sharing its cid', () => {
    const atts = [part({ part: '2' }), part({ part: '3' })]
    expect(hiddenParts(atts, '<img src="cid:logo@x">')).toEqual(['2'])
  })

  it('keeps everything past the inlining ceiling, which is never substituted', () => {
    const atts = Array.from({ length: MAX_INLINE_CID_PARTS + 5 }, (_, i) =>
      part({ part: `2.${i}`, cid: `img${i}@x` }),
    )
    const html = atts.map(a => `<img src="cid:${a.cid}">`).join('')
    expect(hiddenParts(atts, html)).toHaveLength(MAX_INLINE_CID_PARTS)
    expect(hiddenParts(atts, html)).not.toContain(`2.${MAX_INLINE_CID_PARTS}`)
  })
})
