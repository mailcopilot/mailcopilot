import { describe, expect, it } from 'vitest'
import {
  STARTTLS_REQUIRED_CODE,
  isDeliveryUndetermined,
  isPreGreetingFailure,
  isImapPreGreetingTimeout,
  isSmtpSessionError,
  isTlsUpgradeTimeout,
  isStarttlsRefusal,
  isImapConnectionFailure,
  isImapOutcomeUndetermined,
  markImapOutcomeUndetermined,
} from './transportFailure'

const err = (message: string, fields: object) => Object.assign(new Error(message), fields)
const aggregate = (errors: unknown[], message = '', extra: object = {}) => Object.assign(new Error(message), { name: 'AggregateError', errors, ...extra })

describe('isStarttlsRefusal', () => {
  it('recognises the nodemailer and ImapFlow refusal shapes', () => {
    expect(isStarttlsRefusal(err('Error upgrading connection with STARTTLS: 502 no', { code: 'ETLS', command: 'STARTTLS', response: '502 no' }))).toBe(true)
    expect(isStarttlsRefusal(err('Server does not support STARTTLS', { tlsFailed: true }))).toBe(true)
    expect(isStarttlsRefusal(err('EHLO failed but HELO does not support required STARTTLS. response=500', { code: 'ECONNECTION', command: 'EHLO' }))).toBe(true)
    expect(isStarttlsRefusal(err('x', { code: STARTTLS_REQUIRED_CODE }))).toBe(true)
  })

  it('does not mistake a failed handshake, an injection guard or an unrelated error for a refusal', () => {
    // Accepted STARTTLS, then the handshake failed: a certificate problem, no server reply text.
    expect(isStarttlsRefusal(err('Error initiating TLS - self signed certificate', { code: 'ETLS', command: 'STARTTLS' }))).toBe(false)
    expect(isStarttlsRefusal(err('Server sent data after the STARTTLS response', { code: 'STARTTLS_INJECTION', tlsFailed: true }))).toBe(false)
    expect(isStarttlsRefusal(err('Invalid login', { code: 'EAUTH', command: 'AUTH PLAIN' }))).toBe(false)
    expect(isStarttlsRefusal(null)).toBe(false)
    expect(isStarttlsRefusal('Server does not support STARTTLS')).toBe(false)
  })
})

describe('isPreGreetingFailure', () => {
  const stage = (code: string, extra: object = {}, message = 'x') => err(message, { code, command: 'CONN', ...extra })

  it('is true for connect-time socket errors whatever the errno, DNS failures and the two pre-greeting timers', () => {
    expect(isPreGreetingFailure(stage('ESOCKET', { syscall: 'connect' }, 'connect ENETUNREACH 2a00::1:465'))).toBe(true)
    expect(isPreGreetingFailure(stage('ESOCKET', { syscall: 'connect' }, 'connect EHOSTUNREACH 192.0.2.1:587'))).toBe(true)
    expect(isPreGreetingFailure(stage('EDNS'))).toBe(true)
    expect(isPreGreetingFailure(stage('ETIMEDOUT', {}, 'Connection timeout'))).toBe(true)
    expect(isPreGreetingFailure(stage('ETIMEDOUT', {}, 'Greeting never received'))).toBe(true)
  })

  it('does not call a silent close pre-greeting: nothing tells it from a close after the message was handed over', () => {
    expect(isPreGreetingFailure(stage('ECONNECTION', {}, 'Connection closed unexpectedly'))).toBe(false)
    expect(isPreGreetingFailure(new Error('Unexpected socket close'))).toBe(false)
  })

  it('is false once the server has spoken, and for certificate or non-library errors', () => {
    expect(isPreGreetingFailure(stage('ESOCKET', { syscall: 'read' }))).toBe(false)
    expect(isPreGreetingFailure(stage('ETIMEDOUT', {}, 'Timeout'))).toBe(false)
    expect(isPreGreetingFailure(stage('ETLS'))).toBe(false)
    expect(isPreGreetingFailure(err('connect ENETUNREACH', {}))).toBe(false)
  })
})

describe('isDeliveryUndetermined / isSmtpSessionError', () => {
  const stage = (code: string, extra: object = {}, message = 'x') => err(message, { code, command: 'CONN', ...extra })

  it('is true for a session that broke after the server was reached, with no reply code', () => {
    expect(isDeliveryUndetermined(stage('ETIMEDOUT', { timeoutType: 'SOCKET_TIMEOUT' }, 'Timeout'))).toBe(true)
    expect(isDeliveryUndetermined(stage('ETIMEDOUT', {}, 'Timeout'))).toBe(true)
    expect(isDeliveryUndetermined(stage('ESOCKET', { syscall: 'read' }, 'read ECONNRESET'))).toBe(true)
    expect(isDeliveryUndetermined(stage('ESOCKET', { syscall: 'write' }, 'write EPIPE'))).toBe(true)
    expect(isDeliveryUndetermined(stage('ECONNECTION', {}, 'Connection closed unexpectedly'))).toBe(true)
  })

  it('is false for everything the server answered, everything before the greeting and local failures', () => {
    // A reply code decides by itself.
    expect(isDeliveryUndetermined(stage('ECONNECTION', { responseCode: 421, response: '421 bye' }))).toBe(false)
    expect(isDeliveryUndetermined(err('x', { code: 'EMESSAGE', command: 'DATA', responseCode: 554 }))).toBe(false)
    // Before the greeting: its own, retryable verdict.
    expect(isDeliveryUndetermined(stage('ESOCKET', { syscall: 'connect' }, 'connect ECONNREFUSED'))).toBe(false)
    expect(isDeliveryUndetermined(stage('EDNS'))).toBe(false)
    expect(isDeliveryUndetermined(stage('ETIMEDOUT', { timeoutType: 'GREETING_TIMEOUT' }, 'Greeting never received'))).toBe(false)
    expect(isDeliveryUndetermined(stage('ETIMEDOUT', { timeoutType: 'CONNECT_TIMEOUT' }, 'Connection timeout'))).toBe(false)
    // Certificate, credentials, protocol and other stages.
    expect(isDeliveryUndetermined(stage('ETLS'))).toBe(false)
    // A certificate or pin rejection is reported by nodemailer as ESOCKET on CONN with the
    // TLS code in originalCode and NO syscall: nothing was sent, so it is not "unknown".
    expect(isDeliveryUndetermined(stage('ESOCKET', { originalCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'self-signed certificate'))).toBe(false)
    expect(isDeliveryUndetermined(stage('ESOCKET', {}, 'TLS pin mismatch: expected 1 pinned fingerprint'))).toBe(false)
    expect(isDeliveryUndetermined(err('x', { code: 'EAUTH', command: 'AUTH PLAIN' }))).toBe(false)
    expect(isDeliveryUndetermined(err('x', { code: 'ECONNECTION', command: 'EHLO' }))).toBe(false)
    // Not from the session at all, and values that are not errors.
    expect(isDeliveryUndetermined(new Error('read ECONNRESET'))).toBe(false)
    expect(isDeliveryUndetermined(new Error('Connection closed unexpectedly'))).toBe(false)
    expect(isDeliveryUndetermined('Connection closed')).toBe(false)
    expect(isDeliveryUndetermined(null)).toBe(false)
  })

  it('reads the session boundary from the stage, not from words', () => {
    expect(isSmtpSessionError(stage('EAUTH'))).toBe(true)
    expect(isSmtpSessionError(new Error('Connection closed'))).toBe(false)
    expect(isSmtpSessionError(new Error('read ECONNRESET'))).toBe(false)
    expect(isSmtpSessionError(err('fetch failed', { code: 'ETIMEDOUT' }))).toBe(false)
    expect(isSmtpSessionError(undefined)).toBe(false)
  })
})

describe('multi-address connect failures and the TLS upgrade timer', () => {
  const aggregate = (members: object[], fields: object = {}) =>
    Object.assign(new Error(''), {
      name: 'AggregateError',
      code: 'ESOCKET',
      originalCode: 'ECONNREFUSED',
      command: 'CONN',
      errors: members.map((m) => Object.assign(new Error('connect ECONNREFUSED'), m)),
      ...fields,
    })
  const refused = { code: 'ECONNREFUSED', syscall: 'connect' }

  it('an aggregate in which every attempt failed in connect(2) is a failure before the greeting', () => {
    const err = aggregate([refused, { code: 'ENETUNREACH', syscall: 'connect' }])
    expect(isPreGreetingFailure(err)).toBe(true)
    // It names no syscall of its own and must not read as a broken session.
    expect(isDeliveryUndetermined(err)).toBe(false)
  })

  it('a mixed, empty or unmarked aggregate is not', () => {
    expect(isPreGreetingFailure(aggregate([refused, { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }]))).toBe(false)
    expect(isPreGreetingFailure(aggregate([refused, { code: 'ECONNRESET', syscall: 'read' }]))).toBe(false)
    expect(isPreGreetingFailure(aggregate([]))).toBe(false)
    expect(isPreGreetingFailure(aggregate([refused], { errors: 'not a list' }))).toBe(false)
    expect(isPreGreetingFailure(aggregate([refused], { command: 'EHLO' }))).toBe(false)
    expect(isPreGreetingFailure(aggregate([refused], { code: 'ETLS' }))).toBe(false)
  })

  it('only the TLS handshake timer is the upgrade timeout; the socket timer is not', () => {
    const timer = (timeoutType: string, message: string) => err(message, { code: 'ETIMEDOUT', command: 'CONN', timeoutType })
    expect(isTlsUpgradeTimeout(timer('UPGRADE_TIMEOUT', 'TLS handshake timed out'))).toBe(true)
    expect(isTlsUpgradeTimeout(err('TLS handshake timed out', { code: 'ETIMEDOUT', command: 'CONN' }))).toBe(true)
    expect(isTlsUpgradeTimeout(timer('SOCKET_TIMEOUT', 'Timeout'))).toBe(false)
    expect(isTlsUpgradeTimeout(timer('GREETING_TIMEOUT', 'Greeting never received'))).toBe(false)
    expect(isTlsUpgradeTimeout(err('TLS handshake timed out', { code: 'ETIMEDOUT', command: 'DATA' }))).toBe(false)
    expect(isTlsUpgradeTimeout(err('TLS handshake timed out', {}))).toBe(false)
    expect(isTlsUpgradeTimeout(null)).toBe(false)
    // It is not a pre-greeting failure and not an unknown delivery: the greeting happened, nothing was sent.
    const upgrade = timer('UPGRADE_TIMEOUT', 'TLS handshake timed out')
    expect(isPreGreetingFailure(upgrade)).toBe(false)
    expect(isDeliveryUndetermined(upgrade)).toBe(false)
  })
})

describe('isImapConnectionFailure (structural retry classification)', () => {
  const node = (code: string, syscall = 'connect') => Object.assign(new Error(`${syscall} ${code} 203.0.113.7:993`), { code, syscall })

  it('recognises an empty-message AggregateError by the codes of its members', () => {
    // What Node raises when every address of a multi-address connect failed:
    // the message is empty, the diagnosis is on errors[].
    const agg = Object.assign(aggregate([node('ECONNREFUSED'), node('ENETUNREACH')], ''), { code: 'ECONNREFUSED' })
    expect(agg.message).toBe('')
    expect(isImapConnectionFailure(agg)).toBe(true)
    // Even when the aggregate itself carries no code.
    expect(isImapConnectionFailure(aggregate([node('ENETUNREACH')], ''))).toBe(true)
  })

  it.each(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'NoConnection', 'EConnectionClosed', 'ClosedAfterConnectTLS'])(
    'treats %s as a connection failure by code, whatever the prose says',
    (code) => {
      expect(isImapConnectionFailure(Object.assign(new Error('something unrelated'), { code }))).toBe(true)
    },
  )

  it('finds the code on a cause chain', () => {
    expect(isImapConnectionFailure(Object.assign(new Error('wrapped'), { cause: node('ECONNRESET', 'read') }))).toBe(true)
  })

  it('does not retry ImapFlow wait timers that already spent their whole budget', () => {
    for (const code of ['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEOUT']) {
      expect(isImapConnectionFailure(Object.assign(new Error('Failed to establish connection in required time'), { code }))).toBe(false)
    }
  })

  it('does not retry a server verdict, an authentication failure or a certificate failure', () => {
    expect(isImapConnectionFailure(Object.assign(new Error('Command failed'), { code: 'NoConnection', authenticationFailed: true }))).toBe(false)
    expect(isImapConnectionFailure(Object.assign(new Error('Command failed'), { responseStatus: 'NO', serverResponseCode: 'NONEXISTENT' }))).toBe(false)
    expect(isImapConnectionFailure(Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }))).toBe(false)
    expect(isImapConnectionFailure(aggregate([Object.assign(new Error('x'), { code: 'EAUTH' })], ''))).toBe(false)
  })

  it('falls back to the legacy text match only for errors that carry no code anywhere', () => {
    expect(isImapConnectionFailure(new Error('Unexpected close'))).toBe(true)
    expect(isImapConnectionFailure(new Error('NoConnection'))).toBe(true)
    expect(isImapConnectionFailure(new Error('Invalid credentials'))).toBe(false)
    // A node with a code is judged by the code: prose that happens to say "closed" is not enough.
    expect(isImapConnectionFailure(Object.assign(new Error('mailbox closed'), { code: 'SOMETHING_ELSE' }))).toBe(false)
    expect(isImapConnectionFailure(null)).toBe(false)
    expect(isImapConnectionFailure(undefined)).toBe(false)
  })
})

describe('imap outcome-undetermined marker', () => {
  it('rides beside the original error and is found through a cause chain', () => {
    const original = new Error('Unexpected close')
    expect(isImapOutcomeUndetermined(original)).toBe(false)
    markImapOutcomeUndetermined(original)
    expect(isImapOutcomeUndetermined(original)).toBe(true)
    expect(isImapOutcomeUndetermined(Object.assign(new Error('wrapper'), { cause: original }))).toBe(true)
    expect(isImapOutcomeUndetermined(new Error('unrelated'))).toBe(false)
  })

  it('ignores primitives without throwing', () => {
    markImapOutcomeUndetermined('boom')
    markImapOutcomeUndetermined(null)
    expect(isImapOutcomeUndetermined('boom')).toBe(false)
  })
})

describe('isImapPreGreetingTimeout', () => {
  const withCode = (code: string) => Object.assign(new Error('x'), { code })

  it('is true for the two ImapFlow timers that fire before the greeting', () => {
    expect(isImapPreGreetingTimeout(withCode('GREETING_TIMEOUT'))).toBe(true)
    expect(isImapPreGreetingTimeout(withCode('CONNECT_TIMEOUT'))).toBe(true)
  })

  it('finds the code on a wrapped cause', () => {
    expect(isImapPreGreetingTimeout(Object.assign(new Error('wrapper'), { cause: withCode('GREETING_TIMEOUT') }))).toBe(true)
  })

  it('is false once the server had greeted us, and for prose alone', () => {
    expect(isImapPreGreetingTimeout(withCode('ETIMEOUT'))).toBe(false)
    expect(isImapPreGreetingTimeout(withCode('UPGRADE_TIMEOUT'))).toBe(false)
    expect(isImapPreGreetingTimeout(new Error('GREETING_TIMEOUT'))).toBe(false)
    expect(isImapPreGreetingTimeout(undefined)).toBe(false)
  })
})
