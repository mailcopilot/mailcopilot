import { describe, it, expect } from 'vitest'
import { splitComposeBody, joinComposeBody } from './composeBody'
import { quoteText } from './mail'

/** Our own reply shape: `['', '', attribution, quoteText(original)].join('\n')`. */
function replyBody(typed: string, attribution: string, original: string): string {
  return [typed, '', attribution, quoteText(original)].join('\n')
}

describe('splitComposeBody', () => {
  it('treats a plain draft with no quote/signature as entirely the user\'s own text', () => {
    const body = 'Hi Bob,\n\nHere is the report you asked for.\n\nThanks!'
    expect(splitComposeBody(body)).toEqual({ lead: '', own: body, tail: '' })
  })

  it('keeps the quoted original out of the own part on a reply', () => {
    const body = replyBody('Sounds good, shipping today.', 'On Mon, alice@example.com wrote:', 'Can you ship it?')
    const split = splitComposeBody(body)
    expect(split.own).toBe('Sounds good, shipping today.')
    expect(split.tail).toBe('\n\nOn Mon, alice@example.com wrote:\n> Can you ship it?')
  })

  it('pulls the attribution line directly above the quote into the tail', () => {
    const split = splitComposeBody('My answer.\n\nOn Mon, alice wrote:\n> question?')
    expect(split.own).toBe('My answer.')
    expect(split.tail).toContain('On Mon, alice wrote:')
  })

  it('LIMITATION: an attribution separated from the quote by a blank line stays in the rewritable own part, not the tail', () => {
    // findTailStart() only consults the SINGLE line directly above the quote
    // line (`lines[i - 1]`). When a blank line sits between the attribution and
    // the quote, that immediate predecessor is the blank line, which
    // isAttributionLine() rejects (empty string) — so the boundary falls back
    // to the quote line itself and the attribution sentence above the blank
    // line is left in `own`, exposed to the rewrite. The quoted text (`>` line)
    // is still protected either way — only the attribution can be reworded or
    // dropped. Documented v1 limitation (module docblock, "single line above
    // the quote"), not something this fix wave changes.
    const body = 'My answer.\n\nOn Mon, alice wrote:\n\n> question?'
    const split = splitComposeBody(body)
    expect(split.own).toBe('My answer.\n\nOn Mon, alice wrote:')
    expect(split.tail).toBe('\n\n> question?')
    expect(split.lead + split.own + split.tail).toBe(body)
  })

  it('LIMITATION: a wrapped (multi-line) attribution only has its LAST line pulled into the tail — earlier lines stay in own', () => {
    // Same root cause as the blank-line case above: the detector inspects only
    // the one line immediately above the quote. When an attribution line-wraps
    // across two source lines, the first line is neither blank, quote-prefixed,
    // nor colon-terminated, so it reads as ordinary own text and only the final
    // ("...wrote:") line is recognized and pulled into the tail.
    const body = 'My answer.\n\nOn Mon,\nalice wrote:\n> question?'
    const split = splitComposeBody(body)
    expect(split.own).toBe('My answer.\n\nOn Mon,')
    expect(split.tail).toBe('\nalice wrote:\n> question?')
    expect(split.lead + split.own + split.tail).toBe(body)
  })

  it('detects the attribution in every shipped locale (structural colon test, not a template match)', () => {
    const attributions = [
      'On Mon, alice@example.com wrote:',      // en
      'В понедельник alice@example.com писал(а):', // ru
      'Le lundi, alice@example.com a écrit :',  // fr — colon preceded by a space
      'Am Montag schrieb alice@example.com:',   // de
      'El lunes, alice@example.com escribió:',  // es
      'Il lunedì, alice@example.com ha scritto:', // it
    ]
    for (const attribution of attributions) {
      const split = splitComposeBody(replyBody('My answer.', attribution, 'question?'))
      expect(split.own).toBe('My answer.')
      expect(split.tail).toContain(attribution)
    }
  })

  it('keeps a non-attribution line above the quote in the own part', () => {
    // No trailing colon → not an attribution, so it is the user's own last line.
    const split = splitComposeBody('My answer, see below\n> question?')
    expect(split.own).toBe('My answer, see below')
    expect(split.tail).toBe('\n> question?')
  })

  it('treats nested quote levels as tail', () => {
    const body = 'Agreed.\n\nOn Mon, bob wrote:\n>> alice asked this\n> and bob replied that'
    const split = splitComposeBody(body)
    expect(split.own).toBe('Agreed.')
    expect(split.tail).toContain('>> alice asked this')
    expect(split.tail).toContain('> and bob replied that')
  })

  it('treats an indented quote line as tail', () => {
    const split = splitComposeBody('Answer.\n  > indented quote')
    expect(split.own).toBe('Answer.')
    expect(split.tail).toBe('\n  > indented quote')
  })

  it('keeps the forwarded header block and forwarded body out of the own part', () => {
    const body = [
      'FYI — please handle this.',
      '',
      '---------- Forwarded message ----------',
      'From: alice@example.com',
      'Date: Mon, 3 Mar 2026 10:00',
      'Subject: Invoice',
      'To: bob@example.com',
      '',
      'The invoice is attached.',
    ].join('\n')
    const split = splitComposeBody(body)
    expect(split.own).toBe('FYI — please handle this.')
    expect(split.tail).toContain('---------- Forwarded message ----------')
    expect(split.tail).toContain('From: alice@example.com')
    expect(split.tail).toContain('The invoice is attached.')
  })

  it('detects a localized forward banner (structural dashes, not the words)', () => {
    const split = splitComposeBody('Пересылаю.\n\n---------- Пересланное сообщение ----------\nОт: alice@example.com')
    expect(split.own).toBe('Пересылаю.')
    expect(split.tail).toContain('Пересланное сообщение')
  })

  it('detects the Outlook-style forward banner', () => {
    const split = splitComposeBody('See below.\n\n-----Original Message-----\nFrom: alice@example.com')
    expect(split.own).toBe('See below.')
    expect(split.tail).toContain('-----Original Message-----')
  })

  it('does NOT treat a bare dashed rule inside the user\'s own text as a boundary', () => {
    const body = 'Point one.\n--------\nPoint two.'
    expect(splitComposeBody(body)).toEqual({ lead: '', own: body, tail: '' })
  })

  it('keeps the signature out of the own part in MailCopilot form (`--`, no trailing space)', () => {
    // src/windows/Compose.tsx writes `\n\n--\n${signature}` — no RFC trailing space.
    const split = splitComposeBody('Hello Bob\n\n--\nSergey\nMailCopilot')
    expect(split.own).toBe('Hello Bob')
    expect(split.tail).toBe('\n\n--\nSergey\nMailCopilot')
  })

  it('keeps the signature out of the own part in RFC 3676 form (`-- ` with trailing space)', () => {
    const split = splitComposeBody('Hello Bob\n\n-- \nSergey\nMailCopilot')
    expect(split.own).toBe('Hello Bob')
    expect(split.tail).toBe('\n\n-- \nSergey\nMailCopilot')
  })

  it('takes the earliest boundary when a signature sits above the quoted message', () => {
    const body = 'Hello Bob\n\n--\nSergey\n\nOn Mon, alice wrote:\n> question?'
    const split = splitComposeBody(body)
    expect(split.own).toBe('Hello Bob')
    expect(split.tail).toContain('--\nSergey')
    expect(split.tail).toContain('> question?')
  })

  it('takes the earliest boundary when the quote sits above the signature', () => {
    const body = 'Hello Bob\n\nOn Mon, alice wrote:\n> question?\n\n--\nSergey'
    const split = splitComposeBody(body)
    expect(split.own).toBe('Hello Bob')
    expect(split.tail).toContain('> question?')
    expect(split.tail).toContain('--\nSergey')
  })

  it('reports an empty own part for an untouched reply draft (nothing typed yet)', () => {
    const split = splitComposeBody(replyBody('', 'On Mon, alice wrote:', 'question?'))
    expect(split.own).toBe('')
    expect(split.tail).toContain('> question?')
  })

  it('reports an empty own part for a body that is only a signature', () => {
    const split = splitComposeBody('\n\n--\nSergey')
    expect(split.own).toBe('')
    expect(split.tail).toBe('\n\n--\nSergey')
  })

  it('v1 limitation: a reply typed UNDER the quote is tail, not own text', () => {
    // Deliberate: bottom posting is not segmented in v1. Failing towards "own
    // is empty" makes the caller refuse; the alternative (boundary at the LAST
    // marker) would hand the correspondent's quoted words to the model.
    const body = '\n\nOn Mon, alice wrote:\n> question?\n\nMy answer typed below the quote.'
    const split = splitComposeBody(body)
    expect(split.own).toBe('')
    expect(split.tail).toContain('My answer typed below the quote.')
  })

  it('handles an empty and a whitespace-only body without splitting', () => {
    expect(splitComposeBody('')).toEqual({ lead: '', own: '', tail: '' })
    expect(splitComposeBody('   \n\n ')).toEqual({ lead: '', own: '   \n\n ', tail: '' })
  })

  it('moves leading blank lines into lead so they are not sent to the model', () => {
    const split = splitComposeBody('\n\nHello Bob\n\n--\nSergey')
    expect(split.lead).toBe('\n\n')
    expect(split.own).toBe('Hello Bob')
    expect(split.tail).toBe('\n\n--\nSergey')
  })

  it('sweeps a user line ending in ":" directly above a quote into the tail, even when it is not real attribution (safe false positive — text is scoped out, never lost)', () => {
    // "Details below:" is the USER's own sentence, not a correspondent's
    // attribution — but isAttributionLine() cannot tell the difference from a
    // trailing colon alone. The documented direction is safe: the line is
    // excluded from the rewrite (narrower `own`), never destroyed — it still
    // round-trips through `tail`.
    const split = splitComposeBody('Details below:\n> quoted stuff')
    expect(split.own).toBe('')
    expect(split.tail).toBe('Details below:\n> quoted stuff')
    expect(split.lead + split.own + split.tail).toBe('Details below:\n> quoted stuff')
  })

  it('does not crash when the draft starts with a quote line and there is no line above it', () => {
    const split = splitComposeBody('> quoted only, nothing above')
    expect(split.own).toBe('')
    expect(split.tail).toBe('> quoted only, nothing above')
  })

  it('does NOT detect an Outlook-style underscore separator as a boundary (documented gap — no boundary, own = whole body, per §2.78 slow-follow list)', () => {
    const body = 'See below.\n\n____________________________\nFrom: alice@example.com\nSubject: FW: Report'
    expect(splitComposeBody(body)).toEqual({ lead: '', own: body, tail: '' })
  })

  it('does NOT detect an Apple Mail-style forward without a dashed banner (documented gap — no boundary, own = whole body, per §2.78 slow-follow list)', () => {
    // No "> " prefix, no dashes — only the localized template words, which
    // this detector deliberately does not key off (module docblock).
    const body = 'FYI.\n\nBegin forwarded message:\n\nFrom: alice@example.com\nSubject: Report\n\nThe report is attached.'
    expect(splitComposeBody(body)).toEqual({ lead: '', own: body, tail: '' })
  })
})

/**
 * CRLF drafts. A draft resumed from an IMAP server arrives with wire line
 * endings, and `splitComposeBody` deliberately does NOT normalize them (that
 * would break the byte-exact round trip that makes the tail untouchable).
 * Every classifier therefore has to survive a trailing `\r` on each line —
 * `SIGNATURE_SEPARATOR_RE` did not, and the signature silently became part of
 * the rewritable own part.
 */
describe('splitComposeBody with CRLF line endings', () => {
  it('keeps the signature out of the own part when the separator line is `--\\r`', () => {
    // Regression: `/^--[ \t]*$/` did not match `"--\r"`, so `--`, the signature
    // and everything under it were classified as the user's own text and could
    // be reworded or dropped by a rewrite.
    const body = 'Hello Bob\r\n\r\n--\r\nSergey\r\nMailCopilot'
    const split = splitComposeBody(body)
    // The trailing `\r` stays on `own` — byte exactness beats prettiness here.
    expect(split.own).toBe('Hello Bob\r')
    expect(split.tail).toBe('\n\r\n--\r\nSergey\r\nMailCopilot')
    expect(split.tail).toContain('Sergey')
  })

  it('keeps the RFC 3676 separator (`-- \\r`) out of the own part too', () => {
    const split = splitComposeBody('Hello Bob\r\n\r\n-- \r\nSergey')
    expect(split.own).toBe('Hello Bob\r')
    expect(split.tail).toBe('\n\r\n-- \r\nSergey')
  })

  it('keeps the quoted original and its attribution out of the own part', () => {
    const body = 'Sounds good.\r\n\r\nOn Mon, alice@example.com wrote:\r\n> Can you ship it?'
    const split = splitComposeBody(body)
    expect(split.own).toBe('Sounds good.\r')
    expect(split.tail).toBe('\n\r\nOn Mon, alice@example.com wrote:\r\n> Can you ship it?')
  })

  it('keeps the forwarded banner out of the own part', () => {
    const body = 'FYI.\r\n\r\n---------- Forwarded message ----------\r\nFrom: alice@example.com'
    const split = splitComposeBody(body)
    expect(split.own).toBe('FYI.\r')
    expect(split.tail).toContain('---------- Forwarded message ----------')
  })

  it('round-trips byte for byte, every `\\r` included', () => {
    const bodies = [
      'Hello Bob\r\n\r\n--\r\nSergey\r\nMailCopilot',
      'Hello Bob\r\n\r\n-- \r\nSergey',
      'Sounds good.\r\n\r\nOn Mon, alice wrote:\r\n> Can you ship it?',
      'FYI.\r\n\r\n---------- Forwarded message ----------\r\nFrom: alice@example.com',
      '\r\n\r\nOn Mon, alice wrote:\r\n> question?',
      'plain CRLF draft\r\nwith two lines\r\n',
      // Mixed endings: a draft edited locally under a body pulled from the wire.
      'Typed locally\n\r\nOn Mon, alice wrote:\r\n> question?',
    ]
    for (const body of bodies) {
      const split = splitComposeBody(body)
      expect(split.lead + split.own + split.tail).toBe(body)
      expect(joinComposeBody(split, split.own)).toBe(body)
    }
  })

  it('carries the CRLF tail through a rewrite untouched', () => {
    const split = splitComposeBody('hey bob got the thing\r\n\r\n--\r\nSergey\r\nMailCopilot')
    // The blank separator line and the signature keep their wire bytes; only
    // the own part is substituted.
    expect(joinComposeBody(split, 'Hi Bob, I received it.'))
      .toBe('Hi Bob, I received it.\n\r\n--\r\nSergey\r\nMailCopilot')
  })
})

/**
 * Quoting styles this detector does NOT recognize (module docblock, "Known v1
 * limitation — quoting styles this detector does NOT recognize").
 *
 * These tests exist to PIN the safe direction, not to describe a bug queue. On
 * such a draft no boundary is found, so the whole body is `own` — exactly how
 * these drafts behaved before §2.78 shipped, i.e. no regression. What must keep
 * holding is the round trip: the split itself never loses a byte, and the user
 * still reviews every rewrite before it is applied.
 *
 * Do NOT "fix" these by adding marker regexes — see the module docblock: the
 * durable answer is structured segmentation carried from the composer, and a
 * growing stack of per-client patterns costs everyone false positives that
 * silently narrow the rewritable part.
 */
describe('splitComposeBody: unrecognized quoting styles fall back to "all own text"', () => {
  function expectNoBoundary(body: string): void {
    const split = splitComposeBody(body)
    expect(split).toEqual({ lead: '', own: body, tail: '' })
    expect(split.lead + split.own + split.tail).toBe(body)
    expect(joinComposeBody(split, split.own)).toBe(body)
  }

  it('vertical-bar quoting (`| their text`) is not detected', () => {
    expectNoBoundary('My answer.\n\n| Can you ship it?\n| Asking for the invoice too.')
  })

  it('indentation-only quoting is not detected', () => {
    // Leading spaces with no `>` at all: indistinguishable from an indented
    // paragraph the user typed themselves.
    expectNoBoundary('My answer.\n\n    Can you ship it?\n    Asking for the invoice too.')
  })

  it('a tab-indented quote is not detected either', () => {
    expectNoBoundary('My answer.\n\n\tCan you ship it?')
  })

  it('a bare Outlook header block (no dashed banner, no underscore rule) is not detected', () => {
    expectNoBoundary([
      'See below.',
      '',
      'From: alice@example.com',
      'Sent: Monday, 3 March 2026 10:00',
      'To: bob@example.com',
      'Subject: Invoice',
      '',
      'The invoice is attached.',
    ].join('\n'))
  })

  it('a plain-text rendering of an HTML quote (prefixes stripped) is not detected', () => {
    // The HTML→text conversion drops the `>` prefixes, so the correspondent's
    // paragraphs arrive bare. The attribution line above them is only consulted
    // when a quote line follows it, so it does not create a boundary on its own.
    expectNoBoundary('Agreed.\n\nOn Monday, Alice wrote:\n\nCan you ship it?\n\nAsking for the invoice too.')
  })

  it('holds the same way on a CRLF body', () => {
    expectNoBoundary('My answer.\r\n\r\n| Can you ship it?\r\n| And the invoice?')
  })
})

describe('splitComposeBody / joinComposeBody round trip', () => {
  const bodies = [
    '',
    'plain draft',
    '   \n\n ',
    'Hello Bob\n\n--\nSergey',
    'Hello Bob\n\n-- \nSergey',
    '\n\nHello Bob\n\n--\nSergey',
    replyBody('Sounds good.', 'On Mon, alice wrote:', 'Can you ship it?'),
    replyBody('', 'On Mon, alice wrote:', 'Can you ship it?'),
    'FYI\n\n---------- Forwarded message ----------\nFrom: alice@example.com\n\nBody.',
    'Answer.\n> q1\n>> q2',
    'Hello Bob\n\n--\nSergey\n\nOn Mon, alice wrote:\n> question?',
    'Trailing newline draft\n',
    '\n',
  ]

  it('lead + own + tail reproduces the original body byte for byte', () => {
    for (const body of bodies) {
      const split = splitComposeBody(body)
      expect(split.lead + split.own + split.tail).toBe(body)
    }
  })

  it('joinComposeBody with the unchanged own part is the identity', () => {
    for (const body of bodies) {
      const split = splitComposeBody(body)
      expect(joinComposeBody(split, split.own)).toBe(body)
    }
  })

  it('joinComposeBody splices a rewrite in without touching the tail', () => {
    const body = replyBody('sounds good ship today', 'On Mon, alice wrote:', 'Can you ship it?')
    const split = splitComposeBody(body)
    const next = joinComposeBody(split, 'Sounds good — we will ship today.')
    expect(next).toBe('Sounds good — we will ship today.\n\nOn Mon, alice wrote:\n> Can you ship it?')
    expect(next).toContain('> Can you ship it?')
  })

  it('joinComposeBody keeps the signature intact across a rewrite', () => {
    const split = splitComposeBody('hey bob got the thing\n\n--\nSergey\nMailCopilot')
    const next = joinComposeBody(split, 'Hi Bob, I received it.')
    expect(next).toBe('Hi Bob, I received it.\n\n--\nSergey\nMailCopilot')
  })
})

/**
 * Property-style round-trip: the fixed `bodies` list above pins specific
 * shapes, but a bug that only shows up on ONE particular own-text /
 * marker / line-ending combination (e.g. a multi-line own part combined with
 * a CRLF signature) can hide behind that finite list. This generates the
 * cartesian product of a few own-text shapes, tail markers, and line-ending
 * styles and asserts the two invariants the module docblock promises for
 * EVERY combination: `lead + own + tail === body` byte for byte, and
 * `joinComposeBody(split, split.own)` reproduces `body` exactly (splicing a
 * rewrite in with the unchanged own part is the identity).
 */
describe('splitComposeBody / joinComposeBody round trip — property-style combinations', () => {
  const OWN_SHAPES: readonly string[] = [
    'Hi',
    'Hi Bob,\n\nThanks for the update!',
    '',
  ]
  const TAIL_MARKERS: ReadonlyArray<[string, (nl: string) => string]> = [
    ['none', () => ''],
    ['signature (MailCopilot form, no trailing space)', nl => `--${nl}Sergey`],
    ['signature (RFC 3676, trailing space)', nl => `-- ${nl}Sergey`],
    ['quoted reply', nl => `On Mon, alice wrote:${nl}> Can you ship it?`],
    ['forward banner', nl => `---------- Forwarded message ----------${nl}From: alice@example.com`],
  ]
  const LINE_ENDINGS: ReadonlyArray<[string, string]> = [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ]

  function buildBody(ownShape: string, buildTail: (nl: string) => string, nl: string): string {
    const own = ownShape.split('\n').join(nl)
    const tail = buildTail(nl)
    return tail.length > 0 ? `${own}${nl}${nl}${tail}` : own
  }

  for (const ownShape of OWN_SHAPES) {
    for (const [markerLabel, buildTail] of TAIL_MARKERS) {
      for (const [nlLabel, nl] of LINE_ENDINGS) {
        const body = buildBody(ownShape, buildTail, nl)

        it(`own=${JSON.stringify(ownShape)} marker=${markerLabel} eol=${nlLabel}: round-trips byte for byte and join is identity`, () => {
          const split = splitComposeBody(body)
          expect(split.lead + split.own + split.tail).toBe(body)
          expect(joinComposeBody(split, split.own)).toBe(body)
        })
      }
    }
  }
})
