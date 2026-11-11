import { describe, expect, it } from 'vitest'
import { ANSWER_MAX_CHARS, ANSWER_MAX_TABLE_CELLS, prepareAnswerMarkdown } from './answerMarkdown'
import { citationTokensOfAnswer, createAnswerTokenCache } from './answerCitations'

describe('prepareAnswerMarkdown: the one bound, on length', () => {
  it('the bound is above anything a model can answer in one response (128 000 tokens at 4 characters each)', () => {
    expect(ANSWER_MAX_CHARS).toBeGreaterThan(128_000 * 4)
  })

  it('an ordinary answer, however long, is markdown with its links normalised', () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => `- **Row ${i}** [Subject ${i}](mailref://c/k3f2x7ab) from someone@example.test`).join('\n')
    expect(rows.length).toBeGreaterThan(100_000)
    expect(prepareAnswerMarkdown(rows).kind).toBe('markdown')
    expect(prepareAnswerMarkdown('look: mailref://c/k3f2x7ab')).toEqual({ kind: 'markdown', text: expect.stringContaining('](mailref://c/k3f2x7ab)') })
  })

  it('constructs are not bounded: deep quotes, many marks, many lines, wide tables all stay markdown', () => {
    expect(prepareAnswerMarkdown('>'.repeat(5_000)).kind).toBe('markdown')
    expect(prepareAnswerMarkdown('a] '.repeat(20_000)).kind).toBe('markdown')
    expect(prepareAnswerMarkdown('x\n'.repeat(50_000)).kind).toBe('markdown')
  })

  it('beyond the bound it is plain text, with no tickets', () => {
    const huge = `[a](mailref://c/aaaaaaaa) ${'x'.repeat(ANSWER_MAX_CHARS)}`
    expect(prepareAnswerMarkdown(huge)).toEqual({ kind: 'plain', text: huge })
    expect(citationTokensOfAnswer(huge)).toEqual([])
  })

  it('a non-string answer is empty plain text', () => {
    expect(prepareAnswerMarkdown(undefined as unknown as string)).toEqual({ kind: 'plain', text: '' })
  })
})

describe('createAnswerTokenCache', () => {
  const link = (t: string) => `[x](mailref://c/${t})`

  it('answers a repeated text from the cache', () => {
    const cache = createAnswerTokenCache()
    const text = link('aaaaaaaa')
    expect(cache.tokensOf(text)).toBe(cache.tokensOf(text))
  })

  it('is a real LRU: a hit refreshes the entry, so the one NOT used is evicted', () => {
    const cache = createAnswerTokenCache({ maxEntries: 2, maxChars: 10_000 })
    const [a, b, c] = [link('aaaaaaaa'), link('bbbbbbbb'), link('cccccccc')]
    const first = cache.tokensOf(a)
    cache.tokensOf(b)
    cache.tokensOf(a) // refresh a
    cache.tokensOf(c) // evicts b, not a
    expect(cache.tokensOf(a)).toBe(first)
    expect(cache.tokensOf(b)).not.toBe(first)
  })

  it('is bounded by the total characters it holds, and never caches one answer larger than the bound', () => {
    const cache = createAnswerTokenCache({ maxEntries: 100, maxChars: 100 })
    const big = `${link('aaaaaaaa')} ${'x'.repeat(200)}`
    expect(cache.tokensOf(big)).not.toBe(cache.tokensOf(big)) // too large to keep: parsed each time
    const small = Array.from({ length: 10 }, (_, i) => `${link('bbbbbbbb')} ${i}`)
    const firsts = small.map(t => cache.tokensOf(t))
    // 10 entries of ~30 chars exceed 100 chars in total: the oldest are gone
    expect(cache.tokensOf(small[0]!)).not.toBe(firsts[0])
    expect(cache.tokensOf(small[9]!)).toBe(firsts[9])
  })
})

describe('tables: the output is bounded exactly, whatever the input looks like', () => {
  const header = (cols: number) => `| ${Array(cols).fill('a').join(' | ')} |\n| ${Array(cols).fill('-').join(' | ')} |\n`

  // The guard bounds memory, not time: parsing such a table still takes seconds on a slow
  // machine (an accepted limit), so this asserts the outcome only. Without the guard the
  // parse succeeds and the ticket is returned, which fails the expectation below.
  it('a header of 1 400 columns with pipe-less rows (GFM pads each row to the header) is refused: no tickets', () => {
    const text = `[a](mailref://c/aaaaaaaa)\n\n${header(1_400)}${'x\n'.repeat(1_600)}` // 2.2 million cells if padded
    expect(text.length).toBeLessThan(ANSWER_MAX_CHARS)
    expect(citationTokensOfAnswer(text)).toEqual([])
  }, 60_000)

  it('the cells of ALL the tables of an answer are added up', () => {
    const table = `${header(50)}${'x\n'.repeat(60)}\n\n` // 50 columns x 61 rows = 3 050 cells
    expect(50 * 61).toBeLessThan(ANSWER_MAX_TABLE_CELLS)
    expect(citationTokensOfAnswer(`[a](mailref://c/aaaaaaaa)\n\n${table}`)).toEqual(['aaaaaaaa'])
    expect(citationTokensOfAnswer(`[a](mailref://c/aaaaaaaa)\n\n${table}${table}`)).toEqual([])
  })

  it('a table within the budget is drawn and its links are found', () => {
    const text = `${header(5)}${'| [x](mailref://c/aaaaaaaa) | b | c | d | e |\n'.repeat(20)}`
    expect(5 * 21).toBeLessThan(ANSWER_MAX_TABLE_CELLS)
    expect(citationTokensOfAnswer(text)).toEqual(['aaaaaaaa'])
  })
})
