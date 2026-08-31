import { describe, it, expect, vi } from 'vitest'
import { diffWords } from 'diff'
import {
  applyComposeDiff,
  changedBlockIds,
  diffComposeText,
  segmentComposeEdit,
  summarizeEqualBlock,
  COMPOSE_DIFF_COLLAPSE_MIN_CHARS,
  type ComposeDiffBlock,
  type ComposeDiffSegment,
} from './composeDiff'
import { applyComposeEdits, composeEditId } from './index'
import { splitComposeBody, joinComposeBody } from './composeBody'

/** Compact rendering of segments, so expectations read like the markup. */
function render(segments: readonly ComposeDiffSegment[]): string {
  return segments
    .map(s => (s.op === 'equal' ? s.text : s.op === 'delete' ? `[-${s.text}]` : `[+${s.text}]`))
    .join('')
}

function kinds(blocks: readonly ComposeDiffBlock[]): string[] {
  return blocks.map(b => b.kind)
}

describe('segmentComposeEdit — word level with semantic cleanup', () => {
  it('marks only the words that changed, not the whole sentence', () => {
    const segments = segmentComposeEdit(
      'we can ship the colour picker by Friday',
      'we can ship the color picker by Friday',
    )
    expect(render(segments)).toBe('we can ship the [-colour][+color] picker by Friday')
  })

  it('joins letter-level scraps back into whole words (semantic cleanup)', () => {
    // Without cleanup this comes back as `отч[-ё][+е]т.` — one letter removed,
    // one added, in the middle of a word. That is the fragmentation AC (b)
    // rules out.
    const segments = segmentComposeEdit('Проверь отчёт.', 'Проверь отчет.')
    expect(render(segments)).toBe('Проверь [-отчёт.][+отчет.]')
  })

  it('bridges a single space between two neighbouring edits', () => {
    // Raw output splits this into "-don't", "= ", "+not " — three pieces the
    // reader has to reassemble into one contraction expansion.
    const segments = segmentComposeEdit("I don't know", 'I do not know')
    expect(render(segments)).toBe("I [-don't ][+do not ]know")
  })

  it('does not expand a pure insertion to swallow its neighbours', () => {
    const segments = segmentComposeEdit('спасибо за письмо', 'спасибо за ваше письмо')
    expect(render(segments)).toBe('спасибо за [+ваше ]письмо')
  })

  it('bridges a two-space gap between two neighbouring edits (the other half of BRIDGEABLE_GAP_RE)', () => {
    // The single-space branch is covered above ("I don't know" -> "I do not
    // know"). BRIDGEABLE_GAP_RE also accepts a run of exactly two spaces/tabs.
    // The gap must sit ISOLATED between two edit regions for rule 1 to see it at
    // all (an edit followed by two spaces then unchanged text, e.g. "...know",
    // never isolates a bare two-space equal segment — the library reports the
    // spaces merged with the following unchanged word instead). Two edits
    // either side of the gap does isolate it.
    const segments = segmentComposeEdit("please don't  go now", 'please do not  leave now')
    expect(render(segments)).toBe("please [-don't  go][+do not  leave] now")
  })

  it('does not expand a pure deletion to swallow its neighbours', () => {
    const segments = segmentComposeEdit('please send it right now', 'please send it now')
    expect(render(segments)).toBe('please send it [-right ]now')
  })

  it('treats an empty side as a whole-text insertion or deletion', () => {
    expect(segmentComposeEdit('', 'new text')).toEqual([{ op: 'insert', text: 'new text' }])
    expect(segmentComposeEdit('old text', '')).toEqual([{ op: 'delete', text: 'old text' }])
    expect(segmentComposeEdit('', '')).toEqual([])
  })

  it('is byte-exact on BOTH sides — whitespace is never normalized away', () => {
    const cases: Array<[string, string]> = [
      ['   leading and trailing   ', 'leading and trailing'],
      ['tabs\there', 'tabs  here'],
      ['line one\nline two', 'line 1\nline two here'],
      ['Привет, Анна! Проверь пожалуйста отчёт.', 'Привет, Анна. Проверь, пожалуйста, отчет.'],
      ['Meeting at 10:30 on Monday.', 'Meeting at 11:30 on Tuesday.'],
      ['a', 'b'],
      ['CRLF stays\r\nintact\r\n', 'CRLF stays\r\nintact here\r\n'],
    ]
    for (const [before, after] of cases) {
      const segments = segmentComposeEdit(before, after)
      const rebuiltBefore = segments.filter(s => s.op !== 'insert').map(s => s.text).join('')
      const rebuiltAfter = segments.filter(s => s.op !== 'delete').map(s => s.text).join('')
      expect(rebuiltBefore).toBe(before)
      expect(rebuiltAfter).toBe(after)
    }
  })

  it('never emits an empty segment or two neighbours with the same op', () => {
    const segments = segmentComposeEdit(
      'Hi Anna, I don\'t know if we can ship the colour picker by Friday.',
      'Hi Anna, I do not know whether we can ship the color picker by Friday.',
    )
    expect(segments.every(s => s.text.length > 0)).toBe(true)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].op).not.toBe(segments[i - 1].op)
    }
  })

  it('orders a replacement as removal-then-addition, whatever the library emitted', () => {
    const segments = segmentComposeEdit('alpha beta gamma', 'alpha BETA gamma')
    const ops = segments.map(s => s.op)
    expect(ops).toEqual(['equal', 'delete', 'insert', 'equal'])
  })
})

describe('the word level never reaches across a paragraph boundary', () => {
  it('does not match a word in paragraph one against the same word in paragraph two', () => {
    // The decisive construction: each line's own words are absent from its
    // counterpart but present in the OTHER line's counterpart. A word diff over
    // the run as one piece will happily pair `alpha` with `alpha` across the
    // line break and shred both lines; a per-paragraph one cannot.
    const before = 'alpha first line\nbravo second line\n'
    const after = 'bravo first line\nalpha second line\n'
    const segments = segmentComposeEdit(before, after)
    expect(render(segments)).toBe('[-alpha][+bravo] first line\n[-bravo][+alpha] second line\n')
  })

  it('keeps swapped modified lines positionally isolated', () => {
    // The test above is NOT decisive on its own: the shared filler ("first
    // line" / "second line") anchors a Myers alignment positionally at the
    // line boundary even when the whole two-line run is compared as ONE
    // piece, so a per-paragraph diff and a whole-run diff produce the exact
    // same rendering for that fixture (verified: reverting `segmentPerLine`
    // to always return null does not turn it red).
    //
    // This fixture removes the anchor. Each line is nothing but the swapped,
    // modified token -- so a whole-run comparison finds `bravo` sitting
    // unmodified in `before` line 2 and ALSO present verbatim inside
    // `bravo!` in `after` line 1, and happily matches it across the line
    // break as an `equal` token, rendering
    // `[-alpha\n]bravo[+!]\n[+alpha!\n]` -- `bravo` never shows as changed at
    // all. A per-paragraph diff cannot do this: line 0 is word-diffed against
    // line 0 only, so `bravo` (only present in `after` line 0) can never be
    // matched against `bravo` in `before` line 1.
    const before = 'alpha\nbravo\n'
    const after = 'bravo!\nalpha!\n'
    const segments = segmentComposeEdit(before, after)
    expect(render(segments)).toBe('[-alpha][+bravo!]\n[-bravo][+alpha!]\n')
  })

  it('segments each paragraph on its own when the rewrite left the paragraph structure alone', () => {
    const before = 'Пункт 1: мы посмотрим отчёт.\nПункт 2: мы посмотрим отчёт.\n'
    const after = 'Пункт 1: мы изучим отчет.\nПункт 2: мы изучим отчет.\n'
    expect(render(segmentComposeEdit(before, after))).toBe(
      'Пункт 1: мы [-посмотрим отчёт.][+изучим отчет.]\nПункт 2: мы [-посмотрим отчёт.][+изучим отчет.]\n',
    )
  })

  it('still compares a boundary-moving rewrite as one piece (paragraphs merged)', () => {
    // Two lines becoming one: there is no line-to-line correspondence to keep,
    // so the whole run is compared together and the shared words still match.
    const before = 'I looked at the report.\nIt seems fine.\n'
    const after = 'I looked at the report and it seems fine.\n'
    const segments = segmentComposeEdit(before, after)
    const rendered = render(segments)
    // Words shared by the two paragraphs are still matched to each other, which
    // is only possible because the run was NOT split at the vanished boundary.
    expect(rendered).toContain('I looked at the ')
    expect(rendered).toContain('seems fine.')
    expect(segments.filter(s => s.op !== 'equal').length).toBeGreaterThan(0)
  })

  it('keeps word matching inside consecutive changed paragraphs (three-paragraph run, N:N)', () => {
    // Same decisive construction as above, extended to THREE consecutive lines
    // cyclically shifted, exercised through diffComposeText (the function that
    // actually groups a run of adjacent changed lines into one block before
    // handing it to the word level). If the block's whole 3-line run were
    // word-diffed as one piece instead of per paragraph, a word from paragraph
    // 1 could match the same word surfacing in paragraph 2's or 3's rewrite.
    const before = 'alpha first line\nbravo second line\ncharlie third line\n'
    const after = 'charlie first line\nalpha second line\nbravo third line\n'
    const { blocks, changeCount } = diffComposeText(before, after)
    expect(changeCount).toBe(1)
    expect(blocks[0].kind).toBe('replace')
    expect(render(blocks[0].segments)).toBe(
      '[-alpha][+charlie] first line\n[-bravo][+alpha] second line\n[-charlie][+bravo] third line\n',
    )
  })

  it('still compares a three-paragraph run as one piece when the edit merges them (N:M, paired with the N:N case above)', () => {
    // Three paragraphs collapse into one: there is no line-to-line
    // correspondence left to respect, so the run is compared as ONE piece and
    // words shared across the vanished boundaries are still matched to each
    // other -- the legitimate use of the N:M path this discriminator exists for.
    const before = 'I looked at the report.\nIt seems fine.\nThanks for checking.\n'
    const after = 'I looked at the report, it seems fine, and thanks for checking.\n'
    const { blocks, changeCount } = diffComposeText(before, after)
    expect(changeCount).toBe(1)
    expect(blocks[0].kind).toBe('replace')
    // "I looked at the ", "seems " and "for checking." are matched as `equal`
    // across what used to be paragraph boundaries -- only possible because the
    // whole 3-line run was compared as one piece, never split per line.
    expect(render(blocks[0].segments)).toBe(
      'I looked at the [-report.\nIt ][+report, it ]seems [-fine.\nThanks ][+fine, and thanks ]for checking.\n',
    )
    expect(blocks.map(b => b.before).join('')).toBe(before)
    expect(blocks.map(b => b.after).join('')).toBe(after)
  })

  it('keeps both round trips exact on the per-paragraph path', () => {
    const cases: Array<[string, string]> = [
      ['one\ntwo\nthree\n', 'ONE\nTWO\nTHREE\n'],
      ['a\nb\n', 'b\na\n'],
      ['line\r\nline two\r\n', 'line one\r\nline 2\r\n'],
      ['first\n\nsecond\n', 'FIRST\n\nSECOND\n'],
      ['keep\nchange me\n', 'keep\nchanged\n'],
    ]
    for (const [before, after] of cases) {
      const segments = segmentComposeEdit(before, after)
      expect(segments.filter(s => s.op !== 'insert').map(s => s.text).join('')).toBe(before)
      expect(segments.filter(s => s.op !== 'delete').map(s => s.text).join('')).toBe(after)
    }
  })
})

describe("Fraser's squeezed equality — the scraps the other two rules cannot reach", () => {
  it('heals a letter stranded between a deletion and an insertion (the Cyrillic case)', () => {
    // `посмотрим` → `изучим` arrives from the library as
    // `[-посмотр]и[+зучи]м`: the shared `и` is a whole TOKEN, because Cyrillic
    // is outside jsdiff's extendedWordChars and so tokenizes per character.
    // Rules 1 and 2 both decline here — the gap is not whitespace, and neither
    // neighbour is a replacement — which is exactly the hole rule 3 fills.
    expect(render(segmentComposeEdit('мы посмотрим завтра', 'мы изучим завтра'))).toBe(
      'мы [-посмотрим][+изучим] завтра',
    )
  })

  it('is not a Cyrillic special case — it keys on lengths, not on script', () => {
    // Greek is outside extendedWordChars too, and produces the same shape:
    // `[-σήμερ]α[+ύριο]` without this rule.
    expect(render(segmentComposeEdit('έτοιμη σήμερα', 'έτοιμη αύριο'))).toBe(
      'έτοιμη [-σήμερα][+αύριο]',
    )
    // And plain ASCII, when the alignment strands a whole word between a
    // deletion and an insertion — here the raw diff is `-alpha `, `=beta`,
    // `+ alpha`, which reads as shredded interleaving without the rule.
    expect(render(segmentComposeEdit('alpha beta', 'beta alpha'))).toBe(
      '[-alpha beta][+beta alpha]',
    )
  })

  it('leaves a real island of unchanged text between two independent edits alone', () => {
    // The threshold earns its keep here: ` что это ` is 9 characters, longer
    // than the 7-character edit on its left, so Fraser's test fails and the two
    // edits stay two edits. Collapsing this would turn the panel into a
    // before/after box, which is the thing it replaced.
    expect(render(segmentComposeEdit('я думаю что это хорошая идея', 'я полагаю что это отличная идея'))).toBe(
      'я [-думаю][+полагаю] что это [-хорошая][+отличная] идея',
    )
    expect(render(segmentComposeEdit(
      'we can ship the colour picker by Friday',
      'we can send the color picker by Monday',
    ))).toBe('we can [-ship][+send] the [-colour][+color] picker by [-Friday][+Monday]')
  })

  it('never reports an untouched word as changed (why the rule is narrower than Fraser\'s)', () => {
    // Applied verbatim, the rule cascades through the spaces between
    // neighbouring edits: this pair collapses to
    // `I [-don't know if][+do not know whether] we can...`, telling the reader
    // that `know` changed when it did not. Restricting it to whitespace-free
    // runs keeps `know` outside both edits.
    const rendered = render(segmentComposeEdit(
      "I don't know if we can ship it",
      'I do not know whether we can ship it',
    ))
    expect(rendered).toContain('know')
    expect(rendered).not.toContain("[-don't know")
    expect(rendered).not.toContain('[+do not know')
  })

  it('keeps both round trips exact', () => {
    const cases: Array<[string, string]> = [
      ['мы посмотрим отчёт и вернёмся завтра.', 'мы изучим отчет и ответим завтра.'],
      ['alpha beta', 'beta alpha'],
      ['έτοιμη σήμερα', 'έτοιμη αύριο'],
      ['本日の報告書を確認しました', '本日のレポートを拝見しました'],
      ['a  b  c', 'x  b  y'],
    ]
    for (const [before, after] of cases) {
      const segments = segmentComposeEdit(before, after)
      expect(segments.filter(s => s.op !== 'insert').map(s => s.text).join('')).toBe(before)
      expect(segments.filter(s => s.op !== 'delete').map(s => s.text).join('')).toBe(after)
    }
  })
})

describe('word-boundary expansion declines where "run of non-whitespace" is not a word', () => {
  it('marks one changed character in a Japanese paragraph, not the whole paragraph', () => {
    // Japanese puts no spaces between words, so the whole paragraph is a single
    // run of non-whitespace. Expanding an edit to "word boundaries" there would
    // restate the entire paragraph as removed-and-re-added.
    const before = '来週の会議は月曜日に行います。資料は事前に共有します。'
    const after = '来週の会議は火曜日に行います。資料は事前に共有します。'
    const segments = segmentComposeEdit(before, after)
    const touched = segments.filter(s => s.op !== 'equal').map(s => s.text).join('')
    expect(touched.length).toBeLessThan(6)
    expect(render(segments)).toContain('[-月][+火]')
  })

  it('does not swallow a long unbroken run such as a URL', () => {
    const before = 'see https://example.com/a/very/long/path/that/keeps/going/for/a/while?x=1 ok'
    const after = 'see https://example.com/a/very/long/path/that/keeps/going/for/a/while?x=2 ok'
    const segments = segmentComposeEdit(before, after)
    const touched = segments.filter(s => s.op !== 'equal').map(s => s.text).join('')
    expect(touched.length).toBeLessThan(10)
  })

  it('does not expand a one-character CJK edit to the whole paragraph', () => {
    // Stronger than the "one changed character" test above: pin the actual
    // amount of text that stays `equal` (paragraph length minus the one edited
    // character) and prove both sides still round-trip. Removing the
    // SPACELESS_SCRIPT_RE guard from isExpandableWordFragment would let rule 2
    // absorb this whole (< 48 char) whitespace-free run into the edit, which
    // would shrink `equalText` far below this figure.
    const before = '来週の会議は月曜日に行います。資料は事前に共有します。'
    const after = '来週の会議は火曜日に行います。資料は事前に共有します。'
    const segments = segmentComposeEdit(before, after)
    const equalText = segments.filter(s => s.op === 'equal').map(s => s.text).join('')
    expect(equalText.length).toBe(before.length - 1)
    const rebuiltBefore = segments.filter(s => s.op !== 'insert').map(s => s.text).join('')
    const rebuiltAfter = segments.filter(s => s.op !== 'delete').map(s => s.text).join('')
    expect(rebuiltBefore).toBe(before)
    expect(rebuiltAfter).toBe(after)
  })

  it('still expands over an ordinary long word (the ceiling clears real vocabulary)', () => {
    const segments = segmentComposeEdit(
      'die Rechtsschutzversicherung zahlt',
      'die Rechtsschutzversicherungen zahlt',
    )
    expect(render(segments)).toBe(
      'die [-Rechtsschutzversicherung][+Rechtsschutzversicherungen] zahlt',
    )
  })
})

describe('cost ceilings — a bail-out is coarse but never wrong', () => {
  it('falls back to a whole-region replacement when the word-level edit distance blows the ceiling', () => {
    // Two long texts with nothing in common: the edit script is larger than the
    // ceiling, so the library gives up and we report the honest coarse answer.
    const before = 'абвгдежзийклмнопрстуфхцчшщэюя '.repeat(60)
    const after = 'zyxwvutsrqponmlkjihgfedcba '.repeat(60)
    const segments = segmentComposeEdit(before, after)
    expect(segments).toEqual([
      { op: 'delete', text: before },
      { op: 'insert', text: after },
    ])
  })

  it('falls back to one whole-text block when the line-level edit distance blows the ceiling', () => {
    const before = Array.from({ length: 600 }, (_, i) => `original line ${i}`).join('\n')
    const after = Array.from({ length: 600 }, (_, i) => `rewritten line ${i}`).join('\n')
    const { blocks, changeCount, identical } = diffComposeText(before, after)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('replace')
    expect(identical).toBe(false)
    expect(changeCount).toBe(1)
    // The bail-out is a rendering decision, never a correctness one.
    expect(blocks.map(b => b.before).join('')).toBe(before)
    expect(blocks.map(b => b.after).join('')).toBe(after)
    expect(applyComposeDiff(blocks, new Set())).toBe(before)
    expect(applyComposeDiff(blocks, new Set(changedBlockIds(blocks)))).toBe(after)
  })

  it('falls back when diffWordsWithSpace returns undefined', async () => {
    // The two existing bail-out tests above use texts so unrelated that they
    // ALSO render as a whole-region replacement without any maxEditLength
    // ceiling in effect -- they do not pin that the `!parts` branch actually
    // ran (verified: removing the `if (!parts) return wholeRegionReplacement`
    // guard from `segmentOnePiece` does not turn either of them red; the
    // library still returns a real, disjoint diff for those fixtures and the
    // code path that consumes it never executes). This test forces the
    // branch directly: `diffWordsWithSpace` is mocked to return `undefined`
    // for otherwise perfectly ordinary short text, which the real library
    // would never do.
    vi.resetModules()
    vi.doMock('diff', async () => {
      const actual = await vi.importActual<typeof import('diff')>('diff')
      return { ...actual, diffWordsWithSpace: () => undefined }
    })
    try {
      const mocked = await import('./composeDiff')
      const before = 'short before text'
      const after = 'short after text'
      const segments = mocked.segmentComposeEdit(before, after)
      expect(segments).toEqual([
        { op: 'delete', text: before },
        { op: 'insert', text: after },
      ])
      const rebuiltBefore = segments.filter(s => s.op !== 'insert').map(s => s.text).join('')
      const rebuiltAfter = segments.filter(s => s.op !== 'delete').map(s => s.text).join('')
      expect(rebuiltBefore).toBe(before)
      expect(rebuiltAfter).toBe(after)
    } finally {
      vi.doUnmock('diff')
      vi.resetModules()
    }
  })

  it('falls back when diffArrays returns undefined', async () => {
    // Same reasoning as above, for the line level: the existing 600-line
    // bail-out test renders as one changed block even without a ceiling
    // (verified: removing the `if (!parts) {...}` guard from
    // `diffComposeText` does not turn it red -- the library still returns a
    // real diff whose one changed run happens to look identical). Force the
    // branch directly instead.
    vi.resetModules()
    vi.doMock('diff', async () => {
      const actual = await vi.importActual<typeof import('diff')>('diff')
      return { ...actual, diffArrays: () => undefined }
    })
    try {
      const mocked = await import('./composeDiff')
      const before = 'first paragraph\n\nsecond paragraph\n'
      const after = 'first paragraph changed\n\nsecond paragraph changed\n'
      const result = mocked.diffComposeText(before, after)
      expect(result.blocks).toHaveLength(1)
      expect(result.blocks[0].kind).toBe('replace')
      expect(result.identical).toBe(false)
      expect(result.changeCount).toBe(1)
      expect(result.blocks[0].before).toBe(before)
      expect(result.blocks[0].after).toBe(after)
      expect(mocked.applyComposeDiff(result.blocks, new Set())).toBe(before)
      expect(
        mocked.applyComposeDiff(result.blocks, new Set(mocked.changedBlockIds(result.blocks))),
      ).toBe(after)
    } finally {
      vi.doUnmock('diff')
      vi.resetModules()
    }
  })

  it('bounds the pathological inputs that used to take seconds', () => {
    // Not a benchmark with a tight threshold (CI machines vary) — a guard that
    // the ceilings are actually wired in. Unbounded, these three cost 1.8 s,
    // 1.1 s and 1.7 s respectively inside the diff library alone.
    const punctBefore = Array.from({ length: 2000 }, (_, i) => `a${i % 7},`).join('').slice(0, 6000)
    const punctAfter = Array.from({ length: 2000 }, (_, i) => `b${i % 7};`).join('').slice(0, 6000)
    const started = Date.now()
    segmentComposeEdit(punctBefore, punctAfter)
    segmentComposeEdit('漢'.repeat(4000), '字'.repeat(4000))
    diffComposeText(
      Array.from({ length: 60 }, (_, i) => `Пункт ${i}: мы посмотрим отчёт и вернёмся завтра.`).join('\n'),
      Array.from({ length: 60 }, (_, i) => `Пункт ${i}: мы изучим отчет и ответим завтра.`).join('\n'),
    )
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('cleanupSegments cascade — terminates within CLEANUP_MAX_PASSES', () => {
  it('terminates within the quick-action cap for cascading no-space edits', () => {
    // Several scattered single-character edits inside one long, whitespace-free
    // CJK run -- a shape realistic rewrites produce (touch a few places across
    // a paragraph) and the exact shape the module docblock's "## Why a fixed
    // number of sweeps" section is about: absorbing a fragment on one sweep can
    // qualify the next equal run for absorption on the NEXT sweep. This has to
    // resolve within CLEANUP_MAX_PASSES and within the render budget, without
    // the SPACELESS_SCRIPT_RE ceiling failing open and merging everything
    // between the first and last touched character into one giant replacement.
    const sentences = [
      '来週の会議は月曜日に行います',
      '資料は事前に共有します',
      '内容についてはメールでご案内します',
      '準備が整い次第ご連絡いたします',
      '出席者は五名を予定しています',
      'お手数ですがご確認くださいますようお願いいたします',
    ]
    const replacements = ['火', '水', '木', '金', '土', '日']
    const before = sentences.join('')
    const after = sentences.map((s, i) => s.slice(0, 2) + replacements[i] + s.slice(3)).join('')

    const started = Date.now()
    const segments = segmentComposeEdit(before, after)
    expect(Date.now() - started).toBeLessThan(2000)

    // Whatever the cap leaves behind is still a VALID diff: canonical shape,
    // exact round trip on both sides -- termination never trades correctness.
    expect(segments.every(s => s.text.length > 0)).toBe(true)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].op).not.toBe(segments[i - 1].op)
    }
    const rebuiltBefore = segments.filter(s => s.op !== 'insert').map(s => s.text).join('')
    const rebuiltAfter = segments.filter(s => s.op !== 'delete').map(s => s.text).join('')
    expect(rebuiltBefore).toBe(before)
    expect(rebuiltAfter).toBe(after)

    // The six scattered edits stay six SMALL, separate edits -- a runaway
    // cascade (or a mis-capped one) would instead merge the whole span between
    // the first and last touched character into a couple of giant blocks.
    const changed = segments.filter(s => s.op !== 'equal')
    expect(changed).toHaveLength(sentences.length * 2)
    for (const seg of changed) expect(seg.text.length).toBe(1)
  })

  it('stops a seven-stage leftward cleanup cascade after six sweeps', async () => {
    // The test above does not pin the CLEANUP_MAX_PASSES=6 ceiling itself:
    // its six scattered CJK edits are separated by long equal runs, so each
    // one qualifies for rule 3 independently in pass 1 -- there is no
    // dependency chain, and the whole thing would resolve in one sweep with
    // no cap at all (verified: raising CLEANUP_MAX_PASSES to 7 does not
    // change that test's outcome).
    //
    // A real multi-pass cascade needs one rule-2 firing to CREATE the
    // condition the next firing depends on, one sweep later and one position
    // further left -- exactly the mechanism the module docblock describes
    // ("absorbing a fragment turns a pure insertion into a replacement,
    // which then qualifies its own left-hand gap for rule 2 -- a gap this
    // sweep has already walked past"). Reproducing that with a real
    // diffWordsWithSpace output is impractical to aim precisely, so this
    // test mocks the raw diff and builds the seven-stage chain by hand:
    //
    //   insert(P1) equal(g1) insert(P2) equal(g2) ... insert(P7) equal(g7) delete(D) insert(E)
    //
    // Only the region to a gap's right can be a "replacement" at the start
    // (the trailing anchor `delete(D) insert(E)`), so only g7 -- the
    // rightmost gap -- qualifies for rule 2 in pass 1. Absorbing it turns
    // the (P7, anchor) run into a replacement, which is what lets g6 qualify
    // in pass 2, and so on, walking one stage further left every sweep:
    // pass 1 -> g7, pass 2 -> g6, ..., pass 6 -> g2. Resolving the seventh
    // and final gap, g1, would need a 7th sweep that CLEANUP_MAX_PASSES does
    // not grant.
    //
    // P_i are single characters (so an untouched pair of neighbouring pure
    // insertions never satisfies rule 3's `length <= max(del, ins)` on its
    // own -- max is 1, the 2-character gaps never qualify) and g_i are two
    // characters (word-shaped, no whitespace, so rule 1 -- which only
    // bridges 1-2 SPACES -- never fires either). This isolates the cascade to
    // rule 2 alone, so what stops it is unambiguously the sweep cap.
    const P = ['p', 'q', 'r', 's', 't', 'u', 'v']
    const G = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7']
    const D = 'd'
    const E = 'e'

    const rawParts: Array<{ value: string; added?: boolean; removed?: boolean }> = []
    for (let i = 0; i < 7; i++) {
      rawParts.push({ value: P[i], added: true, removed: false })
      rawParts.push({ value: G[i], added: false, removed: false })
    }
    rawParts.push({ value: D, added: false, removed: true })
    rawParts.push({ value: E, added: true, removed: false })

    const before = G.join('') + D
    const after = P.map((p, i) => p + G[i]).join('') + E

    vi.resetModules()
    vi.doMock('diff', async () => {
      const actual = await vi.importActual<typeof import('diff')>('diff')
      return { ...actual, diffWordsWithSpace: () => rawParts }
    })
    try {
      const mocked = await import('./composeDiff')
      const segments = mocked.segmentComposeEdit(before, after)

      // Still a valid, byte-exact diff -- termination trades legibility, never
      // correctness. Canonical shape holds too (alternating ops, no empties).
      expect(segments.every(s => s.text.length > 0)).toBe(true)
      for (let i = 1; i < segments.length; i++) {
        expect(segments[i].op).not.toBe(segments[i - 1].op)
      }
      const rebuiltBefore = segments.filter(s => s.op !== 'insert').map(s => s.text).join('')
      const rebuiltAfter = segments.filter(s => s.op !== 'delete').map(s => s.text).join('')
      expect(rebuiltBefore).toBe(before)
      expect(rebuiltAfter).toBe(after)

      // The residual equality IS the evidence the cap fired: with an
      // unbounded budget the 7th sweep would absorb g1 too and P1 would fuse
      // into the same mega-replacement as everything else, leaving a single
      // delete/insert pair and no equal segment at all (verified below by
      // raising the cap). Capped at 6, stage 1 (P1, g1) is exactly what the
      // cascade never reaches.
      expect(segments).toEqual([
        { op: 'insert', text: 'p' },
        { op: 'equal', text: 'g1' },
        { op: 'delete', text: 'g2g3g4g5g6g7d' },
        { op: 'insert', text: 'qg2rg3sg4tg5ug6vg7e' },
      ])
    } finally {
      vi.doUnmock('diff')
      vi.resetModules()
    }
  })
})

describe('why diffWordsWithSpace, not diffWords (module docblock claim, checked against the library)', () => {
  it('diffWords cannot reconstruct the original byte-for-byte; diffWordsWithSpace (what segmentComposeEdit uses) can', () => {
    // The docblock claims diffWords "normalizes [whitespace] to the after
    // side and therefore cannot reproduce the before string at all". Proven
    // directly against the library, not on faith: rebuild `before` from a raw
    // diffWords() result and show it does NOT match, then show
    // segmentComposeEdit's own reconstruction DOES match. If composeDiff ever
    // switched to diffWords, this second half would start failing exactly the
    // way the first half already does.
    const before = '   leading and trailing   '
    const after = 'leading and trailing'

    const rawWords = diffWords(before, after)
    const rebuiltFromWords = rawWords.filter(p => !p.added).map(p => p.value).join('')
    expect(rebuiltFromWords).not.toBe(before)

    const segments = segmentComposeEdit(before, after)
    const rebuiltFromOurs = segments.filter(s => s.op !== 'insert').map(s => s.text).join('')
    expect(rebuiltFromOurs).toBe(before)
  })
})

describe('diffComposeText — paragraph alignment', () => {
  it('keeps untouched paragraphs whole and marks only the rewritten one', () => {
    const before = 'First paragraph, untouched.\n\nSecond paragraph, reworded here.\n\nThird, untouched.'
    const after = 'First paragraph, untouched.\n\nSecond paragraph, rephrased here.\n\nThird, untouched.'
    const { blocks, changeCount } = diffComposeText(before, after)
    expect(kinds(blocks)).toEqual(['equal', 'replace', 'equal'])
    expect(changeCount).toBe(1)
    expect(render(blocks[1].segments)).toBe(
      'Second paragraph, [-reworded][+rephrased] here.\n',
    )
  })

  it('does not degenerate into "the whole paragraph changed" for one long line', () => {
    // The point of the second level: an email paragraph is one line, so a
    // line-only comparison would highlight all of it.
    const before = 'Thanks for the update, I will review the draft and get back to you tomorrow.'
    const after = 'Thanks for the update. I will review the draft and reply tomorrow.'
    const { blocks } = diffComposeText(before, after)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('replace')
    const equalText = blocks[0].segments.filter(s => s.op === 'equal').map(s => s.text).join('')
    expect(equalText.length).toBeGreaterThan(30)
  })

  it('reports a pure insertion and a pure deletion of whole paragraphs', () => {
    const inserted = diffComposeText('One.\n', 'One.\nTwo.\n')
    expect(kinds(inserted.blocks)).toEqual(['equal', 'insert'])
    expect(inserted.blocks[1].before).toBe('')
    expect(inserted.blocks[1].after).toBe('Two.\n')

    const deleted = diffComposeText('One.\nTwo.\n', 'One.\n')
    expect(kinds(deleted.blocks)).toEqual(['equal', 'delete'])
    expect(deleted.blocks[1].before).toBe('Two.\n')
    expect(deleted.blocks[1].after).toBe('')
  })

  it('treats a run of adjacent line changes as ONE reviewable edit', () => {
    // A rewrite that merges two paragraphs into one must not read as three
    // separate edits the user has to accept one by one.
    const before = 'I looked at the report.\nIt seems fine.\n'
    const after = 'I looked at the report and it seems fine.\n'
    const { blocks, changeCount } = diffComposeText(before, after)
    expect(changeCount).toBe(1)
    expect(blocks[0].kind).toBe('replace')
    expect(blocks[0].before).toBe(before)
    expect(blocks[0].after).toBe(after)
  })

  it('reports an identical rewrite as nothing to review', () => {
    const result = diffComposeText('same text', 'same text')
    expect(result.identical).toBe(true)
    expect(result.changeCount).toBe(0)
    expect(kinds(result.blocks)).toEqual(['equal'])
  })

  it('handles both sides empty without inventing a block', () => {
    const result = diffComposeText('', '')
    expect(result.blocks).toEqual([])
    expect(result.identical).toBe(true)
  })

  it('gives every block a distinct id', () => {
    const { blocks } = diffComposeText('a\nb\nc\n', 'a\nB\nc\nd\n')
    const ids = blocks.map(b => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('surfaces a whitespace-only change as an edit rather than reporting it as identical', () => {
    // A double space collapsed to one is invisible to a careless glance, but
    // it IS a change: silently swallowing it into an "equal" block would make
    // the "nothing to review" state (`identical: true`) lie.
    const { blocks, changeCount, identical } = diffComposeText('one  two\n', 'one two\n')
    expect(identical).toBe(false)
    expect(changeCount).toBe(1)
    expect(blocks.map(b => b.before).join('')).toBe('one  two\n')
    expect(blocks.map(b => b.after).join('')).toBe('one two\n')
  })

  it('reports a whole-text insertion when before is empty, and a whole-text deletion when after is empty', () => {
    const inserted = diffComposeText('', 'brand new paragraph')
    expect(kinds(inserted.blocks)).toEqual(['insert'])
    expect(inserted.blocks[0].before).toBe('')
    expect(inserted.blocks[0].after).toBe('brand new paragraph')

    const deleted = diffComposeText('everything removed', '')
    expect(kinds(deleted.blocks)).toEqual(['delete'])
    expect(deleted.blocks[0].before).toBe('everything removed')
    expect(deleted.blocks[0].after).toBe('')
  })
})

describe('§2.78 regression — composeDiff never sees or touches the quote/forward/signature tail', () => {
  it('rewriting only the own part (via splitComposeBody) leaves a quoted original, its attribution, and a signature byte-identical', () => {
    const original = 'Thanks for the update, I will review the draft and get back to you tomorrow.'
    const rewritten = 'Thanks for the update. I will review the draft and reply tomorrow.'
    const tail = 'On Mon, Jan 5, 2026, Anna wrote:\n> Please check the attached report.\n> Let me know by Friday.\n\n--\nJohn Doe'
    const body = `${original}\n\n${tail}`

    const split = splitComposeBody(body)
    expect(split.own).toBe(original) // composeBody already drew the line; composeDiff must not need to redraw it

    const { blocks } = diffComposeText(split.own, rewritten)
    const rewrittenOwn = applyComposeDiff(blocks, new Set(changedBlockIds(blocks)))
    expect(rewrittenOwn).toBe(rewritten)

    const finalBody = joinComposeBody(split, rewrittenOwn)
    expect(finalBody).toBe(`${rewritten}\n\n${tail}`)
    // The tail bytes themselves, not just "look the same" — identical substring.
    expect(finalBody.slice(finalBody.indexOf('On Mon'))).toBe(body.slice(body.indexOf('On Mon')))
  })

  it('has no boundary detector of its own — a quote-prefixed line handed to it directly is diffed like ordinary text, not specially preserved', () => {
    // If composeDiff grew a second detector for '>' lines (the thing the
    // module docblock forbids), this line would come back unchanged or
    // vanish from the diff instead of being reported as an edit.
    const before = '> quoted line one\n> quoted line two\n'
    const after = '> quoted line one\n> quoted line CHANGED\n'
    const { blocks, changeCount } = diffComposeText(before, after)
    expect(changeCount).toBeGreaterThan(0)
    expect(blocks.map(b => b.before).join('')).toBe(before)
    expect(blocks.map(b => b.after).join('')).toBe(after)
  })
})

describe('round-trip contract (the guarantee per-edit acceptance rests on)', () => {
  const cases: Array<[string, string]> = [
    ['One.\n\nTwo.\n', 'One!\n\nTwo, revised.\n'],
    ['', 'written from scratch'],
    ['deleted entirely', ''],
    ['a\nb\nc', 'c\nb\na'],
    ['CRLF draft\r\nsecond line\r\n', 'CRLF draft\r\nsecond line rewritten\r\n'],
    ['   ragged   spacing   ', 'ragged spacing'],
    ['same', 'same'],
    ['trailing newline\n', 'trailing newline'],
  ]

  it('concatenating the blocks reproduces both inputs byte for byte', () => {
    for (const [before, after] of cases) {
      const { blocks } = diffComposeText(before, after)
      expect(blocks.map(b => b.before).join('')).toBe(before)
      expect(blocks.map(b => b.after).join('')).toBe(after)
    }
  })

  it('accepting nothing yields the original; accepting everything yields the rewrite', () => {
    for (const [before, after] of cases) {
      const { blocks } = diffComposeText(before, after)
      expect(applyComposeDiff(blocks, new Set())).toBe(before)
      expect(applyComposeDiff(blocks, new Set(changedBlockIds(blocks)))).toBe(after)
    }
  })

  it('accepting one edit takes that block from the rewrite and leaves the rest alone', () => {
    const before = 'Alpha line.\nBeta line.\nGamma line.\n'
    const after = 'Alpha line changed.\nBeta line.\nGamma line changed.\n'
    const { blocks } = diffComposeText(before, after)
    const changed = changedBlockIds(blocks)
    expect(changed).toHaveLength(2)

    expect(applyComposeDiff(blocks, new Set([changed[0]]))).toBe(
      'Alpha line changed.\nBeta line.\nGamma line.\n',
    )
    expect(applyComposeDiff(blocks, new Set([changed[1]]))).toBe(
      'Alpha line.\nBeta line.\nGamma line changed.\n',
    )
  })

  it('ignores an id that is not a changed block (stale selection is inert, not destructive)', () => {
    const { blocks } = diffComposeText('one\n', 'two\n')
    expect(applyComposeDiff(blocks, new Set(['nope', 'b999']))).toBe('one\n')
  })

  it('a stale id set from a DIFFERENT diff generation can silently apply to an unrelated block, because ids collide positionally (documented non-guarantee, not a bug)', () => {
    // The `id` docblock on ComposeDiffBlock says it is "NOT stable across
    // recomputation" and "must be dropped when the text behind it changes".
    // The existing "ignores an id..." test above only exercises ids that never
    // exist in ANY generation ('nope', 'b999'), so it cannot catch the actually
    // dangerous case: two SEPARATE diffComposeText results that both legitimately
    // contain 'b0', computed from completely unrelated text.
    const genA = diffComposeText(
      'Keep this line.\nAlpha replaced here.\nKeep too.\n',
      'Keep this line.\nALPHA REPLACED HERE.\nKeep too.\n',
    )
    const acceptedFromGenA = new Set(changedBlockIds(genA.blocks)) // -> {'b1'}, the user's real choice
    expect([...acceptedFromGenA]).toEqual(['b1'])

    // A later, wholly unrelated diff -- the user never reviewed this rewrite at
    // all -- happens to land its own changed block at the SAME id 'b1'.
    const before2 = 'Nothing to do with alpha.\nBeta original text.\nNothing here either.\n'
    const after2 = 'Nothing to do with alpha.\nBETA COMPLETELY REWRITTEN.\nNothing here either.\n'
    const genB = diffComposeText(before2, after2)
    expect(changedBlockIds(genB.blocks)).toEqual(['b1'])

    // Reusing genA's accepted-id set against genB's blocks silently accepts an
    // edit the user never saw, purely because the ids happen to coincide.
    const result = applyComposeDiff(genB.blocks, acceptedFromGenA)
    expect(result).toBe(after2)
    expect(result).not.toBe(before2)
    // Pinned as documentation of the danger the JSDoc warns about: callers MUST
    // discard a held id set whenever `before` / `after` change, rather than
    // relying on ids being unique across recomputation.
  })
})

describe('segmentComposeEdit — defence-in-depth round-trip fallback', () => {
  it('falls back to a whole-region replacement when the diff library returns segments that do not round-trip', async () => {
    // The module docblock promises: "if the segments stop reproducing their
    // own inputs, fall back to the coarse but always-correct... replacement".
    // Nothing in the current cleanup pipeline can actually produce that failure
    // from real inputs (that is the whole point of the defence), so the only
    // way to exercise this branch is to make the underlying library lie, via a
    // scoped mock of `diff` for one isolated module instance.
    vi.resetModules()
    vi.doMock('diff', async () => {
      const actual = await vi.importActual<typeof import('diff')>('diff')
      return {
        ...actual,
        diffWordsWithSpace: () => [
          { value: 'this does not correspond to before or after at all', added: false, removed: false },
        ],
      }
    })
    try {
      const mocked = await import('./composeDiff')
      const before = 'real before text'
      const after = 'real after text'
      const segments = mocked.segmentComposeEdit(before, after)
      expect(segments).toEqual([
        { op: 'delete', text: before },
        { op: 'insert', text: after },
      ])
    } finally {
      vi.doUnmock('diff')
      vi.resetModules()
    }
  })
})

describe('round-trip contract — hard Unicode cases (Medium finding)', () => {
  it('keeps the round trip exact across astral-plane emoji, ZWJ sequences, combining marks and RTL scripts', () => {
    const cases: Array<[string, string]> = [
      // Astral-plane surrogate pairs (U+1F355 etc.), each a pair of UTF-16 code units.
      ['I love 🍕 pizza night', 'I love 🍔 burger night'],
      // A ZWJ family emoji sequence — several astral code points joined by U+200D.
      ['our team: 👨‍👩‍👧‍👦 all present', 'our team: 👨‍👩‍👧 all present'],
      // Explicit NFD combining marks (e + U+0301 COMBINING ACUTE ACCENT), not the
      // precomposed codepoint — the shape most likely to be split mid-grapheme.
      ['caf' + 'e\u0301' + ' report ready', 'caf' + 'e\u0301' + ' summary ready'],
      // Arabic (RTL).
      ['مرحبا بالعالم اليوم', 'مرحبا بكم اليوم'],
      // Hebrew (RTL).
      ['שלום עולם היום', 'שלום לכולם היום'],
    ]
    for (const [before, after] of cases) {
      const segments = segmentComposeEdit(before, after)
      const rebuiltBefore = segments.filter(s => s.op !== 'insert').map(s => s.text).join('')
      const rebuiltAfter = segments.filter(s => s.op !== 'delete').map(s => s.text).join('')
      expect(rebuiltBefore).toBe(before)
      expect(rebuiltAfter).toBe(after)
    }
  })
})

describe('applyComposeEdits — §3.3 B7 defensive behaviour', () => {
  // These are the exact paths the production guard (lines 1007-1012 of
  // composeDiff.ts) protects. Break any one of those conditions and one of
  // these tests goes red.

  it('applies a single in-range span correctly', () => {
    expect(applyComposeEdits('teh cat', [
      { offset: 0, length: 3, replacement: 'the' },
    ])).toBe('the cat')
  })

  it('silently skips a span whose end exceeds the text length', () => {
    // offset=5, length=10 → end=15 > len('hello')=5: out of range, must be dropped.
    // Break: remove the `e.offset + e.length <= text.length` guard → returns garbage.
    expect(applyComposeEdits('hello', [
      { offset: 5, length: 10, replacement: 'X' },
    ])).toBe('hello')
  })

  it('silently skips a span with a negative offset', () => {
    // Break: remove `e.offset >= 0` guard → crashes or splices wrong substring.
    expect(applyComposeEdits('hello', [
      { offset: -1, length: 3, replacement: 'X' },
    ])).toBe('hello')
  })

  it('silently skips a span with a non-integer offset or length', () => {
    // Break: remove `Number.isInteger` guards → floating-point slice indices.
    expect(applyComposeEdits('hello world', [
      { offset: 1.5, length: 3, replacement: 'X' },
    ])).toBe('hello world')
    expect(applyComposeEdits('hello world', [
      { offset: 0, length: 2.9, replacement: 'X' },
    ])).toBe('hello world')
  })

  it('applies multiple non-overlapping spans in offset order regardless of input order', () => {
    // Break: remove the sort → later span may be applied before earlier one
    // and cursor arithmetic produces wrong output.
    const result = applyComposeEdits('teh cat sat', [
      { offset: 8, length: 3, replacement: 'slept' },
      { offset: 0, length: 3, replacement: 'the' },
    ])
    expect(result).toBe('the cat slept')
  })

  it('skips the second of two overlapping spans to avoid splicing across a boundary the user did not review', () => {
    // Spans [0,5) and [3,6) overlap at [3,5). Applying the second would
    // reference a region already consumed by the first.
    // Break: remove `if (edit.offset < cursor) continue` → double-applies bytes.
    const result = applyComposeEdits('hello world', [
      { offset: 0, length: 5, replacement: 'hi' },
      { offset: 3, length: 3, replacement: 'X' },
    ])
    expect(result).toBe('hi world')
  })

  it('returns the original string unchanged when the edits array is empty', () => {
    expect(applyComposeEdits('unchanged', [])).toBe('unchanged')
  })

  it('returns empty string and does not throw when text is not a string', () => {
    // Break: remove `typeof text !== 'string'` guard → crash on .slice().
    expect(applyComposeEdits(null as unknown as string, [
      { offset: 0, length: 1, replacement: 'y' },
    ])).toBe('')
  })
})

describe('composeEditId — §2.251 injective, content-derived identity', () => {
  // The id format is "e<offset>:<length>:<original.length>:<original><replacement>".
  // The tests below prove injectivity: distinct tuples → distinct ids, same tuple
  // → same id. They also document the contract that makes the id PII (it encodes
  // draft text) and that therefore it must never reach a log/span/audit/Sentry.

  it('same tuple produces the same id on repeated calls (stability)', () => {
    const params = { offset: 0, length: 3, original: 'teh', replacement: 'the' }
    expect(composeEditId(params)).toBe(composeEditId(params))
    expect(composeEditId(params)).toBe(composeEditId({ ...params }))
  })

  it('different offset alone produces a different id', () => {
    const base = { offset: 0, length: 3, original: 'teh', replacement: 'the' }
    expect(composeEditId(base)).not.toBe(composeEditId({ ...base, offset: 1 }))
  })

  it('different length alone produces a different id', () => {
    const base = { offset: 0, length: 3, original: 'teh', replacement: 'the' }
    expect(composeEditId(base)).not.toBe(composeEditId({ ...base, length: 4 }))
  })

  it('different replacement alone produces a different id', () => {
    const base = { offset: 0, length: 3, original: 'teh', replacement: 'the' }
    expect(composeEditId(base)).not.toBe(composeEditId({ ...base, replacement: 'thee' }))
  })

  it('FNV collision: same span, single-char original shift at boundary — distinct ids', () => {
    // The previous FNV hash collided on: two edits where one char of original
    // shifts across the boundary into replacement (offset=0, length=3).
    // "teh" → "the" vs "te" → "hthe" share offset+length but differ in original.
    const a = composeEditId({ offset: 0, length: 3, original: 'teh', replacement: 'the' })
    const b = composeEditId({ offset: 0, length: 3, original: 'te', replacement: 'hthe' })
    // Distinct tuples must yield distinct ids BY CONSTRUCTION (not hash luck).
    expect(a).not.toBe(b)
  })

  it('appending bytes to replacement always changes the id', () => {
    const base = { offset: 0, length: 3, original: 'teh', replacement: 'the' }
    expect(composeEditId(base)).not.toBe(composeEditId({ ...base, replacement: 'the ' }))
    expect(composeEditId(base)).not.toBe(composeEditId({ ...base, replacement: 'theX' }))
  })

  it('id encodes original and replacement text (PII — must never reach a sink)', () => {
    const original = 'uniqueOriginalSentinel'
    const replacement = 'uniqueReplacementSentinel'
    const id = composeEditId({ offset: 0, length: original.length, original, replacement })
    // The id contains the draft text: that is the §2.251 construction guarantee.
    // The test documents it explicitly so future readers know the id is PII.
    expect(id).toContain(original)
    expect(id).toContain(replacement)
  })
})

describe('summarizeEqualBlock — when an untouched region is worth folding away', () => {
  it('leaves a short region expanded', () => {
    const summary = summarizeEqualBlock('Thanks!\n')
    expect(summary.lines).toBe(2)
    expect(summary.collapsible).toBe(false)
  })

  it('folds a long single-line region', () => {
    const text = 'x'.repeat(COMPOSE_DIFF_COLLAPSE_MIN_CHARS + 1)
    expect(summarizeEqualBlock(text).collapsible).toBe(true)
  })

  it('folds a tall region even when it is short in characters', () => {
    expect(summarizeEqualBlock('a\nb\nc\n').collapsible).toBe(true)
  })

  it('reports at least one line for the empty string', () => {
    expect(summarizeEqualBlock('').lines).toBe(1)
  })
})
