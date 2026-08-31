// ──────────────────────────────────────────────────────────────────────────
// language.ts — §3.3 B6, the LOCAL half of "what language is this?".
//
// Pure logic, no dependencies. The trigram model itself (`franc`, MIT ©
// Titus Wormer, https://github.com/wooorm/franc) is INJECTED as a scorer
// function by the caller — `electron/services/aiTranslate.ts` passes
// `francAll`. Two reasons, both load-bearing:
//
//   1. `packages/core` is imported by the RENDERER bundle. franc ships a
//      trigram table for 180+ languages; pulling it in through the core barrel
//      would put that table in the renderer for a feature that runs entirely in
//      main. This module is therefore NOT re-exported from `packages/core/index.ts`
//      — main imports it by path. Keep it that way.
//   2. The gating decisions below (too short / undetermined / near-tie) are the
//      part worth testing, and injecting the scorer lets the tests drive both
//      the REAL franc (see language.test.ts) and hand-built edge cases.
//
// NOTHING here talks to a provider, and the ANSWER is advisory — see
// `detectTextLanguage` for what it is allowed to decide and what it
// deliberately is not. The INPUT is a different matter, and an earlier version
// of this header said "nothing here is a security boundary" without that
// distinction: every pass below is synchronous, runs on the IPC handler path,
// and runs on text a stranger wrote, so `LANGUAGE_DETECTION_MAX_INPUT_CHARS`
// and the backtracking rules on the patterns below are availability controls
// and load-bearing as such (§3.3.B6.f2 — pressing "Reply" on a hostile message
// froze the main process for seconds). "Advisory" describes the verdict, never
// the budget.
// ──────────────────────────────────────────────────────────────────────────

import type { TranslateLanguageCode } from '@mailcopilot/types'

/**
 * Minimum amount of SCRIPT — letters and the marks written on them — the
 * detector requires before it will name a language at all. THIS is the real
 * reliability control, not the margin below.
 *
 * franc's own README states the model is "easily confused on small samples" and
 * ships `minLength: 10` as its default — a default the README frames as the
 * point below which it refuses, not as a point above which it is reliable. Ten
 * characters is far too generous for our use: a wrong answer here does not
 * degrade a search ranking (franc's usual habitat), it puts a wrong language
 * name in front of the user and, before this constant existed, decided whether
 * we called a paid provider at all.
 *
 * ## The unit has been re-measured TWICE, and the name states it for a reason
 *
 * The gate originally compared `normalized.length` — every code unit the
 * normaliser happened not to remove — against 100, and the fix that moved it
 * onto `\p{L}` kept the 100 unchanged (§3.3.B6.f1 iteration 2). A number
 * carried across a change of unit is a different number: ordinary Latin prose
 * is about four fifths letters, so the bar rose by roughly a fifth, and it rose
 * through exactly the band ordinary business mail occupies.
 *
 * `\p{L}` was then the wrong unit for a different reason (§3.3.B6.f1 iteration
 * 3): "letter" does not mean the same amount of writing in every script. In
 * Devanagari the vowel signs are Unicode MARKS (`\p{M}`), not letters, so half
 * of an ordinary Hindi sentence does not count as anything — and Hindi is one
 * of the sixteen languages this feature offers. Measured on this machine, all
 * counts taken AFTER `normalizeForLanguageDetection` (the calibration test
 * asserts these exact numbers in BOTH units):
 *
 *     script            code points   \p{L}   \p{L}+\p{M}   ratio (new unit)
 *     English mail             103      84         84            0.82
 *     German mail               91      76         76            0.84
 *     French mail               94      77         77            0.82
 *     Russian mail             101      86         86            0.85
 *     Turkish mail              99      83         83            0.84
 *     Hindi mail               101      51         82            0.81
 *     Arabic mail (vowelled)   102      51         91            0.89
 *     Chinese mail              47      42         42            0.89
 *     Japanese mail             54      51         51            0.94
 *     Korean mail               59      44         44            0.75
 *
 * Under `\p{L}` the Hindi and fully-vowelled Arabic rows sit at HALF the ratio
 * of every Latin and Cyrillic row, so a threshold calibrated on Latin refused
 * ordinary mail in those scripts — a regression this feature's own fix
 * introduced. Under `\p{L}+\p{M}` every row lands in the same 0.75–0.94 band,
 * which is what makes one number mean the same thing across the sixteen.
 *
 * ## Why the number itself did not have to move again
 *
 * 80 was calibrated on the Latin population below, and for every script in that
 * population `\p{M}` matches NOTHING (the rows above show `\p{L}` and
 * `\p{L}+\p{M}` identical for Latin, Cyrillic and CJK). The new unit is a
 * superset that is empty exactly where the calibration was taken, so the figure
 * carries over provably rather than by assumption — the mistake made twice
 * before is not being made a third time.
 *
 * Measured with franc 6.2.0 over short business mail (transcript reproduced in
 * language.test.ts, which asserts these exact counts):
 *
 *     "Thanks, see you tomorrow."           20 units,  25 cp → hat  ✗
 *     "Спасибо, до завтра."                 15 units,  19 cp → ukr  ✗
 *     "Hi team, please find attached …"     71 units,  87 cp → eng  ✓
 *     "Guten Tag, anbei finden Sie …"       76 units,  91 cp → deu  ✓
 *     "Bonjour, veuillez trouver …"         77 units,  94 cp → fra  ✓
 *     "Hi Paul, could you please review …"  84 units, 103 cp → eng  ✓
 *
 * The short samples are confidently wrong at 15–20 units; the ordinary ones are
 * right from 71 units up. The units-per-character ratio across that population
 * is 0.82 ± 0.02, so the character-era threshold of 100 is 82 units in this
 * one. 80 is that figure rounded, and rounded DOWN on purpose: the samples this
 * gate must not begin refusing sit at 71–77, the wrong answers it must keep
 * refusing sit at 15–20, and there is nothing in between to separate. It is
 * still an order of magnitude above franc's own default.
 *
 * Counted AFTER `normalizeForLanguageDetection`, so a hundred characters of
 * quoted headers and URLs buy the detector no confidence it has not earned —
 * see {@link countDetectionScriptChars} for why counting script rather than
 * string length is load-bearing rather than pedantic. A CJK sample is counted
 * character-for-character there, so eighty of those is a much larger sample
 * than eighty Latin ones; the gate errs toward refusing a label rather than
 * inventing one, which is the right direction for something the interface only
 * ever shows as a caption.
 *
 * It is a heuristic, not a proof, which is exactly why a refusal here hands the
 * choice to the user instead of degrading to a guess.
 */
export const LANGUAGE_DETECTION_MIN_SCRIPT_CHARS = 80

/**
 * Smallest gap between the best and second-best candidate that still counts as
 * an answer. A TIE-BREAKER, and nothing more — read this before using it as if
 * it were a confidence score.
 *
 * franc normalises its output so the top candidate is always exactly 1, which
 * means there is no absolute confidence number to threshold; the only signal
 * available is the distance to the runner-up. That signal is weak, because the
 * runner-up is almost always a CLOSE RELATIVE of the right answer even when the
 * right answer wins. Measured with franc 6.2.0 on normalised business mail:
 *
 *     English, ~96 chars    → eng 1.0000, sco 0.9860   margin 0.0140  ✓ named
 *     English, ~170 chars   → eng 1.0000, sco 0.9186   margin 0.0814  ✓ named
 *     Russian sample A      → rus 1.0000, bul 0.9972   margin 0.0028  → refused
 *     Russian sample B      → bul 1.0000, rus 0.9754   margin 0.0246  ✗ named bul
 *
 * Two things follow, and both shaped this constant. First, a CORRECT answer can
 * score 0.014 while a WRONG one scores 0.025, so this number cannot separate
 * right from wrong and a threshold high enough to exclude the last row would
 * reject the first. It is therefore set just low enough to catch a genuine coin
 * flip — the third row, where the model itself cannot separate Russian from
 * Bulgarian — and no higher. Second, the length gate above is what actually
 * keeps the detector honest; this one only removes the ties.
 *
 * The last row is also why the detected language is ADVISORY everywhere
 * downstream: franc cannot reliably tell Russian from Bulgarian or Macedonian
 * at any length we tested. It is never sent to the model, never used to skip a
 * translation, and only ever shown as a label.
 */
export const LANGUAGE_DETECTION_MIN_MARGIN = 0.01

/**
 * A trigram language scorer, shaped exactly like franc's `francAll`: candidates
 * sorted best-first as `[iso-639-3, distance]`, distance normalised so the best
 * is 1. `[['und', 1]]` is franc's "I will not answer" and is honoured as such.
 */
export type TrigramScorer = (text: string) => ReadonlyArray<readonly [string, number]>

/**
 * Detection verdict.
 *
 *   - `too_short`    — the normalised text carries fewer script characters
 *                      than {@link LANGUAGE_DETECTION_MIN_SCRIPT_CHARS}.
 *   - `undetermined` — the scorer answered `und`, answered nothing, or its top
 *                      two candidates were within {@link LANGUAGE_DETECTION_MIN_MARGIN}.
 *
 * Both collapse into the same user-facing refusal; they are kept apart here so
 * the tests (and a future counter) can tell "there was not enough text" from
 * "there was text and the model could not read it".
 */
export type LanguageDetection =
  | { ok: true; iso6393: string }
  | { ok: false; reason: 'too_short' | 'undetermined' }

/**
 * The most text this module will ever run a SYNCHRONOUS pass over. Longer input
 * is SLICED, never refused.
 *
 * ## A property of the detector, not of one feature that calls it
 *
 * Everything below — the normaliser, the script count, the scorer — is
 * synchronous and runs on text that arrived in somebody's mail, so the AMOUNT
 * of it is a main-process stall the sender of a message chooses. The measured
 * shape is recorded on {@link normalizeForLanguageDetection}: 1.0 ms at 750
 * characters, 4.1 ms at 1500, 16.5 ms at 3000 for the worst adversarial shape,
 * i.e. quadratic. `messages.body_text` is stored up to 200 000 characters, and
 * nothing in that curve survives being handed one of those.
 *
 * The cap therefore lives HERE rather than in each caller. §3.3.B6.f2: the
 * reading path capped its input and the draft-suggestion path, added later, did
 * not — one press of "Reply" on a hostile message was a multi-second freeze of
 * IPC, IDLE, the send queue and the window. A rule the next caller has to
 * remember is a rule that will be forgotten again; this one cannot be.
 *
 * ## Why a slice and not a refusal
 *
 * A language label is not a translation. The size gate answers with
 * {@link LANGUAGE_DETECTION_MIN_SCRIPT_CHARS} (80) worth of script, so the head
 * of a message carries the answer whenever there is one, and truncating the
 * sample cannot make the label WRONG in the way truncating a translation makes
 * the text wrong (that asymmetry is why `TRANSLATE_INPUT_CHAR_CAP` refuses
 * instead). Refusing here would cost a correct advisory answer to protect a
 * budget the slice already protects.
 *
 * The figure deliberately EQUALS `TRANSLATE_INPUT_CHAR_CAP`
 * (`electron/services/aiTranslate.ts`): the reading path refuses anything
 * longer before it ever calls in here, so this cap is inert on that path and
 * cannot change an answer part 1 already gives. Lowering it would.
 */
export const LANGUAGE_DETECTION_MAX_INPUT_CHARS = 3000

/**
 * Strip the parts of an email body that carry no language signal but plenty of
 * trigrams, so the length gate measures PROSE rather than machinery.
 *
 * Removed: quoted lines (`>` prefixed), URLs, email addresses, and digit runs.
 * All four are approximately language-neutral and all four are abundant in mail
 * — a forwarded thread can be mostly URLs and headers, and without this the
 * length gate would happily certify a hundred characters of `https://` as
 * "enough text to identify a language".
 *
 * PUNCTUATION IS DELIBERATELY LEFT IN, and the size gate is what changed instead
 * (§3.3.B6.f1). An earlier version of this docblock claimed punctuation runs
 * were stripped; they were not, and the gate measured `normalized.length`, so
 * `"Hi!" + "!".repeat(200)` cleared a threshold whose entire justification is
 * "a hundred characters of PROSE are enough to identify a language". The fix is
 * not more stripping — a stripper is a moving target against arbitrary
 * non-letter filler (dingbats, box drawing, emoji, CJK punctuation) — it is to
 * count what the threshold was always talking about. See
 * {@link countDetectionScriptChars}. Punctuation stays because it carries real
 * trigram signal for the SCORER (French elision, German quotation style), and
 * franc does its own normalisation on top of this.
 *
 * EVERY PATTERN HERE RUNS ON HOSTILE INPUT and must have NO SUPERLINEAR
 * BACKTRACKING: this function is called synchronously from the IPC handler
 * path, so a pattern that can be made to re-split the same characters is a
 * main-process stall the sender of a message chooses (see the address
 * pattern's own note). Three of the four are linear by construction — `\S+`
 * after a literal prefix, `\d+` and `\s+` each have no second variable-length
 * part to disagree with — and a new pattern added here has to be able to say
 * at least as much.
 *
 * THE ADDRESS PATTERN IS NOT LINEAR IN THE LENGTH OF THE TEXT, and an earlier
 * version of this docblock said it was (found independently by both reviewers
 * of §3.3.B6). What the respelling below removed is the backtracking WITHIN one
 * attempt; what it did not remove — and could not, for a pattern that has to
 * start at a word boundary — is that the attempt is repeated from EVERY word
 * boundary, and `[^\s@]+` scans forward from each of them looking for an `@`
 * that a hostile text simply omits. Text with a boundary every other character
 * therefore costs a scan per boundary, i.e. quadratic work, and the honest
 * claim is that it is BOUNDED rather than linear: each scan dies on the first
 * character it cannot consume, and {@link LANGUAGE_DETECTION_MAX_INPUT_CHARS}
 * (3000 characters, applied by {@link detectTextLanguage} at the entry to the
 * synchronous pass, i.e. before this function is reached on any path) puts a
 * ceiling on the product. The bound belongs to the DETECTOR, not to one
 * feature: an earlier version of this note credited `TRANSLATE_INPUT_CHAR_CAP`,
 * the reading path's own refusal, and that is precisely the claim §3.3.B6.f2
 * disproved — part 2 added a second caller that never passed through it.
 *
 * Measured on this machine, all at that 3000-character cap:
 *
 *     3000 chars of ordinary business mail                    0.1 ms
 *     the incident input, `('a.' x 400) + '@' + ('.' x 2199)`  1.2 ms
 *     `('a-' x 1500)` — a word boundary every two characters
 *       and no `@` anywhere — the worst shape measured        16.5 ms
 *
 * and the quadratic shape is visible in the last one: 1.0 ms at 750 characters,
 * 4.1 ms at 1500, 16.5 ms at 3000. Sixteen milliseconds is a frame, not a
 * stall — but ONLY because 3000 is the largest input that can reach here, and
 * what guarantees that is {@link LANGUAGE_DETECTION_MAX_INPUT_CHARS}, applied
 * by {@link detectTextLanguage} to every caller. It is NOT guaranteed by any
 * one feature's own cap: this note used to say the worst case needed "a
 * deliberately built message plus an explicit click on Translate", and by then
 * it was already false — the reply-language suggestion (§3.3.B6 part 2) reached
 * this function on a mere press of "Reply", with an uncapped 200 000-character
 * body behind it. The pre-respelling pattern took 4.7 SECONDS on 3000
 * characters, and that is the difference this note exists to keep.
 *
 * Deliberately conservative: it never reorders or rewrites words, so the text
 * fed to the scorer is a subset of the original, not a paraphrase of it. This
 * result is used ONLY for detection — the text that gets translated is always
 * the original, untouched.
 */
export function normalizeForLanguageDetection(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  const withoutQuotes = text
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
  return withoutQuotes
    // URLs (scheme-qualified and bare www.) — pure noise for trigrams.
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    // Email addresses, including the ones in quoting attribution lines.
    //
    // THE DOMAIN SIDE IS SPELLED AS DOT-SEPARATED LABELS THAT CANNOT THEMSELVES
    // CONTAIN A DOT, and that is a denial-of-service fix, not a style choice
    // (§3.3.B6.f1 iteration 3). The previous spelling was
    // `[^\s@]+@[^\s@]+\.[^\s@]+\b`: two adjacent quantifiers on either side of
    // the literal dot, BOTH able to match a dot themselves. Where the domain
    // does not end at a word boundary the engine has to try every way of
    // splitting that run into "before the dot" and "after the dot", which is
    // quadratic in the length of the run and repeated from every word boundary
    // the local part offers. Measured on this machine, a 3000-character input
    // of the shape `('a.' x 400) + '@' + ('.' x 2199)` took 4.7 SECONDS; the
    // spelling below takes 1.2 ms on that same input and 0.1 ms on ordinary
    // business mail of the same size. Bounded, NOT linear — the worst shape
    // measured is a different one, and it is recorded in this function's own
    // docblock above.
    //
    // That mattered because detection is synchronous and runs on the IPC
    // handler path: those seconds are the main process not answering IDLE, the
    // send queue, the snooze poller or any window. The trigger is CHEAPER than
    // an AI click, and this note used to say otherwise: since §3.3.B6 part 2
    // the reply-language suggestion detects on a press of "Reply", so a hostile
    // message plus the ordinary act of answering it is the whole exploit — no
    // click on "Translate" required. What bounds the damage without removing it
    // is `LANGUAGE_DETECTION_MAX_INPUT_CHARS`, the detector's own input
    // ceiling, applied to every caller.
    //
    // Equivalence was measured, not assumed: over a corpus of real addresses
    // (subdomains, `+tags`, multi-label TLDs, angle-bracket attribution lines,
    // non-ASCII domains) and over 3000 characters of business prose the two
    // spellings produce BYTE-IDENTICAL output. They differ only on malformed
    // addresses — `a@b..c`, `a@.b.c` — which the new spelling declines to match
    // and therefore leaves in place. Harmless: what stays behind is a handful
    // of characters in a sample whose size gate counts script characters.
    .replace(/\b[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+\b/g, ' ')
    // Digit runs (dates, amounts, ids) and the punctuation that frames them.
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * How much WRITING a candidate sample carries: code points that belong to a
 * script, i.e. Unicode `Letter` or `Mark`.
 *
 * This is the quantity {@link LANGUAGE_DETECTION_MIN_SCRIPT_CHARS} is about,
 * and it has been wrong in two different ways, so both are recorded here.
 *
 * It used to be `normalized.length`, which counts every code unit the
 * normaliser happened not to remove — so a two-word greeting padded with
 * punctuation, dingbats or box-drawing characters cleared a bar that exists
 * because a hundred characters of PROSE are where franc stopped being
 * confidently wrong in our measurements. Counting script closes that without a
 * blocklist: anything that is not writing simply does not count, whether or not
 * we anticipated it.
 *
 * It was then `\p{L}` alone, which is not the same amount of writing in every
 * script and therefore cannot be compared against one threshold. Devanagari
 * writes its vowels as marks ON the consonant (`\p{Mn}` / `\p{Mc}`), so an
 * ordinary Hindi sentence is only about half `\p{L}` — measured 51 letters in
 * 101 code points, against 84 in 103 for the English equivalent. A gate
 * calibrated on Latin then refused ordinary mail in a language we offer as a
 * target. Adding `\p{M}` puts that same Hindi sentence at 82 of 101, i.e. back
 * in the Latin band, and it is not a special case for Devanagari: it is the
 * same correction for vowelled Arabic (51 → 91 of 102) and for any decomposed
 * (NFD) Latin text, where the accent is a mark rather than part of the letter.
 *
 * A mark is written ON a base, so counting marks is counting strokes of the
 * same word rather than adding a separate class of character — but that is only
 * true up to a point, and the point is enforced rather than assumed. Two hundred
 * combining acutes stacked on one letter ("Zalgo" text) is a filler channel
 * exactly like the punctuation padding this function already refuses, so marks
 * are counted only where a base letter carries them and only up to
 * {@link DETECTION_MARKS_PER_BASE_CAP} per base. Measured on real text, the
 * longest run is TWO — Devanagari `ि` + `्` + a matra, vowelled Arabic, Hebrew
 * with niqqud and Thai all peak at two marks per base — so the cap of three is
 * above anything writing produces and far below anything padding needs. A mark
 * with no base before it counts as nothing.
 *
 * `\p{L}` still covers every script we detect on its own, including the ones
 * with no case distinction (Arabic, Hebrew) and the ideographic ones — a
 * Chinese or Japanese sample is counted character-for-character, which is
 * deliberate: a hundred CJK characters is a far larger sample than a hundred
 * Latin ones, so the gate errs toward refusing a label rather than toward
 * inventing one.
 *
 * Astral-plane characters count once, not twice: the regex is Unicode-aware, so
 * it matches by code POINT, unlike `String.prototype.length`.
 */
export function countDetectionScriptChars(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  // CANONICAL FORM FIRST, so the count measures writing rather than encoding.
  // The same word arrives spelled either way over IMAP, and without this the
  // two spellings measure differently: decomposed Hangul is the loud case —
  // NFD explodes a 44-unit Korean mail to 107, because the jamo are LETTERS —
  // and decomposed Latin is the quiet one. That is an encoding-dependent way to
  // buy confidence the sample has not earned, i.e. the same defect as
  // punctuation padding, and it predates the mark counting below. NFC never
  // throws and cannot lengthen a canonical sample.
  let total = 0
  // One base letter plus the marks written on it. `\p{L}\p{M}*` is genuinely
  // linear — the two classes are disjoint, so there is nothing for the engine
  // to re-split, and each match resumes where the last one ended — which is
  // strictly stronger than the "no superlinear backtracking" this module
  // requires of every pattern it runs on hostile input (see
  // `normalizeForLanguageDetection`).
  for (const cluster of text.normalize('NFC').match(/\p{L}\p{M}*/gu) ?? []) {
    // Spread, not `.length`: an astral base letter is two UTF-16 units and one
    // code point.
    const marks = [...cluster].length - 1
    total += 1 + (marks > DETECTION_MARKS_PER_BASE_CAP ? DETECTION_MARKS_PER_BASE_CAP : marks)
  }
  return total
}

/**
 * How many combining marks one base letter may contribute to the size count.
 *
 * Three, because real writing peaks at two (measured across Devanagari,
 * vowelled Arabic, Hebrew with niqqud and Thai) and padding needs hundreds.
 * Without a cap, `\p{M}` would be the next filler channel after punctuation —
 * the same defect this file has already been fixed for twice.
 */
const DETECTION_MARKS_PER_BASE_CAP = 3

/**
 * Name the language of `text`, or REFUSE.
 *
 * What this function is allowed to decide: whether we can put a language label
 * on the text at all. What it is deliberately NOT allowed to decide: anything
 * about the translation itself. The detected code never reaches the model (the
 * instruction names only the target language), and a source that matches the
 * target is still translated rather than short-circuited — precisely because a
 * detector that mistakes Russian for Bulgarian must not be able to answer
 * "already in your language" on a message that is not.
 *
 * Refusing is a first-class outcome, not a degraded one: §3.3 B6 hands the
 * choice back to the user, who states the source language explicitly and gets
 * the same translation. Guessing here would produce a confident wrong label
 * with nothing in the interface to contradict it.
 *
 * Input longer than {@link LANGUAGE_DETECTION_MAX_INPUT_CHARS} is SLICED to it
 * before anything else runs — the bound on this synchronous pass belongs to the
 * detector, not to whoever calls it.
 */
export function detectTextLanguage(text: string, scorer: TrigramScorer): LanguageDetection {
  // THE INPUT CAP, applied at the entry to the synchronous pass so it holds for
  // every caller rather than for the ones that remembered to apply it
  // (§3.3.B6.f2 — see LANGUAGE_DETECTION_MAX_INPUT_CHARS). Slicing is linear;
  // everything after this line is not.
  const bounded = typeof text === 'string' && text.length > LANGUAGE_DETECTION_MAX_INPUT_CHARS
    ? text.slice(0, LANGUAGE_DETECTION_MAX_INPUT_CHARS)
    : text
  const normalized = normalizeForLanguageDetection(bounded)
  // SCRIPT, not string length: the threshold's justification is about prose,
  // and string length lets non-writing filler buy confidence the sample has not
  // earned — while `\p{L}` alone under-counts the scripts that write vowels as
  // marks (§3.3.B6.f1).
  if (countDetectionScriptChars(normalized) < LANGUAGE_DETECTION_MIN_SCRIPT_CHARS) {
    return { ok: false, reason: 'too_short' }
  }
  let candidates: ReadonlyArray<readonly [string, number]>
  try {
    candidates = scorer(normalized)
  } catch {
    // The scorer is someone else's code. A throw is "no answer", never an
    // exception that escapes into the IPC promise.
    return { ok: false, reason: 'undetermined' }
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, reason: 'undetermined' }
  }
  const best = candidates[0]
  if (!Array.isArray(best) || typeof best[0] !== 'string' || best[0].length === 0) {
    return { ok: false, reason: 'undetermined' }
  }
  // franc's own refusal token. Honoured verbatim — it already means "the sample
  // is too small or carries no usable trigrams".
  if (best[0] === 'und') return { ok: false, reason: 'undetermined' }
  const runnerUp = candidates[1]
  if (runnerUp && typeof runnerUp[1] === 'number' && typeof best[1] === 'number') {
    if (best[1] - runnerUp[1] < LANGUAGE_DETECTION_MIN_MARGIN) {
      return { ok: false, reason: 'undetermined' }
    }
  }
  return { ok: true, iso6393: best[0] }
}

/**
 * ISO 639-3 (what the detector speaks) → our language code (what the interface
 * and the prompt table speak).
 *
 * Intentionally PARTIAL. A language the detector names that is not in this
 * table resolves to `null`, and `null` is a successful outcome that simply
 * carries no label — it is NOT a refusal. Refusing there would mean a Bulgarian
 * or Czech mail could not be translated at all merely because we do not offer
 * those as targets, which has nothing to do with whether we can translate the
 * message INTO the user's language.
 */
export const ISO6393_TO_LANGUAGE_CODE: Readonly<Record<string, TranslateLanguageCode>> = {
  eng: 'en',
  rus: 'ru',
  ukr: 'uk',
  deu: 'de',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  nld: 'nl',
  pol: 'pl',
  tur: 'tr',
  arb: 'ar',
  cmn: 'zh',
  jpn: 'ja',
  kor: 'ko',
  hin: 'hi',
}

/** Map one ISO 639-3 code into our set, or `null` when we have no code for it. */
export function languageCodeFromIso6393(iso6393: string): TranslateLanguageCode | null {
  return ISO6393_TO_LANGUAGE_CODE[iso6393] ?? null
}

/**
 * Our language code → the English language NAME used in the model instruction.
 *
 * This table is the entire reason `targetLang` can be renderer-supplied without
 * being a prompt-injection channel: the renderer picks a member of a
 * sixteen-value enum, and the only string that ever reaches the prompt is a
 * literal from THIS file. No renderer string is ever concatenated into an
 * instruction.
 *
 * Typed `Record<TranslateLanguageCode, string>` on purpose — adding a code to
 * the union without adding it here is a compile error, so the table cannot
 * drift behind the enum.
 */
export const TRANSLATE_LANGUAGE_NAMES: Record<TranslateLanguageCode, string> = {
  en: 'English',
  ru: 'Russian',
  uk: 'Ukrainian',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  tr: 'Turkish',
  ar: 'Arabic',
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
}

/** Every accepted language code, as a runtime list (zod enums, interface lists). */
export const TRANSLATE_LANGUAGE_CODES = Object.keys(
  TRANSLATE_LANGUAGE_NAMES,
) as TranslateLanguageCode[]

/** Whether an arbitrary string is one of our accepted language codes. */
export function isTranslateLanguageCode(value: unknown): value is TranslateLanguageCode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(TRANSLATE_LANGUAGE_NAMES, value)
}
