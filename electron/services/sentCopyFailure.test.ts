import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * §2.23 PR1 — unit tests for the Sent-copy APPEND failure reporting service.
 *
 * Covers:
 *   - classifySentCopyAppendFailure: every reason bucket, precedence order,
 *     and null/undefined/non-object safety.
 *   - normalizeSentCopyProviderId: closed-domain narrowing.
 *   - reportSentCopyAppendFailure: typed metric emission, broadcast payload
 *     shape (PII boundary — exactly { accountId, folder }, nothing else),
 *     and the fire-and-forget contract (a throwing broadcast or a throwing
 *     recordEvent must never propagate into the send path).
 */

const recordEventMock = vi.hoisted(() => vi.fn())
vi.mock('../metrics', () => ({ recordEvent: recordEventMock }))

import {
  buildSentCopyAppendDiag,
  classifySentCopyAppendFailure,
  normalizeSentCopyProviderId,
  reportSentCopyAppendFailure,
} from './sentCopyFailure'

function imapErr(fields: Record<string, unknown>): Error {
  return Object.assign(new Error(String(fields.message ?? 'Command failed')), fields)
}

describe('classifySentCopyAppendFailure', () => {
  describe('RFC 5530 serverResponseCode (highest precedence)', () => {
    it.each([
      ['AUTHENTICATIONFAILED', 'auth'],
      ['AUTHORIZATIONFAILED', 'auth'],
      ['EXPIRED', 'auth'],
      ['PRIVACYREQUIRED', 'auth'],
      ['OVERQUOTA', 'quota'],
      ['TOOBIG', 'too_big'],
      ['LIMIT', 'too_big'],
    ])('maps serverResponseCode=%s to %s', (serverResponseCode, expected) => {
      expect(classifySentCopyAppendFailure(imapErr({ serverResponseCode }))).toBe(expected)
    })

    it('is case-insensitive on serverResponseCode', () => {
      expect(classifySentCopyAppendFailure(imapErr({ serverResponseCode: 'OverQuota' }))).toBe('quota')
    })

    it('wins over a NO responseStatus on the same error', () => {
      expect(classifySentCopyAppendFailure(
        imapErr({ serverResponseCode: 'OVERQUOTA', responseStatus: 'NO' }),
      )).toBe('quota')
    })
  })

  describe('socket-level error codes', () => {
    it.each([
      'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
      'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH',
      'ENETUNREACH', 'ENETDOWN',
      'NoConnectionAvailable', 'NoConnection',
    ])(
      'maps code=%s to network',
      (code) => {
        expect(classifySentCopyAppendFailure(imapErr({ code }))).toBe('network')
      },
    )

    it('does not match partial codes (anchored regex)', () => {
      expect(classifySentCopyAppendFailure(imapErr({ code: 'XETIMEDOUTX' }))).toBe('unknown')
    })
  })

  describe('message heuristics', () => {
    it('classifies auth failures thrown as plain Errors (assertImapAuth path)', () => {
      expect(classifySentCopyAppendFailure(new Error('Invalid credentials (Failure)'))).toBe('auth')
      expect(classifySentCopyAppendFailure(new Error('XOAUTH2 token rejected'))).toBe('auth')
    })

    it('classifies password and login keyword errors as auth', () => {
      expect(classifySentCopyAppendFailure(new Error('Wrong password for IMAP account'))).toBe('auth')
      expect(classifySentCopyAppendFailure(new Error('Login failed — check your settings'))).toBe('auth')
    })

    it('classifies quota / size / network message text', () => {
      expect(classifySentCopyAppendFailure(new Error('Quota exceeded for mailbox'))).toBe('quota')
      expect(classifySentCopyAppendFailure(new Error('APPEND failed: message too large'))).toBe('too_big')
      expect(classifySentCopyAppendFailure(new Error('Socket timeout while writing literal'))).toBe('network')
    })

    it('classifies storage limit and mailbox full variants as quota', () => {
      expect(classifySentCopyAppendFailure(new Error('Over storage limit for this account'))).toBe('quota')
      expect(classifySentCopyAppendFailure(new Error('Mailbox is full, cannot APPEND'))).toBe('quota')
    })

    it('classifies toobig and message size text variants as too_big', () => {
      expect(classifySentCopyAppendFailure(new Error('APPEND rejected: toobig'))).toBe('too_big')
      expect(classifySentCopyAppendFailure(new Error('Message size exceeds server limit'))).toBe('too_big')
    })
  })

  describe('responseStatus fallback', () => {
    it.each(['NO', 'BAD', 'no', 'bad'])('maps unparsed %s reply to server_refused', (responseStatus) => {
      expect(classifySentCopyAppendFailure(imapErr({ message: 'Command failed', responseStatus }))).toBe('server_refused')
    })
  })

  describe('unknown / defensive paths', () => {
    it('returns unknown for an opaque Error', () => {
      expect(classifySentCopyAppendFailure(new Error('Command failed'))).toBe('unknown')
    })

    it.each([null, undefined, 42, 'boom', {}])('never throws on non-Error input %j', (input) => {
      expect(() => classifySentCopyAppendFailure(input)).not.toThrow()
      expect(classifySentCopyAppendFailure(input)).toBe('unknown')
    })

    it('ignores non-string code/responseStatus/serverResponseCode fields', () => {
      expect(classifySentCopyAppendFailure(imapErr({
        message: 'Command failed', code: 123, responseStatus: { weird: true }, serverResponseCode: ['OVERQUOTA'],
      }))).toBe('unknown')
    })
  })
})

describe('normalizeSentCopyProviderId', () => {
  it.each(['gmail', 'outlook', 'generic-imap'] as const)('passes through %s', (p) => {
    expect(normalizeSentCopyProviderId(p)).toBe(p)
  })

  it.each([null, undefined, '', 'icloud', 'GMAIL', 'user@example.com'])(
    'maps %j to unknown',
    (p) => {
      expect(normalizeSentCopyProviderId(p as string | null | undefined)).toBe('unknown')
    },
  )
})

describe('reportSentCopyAppendFailure', () => {
  beforeEach(() => {
    recordEventMock.mockReset()
  })

  it('emits the typed metric with enum-bucket tags only', () => {
    const broadcastFn = vi.fn()
    reportSentCopyAppendFailure(
      imapErr({ serverResponseCode: 'OVERQUOTA', message: 'NO [OVERQUOTA] user.alice@example.com is over quota' }),
      { accountId: 7, providerId: 'gmail', sentFolder: '[Gmail]/Sent Mail' },
      broadcastFn,
    )
    expect(recordEventMock).toHaveBeenCalledTimes(1)
    expect(recordEventMock).toHaveBeenCalledWith('send_queue.append_failed', {
      reason: 'quota',
      provider_id: 'gmail',
    })
    // PII boundary: the raw message (which carries an email address here)
    // must never reach the tags.
    const tags = recordEventMock.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(tags).sort()).toEqual(['provider_id', 'reason'])
    expect(JSON.stringify(tags)).not.toContain('example.com')
  })

  it('broadcasts mail:sentCopyFailed with exactly { accountId, folder }', () => {
    const broadcastFn = vi.fn()
    reportSentCopyAppendFailure(
      new Error('Command failed'),
      { accountId: 3, providerId: 'generic-imap', sentFolder: 'Отправленные' },
      broadcastFn,
    )
    expect(broadcastFn).toHaveBeenCalledTimes(1)
    expect(broadcastFn).toHaveBeenCalledWith('mail:sentCopyFailed', {
      accountId: 3,
      folder: 'Отправленные',
    })
    const payload = broadcastFn.mock.calls[0][1] as Record<string, unknown>
    // No messageId / recipients / subject / body / raw error text.
    expect(Object.keys(payload).sort()).toEqual(['accountId', 'folder'])
  })

  it('sends folder: null when the Sent folder was never resolved', () => {
    const broadcastFn = vi.fn()
    reportSentCopyAppendFailure(new Error('boom'), { accountId: 1 }, broadcastFn)
    expect(broadcastFn).toHaveBeenCalledWith('mail:sentCopyFailed', { accountId: 1, folder: null })
  })

  it('swallows a throwing broadcastFn (fire-and-forget contract)', () => {
    const broadcastFn = vi.fn(() => { throw new Error('window destroyed') })
    expect(() =>
      reportSentCopyAppendFailure(new Error('boom'), { accountId: 1 }, broadcastFn),
    ).not.toThrow()
    expect(recordEventMock).toHaveBeenCalledTimes(1)
  })

  it('still broadcasts when recordEvent throws (belt-and-braces guard)', () => {
    recordEventMock.mockImplementationOnce(() => { throw new Error('telemetry exploded') })
    const broadcastFn = vi.fn()
    expect(() =>
      reportSentCopyAppendFailure(new Error('boom'), { accountId: 2 }, broadcastFn),
    ).not.toThrow()
    expect(broadcastFn).toHaveBeenCalledTimes(1)
  })

  // §2.23 codex Low — no deduplication or swallowing across consecutive calls.
  // reportSentCopyAppendFailure is stateless and fire-and-forget; calling it
  // twice in the same session (e.g. two accounts fail their APPEND in rapid
  // succession) must produce two independent metric events and two broadcasts.
  it('two consecutive calls with different reason/folder produce two independent events and broadcasts', () => {
    const broadcastFn = vi.fn()

    reportSentCopyAppendFailure(
      imapErr({ serverResponseCode: 'OVERQUOTA', message: 'NO [OVERQUOTA] Quota exceeded' }),
      { accountId: 1, providerId: 'gmail', sentFolder: '[Gmail]/Sent Mail' },
      broadcastFn,
    )
    reportSentCopyAppendFailure(
      imapErr({ code: 'ECONNRESET', message: 'Connection reset by peer' }),
      { accountId: 2, providerId: 'outlook', sentFolder: 'Sent Items' },
      broadcastFn,
    )

    expect(recordEventMock).toHaveBeenCalledTimes(2)
    expect(broadcastFn).toHaveBeenCalledTimes(2)

    // First call: OVERQUOTA → quota reason, gmail provider.
    expect(recordEventMock).toHaveBeenNthCalledWith(1, 'send_queue.append_failed', {
      reason: 'quota',
      provider_id: 'gmail',
    })
    // Second call: ECONNRESET → network reason, outlook provider.
    expect(recordEventMock).toHaveBeenNthCalledWith(2, 'send_queue.append_failed', {
      reason: 'network',
      provider_id: 'outlook',
    })

    expect(broadcastFn).toHaveBeenNthCalledWith(1, 'mail:sentCopyFailed', {
      accountId: 1,
      folder: '[Gmail]/Sent Mail',
    })
    expect(broadcastFn).toHaveBeenNthCalledWith(2, 'mail:sentCopyFailed', {
      accountId: 2,
      folder: 'Sent Items',
    })
  })
})

// §2.82 iter2 finding 1 — the diagnostics payload. Before the fix the caller
// built this inline in electron/main.ts and it carried the Sent folder NAME,
// the Message-ID, and up to 500 characters of raw IMAP response. The consent
// screen promises, without qualification, that folder names and addresses are
// never sent, so a single account with a persistently failing APPEND turned
// that promise into a standing leak requiring no user action to trigger.
describe('buildSentCopyAppendDiag — PII boundary', () => {
  const FOLDER = 'Отправленные/Архив 2026'
  const MESSAGE_ID = '<9f2c@mail.ivanov-family.example>'

  function fullDiag() {
    return buildSentCopyAppendDiag(
      imapErr({
        message: `APPEND to "${FOLDER}" failed for ivan@example.com`,
        code: 'NO',
        response: `NO [OVERQUOTA] ${FOLDER} over quota for ivan@example.com`,
        responseText: `${FOLDER} over quota`,
        responseStatus: 'NO',
        serverResponseCode: 'OVERQUOTA',
        command: 'APPEND',
      }),
      {
        accountId: 12,
        providerId: 'generic-imap',
        sentFolder: FOLDER,
        rawSize: 4096,
        messageId: MESSAGE_ID,
      },
    )
  }

  it('carries no folder name, no Message-ID and no server text', () => {
    const serialized = JSON.stringify(fullDiag())
    expect(serialized).not.toContain(FOLDER)
    expect(serialized).not.toContain('Отправленные')
    expect(serialized).not.toContain('Архив')
    expect(serialized).not.toContain(MESSAGE_ID)
    expect(serialized).not.toContain('9f2c')
    expect(serialized).not.toContain('ivanov-family')
    expect(serialized).not.toContain('ivan@example.com')
    expect(serialized).not.toContain('over quota')
  })

  it('substitutes the folder ROLE and the folder name length', () => {
    const diag = fullDiag()
    expect(diag.sentFolderRole).toBe('sent')
    expect(diag.sentFolderLen).toBe(FOLDER.length)
  })

  it('substitutes an irreversible, domain-separated hash for the Message-ID', () => {
    const diag = fullDiag()
    expect(diag.messageIdHash).toMatch(/^[0-9a-f]{12}$/)
    // Stable for the same id (so repeated failures of ONE message collapse)…
    expect(buildSentCopyAppendDiag(null, { accountId: 1, messageId: MESSAGE_ID }).messageIdHash)
      .toBe(diag.messageIdHash)
    // …and different for a different id.
    expect(buildSentCopyAppendDiag(null, { accountId: 1, messageId: '<other@x.example>' }).messageIdHash)
      .not.toBe(diag.messageIdHash)
  })

  it('substitutes a length for the free-form server text', () => {
    const diag = fullDiag()
    expect(typeof diag.errorTextLen).toBe('number')
    expect(diag.errorTextLen).toBeGreaterThan(0)
  })

  // §2.82 iter3 finding 1 — the four structured fields are gated by CLOSED
  // VOCABULARIES, not by a token SHAPE. `/^[A-Za-z0-9_-]{1,40}$/` accepted
  // `ALICE`, `SENT` and `IVANOV`, so a mailbox name or a person's name landing
  // in a "response code" field shipped as protocol diagnostics — the same leak
  // this builder exists to prevent, through a different door.
  it('drops short server-chosen words that merely LOOK like protocol codes', () => {
    const IMPOSTORS = ['ALICE', 'SENT', 'IVANOV', 'Отправленные', 'Alice', 'sent-2026', 'INBOX_PRIVATE']
    for (const impostor of IMPOSTORS) {
      const diag = buildSentCopyAppendDiag(
        imapErr({
          message: 'Command failed',
          code: impostor,
          responseStatus: impostor,
          serverResponseCode: impostor,
          command: impostor,
        }),
        { accountId: 7 },
      )
      expect(diag.errorCode).toBeUndefined()
      expect(diag.errorResponseStatus).toBeUndefined()
      expect(diag.errorServerResponseCode).toBeUndefined()
      expect(diag.errorCommand).toBeUndefined()
      // Serialize only the protocol fields: `sentFolderRole` legitimately
      // contains the substring "sent" and would confuse a whole-object scan.
      const protocolFields = JSON.stringify({
        errorCode: diag.errorCode,
        errorResponseStatus: diag.errorResponseStatus,
        errorServerResponseCode: diag.errorServerResponseCode,
        errorCommand: diag.errorCommand,
      }).toUpperCase()
      expect(protocolFields).not.toContain(impostor.toUpperCase())
    }
  })

  it('keeps a real code only in the field whose vocabulary contains it', () => {
    // `OVERQUOTA` is a response code, not a socket error code and not a
    // command — membership is per field, not one shared bag of "known words".
    const diag = buildSentCopyAppendDiag(
      imapErr({ code: 'OVERQUOTA', responseStatus: 'APPEND', serverResponseCode: 'ETIMEDOUT', command: 'NO' }),
      { accountId: 1 },
    )
    expect(diag.errorCode).toBeUndefined()
    expect(diag.errorResponseStatus).toBeUndefined()
    expect(diag.errorServerResponseCode).toBeUndefined()
    expect(diag.errorCommand).toBeUndefined()
  })

  it('keeps recognised protocol codes and drops everything else', () => {
    const diag = buildSentCopyAppendDiag(
      imapErr({
        message: 'nope',
        code: 'ETIMEDOUT',
        responseStatus: 'no',
        serverResponseCode: 'OVERQUOTA',
        command: 'APPEND',
      }),
      { accountId: 1 },
    )
    expect(diag.errorCode).toBe('ETIMEDOUT')
    expect(diag.errorResponseStatus).toBe('NO')
    expect(diag.errorServerResponseCode).toBe('OVERQUOTA')
    expect(diag.errorCommand).toBe('APPEND')

    // An allowlist, not a blocklist: a server that puts an address or a folder
    // path where a code belongs gets dropped, not forwarded.
    const hostile = buildSentCopyAppendDiag(
      imapErr({
        code: 'user ivan@example.com is over quota',
        responseStatus: 'NO [OVERQUOTA] Отправленные',
        command: 'APPEND "Отправленные"',
        serverResponseCode: 'a'.repeat(64),
      }),
      { accountId: 1 },
    )
    expect(hostile.errorCode).toBeUndefined()
    expect(hostile.errorResponseStatus).toBeUndefined()
    expect(hostile.errorCommand).toBeUndefined()
    expect(hostile.errorServerResponseCode).toBeUndefined()
    expect(JSON.stringify(hostile)).not.toContain('ivan@example.com')
  })

  it('reports a null role when folder resolution never happened', () => {
    const diag = buildSentCopyAppendDiag(new Error('Invalid credentials'), {
      accountId: 3,
      providerId: 'gmail',
      sentFolder: null,
    })
    expect(diag.sentFolderRole).toBeNull()
    expect(diag.sentFolderLen).toBeUndefined()
    expect(diag.rawSize).toBeNull()
    expect(diag.reason).toBe('auth')
  })

  it('narrows an unexpected providerId to the closed domain', () => {
    expect(buildSentCopyAppendDiag(null, { accountId: 1, providerId: 'yandex' }).providerId)
      .toBe('unknown')
  })

  it('never throws on hostile or degenerate input', () => {
    for (const e of [null, undefined, 42, 'boom', { message: { nested: true } }]) {
      expect(() => buildSentCopyAppendDiag(e, { accountId: 1 })).not.toThrow()
    }
    expect(buildSentCopyAppendDiag(null, { accountId: 1 }).messageIdHash).toBeUndefined()
  })
})
