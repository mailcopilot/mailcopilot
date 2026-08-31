import { describe, expect, it, vi } from 'vitest'

// `./message` transitively imports `./imap` which loads better-sqlite3 via
// `../db`. The native binding is built against the Electron ABI, not the
// system Node ABI vitest runs under, so any test that imports `./message`
// must mock the DB surface upfront — same pattern as `./imap.test.ts`.
// `extractIcsFromRawEml` itself never touches the DB; the mock is purely a
// shield for the import chain.
vi.mock('../db', () => ({
  upsertMessages: vi.fn(),
  setUnread: vi.fn(),
  deleteMessages: vi.fn(),
  setFlagged: vi.fn(),
  upsertContactsIncoming: vi.fn(),
  removeStaleMessages: vi.fn(),
  getAccountMessageCount: vi.fn().mockReturnValue(0),
  getFolderUids: vi.fn().mockReturnValue([]),
  getFolderFlags: vi.fn().mockReturnValue(new Map()),
  removeStaleMessagesByUids: vi.fn(),
  getMessageByUid: vi.fn().mockReturnValue(undefined),
}))

import {
  capDecodedBody,
  EML_BODY_FULL_CAP_BYTES,
  EML_BODY_SOFT_CAP_BYTES,
  exceedsHardParseCap,
  extractEmlAttachment,
  MAX_EML_PARSE_BYTES,
  parseEmlBuffer,
  parseEmlBufferInline,
  parseEmlHeaderFacts,
} from './eml'
import {
  __emlWorkerStateForTest,
  __resetEmlWorkerForTest,
  EML_WORKER_MIN_BYTES,
  MAX_QUEUED_BYTES,
} from './emlWorkerClient'
import { extractIcsFromRawEml } from './message'
import { setNetEventReporter } from './telemetry'
import type { MessageParseCap } from './types'

describe('packages/net/eml', () => {
  it('parseEmlBuffer returns attachments with part=eml:N and extractEmlAttachment extracts content', async () => {
    const body = 'Hello'
    const fileName = 'hello.txt'
    const fileContent = 'hi'
    const b64 = Buffer.from(fileContent, 'utf8').toString('base64')

    const eml = [
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Test',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="BOUNDARY"',
      '',
      '--BOUNDARY',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      body,
      '--BOUNDARY',
      `Content-Type: application/octet-stream; name="${fileName}"`,
      `Content-Disposition: attachment; filename="${fileName}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      '--BOUNDARY--',
      '',
    ].join('\r\n')

    const raw = Buffer.from(eml, 'utf8')
    const details = await parseEmlBuffer(123, raw)
    expect(details.uid).toBe(123)
    expect(details.text?.trim()).toBe(body)

    expect(details.attachments?.length).toBe(1)
    expect(details.attachments?.[0]?.filename).toBe(fileName)
    expect(details.attachments?.[0]?.part).toBe('eml:1')

    const att = await extractEmlAttachment(raw, 'eml:1')
    expect(att?.filename).toBe(fileName)
    expect(att?.content.toString('utf8')).toBe(fileContent)

    expect(await extractEmlAttachment(raw, 'eml:2')).toBe(null)
    expect(await extractEmlAttachment(raw, '2')).toBe(null)
  })
})

// §2.22 Wave A — verify the raw-EML ics extraction helper used on the
// on-disk-cache path. The helper is layer-pure (mailparser walk only) — it
// must NOT parse the ics or import ical.js. We feed real RFC822 fixtures
// covering each MIME-content-type variant the wild has shown:
//   - text/calendar inline (canonical Outlook / Google Calendar)
//   - application/ics as an attachment (older Outlook)
//   - application/octet-stream + .ics filename (broken senders)
//   - no calendar part at all (must return undefined, never throw)
describe('packages/net/message — extractIcsFromRawEml', () => {
  const ICS_BODY = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Test//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:event-123@example.test',
    'DTSTAMP:20260501T100000Z',
    'DTSTART:20260601T140000Z',
    'SUMMARY:Demo',
    'ORGANIZER:mailto:org@example.test',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('extracts a text/calendar part as a UTF-8 string', async () => {
    const eml = [
      'From: Org <org@example.test>',
      'To: Bob <bob@example.test>',
      'Subject: Demo invite',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="OUTER"',
      '',
      '--OUTER',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'You are invited.',
      '--OUTER',
      'Content-Type: text/calendar; method=REQUEST; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      ICS_BODY,
      '--OUTER--',
      '',
    ].join('\r\n')
    const raw = Buffer.from(eml, 'utf8')
    const ics = await extractIcsFromRawEml(raw)
    expect(ics).toBeDefined()
    expect(ics).toContain('UID:event-123@example.test')
    expect(ics).toContain('METHOD:REQUEST')
  })

  it('extracts application/ics attachments', async () => {
    const b64 = Buffer.from(ICS_BODY, 'utf8').toString('base64')
    const eml = [
      'From: Org <org@example.test>',
      'To: Bob <bob@example.test>',
      'Subject: Outlook-style invite',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B1"',
      '',
      '--B1',
      'Content-Type: text/plain',
      '',
      'See attached.',
      '--B1',
      'Content-Type: application/ics; name="invite.ics"',
      'Content-Disposition: attachment; filename="invite.ics"',
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      '--B1--',
      '',
    ].join('\r\n')
    const raw = Buffer.from(eml, 'utf8')
    const ics = await extractIcsFromRawEml(raw)
    expect(ics).toBeDefined()
    expect(ics).toContain('UID:event-123@example.test')
  })

  it('extracts application/octet-stream parts when filename ends in .ics', async () => {
    const b64 = Buffer.from(ICS_BODY, 'utf8').toString('base64')
    const eml = [
      'From: Org <org@example.test>',
      'To: Bob <bob@example.test>',
      'Subject: Quirky sender',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B2"',
      '',
      '--B2',
      'Content-Type: text/plain',
      '',
      'Body',
      '--B2',
      'Content-Type: application/octet-stream; name="meeting.ics"',
      'Content-Disposition: attachment; filename="meeting.ics"',
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      '--B2--',
      '',
    ].join('\r\n')
    const raw = Buffer.from(eml, 'utf8')
    const ics = await extractIcsFromRawEml(raw)
    expect(ics).toBeDefined()
    expect(ics).toContain('UID:event-123@example.test')
  })

  it('returns undefined when there is no calendar part', async () => {
    const eml = [
      'From: Alice <alice@example.test>',
      'To: Bob <bob@example.test>',
      'Subject: Plain text',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'Just a plain message.',
      '',
    ].join('\r\n')
    const raw = Buffer.from(eml, 'utf8')
    expect(await extractIcsFromRawEml(raw)).toBeUndefined()
  })

  it('returns undefined (does not throw) on malformed input', async () => {
    const raw = Buffer.from('this is not an email', 'utf8')
    // Must not throw — main.ts wraps this on the cache path and depends on
    // graceful undefined for malformed local cache rows.
    await expect(extractIcsFromRawEml(raw)).resolves.toBeUndefined()
  })

  // §2.22 fix iter4 — codex-security-review MEDIUM: cap returned ics at
  // 1 MiB to mirror the IMAP path. Without this guard, an oversized ics in
  // an offline-cached EML would force unbounded `simpleParser` + `toString`
  // + downstream `ICAL.parse` work.
  it('returns undefined when the ics part exceeds the 1 MiB byte cap', async () => {
    const headerLine = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//bloat//\r\n'
    const footer = '\r\nBEGIN:VEVENT\r\nUID:big@example.test\r\nDTSTAMP:20260501T100000Z\r\nDTSTART:20260601T140000Z\r\nSUMMARY:big\r\nORGANIZER:mailto:org@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    // Build ~1.5 MiB of payload content plus the calendar wrappers, well
    // above the 1 MiB cap regardless of how mailparser counts bytes.
    const filler = 'X-PADDING:' + 'A'.repeat(1500 * 1024) + '\r\n'
    const oversizedIcs = headerLine + filler + footer

    const eml = [
      'From: Org <org@example.test>',
      'To: Bob <bob@example.test>',
      'Subject: Oversized invite',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="BIG"',
      '',
      '--BIG',
      'Content-Type: text/plain',
      '',
      'See ics.',
      '--BIG',
      'Content-Type: text/calendar; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      oversizedIcs,
      '--BIG--',
      '',
    ].join('\r\n')
    const raw = Buffer.from(eml, 'utf8')
    const ics = await extractIcsFromRawEml(raw)
    // Must skip — never return a payload above the cap, never throw.
    expect(ics).toBeUndefined()
  })
})

// §2.57 — mailparser 3.9.12 -> 3.9.14 pulled linkify-it 5.0.1 -> 5.0.2.
// Every plain-text message parsed here runs through mailparser's
// `textToHtml`, which unconditionally calls `linkify.pretest`/`linkify.match`
// on the body to build `textAsHtml` (mail-parser.js — runs whenever the
// message has text content, regardless of whether the caller reads
// `textAsHtml`). Pre-5.0.2, linkify-it's `mailto:` validator regex used an
// unbounded `*` quantifier for the local-part
// (`[...][...]*@...`), so a body containing many repeats of the literal
// string "mailto:" (":" is itself a legal local-part character) made the
// validator greedily consume to the end of the remaining text and then
// backtrack one char at a time looking for an "@" that never appears —
// O(n) work per occurrence, O(n^2) for the whole body. 5.0.2 caps the
// local-part at 64 chars (RFC 5321), bounding each validator call to O(1)
// regardless of body length. This is a real, network-reachable DoS surface:
// the payload is exactly an attacker-controlled email body, not a
// synthetic microbenchmark.
describe('packages/net/eml — linkify-it mailto: DoS regression (mailparser textToHtml)', () => {
  it('parseEmlBuffer stays fast on a body flooded with "mailto:" tokens and no valid address', async () => {
    // 20k repeats of "mailto:" with no terminating "@": before the fix this
    // pattern forced linkify-it's mailto validator into repeated
    // end-of-string backtracking; after the fix each attempt is bounded to
    // ~64 chars. Empirically this now parses in well under 100ms; the 2s
    // bound below leaves generous headroom for CI while still failing hard
    // if quadratic behavior is ever reintroduced (e.g. via a future
    // linkify-it/mailparser downgrade).
    const body = 'mailto:'.repeat(20_000)
    const eml = [
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Adversarial plain-text body',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      body,
      '',
    ].join('\r\n')

    const raw = Buffer.from(eml, 'utf8')
    const start = Date.now()
    const details = await parseEmlBuffer(1, raw)
    const elapsedMs = Date.now() - start

    expect(details.text).toBeDefined()
    expect(elapsedMs).toBeLessThan(2000)
  })
})

// §2.124 — the two shapes a large message can take. The cost of parsing was
// measured to be driven by the MIME splitter's per-line event-loop yield, not
// by attachment content, so both shapes must come back with identical
// metadata whether the parse ran inline or in the worker (the worker calls
// exactly `parseEmlBufferInline`). Under vitest no built worker exists, so
// `parseEmlBuffer` resolves to the inline path and these specs compare the
// dispatching wrapper against the implementation it dispatches to.
describe('packages/net/eml — large-message shapes (§2.124)', () => {
  const ATTACHMENT_BYTES = 200 * 1024

  function oneBigAttachment(): Buffer {
    const payload = Buffer.alloc(ATTACHMENT_BYTES, 0x41).toString('base64').replace(/(.{76})/g, '$1\r\n')
    return Buffer.from([
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: One big attachment',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'See attached.',
      '--B',
      'Content-Type: application/octet-stream; name="big.bin"',
      'Content-Disposition: attachment; filename="big.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      payload,
      '--B--',
      '',
    ].join('\r\n'), 'utf8')
  }

  function manySmallParts(count: number): Buffer {
    const payload = Buffer.alloc(512, 0x42).toString('base64').replace(/(.{76})/g, '$1\r\n')
    const parts: string[] = [
      '--B\r\nContent-Type: text/html; charset="utf-8"\r\n\r\n<p>Gallery</p>\r\n',
    ]
    for (let i = 0; i < count; i++) {
      parts.push(
        '--B\r\n' +
        'Content-Type: image/png\r\n' +
        'Content-Transfer-Encoding: base64\r\n' +
        `Content-ID: <img${i}@example.com>\r\n` +
        `Content-Disposition: inline; filename="img${i}.png"\r\n\r\n${payload}\r\n`,
      )
    }
    parts.push('--B--\r\n')
    return Buffer.from([
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Many parts',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="B"',
      '',
      '',
    ].join('\r\n') + parts.join(''), 'utf8')
  }

  it('reads a message that is large because of a single attachment', async () => {
    const raw = oneBigAttachment()
    expect(raw.length).toBeGreaterThan(EML_WORKER_MIN_BYTES)

    const details = await parseEmlBuffer(501, raw)

    expect(details.uid).toBe(501)
    expect(details.envelope?.subject).toBe('One big attachment')
    expect(details.text?.trim()).toBe('See attached.')
    expect(details.attachments?.length).toBe(1)
    expect(details.attachments?.[0]?.filename).toBe('big.bin')
    expect(details.attachments?.[0]?.contentType).toBe('application/octet-stream')
    // Pre-existing gap, unchanged by §2.124 and asserted so a future change is
    // deliberate: the streaming parse reports attachment metadata before the
    // content stream has been drained, so `size` is never populated on the EML
    // path — at any attachment size.
    expect(details.attachments?.[0]?.size).toBeUndefined()
    expect(details).toEqual(await parseEmlBufferInline(501, raw))
  })

  it('reads a message that is large because of many small parts', async () => {
    const raw = manySmallParts(300)
    expect(raw.length).toBeGreaterThan(EML_WORKER_MIN_BYTES)

    const details = await parseEmlBuffer(502, raw)

    expect(details.uid).toBe(502)
    expect(details.envelope?.subject).toBe('Many parts')
    expect(details.attachments?.length).toBe(300)
    expect(details.attachments?.[0]?.cid).toBe('img0@example.com')
    expect(details.attachments?.[299]?.filename).toBe('img299.png')
    expect(details).toEqual(await parseEmlBufferInline(502, raw))
  })
})

// ---------------------------------------------------------------------------
// §2.145 — two-tier parse caps.
//
// The two caps are tested at different levels on purpose. The HARD cap is a
// size decision, so its boundary is pinned on the pure predicate (allocating
// 100 MiB per boundary case would buy nothing but wall time) and its WIRING is
// then proven once per doorway with a really oversized buffer. The SOFT cap is
// a content decision, so it is exercised end to end on real messages, through
// the same entry point production uses.
// ---------------------------------------------------------------------------
describe('packages/net/eml — hard cap on raw input (§2.145)', () => {
  /** A syntactically real message whose declared size is past the cap. The body
   *  is a single zero-filled run: nothing here should ever be decoded, and a
   *  test that quietly started decoding it would be visible as a timeout. */
  function oversizedMessage(): Buffer {
    const headers = Buffer.from([
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Enormous',
      'Date: Tue, 12 Aug 2026 10:00:00 +0000',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      '',
    ].join('\r\n'), 'utf8')
    return Buffer.concat([headers, Buffer.alloc(MAX_EML_PARSE_BYTES + 1 - headers.length, 0x41)])
  }

  it('is a maximum, not a threshold: the boundary byte is still parsed', () => {
    expect(exceedsHardParseCap(0)).toBe(false)
    expect(exceedsHardParseCap(MAX_EML_PARSE_BYTES - 1)).toBe(false)
    expect(exceedsHardParseCap(MAX_EML_PARSE_BYTES)).toBe(false)
    expect(exceedsHardParseCap(MAX_EML_PARSE_BYTES + 1)).toBe(true)
  })

  // The ordering the §2.145 brief asks for, pinned rather than described: with
  // the queue bound ABOVE the hard cap, "too big" would reach the user as a
  // load-dependent queue refusal on some opens and a placeholder on others.
  it('sits above the worker admission bound, so one symptom keeps one cause', () => {
    expect(MAX_EML_PARSE_BYTES).toBeGreaterThanOrEqual(MAX_QUEUED_BYTES)
  })

  it('opens an oversized message as header facts, with nothing decoded', async () => {
    const raw = oversizedMessage()
    const details = await parseEmlBuffer(900, raw)

    expect(details.uid).toBe(900)
    expect(details.parseCap).toEqual({
      kind: 'hard',
      rawBytes: raw.length,
      limitBytes: MAX_EML_PARSE_BYTES,
    })
    // The facts the placeholder stands on.
    expect(details.envelope?.subject).toBe('Enormous')
    expect(details.envelope?.from?.[0]?.address).toBe('alice@example.com')
    expect(details.envelope?.date).toBe('2026-08-12T10:00:00.000Z')
    // And nothing else. `attachments` absent rather than empty: we did not
    // look, and "no attachments" would be a claim we cannot make.
    expect(details.html).toBeUndefined()
    expect(details.text).toBeUndefined()
    expect(details.attachments).toBeUndefined()
  })

  // Mutation killed: putting the hard cap after `planEmlParseDispatch`. A
  // dispatch that never happened must not be counted as one, exactly as a queue
  // refusal is not — otherwise `eml.parse_dispatch` reports parses that did not
  // occur on any thread.
  it('counts no parse dispatch, because no parse took place anywhere', async () => {
    __resetEmlWorkerForTest()
    await parseEmlBuffer(901, oversizedMessage())
    const counts = __emlWorkerStateForTest().dispatch
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0)
  })

  // Mutation killed: capping only `parseEmlBuffer`. The EML cache path hands
  // the SAME buffer to the calendar scan immediately afterwards, and that scan
  // runs a FULL simpleParser which buffers every attachment — strictly more
  // expensive than the parse the cap just declined.
  it('refuses the calendar scan over the same oversized bytes', async () => {
    expect(await extractIcsFromRawEml(oversizedMessage())).toBeUndefined()
  })

  // Mutation killed: capping the parse but leaving the one entry point that
  // materialises every attachment of a message in memory at once reachable.
  it('refuses to extract an attachment out of an oversized message', async () => {
    expect(await extractEmlAttachment(oversizedMessage(), 'eml:1')).toBeNull()
  })

  it('still opens when the header block is unterminated garbage', async () => {
    // No empty line anywhere: the placeholder must degrade to "size only"
    // rather than hanging on a stream the parser considers unfinished.
    const raw = Buffer.alloc(MAX_EML_PARSE_BYTES + 1, 0x41)
    const details = await parseEmlBuffer(902, raw)
    expect(details.parseCap?.kind).toBe('hard')
    expect(details.text).toBeUndefined()
  })

  // codex-bg-review Part B, LOW — the raised tier is a SOFT-cap concept only.
  // `parseEmlBuffer`'s hard-cap branch stands before `resolveBodyLimit` is
  // even consulted, so `full: true` on an oversized message must produce the
  // exact same placeholder as an ordinary open, and must not count as a parse
  // dispatch either (the bytes never reach any thread, `full` or not).
  it('cannot be bypassed by full: true — same placeholder, zero dispatches', async () => {
    __resetEmlWorkerForTest()
    const raw = oversizedMessage()
    const details = await parseEmlBuffer(903, raw, { full: true })

    expect(details.parseCap).toEqual({
      kind: 'hard',
      rawBytes: raw.length,
      limitBytes: MAX_EML_PARSE_BYTES,
    })
    expect(details.text).toBeUndefined()
    expect(details.html).toBeUndefined()
    const counts = __emlWorkerStateForTest().dispatch
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0)
  })
})

// codex-bg-review Part B, MEDIUM — the placeholder's header scan is a BOUNDED
// PREFIX (`EML_HEADER_SCAN_BYTES` in eml.ts, not exported: the value is an
// implementation detail of `headerBlockOf`, pinned here by its documented
// value rather than by import, matching the JSDoc above `headerBlockOf`). The
// hard-cap tests above prove the placeholder recovers early headers; these
// prove the OTHER half — that nothing past the window can reach the parser at
// all, and that the cut recognizes both RFC 5322 CRLF and bare-LF blank lines.
describe('packages/net/eml — hard-cap placeholder header scan window (§2.145)', () => {
  // Mirrors the internal (non-exported) `EML_HEADER_SCAN_BYTES` in eml.ts.
  // If that constant changes, this test's window must move with it.
  const HEADER_SCAN_BYTES = 32 * 1024

  it('never lets a header past the scan window reach the parser', async () => {
    const early = [
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Real Subject',
      'Date: Tue, 12 Aug 2026 10:00:00 +0000',
    ].join('\r\n') + '\r\n'
    // A single header line long enough, on its own, to push the blank-line
    // terminator (and everything after it) past the scan window.
    const paddingHeader = `X-Padding: ${'p'.repeat(HEADER_SCAN_BYTES)}\r\n`
    // A duplicate Subject placed AFTER the padding — if the window were not
    // enforced (or were wide enough to reach it), a header container that
    // resolves duplicates by last-value-wins would report THIS subject
    // instead of the real one.
    const raw = Buffer.from(
      early + paddingHeader + 'Subject: SENTINEL-SHOULD-NOT-APPEAR\r\n' + '\r\n' + 'irrelevant body\r\n',
      'utf8',
    )
    expect(raw.length).toBeGreaterThan(HEADER_SCAN_BYTES)
    // The real blank-line terminator must sit past the window — otherwise this
    // test would not be exercising the bound at all, just an ordinary parse.
    expect(raw.indexOf('\r\n\r\n')).toBeGreaterThan(HEADER_SCAN_BYTES)

    const details = await parseEmlHeaderFacts(999, raw)
    expect(details.envelope?.subject).toBe('Real Subject')
    expect(details.envelope?.from?.[0]?.address).toBe('alice@example.com')
  })

  it('recognizes a bare-LF blank line as a header terminator, not only CRLF', async () => {
    // RFC 5322 mandates CRLF, but mail that has passed through a Unix
    // mailstore routinely arrives with bare LF — `headerBlockOf` looks for
    // both, and whichever comes first wins.
    const raw = Buffer.from(
      'From: Alice <alice@example.com>\nSubject: LF only header block\n\nBody is never decoded here.\n',
      'utf8',
    )
    const details = await parseEmlHeaderFacts(998, raw)
    expect(details.envelope?.subject).toBe('LF only header block')
    expect(details.envelope?.from?.[0]?.address).toBe('alice@example.com')
  })
})

describe('packages/net/eml — soft cap on the decoded body (§2.145)', () => {
  /** A message whose plain-text body is `bytes` long. */
  function messageWithTextBody(bytes: number): Buffer {
    return Buffer.from([
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Long',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'x'.repeat(bytes),
      '',
    ].join('\r\n'), 'utf8')
  }

  it('leaves an ordinary message untouched and unmarked', async () => {
    const details = await parseEmlBuffer(910, messageWithTextBody(4096))
    expect(details.text?.trim().length).toBe(4096)
    expect(details.parseCap).toBeUndefined()
  })

  it('cuts a body past the first-tier cap and says the rest can be asked for', async () => {
    const raw = messageWithTextBody(EML_BODY_SOFT_CAP_BYTES + 64 * 1024)
    const details = await parseEmlBuffer(911, raw)

    expect(Buffer.byteLength(details.text ?? '', 'utf8')).toBeLessThanOrEqual(EML_BODY_SOFT_CAP_BYTES)
    expect(details.parseCap).toEqual({
      kind: 'soft',
      rawBytes: raw.length,
      limitBytes: EML_BODY_SOFT_CAP_BYTES,
      canShowFull: true,
    })
    // The message is otherwise whole — this is a clip, not a refusal.
    expect(details.envelope?.subject).toBe('Long')
  })

  it('shows the same message whole once the user asks for it', async () => {
    const bodyBytes = EML_BODY_SOFT_CAP_BYTES + 64 * 1024
    const details = await parseEmlBuffer(912, messageWithTextBody(bodyBytes), { full: true })

    expect(details.text?.trim().length).toBe(bodyBytes)
    expect(details.parseCap).toBeUndefined()
  })

  // The raised tier is raised, not removed: a body past it clips again, and the
  // banner has to be able to say there is nothing further to ask for.
  //
  // This pins the SHAPE of "raised tier still clips" (canShowFull flips to
  // false at the boundary) with a small body at various limits — it does not
  // exercise a body genuinely larger than the raised tier through the real
  // { full: true } entry point. See the next test for that.
  it('offers nothing further when even the raised tier clipped', async () => {
    const details = await parseEmlBufferInline(913, messageWithTextBody(2048), 1024)
    expect(details.parseCap?.canShowFull).toBe(true)

    const atTop = await parseEmlBufferInline(914, messageWithTextBody(2048), EML_BODY_FULL_CAP_BYTES)
    expect(atTop.parseCap).toBeUndefined()
  })

  // codex-bg-review Part B, MEDIUM — the test above never actually reaches the
  // raised-tier clip: its body (2048 bytes) never exceeds EML_BODY_FULL_CAP_BYTES
  // (8 MiB) at any of the limits it tries. This is the real case: a body
  // bigger than even the raised tier, through the real `{ full: true }` entry
  // point `parseEmlBuffer` exposes, with the telemetry tier it must report.
  it('clips again at the raised tier for a body genuinely bigger than it, through the real { full: true } entry point', async () => {
    // Built via the same efficient `'x'.repeat(n)` allocation the rest of this
    // suite already uses at MB scale — one contiguous allocation, no
    // intermediate copies.
    const raw = messageWithTextBody(EML_BODY_FULL_CAP_BYTES + 1)
    const events: Array<{ name: string; tags: Record<string, unknown> }> = []
    setNetEventReporter((name, tags) => { events.push({ name, tags }) })

    let details
    try {
      details = await parseEmlBuffer(926, raw, { full: true })
    } finally {
      setNetEventReporter(null)
    }

    expect(Buffer.byteLength(details.text ?? '', 'utf8')).toBe(EML_BODY_FULL_CAP_BYTES)
    expect(details.parseCap).toEqual({
      kind: 'soft',
      rawBytes: raw.length,
      limitBytes: EML_BODY_FULL_CAP_BYTES,
      // At the raised tier itself, there is nowhere further to ask for.
      canShowFull: false,
    })

    const soft = events.filter(e => e.name === 'eml.parse_cap_soft')
    expect(soft.length).toBe(1)
    expect(soft[0].tags).toEqual({ size_bucket: '1MB+', tier: 'full' })
  })

  // codex-bg-review Part B, LOW — a cut that lands inside one enormous opening
  // tag with no closing '>' before it drops the WHOLE clipped fragment
  // (`capDecodedBody`'s html branch: `lastOpen > lastClose` cuts back to the
  // tag's own start). The result is an html value of `''`, which
  // `parseEmlBufferInline` then folds to `undefined` (`html.value || undefined`)
  // — the same falsy shape as "no html part at all". The cap verdict is still
  // real: `truncated` came from the clip, not from the emptiness, so
  // `parseCap` stays soft. This is what lets the renderer's parse-cap banner
  // still render for a message whose body area would otherwise look bodyless.
  it('can clip an html body to nothing near byte zero, and still marks the result soft-capped', async () => {
    // No visible text anywhere outside the tag itself (the padding lives in an
    // attribute value, not between tags), so mailparser's own html-to-text
    // derivation — which runs on the FULL, uncapped html independently of our
    // cap — also comes back empty. Both representations clip to nothing.
    const html = '<div style="' + 'x'.repeat(4096) + '"></div>'
    const raw = Buffer.from([
      'From: Alice <alice@example.com>',
      'Subject: Empty after clip',
      'Content-Type: text/html; charset="utf-8"',
      '',
      html,
      '',
    ].join('\r\n'), 'utf8')

    const details = await parseEmlBufferInline(927, raw, 5)
    expect(details.html).toBeUndefined()
    expect(details.text).toBeUndefined()
    expect(details.parseCap?.kind).toBe('soft')
  })

  it('keeps attachment metadata on the clipped path', async () => {
    const payload = Buffer.alloc(1024, 0x41).toString('base64').replace(/(.{76})/g, '$1\r\n')
    const raw = Buffer.from([
      'From: Alice <alice@example.com>',
      'Subject: Clipped with attachment',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'y'.repeat(4096),
      '--B',
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      payload,
      '--B--',
      '',
    ].join('\r\n'), 'utf8')

    const details = await parseEmlBufferInline(915, raw, 1024)

    expect(details.parseCap?.kind).toBe('soft')
    expect(details.attachments?.length).toBe(1)
    expect(details.attachments?.[0]?.filename).toBe('report.pdf')
    expect(details.attachments?.[0]?.part).toBe('eml:1')
  })
})

describe('packages/net/eml — capDecodedBody (§2.145)', () => {
  it('returns a body that fits untouched', () => {
    expect(capDecodedBody('hello', 1024, 'text')).toEqual({ value: 'hello', truncated: false })
    expect(capDecodedBody('', 0, 'text')).toEqual({ value: '', truncated: false })
  })

  // Mutation killed: measuring with `String.length`. Ten two-byte characters
  // are twenty bytes, and a cap that counted code units would pass them.
  it('measures and cuts in bytes, not in UTF-16 code units', () => {
    const body = 'д'.repeat(10)
    expect(body.length).toBe(10)
    expect(Buffer.byteLength(body, 'utf8')).toBe(20)

    const capped = capDecodedBody(body, 15, 'text')
    expect(capped.truncated).toBe(true)
    expect(Buffer.byteLength(capped.value, 'utf8')).toBeLessThanOrEqual(15)
    // Cut on a character boundary — never a half-encoded replacement char.
    expect(capped.value).toBe('д'.repeat(7))
  })

  // Mutation killed: cutting HTML at a raw byte offset and leaving `<div cla`
  // for the sanitizer to deal with silently.
  it('drops a tag the cut landed inside, for html only', () => {
    const html = '<p>hello</p><div class="wide"'
    const capped = capDecodedBody(html, 20, 'html')
    expect(capped.truncated).toBe(true)
    expect(capped.value).toBe('<p>hello</p>')

    // Text bodies have no tags, and a `<` in prose is just a character.
    const text = capDecodedBody('a < b and more text here', 12, 'text')
    expect(text.value).toBe('a < b and mo')
  })

  // codex-bg-review Part B, LOW — "a maximum, not a threshold" pinned at the
  // byte-exact boundary for BOTH representations, and for multibyte UTF-8
  // specifically: a body exactly the size of the limit must not be reported
  // as truncated, and one byte over must cut back to a WHOLE character, never
  // a half-encoded one, on both sides of the boundary.
  it('is a maximum, not a threshold, at the exact byte boundary — ASCII and multibyte, text and html', () => {
    const ascii = 'x'.repeat(100)
    expect(capDecodedBody(ascii, 100, 'text')).toEqual({ value: ascii, truncated: false })
    expect(capDecodedBody(ascii, 99, 'text')).toEqual({ value: ascii.slice(0, 99), truncated: true })

    // 'д' is 2 bytes in UTF-8; 50 of them is exactly 100 bytes.
    const multibyte = 'д'.repeat(50)
    expect(capDecodedBody(multibyte, 100, 'text')).toEqual({ value: multibyte, truncated: false })
    // One byte short of a whole character: must walk back a full character
    // (49 chars / 98 bytes), never emit a half-encoded 99th byte.
    const overByOne = capDecodedBody(multibyte, 99, 'text')
    expect(overByOne.truncated).toBe(true)
    expect(overByOne.value).toBe('д'.repeat(49))
    expect(Buffer.byteLength(overByOne.value, 'utf8')).toBe(98)

    // Same boundary, html representation: a limit that lands exactly at the
    // end of a complete tag must not drop it (no '<' after the last '>').
    // '<p>' (3) + 93 'y's + '</p>' (4) = exactly 100 bytes.
    const html = '<p>' + 'y'.repeat(93) + '</p>'
    expect(Buffer.byteLength(html, 'utf8')).toBe(100)
    expect(capDecodedBody(html, 100, 'html')).toEqual({ value: html, truncated: false })
    // One byte inside the closing tag ('</p>' minus its final '>'): the tag is
    // now open-ended, so the whole partial closing tag drops, per the same
    // rule the earlier "drops a tag the cut landed inside" test pins.
    const cutInsideTag = capDecodedBody(html, 99, 'html')
    expect(cutInsideTag.truncated).toBe(true)
    expect(cutInsideTag.value).toBe('<p>' + 'y'.repeat(93))
  })
})

describe('packages/net/eml — cap telemetry (§2.145)', () => {
  /** Collects what would be sent, through the same seam main.ts wires. */
  function captureNetEvents(): { events: Array<{ name: string; tags: Record<string, unknown> }>; restore: () => void } {
    const events: Array<{ name: string; tags: Record<string, unknown> }> = []
    setNetEventReporter((name, tags) => { events.push({ name, tags }) })
    return { events, restore: () => setNetEventReporter(null) }
  }

  it('reports a hard trip as aggregates only', async () => {
    const { events, restore } = captureNetEvents()
    try {
      const headers = Buffer.from('From: a@example.com\r\nSubject: Enormous\r\n\r\n', 'utf8')
      await parseEmlBuffer(
        920,
        Buffer.concat([headers, Buffer.alloc(MAX_EML_PARSE_BYTES + 1 - headers.length, 0x41)]),
      )
    } finally {
      restore()
    }

    const trip = events.filter(e => e.name === 'eml.parse_cap_hard')
    expect(trip.length).toBe(1)
    // A size band and nothing else — no byte count, no subject, no address.
    expect(Object.keys(trip[0].tags)).toEqual(['size_bucket'])
    expect(trip[0].tags.size_bucket).toBe('1MB+')
  })

  it('reports a soft trip with the tier that tripped', async () => {
    const body = ['From: a@example.com', 'Subject: Long', '', 'x'.repeat(4096), ''].join('\r\n')
    const raw = Buffer.from(body, 'utf8')

    const first = captureNetEvents()
    try {
      // Routed through the same wrapper production uses, so the report does not
      // depend on which inline entry point the message took.
      await parseEmlBufferInline(921, raw, 1024)
      // The inline helper itself does not report — the wrapper does.
      expect(first.events.filter(e => e.name === 'eml.parse_cap_soft').length).toBe(0)
    } finally {
      first.restore()
    }

    const second = captureNetEvents()
    try {
      await parseEmlBuffer(922, raw)
    } finally {
      second.restore()
    }
    // 4 KiB is far below the first-tier cap, so nothing trips on the real path.
    expect(second.events.filter(e => e.name === 'eml.parse_cap_soft').length).toBe(0)

    const third = captureNetEvents()
    try {
      await parseEmlBuffer(923, Buffer.from([
        'From: a@example.com',
        'Subject: Long',
        '',
        'x'.repeat(EML_BODY_SOFT_CAP_BYTES + 1024),
        '',
      ].join('\r\n'), 'utf8'))
    } finally {
      third.restore()
    }
    const soft = third.events.filter(e => e.name === 'eml.parse_cap_soft')
    expect(soft.length).toBe(1)
    expect(soft[0].tags).toEqual({ size_bucket: '1MB+', tier: 'default' })
  })

  it('never lets a broken telemetry sink cost the user a message', async () => {
    setNetEventReporter(() => { throw new Error('sink is down') })
    try {
      const details = await parseEmlBuffer(924, Buffer.from([
        'From: a@example.com',
        'Subject: Long',
        '',
        'x'.repeat(EML_BODY_SOFT_CAP_BYTES + 1024),
        '',
      ].join('\r\n'), 'utf8'))
      expect(details.parseCap?.kind).toBe('soft')
    } finally {
      setNetEventReporter(null)
    }
  })
})

describe('packages/net/eml — MessageParseCap is a real union (§2.145 fix wave 1.1)', () => {
  // Type-level, and it earns its place: the first version was ONE object with
  // `kind: 'hard' | 'soft'` and an optional `canShowFull`, so the compiler
  // accepted `{ kind: 'hard', canShowFull: true }` — a state this system does
  // not have, and one a renderer would read as "offer the user a button that
  // raises the hard cap", i.e. a button that asks the app to run out of memory.
  // It equally accepted a soft cap with the field missing, which renders the
  // same as `false` while meaning "nobody decided".
  it('rejects the shapes the optional-field version allowed', () => {
    const hard: MessageParseCap = { kind: 'hard', rawBytes: 200e6, limitBytes: 100e6 }
    const soft: MessageParseCap = { kind: 'soft', rawBytes: 2e6, limitBytes: 1e6, canShowFull: true }
    expect(hard.kind).toBe('hard')
    expect(soft.canShowFull).toBe(true)

    // @ts-expect-error — a hard cap can never offer a raised tier.
    const bad1: MessageParseCap = { kind: 'hard', rawBytes: 1, limitBytes: 1, canShowFull: true }
    // @ts-expect-error — a soft cap must state whether more can be asked for.
    const bad2: MessageParseCap = { kind: 'soft', rawBytes: 1, limitBytes: 1 }
    expect([bad1, bad2]).toHaveLength(2)
  })

  // The narrowing has to be usable, not merely sound: consumers switch on
  // `kind` and read `canShowFull` in the soft arm without a non-null assertion.
  it('narrows so the soft arm can read canShowFull directly', () => {
    const describe_ = (cap: MessageParseCap): string =>
      cap.kind === 'hard' ? 'placeholder' : cap.canShowFull ? 'banner+button' : 'banner'

    expect(describe_({ kind: 'hard', rawBytes: 1, limitBytes: 1 })).toBe('placeholder')
    expect(describe_({ kind: 'soft', rawBytes: 1, limitBytes: 1, canShowFull: true })).toBe('banner+button')
    expect(describe_({ kind: 'soft', rawBytes: 1, limitBytes: 1, canShowFull: false })).toBe('banner')
  })
})
