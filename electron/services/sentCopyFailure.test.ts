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
