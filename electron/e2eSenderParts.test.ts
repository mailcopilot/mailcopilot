import { describe, it, expect, vi } from 'vitest'

// e2eSenderParts.ts imports the production verdict from packages/net/imap.ts,
// whose module graph reaches the DB (native better-sqlite3) and SMTP. Same
// mocks packages/net/imap.test.ts uses — the subject here is a pure function.
vi.mock('../packages/db', () => ({
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
  setPinned: vi.fn(),
}))
vi.mock('../packages/net/smtp', () => ({
  buildRawMessage: vi.fn().mockResolvedValue(Buffer.from('raw', 'utf8')),
}))

import { senderPartsFromHeader, parseSenderHeader } from './e2eSenderParts'
import { senderFromEnvelope } from '../packages/net/imap'

/**
 * §2.172 — behavioural pinning of the e2e fixture sender split.
 *
 * Every assertion is about the VALUES a fixture `From:` produces, never about
 * the source text of main.ts: the point of the task is that the seeding sites
 * cannot produce a row the production parser could not have written, and only
 * values can express that.
 *
 * The load-bearing rule: `fromAddr` is the parsed address or the empty string.
 * It is never back-filled from the display name, because the display name is
 * attacker-controlled free text and `from_address` static rules (which can move
 * or delete mail) compare against `fromAddr` alone.
 */
describe('senderPartsFromHeader', () => {
  const cases: Array<{
    title: string
    from: string
    expected: { from: string; fromAddr: string; fromName: string | undefined }
  }> = [
    {
      title: 'display name plus angle-bracket address',
      from: 'MailCopilot Team <product@mailcopilot.io>',
      expected: {
        from: 'MailCopilot Team',
        fromAddr: 'product@mailcopilot.io',
        fromName: 'MailCopilot Team',
      },
    },
    {
      title: 'bare addr-spec is an address, not a name (production parity)',
      from: 'alice@example.test',
      expected: { from: 'alice@example.test', fromAddr: 'alice@example.test', fromName: undefined },
    },
    {
      title: 'quoted address-lookalike name with no angle brackets yields no address',
      from: '"victim@example.com"',
      expected: { from: 'victim@example.com', fromAddr: '', fromName: 'victim@example.com' },
    },
    {
      title: 'multi-token text containing @ is a name, not an address',
      from: 'Support via alice@example.test',
      expected: {
        from: 'Support via alice@example.test',
        fromAddr: '',
        fromName: 'Support via alice@example.test',
      },
    },
    {
      title: 'plain display name with no address at all',
      from: 'Some Name',
      expected: { from: 'Some Name', fromAddr: '', fromName: 'Some Name' },
    },
    {
      title: 'empty header',
      from: '',
      expected: { from: '', fromAddr: '', fromName: undefined },
    },
    {
      title: 'quoted name containing a comma keeps the comma and the real address',
      from: '"Doe, John" <john@example.test>',
      expected: { from: 'Doe, John', fromAddr: 'john@example.test', fromName: 'Doe, John' },
    },
    {
      title: 'quoted name containing a comma and no address yields no address',
      from: '"Doe, John"',
      expected: { from: 'Doe, John', fromAddr: '', fromName: 'Doe, John' },
    },
    {
      title: 'spoof: display name is a real address, envelope address is the attacker',
      from: '"victim@example.com" <attacker@evil.example>',
      expected: {
        from: 'victim@example.com',
        fromAddr: 'attacker@evil.example',
        fromName: 'victim@example.com',
      },
    },
    {
      title: 'empty angle brackets do not promote the label to an address',
      from: 'victim@example.com <>',
      expected: { from: 'victim@example.com', fromAddr: '', fromName: 'victim@example.com' },
    },
    {
      title: 'angle brackets with no display name before them are a bare address, no name',
      from: '<bob@example.test>',
      expected: { from: 'bob@example.test', fromAddr: 'bob@example.test', fromName: undefined },
    },
    {
      title: 'whitespace inside angle brackets is trimmed off the address',
      from: 'Bob <  bob@example.test  >',
      expected: { from: 'Bob', fromAddr: 'bob@example.test', fromName: 'Bob' },
    },
    {
      // No space on either side of the comma, so a mutation that dropped only
      // the comma exclusion from `isBareAddrSpec` (and left the whitespace
      // exclusion intact) would still turn this single-token string into a
      // bare-addr-spec match — the space-free shape is what makes the comma
      // check itself the thing under test, not the whitespace check.
      title: 'a comma with no surrounding space is still excluded from a bare addr-spec',
      from: 'alice@example.test,bob@example.test',
      expected: {
        from: 'alice@example.test,bob@example.test',
        fromAddr: '',
        fromName: 'alice@example.test,bob@example.test',
      },
    },
    {
      title: 'an unterminated angle bracket is not an addr-spec — whole string becomes the name',
      from: 'Name <bob@example.test',
      expected: { from: 'Name <bob@example.test', fromAddr: '', fromName: 'Name <bob@example.test' },
    },
  ]

  for (const c of cases) {
    it(c.title, () => {
      expect(senderPartsFromHeader(c.from)).toEqual(c.expected)
    })
  }

  it('never uses the display name as the address', () => {
    for (const c of cases) {
      if (c.expected.fromName && c.expected.fromName !== c.expected.fromAddr) {
        expect(senderPartsFromHeader(c.from).fromAddr).not.toBe(c.expected.fromName)
      }
    }
  })

  it('is idempotent across seeding sites: same header, same three fields', () => {
    for (const c of cases) {
      expect(senderPartsFromHeader(c.from)).toEqual(senderPartsFromHeader(c.from))
    }
  })

  /**
   * Behavioural pin, not a source-text check: replaces `senderPartsFromHeader`'s
   * internal call with an explicit `parseSenderHeader` → `senderFromEnvelope`
   * pipeline built from the two production imports directly, then asserts they
   * agree byte-for-byte. If `e2eSenderParts.ts` ever grows its own copy of the
   * `from: fromName || fromAddr` fallback or the trim rules instead of calling
   * the real `senderFromEnvelope`, this drifts from the direct pipeline while
   * `senderPartsFromHeader` itself would still pass every case above (a
   * reimplementation can accidentally match the fixtures without matching the
   * production function).
   */
  it('is a pass-through: parseSenderHeader piped into the real senderFromEnvelope matches senderPartsFromHeader', () => {
    const headers = [
      ...cases.map(c => c.from),
      '"  " <bob@example.test>', // whitespace-only quoted name: senderFromEnvelope's
      // own `(name || '').trim() || undefined` fallback is what turns this into
      // `fromName: undefined` and `from: fromAddr` — not a case any of the
      // `cases` table exercises directly.
    ]
    for (const raw of headers) {
      const direct = senderFromEnvelope(parseSenderHeader(raw))
      expect(senderPartsFromHeader(raw)).toEqual(direct)
    }
    expect(senderFromEnvelope(parseSenderHeader('"  " <bob@example.test>'))).toEqual({
      from: 'bob@example.test',
      fromAddr: 'bob@example.test',
      fromName: undefined,
    })
  })
})
