/**
 * §2.128 — attachment list model.
 *
 * The suite is split the same way the module is:
 *
 *  - the **cap** block never touches `cid` / `disposition`, and its headline
 *    case runs with `groupInline: false` so a regression that makes the ceiling
 *    depend on any inline judgement fails here immediately;
 *  - the **ordering** block proves the property the final revision of §2.128 is
 *    actually built on: *no part is ever removed*. Parts the body inlined are
 *    demoted below the real attachments and wait behind the toggle; expanding
 *    yields every part the message carries, without exception.
 *
 * Which parts count as inlined is NOT decided here — the module no longer
 * decides it. The rule lives in `packages/core/cidRefs.ts`
 * (`selectPartsToHide`) and its integration in
 * `src/hooks/useMailIframeDoc.test.ts`. After this revision that rule only
 * chooses "shown first" vs "shown behind the toggle", which is why a rule that
 * cannot be made exact (the browser owns visibility) is no longer dangerous.
 */
import { describe, expect, it } from 'vitest'
import { MAX_INLINE_CID_PARTS, selectCidPartsToInline, selectPartsToHide } from '@mailcopilot/core/cidRefs'
import type { AttachmentMeta } from '../../packages/types'
import {
  ATTACHMENT_COLLAPSED_LIMIT,
  buildAttachmentList,
  capAttachmentList,
  dedupeAttachments,
  orderAttachments,
  selectInlineAttachments,
  selectRealAttachments,
} from './attachmentList'

function att(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    part: '2',
    filename: 'file.bin',
    contentType: 'application/octet-stream',
    size: 1024,
    ...overrides,
  }
}

/** N genuine attachments: every one `disposition: attachment`, not one `cid`. */
function realAttachments(n: number): AttachmentMeta[] {
  return Array.from({ length: n }, (_, i) =>
    att({
      part: `2.${i + 1}`,
      filename: `contract-${i + 1}.pdf`,
      contentType: 'application/pdf',
      size: 10_000 + i,
      disposition: 'attachment',
    }),
  )
}

/** N layout images as a well-behaved sender writes them. */
function inlineImages(n: number, prefix = '3'): AttachmentMeta[] {
  return Array.from({ length: n }, (_, i) =>
    att({
      part: `${prefix}.${i + 1}`,
      filename: `img-${i + 1}.png`,
      contentType: 'image/png',
      size: 4096,
      cid: `img${i + 1}@x`,
      disposition: 'inline',
    }),
  )
}

// ---------------------------------------------------------------------------
// Part 2 — the cap. Deliberately written and asserted without any inline input.
// ---------------------------------------------------------------------------

describe('capAttachmentList — standalone list ceiling', () => {
  it('renders everything when the list fits under the limit', () => {
    const model = capAttachmentList(realAttachments(3))
    expect(model.total).toBe(3)
    expect(model.visible).toHaveLength(3)
    expect(model.hiddenCount).toBe(0)
    expect(model.canExpand).toBe(false)
    expect(model.expanded).toBe(false)
  })

  it('renders everything at exactly the limit without offering a toggle', () => {
    const model = capAttachmentList(realAttachments(ATTACHMENT_COLLAPSED_LIMIT))
    expect(model.visible).toHaveLength(ATTACHMENT_COLLAPSED_LIMIT)
    expect(model.canExpand).toBe(false)
    expect(model.hiddenCount).toBe(0)
  })

  it('collapses one item over the limit', () => {
    const model = capAttachmentList(realAttachments(ATTACHMENT_COLLAPSED_LIMIT + 1))
    expect(model.visible).toHaveLength(ATTACHMENT_COLLAPSED_LIMIT)
    expect(model.hiddenCount).toBe(1)
    expect(model.canExpand).toBe(true)
  })

  it('caps 30 genuine attachments and keeps the toggle available once expanded', () => {
    const items = realAttachments(30)
    const collapsed = capAttachmentList(items)
    expect(collapsed.visible).toHaveLength(ATTACHMENT_COLLAPSED_LIMIT)
    expect(collapsed.hiddenCount).toBe(30 - ATTACHMENT_COLLAPSED_LIMIT)

    const expanded = capAttachmentList(items, { expanded: true })
    expect(expanded.visible).toHaveLength(30)
    expect(expanded.hiddenCount).toBe(0)
    expect(expanded.canExpand).toBe(true)
    expect(expanded.expanded).toBe(true)
  })

  it('keeps the first N items in their original order when collapsed', () => {
    const model = capAttachmentList(realAttachments(10))
    expect(model.visible.map(a => a.part)).toEqual(['2.1', '2.2', '2.3', '2.4'])
  })

  it('honours a custom limit and ignores a nonsensical one', () => {
    expect(capAttachmentList(realAttachments(10), { collapsedLimit: 2 }).visible).toHaveLength(2)
    expect(capAttachmentList(realAttachments(10), { collapsedLimit: 0 }).visible).toHaveLength(
      ATTACHMENT_COLLAPSED_LIMIT,
    )
    expect(capAttachmentList(realAttachments(10), { collapsedLimit: -5 }).visible).toHaveLength(
      ATTACHMENT_COLLAPSED_LIMIT,
    )
  })

  it('reports nothing to expand for an empty list', () => {
    const model = capAttachmentList([])
    expect(model.total).toBe(0)
    expect(model.visible).toEqual([])
    expect(model.canExpand).toBe(false)
  })

  it('ignores a stale expanded flag when the list no longer overflows', () => {
    const model = capAttachmentList(realAttachments(2), { expanded: true })
    expect(model.canExpand).toBe(false)
    expect(model.expanded).toBe(false)
  })
})

describe('capAttachmentList — collapsedEligible only withholds, never removes', () => {
  it('shows fewer than the limit when only the leading items are eligible', () => {
    const model = capAttachmentList(realAttachments(10), { collapsedEligible: 2 })
    expect(model.visible.map(a => a.part)).toEqual(['2.1', '2.2'])
    expect(model.total).toBe(10)
    expect(model.hiddenCount).toBe(8)
    expect(model.canExpand).toBe(true)
  })

  it('shows an empty collapsed row when nothing is eligible, and everything once expanded', () => {
    const items = realAttachments(6)
    const collapsed = capAttachmentList(items, { collapsedEligible: 0 })
    expect(collapsed.visible).toEqual([])
    expect(collapsed.total).toBe(6)
    expect(collapsed.hiddenCount).toBe(6)
    expect(collapsed.canExpand).toBe(true)

    const expanded = capAttachmentList(items, { collapsedEligible: 0, expanded: true })
    expect(expanded.visible).toHaveLength(6)
    expect(expanded.hiddenCount).toBe(0)
  })

  it('never exceeds the limit even when every item is eligible', () => {
    const model = capAttachmentList(realAttachments(10), { collapsedEligible: 10 })
    expect(model.visible).toHaveLength(ATTACHMENT_COLLAPSED_LIMIT)
  })

  it('clamps a nonsensical eligible count instead of losing items', () => {
    expect(capAttachmentList(realAttachments(3), { collapsedEligible: 99 }).visible).toHaveLength(3)
    expect(capAttachmentList(realAttachments(3), { collapsedEligible: -4 }).visible).toEqual([])
    expect(capAttachmentList(realAttachments(3), { collapsedEligible: Number.NaN }).visible).toHaveLength(3)
    // Whatever the value, expanding still yields the whole list.
    expect(
      capAttachmentList(realAttachments(3), { collapsedEligible: -4, expanded: true }).visible,
    ).toHaveLength(3)
  })
})

describe('buildAttachmentList — cap independence from inline grouping', () => {
  // Acceptance criterion of §2.128: the ceiling must hold with the grouping
  // switched off entirely. 30 real attachments, grouping disabled, still capped.
  it('caps 30 real attachments with inline grouping fully disabled', () => {
    const model = buildAttachmentList({
      attachments: realAttachments(30),
      groupInline: false,
    })
    expect(model.total).toBe(30)
    expect(model.visible).toHaveLength(ATTACHMENT_COLLAPSED_LIMIT)
    expect(model.hiddenCount).toBe(26)
    expect(model.canExpand).toBe(true)
  })

  it('does not deduplicate or reorder when grouping is disabled', () => {
    const twins = [
      att({ part: '2.1', filename: 'logo.png', size: 512, cid: 'logo@x' }),
      att({ part: '2.2', filename: 'logo.png', size: 512, cid: 'logo@x' }),
    ]
    const real = att({ part: '9', filename: 'agenda.pdf', disposition: 'attachment' })
    const model = buildAttachmentList({
      attachments: [...twins, real],
      inlineParts: twins,
      groupInline: false,
    })
    expect(model.total).toBe(3)
    expect(model.visible.map(a => a.part)).toEqual(['2.1', '2.2', '9'])
  })

  it('treats a missing attachments array as an empty list', () => {
    expect(buildAttachmentList().total).toBe(0)
    expect(buildAttachmentList({ attachments: null }).total).toBe(0)
    expect(buildAttachmentList({ attachments: undefined }).total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Part 1 — ordering. Inlined parts are demoted; nothing is removed.
// ---------------------------------------------------------------------------

describe('selectRealAttachments / selectInlineAttachments', () => {
  it('splits the list into the reported parts and the rest', () => {
    const logo = att({ part: '2', filename: 'logo.png', contentType: 'image/png', cid: 'logo@x', disposition: 'inline' })
    const speaker = att({ part: '3', filename: 'speaker.jpg', contentType: 'image/jpeg', cid: 'sp@x', disposition: 'inline' })
    const agenda = att({ part: '4', filename: 'agenda.pdf', contentType: 'application/pdf', disposition: 'attachment' })
    const parts = [logo, speaker, agenda]

    expect(selectRealAttachments(parts, [logo, speaker]).map(a => a.part)).toEqual(['4'])
    expect(selectInlineAttachments(parts, [logo, speaker]).map(a => a.part)).toEqual(['2', '3'])
  })

  it('treats no report as "nothing was inlined"', () => {
    const parts = [att({ part: '2', cid: 'logo@x', disposition: 'inline' })]
    expect(selectRealAttachments(parts, undefined)).toHaveLength(1)
    expect(selectRealAttachments(parts, null)).toHaveLength(1)
    expect(selectRealAttachments(parts, [])).toHaveLength(1)
    expect(selectInlineAttachments(parts, undefined)).toEqual([])
    expect(selectInlineAttachments(parts, [])).toEqual([])
  })

  // Identity, not `part` / filename / cid: a look-alike entry the renderer never
  // reported keeps its place in the leading group.
  it('moves the reported object only, not a twin that shares its fields', () => {
    const reported = att({ part: '2', filename: 'logo.png', cid: 'logo@x' })
    const twin = att({ part: '2', filename: 'logo.png', cid: 'logo@x' })
    expect(selectRealAttachments([reported, twin], [reported])).toEqual([twin])
  })

  it('preserves the original order inside each group', () => {
    const logo = att({ part: '3', cid: 'logo@x' })
    const parts = [
      att({ part: '2', filename: 'a.pdf', disposition: 'attachment' }),
      logo,
      att({ part: '4', filename: 'b.pdf', disposition: 'attachment' }),
    ]
    expect(selectRealAttachments(parts, [logo]).map(a => a.part)).toEqual(['2', '4'])
  })
})

describe('orderAttachments', () => {
  it('puts the real attachments first and the inlined parts after them', () => {
    const logo = att({ part: '2', cid: 'logo@x', disposition: 'inline' })
    const banner = att({ part: '3', cid: 'ban@x', disposition: 'inline' })
    const contract = att({ part: '4', filename: 'contract.pdf', disposition: 'attachment' })
    const { items, realCount } = orderAttachments([logo, banner, contract], [logo, banner])

    expect(items.map(a => a.part)).toEqual(['4', '2', '3'])
    expect(realCount).toBe(1)
    expect(items).toHaveLength(3)
  })

  it('leaves the server order untouched when nothing was inlined', () => {
    const parts = realAttachments(3)
    const { items, realCount } = orderAttachments(parts, [])
    expect(items.map(a => a.part)).toEqual(['2.1', '2.2', '2.3'])
    expect(realCount).toBe(3)
  })
})

describe('dedupeAttachments', () => {
  it('collapses a part reported twice under the same path', () => {
    const parts = [
      att({ part: '2', filename: 'logo.png', cid: 'logo@x' }),
      att({ part: '2', filename: 'logo.png', cid: 'logo@x' }),
    ]
    expect(dedupeAttachments(parts).map(a => a.part)).toEqual(['2'])
  })

  // Everything below is the dangerous direction: distinct parts must survive.
  // None of `cid`, filename, type or size is derived from the content, and all
  // of them are set by the sender — so none of them can retire a part.
  it('keeps distinct parts that share a cid', () => {
    const parts = [
      att({ part: '2', filename: 'logo.png', cid: 'logo@x' }),
      att({ part: '3', filename: 'invoice.pdf', cid: '<LOGO@X>', disposition: 'attachment' }),
    ]
    expect(dedupeAttachments(parts).map(a => a.part)).toEqual(['2', '3'])
  })

  it('keeps distinct parts that share filename, type and size', () => {
    // Two genuinely different documents the sender declared identically. The
    // old name+type+size key threw one of them away, and with it the only way
    // to reach that file.
    const parts = [
      att({ part: '2', filename: 'photo.png', contentType: 'image/png', size: 2048, disposition: 'attachment' }),
      att({ part: '3', filename: 'Photo.PNG', contentType: 'image/png', size: 2048, disposition: 'attachment' }),
    ]
    expect(dedupeAttachments(parts).map(a => a.part)).toEqual(['2', '3'])
  })

  it('keeps same-named files of different size', () => {
    const parts = [
      att({ part: '2', filename: 'scan.pdf', contentType: 'application/pdf', size: 2048 }),
      att({ part: '3', filename: 'scan.pdf', contentType: 'application/pdf', size: 4096 }),
    ]
    expect(dedupeAttachments(parts)).toHaveLength(2)
  })

  it('keeps unnamed parts apart instead of guessing', () => {
    const parts = [
      att({ part: '2', filename: undefined, size: undefined }),
      att({ part: '3', filename: undefined, size: undefined }),
    ]
    expect(dedupeAttachments(parts)).toHaveLength(2)
  })

  it('keeps same-named files when the size is unknown', () => {
    const parts = [
      att({ part: '2', filename: 'note.txt', size: undefined }),
      att({ part: '3', filename: 'note.txt', size: undefined }),
    ]
    expect(dedupeAttachments(parts)).toHaveLength(2)
  })

  it('never merges parts whose path is missing', () => {
    const parts = [
      att({ part: '', filename: 'a.pdf', size: 10 }),
      att({ part: '', filename: 'a.pdf', size: 10 }),
    ]
    expect(dedupeAttachments(parts)).toHaveLength(2)
  })

  it('preserves order and the first occurrence', () => {
    const parts = [
      att({ part: '2', filename: 'first.pdf' }),
      att({ part: '3', filename: 'other.pdf' }),
      att({ part: '2', filename: 'shadow.pdf' }),
    ]
    expect(dedupeAttachments(parts).map(a => a.filename)).toEqual(['first.pdf', 'other.pdf'])
  })
})

describe('buildAttachmentList — grouping + cap together', () => {
  /**
   * Wire the module the way the app wires it: `selectCidPartsToInline` picks
   * what the body inlines, `selectPartsToHide` narrows that to what may be
   * demoted, and the list puts it behind the toggle. Every fetch is assumed to
   * succeed here — the failed-fetch half of condition 4 lives in
   * `src/hooks/useMailIframeDoc.test.ts`, which is the only place that knows.
   */
  function listFor(attachments: AttachmentMeta[], html: string, expanded = false) {
    return buildAttachmentList({
      attachments,
      inlineParts: selectPartsToHide(selectCidPartsToInline(attachments, html), html),
      expanded,
    })
  }

  /** A layout image as a well-behaved sender writes it. */
  function layoutImage(part: string, filename: string, cid: string): AttachmentMeta {
    return att({ part, filename, contentType: 'image/png', size: 4096, cid, disposition: 'inline' })
  }

  // The reported message: ~30 chips, a logo repeated all over the body, one
  // genuine file at the end. The genuine file now leads the row; the layout
  // images are one click away instead of gone.
  it('leads a newsletter-style message with its real attachment and keeps the rest reachable', () => {
    const parts: AttachmentMeta[] = [layoutImage('2', 'logo.png', 'logo@x')]
    for (let i = 0; i < 15; i++) {
      parts.push(layoutImage(`3.${i}`, `speaker-${i}.jpg`, `sp${i}@x`))
    }
    parts.push(att({ part: '9', filename: 'programme.pdf', contentType: 'application/pdf', size: 99_000, disposition: 'attachment' }))

    // The logo is referenced fifteen times; it is still one part.
    const html = `${'<img src="cid:logo@x">'.repeat(15)}${Array.from({ length: 15 }, (_, i) => `<img src="cid:sp${i}@x">`).join('')}`
    const model = listFor(parts, html)

    expect(model.total).toBe(17)
    expect(model.visible.map(a => a.filename)).toEqual(['programme.pdf'])
    expect(model.hiddenCount).toBe(16)
    expect(model.canExpand).toBe(true)
    expect(listFor(parts, html, true).visible).toHaveLength(17)
  })

  // The user's screenshot: a message that is nothing but layout images. The
  // collapsed view must not drown the message, and every image must still be
  // one click away — including any the sender mislabelled as decoration.
  it('keeps a 30-image message off the reading area and reveals all 30 on expand', () => {
    const parts = inlineImages(30)
    const html = parts.map(a => `<img src="cid:${a.cid}">`).join('')

    // Only the first MAX_INLINE_CID_PARTS are actually substituted into the
    // body, so the five past the ceiling are ordinary chips — that is the cap's
    // job from here on, and it holds.
    const collapsed = listFor(parts, html)
    expect(collapsed.total).toBe(30)
    expect(collapsed.visible.length).toBeLessThanOrEqual(ATTACHMENT_COLLAPSED_LIMIT)
    expect(collapsed.canExpand).toBe(true)
    expect(collapsed.hiddenCount).toBe(30 - collapsed.visible.length)

    const expanded = listFor(parts, html, true)
    expect(expanded.visible).toHaveLength(30)
    expect(new Set(expanded.visible)).toEqual(new Set(parts))
    expect(expanded.hiddenCount).toBe(0)
  })

  it('renders an empty collapsed row when every part was inlined', () => {
    const parts = inlineImages(MAX_INLINE_CID_PARTS)
    const html = parts.map(a => `<img src="cid:${a.cid}">`).join('')

    const collapsed = listFor(parts, html)
    expect(collapsed.total).toBe(MAX_INLINE_CID_PARTS)
    expect(collapsed.visible).toEqual([])
    expect(collapsed.hiddenCount).toBe(MAX_INLINE_CID_PARTS)
    expect(collapsed.canExpand).toBe(true)

    const expanded = listFor(parts, html, true)
    expect(expanded.visible.map(a => a.part)).toEqual(parts.map(a => a.part))
    expect(expanded.hiddenCount).toBe(0)
  })

  // The security finding that ended the "detect what the browser drew" line of
  // work: `display:none` satisfies every condition we can check, yet nothing is
  // painted. Under the final rule that costs a click, not the file.
  it('keeps a part reachable when the body hides it with display:none', () => {
    const report = att({
      part: '2',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      size: 5000,
      cid: 'report@x',
      disposition: 'inline',
    })
    const html = '<div style="display:none"><img src="cid:report@x"></div>'

    // Precondition: the rule really does classify this part as inlined — the
    // test would otherwise pass for the wrong reason.
    expect(selectPartsToHide(selectCidPartsToInline([report], html), html)).toEqual([report])

    const collapsed = listFor([report], html)
    expect(collapsed.total).toBe(1)
    expect(collapsed.canExpand).toBe(true)
    expect(collapsed.hiddenCount).toBe(1)
    expect(collapsed.items).toContain(report)

    expect(listFor([report], html, true).visible).toEqual([report])
  })

  // Mixed message: the genuine files must be on screen without any interaction.
  it('shows the real attachments immediately alongside 30 inline images', () => {
    const contracts = realAttachments(2)
    const images = inlineImages(30)
    const parts = [...images.slice(0, 15), ...contracts, ...images.slice(15)]
    const html = images.map(a => `<img src="cid:${a.cid}">`).join('')

    // The contracts lead the collapsed row with no interaction, even though
    // they sit in the middle of the server's order. (The five images past the
    // inlining ceiling are never substituted, so they stay ordinary chips and
    // fill the rest of the row.)
    const collapsed = listFor(parts, html)
    expect(collapsed.visible.slice(0, 2).map(a => a.filename)).toEqual(['contract-1.pdf', 'contract-2.pdf'])
    expect(collapsed.visible).toHaveLength(ATTACHMENT_COLLAPSED_LIMIT)
    expect(collapsed.total).toBe(32)
    expect(listFor(parts, html, true).visible).toHaveLength(32)
  })

  // Two distinct parts declaring the same Content-ID: only one of them is the
  // part the substitution addressed, so only that one is demoted. Demoting the
  // other would be `cid`-based grouping, which §2.128 rules out — `cid` is
  // sender-controlled and says nothing about the second part's bytes.
  it('leads with a part that merely shares a cid with the inlined one', () => {
    const parts = [
      layoutImage('2', 'logo.png', 'logo@x'),
      att({ part: '3', filename: 'logo.png', contentType: 'image/png', size: 9999, cid: 'logo@x', disposition: 'inline' }),
    ]
    const model = listFor(parts, '<img src="cid:logo@x">')
    expect(model.items.map(a => a.part)).toEqual(['3', '2'])
    expect(model.visible.map(a => a.part)).toEqual(['3'])
  })

  it('still caps when every leading part is genuine', () => {
    const parts = [...realAttachments(30), layoutImage('9', 'logo.png', 'logo@x')]
    const model = listFor(parts, '<img src="cid:logo@x">')
    expect(model.total).toBe(31)
    expect(model.visible).toHaveLength(ATTACHMENT_COLLAPSED_LIMIT)
    expect(model.hiddenCount).toBe(27)
  })

  // Attacker model: the sender controls the body and wants the recipient not to
  // notice a part. None of these positions proves the browser drew anything —
  // and now none of them can cost the user the file either way.
  it.each([
    ['an HTML comment', '<p>Nothing to see</p><!-- <img src="cid:inv@x"> -->'],
    ['a CSS background', '<style>.x{background:url(cid:inv@x)}</style>'],
    ['a media query that never applies', '<style>@media not all{.x{background:url(cid:inv@x)}}</style>'],
    ['a srcset candidate', '<img srcset="cid:inv@x 2x" src="other.png">'],
  ])('leads with a file whose cid only appears in %s', (_label, html) => {
    const parts = [
      att({ part: '2', filename: 'invoice.pdf', contentType: 'application/pdf', size: 1234, cid: 'inv@x', disposition: 'inline' }),
    ]
    const model = listFor(parts, html)
    expect(model.total).toBe(1)
    expect(model.visible.map(a => a.part)).toEqual(['2'])
    expect(model.canExpand).toBe(false)
  })

  it('leads with two same-looking files the sender declared identically', () => {
    const parts = [
      att({ part: '2', filename: 'report.pdf', contentType: 'application/pdf', size: 4096, disposition: 'attachment' }),
      att({ part: '3', filename: 'report.pdf', contentType: 'application/pdf', size: 4096, disposition: 'attachment' }),
    ]
    const model = listFor(parts, '<p>hi</p>')
    expect(model.total).toBe(2)
    expect(model.visible).toHaveLength(2)
  })

  // `Content-Disposition: attachment` is never demoted, whatever the body does
  // with its cid.
  it('leads with a cid-bearing part that is marked as an attachment', () => {
    const parts = [
      att({ part: '2', filename: 'invoice.pdf', contentType: 'application/pdf', size: 1234, cid: 'inv@x', disposition: 'attachment' }),
      ...inlineImages(10),
    ]
    const html = `<img src="cid:inv@x">${inlineImages(10).map(a => `<img src="cid:${a.cid}">`).join('')}`
    const model = listFor(parts, html)
    expect(model.visible.map(a => a.part)).toEqual(['2'])
    expect(model.total).toBe(11)
  })

  it('leads with a part whose disposition never said inline', () => {
    const parts = [
      att({ part: '2', filename: 'logo.png', contentType: 'image/png', size: 4096, cid: 'logo@x' }),
    ]
    const model = listFor(parts, '<img src="cid:logo@x">')
    expect(model.visible.map(a => a.part)).toEqual(['2'])
  })

  // Parameters on the disposition are ordinary — `inline; filename=...` is
  // still inline.
  it('demotes an inline part whose disposition carries a filename parameter', () => {
    const parts = [
      att({ part: '2', filename: 'logo.png', contentType: 'image/png', cid: 'logo@x', disposition: 'inline; filename="logo.png"' }),
      att({ part: '3', filename: 'agenda.pdf', contentType: 'application/pdf', disposition: 'attachment' }),
    ]
    const model = listFor(parts, '<img src="cid:logo@x">')
    expect(model.items.map(a => a.part)).toEqual(['3', '2'])
    expect(model.visible.map(a => a.part)).toEqual(['3'])
  })

  // Past the ceiling nothing is fetched, so nothing is substituted, so nothing
  // is demoted. The overflow parts lead the row.
  it('leads with every inline image past the inlining ceiling', () => {
    const parts = Array.from({ length: MAX_INLINE_CID_PARTS + 5 }, (_, i) =>
      layoutImage(`2.${i}`, `img-${i}.png`, `img${i}@x`),
    )
    const html = parts.map(a => `<img src="cid:${a.cid}">`).join('')
    const model = listFor(parts, html)
    expect(model.total).toBe(MAX_INLINE_CID_PARTS + 5)
    expect(model.items.slice(0, 5).map(a => a.cid)).toEqual([
      'img25@x', 'img26@x', 'img27@x', 'img28@x', 'img29@x',
    ])
    expect(model.visible).toHaveLength(ATTACHMENT_COLLAPSED_LIMIT)
  })
})
