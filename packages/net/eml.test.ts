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

import { extractEmlAttachment, parseEmlBuffer } from './eml'
import { extractIcsFromRawEml } from './message'

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
