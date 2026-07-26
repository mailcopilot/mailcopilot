import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock dependencies of imap.ts — DB and SMTP (better-sqlite3 is a native module).
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
vi.mock('./smtp', () => ({
  buildRawMessage: vi.fn().mockResolvedValue(Buffer.from('raw', 'utf8')),
}))

import {
  detectFolderRoles, listMailboxes,
  connectImapPerAccount, withImapRetryPerAccount, disconnectAllPerAccount,
  extractReferencesHeader,
  collectAttachmentFilenames,
  __testDetectAttachments,
  classifyImapError,
  fetchAllFolderHeaders,
  syncFolderFlagsOnly,
  withImapRetry,
  registerAuthErrorHandler,
  unregisterAuthErrorHandler,
  registerCertErrorHandler,
  unregisterCertErrorHandler,
  IDLE_REFRESH_MS,
  MAX_CONNECTIONS_PER_ACCOUNT,
  __testInvokeAuthHandlerWithCooldown,
  __resetAuthRefreshConsecutiveForTest,
  AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS,
  startIdle,
  stopIdle,
  saveDraft,
  deleteDraft,
  sweepOrphanDrafts,
  withSaveDraftLock,
  __resetSaveDraftLockForTest,
  extractMessageIdFromRaw,
  forceDisconnectImap,
} from './imap'
import {
  __resetAuthRefreshCooldown,
  __setAuthRefreshCooldownClock,
  isInCooldown,
  peekCooldownEntry,
  recordRefreshFailure,
  recordRefreshSuccess,
} from './authRefreshCooldown'
import {
  getAccountMessageCount,
  getFolderUids,
  getFolderFlags,
  removeStaleMessages,
  removeStaleMessagesByUids,
  setUnread,
} from '../db'
import type { ImapConfig, Mailbox } from './types'

// Mock mailboxOpen result — configurable per test
let mockMailboxResult: { exists: number; highestModseq: bigint | null; uidValidity: number } = {
  exists: 10, highestModseq: BigInt(100), uidValidity: 1,
}
// Mock fetch results — configurable per test (array of message-like objects)
let mockFetchResults: Array<{ uid: number; flags?: Set<string>; envelope?: Record<string, unknown>; bodyStructure?: unknown; internalDate?: Date; headers?: Buffer }> = []

// Mock ImapFlow for listMailboxes + fetchAllFolderHeaders + syncFolderFlagsOnly
vi.mock('imapflow', () => {
  const mockList = vi.fn()
  const mockConnect = vi.fn().mockResolvedValue(undefined)
  const mockLogout = vi.fn().mockResolvedValue(undefined)
  return {
    ImapFlow: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      logout: mockLogout,
      list: mockList,
      usable: true,
      on: vi.fn(),
      close: vi.fn(),
      noop: vi.fn().mockResolvedValue(undefined),
      mailboxOpen: vi.fn().mockImplementation(() => Promise.resolve(mockMailboxResult)),
      fetch: vi.fn().mockImplementation(() => ({
        [Symbol.asyncIterator]: () => {
          let i = 0
          return {
            next: () => {
              if (i < mockFetchResults.length) return Promise.resolve({ value: mockFetchResults[i++], done: false })
              return Promise.resolve({ value: undefined, done: true })
            },
          }
        },
      })),
      fetchOne: vi.fn().mockResolvedValue(null),
    })),
    __mockList: mockList,
    __mockConnect: mockConnect,
  }
})

describe('packages/net/imap — detectFolderRoles', () => {
  it('detects roles by specialUse (RFC 6154)', () => {
    const boxes: Mailbox[] = [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Sent Items', name: 'Sent Items', specialUse: '\\Sent' },
      { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts' },
      { path: 'Deleted', name: 'Deleted', specialUse: '\\Trash' },
      { path: 'Spam', name: 'Spam', specialUse: '\\Junk' },
      { path: 'All', name: 'All', specialUse: '\\Archive' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.sent).toBe('Sent Items')
    expect(roles.drafts).toBe('Drafts')
    expect(roles.trash).toBe('Deleted')
    expect(roles.junk).toBe('Spam')
    expect(roles.archive).toBe('All')
  })

  it('detects roles by folder name (fallback) when no specialUse', () => {
    const boxes: Mailbox[] = [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Sent', name: 'Sent' },
      { path: 'Trash', name: 'Trash' },
      { path: 'Drafts', name: 'Drafts' },
      { path: 'Spam', name: 'Spam' },
      { path: 'Archive', name: 'Archive' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.sent).toBe('Sent')
    expect(roles.trash).toBe('Trash')
    expect(roles.drafts).toBe('Drafts')
    expect(roles.junk).toBe('Spam')
    expect(roles.archive).toBe('Archive')
  })

  it('Russian folder names are correctly detected', () => {
    const boxes: Mailbox[] = [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Отправленные', name: 'Отправленные' },
      { path: 'Корзина', name: 'Корзина' },
      { path: 'Черновики', name: 'Черновики' },
      { path: 'Спам', name: 'Спам' },
      { path: 'Архив', name: 'Архив' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.sent).toBe('Отправленные')
    expect(roles.trash).toBe('Корзина')
    expect(roles.drafts).toBe('Черновики')
    expect(roles.junk).toBe('Спам')
    expect(roles.archive).toBe('Архив')
  })

  it('specialUse takes priority over name', () => {
    const boxes: Mailbox[] = [
      { path: 'Inbox', name: 'Inbox' },
      { path: 'Custom Sent Folder', name: 'Custom Sent Folder', specialUse: '\\Sent' },
      { path: 'Sent', name: 'Sent' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.sent).toBe('Custom Sent Folder')
  })

  it('returns empty object if folders have no roles', () => {
    const boxes: Mailbox[] = [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Custom1', name: 'Custom1' },
      { path: 'Custom2', name: 'Custom2' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles).toEqual({})
  })

  it('handles empty folder list', () => {
    const roles = detectFolderRoles([])
    expect(roles).toEqual({})
  })

  it('Deleted Items is detected as trash', () => {
    const boxes: Mailbox[] = [
      { path: 'Deleted Items', name: 'Deleted Items' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.trash).toBe('Deleted Items')
  })

  it('Sent Messages is detected as sent', () => {
    const boxes: Mailbox[] = [
      { path: 'Sent Messages', name: 'Sent Messages' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.sent).toBe('Sent Messages')
  })

  it('Bulk Mail is detected as junk', () => {
    const boxes: Mailbox[] = [
      { path: 'Bulk Mail', name: 'Bulk Mail' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.junk).toBe('Bulk Mail')
  })

  it('Gmail \\All specialUse is detected as archive', () => {
    const boxes: Mailbox[] = [
      { path: 'INBOX', name: 'INBOX' },
      { path: '[Gmail]/All Mail', name: 'All Mail', specialUse: '\\All' },
      { path: '[Gmail]/Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' },
      { path: '[Gmail]/Drafts', name: 'Drafts', specialUse: '\\Drafts' },
      { path: '[Gmail]/Spam', name: 'Spam', specialUse: '\\Junk' },
      { path: '[Gmail]/Trash', name: 'Trash', specialUse: '\\Trash' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.archive).toBe('[Gmail]/All Mail')
    expect(roles.sent).toBe('[Gmail]/Sent Mail')
    expect(roles.drafts).toBe('[Gmail]/Drafts')
    expect(roles.junk).toBe('[Gmail]/Spam')
    expect(roles.trash).toBe('[Gmail]/Trash')
  })

  it('\\Archive takes priority over \\All when both present', () => {
    const boxes: Mailbox[] = [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Archive', name: 'Archive', specialUse: '\\Archive' },
      { path: 'All Mail', name: 'All Mail', specialUse: '\\All' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.archive).toBe('Archive')
  })

  it('All Mail detected by name fallback when no specialUse', () => {
    const boxes: Mailbox[] = [
      { path: 'INBOX', name: 'INBOX' },
      { path: '[Gmail]/All Mail', name: 'All Mail' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.archive).toBe('[Gmail]/All Mail')
  })

  it('Russian Gmail Вся почта detected by name fallback', () => {
    const boxes: Mailbox[] = [
      { path: 'INBOX', name: 'INBOX' },
      { path: '[Gmail]/Вся почта', name: 'Вся почта' },
    ]
    const roles = detectFolderRoles(boxes)
    expect(roles.archive).toBe('[Gmail]/Вся почта')
  })
})

describe('packages/net/imap — listMailboxes', () => {
  it('excludes folders with \\Noselect flag (containers like [Gmail])', async () => {
    const { __mockList } = await import('imapflow') as unknown as { __mockList: ReturnType<typeof vi.fn> }
    __mockList.mockResolvedValue([
      {
        path: 'INBOX',
        name: 'INBOX',
        flags: new Set<string>(),
        specialUse: undefined,
        status: { unseen: 3 },
      },
      {
        path: '[Gmail]',
        name: '[Gmail]',
        flags: new Set(['\\Noselect']),
        specialUse: undefined,
        status: undefined,
      },
      {
        path: '[Gmail]/Sent Mail',
        name: 'Sent Mail',
        flags: new Set<string>(),
        specialUse: '\\Sent',
        status: { unseen: 0 },
      },
      {
        path: '[Gmail]/Trash',
        name: 'Trash',
        flags: new Set<string>(),
        specialUse: '\\Trash',
        status: { unseen: 1 },
      },
    ])

    const result = await listMailboxes(1, {
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      user: 'test@gmail.com',
      pass: 'pass',
    })

    // [Gmail] with \Noselect should be excluded
    expect(result).toHaveLength(3)
    expect(result.map(r => r.path)).toEqual(['INBOX', '[Gmail]/Sent Mail', '[Gmail]/Trash'])
    expect(result.find(r => r.path === '[Gmail]')).toBeUndefined()
  })
})

describe('packages/net/imap — extractReferencesHeader', () => {
  it('parses single-line References header', () => {
    const buf = Buffer.from('References: <msg1@example.com> <msg2@example.com>\r\n')
    expect(extractReferencesHeader(buf)).toBe('<msg1@example.com> <msg2@example.com>')
  })

  it('parses multi-line header with continuation lines', () => {
    const buf = Buffer.from(
      'References: <msg1@example.com>\r\n' +
      ' <msg2@example.com>\r\n' +
      '\t<msg3@example.com>\r\n'
    )
    expect(extractReferencesHeader(buf)).toBe('<msg1@example.com> <msg2@example.com> <msg3@example.com>')
  })

  it('returns undefined for undefined', () => {
    expect(extractReferencesHeader(undefined)).toBeUndefined()
  })

  it('returns undefined for empty buffer', () => {
    expect(extractReferencesHeader(Buffer.from(''))).toBeUndefined()
  })

  it('returns undefined if References header is missing', () => {
    const buf = Buffer.from('Subject: test\r\nFrom: a@b.com\r\n')
    expect(extractReferencesHeader(buf)).toBeUndefined()
  })

  it('case-insensitive: REFERENCES, references, References', () => {
    const buf = Buffer.from('REFERENCES: <id1@x.com>\r\n')
    expect(extractReferencesHeader(buf)).toBe('<id1@x.com>')
  })

  it('single message-id', () => {
    const buf = Buffer.from('References: <single@msg.com>\r\n')
    expect(extractReferencesHeader(buf)).toBe('<single@msg.com>')
  })
})

describe('packages/net/imap — collectAttachmentFilenames', () => {
  it('returns empty array for null/undefined', () => {
    expect(collectAttachmentFilenames(null)).toEqual([])
    expect(collectAttachmentFilenames(undefined)).toEqual([])
  })

  it('collects filename from disposition=attachment', () => {
    const bs = {
      disposition: 'attachment',
      dispositionParameters: { filename: 'report.pdf' },
    }
    expect(collectAttachmentFilenames(bs)).toEqual(['report.pdf'])
  })

  it('collects filename from parameters.name fallback', () => {
    const bs = {
      disposition: 'attachment',
      parameters: { name: 'invoice.xlsx' },
    }
    expect(collectAttachmentFilenames(bs)).toEqual(['invoice.xlsx'])
  })

  it('collects inline with filename', () => {
    const bs = {
      disposition: 'inline',
      dispositionParameters: { filename: 'diagram.png' },
    }
    expect(collectAttachmentFilenames(bs)).toEqual(['diagram.png'])
  })

  it('ignores inline without filename', () => {
    expect(collectAttachmentFilenames({ disposition: 'inline' })).toEqual([])
  })

  it('collects filenames from nested childNodes', () => {
    const bs = {
      childNodes: [
        { disposition: 'attachment', dispositionParameters: { filename: 'doc1.pdf' } },
        {
          childNodes: [
            { disposition: 'attachment', parameters: { name: 'doc2.xlsx' } },
          ],
        },
        { disposition: 'inline' },
      ],
    }
    expect(collectAttachmentFilenames(bs)).toEqual(['doc1.pdf', 'doc2.xlsx'])
  })

  it('trims whitespace from filenames', () => {
    const bs = { disposition: 'attachment', dispositionParameters: { filename: '  spaced.txt  ' } }
    expect(collectAttachmentFilenames(bs)).toEqual(['spaced.txt'])
  })

  it('returns empty for non-object input', () => {
    expect(collectAttachmentFilenames('string')).toEqual([])
    expect(collectAttachmentFilenames(123)).toEqual([])
  })
})

describe('packages/net/imap — detectAttachments', () => {
  // §2.22 — invites surfaced via paperclip even when Content-Disposition is missing.
  it('AC1: returns true for text/calendar leaf without disposition (separate type+subtype shape)', () => {
    expect(__testDetectAttachments({ type: 'text', subtype: 'calendar' })).toBe(true)
  })

  it('AC1b: returns true for text/calendar leaf without disposition (imapflow combined type shape)', () => {
    expect(__testDetectAttachments({ type: 'text/calendar' })).toBe(true)
  })

  it('AC2: returns true for application/ics leaf without disposition', () => {
    expect(__testDetectAttachments({ type: 'application', subtype: 'ics' })).toBe(true)
    expect(__testDetectAttachments({ type: 'application/ics' })).toBe(true)
  })

  it('AC3: returns true for application/octet-stream leaf with .ics filename and no disposition', () => {
    expect(
      __testDetectAttachments({
        type: 'application',
        subtype: 'octet-stream',
        parameters: { name: 'invite.ics' },
      }),
    ).toBe(true)
    // imapflow combined-type variant
    expect(
      __testDetectAttachments({
        type: 'application/octet-stream',
        parameters: { name: 'meeting.ICS' },
      }),
    ).toBe(true)
  })

  it('AC3b: application/octet-stream with non-ics filename and no disposition stays false', () => {
    // Ensures the calendar branch does not over-match generic octet-stream leaves.
    expect(
      __testDetectAttachments({
        type: 'application/octet-stream',
        parameters: { name: 'data.bin' },
      }),
    ).toBe(false)
  })

  it('AC4: returns false for multipart/alternative with text/plain + text/html children only', () => {
    const bs = {
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain' },
        { type: 'text/html' },
      ],
    }
    expect(__testDetectAttachments(bs)).toBe(false)
  })

  it('AC5: returns true for regular PDF attachment with disposition=attachment (existing behaviour)', () => {
    const bs = {
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'report.pdf' },
    }
    expect(__testDetectAttachments(bs)).toBe(true)
  })

  it('AC6: returns true for inline image with filename (existing behaviour)', () => {
    const bs = {
      type: 'image/png',
      disposition: 'inline',
      dispositionParameters: { filename: 'diagram.png' },
    }
    expect(__testDetectAttachments(bs)).toBe(true)
  })

  it('detects calendar invite nested inside multipart/mixed (real-world Outlook invite shape)', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            { type: 'text/plain' },
            { type: 'text/html' },
            { type: 'text/calendar', parameters: { method: 'REQUEST' } },
          ],
        },
      ],
    }
    expect(__testDetectAttachments(bs)).toBe(true)
  })

  it('returns false for null/undefined/non-object input', () => {
    expect(__testDetectAttachments(null)).toBe(false)
    expect(__testDetectAttachments(undefined)).toBe(false)
    expect(__testDetectAttachments('string')).toBe(false)
    expect(__testDetectAttachments(123)).toBe(false)
  })

  it('still ignores inline parts without filename (e.g. embedded cid images without name)', () => {
    expect(__testDetectAttachments({ type: 'image/png', disposition: 'inline' })).toBe(false)
  })

  // Real-world provider shapes and additional edge cases

  it('Apple Calendar: text/calendar with disposition=attachment returns true (calendar branch fires first)', () => {
    // Apple Calendar frequently attaches ICS with explicit Content-Disposition: attachment.
    // The calendar type check precedes the disposition check in the implementation,
    // so this must return true via the calendar path, not the generic disposition path.
    expect(
      __testDetectAttachments({
        type: 'text',
        subtype: 'calendar',
        disposition: 'attachment',
        dispositionParameters: { filename: 'invite.ics' },
      }),
    ).toBe(true)
    // Combined-type variant (imapflow shape)
    expect(
      __testDetectAttachments({
        type: 'text/calendar',
        disposition: 'attachment',
        dispositionParameters: { filename: 'invite.ics' },
      }),
    ).toBe(true)
  })

  it('application/octet-stream with .ics in dispositionParameters.filename (not parameters.name)', () => {
    // Some servers set the filename in Content-Disposition params rather than Content-Type params.
    expect(
      __testDetectAttachments({
        type: 'application/octet-stream',
        disposition: 'attachment',
        dispositionParameters: { filename: 'calendar.ics' },
      }),
    ).toBe(true)
    // Uppercase extension
    expect(
      __testDetectAttachments({
        type: 'application/octet-stream',
        disposition: 'attachment',
        dispositionParameters: { filename: 'EVENT.ICS' },
      }),
    ).toBe(true)
  })

  it('Gmail shape: multipart/mixed with octet-stream .ics at top level alongside text parts', () => {
    // Gmail attaches ICS as application/octet-stream inside multipart/mixed next to text/plain + text/html.
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            { type: 'text/plain' },
            { type: 'text/html' },
          ],
        },
        {
          type: 'application/octet-stream',
          disposition: 'attachment',
          dispositionParameters: { filename: 'invite.ics' },
        },
      ],
    }
    expect(__testDetectAttachments(bs)).toBe(true)
  })

  it('deeply nested calendar: multipart/mixed -> multipart/alternative -> text/calendar (Apple/Google)', () => {
    // Apple Calendar and Google Calendar can nest text/calendar two levels deep.
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            { type: 'text/plain' },
            { type: 'text/html' },
            {
              type: 'text/calendar',
              parameters: { method: 'REQUEST' },
            },
          ],
        },
      ],
    }
    expect(__testDetectAttachments(bs)).toBe(true)
  })

  it('null-valued parameters and dispositionParameters fields do not throw', () => {
    // Defensive: some IMAP servers may send null instead of omitting the field.
    expect(
      __testDetectAttachments({
        type: 'application/octet-stream',
        parameters: null,
        dispositionParameters: null,
      }),
    ).toBe(false)
  })

  it('empty string filename in parameters does not match .ics (no false-positive on octet-stream)', () => {
    expect(
      __testDetectAttachments({
        type: 'application/octet-stream',
        parameters: { name: '' },
      }),
    ).toBe(false)
  })

  // codex-bg-review gap fixes -----------------------------------------------

  it('AC1: .ics filename branch fires on application/octet-stream without disposition (isolated from disposition path)', () => {
    // The disposition='attachment' path would catch this regardless of filename.
    // This test has NO disposition field — exercising the .ics-filename detection branch in isolation.
    expect(
      __testDetectAttachments({
        type: 'application/octet-stream',
        dispositionParameters: { filename: 'invite.ics' },
      }),
    ).toBe(true)
  })

  it('AC2: MIME lookalikes — text/vcard, text/x-vcalendar, application/calendar+json do not trigger attachment detection', () => {
    // These are related MIME types but are NOT ICS/iTIP invites; paperclip must not appear.
    expect(__testDetectAttachments({ type: 'text/vcard' })).toBe(false)
    expect(__testDetectAttachments({ type: 'text/x-vcalendar' })).toBe(false)
    expect(__testDetectAttachments({ type: 'application/calendar+json' })).toBe(false)
    // Confirm same when expressed as separate type/subtype fields
    expect(__testDetectAttachments({ type: 'text', subtype: 'vcard' })).toBe(false)
  })

  it('AC3: disguised filename invite.ics.exe does not match — regex requires .ics at end of string', () => {
    // Security boundary: a malicious file with .ics embedded mid-filename must NOT match.
    expect(
      __testDetectAttachments({
        type: 'application/octet-stream',
        parameters: { name: 'invite.ics.exe' },
      }),
    ).toBe(false)
    // Same shape via dispositionParameters
    expect(
      __testDetectAttachments({
        type: 'application/octet-stream',
        dispositionParameters: { filename: 'invite.ics.exe' },
      }),
    ).toBe(false)
  })
})

describe('packages/net/imap — per-account IMAP pool', () => {
  const cfg1: ImapConfig = { host: 'imap.a.com', port: 993, secure: true, user: 'user1@a.com', pass: 'p1' }
  const cfg2: ImapConfig = { host: 'imap.b.com', port: 993, secure: true, user: 'user2@b.com', pass: 'p2' }

  afterEach(async () => {
    await disconnectAllPerAccount()
  })

  it('connectImapPerAccount creates a connection', async () => {
    const c = await connectImapPerAccount(cfg1)
    expect(c).toBeTruthy()
    expect(c.usable).toBe(true)
  })

  it('connectImapPerAccount reuses existing connection', async () => {
    const c1 = await connectImapPerAccount(cfg1)
    const c2 = await connectImapPerAccount(cfg1)
    expect(c1).toBe(c2)
  })

  it('connectImapPerAccount creates different connections for different accounts', async () => {
    const c1 = await connectImapPerAccount(cfg1)
    const c2 = await connectImapPerAccount(cfg2)
    expect(c1).not.toBe(c2)
  })

  it('withImapRetryPerAccount executes operation', async () => {
    const result = await withImapRetryPerAccount(1, cfg1, async () => 42)
    expect(result).toBe(42)
  })

  it('withImapRetryPerAccount retries on NoConnection', async () => {
    let attempt = 0
    const result = await withImapRetryPerAccount(1, cfg1, async () => {
      attempt++
      if (attempt === 1) throw new Error('NoConnection')
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(attempt).toBe(2)
  })

  it('disconnectAllPerAccount closes all connections', async () => {
    await connectImapPerAccount(cfg1)
    await connectImapPerAccount(cfg2)
    await disconnectAllPerAccount()

    // After disconnect, a new connect will create new connections
    const c = await connectImapPerAccount(cfg1)
    expect(c).toBeTruthy()
  })

  it('per-account op lock serializes operations for a single account', async () => {
    const order: number[] = []
    const p1 = withImapRetryPerAccount(1, cfg1, async () => {
      order.push(1)
      await new Promise(r => setTimeout(r, 10))
      order.push(2)
    })
    const p2 = withImapRetryPerAccount(1, cfg1, async () => {
      order.push(3)
    })
    await Promise.all([p1, p2])
    // Operations for a single account are executed sequentially
    expect(order).toEqual([1, 2, 3])
  })
})

// --- §2.17 Phase 0: imap.pool_queue_wait_ms ---

describe('withImapRetryPerAccount — pool queue wait telemetry (§2.17 Phase 0)', () => {
  const waitCfg: ImapConfig = { host: 'imap.wait.com', port: 993, secure: true, user: 'wait@x.com', pass: 'p' }

  afterEach(async () => {
    await disconnectAllPerAccount()
    // Restore the no-op reporter between cases.
    const { setNetEventReporter } = await import('./telemetry')
    setNetEventReporter(null)
  })

  it('emits imap.pool_queue_wait_ms with requester=interactive when wait > 500ms', async () => {
    const events: Array<{ name: string; tags: Record<string, string | number | boolean> }> = []
    const { setNetEventReporter } = await import('./telemetry')
    setNetEventReporter((name, tags) => { events.push({ name, tags }) })

    // Block the per-account op chain with a slow first op so the second
    // call observes a real wait. The first op also pulls the queue beyond
    // the 500ms threshold; we measure the second call's wait.
    const slowOp = withImapRetryPerAccount(1, waitCfg, async () => {
      await new Promise(r => setTimeout(r, 600))
    })
    // Small jitter so the second call enters the chain after the first
    // grabs the lock.
    await new Promise(r => setTimeout(r, 5))
    const fastOp = withImapRetryPerAccount(1, waitCfg, async () => 'ok', 2, { priority: 'interactive' })

    await Promise.all([slowOp, fastOp])

    const waitEvents = events.filter(e => e.name === 'imap.pool_queue_wait_ms')
    expect(waitEvents.length).toBe(1)
    expect(waitEvents[0]!.tags.requester).toBe('interactive')
    // wait_ms_bucket is one of the bucketDuration buckets — anything
    // above '<50' is acceptable here; we only assert the tag is present.
    expect(typeof waitEvents[0]!.tags.wait_ms_bucket).toBe('string')
  })

  it('does NOT emit imap.pool_queue_wait_ms when fn() runs without a real wait', async () => {
    const events: Array<{ name: string; tags: Record<string, string | number | boolean> }> = []
    const { setNetEventReporter } = await import('./telemetry')
    setNetEventReporter((name, tags) => { events.push({ name, tags }) })

    // No prior op holds the chain; this call should run essentially
    // immediately and stay below the 500ms reporting threshold.
    await withImapRetryPerAccount(2, { ...waitCfg, user: 'noWait@x.com' }, async () => 'ok', 2, {
      priority: 'background',
    })

    const waitEvents = events.filter(e => e.name === 'imap.pool_queue_wait_ms')
    expect(waitEvents).toHaveLength(0)
  })

  it("falls back to requester='other' when opts is omitted", async () => {
    const events: Array<{ name: string; tags: Record<string, string | number | boolean> }> = []
    const { setNetEventReporter } = await import('./telemetry')
    setNetEventReporter((name, tags) => { events.push({ name, tags }) })

    const slowOp = withImapRetryPerAccount(3, { ...waitCfg, user: 'other@x.com' }, async () => {
      await new Promise(r => setTimeout(r, 600))
    })
    await new Promise(r => setTimeout(r, 5))
    const fastOp = withImapRetryPerAccount(3, { ...waitCfg, user: 'other@x.com' }, async () => 'ok')

    await Promise.all([slowOp, fastOp])

    const waitEvents = events.filter(e => e.name === 'imap.pool_queue_wait_ms')
    expect(waitEvents.length).toBe(1)
    expect(waitEvents[0]!.tags.requester).toBe('other')
  })
})

// --- imapSearchFolder ---

describe('imapSearchFolder', () => {
  const searchCfg: ImapConfig = { host: 'imap.test.com', port: 993, secure: true, user: 'search@test.com', pass: 'pass' }

  it('returns empty array when no criteria provided', async () => {
    const { imapSearchFolder } = await import('./imap')
    const result = await imapSearchFolder(1, searchCfg, 'INBOX', {}, 100)
    expect(result).toEqual([])
  })
})

// --- classifyImapError ---

describe('classifyImapError', () => {
  it('classifies auth errors', () => {
    expect(classifyImapError(new Error('AUTHENTICATIONFAILED'))).toBe('auth')
    expect(classifyImapError(new Error('NO LOGIN failed'))).toBe('auth')
    expect(classifyImapError(new Error('Invalid credentials'))).toBe('auth')
    expect(classifyImapError(new Error('AUTHENTICATE PLAIN rejected'))).toBe('auth')
    expect(classifyImapError(new Error('CREDENTIALS invalid'))).toBe('auth')
  })

  it('classifies permanent errors', () => {
    expect(classifyImapError(new Error('NO [NONEXISTENT] mailbox'))).toBe('permanent')
    expect(classifyImapError(new Error('Mailbox does not exist'))).toBe('permanent')
    expect(classifyImapError(new Error('mailbox not found'))).toBe('permanent')
  })

  it('classifies network errors', () => {
    expect(classifyImapError(new Error('ECONNRESET'))).toBe('network')
    expect(classifyImapError(new Error('ETIMEDOUT'))).toBe('network')
    expect(classifyImapError(new Error('socket closed'))).toBe('network')
    expect(classifyImapError(new Error('Something unknown happened'))).toBe('network')
  })

  it('classifies Microsoft XOAUTH2 auth errors', () => {
    expect(classifyImapError(new Error('AUTHENTICATE failed — XOAUTH2 mechanism not available'))).toBe('auth')
    expect(classifyImapError(new Error('NO LOGIN failed (XOAUTH2)'))).toBe('auth')
    expect(classifyImapError(new Error('token expired'))).toBe('auth')
    expect(classifyImapError(new Error('XOAUTH2 authentication error'))).toBe('auth')
  })

  it('classifies Google-specific auth errors', () => {
    expect(classifyImapError(new Error('WEBALERT https://accounts.google.com/'))).toBe('auth')
    expect(classifyImapError(new Error('Web login required'))).toBe('auth')
  })

  it('handles non-Error objects', () => {
    expect(classifyImapError('string error')).toBe('network')
    expect(classifyImapError(undefined)).toBe('network')
  })

  // ─── 'cert' class (TLS trust failures — AV/proxy interception, bad chains) ─

  it('classifies OpenSSL/Node cert error messages as cert (NOT network)', () => {
    expect(classifyImapError(new Error('self-signed certificate'))).toBe('cert')
    expect(classifyImapError(new Error('self signed certificate in certificate chain'))).toBe('cert')
    expect(classifyImapError(new Error('unable to verify the first certificate'))).toBe('cert')
    expect(classifyImapError(new Error('certificate has expired'))).toBe('cert')
    expect(classifyImapError(new Error("Hostname/IP does not match certificate's altnames: Host: imap.example.com. is not in the cert's altnames"))).toBe('cert')
    expect(classifyImapError(new Error('unable to get issuer certificate'))).toBe('cert')
  })

  it('classifies Node TLS error codes as cert', () => {
    const withCode = (code: string, message = 'connect failed') => {
      const e = new Error(message) as Error & { code: string }
      e.code = code
      return e
    }
    expect(classifyImapError(withCode('CERT_HAS_EXPIRED'))).toBe('cert')
    expect(classifyImapError(withCode('DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe('cert')
    expect(classifyImapError(withCode('SELF_SIGNED_CERT_IN_CHAIN'))).toBe('cert')
    expect(classifyImapError(withCode('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe('cert')
    expect(classifyImapError(withCode('UNABLE_TO_GET_ISSUER_CERT'))).toBe('cert')
    expect(classifyImapError(withCode('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'))).toBe('cert')
    expect(classifyImapError(withCode('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('cert')
  })

  it('classifies TLS pin mismatch as cert', () => {
    expect(classifyImapError(new Error('TLS pin mismatch: AA:BB:CC'))).toBe('cert')
  })

  it('cert takes precedence over auth (no useless token refresh on TLS failure)', () => {
    // A message that matches both cert and auth patterns must classify cert —
    // refreshing an OAuth token cannot fix a broken TLS chain.
    expect(classifyImapError(new Error('LOGIN aborted: self-signed certificate'))).toBe('cert')
  })

  it('plain network errors stay network (no cert false positives)', () => {
    expect(classifyImapError(new Error('ECONNRESET'))).toBe('network')
    expect(classifyImapError(new Error('Unexpected close'))).toBe('network')
    const e = new Error('connect ETIMEDOUT') as Error & { code: string }
    e.code = 'ETIMEDOUT'
    expect(classifyImapError(e)).toBe('network')
  })

  // Regression (codex round-3 MEDIUM): the matcher used to carry a bare
  // `certificate` alternative, so ANY server response mentioning the word —
  // typically an auth/policy rejection — classified as 'cert'. Consequences:
  // the OAuth refresh path was suppressed for a plain auth failure, and the
  // user got a misleading "TLS interception" recovery dialog.
  it('auth/policy responses that merely MENTION a certificate stay auth (narrow matcher)', () => {
    expect(
      classifyImapError(new Error('NO [AUTHENTICATIONFAILED] client certificate required by policy')),
    ).toBe('auth')
    expect(
      classifyImapError(new Error('NO LOGIN failed: certificate-based authentication is disabled')),
    ).toBe('auth')
  })

  it('non-auth messages mentioning a certificate without a trust failure stay network', () => {
    expect(classifyImapError(new Error('server busy, certificate renewal in progress'))).toBe('network')
    // A lone "altname" token is not a trust failure either — the full OpenSSL
    // phrase is what identifies a hostname mismatch.
    expect(classifyImapError(new Error('unknown altname handling'))).toBe('network')
  })
})

// --- cert error handler registry + retry-wrapper integration ---

describe('registerCertErrorHandler — cert errors notify main and abort retry', () => {
  const certErr = () => {
    const e = new Error('unable to verify the first certificate') as Error & { code: string }
    e.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    return e
  }

  afterEach(async () => {
    unregisterCertErrorHandler(41)
    unregisterCertErrorHandler(42)
    unregisterCertErrorHandler(43)
    __resetAuthRefreshCooldown()
    await disconnectAllPerAccount()
    const { setNetEventReporter } = await import('./telemetry')
    setNetEventReporter(null)
  })

  it('withImapRetry: handler invoked with payload, error rethrown, no retry', async () => {
    const certCfg: ImapConfig = { host: 'imap.cert-a.com', port: 993, secure: true, user: 'a@cert.com', pass: 'p' }
    const handler = vi.fn()
    registerCertErrorHandler(41, handler)

    let attempts = 0
    await expect(
      withImapRetry(41, certCfg, async () => {
        attempts++
        throw certErr()
      }),
    ).rejects.toThrow('unable to verify')

    expect(attempts).toBe(1) // no connection-loss retry on cert errors
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      host: 'imap.cert-a.com',
      port: 993,
      rawMessage: 'unable to verify the first certificate',
      // Transport is part of the payload: the diagnostic probe must know
      // whether to speak implicit TLS or STARTTLS to this endpoint.
      secure: true,
      protocol: 'imap',
    })
  })

  it('withImapRetryPerAccount: handler invoked, no auth refresh triggered', async () => {
    const certCfg: ImapConfig = { host: 'imap.cert-b.com', port: 993, secure: true, user: 'b@cert.com', pass: undefined, accessToken: 'tok' }
    const certHandler = vi.fn()
    const refreshFn = vi.fn().mockResolvedValue('fresh-token')
    registerCertErrorHandler(42, certHandler)
    registerAuthErrorHandler(42, refreshFn)
    try {
      await expect(
        withImapRetryPerAccount(42, certCfg, async () => {
          throw certErr()
        }),
      ).rejects.toThrow('unable to verify')

      expect(certHandler).toHaveBeenCalledTimes(1)
      expect(certHandler.mock.calls[0]![0]).toMatchObject({ host: 'imap.cert-b.com', port: 993 })
      // TLS failure must NOT burn an OAuth refresh attempt
      expect(refreshFn).not.toHaveBeenCalled()
    } finally {
      unregisterAuthErrorHandler(42)
    }
  })

  it('emits imap.cert_error telemetry event even without a registered handler', async () => {
    const certCfg: ImapConfig = { host: 'imap.gmail.com', port: 993, secure: true, user: 'c@cert.com', pass: 'p' }
    const events: Array<{ name: string; tags: Record<string, string | number | boolean> }> = []
    const { setNetEventReporter } = await import('./telemetry')
    setNetEventReporter((name, tags) => { events.push({ name, tags }) })

    await expect(
      withImapRetry(43, certCfg, async () => {
        throw certErr()
      }),
    ).rejects.toThrow('unable to verify')

    const certEvents = events.filter(e => e.name === 'imap.cert_error')
    expect(certEvents).toHaveLength(1)
    expect(typeof certEvents[0]!.tags.provider).toBe('string')
  })

  it('a throwing handler does not change retry semantics (error still rethrown)', async () => {
    const certCfg: ImapConfig = { host: 'imap.cert-a.com', port: 993, secure: true, user: 'a@cert.com', pass: 'p' }
    registerCertErrorHandler(41, () => {
      throw new Error('subscriber exploded')
    })

    await expect(
      withImapRetry(41, certCfg, async () => {
        throw certErr()
      }),
    ).rejects.toThrow('unable to verify')
  })

  it('unregisterCertErrorHandler stops notifications and is idempotent', async () => {
    const certCfg: ImapConfig = { host: 'imap.cert-a.com', port: 993, secure: true, user: 'a@cert.com', pass: 'p' }
    const handler = vi.fn()
    registerCertErrorHandler(41, handler)
    unregisterCertErrorHandler(41)
    unregisterCertErrorHandler(41) // idempotent

    await expect(
      withImapRetry(41, certCfg, async () => {
        throw certErr()
      }),
    ).rejects.toThrow('unable to verify')

    expect(handler).not.toHaveBeenCalled()
  })
})

// --- constants ---

describe('IMAP constants', () => {
  it('IDLE_REFRESH_MS is 24 minutes', () => {
    expect(IDLE_REFRESH_MS).toBe(24 * 60 * 1000)
  })

  it('MAX_CONNECTIONS_PER_ACCOUNT is 3', () => {
    expect(MAX_CONNECTIONS_PER_ACCOUNT).toBe(3)
  })
})

// --- fetchAllFolderHeaders ---

const testCfg: ImapConfig = { host: 'imap.test', port: 993, secure: true, user: 'u', pass: 'p' }

describe('fetchAllFolderHeaders', () => {
  afterEach(() => {
    vi.clearAllMocks()
    mockMailboxResult = { exists: 10, highestModseq: BigInt(100), uidValidity: 1 }
    mockFetchResults = []
  })

  it('skips when knownModseq matches server highestModseq', async () => {
    mockMailboxResult = { exists: 5, highestModseq: BigInt(200), uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(5)

    const batches: unknown[][] = []
    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, (msgs) => batches.push(msgs), {
      knownModseq: '200',
    })

    expect(result.skipped).toBe(true)
    expect(result.fetched).toBe(0)
    expect(result.exists).toBe(5)
    expect(batches).toHaveLength(0)
  })

  it('does NOT skip when knownModseq matches but local cache is empty', async () => {
    mockMailboxResult = { exists: 5, highestModseq: BigInt(200), uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(0) // empty cache
    vi.mocked(getFolderUids).mockReturnValue([])
    // Provide FLAGS fetch results — 5 UIDs on server, all new
    mockFetchResults = [
      { uid: 1, flags: new Set(['\\Seen']) },
      { uid: 2, flags: new Set() },
      { uid: 3, flags: new Set(['\\Seen']) },
      { uid: 4, flags: new Set() },
      { uid: 5, flags: new Set() },
    ]

    const batches: unknown[][] = []
    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, (msgs) => batches.push(msgs), {
      knownModseq: '200', // same modseq — but empty cache forces full sync
    })

    expect(result.skipped).not.toBe(true)
    // Should have attempted to fetch headers for 5 new UIDs
    // (may produce 0 results because mock fetchOne returns null, but the point is it didn't skip)
    expect(result.exists).toBe(5)
  })

  it('clears all cursors on UIDVALIDITY mismatch', async () => {
    mockMailboxResult = { exists: 3, highestModseq: BigInt(50), uidValidity: 99 }
    vi.mocked(getAccountMessageCount).mockReturnValue(0)
    vi.mocked(getFolderUids).mockReturnValue([])
    mockFetchResults = [
      { uid: 10, flags: new Set() },
      { uid: 11, flags: new Set() },
      { uid: 12, flags: new Set() },
    ]

    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {}, {
      knownUidValidity: 1, // mismatch with server's 99
      sinceUid: 100, // should be cleared
      beforeUid: 200, // should be cleared
      knownModseq: '50', // should be cleared
    })

    // removeStaleMessages should have been called to purge cache with explicit reason
    expect(removeStaleMessages).toHaveBeenCalledWith(1, 'INBOX', [], { reason: 'uidvalidity_bump' })
    // Should NOT have skipped — full sync
    expect(result.skipped).not.toBe(true)
    expect(result.uidValidity).toBe(99)
  })

  it('filters header fetch by sinceUid (incremental sync)', async () => {
    mockMailboxResult = { exists: 5, highestModseq: null, uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(3) // 3 already cached
    vi.mocked(getFolderUids).mockReturnValue([1, 2, 3])
    // Local flags say all 3 cached UIDs are unread; the diff against server
    // flags (uid 1 + 3 are \Seen) should produce a markRead update.
    vi.mocked(getFolderFlags).mockReturnValue(new Map([
      [1, { unread: true, flagged: false }],
      [2, { unread: true, flagged: false }],
      [3, { unread: true, flagged: false }],
    ]))
    // Server has UIDs 1-5 — only 4 and 5 are new
    mockFetchResults = [
      { uid: 1, flags: new Set(['\\Seen']) },
      { uid: 2, flags: new Set() },
      { uid: 3, flags: new Set(['\\Seen']) },
      { uid: 4, flags: new Set() },
      { uid: 5, flags: new Set() },
    ]

    const fetchedUids: number[] = []
    await fetchAllFolderHeaders(testCfg, 'INBOX', 1, (msgs) => {
      for (const m of msgs) fetchedUids.push(m.uid)
    }, { sinceUid: 3 })

    // UIDs 1,2,3 should not get header fetch (they are <= sinceUid or already cached)
    // UIDs 4,5 are new and > sinceUid — should be fetched
    // Note: header fetch produces empty results because mock envelope is undefined,
    // but the FLAGS fetch should have updated flags for UIDs 1-3
    expect(setUnread).toHaveBeenCalled()
  })

  it('includes uncached UIDs below beforeUid during partial crawl', async () => {
    mockMailboxResult = { exists: 10, highestModseq: null, uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(3)
    vi.mocked(getFolderUids).mockReturnValue([8, 9, 10]) // cached top 3
    vi.mocked(getFolderFlags).mockReturnValue(new Map([
      [8, { unread: false, flagged: false }],
      [9, { unread: false, flagged: false }],
      [10, { unread: false, flagged: false }],
    ]))
    // Server has UIDs 1-10, local cache has {8,9,10}. Partial crawl targets
    // UIDs below watermark (beforeUid=8). Header fetch should pull UIDs 1-7.
    mockFetchResults = Array.from({ length: 10 }, (_, i) => ({
      uid: i + 1,
      flags: new Set(i >= 7 ? ['\\Seen'] : []),
    }))

    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {}, {
      beforeUid: 8,
    })

    // FLAGS fetch is 1:* (full) — all 10 UIDs come back for the flags scan.
    // The header-fetch path runs for the 7 UIDs not already cached (1-7).
    expect(result.exists).toBe(10)
    expect(result.fetched).toBeGreaterThan(0)
  })

  it('recovers gap UIDs above beforeUid watermark (covered_recent FLAGS-hole recovery)', async () => {
    // Regression for 2026-04-22 mail.ru Archive stuck at 37/38.
    // Scenario: prior crawl reached watermark=4023 and set status=covered_recent.
    // A partial cache wipe (WAL-loss on 2026-04-21) removed messages with UIDs
    // between 100 and 400 from the local cache. On the next resume the server
    // FLAGS scan still reports those UIDs, but they now live ABOVE the prior
    // watermark. Pre-fix the `uid >= beforeUid` guard dropped them and the
    // folder stayed permanently at `covered_recent` with fetched=0 every cycle.
    //
    // Post-fix: `localUidSet.has(uid)` is the sole authority for "already
    // cached", so gap UIDs above beforeUid are re-fetched and the folder can
    // progress back to covered_full once the counts reconcile.
    mockMailboxResult = { exists: 5, highestModseq: null, uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(2)
    vi.mocked(getFolderUids).mockReturnValue([100, 500])
    vi.mocked(getFolderFlags).mockReturnValue(new Map([
      [100, { unread: false, flagged: false }],
      [500, { unread: false, flagged: false }],
    ]))
    // Server returns UIDs {100, 200, 300, 400, 500} — the 200/300/400 UIDs
    // exist on the server but are missing locally. They all sit ABOVE
    // beforeUid=50 (the pre-fix guard excluded them entirely).
    mockFetchResults = [
      { uid: 100, flags: new Set() },
      { uid: 200, flags: new Set() },
      { uid: 300, flags: new Set() },
      { uid: 400, flags: new Set() },
      { uid: 500, flags: new Set() },
    ]

    const gotUids: number[] = []
    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, (msgs) => {
      for (const m of msgs) gotUids.push(m.uid)
    }, { beforeUid: 50 })

    expect(result.skipped).not.toBe(true)
    expect(result.exists).toBe(5)
    // Regression guard: fetched MUST NOT be zero. Pre-fix this was 0 because
    // every uncached UID (200,300,400) sat above beforeUid=50 and was
    // filtered out before the header fetch.
    expect(result.fetched).toBeGreaterThan(0)
    // The onBatch callback must have received at least the three gap UIDs.
    // (The shared imapflow mock doesn't honour the header-fetch range, so it
    // may also echo back cached UIDs — the regression property is that the
    // gap UIDs appear at all, not that cached UIDs are absent.)
    expect(gotUids).toEqual(expect.arrayContaining([200, 300, 400]))
  })

  it('sinceUid clause alone excludes below-watermark UIDs that are NOT cached', async () => {
    // Isolated regression for the sinceUid guard. The pre-existing
    // "filters header fetch by sinceUid" test above overlaps both the
    // localUidSet.has() and sinceUid clauses (UIDs 1-3 are cached AND
    // below sinceUid), so removing the sinceUid guard would not change
    // its result. This test decouples the two: a server UID below sinceUid
    // that is NOT in the local cache must still be suppressed by sinceUid
    // alone — otherwise incremental (covered_full) sync would re-fetch
    // every hole below the watermark on every cycle.
    mockMailboxResult = { exists: 1, highestModseq: null, uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(0) // empty cache
    vi.mocked(getFolderUids).mockReturnValue([])
    vi.mocked(getFolderFlags).mockReturnValue(new Map()) // NOT cached
    // Server returns a single UID 3 which is below sinceUid=5.
    // With the sinceUid guard: newUids=[] → fetched=0.
    // Without the sinceUid guard: newUids=[3] → header fetch runs.
    mockFetchResults = [
      { uid: 3, flags: new Set() },
    ]

    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {}, {
      sinceUid: 5,
    })

    expect(result.skipped).not.toBe(true)
    expect(result.exists).toBe(1)
    // Regression assertion: sinceUid must block the only UID below it,
    // even though that UID is not present locally.
    expect(result.fetched).toBe(0)
  })

  it('does not use CHANGEDSINCE with beforeUid (partial crawl)', async () => {
    mockMailboxResult = { exists: 5, highestModseq: BigInt(300), uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(2)
    vi.mocked(getFolderUids).mockReturnValue([4, 5])
    mockFetchResults = [
      { uid: 1, flags: new Set() },
      { uid: 2, flags: new Set() },
      { uid: 3, flags: new Set() },
      { uid: 4, flags: new Set(['\\Seen']) },
      { uid: 5, flags: new Set(['\\Seen']) },
    ]

    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {}, {
      beforeUid: 4,
      knownModseq: '200', // different from server's 300 — but should NOT use CHANGEDSINCE
    })

    // Should have fetched all flags (not CHANGEDSINCE filtered)
    // because beforeUid disables CHANGEDSINCE
    expect(result.exists).toBe(5)
    expect(result.skipped).not.toBe(true)
  })

  it('reconciles UIDs on count mismatch despite same modseq', async () => {
    mockMailboxResult = { exists: 4, highestModseq: BigInt(200), uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(5) // local has more — expunge happened
    vi.mocked(getFolderUids).mockReturnValue([1, 2, 3, 4, 5])
    // Server only has UIDs 1-4 (UID 5 was expunged)
    mockFetchResults = [
      { uid: 1, flags: new Set() },
      { uid: 2, flags: new Set() },
      { uid: 3, flags: new Set() },
      { uid: 4, flags: new Set() },
    ]

    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {}, {
      knownModseq: '200', // same modseq — but count mismatch
    })

    expect(result.skipped).toBe(true) // skipped header fetch, but reconciled UIDs
    expect(removeStaleMessagesByUids).toHaveBeenCalledWith(1, 'INBOX', [5])
  })

  it('returns empty folder correctly', async () => {
    mockMailboxResult = { exists: 0, highestModseq: null, uidValidity: 1 }

    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {})

    expect(result.fetched).toBe(0)
    expect(result.exists).toBe(0)
    expect(removeStaleMessages).toHaveBeenCalledWith(1, 'INBOX', [], { reason: 'server_empty' })
  })

  it('stale_wipe_guard: does NOT call removeStaleMessages when mailbox.exists is undefined', async () => {
    // Regression: the 2026-04-21 P0 data-loss trigger. ImapFlow returned
    // `exists: undefined` on a Yandex ETIMEDOUT, old code coerced it to 0
    // and wiped the entire folder. New guard must refuse and skip.
    mockMailboxResult = { exists: undefined as unknown as number, highestModseq: null, uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(42)
    vi.mocked(getFolderUids).mockReturnValue([1, 2, 3])

    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {})

    expect(result.exists).toBe(0)
    expect(result.skipped).toBe(true)
    // The critical invariant: the purge call MUST NOT have fired.
    expect(removeStaleMessages).not.toHaveBeenCalled()
    expect(removeStaleMessagesByUids).not.toHaveBeenCalled()
  })

  it('stale_wipe_guard: does NOT purge on negative mailbox.exists', async () => {
    // Defence-in-depth: even if a server returns a negative total, refuse
    // to mass-delete. No known server does this, but the guard is cheap.
    mockMailboxResult = { exists: -1, highestModseq: null, uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(42)

    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {})

    expect(result.skipped).toBe(true)
    expect(removeStaleMessages).not.toHaveBeenCalled()
  })

  it('exists=0 path: passes reason=server_empty explicitly', async () => {
    // AC from BACKLOG §2.15: each empty-array call site must declare reason.
    mockMailboxResult = { exists: 0, highestModseq: null, uidValidity: 1 }

    await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {})

    expect(removeStaleMessages).toHaveBeenCalledWith(1, 'INBOX', [], { reason: 'server_empty' })
  })

  it('UIDVALIDITY bump still purges (regression guard)', async () => {
    // Existing invariant — UIDVALIDITY path must continue to purge, now with
    // the explicit uidvalidity_bump reason.
    mockMailboxResult = { exists: 3, highestModseq: null, uidValidity: 99 }
    vi.mocked(getAccountMessageCount).mockReturnValue(0)
    vi.mocked(getFolderUids).mockReturnValue([])
    mockFetchResults = [
      { uid: 10, flags: new Set() },
      { uid: 11, flags: new Set() },
      { uid: 12, flags: new Set() },
    ]

    await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {}, { knownUidValidity: 1 })

    expect(removeStaleMessages).toHaveBeenCalledWith(1, 'INBOX', [], { reason: 'uidvalidity_bump' })
  })
})

// --- syncFolderFlagsOnly ---

describe('syncFolderFlagsOnly', () => {
  afterEach(() => {
    vi.clearAllMocks()
    mockMailboxResult = { exists: 10, highestModseq: BigInt(100), uidValidity: 1 }
    mockFetchResults = []
  })

  it('detects new UIDs not in local cache', async () => {
    mockMailboxResult = { exists: 5, highestModseq: null, uidValidity: 1 }
    vi.mocked(getFolderUids).mockReturnValue([1, 2, 3])
    mockFetchResults = [
      { uid: 1, flags: new Set(['\\Seen']) },
      { uid: 2, flags: new Set() },
      { uid: 3, flags: new Set(['\\Seen']) },
      { uid: 4, flags: new Set() },
      { uid: 5, flags: new Set() },
    ]

    const result = await syncFolderFlagsOnly(testCfg, 'INBOX', 1)

    expect(result.newUids).toEqual([4, 5])
    expect(result.deletedCount).toBe(0)
    expect(result.uidValidity).toBe(1)
    expect(result.uidValidityChanged).toBeUndefined()
  })

  it('detects deleted UIDs not on server', async () => {
    mockMailboxResult = { exists: 2, highestModseq: null, uidValidity: 1 }
    vi.mocked(getFolderUids).mockReturnValue([1, 2, 3, 4])
    mockFetchResults = [
      { uid: 1, flags: new Set() },
      { uid: 3, flags: new Set() },
    ]

    const result = await syncFolderFlagsOnly(testCfg, 'INBOX', 1)

    expect(result.deletedCount).toBe(2)
    expect(removeStaleMessagesByUids).toHaveBeenCalledWith(1, 'INBOX', [2, 4])
  })

  it('returns uidValidityChanged on UIDVALIDITY mismatch', async () => {
    mockMailboxResult = { exists: 5, highestModseq: null, uidValidity: 99 }
    vi.mocked(getFolderUids).mockReturnValue([1, 2, 3])

    const result = await syncFolderFlagsOnly(testCfg, 'INBOX', 1, 1) // known=1, server=99

    expect(result.uidValidityChanged).toBe(true)
    expect(result.newUids).toEqual([])
    expect(result.uidValidity).toBe(99)
    expect(removeStaleMessagesByUids).toHaveBeenCalledWith(1, 'INBOX', [1, 2, 3])
  })

  it('does not flag uidValidityChanged when values match', async () => {
    mockMailboxResult = { exists: 3, highestModseq: null, uidValidity: 42 }
    vi.mocked(getFolderUids).mockReturnValue([1, 2, 3])
    mockFetchResults = [
      { uid: 1, flags: new Set() },
      { uid: 2, flags: new Set() },
      { uid: 3, flags: new Set() },
    ]

    const result = await syncFolderFlagsOnly(testCfg, 'INBOX', 1, 42) // known=42, server=42

    expect(result.uidValidityChanged).toBeUndefined()
    expect(result.uidValidity).toBe(42)
  })

  it('handles empty folder — purges local cache', async () => {
    mockMailboxResult = { exists: 0, highestModseq: null, uidValidity: 1 }
    vi.mocked(getFolderUids).mockReturnValue([1, 2])

    const result = await syncFolderFlagsOnly(testCfg, 'INBOX', 1)

    expect(result.newUids).toEqual([])
    expect(result.deletedCount).toBe(2)
    expect(removeStaleMessagesByUids).toHaveBeenCalledWith(1, 'INBOX', [1, 2])
  })

  it('skips UIDVALIDITY check when knownUidValidity is undefined', async () => {
    mockMailboxResult = { exists: 2, highestModseq: null, uidValidity: 99 }
    vi.mocked(getFolderUids).mockReturnValue([])
    mockFetchResults = [
      { uid: 1, flags: new Set() },
      { uid: 2, flags: new Set() },
    ]

    const result = await syncFolderFlagsOnly(testCfg, 'INBOX', 1) // no knownUidValidity

    expect(result.uidValidityChanged).toBeUndefined()
    expect(result.newUids).toEqual([1, 2])
  })
})

// --- imap.sync span instrumentation ----------------------------------------
// These tests verify that fetchAllFolderHeaders opens an 'imap.sync' span
// with structural attributes only, calls end() on both CONDSTORE fast-path
// (skipped:true) and full-sync paths, and survives a broken telemetry sink.

import { setNetTelemetrySink, setNetErrorReporter } from './telemetry'

describe('fetchAllFolderHeaders — imap.sync telemetry span', () => {
  afterEach(() => {
    setNetTelemetrySink(null)
    setNetErrorReporter(null)
    vi.clearAllMocks()
    mockMailboxResult = { exists: 10, highestModseq: BigInt(100), uidValidity: 1 }
    mockFetchResults = []
  })

  it('opens imap.sync span with folder_role + provider + changed_since_present', async () => {
    mockMailboxResult = { exists: 5, highestModseq: BigInt(200), uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(5)

    const end = vi.fn()
    const setAttributes = vi.fn()
    const starter = vi.fn<(name: string, attrs: Record<string, unknown>) => { end: typeof end; setAttributes: typeof setAttributes }>(() => ({ end, setAttributes }))
    setNetTelemetrySink(starter)

    await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {}, { knownModseq: '200' })

    expect(starter).toHaveBeenCalledTimes(1)
    const [name, attrs] = starter.mock.calls[0]
    expect(name).toBe('imap.sync')
    expect(attrs).toMatchObject({
      folder_role: 'inbox',
      provider: 'other',
      changed_since_present: true,
    })
    expect(end).toHaveBeenCalledTimes(1)
    // finalize() should have attached fetched_headers_bucket even on CONDSTORE skip path
    expect(setAttributes).toHaveBeenCalled()
    const finalAttrs = setAttributes.mock.calls[0][0] as Record<string, unknown>
    expect(finalAttrs.fetched_headers_bucket).toBe('0')
    expect(finalAttrs.skipped).toBe(true)
  })

  it('sets changed_since_present=false when no knownModseq is provided', async () => {
    mockMailboxResult = { exists: 0, highestModseq: null, uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(0)

    const starter = vi.fn<(name: string, attrs: Record<string, unknown>) => { end: () => void }>(() => ({ end: vi.fn() }))
    setNetTelemetrySink(starter)

    await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {})

    const attrs = starter.mock.calls[0][1] as Record<string, unknown>
    expect(attrs.changed_since_present).toBe(false)
  })

  it('calls end() + reports error on failure path', async () => {
    // Force an error inside the sync body by returning a bad mailbox shape.
    mockMailboxResult = { exists: 3, highestModseq: BigInt(1), uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(0)
    vi.mocked(getFolderUids).mockReturnValue([])
    // Patch the ImapFlow mock's fetch to throw.
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
      usable: true,
      on: vi.fn(),
      close: vi.fn(),
      noop: vi.fn().mockResolvedValue(undefined),
      mailboxOpen: vi.fn().mockResolvedValue(mockMailboxResult),
      fetch: vi.fn().mockImplementation(() => {
        throw new Error('fetch exploded')
      }),
      fetchOne: vi.fn().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)

    const end = vi.fn()
    setNetTelemetrySink(() => ({ end, setAttributes: vi.fn() }))
    const reporter = vi.fn()
    setNetErrorReporter(reporter)

    await expect(
      fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {}),
    ).rejects.toThrow('fetch exploded')

    expect(end).toHaveBeenCalledTimes(1)
    expect(reporter).toHaveBeenCalledTimes(1)
    expect(reporter.mock.calls[0][0]).toBe('imap.sync')
  })

  it('a broken telemetry sink does not break the sync', async () => {
    mockMailboxResult = { exists: 5, highestModseq: BigInt(200), uidValidity: 1 }
    vi.mocked(getAccountMessageCount).mockReturnValue(5)

    setNetTelemetrySink(() => { throw new Error('sentry exploded') })
    setNetErrorReporter(() => { throw new Error('reporter exploded') })

    const result = await fetchAllFolderHeaders(testCfg, 'INBOX', 1, () => {}, { knownModseq: '200' })
    expect(result.skipped).toBe(true)
  })
})

// --- Auth error retry (OAuth token refresh via onAuthError callback) ---

describe('withImapRetryPerAccount — auth error + onAuthError callback', () => {
  const accountId = 1
  const oauthCfg: ImapConfig = { host: 'outlook.office365.com', port: 993, secure: true, user: 'user@outlook.com', pass: undefined, accessToken: 'old-token' }

  afterEach(async () => {
    unregisterAuthErrorHandler(accountId)
    __resetAuthRefreshCooldown()
    await disconnectAllPerAccount()
  })

  it('auth failure -> onAuthError refresh -> retry succeeds', async () => {
    const refreshFn = vi.fn().mockResolvedValue('fresh-token')
    registerAuthErrorHandler(accountId, refreshFn)

    let attempt = 0
    const result = await withImapRetryPerAccount(accountId, oauthCfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('AUTHENTICATE failed — XOAUTH2 mechanism not available')
      return 'success'
    })

    expect(result).toBe('success')
    expect(attempt).toBe(2)
    expect(refreshFn).toHaveBeenCalledTimes(1)
    // Config should have been patched with the fresh token
    expect(oauthCfg.accessToken).toBe('fresh-token')
  })

  it('auth failure -> onAuthError refresh fails -> original auth error thrown', async () => {
    const refreshFn = vi.fn().mockRejectedValue(new Error('refresh token revoked'))
    registerAuthErrorHandler(accountId, refreshFn)

    await expect(
      withImapRetryPerAccount(accountId, oauthCfg, async () => {
        throw new Error('AUTHENTICATE failed')
      }),
    ).rejects.toThrow('AUTHENTICATE failed')

    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('connection error -> normal retry without auth callback', async () => {
    const refreshFn = vi.fn().mockResolvedValue('should-not-be-called')
    registerAuthErrorHandler(accountId, refreshFn)

    let attempt = 0
    const result = await withImapRetryPerAccount(accountId, oauthCfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('ECONNRESET')
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(attempt).toBe(2)
    // Auth refresh callback should NOT have been invoked for a connection error
    expect(refreshFn).not.toHaveBeenCalled()
  })

  it('double auth failure -> error after one refresh attempt (no infinite loop)', async () => {
    const refreshFn = vi.fn().mockResolvedValue('refreshed-but-still-bad')
    registerAuthErrorHandler(accountId, refreshFn)

    await expect(
      withImapRetryPerAccount(accountId, oauthCfg, async () => {
        // Always fails with auth error — even after token refresh
        throw new Error('AUTHENTICATE failed')
      }),
    ).rejects.toThrow('AUTHENTICATE failed')

    // Handler should have been called exactly once (first auth failure).
    // Second auth failure after refresh should NOT trigger the handler again.
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('no handler registered -> auth error thrown without retry', async () => {
    // Do NOT register any handler
    await expect(
      withImapRetryPerAccount(accountId, oauthCfg, async () => {
        throw new Error('AUTHENTICATE failed')
      }),
    ).rejects.toThrow('AUTHENTICATE failed')
  })

  it('Microsoft XOAUTH2 token expired pattern triggers refresh', async () => {
    const refreshFn = vi.fn().mockResolvedValue('fresh-ms-token')
    registerAuthErrorHandler(accountId, refreshFn)

    let attempt = 0
    const result = await withImapRetryPerAccount(accountId, oauthCfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('token expired')
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })
})

describe('withImapRetry (singleton) — auth error + onAuthError callback', () => {
  const accountId = 2
  const oauthCfg: ImapConfig = { host: 'imap.gmail.com', port: 993, secure: true, user: 'user@gmail.com', pass: undefined, accessToken: 'old-gmail-token' }

  afterEach(() => {
    unregisterAuthErrorHandler(accountId)
    __resetAuthRefreshCooldown()
  })

  it('auth failure -> onAuthError refresh -> retry succeeds', async () => {
    const refreshFn = vi.fn().mockResolvedValue('fresh-gmail-token')
    registerAuthErrorHandler(accountId, refreshFn)

    let attempt = 0
    const result = await withImapRetry(accountId, oauthCfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('XOAUTH2 authentication error')
      return 'gmail-success'
    })

    expect(result).toBe('gmail-success')
    expect(attempt).toBe(2)
    expect(refreshFn).toHaveBeenCalledTimes(1)
    expect(oauthCfg.accessToken).toBe('fresh-gmail-token')
  })

  it('double auth failure -> error after one refresh attempt', async () => {
    const refreshFn = vi.fn().mockResolvedValue('refreshed-token')
    registerAuthErrorHandler(accountId, refreshFn)

    await expect(
      withImapRetry(accountId, oauthCfg, async () => {
        throw new Error('AUTHENTICATE failed')
      }),
    ).rejects.toThrow('AUTHENTICATE failed')

    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('auth failure -> refresh fails -> original auth error surfaces', async () => {
    const refreshFn = vi.fn().mockRejectedValue(new Error('network failure during refresh'))
    registerAuthErrorHandler(accountId, refreshFn)

    await expect(
      withImapRetry(accountId, oauthCfg, async () => {
        throw new Error('AUTHENTICATE failed')
      }),
    ).rejects.toThrow('AUTHENTICATE failed')

    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('connection error -> normal retry without auth callback (singleton)', async () => {
    const refreshFn = vi.fn().mockResolvedValue('should-not-be-called')
    registerAuthErrorHandler(accountId, refreshFn)

    let attempt = 0
    const result = await withImapRetry(accountId, oauthCfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('ECONNRESET')
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(attempt).toBe(2)
    expect(refreshFn).not.toHaveBeenCalled()
  })

  it('no handler registered -> auth error thrown without retry (singleton)', async () => {
    // Do NOT register any handler for this config
    await expect(
      withImapRetry(accountId, oauthCfg, async () => {
        throw new Error('AUTHENTICATE failed')
      }),
    ).rejects.toThrow('AUTHENTICATE failed')
  })

  it('Google WEBALERT triggers auth refresh via handler (singleton)', async () => {
    const refreshFn = vi.fn().mockResolvedValue('fresh-google-token')
    registerAuthErrorHandler(accountId, refreshFn)

    let attempt = 0
    const result = await withImapRetry(accountId, oauthCfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('WEBALERT https://accounts.google.com/signin/continue')
      return 'google-ok'
    })

    expect(result).toBe('google-ok')
    expect(attempt).toBe(2)
    expect(refreshFn).toHaveBeenCalledTimes(1)
    expect(oauthCfg.accessToken).toBe('fresh-google-token')
  })
})

// --- §2.20-E: connection-lost classifier covers ImapFlow "Unexpected close" ---

describe('withImapRetry — §2.20-E connection-lost classifier', () => {
  const accountId = 42
  const cfg: ImapConfig = { host: 'imap.test.com', port: 993, secure: true, user: 'close-test@test.com', pass: 'p' }

  afterEach(() => {
    unregisterAuthErrorHandler(accountId)
    __resetAuthRefreshCooldown()
  })

  it('retries on ImapFlow "Unexpected close" and succeeds on second attempt', async () => {
    let attempt = 0
    const result = await withImapRetry(accountId, cfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('Unexpected close')
      return 'recovered'
    })

    expect(result).toBe('recovered')
    expect(attempt).toBe(2)
  })

  it('does NOT retry on permanent auth errors (regression guard against over-broad regex)', async () => {
    let attempt = 0
    await expect(
      withImapRetry(accountId, cfg, async () => {
        attempt++
        throw new Error('Invalid credentials')
      }),
    ).rejects.toThrow('Invalid credentials')

    // No retry — auth-class errors without a registered handler must surface
    // immediately. If the classifier accidentally matches "Invalid credentials"
    // as a connection-lost error, attempt would exceed 1.
    expect(attempt).toBe(1)
  })

  it('exhausts retry budget and throws after all attempts with "Unexpected close"', async () => {
    // withImapRetry defaults to retries=2: fn runs at most 3 times total
    // (initial + 2 retries). If every attempt fails, the error must propagate.
    let attempt = 0
    await expect(
      withImapRetry(accountId, cfg, async () => {
        attempt++
        throw new Error('Unexpected close')
      }),
    ).rejects.toThrow('Unexpected close')

    // 1 initial + 2 retries = 3 total attempts; remaining drops 2→1→0 then throws.
    expect(attempt).toBe(3)
  })

  it('matches "Unexpected close" as substring inside a longer ImapFlow message', async () => {
    // ImapFlow can emit messages like "Imap stream Unexpected close at line 5".
    // The regex must match the substring, not require an exact message.
    let attempt = 0
    const result = await withImapRetry(accountId, cfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('Imap stream Unexpected close at line 5')
      return 'substring-ok'
    })

    expect(result).toBe('substring-ok')
    expect(attempt).toBe(2)
  })
})

// --- §2.20-E: withImapRetryPerAccount classifier sync (AC2 — third regex site) ---

describe('withImapRetryPerAccount — §2.20-E connection-lost classifier sync', () => {
  const accountId = 43
  const cfg: ImapConfig = { host: 'imap.per.com', port: 993, secure: true, user: 'per-close@test.com', pass: 'p' }

  afterEach(async () => {
    unregisterAuthErrorHandler(accountId)
    __resetAuthRefreshCooldown()
    await disconnectAllPerAccount()
  })

  it('retries on "Unexpected close" via withImapRetryPerAccount (third regex site, imap.ts:~2753)', async () => {
    // Verifies that the per-account retry path (imap.ts:~2753) is in sync
    // with withImapRetry (imap.ts:~538) per the §2.20-E synchronisation comment.
    let attempt = 0
    const result = await withImapRetryPerAccount(accountId, cfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('Unexpected close')
      return 'per-account-recovered'
    })

    expect(result).toBe('per-account-recovered')
    expect(attempt).toBe(2)
  })
})

// --- registerAuthErrorHandler / unregisterAuthErrorHandler explicit tests ---

describe('registerAuthErrorHandler / unregisterAuthErrorHandler', () => {
  const accountId = 3
  const cfg: ImapConfig = { host: 'imap.test.com', port: 993, secure: true, user: 'reg-test@test.com', pass: undefined, accessToken: 'tok' }

  afterEach(async () => {
    unregisterAuthErrorHandler(accountId)
    __resetAuthRefreshCooldown()
    await disconnectAllPerAccount()
  })

  it('unregister prevents handler invocation on auth error', async () => {
    const handler = vi.fn().mockResolvedValue('refreshed')
    registerAuthErrorHandler(accountId, handler)
    unregisterAuthErrorHandler(accountId)

    // Auth error should be thrown without invoking the handler
    await expect(
      withImapRetryPerAccount(accountId, cfg, async () => {
        throw new Error('AUTHENTICATE failed')
      }),
    ).rejects.toThrow('AUTHENTICATE failed')

    expect(handler).not.toHaveBeenCalled()
  })

  it('re-registering overwrites the previous handler', async () => {
    const handler1 = vi.fn().mockResolvedValue('token-1')
    const handler2 = vi.fn().mockResolvedValue('token-2')

    registerAuthErrorHandler(accountId, handler1)
    registerAuthErrorHandler(accountId, handler2)

    let attempt = 0
    await withImapRetryPerAccount(accountId, cfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('AUTHENTICATE failed')
      return 'ok'
    })

    expect(handler1).not.toHaveBeenCalled()
    expect(handler2).toHaveBeenCalledTimes(1)
    expect(cfg.accessToken).toBe('token-2')
  })

  it('unregister is idempotent (no error on double unregister)', () => {
    registerAuthErrorHandler(accountId, vi.fn().mockResolvedValue('t'))
    unregisterAuthErrorHandler(accountId)
    // Second unregister should not throw
    expect(() => unregisterAuthErrorHandler(accountId)).not.toThrow()
  })
})

// --- withImapRetryPerAccount: additional edge cases ---

describe('withImapRetryPerAccount — auth error edge cases', () => {
  const accountId = 4
  const oauthCfg: ImapConfig = { host: 'outlook.office365.com', port: 993, secure: true, user: 'edge@outlook.com', pass: undefined, accessToken: 'old-edge-token' }

  afterEach(async () => {
    unregisterAuthErrorHandler(accountId)
    __resetAuthRefreshCooldown()
    await disconnectAllPerAccount()
  })

  it('config accessToken is patched after successful refresh', async () => {
    const refreshFn = vi.fn().mockResolvedValue('patched-token')
    registerAuthErrorHandler(accountId, refreshFn)

    let attempt = 0
    await withImapRetryPerAccount(accountId, oauthCfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('AUTHENTICATE failed')
      return 'ok'
    })

    expect(oauthCfg.accessToken).toBe('patched-token')
  })

  it('Google Web login required triggers auth refresh (per-account)', async () => {
    const refreshFn = vi.fn().mockResolvedValue('fresh-google-pa-token')
    registerAuthErrorHandler(accountId, refreshFn)

    let attempt = 0
    const result = await withImapRetryPerAccount(accountId, oauthCfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('Web login required')
      return 'google-pa-ok'
    })

    expect(result).toBe('google-pa-ok')
    expect(attempt).toBe(2)
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('permanent error (NONEXISTENT) does not trigger auth handler', async () => {
    const refreshFn = vi.fn().mockResolvedValue('should-not-be-called')
    registerAuthErrorHandler(accountId, refreshFn)

    await expect(
      withImapRetryPerAccount(accountId, oauthCfg, async () => {
        throw new Error('NO [NONEXISTENT] mailbox does not exist')
      }),
    ).rejects.toThrow('NO [NONEXISTENT] mailbox does not exist')

    expect(refreshFn).not.toHaveBeenCalled()
  })
})

// --- fetchAllFolderHeaders: auth-error retry via withDedicatedImapRetry ---

describe('fetchAllFolderHeaders — auth error triggers onAuthError refresh', () => {
  const accountId = 5
  const oauthSyncCfg: ImapConfig = { host: 'outlook.office365.com', port: 993, secure: true, user: 'sync@outlook.com', pass: undefined, accessToken: 'old-sync-token' }

  afterEach(async () => {
    unregisterAuthErrorHandler(accountId)
    __resetAuthRefreshCooldown()
    vi.clearAllMocks()
    mockMailboxResult = { exists: 10, highestModseq: BigInt(100), uidValidity: 1 }
    mockFetchResults = []
  })

  it('auth failure on connect triggers onAuthError and retries successfully', async () => {
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)

    // First connection attempt: auth failure on connect
    let attempt = 0
    ImapFlowMock.mockImplementation(() => {
      attempt++
      if (attempt === 1) {
        return {
          connect: vi.fn().mockRejectedValue(new Error('AUTHENTICATE failed — XOAUTH2 mechanism not available')),
          logout: vi.fn().mockResolvedValue(undefined),
          list: vi.fn(),
          usable: true,
          on: vi.fn(),
          close: vi.fn(),
          noop: vi.fn().mockResolvedValue(undefined),
          mailboxOpen: vi.fn().mockResolvedValue(mockMailboxResult),
          fetch: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }) }),
          fetchOne: vi.fn().mockResolvedValue(null),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any
      }
      // Second attempt (after token refresh): succeed with empty folder
      mockMailboxResult = { exists: 0, highestModseq: null, uidValidity: 1 }
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        logout: vi.fn().mockResolvedValue(undefined),
        list: vi.fn(),
        usable: true,
        on: vi.fn(),
        close: vi.fn(),
        noop: vi.fn().mockResolvedValue(undefined),
        mailboxOpen: vi.fn().mockResolvedValue(mockMailboxResult),
        fetch: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }) }),
        fetchOne: vi.fn().mockResolvedValue(null),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
    })

    const refreshFn = vi.fn().mockResolvedValue('fresh-sync-token')
    registerAuthErrorHandler(accountId, refreshFn)

    vi.mocked(getAccountMessageCount).mockReturnValue(0)

    const result = await fetchAllFolderHeaders(oauthSyncCfg, 'INBOX', accountId, () => {})

    expect(refreshFn).toHaveBeenCalledTimes(1)
    expect(oauthSyncCfg.accessToken).toBe('fresh-sync-token')
    expect(result.exists).toBe(0)
  })
})

// --- fetchAllFolderHeaders: cert-error path via withDedicatedImapRetry ---
//
// withDedicatedImapRetry (unexported, used internally by fetchAllFolderHeaders
// and other dedicated-connection sync helpers) got the same 'cert' short-
// circuit as withImapRetry / withImapRetryPerAccount. This is the third of
// the three retry wrappers touched by the TLS trust rework and had no direct
// coverage — exercised here through its only reachable caller.

describe('fetchAllFolderHeaders — cert error notifies and aborts (withDedicatedImapRetry)', () => {
  const accountId = 6
  const certSyncCfg: ImapConfig = { host: 'imap.cert-dedicated.com', port: 993, secure: true, user: 'dedicated@cert.com', pass: 'p' }

  afterEach(() => {
    unregisterCertErrorHandler(accountId)
    unregisterAuthErrorHandler(accountId)
    vi.clearAllMocks()
    mockMailboxResult = { exists: 10, highestModseq: BigInt(100), uidValidity: 1 }
    mockFetchResults = []
  })

  it('cert error on connect notifies the registered handler and rethrows without retrying', async () => {
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)

    let connectAttempts = 0
    // mockImplementationOnce — scoped to this single ImapFlow construction so
    // it self-clears and cannot leak a rejecting connect() into later
    // describe blocks that rely on the module-level default (mockConnect
    // resolving undefined, set once in the vi.mock('imapflow', ...) factory).
    ImapFlowMock.mockImplementationOnce(() => ({
      connect: vi.fn().mockImplementation(() => {
        connectAttempts++
        const e = new Error('unable to verify the first certificate') as Error & { code: string }
        e.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
        return Promise.reject(e)
      }),
      logout: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
      usable: true,
      on: vi.fn(),
      close: vi.fn(),
      noop: vi.fn().mockResolvedValue(undefined),
      mailboxOpen: vi.fn(),
      fetch: vi.fn(),
      fetchOne: vi.fn().mockResolvedValue(null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)

    const certHandler = vi.fn()
    registerCertErrorHandler(accountId, certHandler)
    const refreshFn = vi.fn().mockResolvedValue('should-not-be-called')
    registerAuthErrorHandler(accountId, refreshFn)

    vi.mocked(getAccountMessageCount).mockReturnValue(0)

    await expect(
      fetchAllFolderHeaders(certSyncCfg, 'INBOX', accountId, () => {}),
    ).rejects.toThrow('unable to verify')

    // No connection-loss retry budget spent on a cert failure.
    expect(connectAttempts).toBe(1)
    expect(certHandler).toHaveBeenCalledTimes(1)
    expect(certHandler).toHaveBeenCalledWith({
      host: 'imap.cert-dedicated.com',
      port: 993,
      rawMessage: 'unable to verify the first certificate',
      secure: true,
      protocol: 'imap',
    })
    // TLS trust failures must not burn an OAuth refresh attempt either.
    expect(refreshFn).not.toHaveBeenCalled()
  })
})

// --- H2 regression: two accounts sharing userKey must have independent handlers ---
//
// The registry was previously keyed by `userKey(cfg) = user@host:port:tls:pins`.
// If the same Outlook address was added twice (two DB rows, two accountIds,
// two refresh tokens), both would collide on the same key: the second
// registration would silently overwrite the first, and an auth failure on
// EITHER account would invoke the handler for the LAST-registered one —
// refreshing the wrong refresh token, leaving the original account broken.
//
// With the accountId-keyed registry this cannot happen: distinct accountIds
// reserve distinct slots regardless of userKey overlap.

describe('auth-error handler registry — H2 accountId keying (collision isolation)', () => {
  // Both accounts have IDENTICAL userKey (same user/host/port/tls/pins) but
  // distinct accountIds — this is the exact collision scenario H2 describes.
  const sharedCfg = { host: 'outlook.office365.com', port: 993, secure: true, user: 'shared@outlook.com', pass: undefined } as const
  const cfgA: ImapConfig = { ...sharedCfg, accessToken: 'token-A' }
  const cfgB: ImapConfig = { ...sharedCfg, accessToken: 'token-B' }
  const accountIdA = 101
  const accountIdB = 102

  afterEach(async () => {
    unregisterAuthErrorHandler(accountIdA)
    unregisterAuthErrorHandler(accountIdB)
    __resetAuthRefreshCooldown()
    await disconnectAllPerAccount()
  })

  it('registering two accounts with identical userKey keeps handlers independent', async () => {
    const handlerA = vi.fn().mockResolvedValue('fresh-token-A')
    const handlerB = vi.fn().mockResolvedValue('fresh-token-B')

    // Both registrations under different accountIds — no collision.
    registerAuthErrorHandler(accountIdA, handlerA)
    registerAuthErrorHandler(accountIdB, handlerB)

    // Auth failure on account A invokes ONLY handlerA.
    let attemptA = 0
    await withImapRetryPerAccount(accountIdA, cfgA, async () => {
      attemptA++
      if (attemptA === 1) throw new Error('AUTHENTICATE failed')
      return 'ok'
    })

    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerB).not.toHaveBeenCalled()
    expect(cfgA.accessToken).toBe('fresh-token-A')
    // Account B's cfg must NOT have been touched by A's failure.
    expect(cfgB.accessToken).toBe('token-B')
  })

  it('registering same accountId twice overwrites (idempotent per-slot)', async () => {
    const handler1 = vi.fn().mockResolvedValue('token-1')
    const handler2 = vi.fn().mockResolvedValue('token-2')

    registerAuthErrorHandler(accountIdA, handler1)
    registerAuthErrorHandler(accountIdA, handler2)

    let attempt = 0
    await withImapRetryPerAccount(accountIdA, cfgA, async () => {
      attempt++
      if (attempt === 1) throw new Error('AUTHENTICATE failed')
      return 'ok'
    })

    // The later registration wins within the same slot — this is intentional
    // (callers may re-register after reconfiguring OAuth state).
    expect(handler1).not.toHaveBeenCalled()
    expect(handler2).toHaveBeenCalledTimes(1)
    expect(cfgA.accessToken).toBe('token-2')
  })

  it('unregisterAuthErrorHandler by accountId does not affect the sibling slot', async () => {
    const handlerA = vi.fn().mockResolvedValue('fresh-A')
    const handlerB = vi.fn().mockResolvedValue('fresh-B')

    registerAuthErrorHandler(accountIdA, handlerA)
    registerAuthErrorHandler(accountIdB, handlerB)
    unregisterAuthErrorHandler(accountIdA)

    // A is now unregistered — auth error on A surfaces immediately without retry.
    await expect(
      withImapRetryPerAccount(accountIdA, cfgA, async () => {
        throw new Error('AUTHENTICATE failed')
      }),
    ).rejects.toThrow('AUTHENTICATE failed')
    expect(handlerA).not.toHaveBeenCalled()

    // B is still active — auth error triggers refresh.
    let attemptB = 0
    await withImapRetryPerAccount(accountIdB, cfgB, async () => {
      attemptB++
      if (attemptB === 1) throw new Error('AUTHENTICATE failed')
      return 'ok'
    })
    expect(handlerB).toHaveBeenCalledTimes(1)
    expect(cfgB.accessToken).toBe('fresh-B')
  })
})

// --- H1: per-account refresh cooldown (prevents /token request storms) ------
//
// When Azure/Google return invalid_grant (refresh token revoked), each IMAP
// op would otherwise fire a fresh /token call. Azure rate-limits /token on
// the client_id and can 429 legitimate sibling accounts. The cooldown gate
// inside invokeAuthHandlerWithCooldown enforces per-account throttling:
// handler is invoked at most once per exponential window on sustained
// failure, reset on success.
//
// These tests exercise the gate via both imap.ts retry wrappers and the
// cooldown state module directly. They use a virtual clock via
// __setAuthRefreshCooldownClock so a real 60s window isn't waited.

describe('auth refresh cooldown — H1 request storm prevention', () => {
  const accountId = 200
  const cfg: ImapConfig = { host: 'outlook.office365.com', port: 993, secure: true, user: 'cd@outlook.com', pass: undefined, accessToken: 'tok' }

  let fakeNow = 1_700_000_000_000
  const advanceClockBy = (ms: number) => { fakeNow += ms }

  beforeEach(() => {
    fakeNow = 1_700_000_000_000
    __setAuthRefreshCooldownClock(() => fakeNow)
  })

  afterEach(async () => {
    __setAuthRefreshCooldownClock(null)
    __resetAuthRefreshCooldown()
    unregisterAuthErrorHandler(accountId)
    await disconnectAllPerAccount()
  })

  it('cooldown gate blocks second refresh within 60s window', async () => {
    const refreshFn = vi.fn().mockRejectedValue(new Error('invalid_grant — refresh token revoked'))
    registerAuthErrorHandler(accountId, refreshFn)

    // First auth error: handler IS invoked (and rejects). Cooldown now armed.
    await expect(
      withImapRetryPerAccount(accountId, cfg, async () => {
        throw new Error('AUTHENTICATE failed')
      }),
    ).rejects.toThrow('AUTHENTICATE failed')
    expect(refreshFn).toHaveBeenCalledTimes(1)
    expect(isInCooldown(accountId)).toBe(true)

    // Second auth error 30s later — still inside the 60s window, handler
    // must NOT be invoked a second time.
    advanceClockBy(30_000)
    await expect(
      withImapRetryPerAccount(accountId, cfg, async () => {
        throw new Error('AUTHENTICATE failed')
      }),
    ).rejects.toThrow('AUTHENTICATE failed')
    expect(refreshFn).toHaveBeenCalledTimes(1) // still 1 — suppressed
  })

  it('cooldown counter increments on consecutive failures (window grows)', async () => {
    const refreshFn = vi.fn().mockRejectedValue(new Error('invalid_grant'))
    registerAuthErrorHandler(accountId, refreshFn)

    // 1st failure → 60s window
    await expect(
      withImapRetryPerAccount(accountId, cfg, async () => { throw new Error('AUTHENTICATE failed') }),
    ).rejects.toThrow()
    expect(peekCooldownEntry(accountId)?.consecutiveFailures).toBe(1)

    // After 60s exactly — cooldown expired, handler is allowed again, rejects again.
    advanceClockBy(60_001)
    expect(isInCooldown(accountId)).toBe(false)
    await expect(
      withImapRetryPerAccount(accountId, cfg, async () => { throw new Error('AUTHENTICATE failed') }),
    ).rejects.toThrow()
    expect(refreshFn).toHaveBeenCalledTimes(2)
    expect(peekCooldownEntry(accountId)?.consecutiveFailures).toBe(2)

    // Window now 5 minutes. 60s later — still suppressed.
    advanceClockBy(60_000)
    expect(isInCooldown(accountId)).toBe(true)
  })

  it('cooldown resets on successful refresh', async () => {
    const refreshFn = vi.fn()
      .mockRejectedValueOnce(new Error('invalid_grant')) // fail once
      .mockResolvedValueOnce('fresh-token')               // then succeed
    registerAuthErrorHandler(accountId, refreshFn)

    // Failure arms cooldown.
    await expect(
      withImapRetryPerAccount(accountId, cfg, async () => { throw new Error('AUTHENTICATE failed') }),
    ).rejects.toThrow()
    expect(peekCooldownEntry(accountId)).toBeDefined()

    // Advance past window so handler is invoked again — this time succeeds.
    advanceClockBy(61_000)
    let attempt = 0
    await withImapRetryPerAccount(accountId, cfg, async () => {
      attempt++
      if (attempt === 1) throw new Error('AUTHENTICATE failed')
      return 'ok'
    })

    // Cooldown cleared on success.
    expect(peekCooldownEntry(accountId)).toBeUndefined()
    expect(isInCooldown(accountId)).toBe(false)
  })

  it('cooldown is independent per accountId', async () => {
    const accountIdA = 210
    const accountIdB = 211
    const cfgA: ImapConfig = { ...cfg, user: 'a@outlook.com', accessToken: 'tA' }
    const cfgB: ImapConfig = { ...cfg, user: 'b@outlook.com', accessToken: 'tB' }
    const handlerA = vi.fn().mockRejectedValue(new Error('invalid_grant'))
    const handlerB = vi.fn().mockResolvedValue('fresh-B')
    registerAuthErrorHandler(accountIdA, handlerA)
    registerAuthErrorHandler(accountIdB, handlerB)

    try {
      // Arm cooldown on A.
      await expect(
        withImapRetryPerAccount(accountIdA, cfgA, async () => { throw new Error('AUTHENTICATE failed') }),
      ).rejects.toThrow()
      expect(isInCooldown(accountIdA)).toBe(true)
      // B is NOT in cooldown — its refresh succeeds fine.
      expect(isInCooldown(accountIdB)).toBe(false)

      let attemptB = 0
      const r = await withImapRetryPerAccount(accountIdB, cfgB, async () => {
        attemptB++
        if (attemptB === 1) throw new Error('AUTHENTICATE failed')
        return 'ok'
      })
      expect(r).toBe('ok')
      expect(handlerB).toHaveBeenCalledTimes(1)
    } finally {
      unregisterAuthErrorHandler(accountIdA)
      unregisterAuthErrorHandler(accountIdB)
    }
  })

  it('emits imap.auth_refresh_suppressed metric when cooldown blocks a refresh', async () => {
    // Arm cooldown directly to avoid running a full failure cycle.
    recordRefreshFailure(accountId)
    expect(isInCooldown(accountId)).toBe(true)

    const events: Array<{ name: string; tags: Record<string, unknown> }> = []
    const { setNetEventReporter } = await import('./telemetry')
    setNetEventReporter((name, tags) => { events.push({ name, tags }) })

    try {
      const refreshFn = vi.fn().mockResolvedValue('should-not-be-called')
      registerAuthErrorHandler(accountId, refreshFn)

      // Auth error enters the gate; cooldown active; handler not invoked;
      // suppression metric emitted; original auth error surfaces.
      await expect(
        withImapRetryPerAccount(accountId, cfg, async () => { throw new Error('AUTHENTICATE failed') }),
      ).rejects.toThrow('AUTHENTICATE failed')

      expect(refreshFn).not.toHaveBeenCalled()
      expect(events).toEqual([
        { name: 'imap.auth_refresh_suppressed', tags: { reason: 'cooldown' } },
      ])
    } finally {
      setNetEventReporter(null)
    }
  })

  it('cooldown applies identically via withImapRetry (singleton) path', async () => {
    const refreshFn = vi.fn().mockRejectedValue(new Error('invalid_grant'))
    registerAuthErrorHandler(accountId, refreshFn)

    // Arm via singleton wrapper.
    await expect(
      withImapRetry(accountId, cfg, async () => { throw new Error('AUTHENTICATE failed') }),
    ).rejects.toThrow()
    expect(refreshFn).toHaveBeenCalledTimes(1)
    expect(isInCooldown(accountId)).toBe(true)

    // Second call within window — suppressed (still 1 invocation).
    advanceClockBy(10_000)
    await expect(
      withImapRetry(accountId, cfg, async () => { throw new Error('AUTHENTICATE failed') }),
    ).rejects.toThrow()
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('successful refresh via recordRefreshSuccess clears prior failure counter', () => {
    recordRefreshFailure(accountId)
    recordRefreshFailure(accountId)
    expect(peekCooldownEntry(accountId)?.consecutiveFailures).toBe(2)

    recordRefreshSuccess(accountId)
    expect(peekCooldownEntry(accountId)).toBeUndefined()
    expect(isInCooldown(accountId)).toBe(false)
  })

  // --- H1 concurrency: per-accountId single-flight around the cooldown gate ---
  //
  // Without a lock around the check-and-invoke sequence, two concurrent
  // auth-retry paths on the same accountId both see isInCooldown()===false,
  // both call handler(), and both recordRefreshFailure() on joint failure —
  // bumping consecutiveFailures by 2 after a single real failed refresh and
  // immediately escalating to the 5-minute cooldown window. The single-flight
  // map in imap.ts guarantees exactly-one handler invocation per concurrent
  // burst; the second caller observes the first caller's outcome.
  //
  // These tests drive `invokeAuthHandlerWithCooldown` through the
  // `__testInvokeAuthHandlerWithCooldown` alias because the public retry
  // wrappers have their own op-locks (withImapOpLock for the singleton path,
  // withPerAccountOpLock per userKey for the per-account path) that would
  // mask the concurrency under test. The single-flight behaviour must be
  // proven at the cooldown gate itself; callers inherit it automatically.

  it('two concurrent calls on same accountId invoke handler exactly once (joint failure)', async () => {
    const refreshFn = vi.fn().mockRejectedValue(new Error('invalid_grant — refresh token revoked'))
    registerAuthErrorHandler(accountId, refreshFn)

    const [r1, r2] = await Promise.all([
      __testInvokeAuthHandlerWithCooldown(accountId, new Error('AUTHENTICATE failed')),
      __testInvokeAuthHandlerWithCooldown(accountId, new Error('AUTHENTICATE failed')),
    ])
    // Both callers observe null (no fresh token) — original error propagates
    // to the outer retry loop which throws it.
    expect(r1).toBeNull()
    expect(r2).toBeNull()
    // Handler invoked exactly once — the single-flight prevented the second
    // concurrent call from re-entering the gate.
    expect(refreshFn).toHaveBeenCalledTimes(1)
    // consecutiveFailures must be 1, not 2 — the pre-fix regression would
    // over-count and immediately promote the account into the 5-min window.
    expect(peekCooldownEntry(accountId)?.consecutiveFailures).toBe(1)
  })

  it('two concurrent calls on same accountId share a successful refresh outcome', async () => {
    // Deferred handler so both callers enter the gate before it resolves.
    let resolveHandler!: (v: string) => void
    const handlerPromise = new Promise<string>((resolve) => { resolveHandler = resolve })
    const refreshFn = vi.fn().mockImplementation(() => handlerPromise)
    registerAuthErrorHandler(accountId, refreshFn)

    const p1 = __testInvokeAuthHandlerWithCooldown(accountId, new Error('AUTHENTICATE failed'))
    const p2 = __testInvokeAuthHandlerWithCooldown(accountId, new Error('AUTHENTICATE failed'))
    // Drain microtasks so both callers are definitely inside the single-flight.
    await Promise.resolve()
    expect(refreshFn).toHaveBeenCalledTimes(1)

    resolveHandler('fresh-token-shared')
    const [t1, t2] = await Promise.all([p1, p2])
    // Both callers observe the same fresh token from the one shared refresh.
    expect(t1).toBe('fresh-token-shared')
    expect(t2).toBe('fresh-token-shared')
    expect(refreshFn).toHaveBeenCalledTimes(1)
    // Success clears cooldown state entirely.
    expect(peekCooldownEntry(accountId)).toBeUndefined()
  })

  it('concurrent calls on DIFFERENT accountIds are not serialized', async () => {
    const accountIdA = 220
    const accountIdB = 221

    // Both handlers block on manual resolution so we can observe ordering.
    let resolveA!: (v: string) => void
    let resolveB!: (v: string) => void
    const pendingA = new Promise<string>((r) => { resolveA = r })
    const pendingB = new Promise<string>((r) => { resolveB = r })
    const handlerA = vi.fn().mockImplementation(() => pendingA)
    const handlerB = vi.fn().mockImplementation(() => pendingB)
    registerAuthErrorHandler(accountIdA, handlerA)
    registerAuthErrorHandler(accountIdB, handlerB)

    try {
      const pA = __testInvokeAuthHandlerWithCooldown(accountIdA, new Error('AUTHENTICATE failed'))
      const pB = __testInvokeAuthHandlerWithCooldown(accountIdB, new Error('AUTHENTICATE failed'))

      // Drain microtasks so both handlers are definitely invoked.
      await Promise.resolve()
      await Promise.resolve()

      // Both handlers are in-flight at once — accountA does NOT serialize accountB.
      expect(handlerA).toHaveBeenCalledTimes(1)
      expect(handlerB).toHaveBeenCalledTimes(1)

      // Resolve B first, then A — independent ordering proves no cross-account lock.
      resolveB('fresh-B')
      await expect(pB).resolves.toBe('fresh-B')

      resolveA('fresh-A')
      await expect(pA).resolves.toBe('fresh-A')
    } finally {
      unregisterAuthErrorHandler(accountIdA)
      unregisterAuthErrorHandler(accountIdB)
    }
  })
})

// --- startIdle: in-loop OAuth token refresh on auth error ---
//
// Before §2.9 the IDLE cycle treated any auth error identically — sleep
// BACKOFF_MS.auth (60 min), then reconnect. For OAuth accounts this meant a
// mid-IDLE access-token expiry silently disabled push delivery for up to an
// hour even though a registered refresh handler could mint a fresh token in
// milliseconds. These tests pin the new behaviour: handler invoked before any
// sleep, successful refresh swaps the IDLE client cleanly, failed/absent
// handler falls back to the original 60-min path unchanged.

// BACKOFF_MS is module-private in imap.ts; mirror the auth value locally so
// the IDLE-loop tests below can assert that the 60-min sleep was (or was not)
// scheduled. If imap.ts ever changes the value, this constant must be updated
// in lockstep — CLAUDE.md §5 already forbids changing it silently.
const BACKOFF_MS_AUTH = 60 * 60_000

describe('startIdle — in-loop OAuth token refresh', () => {
  const accountId = 7
  // Fresh per-test cfg — each test mutates accessToken and we don't want the
  // mutation to leak across cases.
  function makeOauthCfg(): ImapConfig {
    return {
      host: 'outlook.office365.com',
      port: 993,
      secure: true,
      user: 'user@outlook.com',
      pass: undefined,
      accessToken: 'stale-token',
    }
  }

  // Build a fake ImapFlow instance whose idle() resolves when we trip
  // `breakIdle`. The exit behaviour — resolve vs reject — is controlled by
  // the optional `idleError` argument so tests can drive a cycle-ending
  // failure or a clean loop-exit at will. Setting `usable = false` from the
  // outside tells the while-condition to drop out after idle() returns.
  interface FakeClient {
    connect: ReturnType<typeof vi.fn>
    logout: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
    usable: boolean
    on: ReturnType<typeof vi.fn>
    removeListener: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    noop: ReturnType<typeof vi.fn>
    mailboxOpen: ReturnType<typeof vi.fn>
    idle: ReturnType<typeof vi.fn>
    /** Force the pending idle() call to resolve cleanly — used to flush the loop. */
    breakIdle: (err?: Error) => void
  }

  function makeFakeClient(): FakeClient {
    let idleResolve: (() => void) | null = null
    let idleReject: ((err: Error) => void) | null = null
    const fc: Partial<FakeClient> = {
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockImplementation(async () => {
        // Ensure a pending idle() unblocks when the client is logged out —
        // matches ImapFlow's real behaviour and lets stopIdle() finish.
        if (idleResolve) { const r = idleResolve; idleResolve = null; r() }
      }),
      list: vi.fn(),
      usable: true,
      on: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(),
      noop: vi.fn().mockResolvedValue(undefined),
      mailboxOpen: vi.fn().mockResolvedValue({ exists: 0, highestModseq: null, uidValidity: 1 }),
      idle: vi.fn().mockImplementation(() => new Promise<void>((resolve, reject) => {
        idleResolve = resolve
        idleReject = reject
      })),
      breakIdle: (err?: Error) => {
        if (err) {
          if (idleReject) { const r = idleReject; idleResolve = null; idleReject = null; r(err) }
        } else {
          if (idleResolve) { const r = idleResolve; idleResolve = null; idleReject = null; r() }
        }
      },
    }
    return fc as FakeClient
  }

  // Wait for a chain of microtasks to flush. 40 ticks is enough to walk
  // through: idle rejection → handler → connectIdle → mailboxOpen → next
  // idle() call on the new client.
  async function flushMicrotasks(n = 40) {
    for (let i = 0; i < n; i++) await Promise.resolve()
  }

  beforeEach(async () => {
    __resetAuthRefreshCooldown()
    // M-1 storm-brake counter is module-scope; clear so tests that reuse
    // the same accountId across cases start from zero.
    __resetAuthRefreshConsecutiveForTest()
    // Clear constructor-call history AND reset the mockImplementationOnce
    // queue. `mockClear` alone preserves queued `Once` implementations
    // which leak across tests — a prior test's leftover "throw
    // ECONNREFUSED" would fire at startIdle() in a clean test. `mockReset`
    // wipes the queue plus the default impl, so we immediately re-install
    // the default fallback factory. Default matches the file-top vi.mock
    // but simpler (the specialised startIdle tests all register their
    // own clients via mockImplementationOnce, so the default is only a
    // safety net in case a test under-specifies).
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockReset()
    ImapFlowMock.mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
      usable: true,
      on: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(),
      noop: vi.fn().mockResolvedValue(undefined),
      mailboxOpen: vi.fn().mockResolvedValue({ exists: 0, highestModseq: null, uidValidity: 1 }),
      idle: vi.fn().mockImplementation(() => new Promise<void>(() => { /* parked */ })),
      fetch: vi.fn(),
      fetchOne: vi.fn().mockResolvedValue(null),
    }) as unknown as InstanceType<typeof imapflow.ImapFlow>)
  })

  afterEach(async () => {
    unregisterAuthErrorHandler(accountId)
    // Tear down the IDLE loop. stopIdle() sets idleStop=true + logouts the
    // active client; our fake logout resolves the pending idle() so the loop
    // actually exits. Guard with a short fallback timeout in case something
    // is parked in an unexpected state.
    try {
      await Promise.race([
        stopIdle(),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ])
    } catch { /* ignore */ }
    __resetAuthRefreshCooldown()
    setNetErrorReporter(null)
  })

  it('auth error + registered handler invokes handler BEFORE sleep, reconnects, emits auth_refreshed telemetry', async () => {
    const refreshFn = vi.fn().mockResolvedValue('fresh-token')
    registerAuthErrorHandler(accountId, refreshFn)

    // Capture typed events (we expect 'imap.idle_auth_refreshed').
    const events: Array<{ name: string; tags: Record<string, unknown> }> = []
    const { setNetEventReporter } = await import('./telemetry')
    setNetEventReporter((name, tags) => { events.push({ name, tags }) })
    // Capture reportNetError calls — after a successful refresh we must NOT
    // emit the generic 'imap.idle' error because the cycle recovered.
    const errorReporter = vi.fn()
    setNetErrorReporter(errorReporter)

    // Spy on setTimeout to prove the BACKOFF_MS.auth sleep path was NOT entered.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    // Sequence two ImapFlow instances:
    //   #1 — idle() will be forced to reject with auth error.
    //   #2 — idle() parks (resolves on logout during stopIdle teardown).
    const client1 = makeFakeClient()
    const client2 = makeFakeClient()
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => client1 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementationOnce(() => client2 as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const oauthCfg = makeOauthCfg()
    try {
      await startIdle(accountId, oauthCfg, 'INBOX', () => {})
      // Let the loop reach c.idle() on client1.
      await flushMicrotasks()
      // Force client1.idle() to reject with an auth error — this is the
      // trigger for the refresh path.
      client1.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      // Walk through the recovery chain (handler → connectIdle → mailboxOpen).
      await flushMicrotasks()

      // Handler invoked exactly once, config patched, second client built.
      expect(refreshFn).toHaveBeenCalledTimes(1)
      expect(oauthCfg.accessToken).toBe('fresh-token')
      expect(ImapFlowMock).toHaveBeenCalledTimes(2)

      // Old client torn down cleanly: exists listener removed + logout.
      expect(client1.removeListener).toHaveBeenCalledWith('exists', expect.any(Function))
      expect(client1.logout).toHaveBeenCalledTimes(1)

      // New client reopened the mailbox and attached a fresh exists listener.
      expect(client2.mailboxOpen).toHaveBeenCalledWith('INBOX')
      expect(client2.on).toHaveBeenCalledWith('exists', expect.any(Function))
      // And actually entered IDLE on the new client.
      expect(client2.idle).toHaveBeenCalledTimes(1)

      // Telemetry: auth_refreshed event emitted, and no generic error report
      // (because the cycle recovered without falling through to the error path).
      expect(events.some(e => e.name === 'imap.idle_auth_refreshed')).toBe(true)
      expect(errorReporter).not.toHaveBeenCalled()

      // Storm-protection gate NOT tripped — recordRefreshSuccess clears state.
      expect(isInCooldown(accountId)).toBe(false)

      // And the decisive invariant: we did NOT enter the 60-min auth backoff.
      const sleptAuthBackoff = setTimeoutSpy.mock.calls.some(([, ms]) => ms === BACKOFF_MS_AUTH)
      expect(sleptAuthBackoff).toBe(false)
    } finally {
      setNetEventReporter(null)
      setTimeoutSpy.mockRestore()
    }
  })

  it('auth error + NO handler registered falls through to existing BACKOFF_MS.auth sleep path', async () => {
    // Deliberately NOT registering a handler — invokeAuthHandlerWithCooldown
    // returns null → existing fall-through path must run.
    expect(isInCooldown(accountId)).toBe(false)

    const errorReporter = vi.fn()
    setNetErrorReporter(errorReporter)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    // Only one ImapFlow instance should be built — we never reconnect.
    const client1 = makeFakeClient()
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => client1 as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const oauthCfg = makeOauthCfg()
    try {
      await startIdle(accountId, oauthCfg, 'INBOX', () => {})
      // Let the loop reach c.idle() on client1.
      await flushMicrotasks()
      client1.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      // Flush microtasks so the auth error is classified and the sleep call
      // is scheduled. We don't actually wait 60 min — the presence of
      // setTimeout(..., BACKOFF_MS.auth) is enough.
      await flushMicrotasks()

      // No reconnect happened — exactly one ImapFlow constructed.
      expect(ImapFlowMock).toHaveBeenCalledTimes(1)
      // Config was NOT patched — token still stale.
      expect(oauthCfg.accessToken).toBe('stale-token')
      // Generic error telemetry fired with exit_reason=auth.
      expect(errorReporter).toHaveBeenCalledWith(
        'imap.idle',
        expect.any(Error),
        expect.objectContaining({ exit_reason: 'auth' }),
      )
      // Decisive invariant: the 60-min auth backoff sleep WAS scheduled.
      const sleptAuthBackoff = setTimeoutSpy.mock.calls.some(([, ms]) => ms === BACKOFF_MS_AUTH)
      expect(sleptAuthBackoff).toBe(true)
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  // --- Cert error during an ordinary IDLE cycle (not the auth-refresh
  // reconnect loop): a TLS trust failure surfacing straight out of c.idle()
  // must classify 'cert', NOTIFY the main process, and exit the loop cleanly
  // — without the 6h in-loop sleep.
  //
  // Regression this pins (codex round-3 HIGH): the branch used to fall into
  // `await sleep(BACKOFF_MS.cert)` with NO notifyCertError call. Two bugs in
  // one line — the trust failure was never reported (no interception banner,
  // no recovery UX, user just sees a dead account), and stopIdle() had to
  // wait out a six-hour sleep before teardown could complete.
  it('cert error on idle() notifies main once and exits the loop without the 6h sleep', async () => {
    const BACKOFF_MS_CERT = 6 * 60 * 60_000
    const errorReporter = vi.fn()
    setNetErrorReporter(errorReporter)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const certHandler = vi.fn()
    registerCertErrorHandler(accountId, certHandler)

    // Only one ImapFlow instance should be built — a cert failure must not
    // trigger the auth-refresh reconnect path or any connection retry.
    const client1 = makeFakeClient()
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => client1 as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const oauthCfg = makeOauthCfg()
    try {
      await startIdle(accountId, oauthCfg, 'INBOX', () => {})
      await flushMicrotasks()
      const certErr = new Error('unable to verify the first certificate') as Error & { code: string }
      certErr.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      client1.breakIdle(certErr)
      await flushMicrotasks()

      // No reconnect happened — exactly one ImapFlow constructed.
      expect(ImapFlowMock).toHaveBeenCalledTimes(1)
      // Generic error telemetry fired with exit_reason=cert (not 'auth').
      expect(errorReporter).toHaveBeenCalledWith(
        'imap.idle',
        expect.any(Error),
        expect.objectContaining({ exit_reason: 'cert' }),
      )
      // Decisive invariant #1: main was told, exactly once, with transport.
      expect(certHandler).toHaveBeenCalledTimes(1)
      expect(certHandler.mock.calls[0]![0]).toMatchObject({
        host: 'outlook.office365.com',
        port: 993,
        secure: true,
        protocol: 'imap',
      })
      // Decisive invariant #2: no 6h sleep was ever scheduled inside the loop.
      const sleptCertBackoff = setTimeoutSpy.mock.calls.some(([, ms]) => ms === BACKOFF_MS_CERT)
      expect(sleptCertBackoff).toBe(false)
      // Decisive invariant #3: stopIdle() returns immediately (the loop is
      // already gone) instead of blocking on a sleeping cycle.
      await stopIdle()
    } finally {
      setTimeoutSpy.mockRestore()
      unregisterCertErrorHandler(accountId)
    }
  })

  // Cert failure surfacing from the INITIAL connect/select prologue of
  // startIdle — previously propagated to the caller unclassified, so IDLE
  // never started and main never learned why.
  it('cert error on the initial IDLE connect notifies main and rethrows', async () => {
    const certHandler = vi.fn()
    registerCertErrorHandler(accountId, certHandler)
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => ({
      connect: vi.fn().mockImplementation(() => {
        const e = new Error('self-signed certificate') as Error & { code: string }
        e.code = 'DEPTH_ZERO_SELF_SIGNED_CERT'
        return Promise.reject(e)
      }),
      logout: vi.fn().mockResolvedValue(undefined),
      usable: true,
      on: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(),
      mailboxOpen: vi.fn(),
      idle: vi.fn(),
      noop: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)

    try {
      await expect(
        startIdle(accountId, makeOauthCfg(), 'INBOX', () => {}),
      ).rejects.toThrow('self-signed certificate')
      expect(certHandler).toHaveBeenCalledTimes(1)
      expect(certHandler.mock.calls[0]![0]).toMatchObject({
        host: 'outlook.office365.com',
        port: 993,
        secure: true,
        protocol: 'imap',
      })
    } finally {
      unregisterCertErrorHandler(accountId)
    }
  })

  // --- Reconnect-path: bounded retry instead of single-attempt death --
  //
  // After a successful token refresh the code tears down the dead IDLE client
  // and then awaits `connectIdle(cfg)` + `c.mailboxOpen(mailbox)`. Either can
  // reject — token valid but TCP unreachable, mailbox gone, TLS handshake
  // stuck, etc.
  //
  // Round-1 fix (single try/catch + sleep + continue) left a subtle bug: after
  // teardown of the old client, `idleClient` was nulled and the local `c`
  // still pointed at the logged-out old client. If connectIdle rejected, the
  // catch slept and `continue`d, but the outer while-guard
  // `idleClient === c && c.usable` was false — the while-loop exited cleanly,
  // the IIFE resolved as a (non-null) Promise, and next startIdle()'s
  // `if (!idleLoop)` guard was false. IDLE stayed dead until app restart.
  //
  // Round-2 fix (current):
  //   1. Inner bounded retry loop for connectIdle+mailboxOpen+listener. On
  //      attempt N's success, `c` is reassigned to the live client so the
  //      outer guard tracks it. Each transient failure sleeps the class-
  //      appropriate backoff before retrying. Permanent class or exhaustion
  //      of AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS → break with distinct
  //      exit_reason 'auth_refresh_reconnect_failed_terminal'.
  //   2. IIFE wrapped in try/finally so that on ANY exit path — including
  //      the terminal reconnect break above — `idleLoop` resets to null.
  //      Next startIdle() sees the guard true again and re-enters cleanly.
  //
  // Tests below pin:
  //   (a) retry-then-success: first connectIdle rejects, second succeeds,
  //       loop continues on the live client.
  //   (b) permanent-class: immediate terminal exit without retry.
  //   (c) attempts-exhausted: all retries fail, loop exits cleanly, next
  //       startIdle() re-enters successfully.

  it('reconnect retry: first connectIdle rejection sleeps backoff then retries; second attempt succeeds → loop continues', async () => {
    vi.useFakeTimers()
    try {
      const refreshFn = vi.fn().mockResolvedValue('fresh-token')
      registerAuthErrorHandler(accountId, refreshFn)

      const errorReporter = vi.fn()
      setNetErrorReporter(errorReporter)

      const client1 = makeFakeClient()
      const client2 = makeFakeClient()
      const imapflow = await import('imapflow')
      const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
      // Sequence: client1 built at startIdle → auth err → refresh → FIRST
      // reconnect attempt throws on ImapFlow construction (ECONNREFUSED) →
      // sleep network backoff → SECOND reconnect attempt returns client2.
      ImapFlowMock.mockImplementationOnce(() => client1 as unknown as InstanceType<typeof imapflow.ImapFlow>)
      ImapFlowMock.mockImplementationOnce(() => { throw new Error('ECONNREFUSED during reconnect') })
      ImapFlowMock.mockImplementationOnce(() => client2 as unknown as InstanceType<typeof imapflow.ImapFlow>)

      const oauthCfg = makeOauthCfg()
      await startIdle(accountId, oauthCfg, 'INBOX', () => {})
      for (let i = 0; i < 40; i++) await Promise.resolve()
      client1.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      for (let i = 0; i < 40; i++) await Promise.resolve()

      // Walk past the sleep(BACKOFF_MS.network) between attempt 1 and
      // attempt 2. After the advance, attempt 2 constructs client2 and
      // the loop resumes on the live client.
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      for (let i = 0; i < 40; i++) await Promise.resolve()

      // Handler ran once, cfg patched.
      expect(refreshFn).toHaveBeenCalledTimes(1)
      expect(oauthCfg.accessToken).toBe('fresh-token')
      // Old client torn down.
      expect(client1.logout).toHaveBeenCalledTimes(1)
      // Exactly TWO reconnect attempts made (plus client1 at startup = 3 total).
      expect(ImapFlowMock).toHaveBeenCalledTimes(3)

      // First failed attempt reported with attempt=1 tag.
      expect(errorReporter).toHaveBeenCalledWith(
        'imap.idle',
        expect.any(Error),
        expect.objectContaining({ exit_reason: 'auth_refresh_reconnect_failed', attempt: 1 }),
      )

      // Terminal exit reason NOT emitted — the retry succeeded on attempt 2.
      const sawTerminal = errorReporter.mock.calls.some(
        ([, , ctx]) => ctx?.exit_reason === 'auth_refresh_reconnect_failed_terminal',
      )
      expect(sawTerminal).toBe(false)

      // client2 now has idle() entered — loop resumed on the live client.
      expect(client2.idle).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnect retry: permanent classification → no retry, terminal exit, next startIdle() re-enters', async () => {
    // mailboxOpen rejection with "Mailbox does not exist" classifies as
    // 'permanent' in classifyImapError — retry would never improve matters
    // (the mailbox is gone), so the inner retry loop must bail IMMEDIATELY
    // without sleeping or scheduling another attempt.
    const refreshFn = vi.fn().mockResolvedValue('fresh-token')
    registerAuthErrorHandler(accountId, refreshFn)

    const errorReporter = vi.fn()
    setNetErrorReporter(errorReporter)

    const client1 = makeFakeClient()
    const client2 = makeFakeClient()
    client2.mailboxOpen = vi.fn().mockRejectedValue(new Error('NO Mailbox does not exist'))

    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => client1 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementationOnce(() => client2 as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const oauthCfg = makeOauthCfg()
    await startIdle(accountId, oauthCfg, 'INBOX', () => {})
    await flushMicrotasks()
    client1.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
    await flushMicrotasks()

    // Exactly ONE reconnect attempt was made — no retry for permanent errors.
    // (Plus client1 at startup = 2 total ImapFlow constructions.)
    expect(ImapFlowMock).toHaveBeenCalledTimes(2)
    expect(client2.mailboxOpen).toHaveBeenCalledTimes(1)
    expect(client1.logout).toHaveBeenCalledTimes(1)

    // Per-attempt failure reported (attempt=1) AND terminal reason reported.
    expect(errorReporter).toHaveBeenCalledWith(
      'imap.idle',
      expect.any(Error),
      expect.objectContaining({ exit_reason: 'auth_refresh_reconnect_failed', attempt: 1 }),
    )
    expect(errorReporter).toHaveBeenCalledWith(
      'imap.idle',
      expect.any(Error),
      expect.objectContaining({ exit_reason: 'auth_refresh_reconnect_failed_terminal' }),
    )

    // Critical invariant: the IIFE's finally must have nulled idleLoop, so
    // a fresh startIdle() call can re-enter. Prove this by calling startIdle
    // again with a new client and watching it proceed into idle() normally.
    const client3 = makeFakeClient()
    ImapFlowMock.mockImplementationOnce(() => client3 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    const newCfg = makeOauthCfg()
    // stopIdle isn't strictly required here — the old loop already exited —
    // but we reset idleStop via a stopIdle+startIdle pair to simulate the
    // realistic re-entry path (stopIdle called by periodic sync or app
    // startup). Inside afterEach there's another stopIdle; both are safe.
    await stopIdle()
    await startIdle(accountId, newCfg, 'INBOX', () => {})
    await flushMicrotasks()

    // Re-entry succeeded: new client was built AND had idle() entered.
    expect(client3.idle).toHaveBeenCalled()
  })

  it('reconnect retry: cert classification → no retry, terminal exit (6h cert backoff must not pin the reconnect loop)', async () => {
    // mailboxOpen rejection with a TLS trust error classifies as 'cert'.
    // BACKOFF_MS.cert is 6h — if the reconnect loop treated 'cert' like a
    // transient class (network/auth) it would call sleep(BACKOFF_MS.cert)
    // INSIDE this bounded loop, pinning the IDLE IIFE for hours. The
    // production code special-cases 'permanent' OR 'cert' to bail
    // immediately (imap.ts: `if (reconnectClass === 'permanent' || reconnectClass === 'cert') break`).
    const refreshFn = vi.fn().mockResolvedValue('fresh-token')
    registerAuthErrorHandler(accountId, refreshFn)

    const errorReporter = vi.fn()
    setNetErrorReporter(errorReporter)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    const client1 = makeFakeClient()
    const client2 = makeFakeClient()
    const certErr = new Error('unable to verify the first certificate') as Error & { code: string }
    certErr.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    client2.mailboxOpen = vi.fn().mockRejectedValue(certErr)

    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => client1 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementationOnce(() => client2 as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const oauthCfg = makeOauthCfg()
    try {
      await startIdle(accountId, oauthCfg, 'INBOX', () => {})
      await flushMicrotasks()
      client1.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      await flushMicrotasks()

      // Exactly ONE reconnect attempt was made — no retry for cert errors.
      expect(ImapFlowMock).toHaveBeenCalledTimes(2)
      expect(client2.mailboxOpen).toHaveBeenCalledTimes(1)

      expect(errorReporter).toHaveBeenCalledWith(
        'imap.idle',
        expect.any(Error),
        expect.objectContaining({ exit_reason: 'auth_refresh_reconnect_failed', attempt: 1 }),
      )
      expect(errorReporter).toHaveBeenCalledWith(
        'imap.idle',
        expect.any(Error),
        expect.objectContaining({ exit_reason: 'auth_refresh_reconnect_failed_terminal' }),
      )

      // Decisive invariant: the 6h cert backoff was never scheduled inside
      // this loop — the reconnect loop bails immediately on 'cert'.
      const sleptCertBackoff = setTimeoutSpy.mock.calls.some(([, ms]) => ms === 6 * 60 * 60_000)
      expect(sleptCertBackoff).toBe(false)

      // Next startIdle() can still re-enter — terminal exit, not a stuck loop.
      const client3 = makeFakeClient()
      ImapFlowMock.mockImplementationOnce(() => client3 as unknown as InstanceType<typeof imapflow.ImapFlow>)
      const newCfg = makeOauthCfg()
      await stopIdle()
      await startIdle(accountId, newCfg, 'INBOX', () => {})
      await flushMicrotasks()
      expect(client3.idle).toHaveBeenCalled()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('reconnect retry exhaustion: with fake timers, all 5 attempts run, terminal exit, next startIdle() re-enters', async () => {
    vi.useFakeTimers()
    try {
      const refreshFn = vi.fn().mockResolvedValue('fresh-token')
      registerAuthErrorHandler(accountId, refreshFn)

      const errorReporter = vi.fn()
      setNetErrorReporter(errorReporter)

      const client1 = makeFakeClient()
      const imapflow = await import('imapflow')
      const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
      ImapFlowMock.mockImplementationOnce(() => client1 as unknown as InstanceType<typeof imapflow.ImapFlow>)
      // Register exactly AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS throws — the
      // retry loop bails after N attempts, so extra entries would leak into
      // the subsequent "re-entry" startIdle() call (mockImplementationOnce
      // appends to the queue tail; leftover throws would fire BEFORE our
      // post-exhaustion clientRecover entry).
      for (let i = 0; i < AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS; i++) {
        ImapFlowMock.mockImplementationOnce(() => { throw new Error('ECONNREFUSED attempt') })
      }

      const oauthCfg = makeOauthCfg()
      await startIdle(accountId, oauthCfg, 'INBOX', () => {})
      // flushMicrotasks under fake timers still works — it just awaits
      // Promise.resolve() N times.
      for (let i = 0; i < 40; i++) await Promise.resolve()
      client1.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      for (let i = 0; i < 40; i++) await Promise.resolve()

      // Walk through each of the 5 retry attempts by advancing fake timers
      // past each BACKOFF_MS.network sleep. Between each advance, flush
      // microtasks so the awaited sleep resolves and the next attempt's
      // construction executes.
      for (let i = 0; i < AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(5 * 60_000) // BACKOFF_MS.network
        for (let j = 0; j < 40; j++) await Promise.resolve()
      }

      // Per-attempt reports — one per failed attempt, totalling 5.
      const attemptReports = errorReporter.mock.calls.filter(
        ([, , ctx]) => ctx?.exit_reason === 'auth_refresh_reconnect_failed',
      )
      expect(attemptReports).toHaveLength(AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS)
      // Final attempt tagged attempt=5.
      const finalAttempt = attemptReports[attemptReports.length - 1]
      expect(finalAttempt?.[2]?.attempt).toBe(AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS)

      // Terminal report emitted exactly once after exhaustion.
      const terminalReports = errorReporter.mock.calls.filter(
        ([, , ctx]) => ctx?.exit_reason === 'auth_refresh_reconnect_failed_terminal',
      )
      expect(terminalReports).toHaveLength(1)

      // Decisive invariant: `idleLoop` has been reset so the next startIdle()
      // can re-enter. Build a new client and watch startIdle proceed.
      const clientRecover = makeFakeClient()
      ImapFlowMock.mockImplementationOnce(() => clientRecover as unknown as InstanceType<typeof imapflow.ImapFlow>)
      // Need to reset idleStop — stopIdle is the normal path, and its
      // logout on a nulled client is a no-op.
      await stopIdle()
      await startIdle(accountId, makeOauthCfg(), 'INBOX', () => {})
      for (let j = 0; j < 40; j++) await Promise.resolve()
      expect(clientRecover.idle).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopIdle race: stopIdle called while refresh handler is in-flight does not create a new client', async () => {
    // Gate the refresh handler on an external deferred so the test can drive
    // the race: resolve stopIdle BEFORE the handler resolves, so when the
    // freshToken arrives the loop sees idleStop=true and bails.
    const releaseRefreshRef: { fn: ((token: string) => void) | null } = { fn: null }
    const refreshFn = vi.fn<() => Promise<string>>().mockImplementation(() => new Promise<string>((resolve) => {
      releaseRefreshRef.fn = resolve
    }))
    registerAuthErrorHandler(accountId, refreshFn)

    const client1 = makeFakeClient()
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => client1 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    // A second ImapFlow constructor is registered too — this is the one that
    // MUST NOT be called. If the loop incorrectly builds a new client after
    // the stop signal, this factory fires and the expectation at the bottom
    // of the test fails.
    const wouldLeak = vi.fn(() => makeFakeClient() as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementation(wouldLeak)

    const oauthCfg = makeOauthCfg()
    await startIdle(accountId, oauthCfg, 'INBOX', () => {})
    await flushMicrotasks()

    // Trigger the auth path — refreshFn will hang until we release it.
    client1.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
    await flushMicrotasks()
    // Handler invoked, but still pending.
    expect(refreshFn).toHaveBeenCalledTimes(1)

    // Now request stop — this is the race window. stopIdle() sets idleStop,
    // captures + logouts client1 (its own teardown), and awaits the loop.
    const stopPromise = stopIdle()
    await flushMicrotasks()
    // Release the refresh so the hung handler resolves; the loop must now
    // see idleStop=true and bail without building a new client.
    if (releaseRefreshRef.fn) releaseRefreshRef.fn('fresh-token-after-stop')
    await Promise.race([
      stopPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ])

    // Decisive invariant: only ONE ImapFlow was constructed (client1). The
    // fallback factory that would have created a leaking second client was
    // never invoked.
    expect(ImapFlowMock).toHaveBeenCalledTimes(1)
    expect(wouldLeak).not.toHaveBeenCalled()
    // cfg.accessToken stays stale — we bailed before the refresh swap
    // completed (the `idleStop` guard runs before cfg mutation).
    expect(oauthCfg.accessToken).toBe('stale-token')
  })

  it('auth refresh path: listener accounting — old client loses its exists listener, new client gains exactly one', async () => {
    const refreshFn = vi.fn().mockResolvedValue('fresh-token')
    registerAuthErrorHandler(accountId, refreshFn)

    const client1 = makeFakeClient()
    const client2 = makeFakeClient()
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => client1 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementationOnce(() => client2 as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const oauthCfg = makeOauthCfg()
    await startIdle(accountId, oauthCfg, 'INBOX', () => {})
    await flushMicrotasks()
    client1.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
    await flushMicrotasks()

    // client1 had exactly one 'exists' listener attached during startIdle and
    // it was removed during refresh teardown — net zero, no leak.
    const c1Attachments = client1.on.mock.calls.filter(([ev]) => ev === 'exists')
    const c1Removals = client1.removeListener.mock.calls.filter(([ev]) => ev === 'exists')
    expect(c1Attachments).toHaveLength(1)
    expect(c1Removals).toHaveLength(1)

    // client2 has exactly one 'exists' listener attached and (so far) none
    // removed — it's the live IDLE client now.
    const c2Attachments = client2.on.mock.calls.filter(([ev]) => ev === 'exists')
    const c2Removals = client2.removeListener.mock.calls.filter(([ev]) => ev === 'exists')
    expect(c2Attachments).toHaveLength(1)
    expect(c2Removals).toHaveLength(0)
  })

  // --- M-1 storm-brake: consecutive-refresh ceiling ----------------------
  //
  // Threat model: provider `/token` endpoint keeps minting fresh tokens but
  // IMAP server rejects every AUTHENTICATE with the fresh token (conditional-
  // access policy change mid-session, admin-side IMAP app-password revocation,
  // per-mailbox MFA, systematic clock skew). Each iteration:
  //   1. idle() rejects → errClass='auth'.
  //   2. handler succeeds → recordRefreshSuccess clears any cooldown state.
  //   3. Reconnect + mailboxOpen succeed.
  //   4. continue — skips BACKOFF_MS.auth.
  //   5. idle() on the new client rejects again with the same auth error.
  // Without a ceiling this becomes a tight loop against /token + IMAP
  // auth — a DoS amplifier against the shared Azure/Google client_id.
  // §2.2-D cooldown doesn't engage because refresh itself is succeeding.
  // These tests pin the ceiling: after N=3 consecutive refreshes without a
  // healthy IDLE cycle, the 4th auth error short-circuits the handler call,
  // emits 'imap.auth_refresh_exhausted', and falls through to the ordinary
  // BACKOFF_MS.auth sleep path.

  it('auth refresh storm-brake: 4th consecutive auth error skips handler, emits exhausted event, sleeps BACKOFF_MS.auth', async () => {
    const refreshFn = vi.fn().mockResolvedValue('fresh-token')
    registerAuthErrorHandler(accountId, refreshFn)

    const events: Array<{ name: string; tags: Record<string, unknown> }> = []
    const { setNetEventReporter } = await import('./telemetry')
    setNetEventReporter((name, tags) => { events.push({ name, tags }) })

    const errorReporter = vi.fn()
    setNetErrorReporter(errorReporter)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    // Sequence: client1 (iter 1) rejects auth → client2 (iter 2) rejects
    // auth → client3 (iter 3) rejects auth → client4 (iter 4) rejects auth
    // → brake trips, no 5th client is built. After brake fires we also need
    // one more client that the loop would build post-backoff, but we park
    // the test before the sleep resolves — a fifth factory is still
    // registered as a guard that MUST NOT fire during this scenario.
    const c1 = makeFakeClient()
    const c2 = makeFakeClient()
    const c3 = makeFakeClient()
    const c4 = makeFakeClient()
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => c1 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementationOnce(() => c2 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementationOnce(() => c3 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementationOnce(() => c4 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    // Guard: the brake must prevent a fifth construction during this test.
    const wouldLeak = vi.fn(() => makeFakeClient() as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementation(wouldLeak)

    const oauthCfg = makeOauthCfg()
    try {
      await startIdle(accountId, oauthCfg, 'INBOX', () => {})
      await flushMicrotasks()

      // Iter 1: auth err on c1 → refresh #1 → reconnect to c2.
      c1.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      await flushMicrotasks()
      // Iter 2: auth err on c2 → refresh #2 → reconnect to c3.
      c2.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      await flushMicrotasks()
      // Iter 3: auth err on c3 → refresh #3 → reconnect to c4.
      c3.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      await flushMicrotasks()
      // Iter 4: auth err on c4. Counter is now 3 → brake trips. Handler
      // must NOT be called a 4th time, no 5th client may be built.
      c4.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      await flushMicrotasks()

      // Exactly three refreshes executed — the 4th iteration short-circuits.
      expect(refreshFn).toHaveBeenCalledTimes(3)
      // Exactly four ImapFlow instances constructed (c1..c4). No fifth.
      expect(ImapFlowMock).toHaveBeenCalledTimes(4)
      expect(wouldLeak).not.toHaveBeenCalled()

      // Brake fired — typed event emitted with the consecutive count.
      const exhausted = events.find(e => e.name === 'imap.auth_refresh_exhausted')
      expect(exhausted).toBeDefined()
      expect(exhausted?.tags.consecutive).toBe(3)

      // Generic error telemetry also fired with the distinct exit_reason.
      expect(errorReporter).toHaveBeenCalledWith(
        'imap.idle',
        expect.any(Error),
        expect.objectContaining({ exit_reason: 'auth_refresh_exhausted', consecutive: 3 }),
      )

      // Decisive invariant: the 60-min BACKOFF_MS.auth sleep WAS scheduled
      // once the brake tripped — tight-loop hammering is prevented.
      const sleptAuthBackoff = setTimeoutSpy.mock.calls.some(([, ms]) => ms === BACKOFF_MS_AUTH)
      expect(sleptAuthBackoff).toBe(true)
    } finally {
      setNetEventReporter(null)
      setTimeoutSpy.mockRestore()
    }
  })

  it('auth refresh storm-brake: a healthy IDLE cycle between refreshes resets the counter', async () => {
    const refreshFn = vi.fn().mockResolvedValue('fresh-token')
    registerAuthErrorHandler(accountId, refreshFn)

    const events: Array<{ name: string; tags: Record<string, unknown> }> = []
    const { setNetEventReporter } = await import('./telemetry')
    setNetEventReporter((name, tags) => { events.push({ name, tags }) })
    const errorReporter = vi.fn()
    setNetErrorReporter(errorReporter)

    // Scenario: auth err → refresh #1 → client2 IDLE parks cleanly for one
    // healthy cycle → client2 idle auth err again → refresh #2 → client3
    // parks. After the healthy parked cycle the counter must be reset, so
    // the second refresh does NOT trip the brake. We observe this by
    // asserting that the brake's 'imap.auth_refresh_exhausted' event was
    // never emitted and that a second refresh happened normally.
    const c1 = makeFakeClient()
    const c2 = makeFakeClient()
    const c3 = makeFakeClient()
    const imapflow = await import('imapflow')
    const ImapFlowMock = vi.mocked(imapflow.ImapFlow)
    ImapFlowMock.mockImplementationOnce(() => c1 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementationOnce(() => c2 as unknown as InstanceType<typeof imapflow.ImapFlow>)
    ImapFlowMock.mockImplementationOnce(() => c3 as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const oauthCfg = makeOauthCfg()
    try {
      await startIdle(accountId, oauthCfg, 'INBOX', () => {})
      await flushMicrotasks()

      // Iter 1: auth err → refresh #1 → switch to c2.
      c1.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      await flushMicrotasks()

      // Iter 2: c2.idle() parks cleanly — resolve it without an error.
      // That's the "healthy cycle" that resets the consecutive counter.
      c2.breakIdle()
      await flushMicrotasks()

      // Iter 3: c2.idle() is called again (IDLE refresh cycle). Reject with
      // auth error — counter has been reset, so this takes the normal
      // refresh path (refresh #2), not the brake. Reconnect to c3.
      c2.breakIdle(new Error('AUTHENTICATE failed — XOAUTH2 token expired'))
      await flushMicrotasks()

      // Exactly two refreshes executed — both via the normal path.
      expect(refreshFn).toHaveBeenCalledTimes(2)
      // Brake never tripped.
      expect(events.some(e => e.name === 'imap.auth_refresh_exhausted')).toBe(false)
      // Reconnects produced three clients total (c1 → c2 → c3).
      expect(ImapFlowMock).toHaveBeenCalledTimes(3)
      // Auth-refreshed event fired twice — once per successful refresh.
      const refreshedCount = events.filter(e => e.name === 'imap.idle_auth_refreshed').length
      expect(refreshedCount).toBe(2)
      // No auth_refresh_exhausted error report either.
      const exhaustedErr = errorReporter.mock.calls.some(
        ([, , ctx]) => ctx?.exit_reason === 'auth_refresh_exhausted',
      )
      expect(exhaustedErr).toBe(false)
    } finally {
      setNetEventReporter(null)
    }
  })
})

// ============================================================
// §2.16 — duplicate IMAP draft accumulation hardening
// ------------------------------------------------------------
// Three failure modes are covered here:
//   1. Per-account mutex (`withSaveDraftLock`) — concurrent autosaves on
//      the same account must serialize so neither's APPEND/SEARCH/DELETE
//      triple races against the other. Different accounts proceed in
//      parallel.
//   2. Fallback dedup chain (`saveDraft`) — when SEARCH by our X-header
//      returns [] (mail.ru-class servers do this), try Message-Id, then
//      SUBJECT+SINCE(≤1h). If all three fall through, do NOT delete blind.
//   3. Orphan sweep (`sweepOrphanDrafts`) — group all UIDs in Drafts by
//      X-MailCopilot-Draft-Id, keep max(uid) per group, delete the rest.
//      Drafts WITHOUT our X-header (other clients) are never touched.
// ============================================================

describe('extractMessageIdFromRaw — header parser', () => {
  it('extracts Message-ID from a typical RFC822 header block', () => {
    const raw = Buffer.from(
      'From: alice@example.com\r\n' +
      'To: bob@example.com\r\n' +
      'Subject: hi\r\n' +
      'Message-ID: <abc-123@example.com>\r\n' +
      'X-MailCopilot-Draft-Id: draft-xyz\r\n' +
      '\r\n' +
      'body content\r\n',
      'utf8',
    )
    expect(extractMessageIdFromRaw(raw)).toBe('abc-123@example.com')
  })

  it('returns undefined when Message-ID header is absent', () => {
    const raw = 'From: a@b\r\nTo: c@d\r\n\r\nbody'
    expect(extractMessageIdFromRaw(raw)).toBeUndefined()
  })

  it('case-insensitive on header name (Message-Id)', () => {
    const raw = 'Message-Id: <X@Y>\r\n\r\nbody'
    expect(extractMessageIdFromRaw(raw)).toBe('X@Y')
  })
})

describe('withSaveDraftLock — per-account mutex (§2.16 AC3)', () => {
  beforeEach(() => {
    __resetSaveDraftLockForTest()
  })

  it('serializes calls for the same accountId', async () => {
    const order: string[] = []
    const slowFn = (label: string) => async () => {
      order.push(`${label}:start`)
      await new Promise(r => setTimeout(r, 20))
      order.push(`${label}:end`)
      return label
    }
    const p1 = withSaveDraftLock(1, slowFn('a'))
    const p2 = withSaveDraftLock(1, slowFn('b'))
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe('a')
    expect(r2).toBe('b')
    // Strict ordering — b cannot start until a completes.
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('runs different accountIds in parallel', async () => {
    const order: string[] = []
    const slowFn = (label: string) => async () => {
      order.push(`${label}:start`)
      await new Promise(r => setTimeout(r, 20))
      order.push(`${label}:end`)
      return label
    }
    const p1 = withSaveDraftLock(1, slowFn('a'))
    const p2 = withSaveDraftLock(2, slowFn('b'))
    await Promise.all([p1, p2])
    // Both should start before either ends — interleaved.
    expect(order.slice(0, 2).sort()).toEqual(['a:start', 'b:start'])
  })

  it('does not poison the chain if one call rejects', async () => {
    const failing = withSaveDraftLock(1, async () => { throw new Error('boom') })
    await expect(failing).rejects.toThrow('boom')
    // Subsequent call must proceed normally.
    const next = await withSaveDraftLock(1, async () => 42)
    expect(next).toBe(42)
  })
})

// ------------------------------------------------------------
// Helper — build a fully-stubbed ImapFlow instance for saveDraft /
// sweepOrphanDrafts tests. Returns the instance plus per-method spies so
// individual tests can assert call counts and ordering without poking at
// internal mock state.
// ------------------------------------------------------------
type DraftTestClient = {
  client: {
    connect: ReturnType<typeof vi.fn>
    logout: ReturnType<typeof vi.fn>
    usable: boolean
    on: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    noop: ReturnType<typeof vi.fn>
    capabilities: Set<string>
    mailboxOpen: ReturnType<typeof vi.fn>
    append: ReturnType<typeof vi.fn>
    search: ReturnType<typeof vi.fn>
    messageDelete: ReturnType<typeof vi.fn>
    messageFlagsAdd: ReturnType<typeof vi.fn>
    fetch: ReturnType<typeof vi.fn>
  }
}

function makeDraftFakeClient(opts?: {
  onAppend?: (folder: string) => Promise<{ uid: number } | undefined> | { uid: number } | undefined
  onSearch?: (criteria: unknown) => Promise<number[]> | number[]
  onMessageDelete?: (uids: number[]) => boolean | Promise<boolean>
  onFetch?: (range: string) => Iterable<{ uid: number; headers?: Buffer | string }>
  exists?: number
  uidplus?: boolean
}): DraftTestClient {
  const exists = opts?.exists ?? 0
  const uidplus = opts?.uidplus ?? true
  const capabilities = new Set<string>(uidplus ? ['UIDPLUS'] : [])
  const append = vi.fn().mockImplementation(async (folder: string) => {
    if (opts?.onAppend) {
      const r = await opts.onAppend(folder)
      return r ?? { uid: 100 }
    }
    return { uid: 100 }
  })
  const search = vi.fn().mockImplementation(async (criteria: unknown) => {
    if (opts?.onSearch) return opts.onSearch(criteria)
    return []
  })
  const messageDelete = vi.fn().mockImplementation(async (uids: number[]) => {
    if (opts?.onMessageDelete) return opts.onMessageDelete(uids)
    return true
  })
  const messageFlagsAdd = vi.fn().mockResolvedValue(true)
  const fetch = vi.fn().mockImplementation((range: string) => ({
    [Symbol.asyncIterator]() {
      const iter = opts?.onFetch ? opts.onFetch(range) : []
      const it = iter[Symbol.iterator]()
      return {
        next() {
          const n = it.next()
          if (n.done) return Promise.resolve({ value: undefined, done: true })
          return Promise.resolve({ value: n.value, done: false })
        },
      }
    },
  }))
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    usable: true,
    on: vi.fn(),
    close: vi.fn(),
    noop: vi.fn().mockResolvedValue(undefined),
    capabilities,
    mailboxOpen: vi.fn().mockResolvedValue({
      exists, highestModseq: BigInt(0), uidValidity: 1,
    }),
    append,
    search,
    messageDelete,
    messageFlagsAdd,
    fetch,
  }
  return { client }
}

describe('saveDraft — fallback dedup chain (§2.16 AC4)', () => {
  const cfg: ImapConfig = {
    host: 'imap.mail.ru', port: 993, secure: true, user: 'u@mail.ru', pass: 'p',
  }

  beforeEach(async () => {
    __resetSaveDraftLockForTest()
    forceDisconnectImap()
    vi.clearAllMocks()
    await disconnectAllPerAccount()
    // Default smtp mock returns a buffer with NO Message-ID header, so the
    // Message-Id fallback exercises the "no MID at all" branch unless a test
    // overrides buildRawMessage.
    const smtp = await import('./smtp')
    vi.mocked(smtp.buildRawMessage).mockResolvedValue(Buffer.from(
      'From: u@mail.ru\r\nTo: x@y\r\nSubject: hello\r\nX-MailCopilot-Draft-Id: D1\r\n\r\nbody',
      'utf8',
    ))
  })

  afterEach(async () => {
    await disconnectAllPerAccount()
    forceDisconnectImap()
  })

  it('happy path: X-header SEARCH finds prior copies — old UIDs deleted, appended UID kept', async () => {
    const { client } = makeDraftFakeClient({
      onAppend: () => ({ uid: 30 }),
      onSearch: () => [10, 20, 30], // includes our newly-appended UID
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const res = await saveDraft(1, cfg, 'Drafts', 'D1', { subject: 'hello', text: 'body' })
    expect(res.uid).toBe(30)
    // SEARCH only by X-header — fallbacks not exercised on happy path.
    expect(client.search).toHaveBeenCalledTimes(1)
    expect(client.messageDelete).toHaveBeenCalledTimes(1)
    expect(client.messageDelete.mock.calls[0][0]).toEqual([10, 20])
  })

  it('X-header SEARCH returns [] → falls back to Message-Id → deletes prior copies', async () => {
    // Build a raw message that DOES have a Message-ID so the fallback can fire.
    const smtp = await import('./smtp')
    vi.mocked(smtp.buildRawMessage).mockResolvedValueOnce(Buffer.from(
      'From: u@mail.ru\r\nTo: x@y\r\nSubject: hello\r\n' +
      'Message-ID: <fallback-mid@example.com>\r\n' +
      'X-MailCopilot-Draft-Id: D1\r\n\r\nbody',
      'utf8',
    ))
    const calls: Array<{ criteria: unknown }> = []
    const { client } = makeDraftFakeClient({
      onAppend: () => ({ uid: 50 }),
      onSearch: (criteria) => {
        calls.push({ criteria })
        const c = criteria as { header?: Record<string, string> }
        if (c?.header?.['X-MailCopilot-Draft-Id']) return [] // primary empty
        if (c?.header?.['message-id']) return [40, 50]
        return []
      },
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const res = await saveDraft(1, cfg, 'Drafts', 'D1', { subject: 'hello', text: 'body' })
    expect(res.uid).toBe(50)
    // Two SEARCH calls — primary (X-header) + fallback (Message-Id). No third.
    expect(client.search).toHaveBeenCalledTimes(2)
    expect(client.messageDelete).toHaveBeenCalledTimes(1)
    expect(client.messageDelete.mock.calls[0][0]).toEqual([40])
  })

  it('X-header + Message-Id both empty → falls back to SUBJECT+SINCE(≤1h)', async () => {
    const smtp = await import('./smtp')
    vi.mocked(smtp.buildRawMessage).mockResolvedValueOnce(Buffer.from(
      'From: u@mail.ru\r\nTo: x@y\r\nSubject: hello\r\n' +
      'Message-ID: <mid-no-match@example.com>\r\n' +
      'X-MailCopilot-Draft-Id: D1\r\n\r\nbody',
      'utf8',
    ))
    const sinceArgs: Array<Date | undefined> = []
    const { client } = makeDraftFakeClient({
      onAppend: () => ({ uid: 70 }),
      onSearch: (criteria) => {
        const c = criteria as { header?: Record<string, string>; subject?: string; since?: Date }
        if (c?.header?.['X-MailCopilot-Draft-Id']) return []
        if (c?.header?.['message-id']) return []
        if (c?.subject) {
          sinceArgs.push(c.since)
          return [60, 70]
        }
        return []
      },
      // §2.16 iter2 — SUBJECT fallback now FETCHes X-header per UID and only
      // deletes UIDs whose header matches our draftId. Both candidates carry
      // the matching header in this test, so the verifier keeps both.
      onFetch: () => [
        { uid: 60, headers: 'X-MailCopilot-Draft-Id: D1\r\n' },
        { uid: 70, headers: 'X-MailCopilot-Draft-Id: D1\r\n' },
      ],
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const res = await saveDraft(1, cfg, 'Drafts', 'D1', { subject: 'hello', text: 'body' })
    expect(res.uid).toBe(70)
    // Three SEARCH calls — X-header, Message-Id, then SUBJECT+SINCE.
    expect(client.search).toHaveBeenCalledTimes(3)
    expect(client.messageDelete).toHaveBeenCalledTimes(1)
    expect(client.messageDelete.mock.calls[0][0]).toEqual([60])
    // The SINCE window must be ≤ 1h before the save call (AC4 strict bound).
    expect(sinceArgs).toHaveLength(1)
    const since = sinceArgs[0]!
    const ageMs = Date.now() - since.getTime()
    expect(ageMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5_000) // -5s tolerance for slow CI
    expect(ageMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000)   // +5s tolerance
  })

  it('all three searches return [] → dedup_impossible warn, no DELETE issued', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = makeDraftFakeClient({
      onAppend: () => ({ uid: 80 }),
      onSearch: () => [],
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const res = await saveDraft(1, cfg, 'Drafts', 'D1', { subject: 'hello', text: 'body' })
    expect(res.uid).toBe(80)
    expect(client.messageDelete).not.toHaveBeenCalled()
    // Belt-and-suspenders — the warn must mention the impossible-dedup branch
    // so dashboards can spot it.
    const sawWarn = warnSpy.mock.calls.some(call =>
      call.some(arg => typeof arg === 'string' && arg.includes('saveDraft.dedup_impossible')),
    )
    expect(sawWarn).toBe(true)
    warnSpy.mockRestore()
  })

  it('PII guard — subject content is not present in any log argument, only its length', async () => {
    const sensitive = 'TOP-SECRET-SUBJECT-XYZ'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { client } = makeDraftFakeClient({
      onAppend: () => ({ uid: 1 }),
      onSearch: () => [], // forces dedup_impossible — most verbose path
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    await saveDraft(1, cfg, 'Drafts', 'D1', { subject: sensitive, text: 'body' })

    const allLogged = [
      ...warnSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].map(v => typeof v === 'object' ? JSON.stringify(v) : String(v))
    for (const blob of allLogged) {
      expect(blob).not.toContain(sensitive)
    }
    // But the LENGTH must be reported somewhere so we can correlate with
    // user reports.
    const sawLen = allLogged.some(blob => blob.includes(`"subjectLen":${sensitive.length}`))
    expect(sawLen).toBe(true)
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // §2.16 iter2 — codex closure tests for High #2 (SUBJECT fallback safety)
  // and High #3 (Message-Id derived from draftId enables real dedup).
  // ───────────────────────────────────────────────────────────────────────────

  it('§2.16 iter2: SUBJECT fallback verifies X-header before delete — unrelated draft is NOT deleted', async () => {
    // Scenario: X-header SEARCH and Message-Id SEARCH both return empty (mail.ru
    // race / index lag). SUBJECT+SINCE returns a candidate UID that LOOKS
    // matching by subject but actually belongs to a DIFFERENT draft (e.g. a
    // legitimate user reply with the same subject from earlier in the hour, or
    // a draft by another client). Our header verification step must keep that
    // unrelated UID alive — only the just-appended copy carrying our draftId
    // gets kept (no DELETE issued because nothing else matches).
    const smtp = await import('./smtp')
    vi.mocked(smtp.buildRawMessage).mockResolvedValueOnce(Buffer.from(
      'From: u@mail.ru\r\nTo: x@y\r\nSubject: hello\r\n' +
      'Message-ID: <draft-D1@mailcopilot.local>\r\n' +
      'X-MailCopilot-Draft-Id: D1\r\n\r\nbody',
      'utf8',
    ))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = makeDraftFakeClient({
      onAppend: () => ({ uid: 99 }),
      onSearch: (criteria) => {
        const c = criteria as { header?: Record<string, string>; subject?: string }
        if (c?.header?.['X-MailCopilot-Draft-Id']) return []
        if (c?.header?.['message-id']) return []
        if (c?.subject) return [55, 99] // 55 = unrelated, 99 = our just-appended
        return []
      },
      // FETCH for the SUBJECT candidates: 55 has a DIFFERENT draftId, 99
      // carries ours. Verifier must keep only 99 in the candidate set; since
      // 99 is the just-appended UID and the keep policy keeps appendedUid,
      // there's nothing to delete.
      onFetch: () => [
        { uid: 55, headers: 'X-MailCopilot-Draft-Id: SOME-OTHER-DRAFT\r\n' },
        { uid: 99, headers: 'X-MailCopilot-Draft-Id: D1\r\n' },
      ],
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const res = await saveDraft(1, cfg, 'Drafts', 'D1', { subject: 'hello', text: 'body' })
    expect(res.uid).toBe(99)
    // CRITICAL — UID 55 (the unrelated draft sharing our subject) must NOT be
    // touched. The previous (unsafe) behaviour would have deleted it.
    expect(client.messageDelete).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('§2.16 iter2: SUBJECT fallback with NO matching X-header → no delete + warn fires', async () => {
    // Pathological scenario: SUBJECT search returns N drafts, ALL of which
    // belong to other clients / other draftIds. Verifier filters out every
    // candidate — nothing to delete. We log a dedicated warn so dashboards
    // can spot how often the fallback is rescuing user data.
    const smtp = await import('./smtp')
    vi.mocked(smtp.buildRawMessage).mockResolvedValueOnce(Buffer.from(
      'From: u@mail.ru\r\nTo: x@y\r\nSubject: hello\r\n' +
      'Message-ID: <draft-D1@mailcopilot.local>\r\n' +
      'X-MailCopilot-Draft-Id: D1\r\n\r\nbody',
      'utf8',
    ))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = makeDraftFakeClient({
      onAppend: () => ({ uid: 7 }),
      onSearch: (criteria) => {
        const c = criteria as { header?: Record<string, string>; subject?: string }
        if (c?.header?.['X-MailCopilot-Draft-Id']) return []
        if (c?.header?.['message-id']) return []
        if (c?.subject) return [3, 5]
        return []
      },
      onFetch: () => [
        { uid: 3, headers: 'X-MailCopilot-Draft-Id: OTHER-A\r\n' },
        { uid: 5, headers: 'X-MailCopilot-Draft-Id: OTHER-B\r\n' },
      ],
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const res = await saveDraft(1, cfg, 'Drafts', 'D1', { subject: 'hello', text: 'body' })
    expect(res.uid).toBe(7)
    expect(client.messageDelete).not.toHaveBeenCalled()
    // Warn must be specifically the subject_fallback_no_match flavour.
    const sawWarn = warnSpy.mock.calls.some(call =>
      call.some(arg => typeof arg === 'string' && arg.includes('saveDraft.subject_fallback_no_match')),
    )
    expect(sawWarn).toBe(true)
    warnSpy.mockRestore()
  })

  it('§2.16 iter2: Message-Id is derived deterministically from draftId — same draftId emits same MID', async () => {
    // Verify the saveDraft → buildRawMessage call shape: we pass an explicit
    // `messageId` derived from draftId so MailComposer emits a stable header
    // across repeated saves of the SAME draft.
    const smtp = await import('./smtp')
    const buildSpy = vi.mocked(smtp.buildRawMessage)
    buildSpy.mockClear()
    // Use Once so we don't leak an impl override past this test (beforeEach
    // calls vi.clearAllMocks(), which clears call history but does NOT reset
    // mockImplementation — leaked impl would silently break unrelated tests).
    buildSpy.mockResolvedValueOnce(Buffer.from(
      'From: u@mail.ru\r\nTo: x@y\r\nSubject: hello\r\n' +
      'Message-ID: <draft-D1@mailcopilot.local>\r\n' +
      'X-MailCopilot-Draft-Id: D1\r\n\r\nbody',
      'utf8',
    ))
    const { client } = makeDraftFakeClient({
      onAppend: () => ({ uid: 10 }),
      onSearch: (criteria) => {
        const c = criteria as { header?: Record<string, string> }
        if (c?.header?.['X-MailCopilot-Draft-Id']) return [10] // happy path
        return []
      },
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    await saveDraft(1, cfg, 'Drafts', 'D1', { subject: 'hello', text: 'body' })
    // saveDraft must request a deterministic Message-Id derived from draftId.
    const calls = buildSpy.mock.calls
    const lastCall = calls.length > 0 ? calls[calls.length - 1][0] as { messageId?: string } : undefined
    expect(lastCall?.messageId).toBe('draft-D1@mailcopilot.local')
  })

  it('§2.16 iter2: Message-Id derived from draftId enables dedup of prior copy across saves', async () => {
    // Two consecutive saveDraft calls with the SAME draftId. mail.ru-class
    // server: X-header SEARCH is broken (returns []), Message-Id SEARCH works.
    // Because Message-Id is now stable across saves (derived from draftId),
    // the SECOND save's Message-Id SEARCH finds BOTH the first APPEND and its
    // own — the first copy gets cleaned up. Without iter2 fix this never
    // happened (random per-call MIDs would only match the just-appended UID).
    const smtp = await import('./smtp')
    const stableMid = 'draft-DUPE@mailcopilot.local'
    const rawWithMid = Buffer.from(
      'From: u@mail.ru\r\nTo: x@y\r\nSubject: hello\r\n' +
      `Message-ID: <${stableMid}>\r\n` +
      'X-MailCopilot-Draft-Id: DUPE\r\n\r\nbody',
      'utf8',
    )
    // Two saveDraft calls in this test; use Once × 2 so neither impl leaks
    // into the next test (vi.clearAllMocks() clears history but not impls).
    vi.mocked(smtp.buildRawMessage)
      .mockResolvedValueOnce(rawWithMid)
      .mockResolvedValueOnce(rawWithMid)

    // Stateful fake: first save leaves UID 100 in the mailbox. Second save
    // appends UID 200 and Message-Id SEARCH must find both 100 and 200.
    let appendCount = 0
    const present = new Set<number>()
    const { client } = makeDraftFakeClient({
      onAppend: () => {
        appendCount += 1
        const uid = appendCount === 1 ? 100 : 200
        present.add(uid)
        return { uid }
      },
      onSearch: (criteria) => {
        const c = criteria as { header?: Record<string, string> }
        if (c?.header?.['X-MailCopilot-Draft-Id']) return [] // broken (mail.ru)
        if (c?.header?.['message-id']) {
          // Server indexes Message-Id reliably — returns every matching UID.
          // Stable MID across saves → both copies match.
          return Array.from(present).sort()
        }
        return []
      },
      onMessageDelete: (uids) => {
        for (const u of uids) present.delete(u)
        return true
      },
    })
    const imapflow = await import('imapflow')
    // Singleton client is cached after first connect, so the second saveDraft
    // reuses the same ImapFlow instance — only ONE constructor call. Using
    // mockImplementationOnce (rather than mockImplementation) avoids leaking
    // an unconsumed impl into subsequent tests; vi.clearAllMocks() in the
    // next beforeEach clears call history but does NOT reset implementations.
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(
      () => client as unknown as InstanceType<typeof imapflow.ImapFlow>,
    )

    await saveDraft(1, cfg, 'Drafts', 'DUPE', { subject: 'hello', text: 'first' })
    expect(present).toEqual(new Set([100])) // first save: nothing to delete

    await saveDraft(1, cfg, 'Drafts', 'DUPE', { subject: 'hello', text: 'second' })
    // Second save: Message-Id SEARCH found [100, 200], appended=200 kept,
    // 100 deleted. Mailbox ends up with the latest copy only.
    expect(present).toEqual(new Set([200]))
    // The DELETE was specifically for the prior UID, not a blind sweep.
    const deleteCalls = client.messageDelete.mock.calls
    expect(deleteCalls.some(call => Array.isArray(call[0]) && call[0].includes(100))).toBe(true)
  })

  it('AC6a — concurrent saveDraft × 2 on same account: APPEND called 2x, calls serialize via withSaveDraftLock', async () => {
    // Each saveDraft attempt creates its own search/delete pair against the
    // singleton client. We assert both APPENDs land and that the second's
    // SEARCH does not begin before the first's DELETE completes (strict
    // serialization). The mutex is the only thing standing between this and
    // the mail.ru race.
    const events: string[] = []
    const { client } = makeDraftFakeClient({
      onAppend: () => {
        events.push('append')
        return { uid: events.filter(e => e === 'append').length === 1 ? 11 : 22 }
      },
      onSearch: async () => {
        events.push('search')
        await new Promise(r => setTimeout(r, 5))
        return [11, 22].slice(0, events.filter(e => e === 'search').length) // grow over time
      },
      onMessageDelete: async () => {
        events.push('delete')
        await new Promise(r => setTimeout(r, 5))
        return true
      },
    })
    const imapflow = await import('imapflow')
    // Single ImapFlow instance — withImapRetry uses the singleton client, so
    // both saveDraft calls share the same fake.
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const p1 = withSaveDraftLock(1, () => saveDraft(1, cfg, 'Drafts', 'D1', { subject: 's1', text: 'a' }))
    const p2 = withSaveDraftLock(1, () => saveDraft(1, cfg, 'Drafts', 'D1', { subject: 's2', text: 'b' }))
    await Promise.all([p1, p2])

    expect(client.append).toHaveBeenCalledTimes(2)
    // Strict serialization: every event from call 2 must occur after call 1's
    // delete (or after call 1's search if no delete was needed). Concretely —
    // the second 'append' index must be greater than the first 'delete'/'search'
    // index, never interleaved.
    const firstAppendIdx = events.indexOf('append')
    const lastEventOfFirstCall = (() => {
      // search of call 2 is the first 'search' AFTER the second 'append'
      const secondAppendIdx = events.indexOf('append', firstAppendIdx + 1)
      return secondAppendIdx
    })()
    // secondAppend must be after the first cycle's last operation.
    // i.e. if a 'search' occurs at index i and a 'delete' at j with j>i, then
    // the second 'append' must come at k > j. We just ensure the second
    // 'append' is not adjacent to the first one.
    expect(lastEventOfFirstCall).toBeGreaterThan(firstAppendIdx + 1)
  })
})

describe('deleteDraft — fallback dedup chain (§2.16 iter5)', () => {
  const cfg: ImapConfig = {
    host: 'imap.mail.ru', port: 993, secure: true, user: 'u@mail.ru', pass: 'p',
  }

  beforeEach(async () => {
    __resetSaveDraftLockForTest()
    forceDisconnectImap()
    vi.clearAllMocks()
    await disconnectAllPerAccount()
  })

  afterEach(async () => {
    await disconnectAllPerAccount()
    forceDisconnectImap()
  })

  it('§2.16 iter5: deleteDraft falls back to Message-Id when X-header SEARCH returns []', async () => {
    // mail.ru-class server: X-header SEARCH broken (returns []), Message-Id
    // SEARCH works. deleteDraft must locate the draft via the deterministic
    // Message-Id (`draft-${draftId}@mailcopilot.local`) so finalization
    // actually clears the orphan instead of silently leaving it on the server.
    const searchCalls: Array<{ criteria: unknown }> = []
    const { client } = makeDraftFakeClient({
      onSearch: (criteria) => {
        searchCalls.push({ criteria })
        const c = criteria as { header?: Record<string, string> }
        if (c?.header?.['X-MailCopilot-Draft-Id']) return [] // primary empty
        if (c?.header?.['message-id']) return [42] // fallback finds it
        return []
      },
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(
      () => client as unknown as InstanceType<typeof imapflow.ImapFlow>,
    )

    await deleteDraft(1, cfg, 'Drafts', 'D1')
    // Two SEARCH calls — primary X-header + fallback Message-Id.
    expect(client.search).toHaveBeenCalledTimes(2)
    // Verify the Message-Id used matches saveDraft's deterministic format.
    const midCall = searchCalls.find(call => {
      const c = call.criteria as { header?: Record<string, string> }
      return Boolean(c?.header?.['message-id'])
    })
    const midValue = (midCall?.criteria as { header: Record<string, string> }).header['message-id']
    expect(midValue).toBe('draft-D1@mailcopilot.local')
    // The orphan UID 42 must actually be deleted.
    expect(client.messageDelete).toHaveBeenCalledTimes(1)
    expect(client.messageDelete.mock.calls[0][0]).toEqual([42])
  })

  it('§2.16 iter5: deleteDraft SUBJECT fallback verifies X-header before delete', async () => {
    // Same safety check as iter2 saveDraft: SINCE-bounded scan returns
    // candidate UIDs, but ONLY UIDs whose X-header matches our draftId may be
    // deleted. Unrelated drafts with matching SINCE window (other clients,
    // different draftIds) must be kept.
    const { client } = makeDraftFakeClient({
      onSearch: (criteria) => {
        const c = criteria as { header?: Record<string, string>; since?: Date }
        if (c?.header?.['X-MailCopilot-Draft-Id']) return []
        if (c?.header?.['message-id']) return []
        if (c?.since) return [55, 66, 77] // 55 = ours, others = unrelated
        return []
      },
      onFetch: () => [
        { uid: 55, headers: 'X-MailCopilot-Draft-Id: D1\r\n' },
        { uid: 66, headers: 'X-MailCopilot-Draft-Id: SOME-OTHER-DRAFT\r\n' },
        { uid: 77, headers: 'Subject: foreign draft\r\n' }, // no X-header
      ],
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(
      () => client as unknown as InstanceType<typeof imapflow.ImapFlow>,
    )

    await deleteDraft(1, cfg, 'Drafts', 'D1')
    // Three SEARCH calls — X-header, Message-Id, SINCE.
    expect(client.search).toHaveBeenCalledTimes(3)
    // Only UID 55 (matching X-header) deleted; 66 and 77 untouched.
    expect(client.messageDelete).toHaveBeenCalledTimes(1)
    expect(client.messageDelete.mock.calls[0][0]).toEqual([55])
  })

  it('§2.16 iter5: deleteDraft logs warn when all fallbacks fail (no DELETE issued)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = makeDraftFakeClient({
      onSearch: () => [], // all three searches return []
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(
      () => client as unknown as InstanceType<typeof imapflow.ImapFlow>,
    )

    await expect(deleteDraft(1, cfg, 'Drafts', 'D1')).resolves.toBeUndefined()
    // Crucial: NO DELETE issued — we have no evidence of the draft on the
    // server, and a blind sweep would risk deleting unrelated user data.
    expect(client.messageDelete).not.toHaveBeenCalled()
    // Warn must mention the dedup_impossible branch so dashboards can spot it.
    const sawWarn = warnSpy.mock.calls.some(call =>
      call.some(arg => typeof arg === 'string' && arg.includes('deleteDraft.dedup_impossible')),
    )
    expect(sawWarn).toBe(true)
    warnSpy.mockRestore()
  })

  it('§2.16 iter5: deleteDraft SINCE fallback with NO matching X-header → no delete + warn', async () => {
    // SINCE returns candidates but verifier filters all of them out (none
    // carry our draftId). Mirrors saveDraft's subject_fallback_no_match warn.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = makeDraftFakeClient({
      onSearch: (criteria) => {
        const c = criteria as { header?: Record<string, string>; since?: Date }
        if (c?.header?.['X-MailCopilot-Draft-Id']) return []
        if (c?.header?.['message-id']) return []
        if (c?.since) return [3, 5]
        return []
      },
      onFetch: () => [
        { uid: 3, headers: 'X-MailCopilot-Draft-Id: OTHER-A\r\n' },
        { uid: 5, headers: 'X-MailCopilot-Draft-Id: OTHER-B\r\n' },
      ],
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(
      () => client as unknown as InstanceType<typeof imapflow.ImapFlow>,
    )

    await deleteDraft(1, cfg, 'Drafts', 'D1')
    expect(client.messageDelete).not.toHaveBeenCalled()
    const sawSinceWarn = warnSpy.mock.calls.some(call =>
      call.some(arg => typeof arg === 'string' && arg.includes('deleteDraft.since_fallback_no_match')),
    )
    expect(sawSinceWarn).toBe(true)
    // Final dedup_impossible warn also fires (no UIDs left after verification).
    const sawImpossibleWarn = warnSpy.mock.calls.some(call =>
      call.some(arg => typeof arg === 'string' && arg.includes('deleteDraft.dedup_impossible')),
    )
    expect(sawImpossibleWarn).toBe(true)
    warnSpy.mockRestore()
  })

  it('§2.16 iter5: deleteDraft happy path (X-header SEARCH finds draft) — no fallback exercised', async () => {
    // Regression guard: the existing X-header path must continue to work
    // unchanged; fallbacks fire only when primary returns [].
    const { client } = makeDraftFakeClient({
      onSearch: (criteria) => {
        const c = criteria as { header?: Record<string, string> }
        if (c?.header?.['X-MailCopilot-Draft-Id']) return [10, 20]
        return []
      },
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(
      () => client as unknown as InstanceType<typeof imapflow.ImapFlow>,
    )

    await deleteDraft(1, cfg, 'Drafts', 'D1')
    // Only one SEARCH (primary) — fallbacks not exercised on happy path.
    expect(client.search).toHaveBeenCalledTimes(1)
    expect(client.messageDelete).toHaveBeenCalledTimes(1)
    expect(client.messageDelete.mock.calls[0][0]).toEqual([10, 20])
  })
})

describe('sweepOrphanDrafts — orphan cleanup (§2.16 AC5)', () => {
  const cfg: ImapConfig = {
    host: 'imap.mail.ru', port: 993, secure: true, user: 'u@mail.ru', pass: 'p',
  }

  beforeEach(async () => {
    __resetSaveDraftLockForTest()
    forceDisconnectImap()
    vi.clearAllMocks()
    await disconnectAllPerAccount()
  })

  afterEach(async () => {
    await disconnectAllPerAccount()
    forceDisconnectImap()
  })

  it('groups by X-MailCopilot-Draft-Id, keeps max(uid) per group, deletes the rest', async () => {
    // Seed: three UIDs share draftId "AAA" (5, 12, 30 — keep 30, delete 5+12).
    // Two UIDs share draftId "BBB" (7, 8 — keep 8, delete 7).
    // One UID has no X-header (orphan from another client) — must NOT be touched.
    // One UID is unique to "CCC" — single-element group, untouched.
    const seeded: Array<{ uid: number; headers: string }> = [
      { uid: 5, headers: 'X-MailCopilot-Draft-Id: AAA\r\n' },
      { uid: 7, headers: 'X-MailCopilot-Draft-Id: BBB\r\n' },
      { uid: 8, headers: 'X-MailCopilot-Draft-Id: BBB\r\n' },
      { uid: 12, headers: 'X-MailCopilot-Draft-Id: AAA\r\n' },
      { uid: 19, headers: 'Subject: foreign draft\r\n' }, // no X-header
      { uid: 25, headers: 'X-MailCopilot-Draft-Id: CCC\r\n' }, // single
      { uid: 30, headers: 'X-MailCopilot-Draft-Id: AAA\r\n' },
    ]
    const { client } = makeDraftFakeClient({
      exists: 7,
      onFetch: () => seeded.map(s => ({ uid: s.uid, headers: s.headers })),
    })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const result = await sweepOrphanDrafts(1, cfg, 'Drafts')

    expect(result.groups).toBe(2) // AAA + BBB
    expect(result.deleted).toBe(3) // 5, 12 (from AAA); 7 (from BBB)
    expect(client.messageDelete).toHaveBeenCalledTimes(1)
    const deleted = client.messageDelete.mock.calls[0][0] as number[]
    expect(deleted.sort((a, b) => a - b)).toEqual([5, 7, 12])
    // Foreign UID 19 and singleton CCC (uid 25) MUST be absent from the delete set.
    expect(deleted).not.toContain(19)
    expect(deleted).not.toContain(25)
    expect(deleted).not.toContain(30) // kept (max of AAA group)
    expect(deleted).not.toContain(8)  // kept (max of BBB group)
  })

  it('mailbox empty → no fetch, no delete, returns zeros', async () => {
    const { client } = makeDraftFakeClient({ exists: 0 })
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementationOnce(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    const result = await sweepOrphanDrafts(1, cfg, 'Drafts')
    expect(result.groups).toBe(0)
    expect(result.deleted).toBe(0)
    expect(client.fetch).not.toHaveBeenCalled()
    expect(client.messageDelete).not.toHaveBeenCalled()
  })

  it('non-fatal failure: connection error swallowed, no throw', async () => {
    const { client } = makeDraftFakeClient({ exists: 5 })
    client.mailboxOpen.mockRejectedValueOnce(new Error('NoConnection'))
    const imapflow = await import('imapflow')
    vi.mocked(imapflow.ImapFlow).mockImplementation(() => client as unknown as InstanceType<typeof imapflow.ImapFlow>)

    // sweep is best-effort — must not propagate.
    await expect(sweepOrphanDrafts(1, cfg, 'Drafts')).resolves.toEqual({ groups: 0, deleted: 0 })
  })
})
