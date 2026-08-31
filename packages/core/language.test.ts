import { describe, it, expect } from 'vitest'
import { francAll } from 'franc'
import {
  LANGUAGE_DETECTION_MAX_INPUT_CHARS,
  LANGUAGE_DETECTION_MIN_SCRIPT_CHARS,
  LANGUAGE_DETECTION_MIN_MARGIN,
  ISO6393_TO_LANGUAGE_CODE,
  TRANSLATE_LANGUAGE_CODES,
  TRANSLATE_LANGUAGE_NAMES,
  detectTextLanguage,
  countDetectionScriptChars,
  isTranslateLanguageCode,
  languageCodeFromIso6393,
  normalizeForLanguageDetection,
  type TrigramScorer,
} from './language'

/**
 * The scorer used in production. Imported here (and ONLY here, plus the main-
 * side service) so the thresholds are calibrated against the real model rather
 * than against a fake that agrees with them by construction.
 */
const realScorer: TrigramScorer = (text) => francAll(text)

/** Business-mail prose, long enough to clear the length gate. */
const EN_LONG = 'Hi team, please find attached the invoice for last month and the completed work report. '
  + 'Please confirm receipt of the documents and let me know if any corrections are needed.'
const DE_LONG = 'Guten Tag, anbei finden Sie die Rechnung für den letzten Monat sowie den Leistungsnachweis. '
  + 'Bitte bestätigen Sie den Erhalt der Unterlagen und melden Sie sich bei Rückfragen.'
const FR_LONG = 'Bonjour, veuillez trouver ci-joint la facture du mois dernier ainsi que le rapport de travaux. '
  + 'Merci de confirmer la bonne réception et de nous prévenir en cas de question.'

/**
 * The three "✓" rows of the LANGUAGE_DETECTION_MIN_SCRIPT_CHARS transcript — the
 * SHORT samples the constant was measured on, as opposed to the two-sentence
 * `*_LONG` ones above. They sit at 71–77 letters, i.e. just under the gate, and
 * the calibration test asserts their exact counts: that is what stops the
 * threshold from being carried across another change of unit unnoticed.
 */
const EN_ANCHOR = 'Hi team, please find attached the invoice for last month and the completed work report.'
const DE_ANCHOR = 'Guten Tag, anbei finden Sie die Rechnung für den letzten Monat sowie den Leistungsnachweis.'
const FR_ANCHOR = 'Bonjour, veuillez trouver ci-joint la facture du mois dernier ainsi que le rapport de travaux.'

/**
 * Ordinary business mail in the scripts that broke the `\p{L}` unit, plus the
 * ones that did not (§3.3.B6.f1 iteration 3).
 *
 * Devanagari writes vowels as MARKS on the consonant and fully-vowelled Arabic
 * writes them as marks too, so under `\p{L}` alone both count about half of
 * what a Latin sentence of the same length counts — and a threshold calibrated
 * on Latin refused them. CJK and Hangul carry no marks at all and are here as
 * the control: they must measure identically in both units, which is what makes
 * the number 80 carry over rather than need re-deriving.
 *
 * All four are named correctly by real franc, so the only thing standing
 * between them and a caption is the size gate.
 */
const HI_ORDINARY = 'नमस्ते, कृपया पिछले महीने का चालान और कार्य रिपोर्ट देख लें और शुक्रवार तक अपनी टिप्पणियाँ भेज दीजिए।'
const AR_VOWELLED = 'مَرْحَبًا، أَرْفَقْتُ لَكُمُ الْفَاتُورَةَ عَنِ الشَّهْرِ الْمَاضِي وَتَقْرِيرَ الْعَمَلِ الْمُنْجَزِ.'
const ZH_ORDINARY = '您好，附件是上个月的发票和工作报告，请确认收到并在本周五之前回复我，谢谢您的配合，祝工作顺利。'
const KO_ORDINARY = '안녕하세요, 지난달 청구서와 작업 보고서를 첨부합니다. 확인 후 금요일까지 회신 부탁드립니다. 감사합니다.'

/**
 * The two samples that straddle the gate. Ordinary business prose, differing
 * only in length: 79 letters against 80. REAL franc names BOTH of them `eng`
 * confidently (margins 0.099 and 0.086), so the only thing that separates them
 * in the assertions below is the threshold itself — which is exactly what a
 * boundary sample has to be, and what the old `EN_LONG`-based calibration
 * (142 letters, a whole unit-change away from the bar) could not be.
 */
const BOUNDARY_BELOW = 'Hi Anna, the quarterly review has moved to Thursday morning. '
  + 'Could you confirm this works for you?'
const BOUNDARY_AT = 'Hello Anna, the review meeting has moved to Thursday morning. '
  + 'Could you confirm this works for you?'

/**
 * The regression the unit change caused: an ordinary hundred-character business
 * mail. It cleared the character-era gate, franc names it `eng` with a healthy
 * margin — and a threshold of 100 LETTERS refused it, costing the caption and
 * putting a "state the language yourself" picker in front of the user for a
 * message the detector had no trouble with.
 */
const ORDINARY_SHORT_MAIL = 'Hi Paul, could you please review the attached proposal '
  + 'before Friday and send your comments back to me.'

describe('normalizeForLanguageDetection', () => {
  it('drops quoted lines so a forwarded thread does not count as prose', () => {
    const out = normalizeForLanguageDetection('Hello there\n> quoted reply line\n> another quoted line\nBye')
    expect(out).toBe('Hello there Bye')
  })

  it('drops URLs, addresses and digit runs', () => {
    const out = normalizeForLanguageDetection(
      'See https://example.com/a/b?c=1 and www.example.org, write to bob@example.com by 2026-08-29.',
    )
    expect(out).not.toMatch(/https?:|www\.|@|\d/)
    expect(out).toContain('See')
    expect(out).toContain('write to')
  })

  it('returns an empty string for non-string and empty input', () => {
    expect(normalizeForLanguageDetection('')).toBe('')
    expect(normalizeForLanguageDetection(undefined as unknown as string)).toBe('')
  })

  it('collapses whitespace so the size gate measures words, not layout', () => {
    expect(normalizeForLanguageDetection('a\n\n\n   b\t\tc')).toBe('a b c')
  })

  it('still strips ordinary addresses byte-for-byte after the linearity fix', () => {
    // The equivalence half of the denial-of-service fix (§3.3.B6.f1 iteration
    // 3): the pattern was respelled to remove the backtracking, and these are
    // the shapes real mail actually carries.
    const out = normalizeForLanguageDetection(
      'Send it to billing@example.co.uk and cc ops@sub.domain.org, '
      + 'On Mon, John <john.doe@corp.example.com> wrote: first.last+tag@mail.example.com.',
    )
    expect(out).not.toContain('@')
    expect(out).toContain('Send it to')
    expect(out).toContain('wrote:')
  })

  it('normalises hostile input in bounded time (§3.3.B6.f1 iteration 3)', () => {
    // The address pattern used to be `[^\s@]+@[^\s@]+\.[^\s@]+\b`, whose two
    // quantifiers could both match a dot: on an input that never reaches the
    // closing word boundary the engine tried every way of splitting the run,
    // and THIS 3000-character string took 4.7 seconds on the machine that found
    // it. Detection is synchronous on the IPC handler path, so those seconds
    // are the main process not answering IDLE, the send queue or any window —
    // and reaching them takes a hostile message plus one click on "Translate".
    //
    // The budget is deliberately loose (50 ms against a measured ~1 ms) so this
    // asserts the absence of a stall rather than the speed of a CI runner.
    const hostile = 'a.'.repeat(400) + '@' + '.'.repeat(2199)
    expect(hostile.length).toBe(3000)
    const started = Date.now()
    normalizeForLanguageDetection(hostile)
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('stays bounded on the WORST shape, not only the one from the incident', () => {
    // Found independently by both reviewers of §3.3.B6: the respelled address
    // pattern is bounded, not linear. `[^\s@]+` is retried from EVERY word
    // boundary looking for an `@` that this input never provides, so work grows
    // quadratically with the number of boundaries — 1.0 ms at 750 characters,
    // 4.1 ms at 1500, 16.5 ms at 3000 on the machine that measured it, i.e.
    // sixteen times the cost of the incident's own input.
    //
    // Pinning ONLY the incident shape would mean the next pattern is compared
    // against the case that was already fixed, which is how the previous stall
    // reached production. The budget is loose (250 ms against a measured
    // 16.5 ms) for the same reason as the case below: this asserts the absence
    // of a stall, not the speed of a CI runner — the pre-fix quadratic took
    // 4.7 SECONDS.
    const hostile = 'a-'.repeat(1500)
    expect(hostile.length).toBe(3000)
    const started = Date.now()
    normalizeForLanguageDetection(hostile)
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('keeps the whole detection gate bounded on the same hostile input', () => {
    // The exploitable path is the exported one: `detectTextLanguage` normalises
    // and then measures. Asserting it here keeps the guarantee attached to what
    // the IPC handler actually calls, not only to the helper.
    const hostile = 'a.'.repeat(400) + '@' + '.'.repeat(2199)
    const started = Date.now()
    // The VERDICT is not asserted — it belongs to franc's model, and pinning it
    // would make this timing guarantee depend on a trigram table. Only the
    // bound is ours.
    expect(() => detectTextLanguage(hostile, realScorer)).not.toThrow()
    expect(Date.now() - started).toBeLessThan(50)
  })
})

describe('countDetectionScriptChars — the size gate counts script, not characters (§3.3.B6.f1)', () => {
  it('counts only script characters', () => {
    expect(countDetectionScriptChars('abc')).toBe(3)
    expect(countDetectionScriptChars('a1b2c3')).toBe(3)
    expect(countDetectionScriptChars('!!!,.;:—«»()[]{}')).toBe(0)
    expect(countDetectionScriptChars('   \n\t  ')).toBe(0)
    expect(countDetectionScriptChars('')).toBe(0)
    expect(countDetectionScriptChars(undefined as unknown as string)).toBe(0)
  })

  it('counts every script we detect, cased or not', () => {
    expect(countDetectionScriptChars('Привет')).toBe(6)
    expect(countDetectionScriptChars('مرحبا')).toBe(5)
    expect(countDetectionScriptChars('こんにちは')).toBe(5)
    expect(countDetectionScriptChars('中文')).toBe(2)
  })

  it('counts the marks a base letter carries, so Devanagari is not half-counted', () => {
    // `क` + `ि` is one written syllable of two code points, and both are
    // writing. Under `\p{L}` alone the vowel sign counted as nothing, which is
    // what made an ordinary Hindi mail measure half of its Latin equivalent.
    expect(countDetectionScriptChars('कि')).toBe(2)
    expect(countDetectionScriptChars('नमस्ते')).toBe(6)
  })

  it('measures writing, not encoding: the same word counts the same in NFC and NFD', () => {
    // Without the canonical form the count depends on how the sender spelled
    // the text. Decomposed Hangul is the loud case — every syllable becomes two
    // or three JAMO, which are letters — and it is an encoding-dependent way to
    // clear a gate that exists to certify prose.
    for (const word of ['café', '안녕하세요', 'नमस्ते', 'Grüße']) {
      expect(countDetectionScriptChars(word.normalize('NFD')))
        .toBe(countDetectionScriptChars(word.normalize('NFC')))
    }
    expect(countDetectionScriptChars('café')).toBe(4)
    expect(countDetectionScriptChars('안녕하세요')).toBe(5)
  })

  it('refuses to let stacked marks become the next filler channel', () => {
    // Marks are counted because they are writing — but two hundred combining
    // acutes on one letter is padding, exactly like the punctuation run this
    // gate already refuses. Capped per base, so the sample below measures five,
    // not two hundred and two.
    const zalgo = 'Hi' + '\u0301'.repeat(200)
    expect(countDetectionScriptChars(zalgo)).toBeLessThan(10)
    expect(detectTextLanguage(zalgo, realScorer)).toEqual({ ok: false, reason: 'too_short' })
    // A mark with no base before it is not writing on anything.
    expect(countDetectionScriptChars('\u0301\u0301\u0301')).toBe(0)
  })

  it('counts an astral-plane character once, unlike String.length', () => {
    // U+10400 DESERET CAPITAL LETTER LONG I — two UTF-16 code units, one letter.
    const deseret = '\u{10400}'
    expect(deseret.length).toBe(2)
    expect(countDetectionScriptChars(deseret)).toBe(1)
  })
})

describe('detectTextLanguage — refusals', () => {
  it('is not fooled by punctuation padding (§3.3.B6.f1)', () => {
    // The regression this replaced: the gate compared `normalized.length`, and
    // `normalizeForLanguageDetection` never removed punctuation despite its
    // docblock claiming otherwise. A greeting franc calls Haitian Creole
    // therefore cleared a hundred-character bar meant to certify prose.
    const padded = 'Thanks, see you tomorrow.' + '!'.repeat(200)
    expect(normalizeForLanguageDetection(padded).length).toBeGreaterThan(LANGUAGE_DETECTION_MIN_SCRIPT_CHARS)
    expect(detectTextLanguage(padded, realScorer)).toEqual({ ok: false, reason: 'too_short' })
  })

  it('is not fooled by non-letter filler that no stripper anticipated', () => {
    // The reason the fix counts letters rather than removing more shapes: the
    // filler space is open-ended (dingbats, box drawing, emoji, CJK punctuation).
    const padded = 'Спасибо, до завтра.' + '★─。'.repeat(70)
    expect(normalizeForLanguageDetection(padded).length).toBeGreaterThan(LANGUAGE_DETECTION_MIN_SCRIPT_CHARS)
    expect(detectTextLanguage(padded, realScorer)).toEqual({ ok: false, reason: 'too_short' })
  })

  it('still names ordinary prose that carries enough letters, punctuation and all', () => {
    // The other half of the calibration: the fix must not start refusing the
    // samples the constant was measured on.
    expect(countDetectionScriptChars(normalizeForLanguageDetection(EN_LONG)))
      .toBeGreaterThanOrEqual(LANGUAGE_DETECTION_MIN_SCRIPT_CHARS)
    expect(detectTextLanguage(EN_LONG, realScorer)).toEqual({ ok: true, iso6393: 'eng' })
  })

  it('refuses text below the minimum length instead of guessing', () => {
    // The exact sample from the LANGUAGE_DETECTION_MIN_SCRIPT_CHARS docblock: franc
    // calls this Haitian Creole. We refuse before asking it.
    expect(detectTextLanguage('Thanks, see you tomorrow.', realScorer))
      .toEqual({ ok: false, reason: 'too_short' })
    expect(detectTextLanguage('Спасибо, до завтра.', realScorer))
      .toEqual({ ok: false, reason: 'too_short' })
  })

  it('measures length AFTER normalisation, so URL padding buys no confidence', () => {
    const padded = 'Hallo. ' + 'https://example.com/some/very/long/tracking/link?utm=1 '.repeat(4)
    expect(padded.length).toBeGreaterThan(LANGUAGE_DETECTION_MIN_SCRIPT_CHARS)
    expect(detectTextLanguage(padded, realScorer))
      .toEqual({ ok: false, reason: 'too_short' })
  })

  it("honours franc's own 'und' refusal token", () => {
    const scorer: TrigramScorer = () => [['und', 1]]
    expect(detectTextLanguage(EN_LONG, scorer)).toEqual({ ok: false, reason: 'undetermined' })
  })

  it('refuses a near-tie between the top two candidates', () => {
    const scorer: TrigramScorer = () => [
      ['eng', 1],
      ['sco', 1 - LANGUAGE_DETECTION_MIN_MARGIN / 2],
    ]
    expect(detectTextLanguage(EN_LONG, scorer)).toEqual({ ok: false, reason: 'undetermined' })
  })

  it('accepts a gap at or above the margin', () => {
    const scorer: TrigramScorer = () => [
      ['eng', 1],
      ['sco', 1 - LANGUAGE_DETECTION_MIN_MARGIN],
    ]
    expect(detectTextLanguage(EN_LONG, scorer)).toEqual({ ok: true, iso6393: 'eng' })
  })

  it('treats an empty, malformed or throwing scorer answer as undetermined, never a throw', () => {
    expect(detectTextLanguage(EN_LONG, () => [])).toEqual({ ok: false, reason: 'undetermined' })
    expect(detectTextLanguage(EN_LONG, () => [['', 1]])).toEqual({ ok: false, reason: 'undetermined' })
    expect(detectTextLanguage(EN_LONG, () => undefined as unknown as never))
      .toEqual({ ok: false, reason: 'undetermined' })
    expect(detectTextLanguage(EN_LONG, () => { throw new Error('boom') }))
      .toEqual({ ok: false, reason: 'undetermined' })
  })
})

describe('detectTextLanguage — the synchronous pass is bounded (§3.3.B6.f2)', () => {
  /** A scorer that records exactly how much text it was handed. */
  function recordingScorer(seen: number[]): TrigramScorer {
    return (text: string) => {
      seen.push(text.length)
      return francAll(text)
    }
  }

  it('never hands the scorer more than the cap, whatever the caller passes', () => {
    // The class-level guarantee. `messages.body_text` is stored up to 200 000
    // characters; the pass below is synchronous and quadratic in the worst
    // shape, so an uncapped caller is a multi-second freeze of the main process
    // that the SENDER of a message chooses. The cap belongs here rather than in
    // each caller, because the caller that forgot it is the defect.
    const seen: number[] = []
    detectTextLanguage(EN_LONG + ' filler.'.repeat(50_000), recordingScorer(seen))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeLessThanOrEqual(LANGUAGE_DETECTION_MAX_INPUT_CHARS)
  })

  it('slices rather than refusing — a quarter-megabyte mail still gets its label', () => {
    // A label is not a translation: the size gate answers with 80 script
    // characters, so the head of the message carries the answer, and refusing
    // here would cost a correct advisory answer for nothing. An ordinary German
    // mail followed by a 250 000-character tracking-link footer — the shape a
    // newsletter or a long forwarded thread actually has.
    const long = `${DE_LONG}\n${'https://tracking.example.com/click?id=abcdef0123456789&utm=news\n'.repeat(4000)}`
    expect(long.length).toBeGreaterThan(200_000)
    expect(detectTextLanguage(long, realScorer)).toEqual({ ok: true, iso6393: 'deu' })
  })

  it('names the sliced text, not the whole one — the slice is the input', () => {
    // What the cap means precisely: the detector answers about the first N
    // characters. A German head with a Russian tail is read as German, and the
    // scorer is handed exactly the head.
    const seen: number[] = []
    const head = `${DE_LONG} `.repeat(20)
    const mixed = head + 'Здравствуйте, во вложении счёт за прошлый месяц и отчёт о работах. '.repeat(200)
    expect(head.length).toBeGreaterThan(LANGUAGE_DETECTION_MAX_INPUT_CHARS)
    const scorer: TrigramScorer = (text) => {
      seen.push(text.length)
      return francAll(text)
    }
    detectTextLanguage(mixed, scorer)
    expect(seen[0]).toBeLessThanOrEqual(LANGUAGE_DETECTION_MAX_INPUT_CHARS)
    expect(normalizeForLanguageDetection(mixed.slice(0, LANGUAGE_DETECTION_MAX_INPUT_CHARS)))
      .not.toMatch(/[\u0400-\u04FF]/)
  })

  it('leaves anything within the cap untouched', () => {
    const seen: number[] = []
    detectTextLanguage(EN_LONG, recordingScorer(seen))
    // Normalisation may shorten it; nothing may lengthen it, and no slice
    // happened at this size.
    expect(seen[0]).toBeLessThanOrEqual(EN_LONG.length)
  })

  it('completes the worst adversarial shape well inside a frame budget', () => {
    // The shape from the `normalizeForLanguageDetection` docblock — a word
    // boundary every two characters and no `@` anywhere — at 200 000
    // characters, which is what the draft-suggestion path used to pass in.
    // Uncapped this is tens of seconds; capped it is the recorded ~16 ms.
    const hostile = 'a-'.repeat(100_000)
    const started = Date.now()
    detectTextLanguage(hostile, realScorer)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('equals the reading path input cap, so part 1 answers cannot change', () => {
    // `TRANSLATE_INPUT_CHAR_CAP` (electron/services/aiTranslate.ts) refuses
    // anything longer BEFORE detecting, so this cap is inert there. Lowering it
    // would silently change labels part 1 already gives.
    expect(LANGUAGE_DETECTION_MAX_INPUT_CHARS).toBe(3000)
  })
})

describe('detectTextLanguage — real franc, calibration transcript', () => {
  // These three are the "✓" rows of the LANGUAGE_DETECTION_MIN_SCRIPT_CHARS docblock.
  // If franc changes its model and one of them flips, the constant's stated
  // justification is no longer true and this test says so.
  it('names ordinary business mail correctly at ~100+ characters', () => {
    expect(detectTextLanguage(EN_LONG, realScorer)).toEqual({ ok: true, iso6393: 'eng' })
    expect(detectTextLanguage(DE_LONG, realScorer)).toEqual({ ok: true, iso6393: 'deu' })
    expect(detectTextLanguage(FR_LONG, realScorer)).toEqual({ ok: true, iso6393: 'fra' })
  })

  it('pins the transcript in BOTH units, so the next unit change cannot pass quietly', () => {
    // The §3.3.B6.f1 defect this replaces: the gate was moved from characters
    // to letters and the number came along unchanged, raising the bar by about
    // a fifth. The docblock's own numbers are asserted here — script characters
    // AND string length — so a future edit that keeps a figure across a change
    // of unit has to walk past a red test to do it. (This is the LATIN
    // population the constant was calibrated on, where the two later units
    // coincide because `\p{M}` matches nothing in it; the cross-script rows are
    // asserted separately below.)
    const transcript: ReadonlyArray<readonly [string, number, number]> = [
      [EN_ANCHOR, 71, 87],
      [DE_ANCHOR, 76, 91],
      [FR_ANCHOR, 77, 94],
      [ORDINARY_SHORT_MAIL, 84, 103],
      [EN_LONG, 142, 174],
    ]
    for (const [sample, scriptChars, chars] of transcript) {
      const normalized = normalizeForLanguageDetection(sample)
      expect(normalized.length).toBe(chars)
      expect(countDetectionScriptChars(normalized)).toBe(scriptChars)
      // The Latin population carries no marks, so the two units agree on it.
      expect((normalized.match(/\p{L}/gu) ?? []).length).toBe(scriptChars)
      // Every row of the transcript is prose franc reads correctly; the ratio
      // between the two columns is what the threshold was converted with.
      expect(countDetectionScriptChars(normalized) / normalized.length).toBeGreaterThan(0.80)
      expect(countDetectionScriptChars(normalized) / normalized.length).toBeLessThan(0.84)
    }
  })

  it('measures the same amount of writing in every script we offer (§3.3.B6.f1 iteration 3)', () => {
    // The defect this replaces: the unit was `\p{L}`, and "letter" is not the
    // same amount of writing in every script. Devanagari and vowelled Arabic
    // write vowels as MARKS, so an ordinary sentence counted about HALF of what
    // the Latin calibration population counted — and a Hindi mail a hundred
    // characters long was refused a caption for a language we offer as a
    // target.
    //
    // Both columns are asserted for every row: the old unit (`\p{L}`) so the
    // regression is visible in the numbers rather than only in the verdict, and
    // the new one so a third change of unit cannot pass quietly.
    const transcript: ReadonlyArray<readonly [string, number, number, number]> = [
      // sample, code points, \p{L}, \p{L}+\p{M}
      [ORDINARY_SHORT_MAIL, 103, 84, 84],
      [HI_ORDINARY, 101, 51, 82],
      [AR_VOWELLED, 102, 51, 91],
      [ZH_ORDINARY, 47, 42, 42],
      [KO_ORDINARY, 59, 44, 44],
    ]
    for (const [sample, codePoints, lettersOnly, scriptChars] of transcript) {
      const normalized = normalizeForLanguageDetection(sample)
      expect([...normalized].length).toBe(codePoints)
      expect((normalized.match(/\p{L}/gu) ?? []).length).toBe(lettersOnly)
      expect(countDetectionScriptChars(normalized)).toBe(scriptChars)
      // The point of the new unit: one band for all of them. Under `\p{L}` the
      // Hindi and Arabic rows sit at 0.50, half of the Latin rows.
      const ratio = scriptChars / codePoints
      expect(ratio).toBeGreaterThan(0.74)
      expect(ratio).toBeLessThan(0.95)
    }
  })

  it('labels ordinary Hindi and Arabic mail that the letters-only unit refused', () => {
    // The user-visible half. Both samples are a hundred code points of ordinary
    // business mail that real franc names without difficulty; under `\p{L}`
    // they measured 51 against a bar of 80 and got no caption at all.
    expect((normalizeForLanguageDetection(HI_ORDINARY).match(/\p{L}/gu) ?? []).length)
      .toBeLessThan(LANGUAGE_DETECTION_MIN_SCRIPT_CHARS)
    expect(detectTextLanguage(HI_ORDINARY, realScorer)).toEqual({ ok: true, iso6393: 'hin' })
    expect(languageCodeFromIso6393('hin')).toBe('hi')

    expect((normalizeForLanguageDetection(AR_VOWELLED).match(/\p{L}/gu) ?? []).length)
      .toBeLessThan(LANGUAGE_DETECTION_MIN_SCRIPT_CHARS)
    expect(detectTextLanguage(AR_VOWELLED, realScorer)).toEqual({ ok: true, iso6393: 'arb' })
  })

  it('keeps refusing short CJK and Hangul samples, in both units alike', () => {
    // The control rows. They carry no marks, so the unit change moves them by
    // exactly nothing — which is why the threshold did not have to be
    // re-derived — and they stay below the bar: eighty CJK characters is a far
    // larger sample than eighty Latin ones, and the gate errs toward refusing a
    // label rather than inventing one.
    for (const sample of [ZH_ORDINARY, KO_ORDINARY]) {
      const normalized = normalizeForLanguageDetection(sample)
      expect(countDetectionScriptChars(normalized))
        .toBe((normalized.match(/\p{L}/gu) ?? []).length)
      expect(countDetectionScriptChars(normalized)).toBeLessThan(LANGUAGE_DETECTION_MIN_SCRIPT_CHARS)
      expect(detectTextLanguage(sample, realScorer)).toEqual({ ok: false, reason: 'too_short' })
    }
  })

  it('is calibrated AT the boundary, not far above it', () => {
    // Two ordinary mails, 79 letters and 80, both named `eng` by real franc.
    // The gate is the only difference between them, which is what makes this a
    // calibration test rather than a restatement of the constant.
    expect(countDetectionScriptChars(normalizeForLanguageDetection(BOUNDARY_BELOW)))
      .toBe(LANGUAGE_DETECTION_MIN_SCRIPT_CHARS - 1)
    expect(countDetectionScriptChars(normalizeForLanguageDetection(BOUNDARY_AT)))
      .toBe(LANGUAGE_DETECTION_MIN_SCRIPT_CHARS)
    expect(detectTextLanguage(BOUNDARY_BELOW, realScorer)).toEqual({ ok: false, reason: 'too_short' })
    expect(detectTextLanguage(BOUNDARY_AT, realScorer)).toEqual({ ok: true, iso6393: 'eng' })
  })

  it('labels an ordinary hundred-character business mail (§3.3.B6.f1 review iteration 2)', () => {
    // The user-visible cost of the un-converted threshold: this message cleared
    // the character-era gate and franc names it without difficulty, but 100
    // LETTERS refused it — no caption, and a language picker for a mail nobody
    // had any trouble reading.
    expect(countDetectionScriptChars(normalizeForLanguageDetection(ORDINARY_SHORT_MAIL))).toBeLessThan(100)
    expect(detectTextLanguage(ORDINARY_SHORT_MAIL, realScorer)).toEqual({ ok: true, iso6393: 'eng' })
  })

  it('is honest about the Cyrillic confusion the docblock records', () => {
    // The two Russian rows of the LANGUAGE_DETECTION_MIN_MARGIN transcript.
    // Sample A is the near-tie (rus 1.0000 / bul 0.9972) the margin gate is
    // there to refuse; sample B clears the margin and franc names Bulgarian —
    // a WRONG answer we ship as a label and never act on. Both behaviours are
    // asserted so the docblock cannot quietly become false: if franc's model
    // changes, this test fails and the justification gets rewritten with it.
    const ruSampleA = 'Здравствуйте, направляю вам счёт за прошлый месяц и акт выполненных работ. '
      + 'Пожалуйста, подтвердите получение документов и сообщите, если потребуются правки.'
    expect(detectTextLanguage(ruSampleA, realScorer)).toEqual({ ok: false, reason: 'undetermined' })

    const ruSampleB = 'Добрый день! Мы получили ваше письмо и уже начали работу над задачей. '
      + 'Ориентировочный срок готовности — пятница. Если что-то изменится, я сразу вам сообщу.'
    const verdictB = detectTextLanguage(ruSampleB, realScorer)
    expect(verdictB).toEqual({ ok: true, iso6393: 'bul' })
    // …and the wrong answer costs nothing beyond a missing label, because 'bul'
    // is not one of our codes.
    if (verdictB.ok) expect(languageCodeFromIso6393(verdictB.iso6393)).toBeNull()
  })
})

describe('language code tables', () => {
  it('maps detector codes into our set, and unknown ones to null', () => {
    expect(languageCodeFromIso6393('eng')).toBe('en')
    expect(languageCodeFromIso6393('rus')).toBe('ru')
    // Bulgarian is a language franc reports but we do not offer — it must map
    // to null (a label-less success), never to a refusal or a wrong code.
    expect(languageCodeFromIso6393('bul')).toBeNull()
    expect(languageCodeFromIso6393('nope')).toBeNull()
  })

  it('never maps two detector codes onto the same language code', () => {
    const codes = Object.values(ISO6393_TO_LANGUAGE_CODE)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('names every accepted code, with no extras', () => {
    expect(TRANSLATE_LANGUAGE_CODES.length).toBe(16)
    for (const code of TRANSLATE_LANGUAGE_CODES) {
      expect(TRANSLATE_LANGUAGE_NAMES[code]).toBeTruthy()
    }
    // Every mapped detector code must be an accepted code — otherwise the
    // detector could produce a `sourceLang` the contract does not allow.
    for (const mapped of Object.values(ISO6393_TO_LANGUAGE_CODE)) {
      expect(TRANSLATE_LANGUAGE_CODES).toContain(mapped)
    }
  })

  it('recognises only real codes, and not inherited object properties', () => {
    expect(isTranslateLanguageCode('ru')).toBe(true)
    expect(isTranslateLanguageCode('xx')).toBe(false)
    expect(isTranslateLanguageCode('constructor')).toBe(false)
    expect(isTranslateLanguageCode('toString')).toBe(false)
    expect(isTranslateLanguageCode(null)).toBe(false)
  })
})
