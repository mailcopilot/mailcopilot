import { describe, expect, it } from 'vitest'
import { joinTranslatedChunks, splitForTranslation } from './translateChunks'

/** The invariant everything else rests on: nothing is lost or reordered. */
function roundTrip(text: string, cap: number) {
  const { pieces, gaps } = splitForTranslation(text, cap)
  expect(gaps).toHaveLength(pieces.length - 1)
  expect(joinTranslatedChunks(pieces, gaps)).toBe(text)
  for (const p of pieces) {
    expect(p.length).toBeLessThanOrEqual(cap)
    expect(p.length).toBeGreaterThan(0)
  }
  return { pieces, gaps }
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

describe('splitForTranslation', () => {
  it('returns text within the budget whole and untouched', () => {
    const text = '  leading space\n\nand a tail  \n'
    expect(splitForTranslation(text, 3000)).toEqual({ pieces: [text], gaps: [] })
    expect(splitForTranslation('x'.repeat(3000), 3000).pieces).toHaveLength(1)
  })

  it('packs paragraphs and cuts only at blank lines when they fit', () => {
    const para = (n: number) => `Paragraph ${n}: ` + 'word '.repeat(30).trim() + '.'
    const text = [1, 2, 3, 4, 5, 6].map(para).join('\n\n')
    const { pieces, gaps } = roundTrip(text, 400)
    expect(pieces.length).toBeGreaterThan(1)
    // Every cut is a paragraph break and every piece is whole paragraphs.
    for (const g of gaps) expect(g).toBe('\n\n')
    for (const p of pieces) expect(p.startsWith('Paragraph ')).toBe(true)
  })

  it('keeps the exact blank-line run between pieces', () => {
    const a = 'A'.repeat(60)
    const b = 'B'.repeat(60)
    const text = `${a}\n \t\n\n${b}`
    const { pieces, gaps } = roundTrip(text, 70)
    expect(pieces).toEqual([a, b])
    expect(gaps).toEqual(['\n \t\n\n'])
  })

  it('splits a paragraph larger than the budget at sentence ends', () => {
    const sentence = 'This is one fairly ordinary sentence of text.'
    const text = Array.from({ length: 20 }, () => sentence).join(' ')
    const { pieces, gaps } = roundTrip(text, 200)
    expect(pieces.length).toBeGreaterThan(1)
    for (const g of gaps) expect(g).toBe(' ')
    for (const p of pieces) expect(p.endsWith('text.')).toBe(true)
  })

  it('does not cut inside 3.14 or an abbreviation without a following space', () => {
    const text = 'Pi is 3.14159 and e.g.this stays together. ' + 'Filler sentence here. '.repeat(10)
    const { pieces } = roundTrip(text, 60)
    expect(pieces.some((p) => p.includes('3.14159'))).toBe(true)
    expect(pieces.some((p) => p.includes('e.g.this'))).toBe(true)
  })

  it('falls back to whitespace when there are no sentence marks', () => {
    const text = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ')
    const { pieces } = roundTrip(text, 100)
    expect(pieces.length).toBeGreaterThan(1)
    for (const p of pieces) {
      expect(p.startsWith(' ')).toBe(false)
      expect(p.endsWith(' ')).toBe(false)
    }
  })

  it('handles text with no blank lines at all (a single block of lines)', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line number ${i}`).join('\n')
    const { pieces } = roundTrip(text, 500)
    expect(pieces.length).toBeGreaterThan(1)
  })

  it('hard-cuts a run with no whitespace as the last resort', () => {
    const blob = 'Q'.repeat(10_000)
    const { pieces } = roundTrip(blob, 3000)
    expect(pieces.map((p) => p.length)).toEqual([3000, 3000, 3000, 1000])
  })

  it('cuts CJK text at full-width sentence marks without needing spaces', () => {
    const sentence = '今日は会議があります。明日は休みです！'
    const text = sentence.repeat(60)
    const { pieces } = roundTrip(text, 100)
    expect(pieces.length).toBeGreaterThan(1)
    for (const p of pieces) expect(/[。！]$/u.test(p)).toBe(true)
  })

  it('hard-cuts unspaced CJK with no marks, one code point at a time', () => {
    const text = '漢'.repeat(700)
    const { pieces } = roundTrip(text, 100)
    expect(pieces).toHaveLength(7)
  })

  it('splits right-to-left text at its own sentence marks and keeps it intact', () => {
    const sentence = 'هل وصلت الرسالة إلى الجميع؟ نعم، وصلت اليوم.'
    const text = Array.from({ length: 30 }, () => sentence).join(' ')
    const { pieces } = roundTrip(text, 150)
    expect(pieces.length).toBeGreaterThan(1)
    for (const p of pieces) expect(/[؟.]$/u.test(p)).toBe(true)
  })

  it('never separates a surrogate pair when it must hard-cut', () => {
    // 😀 is two UTF-16 units: a cut at an odd offset would split it.
    const text = '😀'.repeat(400)
    for (const cap of [99, 100, 101, 3]) {
      const { pieces } = roundTrip(text, cap)
      for (const p of pieces) expect(hasLoneSurrogate(p)).toBe(false)
    }
  })

  it('keeps emoji whole at sentence and word boundaries', () => {
    const text = Array.from({ length: 80 }, () => 'Great news 🎉🎉! See you 👋 soon 😀.').join(' ')
    const { pieces } = roundTrip(text, 120)
    for (const p of pieces) expect(hasLoneSurrogate(p)).toBe(false)
  })

  it('preserves trailing and leading whitespace of the whole text', () => {
    const text = '\n\n  ' + 'word '.repeat(200) + '\n\n\n'
    roundTrip(text, 100)
  })

  it('terminates quickly on pathological input (linear, no backtracking blowup)', () => {
    const started = Date.now()
    roundTrip('!'.repeat(60_000), 3000)
    roundTrip('\n'.repeat(60_000), 3000)
    roundTrip(' \n'.repeat(30_000) + 'x', 3000)
    roundTrip('a. '.repeat(20_000), 3000)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('splits a 20 000 character message with quoted history into about seven pieces', () => {
    const reply = 'Thanks, confirmed for Thursday. Please send the invoice.\n\n'
    const quoted = Array.from({ length: 300 }, (_, i) => `> quoted line ${i} of the earlier conversation`).join('\n')
    const text = (reply + 'On Mon, Alice wrote:\n' + quoted).padEnd(20_000, '\n> padding text here')
    const { pieces } = roundTrip(text, 3000)
    expect(pieces.length).toBeGreaterThanOrEqual(7)
    expect(pieces.length).toBeLessThanOrEqual(9)
  })

  it('rejects a nonsensical budget', () => {
    expect(() => splitForTranslation('abc', 0)).toThrow(RangeError)
    expect(() => splitForTranslation('abc', Number.NaN)).toThrow(RangeError)
  })
})

describe('joinTranslatedChunks', () => {
  it('joins translated pieces with the original gaps', () => {
    expect(joinTranslatedChunks(['A', 'B', 'C'], ['\n\n', ' '])).toBe('A\n\nB C')
    expect(joinTranslatedChunks(['only'], [])).toBe('only')
  })
})
