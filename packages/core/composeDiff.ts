/**
 * composeDiff — segment an AI rewrite of the user's own draft text into the
 * material a review panel renders (§3.3.B4.f5), plus the B7 primitives that
 * anchor, identify and apply individually acceptable edits (§3.3 B7, §2.251):
 * {@link resolveComposeEdits}, {@link composeEditId}, {@link applyComposeEdits}.
 *
 * Pure, DOM-free, React-free. The renderer (`src/components/QuickActionDiff.tsx`)
 * only maps the result onto markup; nothing here knows about elements, CSS or
 * i18n. That split is what lets the algorithm be tested without mounting
 * anything, and what lets main and the renderer share one implementation.
 *
 * ## Why two levels of comparison
 *
 * An email paragraph is ONE long line. A purely line-based comparison therefore
 * degenerates: reword three words in the middle of a paragraph and the whole
 * paragraph reads as "removed" plus "added", which tells the reader nothing
 * they could not see by putting the two versions side by side. A purely
 * word-based comparison over the whole text has the opposite failure: it
 * happily matches a word in paragraph one against the same word in paragraph
 * four and produces a shredded, unreadable interleaving.
 *
 * So the comparison runs twice, at two granularities:
 *
 *  1. **Alignment by line/paragraph** (`diffArrays` over line tokens). This
 *     decides WHICH regions of the draft the rewrite touched, and keeps
 *     untouched regions whole so the panel can collapse them.
 *  2. **Word-level comparison INSIDE each changed region**
 *     (`diffWordsWithSpace`). This is what turns "the whole paragraph changed"
 *     into "these four words changed".
 *
 * ## Why the word level stops at a paragraph boundary
 *
 * Level 1 keeps a RUN of adjacent changed lines together in one block, so that
 * a rewrite merging two paragraphs into one stays a single reviewable edit
 * instead of three. That grouping is right for the block level and wrong for
 * the word level: handing a four-paragraph run to `diffWordsWithSpace` in one
 * piece reproduces exactly the cross-paragraph shredding described above — and
 * "rewrite all of it" is the COMMON case here, not an exotic one ("make this
 * more formal" touches every paragraph).
 *
 * So a changed region is word-diffed paragraph by paragraph whenever the edit
 * left the paragraph structure alone, and as one piece only when it did not:
 *
 *  - **Same number of lines on both sides (N:N)** — assumed to mean line `i`
 *    of the draft corresponds to line `i` of the rewrite, so each pair is
 *    word-diffed on its own and the results are concatenated, keeping a word
 *    from ever being matched against a word in another paragraph. This is a
 *    DETERMINISTIC POSITIONAL ASSUMPTION, not a proof of correspondence: a
 *    rewrite that both reorders and edits lines (swap paragraph 1 and 2, and
 *    reword one of them) preserves the line count and takes this path too,
 *    diffing swapped content against the wrong counterpart. The output stays
 *    consistent with the rest of the module either way — conservative and
 *    byte-exact, never crossing a paragraph boundary it does not already
 *    treat as one region — so the failure mode is a less legible diff, not a
 *    wrong or unsafe one.
 *  - **Different counts (N:M)** — the edit moved the boundaries themselves
 *    (paragraphs merged, split, added or dropped), so there is no line-to-line
 *    correspondence to respect; comparing the run as one piece is the honest
 *    description of what happened.
 *
 * The discriminator is deliberately the line COUNT and not a similarity score:
 * it is cheap and predictable, and a wrong guess in either direction only
 * costs legibility, never correctness (both paths round-trip byte for byte).
 * What it does NOT do is recover the structure-preserving lines inside a mixed
 * N:M run — "paragraph 1 reworded in place, paragraphs 2 and 3 merged" is
 * treated wholly as a boundary-moving edit. Splitting that apart needs a second
 * alignment pass over the run, which is a real feature, not a tweak.
 *
 * ## What the word level actually tokenizes (and why cleanup carries the weight)
 *
 * `diffWordsWithSpace` is only word-level for scripts inside jsdiff's
 * `extendedWordChars` — ASCII plus Latin-1/Latin Extended. Cyrillic and Greek
 * are NOT in that set (jsdiff 9.0.0, `libesm/diff/word.js`), so a Russian
 * paragraph is tokenized one CHARACTER at a time and the raw diff comes back
 * letter-level: `посмотрим` → `изучим` arrives as `[-посмотр]и[+зучи]м`.
 *
 * That is not an anomaly to be engineered around — it is the normal operating
 * point of this technique. diff-match-patch compares characters in EVERY
 * language, English included, and calls it the "finest level of detail";
 * legibility is restored by the cleanup pass, not by the tokenizer. So the
 * cleanup below is not a cosmetic nicety for half of our locales: it is the
 * component that makes the output readable at all, and all three of its rules
 * exist to close a specific shape of scrap.
 *
 * Tokenizing ourselves is not the alternative it looks like. jsdiff exposes an
 * `intlSegmenter` option for exactly this, but only on `diffWords`, which is
 * documented as ignoring whitespace when computing the diff — and a diff that
 * normalizes whitespace cannot reproduce `before` byte for byte, which is the
 * contract per-edit acceptance rests on (see below). `diffWordsWithSpace` has no
 * such option at all. The path is closed by the round-trip contract, not by
 * effort.
 *
 * ## Why the word level needs a cleanup pass
 *
 * `diffWordsWithSpace` is byte-exact (see the round-trip contract below), and
 * that exactness is the reason it fragments: it will happily report that inside
 * `отчёт` → `отчет` one letter was removed and another added, rendering as
 * `отч<del>ё</del><ins>е</ins>т` — technically minimal, unreadable in practice.
 * The standard answer is a "semantic cleanup" pass: Google's diff-match-patch
 * documents `diff_cleanupSemantic` as rewriting a diff "into a more
 * intelligible format" by trading minimality for legibility
 * (https://github.com/google/diff-match-patch/wiki/API). We take the technique
 * and not the library — that repository has been archived (read-only since
 * 2024-08-05) and an unmaintained dependency is not worth one function.
 *
 * We take two of Fraser's ideas and add one of our own — see `cleanupSegments`
 * for the three rules and for which scrap each of them closes.
 *
 * ## Cost — this runs synchronously inside a React render
 *
 * `QuickActionDiff` computes the whole diff in a `useMemo` during render, so an
 * unbounded diff is a frozen window. Myers' algorithm is O(N·D) in the token
 * count and the edit distance, and D is enormous exactly when tokenization
 * degrades to characters (see above) — measured on this machine, one 6000-char
 * region with no whitespace cost **1.8 s** inside `diffWordsWithSpace` alone,
 * before our own cleanup ran.
 *
 * Every level therefore carries an explicit, DETERMINISTIC ceiling, and every
 * bail-out falls back to something coarser but still byte-exact:
 *
 *  - `LINE_DIFF_MAX_EDIT_LENGTH` / `WORD_DIFF_MAX_EDIT_LENGTH` are handed to
 *    jsdiff's own `maxEditLength` option, documented as the way "to limit the
 *    computational cost of diffing large, very different texts by giving up
 *    early" (jsdiff `types.d.ts`, `MaxEditLengthOption`). It returns `undefined`
 *    instead of a diff; we then render the region as a whole-region replacement,
 *    which is what "almost everything changed" actually means. Deterministic:
 *    unlike the sibling `timeout` option, the same inputs always bail the same
 *    way, so the panel cannot render differently on a slower machine.
 *  - `CLEANUP_MAX_PASSES` caps the cleanup loop, making it linear in the segment
 *    count instead of quadratic.
 *  - `WORD_FRAGMENT_MAX_CHARS` caps how far a single cleanup step may reach.
 *
 * Measured after these ceilings, same machine: the 1.8 s case above drops to
 * 37 ms, a fully-rewritten 8000-char Russian region to 21 ms, the 1.7 s CJK case
 * to 19 ms, 60 reworded Russian paragraphs from 119 ms to 11 ms, and a realistic
 * 400-char paragraph rewrite stays fine-grained (does not bail) at 4 ms. The
 * worst whole-draft case found — 8000 characters of Russian hard-wrapped into
 * eight 1000-character lines with every line rewritten end to end — costs
 * 157 ms, once, when the panel opens. That is the shape of the bound: the number
 * of changed regions times O(region size × edit ceiling), with nothing
 * input-dependent left in it.
 *
 * ## Round-trip contracts — read this before building on it
 *
 * BLOCK level is byte-exact, in both directions:
 *   - `blocks.map(b => b.before).join('') === before`
 *   - `blocks.map(b => b.after).join('') === after`
 *   - `applyComposeDiff(blocks, new Set()) === before`
 *   - `applyComposeDiff(blocks, everyChangedId) === after`
 * This is what makes per-edit acceptance safe: accepting an arbitrary subset of
 * the changed blocks yields a body assembled from verbatim pieces of the two
 * inputs, never from re-serialized tokens.
 *
 * SEGMENT level is byte-exact too — `diffWordsWithSpace` preserves whitespace,
 * unlike `diffWords`, which normalizes it to the "after" side and therefore
 * cannot reproduce the "before" string at all. That is precisely why this
 * module uses the with-space variant and repairs legibility afterwards rather
 * than taking the prettier-but-lossy one. Even so, treat segments as DISPLAY
 * material: `applyComposeDiff` deliberately rebuilds from `before` / `after`,
 * so a future change to the cleanup heuristics can never alter what a user's
 * click actually writes into their draft.
 *
 * ## What this module does NOT decide
 *
 * Which part of the draft is even eligible for rewriting is decided upstream by
 * `splitComposeBody()` (`./composeBody`, §2.78) — a RECOGNIZED quoted original,
 * forwarded message or signature does not reach this module. The splitter is
 * best-effort over flat text (§2.173): a quoting style it does not recognize is
 * classified as own text and does reach this module. Do not add a second
 * boundary detector here.
 */

import { diffArrays, diffWordsWithSpace } from 'diff'

/** What happened to one piece of text inside a changed region. */
export type ComposeDiffOp = 'equal' | 'insert' | 'delete'

/** A word-level piece of a changed region, for inline `<ins>` / `<del>` markup. */
export type ComposeDiffSegment = {
  op: ComposeDiffOp
  text: string
}

/**
 * What happened to one aligned region of the draft.
 *
 * `equal` regions are untouched text (collapsible in the UI). The other three
 * are the units of an edit list, and the units a per-edit accept control will
 * toggle.
 */
export type ComposeDiffBlockKind = 'equal' | 'replace' | 'insert' | 'delete'

export type ComposeDiffBlock = {
  /**
   * Identity of this block WITHIN ONE `ComposeDiffResult`. Stable across
   * re-renders of the same result (it is derived from the block's position), so
   * it is a valid React key and a valid "which edits did the user accept" key.
   * It is NOT stable across recomputation from different inputs — a diff is
   * recomputed wholesale, so a held set of ids must be dropped when the text
   * behind it changes.
   */
  id: string
  kind: ComposeDiffBlockKind
  /** This region as it stands in the draft today. Empty for a pure insertion. */
  before: string
  /** This region as the rewrite proposes it. Empty for a pure deletion. */
  after: string
  /**
   * Word-level breakdown of `before` → `after`, for inline markup. For an
   * `equal` block this is a single `equal` segment. Display material only —
   * see the round-trip contract in the module docblock.
   */
  segments: ComposeDiffSegment[]
}

export type ComposeDiffResult = {
  blocks: ComposeDiffBlock[]
  /** Blocks whose kind is not `equal` — the length of the edit list. */
  changeCount: number
  /** The rewrite is byte-identical to the original: there is nothing to review. */
  identical: boolean
}

/**
 * An unchanged region shorter than this (and no taller than
 * `COLLAPSE_MIN_LINES`) is left expanded: collapsing two words behind a
 * "show 1 unchanged line" control costs the reader more than it saves.
 */
export const COMPOSE_DIFF_COLLAPSE_MIN_CHARS = 160
export const COMPOSE_DIFF_COLLAPSE_MIN_LINES = 2

export type ComposeDiffEqualSummary = {
  /** Lines the region spans (never 0 — a region always has at least one). */
  lines: number
  /** Characters in the region, for the "worth collapsing?" decision. */
  chars: number
  /** Whether the panel should collapse this region by default. */
  collapsible: boolean
}

/**
 * Describe an unchanged region so the panel can decide whether to fold it.
 *
 * The thresholds live here rather than in CSS or in the component because
 * "when is a gap big enough to hide" is a property of the text, not of the
 * layout, and because a test can pin it.
 */
export function summarizeEqualBlock(text: string): ComposeDiffEqualSummary {
  const lines = text.length === 0 ? 1 : text.split('\n').length
  const chars = text.length
  return {
    lines,
    chars,
    collapsible: chars > COMPOSE_DIFF_COLLAPSE_MIN_CHARS || lines > COMPOSE_DIFF_COLLAPSE_MIN_LINES,
  }
}

/**
 * Cut `text` into line tokens, each keeping its own trailing `\n`.
 *
 * `toLines(x).join('') === x` for every input, including the empty string and
 * text ending in a newline. That identity is the foundation of the block-level
 * round-trip contract: line endings are never normalized and never moved
 * between tokens, so a CRLF draft keeps its `\r` bytes inside the token that
 * carried them (the same rule `composeBody.ts` follows for the same reason).
 */
function toLines(text: string): string[] {
  if (text === '') return []
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

// --- Ceilings that keep the whole computation bounded. See "## Cost" in the
// --- module docblock for the measurements behind each number.

/** Max line-level edit distance before level 1 gives up and reports one whole-text edit. */
const LINE_DIFF_MAX_EDIT_LENGTH = 512
/** Max word-level edit distance before level 2 gives up and reports one whole-region replacement. */
const WORD_DIFF_MAX_EDIT_LENGTH = 512
/**
 * How far the cleanup may reach when expanding an edit to its word boundaries.
 *
 * Our notion of a "word" is a run of non-whitespace characters, which is true
 * for the six languages this product ships in and false for Chinese, Japanese
 * and Thai, where a whole paragraph is one such run. Without a ceiling, a
 * one-character edit in a Japanese paragraph would expand into "the entire
 * paragraph was replaced" — the exact opposite of the legibility the cleanup
 * exists for. 48 characters clears the longest realistic word in a Latin or
 * Cyrillic text (German compounds included) with room to spare, and stops well
 * short of a sentence in any script.
 *
 * This is a LIMITER, not word segmentation: we decline to expand where our
 * definition of a word is known not to apply, rather than pretending to know
 * where the boundary really is. `Intl.Segmenter` could tell us, but its output
 * is locale- and ICU-version-dependent, which would make a pure, snapshot-
 * testable function depend on the runtime's Unicode data — too high a price for
 * a legibility heuristic whose failure mode is a slightly noisier diff.
 */
const WORD_FRAGMENT_MAX_CHARS = 48
/** Max cleanup sweeps. See `cleanupSegments` for why a small constant suffices. */
const CLEANUP_MAX_PASSES = 6

/**
 * Scripts that do not separate words with spaces, so a run of non-whitespace
 * characters in them is a phrase or a whole paragraph rather than a word:
 * Japanese kana, CJK ideographs (BMP, compatibility and extension B+), and Thai.
 * Korean is left out on purpose — it does use spaces.
 */
const SPACELESS_SCRIPT_RE = /[\u0e00-\u0e7f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u

const WHITESPACE_RE = /\s/

/** Would expanding an edit over this fragment still describe a single human word? */
function isExpandableWordFragment(fragment: string): boolean {
  return (
    fragment !== '' &&
    fragment.length <= WORD_FRAGMENT_MAX_CHARS &&
    !SPACELESS_SCRIPT_RE.test(fragment)
  )
}

/**
 * Trailing run of non-whitespace characters — the word fragment a change is
 * glued to on its left — or `''` when that run is not word-shaped
 * (see `WORD_FRAGMENT_MAX_CHARS`). Scanning stops at the ceiling, so a
 * megabyte-long run costs 49 character tests, not a megabyte.
 */
function trailingWordFragment(text: string): string {
  let start = text.length
  while (start > 0 && !WHITESPACE_RE.test(text[start - 1])) {
    start--
    if (text.length - start > WORD_FRAGMENT_MAX_CHARS) return ''
  }
  const fragment = text.slice(start)
  return isExpandableWordFragment(fragment) ? fragment : ''
}

/** Leading run of non-whitespace characters — the word fragment a change is glued to on its right. */
function leadingWordFragment(text: string): string {
  let end = 0
  while (end < text.length && !WHITESPACE_RE.test(text[end])) {
    end++
    if (end > WORD_FRAGMENT_MAX_CHARS) return ''
  }
  const fragment = text.slice(0, end)
  return isExpandableWordFragment(fragment) ? fragment : ''
}

/** A single space or tab: the only gap we will bridge between two neighbouring edits. */
const BRIDGEABLE_GAP_RE = /^[ \t]{1,2}$/

/** Drop empty segments and merge neighbours that share an op. */
function mergeSegments(segments: readonly ComposeDiffSegment[]): ComposeDiffSegment[] {
  const out: ComposeDiffSegment[] = []
  for (const seg of segments) {
    if (seg.text === '') continue
    const last = out[out.length - 1]
    if (last && last.op === seg.op) last.text += seg.text
    else out.push({ op: seg.op, text: seg.text })
  }
  return out
}

/**
 * Normalize a diff into the canonical shape the cleanup rules assume:
 * alternating `equal` regions and change regions, where a change region is at
 * most one `delete` immediately followed by at most one `insert`.
 *
 * Ordering delete-before-insert is not cosmetic: the cleanup rules below reason
 * about "the delete side and the insert side of this region", and every reader
 * of `segments` renders removals before additions. Leaving the library's
 * incidental order in place would make both depend on input luck.
 */
function canonicalize(segments: readonly ComposeDiffSegment[]): ComposeDiffSegment[] {
  const out: ComposeDiffSegment[] = []
  let del = ''
  let ins = ''
  const flush = () => {
    if (del !== '') out.push({ op: 'delete', text: del })
    if (ins !== '') out.push({ op: 'insert', text: ins })
    del = ''
    ins = ''
  }
  for (const seg of segments) {
    if (seg.text === '') continue
    if (seg.op === 'delete') del += seg.text
    else if (seg.op === 'insert') ins += seg.text
    else {
      flush()
      const last = out[out.length - 1]
      if (last && last.op === 'equal') last.text += seg.text
      else out.push({ op: 'equal', text: seg.text })
    }
  }
  flush()
  return out
}

/**
 * Semantic cleanup — trade a minimal diff for a readable one.
 *
 * Three rules, each closing a different shape of scrap, applied in sweeps:
 *
 *  1. **Bridge a one-or-two-space gap between two edits.** `don't` → `do not`
 *     comes back as "remove `don't`, keep the space, insert `not `", which the
 *     eye has to reassemble. Absorbing the gap into both sides yields the one
 *     edit a human would describe.
 *  2. **Expand an edit to its word boundaries.** When a replacement starts or
 *     ends in the middle of a word, the letter fragment on the equal side is
 *     pulled into BOTH the delete and the insert, so `отч<del>ё</del><ins>е</ins>т`
 *     becomes `<del>отчёт</del><ins>отчет</ins>`.
 *  3. **Eliminate an equality squeezed between two edits** — Fraser's own rule,
 *     threshold and all (`isSqueezedEquality`). This is the one that reaches the
 *     scraps rules 1 and 2 cannot: a shared token stranded between a PURE
 *     deletion and a PURE insertion, where the gap is not whitespace (so rule 1
 *     declines) and neither neighbour is a replacement (so rule 2 declines).
 *     `посмотрим` → `изучим` renders as `[-посмотр]и[+зучи]м` without it.
 *
 * Rule 2 only fires for true replacements (both sides non-empty). A pure
 * insertion or deletion already covers whole tokens, and expanding it would
 * merely restate an untouched word as "removed, then re-added". It also only
 * fires over a word-SHAPED fragment — see `WORD_FRAGMENT_MAX_CHARS` for what
 * happens in scripts where "run of non-whitespace" is not a word.
 *
 * All three rules move text from an `equal` segment into a `delete` AND an
 * `insert` simultaneously, which is exactly why the byte-exact round trip
 * survives them: whatever leaves the equal side reappears once on each side.
 *
 * ## Why a fixed number of sweeps rather than "until it stops changing"
 *
 * A firing can enable another one further LEFT: absorbing a fragment turns a
 * pure insertion into a replacement, which then qualifies its own left-hand gap
 * for rule 2 — a gap this sweep has already walked past. Running sweeps until
 * quiescence therefore costs O(segments) sweeps in the worst case, i.e. time
 * quadratic in the segment count, inside a React render. A budget makes the
 * cost linear, and the budget is safe to impose because every intermediate
 * state is itself a valid, byte-exact diff (all three rules preserve the round
 * trip), so exhausting it degrades legibility and nothing else. Verified rather
 * than assumed: on a seventeen-pair corpus spanning ru/en/fr/el/ja, reordering,
 * heavy rewrites and punctuation soup, six sweeps produce output identical to
 * sixty-four. Re-run that comparison if you add a fourth rule.
 */
function cleanupSegments(input: readonly ComposeDiffSegment[]): ComposeDiffSegment[] {
  let segments = canonicalize(input)

  for (let pass = 0; pass < CLEANUP_MAX_PASSES; pass++) {
    let changed = false
    const out: ComposeDiffSegment[] = []

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (seg.op !== 'equal') {
        out.push({ ...seg })
        continue
      }

      // The edit that ENDS just before this gap, and the one that STARTS just
      // after it. A word fragment at the start of the gap is glued to the
      // former; one at the end of the gap is glued to the latter.
      const before = regionEndingBefore(segments, i)
      const after = regionAt(segments, i + 1)

      // Rule 1 — a one-or-two-space island between two edits.
      if (before && after && BRIDGEABLE_GAP_RE.test(seg.text)) {
        out.push({ op: 'delete', text: seg.text })
        out.push({ op: 'insert', text: seg.text })
        changed = true
        continue
      }

      // Rule 3 — Fraser's squeezed equality (see the docblock).
      if (before && after && isSqueezedEquality(seg.text, before, after)) {
        out.push({ op: 'delete', text: seg.text })
        out.push({ op: 'insert', text: seg.text })
        changed = true
        continue
      }

      // Rule 2 — hand word fragments to the replacement(s) on either side.
      let text = seg.text
      let head = ''
      let tail = ''

      if (before && before.del !== '' && before.ins !== '') {
        const frag = leadingWordFragment(text)
        if (frag !== '' && (endsWithWord(before.del) || endsWithWord(before.ins))) {
          head = frag
          text = text.slice(frag.length)
        }
      }
      if (after && after.del !== '' && after.ins !== '') {
        const frag = trailingWordFragment(text)
        if (frag !== '' && (startsWithWord(after.del) || startsWithWord(after.ins))) {
          tail = frag
          text = text.slice(0, text.length - frag.length)
        }
      }

      // A fragment is pushed as its own delete+insert pair; `canonicalize`
      // welds it onto the neighbouring edit at the end of the pass.
      if (head !== '') {
        out.push({ op: 'delete', text: head })
        out.push({ op: 'insert', text: head })
        changed = true
      }
      if (text !== '') out.push({ op: 'equal', text })
      if (tail !== '') {
        out.push({ op: 'delete', text: tail })
        out.push({ op: 'insert', text: tail })
        changed = true
      }
    }

    segments = canonicalize(mergeSegments(out))
    if (!changed) break
  }

  return segments
}

/**
 * Fraser's test: is this `equal` run small enough, relative to the edits it sits
 * between, that keeping it only shreds the reader's view of one change?
 *
 * The threshold is quoted, not invented — diff-match-patch eliminates
 * "equalities that are smaller than or equal to the insertions and deletions on
 * both sides of them" (https://neil.fraser.name/writing/diff/), which in code is
 * `|equality| <= max(ins, del)` on EACH side. Both halves matter: an equality
 * that is short next to one edit but long next to the other is a real island of
 * unchanged text between two independent edits, and swallowing it would merge
 * two things the reader wants to see separately.
 *
 * WE ADD ONE RESTRICTION Fraser does not have: the equality must contain no
 * whitespace. His algorithm renders a diff of two whole documents and can afford
 * to collapse a clause; ours renders an edit LIST the user accepts item by item,
 * where merging two edits into one costs the reader a choice.
 *
 * That is a deviation from the cited source, so it was measured, not assumed.
 * Verbatim on a fifteen-pair corpus the rule cascades through the spaces between
 * neighbouring edits, and two of the collapses are plainly wrong rather than
 * merely coarse:
 *   - `посмотрим отчёт и вернёмся` → `изучим отчет и ответим` goes from three
 *     visible word changes to one opaque sentence-sized blob;
 *   - `I don't know if` → `I do not know whether` swallows `know`, telling the
 *     reader a word changed when it did not.
 * With the restriction both come out right and every other pair in the corpus is
 * unchanged. The restriction only ever makes the rule fire LESS than Fraser's,
 * so it cannot introduce a collapse he would not also make.
 *
 * What it still fires on, deliberately: any whitespace-free run that passes the
 * threshold — a letter stranded inside a word (`[-посмотр]и[+зучи]м`, the case
 * this rule was added for), and also a whole short token stranded between two
 * larger edits by a reordering (`alpha beta` → `beta alpha`, whose raw diff is
 * `-alpha `, `=beta`, `+ alpha`). Both are the shredded interleaving Fraser
 * describes; neither is script-specific, and nothing here looks at script.
 */
function isSqueezedEquality(
  text: string,
  before: { del: string; ins: string },
  after: { del: string; ins: string },
): boolean {
  if (text === '' || WHITESPACE_RE.test(text)) return false
  return (
    text.length <= Math.max(before.del.length, before.ins.length) &&
    text.length <= Math.max(after.del.length, after.ins.length)
  )
}

function startsWithWord(text: string): boolean {
  return text.length > 0 && !/^\s/.test(text)
}

function endsWithWord(text: string): boolean {
  return text.length > 0 && !/\s$/.test(text)
}

/** The change region that STARTS at `index`, if any (canonical order: delete then insert). */
function regionAt(segments: readonly ComposeDiffSegment[], index: number): { del: string; ins: string } | null {
  let del = ''
  let ins = ''
  let i = index
  while (i < segments.length && segments[i].op !== 'equal') {
    if (segments[i].op === 'delete') del += segments[i].text
    else ins += segments[i].text
    i++
  }
  if (del === '' && ins === '') return null
  return { del, ins }
}

/** The change region that ENDS immediately before `index`, if any. */
function regionEndingBefore(
  segments: readonly ComposeDiffSegment[],
  index: number,
): { del: string; ins: string } | null {
  let start = index - 1
  while (start >= 0 && segments[start].op !== 'equal') start--
  return regionAt(segments, start + 1)
}

/** The coarse, always-correct answer: this whole region was replaced. */
function wholeRegionReplacement(before: string, after: string): ComposeDiffSegment[] {
  return [{ op: 'delete', text: before }, { op: 'insert', text: after }]
}

/**
 * Word-level segmentation of the two strings AS ONE PIECE.
 *
 * The only place `diffWordsWithSpace` is called, which is what makes the piece
 * size the whole question: anything inside this call can be matched against
 * anything else inside it. The caller decides — one paragraph when the rewrite
 * preserved the paragraph structure, the whole region when it did not.
 */
function segmentOnePiece(before: string, after: string): ComposeDiffSegment[] {
  if (before === after) return before === '' ? [] : [{ op: 'equal', text: before }]
  if (before === '') return [{ op: 'insert', text: after }]
  if (after === '') return [{ op: 'delete', text: before }]

  // `maxEditLength` makes the library give up (returning `undefined`) instead of
  // spending O(N·D) on two texts that barely resemble each other — see "## Cost".
  const parts = diffWordsWithSpace(before, after, { maxEditLength: WORD_DIFF_MAX_EDIT_LENGTH })
  if (!parts) return wholeRegionReplacement(before, after)

  return cleanupSegments(
    parts.map<ComposeDiffSegment>(part => ({
      op: part.added ? 'insert' : part.removed ? 'delete' : 'equal',
      text: part.value,
    })),
  )
}

/**
 * Word-diff a region line by line, or `null` when the region's lines do not
 * correspond one-to-one and there is nothing to line up.
 *
 * See "## Why the word level stops at a paragraph boundary" in the module
 * docblock for why equal line counts are the discriminator.
 */
function segmentPerLine(before: string, after: string): ComposeDiffSegment[] | null {
  const beforeLines = toLines(before)
  const afterLines = toLines(after)
  if (beforeLines.length < 2 || beforeLines.length !== afterLines.length) return null

  const out: ComposeDiffSegment[] = []
  for (let i = 0; i < beforeLines.length; i++) {
    for (const segment of segmentOnePiece(beforeLines[i], afterLines[i])) out.push(segment)
  }
  // Welding the per-line results back together: a change that runs across the
  // line break still reads as one edit, and neighbouring equal runs merge. This
  // only concatenates text, so both sides still add up to their inputs.
  return canonicalize(mergeSegments(out))
}

/**
 * Word-level segmentation of one changed region, ready for inline markup.
 *
 * Exported because the corrector (B7) needs the same rendering for a single
 * suggestion, without going through the block machinery.
 */
export function segmentComposeEdit(before: string, after: string): ComposeDiffSegment[] {
  if (before === '' && after === '') return []
  if (before === '') return [{ op: 'insert', text: after }]
  if (after === '') return [{ op: 'delete', text: before }]
  if (before === after) return [{ op: 'equal', text: before }]

  const cleaned = segmentPerLine(before, after) ?? segmentOnePiece(before, after)

  // Defence in depth against a future library change: if the segments stop
  // reproducing their own inputs, fall back to the coarse but always-correct
  // "all of it was replaced". Silently rendering markup that does not add up to
  // the text it claims to describe would be worse than a coarse diff.
  if (!segmentsRoundTrip(cleaned, before, after)) {
    return wholeRegionReplacement(before, after)
  }
  return cleaned
}

function segmentsRoundTrip(segments: readonly ComposeDiffSegment[], before: string, after: string): boolean {
  let b = ''
  let a = ''
  for (const seg of segments) {
    if (seg.op !== 'insert') b += seg.text
    if (seg.op !== 'delete') a += seg.text
  }
  return b === before && a === after
}

/**
 * Compare the draft's own text against its AI rewrite.
 *
 * `before` and `after` must already be the user's OWN text (`splitComposeBody`
 * output), never a whole draft body.
 */
export function diffComposeText(before: string, after: string): ComposeDiffResult {
  if (before === after) {
    const blocks: ComposeDiffBlock[] =
      before === ''
        ? []
        : [{ id: 'b0', kind: 'equal', before, after, segments: [{ op: 'equal', text: before }] }]
    return { blocks, changeCount: 0, identical: true }
  }

  const blocks: ComposeDiffBlock[] = []

  // Same ceiling as the word level, for the same reason (see "## Cost"): past a
  // few hundred changed lines the alignment stops being informative anyway, and
  // "the whole text was rewritten" is both cheap and true.
  const parts = diffArrays(toLines(before), toLines(after), {
    maxEditLength: LINE_DIFF_MAX_EDIT_LENGTH,
  })
  if (!parts) {
    pushBlock(blocks, { kind: wholeTextKind(before, after), before, after })
    return { blocks, changeCount: 1, identical: false }
  }

  let i = 0
  while (i < parts.length) {
    const part = parts[i]
    if (!part.added && !part.removed) {
      const text = part.value.join('')
      pushBlock(blocks, { kind: 'equal', before: text, after: text })
      i++
      continue
    }

    // Collect the whole run of adjacent changes as ONE region. Within a run the
    // removed lines are contiguous in `before` and the added lines contiguous
    // in `after` regardless of the order the library emitted them, so joining
    // each side keeps both round trips exact — and a rewrite that merges two
    // paragraphs into one stays a single reviewable edit instead of three.
    let removed = ''
    let added = ''
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) removed += parts[i].value.join('')
      else added += parts[i].value.join('')
      i++
    }
    const kind: ComposeDiffBlockKind = removed !== '' && added !== ''
      ? 'replace'
      : added !== ''
        ? 'insert'
        : 'delete'
    pushBlock(blocks, { kind, before: removed, after: added })
  }

  const changeCount = blocks.reduce((n, b) => (b.kind === 'equal' ? n : n + 1), 0)
  return { blocks, changeCount, identical: changeCount === 0 }
}

/** Which kind a single block covering the whole text is (the two sides differ). */
function wholeTextKind(before: string, after: string): ComposeDiffBlockKind {
  if (before === '') return 'insert'
  if (after === '') return 'delete'
  return 'replace'
}

function pushBlock(
  blocks: ComposeDiffBlock[],
  spec: { kind: ComposeDiffBlockKind; before: string; after: string },
): void {
  blocks.push({
    id: `b${blocks.length}`,
    kind: spec.kind,
    before: spec.before,
    after: spec.after,
    segments:
      spec.kind === 'equal'
        ? [{ op: 'equal', text: spec.before }]
        : segmentComposeEdit(spec.before, spec.after),
  })
}

/**
 * Rebuild the text from `blocks`, taking the rewrite's version for every block
 * whose id is in `acceptedIds` and the draft's version for everything else.
 *
 * This is the seam the per-edit corrector (B7) sits on, and it is why blocks
 * carry verbatim `before` / `after` strings: accepting a subset produces text
 * assembled only from bytes that were already in one of the two inputs. It
 * never consults `segments`, so cleanup heuristics can be tuned freely without
 * any risk of changing what a click writes into the draft.
 *
 * `applyComposeDiff(blocks, new Set())` is the original; passing every changed
 * block's id yields the full rewrite.
 */
export function applyComposeDiff(
  blocks: readonly ComposeDiffBlock[],
  acceptedIds: ReadonlySet<string>,
): string {
  let out = ''
  for (const block of blocks) {
    out += block.kind !== 'equal' && acceptedIds.has(block.id) ? block.after : block.before
  }
  return out
}

/** Ids of every changed block, in order — the "accept everything" selection. */
export function changedBlockIds(blocks: readonly ComposeDiffBlock[]): string[] {
  return blocks.filter(b => b.kind !== 'equal').map(b => b.id)
}

// ---------------------------------------------------------------------------
// §3.3 B7 — span-addressed edits (the per-edit corrector's unit)
//
// Everything above this line addresses an edit by its POSITION IN A LIST
// (`b0`, `b1`, ...) — fine for rendering one preview, wrong for accepting edits
// one at a time. §2.251: re-run the generation and `b3` points at a different
// block, so an acceptance recorded against it lands somewhere the user never
// looked.
//
// B7 addresses an edit by a SPAN IN THE DRAFT instead — `(offset, length)` plus
// the replacement, the shape LanguageTool's HTTP API uses for
// `matches[].offset` / `.length` / `.replacements[]`. The draft is stable while
// the review panel is open, so the same span denotes the same place in this
// preview and in the next one; identity is a property of the text, not of the
// list we happened to build around it.
//
// The two schemes coexist deliberately. The block scheme still backs the
// whole-rewrite review panel (B4), where there is exactly one preview and a
// single Replace; the span scheme backs per-edit acceptance. Do not "unify"
// them by giving blocks content ids — a block is defined by an alignment of two
// whole texts and has no anchor in either one.
// ---------------------------------------------------------------------------

/**
 * The minimum an edit needs to be applied: replace `[offset, offset+length)`
 * with `replacement`. A structural subset of `ProofreadEdit` in
 * `@mailcopilot/types`, kept local so `applyComposeEdits` is usable by anything
 * that can express a span — not just the proofreader.
 */
export type ComposeEditSpan = {
  offset: number
  length: number
  replacement: string
}

/**
 * A model's proposal BEFORE it has been anchored in the draft: "replace this
 * exact snippet with that one". Carries no offsets, because a language model
 * cannot count characters reliably — asking it for an index produces confident
 * nonsense. Offsets are computed here, by search, from text we already hold.
 */
export type ComposeEditProposal = {
  /** Exact snippet the model claims to have copied out of the draft. */
  original: string
  /** What replaces it. */
  replacement: string
}

/**
 * One proposal successfully anchored in the draft: the proposal plus the span
 * it resolved to, in ascending offset order and never overlapping a neighbour.
 */
export type ResolvedComposeEdit = ComposeEditProposal & {
  offset: number
  length: number
}

/**
 * Longest snippet an edit may replace. A "fix" that swallows half the message
 * is not an edit the user can meaningfully accept on its own — it is a rewrite
 * wearing an edit's clothes, and accepting it would reintroduce exactly the
 * all-or-nothing substitution B7 exists to replace. Such proposals are dropped.
 */
export const COMPOSE_EDIT_MAX_SPAN_CHARS = 600

/**
 * Stable, CONTENT-derived identity for one edit (§2.251).
 *
 * The id is the EQUALITY PREDICATE for acceptance carry, not a display token:
 * the panel holds a set of accepted ids and, after a re-check, keeps an
 * acceptance iff a newly offered edit reports the same id (`useProofread`).
 * §2.251 therefore demands that the mapping be INJECTIVE over
 * `(offset, length, original, replacement)` — two DIFFERENT edits sharing an id
 * would let a stale acceptance be applied to an edit the user never reviewed,
 * which is the exact failure content-derived identity exists to prevent.
 *
 * So the id ENCODES the tuple; it is not a digest of it. A short hash cannot
 * carry this predicate: the tuple originates in a model response — untrusted,
 * attacker-shaped input (CLAUDE.md §5) — and a hostile provider only has to
 * append bytes to `replacement` until two edits collide, so "collisions are
 * unlikely" is an argument that is simply not available here. Length-prefixing
 * `original` makes the three numeric fields and the two strings uniquely
 * decodable, so distinct tuples yield distinct ids BY CONSTRUCTION; `:` is the
 * delimiter because no JS number renders with one.
 *
 * Consequence, and the reason it is stated here: the id CONTAINS draft text. It
 * is renderer/IPC plumbing that travels beside the very bytes it encodes, and
 * it inherits the draft's rule — never logged, never in telemetry, never in
 * Sentry.
 */
export function composeEditId(edit: {
  offset: number
  length: number
  original: string
  replacement: string
}): string {
  const original = String(edit.original ?? '')
  const replacement = String(edit.replacement ?? '')
  return `e${edit.offset}:${edit.length}:${original.length}:${original}${replacement}`
}

/**
 * Anchor a list of model proposals in `text`, dropping every one that cannot be
 * placed (§3.3 B7 AC-e).
 *
 * Resolution is a SEARCH, not arithmetic on a model-supplied index. A proposal
 * survives only if its `original` occurs verbatim in `text`; the returned span
 * is therefore guaranteed to satisfy
 * `text.slice(offset, offset + length) === original`, so a caller never has to
 * defend against a span that does not match what it claims to replace.
 *
 * A monotonic cursor walks forward through the draft as proposals are placed,
 * so a snippet occurring several times ("Thanks", "the the") resolves to
 * SUCCESSIVE occurrences in document order rather than all collapsing onto the
 * first. When a proposal cannot be found at or after the cursor the whole text
 * is searched once more — a model that returned its edits out of order should
 * lose its ordering, not its edits — and the final list is re-sorted by offset.
 *
 * Dropped, in this order:
 *   - a proposal that is not two usable strings, or a no-op (`original ===
 *     replacement`);
 *   - a snippet longer than {@link COMPOSE_EDIT_MAX_SPAN_CHARS};
 *   - a snippet that does not occur in `text` at all;
 *   - a snippet whose span OVERLAPS one already accepted. Overlapping spans
 *     cannot both be applied, and picking a winner at apply time would make the
 *     result depend on the order the user clicked. The earlier-starting span
 *     wins and the other is discarded here, before the user is ever shown it.
 *
 * Returns the surviving edits plus the number dropped, so callers can report
 * the loss instead of silently shortening the list. Whatever else the caller
 * hung on a proposal (a category, an explanation) is CARRIED THROUGH on the
 * resolved edit: re-associating it afterwards by matching text would give two
 * identical fixes with different explanations the same metadata.
 */
export function resolveComposeEdits<P extends ComposeEditProposal>(
  text: string,
  proposals: readonly P[],
): { edits: Array<P & ResolvedComposeEdit>; dropped: number } {
  if (!Array.isArray(proposals)) return { edits: [], dropped: 0 }
  if (typeof text !== 'string' || text.length === 0) {
    return { edits: [], dropped: proposals.length }
  }

  const placed: Array<P & ResolvedComposeEdit> = []
  let dropped = 0
  let cursor = 0

  for (const proposal of proposals) {
    const original = typeof proposal?.original === 'string' ? proposal.original : ''
    const replacement = typeof proposal?.replacement === 'string' ? proposal.replacement : ''
    if (original.length === 0 || original === replacement) {
      dropped++
      continue
    }
    if (original.length > COMPOSE_EDIT_MAX_SPAN_CHARS) {
      dropped++
      continue
    }
    let offset = text.indexOf(original, cursor)
    if (offset === -1) offset = text.indexOf(original)
    if (offset === -1) {
      dropped++
      continue
    }
    // Spread FIRST, so the normalized strings and the resolved span win over
    // whatever the proposal carried, and the caller's own fields survive.
    placed.push({ ...proposal, original, replacement, offset, length: original.length })
    cursor = offset + original.length
  }

  // Ascending by offset; the shorter span first on a tie so the overlap sweep
  // below is deterministic regardless of the order the model emitted.
  placed.sort((a, b) => (a.offset - b.offset) || (a.length - b.length))

  const edits: Array<P & ResolvedComposeEdit> = []
  let end = 0
  for (const edit of placed) {
    if (edit.offset < end) {
      dropped++
      continue
    }
    edits.push(edit)
    end = edit.offset + edit.length
  }
  return { edits, dropped }
}

/**
 * Apply `edits` to `text` in one left-to-right pass and return the result.
 *
 * This is the seam per-edit acceptance sits on: the caller filters the full
 * edit list down to the ones the user ticked and passes ONLY those, so the
 * output is assembled from bytes that were either already in the draft or in a
 * replacement the user looked at. An empty list returns `text` unchanged;
 * passing every edit is "accept all".
 *
 * DEFENSIVE, because the caller may be the renderer applying a list it has held
 * across a re-render: a span that runs past the end of `text`, carries a
 * negative or non-integer bound, or overlaps a span already applied is SKIPPED,
 * not clamped. Skipping loses one edit; clamping would write a replacement
 * across a boundary the user never approved. The tail after the last applied
 * edit is always copied verbatim, so no byte outside an applied span can be
 * lost.
 */
export function applyComposeEdits(
  text: string,
  edits: readonly ComposeEditSpan[],
): string {
  if (typeof text !== 'string') return ''
  if (!Array.isArray(edits) || edits.length === 0) return text

  const ordered = [...edits]
    .filter((e) =>
      !!e
      && Number.isInteger(e.offset) && e.offset >= 0
      && Number.isInteger(e.length) && e.length >= 0
      && e.offset + e.length <= text.length
      && typeof e.replacement === 'string')
    .sort((a, b) => (a.offset - b.offset) || (a.length - b.length))

  let out = ''
  let cursor = 0
  for (const edit of ordered) {
    // Overlaps an already-applied span — skip it rather than splice across a
    // boundary the user did not review.
    if (edit.offset < cursor) continue
    out += text.slice(cursor, edit.offset)
    out += edit.replacement
    cursor = edit.offset + edit.length
  }
  return out + text.slice(cursor)
}
