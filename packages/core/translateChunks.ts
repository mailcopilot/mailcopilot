/**
 * Splitting a long message into pieces one translation request can carry.
 *
 * One provider request cannot return a translation longer than its output
 * ceiling, and a half translation must never be shown. So a message above the
 * per-request budget is cut into pieces, each piece is translated by its own
 * request, and the answers are stitched back together. This is the practice the
 * OpenAI Cookbook uses to translate a whole book: split at structural
 * boundaries, translate each piece, join the results.
 *
 * The cut points are chosen so that neither side of a cut loses meaning, in this
 * order of preference:
 *
 *   1. a paragraph break (a run of blank lines);
 *   2. the end of a sentence;
 *   3. whitespace between words;
 *   4. as a last resort, a hard cut — only for a run of text with no whitespace
 *      at all that is longer than the budget by itself (a pasted blob, a very
 *      long URL, unspaced CJK without sentence marks).
 *
 * Every piece is at most `cap` UTF-16 code units, matching `String#length`, the
 * unit the budget is counted in elsewhere. A hard cut never separates a
 * surrogate pair, so no piece ends or starts with a lone surrogate.
 *
 * LOSSLESS BY CONSTRUCTION: `pieces[0] + gaps[0] + pieces[1] + … + pieces[n-1]`
 * is the original text, byte for byte. The gap is the exact whitespace that
 * stood between two pieces (the blank lines of a paragraph break, the space
 * after a sentence), so joining translated pieces with the same gaps reproduces
 * the original paragraph structure exactly instead of re-guessing it.
 *
 * Pure and linear: no scorer, no regex whose backtracking depends on the input
 * (the text is the user's received mail, i.e. adversarial).
 */

export interface TranslationChunks {
  /** The pieces to translate, in order. Never empty. */
  pieces: string[]
  /** `gaps[i]` is the exact original text between `pieces[i]` and `pieces[i + 1]`. */
  gaps: string[]
}

interface Unit {
  body: string
  /** Original text that followed this unit up to the next one ('' for the last). */
  gap: string
}

/**
 * Sentence terminators that need whitespace (or the end of the text) after them
 * to count — so `3.14`, `a.b` and `e.g.` mid-word are not cut.
 */
const SPACED_TERMINATORS = new Set(['.', '!', '?', '…', '؟', '۔', '।', '॥', '‼', '⁇'])
/** Terminators of scripts written without spaces between sentences. */
const UNSPACED_TERMINATORS = new Set(['。', '！', '？', '．'])
/** Closing marks that belong to the sentence they follow. */
const CLOSERS = new Set(['"', "'", '»', '”', '’', ')', ']', '」', '』', '）'])

function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch)
}

/** Level 1: paragraph breaks — a newline followed by one or more whitespace-only lines. */
const PARAGRAPH_BREAK = /\n(?:[ \t\r]*\n)+/g

function splitByRegexGaps(text: string, re: RegExp): Unit[] {
  const units: Unit[] = []
  let start = 0
  for (const m of text.matchAll(re)) {
    const index = m.index ?? 0
    // A gap at the very start has no body before it: leave it inside the next
    // body rather than emit an empty unit.
    if (index === 0) continue
    units.push({ body: text.slice(start, index), gap: m[0] })
    start = index + m[0].length
  }
  units.push({ body: text.slice(start), gap: '' })
  return units
}

function splitParagraphs(text: string): Unit[] {
  return splitByRegexGaps(text, PARAGRAPH_BREAK)
}

/** Level 3: whitespace between words (`\s+` is linear: no nested quantifier). */
function splitWords(text: string): Unit[] {
  return splitByRegexGaps(text, /\s+/g)
}

/** Level 2: sentence ends, found by a single left-to-right scan. */
function splitSentences(text: string): Unit[] {
  const units: Unit[] = []
  const n = text.length
  let start = 0
  let i = 0
  while (i < n) {
    const ch = text[i]
    const spaced = SPACED_TERMINATORS.has(ch)
    const unspaced = UNSPACED_TERMINATORS.has(ch)
    if (!spaced && !unspaced) {
      i++
      continue
    }
    let end = i + 1
    while (end < n && (SPACED_TERMINATORS.has(text[end]) || UNSPACED_TERMINATORS.has(text[end]))) end++
    while (end < n && CLOSERS.has(text[end])) end++
    const atEnd = end >= n
    if (atEnd || unspaced || isWhitespace(text[end])) {
      let gapEnd = end
      while (gapEnd < n && isWhitespace(text[gapEnd])) gapEnd++
      // Nothing after the final terminator: the last unit is added below.
      if (!atEnd) {
        units.push({ body: text.slice(start, end), gap: text.slice(end, gapEnd) })
        start = gapEnd
      }
      i = gapEnd
    } else {
      i = end
    }
  }
  units.push({ body: text.slice(start), gap: '' })
  return units
}

/** Level 4: hard cuts every `cap` code units, never inside a surrogate pair. */
function splitHard(text: string, cap: number): Unit[] {
  const units: Unit[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + cap, text.length)
    if (end < text.length) {
      const last = text.charCodeAt(end - 1)
      // A high surrogate at the end would be separated from its low half.
      if (last >= 0xd800 && last <= 0xdbff && end - 1 > start) end--
    }
    units.push({ body: text.slice(start, end), gap: '' })
    start = end
  }
  return units
}

/**
 * Cut `text` into units no longer than `cap` each, at the coarsest level that
 * works, then pack neighbouring units back together up to `cap`.
 */
function splitAtLevel(text: string, cap: number, level: number): Unit[] {
  if (text.length <= cap) return [{ body: text, gap: '' }]

  const units =
    level === 0 ? splitParagraphs(text)
    : level === 1 ? splitSentences(text)
    : level === 2 ? splitWords(text)
    : splitHard(text, cap)

  // Whitespace at the very end of `text` leaves an empty last unit. Fold it
  // back into the unit before it so the trailing text is not lost; the unit may
  // then be a little over the budget and is cut again below.
  if (units.length > 1 && units[units.length - 1].body.length === 0) {
    units.pop()
    const prev = units[units.length - 1]
    units[units.length - 1] = { body: prev.body + prev.gap, gap: '' }
  }

  // A unit still over the budget is cut again at the next finer level. The
  // recursion terminates: `splitHard` (level 3) always yields pieces ≤ cap.
  const expanded: Unit[] = []
  for (const unit of units) {
    if (unit.body.length <= cap) {
      expanded.push(unit)
      continue
    }
    const inner = splitAtLevel(unit.body, cap, Math.min(level + 1, 3))
    inner[inner.length - 1] = { body: inner[inner.length - 1].body, gap: unit.gap }
    expanded.push(...inner)
  }

  // Greedy packing: keep adding the next unit (with the gap that preceded it)
  // while the piece still fits.
  const packed: Unit[] = []
  let current = expanded[0]
  for (let k = 1; k < expanded.length; k++) {
    const next = expanded[k]
    if (current.body.length + current.gap.length + next.body.length <= cap) {
      current = { body: current.body + current.gap + next.body, gap: next.gap }
    } else {
      packed.push(current)
      current = next
    }
  }
  packed.push(current)
  return packed
}

/**
 * Split `text` into pieces of at most `cap` code units. Text within the budget
 * is returned whole and untouched (one piece), so the single-request path stays
 * exactly what it was before chunking existed.
 */
export function splitForTranslation(text: string, cap: number): TranslationChunks {
  if (!Number.isFinite(cap) || cap < 2) throw new RangeError('splitForTranslation: cap must be >= 2')
  const units = splitAtLevel(text, cap, 0)
  return {
    pieces: units.map((u) => u.body),
    gaps: units.slice(0, -1).map((u) => u.gap),
  }
}

/**
 * Join translated pieces with the original gaps. The caller trims the result
 * as it does for a single answer.
 */
export function joinTranslatedChunks(translated: readonly string[], gaps: readonly string[]): string {
  let out = ''
  for (let i = 0; i < translated.length; i++) {
    out += translated[i]
    if (i < gaps.length) out += gaps[i]
  }
  return out
}
