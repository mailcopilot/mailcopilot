// Real-library tests: the installed nodemailer and ImapFlow talk to raw local
// servers. A mocked constructor would only prove that an option was passed; the
// requirement is about what the libraries DO when the server never offers TLS,
// so every assertion here is about bytes the server saw.
import { afterEach, describe, expect, it, vi } from 'vitest'
// imap.ts imports the SQLite layer (a native module built for Electron's ABI);
// nothing in these tests touches it.
vi.mock('../db', () => ({}))

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import type { AddressInfo } from 'node:net'
import nodemailer from 'nodemailer'
import * as nodemailerShared from 'nodemailer/lib/shared'
import { ImapFlow } from 'imapflow'
import { __testOnly, classifySmtpError, finalSendFailureText, sendMail, testSmtpConnection } from './smtp'
import { testImapConnection } from './imap'
import { isDeliveryUndetermined, isPreGreetingFailure, isStarttlsRefusal, isTlsUpgradeTimeout } from '@mailcopilot/core/transportFailure'
import { decodeErrorPresentation, classifyErrorPresentation } from '@mailcopilot/core/errorPresentation'

// Self-signed P-256 certificate for CN=localhost / 127.0.0.1, valid until 2126.
const CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUe7O1zl0EPagr9e5/e/nBT6w7j/gwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwNDA4MjA1NloYDzIxMjYxMDEx
MDgyMDU2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATnXQay8TAFk6r1xgPQz1zEX6O4VCRJsjjIJj5H7OG1ImwnuIYUx1dX
ER1PMtuG36VxRW88HuMMyvs2Rz9fFY2to28wbTAdBgNVHQ4EFgQUzwpxW/YqbjSF
GathhZwqqEvBg6cwHwYDVR0jBBgwFoAUzwpxW/YqbjSFGathhZwqqEvBg6cwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIgPidcNoRWPYbO85sta+REk1dI8I6O5inXsHQBFcBO+4sCIQC2
AIOppvCwlqEh+W0MCqGwtkBGiJ2r3fvP+odUx+Vzrg==
-----END CERTIFICATE-----
`
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguOasucezz8VyHIG5
xJQLGwnCZ0gBCQcXiy4ir8Iou9WhRANCAATnXQay8TAFk6r1xgPQz1zEX6O4VCRJ
sjjIJj5H7OG1ImwnuIYUx1dXER1PMtuG36VxRW88HuMMyvs2Rz9fFY2t
-----END PRIVATE KEY-----
`

type Seen = { phase: 'plain' | 'tls'; verb: string }
type Mode = 'no-starttls' | 'starttls'

const closers: Array<() => void> = []
afterEach(() => {
  while (closers.length) closers.pop()!()
})

/** Line-based fake mail server. `proto` decides the dialect; `seen` records the
 *  first word of every command and whether it arrived before or after TLS. */
function startServer(proto: 'smtp' | 'imap', mode: Mode, opts: { immediateTls?: boolean } = {}) {
  const seen: Seen[] = []
  let connections = 0
  const handle = (socket: net.Socket, phase: Seen['phase']) => {
    let buf = ''
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1')
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const [first, second] = line.split(' ')
        const verb = (proto === 'imap' ? second : first || '').toUpperCase()
        seen.push({ phase, verb })
        const tag = proto === 'imap' ? first : ''
        const upgrade = () => {
          const secured = new tls.TLSSocket(socket, { isServer: true, key: KEY, cert: CERT })
          handle(secured, 'tls')
        }
        if (proto === 'smtp') {
          if (verb === 'EHLO' || verb === 'HELO') {
            const starttls = mode === 'starttls' && phase === 'plain' ? '250-STARTTLS\r\n' : ''
            socket.write(`250-localhost\r\n250-AUTH PLAIN LOGIN\r\n${starttls}250 OK\r\n`)
          } else if (verb === 'STARTTLS') {
            if (mode === 'starttls') { socket.write('220 Ready\r\n'); upgrade() } else socket.write('502 5.5.1 not implemented\r\n')
          } else if (verb === 'AUTH') socket.write('235 ok\r\n')
          else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end() }
          else socket.write('250 OK\r\n')
        } else if (verb === 'CAPABILITY') {
          const starttls = mode === 'starttls' && phase === 'plain' ? ' STARTTLS' : ''
          socket.write(`* CAPABILITY IMAP4rev1${starttls} AUTH=PLAIN\r\n${tag} OK done\r\n`)
        } else if (verb === 'STARTTLS') {
          if (mode === 'starttls') { socket.write(`${tag} OK begin TLS\r\n`); upgrade() } else socket.write(`${tag} NO no\r\n`)
        } else if (verb === 'LOGOUT') { socket.write(`* BYE\r\n${tag} OK\r\n`); socket.end() }
        else socket.write(`${tag} NO [AUTHENTICATIONFAILED] rejected\r\n`)
      }
    })
  }
  const imapCaps = `IMAP4rev1${mode === 'starttls' && !opts.immediateTls ? ' STARTTLS' : ''} AUTH=PLAIN`
  const greeting = proto === 'smtp' ? '220 localhost ESMTP\r\n' : `* OK [CAPABILITY ${imapCaps}] ready\r\n`
  const onConn = (socket: net.Socket) => {
    connections += 1
    handle(socket, opts.immediateTls ? 'tls' : 'plain')
    socket.write(greeting)
  }
  const server = opts.immediateTls
    ? tls.createServer({ key: KEY, cert: CERT }, onConn)
    : net.createServer(onConn)
  closers.push(() => server.close())
  return new Promise<{ port: number; seen: Seen[]; connections: () => number }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as AddressInfo).port, seen, connections: () => connections }),
    ),
  )
}
/** Implicit-TLS SMTP server that takes the WHOLE message (DATA ended by the lone
 *  dot) and then, instead of the 250 reply, stays silent, closes cleanly, or
 *  resets the connection. `dataTerminated` proves the message really arrived. */
async function startDataTakingServer(after: 'silent' | 'end' | 'reset') {
  const state = { connections: 0, dataTerminated: 0, rawData: '' }
  const server = tls.createServer({ key: KEY, cert: CERT }, (socket) => {
    state.connections += 1
    let buf = ''
    let inData = false
    socket.on('error', () => {})
    socket.write('220 localhost ESMTP\r\n')
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1')
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (inData) {
          if (line !== '.') state.rawData += `${line}\r\n`
          if (line === '.') {
            state.dataTerminated += 1
            if (after === 'end') socket.end()
            else if (after === 'reset') ((socket as unknown as { _parent?: net.Socket })._parent ?? socket).resetAndDestroy()
          }
          continue
        }
        const verb = line.split(' ')[0].toUpperCase()
        if (verb === 'EHLO') socket.write('250-localhost\r\n250 AUTH PLAIN\r\n')
        else if (verb === 'AUTH') socket.write('235 ok\r\n')
        else if (verb === 'DATA') { socket.write('354 go\r\n'); inData = true }
        else socket.write('250 OK\r\n')
      }
    })
  })
  closers.push(() => server.close())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, state }
}
const fingerprint = new crypto.X509Certificate(CERT).fingerprint256
const trust = { tlsPinsSha256: [fingerprint], tlsPinnedCertsPem: [CERT] }
const smtpCfg = (port: number, secure: boolean) => ({ host: '127.0.0.1', port, secure, user: 'u', pass: 'p', ...trust })
const imapCfg = (port: number, secure: boolean) => ({ host: '127.0.0.1', port, secure, user: 'u', pass: 'p', ...trust })
/** Preconditions for every "nothing was sent" check: an empty `seen` also
 *  results from a connection that never happened, so the check would pass for
 *  the wrong reason. These assert the client really reached the server. */
const reached = (srv: { seen: Seen[]; connections: () => number }) => expect(srv.connections()).toBeGreaterThan(0)
const sawPlain = (seen: Seen[], verb: string) => seen.some((e) => e.phase === 'plain' && e.verb === verb)
const plainAuth = (seen: Seen[]) => seen.filter((e) => e.phase === 'plain' && /AUTH|LOGIN|MAIL|DATA/.test(e.verb))

describe('SMTP: STARTTLS is required when not on immediate TLS', () => {
  it('control: nodemailer without requireTLS continues in cleartext and authenticates', async () => {
    const { port, seen } = await startServer('smtp', 'no-starttls')
    await nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, auth: { user: 'u', pass: 'p' } }).verify()
    expect(plainAuth(seen).map((e) => e.verb)).toContain('AUTH')
  })

  it('refuses a server that offers no STARTTLS: no AUTH, closed code, no server prose', async () => {
    const srv = await startServer('smtp', 'no-starttls')
    const { port, seen } = srv
    const res = await testSmtpConnection(smtpCfg(port, false))
    reached(srv)
    expect(sawPlain(seen, 'EHLO')).toBe(true)
    expect(sawPlain(seen, 'STARTTLS')).toBe(true) // asked for, and refused with 502
    expect(res.ok).toBe(false)
    expect(decodeErrorPresentation(res.error)).toBe('starttls_required')
    expect(res.error).toContain('ERR_STARTTLS_REQUIRED')
    expect(res.error).not.toContain('not implemented')
    expect(plainAuth(seen)).toEqual([])
  })

  it('send path: same refusal, nothing of the message sent, and it is not retried', async () => {
    const srv = await startServer('smtp', 'no-starttls')
    const { port, seen } = srv
    const err = await sendMail(smtpCfg(port, false), { from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't' }).catch((e) => e)
    reached(srv)
    expect(sawPlain(seen, 'STARTTLS')).toBe(true)
    expect(err).toMatchObject({ code: 'ERR_STARTTLS_REQUIRED' })
    // The text stored for the failed queue item carries the vocabulary tag, so
    // the UI shows the translated sentence rather than this English message.
    expect(decodeErrorPresentation(finalSendFailureText(err))).toBe('starttls_required')
    expect(classifyErrorPresentation(err)).toBe('starttls_required')
    expect(plainAuth(seen)).toEqual([])
    expect(classifySmtpError(err)).toEqual({ code: 502, isTransient: false })
  })

  it('upgrades when offered: credentials only after TLS, pinned certificate still honoured', async () => {
    const srv = await startServer('smtp', 'starttls')
    const { port, seen } = srv
    expect(await testSmtpConnection(smtpCfg(port, false))).toEqual({ ok: true })
    reached(srv)
    expect(sawPlain(seen, 'STARTTLS')).toBe(true)
    expect(plainAuth(seen)).toEqual([])
    expect(seen.some((e) => e.phase === 'tls' && e.verb === 'AUTH')).toBe(true)
  })

  it('immediate TLS is unaffected', async () => {
    const srv = await startServer('smtp', 'no-starttls', { immediateTls: true })
    const { port, seen } = srv
    expect(await testSmtpConnection(smtpCfg(port, true))).toEqual({ ok: true })
    reached(srv)
    expect(seen.some((e) => e.verb === 'AUTH')).toBe(true)
    expect(seen.every((e) => e.phase === 'tls')).toBe(true)
  })
})

describe('IMAP: STARTTLS is required when not on immediate TLS', () => {
  it('control: ImapFlow without doSTARTTLS connects and authenticates in cleartext', async () => {
    const { port, seen } = await startServer('imap', 'no-starttls')
    const client = new ImapFlow({ host: '127.0.0.1', port, secure: false, auth: { user: 'u', pass: 'p' }, logger: false })
    client.on('error', () => {})
    await client.connect().catch(() => {})
    expect(plainAuth(seen).length).toBeGreaterThan(0)
  })

  it('refuses a server without STARTTLS before any authentication', async () => {
    const srv = await startServer('imap', 'no-starttls')
    const { port, seen } = srv
    const res = await testImapConnection(imapCfg(port, false))
    reached(srv) // ImapFlow reads the greeting's capabilities and gives up without sending a command
    expect(res.ok).toBe(false)
    expect(decodeErrorPresentation(res.error)).toBe('starttls_required')
    expect(res.error).toContain('ERR_STARTTLS_REQUIRED')
    expect(plainAuth(seen)).toEqual([])
  })

  it('upgrades when offered: authentication happens only inside TLS', async () => {
    const srv = await startServer('imap', 'starttls')
    const { port, seen } = srv
    const res = await testImapConnection(imapCfg(port, false))
    reached(srv)
    expect(sawPlain(seen, 'STARTTLS')).toBe(true)
    expect(res.error ?? '').not.toContain('ERR_STARTTLS_REQUIRED')
    expect(plainAuth(seen)).toEqual([])
    expect(seen.some((e) => e.phase === 'tls' && /AUTHENTICATE|LOGIN/.test(e.verb))).toBe(true)
  })

  it('immediate TLS is unaffected', async () => {
    const srv = await startServer('imap', 'no-starttls', { immediateTls: true })
    const { port, seen } = srv
    const res = await testImapConnection(imapCfg(port, true))
    reached(srv)
    // Commands really arrived (and only inside TLS); an empty `seen` would
    // satisfy `every` for a connection that never worked.
    expect(seen.some((e) => /AUTHENTICATE|LOGIN/.test(e.verb))).toBe(true)
    expect(res.error ?? '').not.toContain('ERR_STARTTLS_REQUIRED')
    expect(seen.every((e) => e.phase === 'tls')).toBe(true)
  })
})

describe('IMAP: PREAUTH greeting does not bypass the STARTTLS requirement', () => {
  it('ImapFlow fails closed: connect rejects and no command is accepted in cleartext', async () => {
    const seen: string[] = []
    let connections = 0
    const server = net.createServer((socket) => {
      connections += 1
      socket.on('error', () => {})
      socket.on('data', (d) => seen.push(d.toString('latin1').trim().split(' ')[1] ?? ''))
      socket.write('* PREAUTH [CAPABILITY IMAP4rev1] already authenticated\r\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => server.close())
    const res = await testImapConnection(imapCfg((server.address() as AddressInfo).port, false))
    expect(connections).toBeGreaterThan(0)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ERR_STARTTLS_REQUIRED')
    expect(seen.filter((v) => /SELECT|EXAMINE|LIST|FETCH|SEARCH|LOGIN|AUTHENTICATE/.test(v))).toEqual([])
  })
})

describe('nodemailer error shapes the transport classifiers read', () => {
  const verify = (port: number, extra: object = {}) =>
    nodemailer
      .createTransport({ host: '127.0.0.1', port, secure: false, requireTLS: true, connectionTimeout: 1000, greetingTimeout: 500, ...extra })
      .verify()
      .then(() => null, (e: unknown) => e as Record<string, unknown> & Error)

  it('DNS failure is EDNS on the CONN stage, a refused connect is ESOCKET with syscall connect', async () => {
    const dns = await nodemailer
      .createTransport({ host: 'nonexistent.invalid', port: 25, secure: false, connectionTimeout: 2000 })
      .verify()
      .then(() => null, (e: unknown) => e as Record<string, unknown>)
    expect(dns).toMatchObject({ code: 'EDNS', command: 'CONN' })

    const closed = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    const refused = await verify(closed)
    expect(refused).toMatchObject({ code: 'ESOCKET', command: 'CONN', syscall: 'connect' })
  })

  it('requireTLS sends STARTTLS even when it is not advertised; a refusal is ETLS on STARTTLS with a string response', async () => {
    const { port, seen } = await startServer('smtp', 'no-starttls')
    const err = await verify(port)
    expect(seen.map((e) => e.verb)).toEqual(['EHLO', 'STARTTLS'])
    expect(err).toMatchObject({ code: 'ETLS', command: 'STARTTLS', responseCode: 502 })
    expect(typeof err?.response).toBe('string')
    expect(isStarttlsRefusal(err)).toBe(true)
  })

  it('a rejected EHLO does not fall back to HELO and names the missing STARTTLS', async () => {
    const verbs: string[] = []
    const rejecting = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.write('220 localhost ESMTP\r\n')
      socket.on('data', (chunk) => {
        for (const line of chunk.toString('latin1').split('\r\n').filter(Boolean)) {
          verbs.push(line.split(' ')[0].toUpperCase())
          socket.write('500 5.5.1 unknown\r\n')
        }
      })
    })
    await new Promise<void>((resolve) => rejecting.listen(0, '127.0.0.1', resolve))
    closers.push(() => rejecting.close())
    const err = await verify((rejecting.address() as AddressInfo).port)
    expect(verbs).toEqual(['EHLO'])
    expect(err).toMatchObject({ code: 'ECONNECTION', command: 'EHLO', responseCode: 500 })
    expect(err?.message).toContain('does not support required STARTTLS')
    expect(isStarttlsRefusal(err)).toBe(true)
  })

  it('a greeting timeout carries the exact message and timeoutType the classifier lists', async () => {
    const silent = net.createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    closers.push(() => silent.close())
    const err = await verify((silent.address() as AddressInfo).port, { greetingTimeout: 300 })
    expect(err).toMatchObject({ code: 'ETIMEDOUT', command: 'CONN', message: 'Greeting never received', timeoutType: 'GREETING_TIMEOUT' })
    expect(isPreGreetingFailure(err)).toBe(true)
  })

  it('the connect timeout message the classifier lists still exists in the installed library', () => {
    // 'Connection timeout' cannot be provoked without an unroutable address, so
    // it is pinned at its source instead: the literal and its timer type.
    const source = fs.readFileSync(
      path.join(path.dirname(require.resolve('nodemailer/package.json')), 'dist/cjs/smtp-connection/index.js'),
      'utf8',
    )
    expect(source).toContain("timeoutError('Connection timeout', 'CONNECT_TIMEOUT')")
    expect(source).toContain("timeoutError('Greeting never received', 'GREETING_TIMEOUT')")
    expect(source).toContain("timeoutError('Timeout', 'SOCKET_TIMEOUT')")
  })
})

describe('SMTP: a message the server took but never confirmed is not retried', () => {
  const send = (port: number) =>
    sendMail(smtpCfg(port, true), { from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't' })
      .then(() => null, (e: unknown) => e as Record<string, unknown> & Error)

  // The real nodemailer, a real local server that took the whole message, the
  // real send path (`sendMail`) and the decisions the send queue takes on its
  // error: whether to reschedule (`classifySmtpError`) and what to store and
  // show (`finalSendFailureText`).
  const cases = [
    { after: 'silent', shape: { code: 'ETIMEDOUT', command: 'CONN', message: 'Timeout', timeoutType: 'SOCKET_TIMEOUT' } },
    { after: 'end', shape: { code: 'ECONNECTION', command: 'CONN', message: 'Connection closed unexpectedly' } },
    { after: 'reset', shape: { code: 'ESOCKET', command: 'CONN', syscall: 'read' } },
  ] as const

  for (const { after, shape } of cases) {
    it(`server took the message, then ${after}: no retry is scheduled and the outcome is shown as unknown`, async () => {
      const timeouts = __testOnly.sendTimeouts
      const saved = timeouts.socket
      timeouts.socket = 400
      try {
        const { port, state } = await startDataTakingServer(after)
        const err = await send(port)
        expect(state.dataTerminated).toBe(1) // the whole message reached the server
        expect(state.connections).toBe(1) // and was not sent to another address
        expect(err).toMatchObject(shape)
        expect(err?.responseCode).toBeUndefined()
        expect(isPreGreetingFailure(err)).toBe(false)
        expect(isDeliveryUndetermined(err)).toBe(true)
        // The queue reschedules only when this is true.
        expect(classifySmtpError(err)).toEqual({ code: null, isTransient: false })
        expect(classifyErrorPresentation(err)).toBe('delivery_unknown')
        expect(decodeErrorPresentation(finalSendFailureText(err))).toBe('delivery_unknown')
      } finally {
        timeouts.socket = saved
      }
    })
  }

  it('a server reply with a 4xx code after DATA is still retried; a 5xx is not', () => {
    // Reply-code paths are unchanged: the server said what happened.
    const shape = (responseCode: number) =>
      Object.assign(new Error(`${responseCode} reply`), { code: 'EMESSAGE', command: 'DATA', responseCode })
    expect(classifySmtpError(shape(451))).toEqual({ code: 451, isTransient: true })
    expect(classifySmtpError(shape(554))).toEqual({ code: 554, isTransient: false })
  })
})

describe('SMTP: a certificate or pin rejection is not an unknown delivery', () => {
  const sendTo = (cfg: Parameters<typeof sendMail>[0]) =>
    sendMail(cfg, { from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't' })
      .then(() => null, (e: unknown) => e as Record<string, unknown> & Error)

  const cases = [
    {
      name: 'an untrusted certificate',
      cfg: (port: number) => ({ host: '127.0.0.1', port, secure: true, user: 'u', pass: 'p' }),
    },
    {
      name: 'a certificate that does not match the pin',
      cfg: (port: number) => ({ ...smtpCfg(port, true), tlsPinsSha256: ['00'.repeat(32)], tlsPinnedCertsPem: [] }),
    },
  ]

  for (const { name, cfg } of cases) {
    it(`${name}: nothing was sent, so the text is the raw error and no retry is scheduled`, async () => {
      const srv = await startServer('smtp', 'no-starttls', { immediateTls: true })
      const err = await sendTo(cfg(srv.port))
      expect(err).toMatchObject({ code: 'ESOCKET', command: 'CONN' })
      expect(err?.syscall).toBeUndefined() // the shape that once looked like a socket failure
      expect(plainAuth(srv.seen)).toEqual([])
      expect(srv.seen).toEqual([]) // not even EHLO: the handshake never finished
      expect(isDeliveryUndetermined(err)).toBe(false)
      expect(isPreGreetingFailure(err)).toBe(false)
      expect(classifySmtpError(err)).toEqual({ code: null, isTransient: false })
      expect(classifyErrorPresentation(err)).not.toBe('delivery_unknown')
      expect(decodeErrorPresentation(finalSendFailureText(err))).not.toBe('delivery_unknown')
    })
  }
})

describe('SMTP: failures that sent nothing are retried', () => {
  const send = (cfg: Parameters<typeof sendMail>[0]) =>
    sendMail(cfg, { from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't' })
      .then(() => null, (e: unknown) => e as Record<string, unknown> & Error)

  const withTimeouts = async <T,>(patch: Partial<typeof __testOnly.sendTimeouts>, run: () => Promise<T>): Promise<T> => {
    const timeouts = __testOnly.sendTimeouts
    const saved = { ...timeouts }
    Object.assign(timeouts, patch)
    try {
      return await run()
    } finally {
      Object.assign(timeouts, saved)
    }
  }

  it('a server that accepts STARTTLS and never completes the handshake: the upgrade timer fires, AUTH/MAIL/DATA were not sent, the queue retries', async () => {
    const verbs: string[] = []
    const stalling = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.write('220 localhost ESMTP\r\n')
      socket.on('data', (chunk) => {
        for (const line of chunk.toString('latin1').split('\r\n').filter(Boolean)) {
          // The client's binary TLS ClientHello that follows is not a command.
          if (!/^[A-Za-z]{4,8}( |$)/.test(line)) continue
          const verb = line.split(' ')[0].toUpperCase()
          verbs.push(verb)
          if (verb === 'EHLO') socket.write('250-localhost\r\n250 STARTTLS\r\n')
          else if (verb === 'STARTTLS') socket.write('220 go ahead\r\n') // ...and then no handshake
        }
      })
    })
    await new Promise<void>((resolve) => stalling.listen(0, '127.0.0.1', resolve))
    closers.push(() => stalling.close())
    const err = await withTimeouts({ greeting: 300 }, () => send(smtpCfg((stalling.address() as AddressInfo).port, false)))
    expect(err).toMatchObject({ code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'UPGRADE_TIMEOUT', message: 'TLS handshake timed out' })
    expect(verbs).toEqual(['EHLO', 'STARTTLS']) // nothing of the message, not even AUTH
    expect(isTlsUpgradeTimeout(err)).toBe(true)
    expect(isDeliveryUndetermined(err)).toBe(false)
    // The queue reschedules on this and only this.
    expect(classifySmtpError(err)).toEqual({ code: null, isTransient: true })
    expect(decodeErrorPresentation(finalSendFailureText(err))).not.toBe('delivery_unknown')
  })

  it('a host with several addresses that all refuse the connection: one aggregate, still a failure before the greeting', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    const host = 'multi-address.example.test'
    // Two loopback addresses for one name, through the resolver cache nodemailer
    // consults first: the same shape a real multi-address host produces.
    nodemailerShared.dnsCache.set(host, { value: { addresses: ['127.0.0.1', '127.0.0.2'] }, expires: Date.now() + 60_000 } as never)
    try {
      const err = await send({ ...smtpCfg(closed, false), host })
      expect(err).toMatchObject({ name: 'AggregateError', code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNREFUSED' })
      expect(err?.syscall).toBeUndefined() // the errno lives on the members
      expect(Array.isArray(err?.errors) && (err.errors as Array<{ syscall?: string }>).every((m) => m.syscall === 'connect')).toBe(true)
      expect(isPreGreetingFailure(err)).toBe(true)
      expect(isDeliveryUndetermined(err)).toBe(false)
      expect(classifySmtpError(err)).toEqual({ code: null, isTransient: true })
      expect(classifyErrorPresentation(err)).toBe('pre_greeting')
      // What the user is shown is the network/VPN sentence, not the word AggregateError.
      expect(decodeErrorPresentation(finalSendFailureText(err))).toBe('pre_greeting')
      expect(finalSendFailureText(err)).toMatch(/^\[mcerr:pre_greeting\]/)
    } finally {
      nodemailerShared.dnsCache.delete(host)
    }
  })
})

describe('SMTP: failure before the server greeting', () => {
  const connectError = (host: string, port: number, extra: object = {}) =>
    nodemailer
      .createTransport({ host, port, secure: false, connectionTimeout: 1000, greetingTimeout: 300, ...extra })
      .verify()
      .then(() => null, (e: unknown) => e)

  it('real library: connection refused (IPv4 and IPv6 alike) is a transient pre-greeting failure', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    for (const host of ['127.0.0.1', '::1']) {
      const err = await connectError(host, closed)
      expect(isPreGreetingFailure(err), host).toBe(true)
      expect(classifyErrorPresentation(err), host).toBe('pre_greeting')
      expect(classifySmtpError(err), host).toEqual({ code: null, isTransient: true })
    }
  })

  it('real library: a server that accepts the socket but never greets is the same kind of failure', async () => {
    let accepted = 0
    const silent = net.createServer(() => { accepted += 1 })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    closers.push(() => silent.close())
    const err = await connectError('127.0.0.1', (silent.address() as AddressInfo).port)
    expect(accepted).toBeGreaterThan(0)
    expect(err).toMatchObject({ code: 'ETIMEDOUT', command: 'CONN', message: 'Greeting never received' })
    expect(isPreGreetingFailure(err)).toBe(true)
    expect(classifySmtpError(err).isTransient).toBe(true)
  })

  it('real library: a silent close before the greeting is NOT pre-greeting, because it looks like a close after the message was handed over', async () => {
    const send = (port: number, secure = false) =>
      sendMail(smtpCfg(port, secure), { from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't' }).catch((e) => e)

    let accepted = 0
    const closing = net.createServer((socket) => { accepted += 1; socket.end() })
    await new Promise<void>((resolve) => closing.listen(0, '127.0.0.1', resolve))
    closers.push(() => closing.close())
    const beforeGreeting = await send((closing.address() as AddressInfo).port)
    expect(accepted).toBeGreaterThan(0)

    // A server that took the whole message (DATA terminated by '.') and closed
    // without the 250 reply: the message may be delivered, so it must never be retried.
    const afterData = await startDataTakingServer('end')
    const afterAccept = await send(afterData.port, true)
    expect(afterData.state.dataTerminated).toBe(1) // the whole message really reached the server

    // The precondition this rule rests on: the library gives the SAME structural
    // shape in both cases. If a newer nodemailer tells them apart, the silent
    // close before the greeting can be classified again and these must be revisited.
    for (const err of [beforeGreeting, afterAccept]) {
      expect(err).toBeInstanceOf(Error)
      expect(err).toMatchObject({ code: 'ECONNECTION', command: 'CONN', message: 'Connection closed unexpectedly' })
      expect(err.response).toBeUndefined()
      expect(err.responseCode).toBeUndefined()
      expect(isPreGreetingFailure(err)).toBe(false)
      expect(classifySmtpError(err)).toEqual({ code: null, isTransient: false })
      expect(classifyErrorPresentation(err)).toBe('delivery_unknown')
      expect(decodeErrorPresentation(finalSendFailureText(err))).toBe('delivery_unknown')
    }
  })

  it('classifies ENETUNREACH / EHOSTUNREACH identically, whichever address failed last', () => {
    // nodemailer reports the LAST attempt: IPv6 last -> ENETUNREACH, IPv4 last -> a timeout.
    const shape = (code: string, syscall: string | undefined, message: string) =>
      Object.assign(new Error(message), { code, command: 'CONN', ...(syscall && { syscall }) })
    const lastWasIpv6 = shape('ESOCKET', 'connect', 'connect ENETUNREACH 2a00:1450:4010:c0e::6c:465 - Local (:::0)')
    const lastWasHostUnreach = shape('ESOCKET', 'connect', 'connect EHOSTUNREACH 192.0.2.1:587')
    const lastWasIpv4 = shape('ETIMEDOUT', undefined, 'Connection timeout')
    for (const err of [lastWasIpv6, lastWasHostUnreach, lastWasIpv4]) {
      expect(classifySmtpError(err)).toEqual({ code: null, isTransient: true })
    }
  })

  it('does not call a mid-session or certificate failure a pre-greeting failure', () => {
    const mk = (code: string, command: string, extra: object = {}) =>
      Object.assign(new Error('x'), { code, command, ...extra })
    expect(isPreGreetingFailure(mk('ESOCKET', 'CONN', { syscall: 'read' }))).toBe(false)
    expect(isPreGreetingFailure(mk('ETIMEDOUT', 'CONN'))).toBe(false) // bare socket 'Timeout'
    expect(isPreGreetingFailure(mk('ETLS', 'CONN'))).toBe(false)
    expect(isPreGreetingFailure(mk('EAUTH', 'AUTH PLAIN'))).toBe(false)
    expect(isPreGreetingFailure('connect ENETUNREACH')).toBe(false)
  })

  it('the final failure text carries the tag only for a pre-greeting failure', () => {
    const unreachable = Object.assign(new Error('connect ENETUNREACH 2a00::1:465'), { code: 'ESOCKET', command: 'CONN', syscall: 'connect' })
    expect(decodeErrorPresentation(finalSendFailureText(unreachable))).toBe('pre_greeting')
    expect(finalSendFailureText(unreachable)).toContain('ENETUNREACH')
    const refused = Object.assign(new Error('550 no such user'), { responseCode: 550 })
    expect(finalSendFailureText(refused)).not.toMatch(/^\[mcerr:/)
    expect(finalSendFailureText(refused)).toContain('550 no such user')
  })
})

describe('SMTP: threading headers of a reply reach the wire (RFC 5322 §3.6.4)', () => {
  const send = async (extra: { inReplyTo?: string; references?: string }) => {
    const { port, state } = await startDataTakingServer('end')
    // The fake server closes after DATA without the 250 reply, so the send
    // rejects; the raw message it took is what is under test.
    await sendMail(smtpCfg(port, true), { from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't', ...extra }).catch(() => {})
    expect(state.dataTerminated).toBe(1)
    return state.rawData
  }

  it('a reply carries In-Reply-To and References as handed to the transport', async () => {
    const raw = await send({ inReplyTo: '<parent@x.test>', references: '<root@x.test> <parent@x.test>' })
    expect(raw).toMatch(/^In-Reply-To: <parent@x\.test>\r?$/m)
    expect(raw).toMatch(/^References: <root@x\.test> <parent@x\.test>\r?$/m)
  })

  it('a message without a parent carries neither header', async () => {
    const raw = await send({})
    expect(raw).not.toMatch(/^In-Reply-To:/im)
    expect(raw).not.toMatch(/^References:/im)
  })
})

// The Account window's connection test runs the IMAP check and then the SMTP
// check; against a path that accepts and stays silent each one used to end in
// the library's own words after its greeting timer (16 s + 15 s + the
// address-retry's 15 s ≈ 47 s in total). The failure now carries the
// `pre_greeting` tag, which the renderer shows as one translated sentence.
// No timer is added or changed: the library's own timers are shortened or
// advanced here only so the test does not wait them out.
describe('connection test against a server that never greets: readable, not the library text', () => {
  const withTestTimeouts = async <T,>(run: () => Promise<T>): Promise<T> => {
    const timeouts = __testOnly.testTimeouts
    const saved = { ...timeouts }
    // Only the greeting timer is short; the others must not fire first.
    Object.assign(timeouts, { connection: 5_000, greeting: 300, socket: 5_000 })
    try {
      return await run()
    } finally {
      Object.assign(timeouts, saved)
    }
  }

  const silentTcp = async () => {
    let accepted = 0
    const server = net.createServer(() => { accepted += 1 })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => server.close())
    return { port: (server.address() as AddressInfo).port, accepted: () => accepted }
  }

  /** TLS completes, then nothing: no `* OK` greeting ever arrives. */
  const tlsWithoutGreeting = async () => {
    let established = 0
    const server = tls.createServer({ key: KEY, cert: CERT }, (socket) => { established += 1; socket.on('error', () => {}) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => server.close())
    return { port: (server.address() as AddressInfo).port, established: () => established }
  }

  it('SMTP: accepted socket, no greeting -> pre_greeting tag, raw text kept after it', async () => {
    const srv = await silentTcp()
    const res = await withTestTimeouts(() => testSmtpConnection(smtpCfg(srv.port, false)))
    expect(srv.accepted()).toBeGreaterThan(0)
    expect(res.ok).toBe(false)
    expect(decodeErrorPresentation(res.error)).toBe('pre_greeting')
    expect(res.error).toContain('Greeting never received')
  })

  it('SMTP: TLS established, no greeting -> pre_greeting tag', async () => {
    const srv = await tlsWithoutGreeting()
    const res = await withTestTimeouts(() => testSmtpConnection(smtpCfg(srv.port, true)))
    expect(srv.established()).toBeGreaterThan(0)
    expect(decodeErrorPresentation(res.error)).toBe('pre_greeting')
  })

  describe('IMAP (ImapFlow timers advanced by a fake clock, real sockets)', () => {
    afterEach(() => { vi.useRealTimers() })

    const run = async (cfg: ReturnType<typeof imapCfg>, advanceMs: number) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pending = testImapConnection(cfg)
      let settled = false
      void pending.finally(() => { settled = true })
      // The greeting timer is armed only once the socket is connected, which
      // happens on the real I/O loop: advance the fake clock in steps, yielding
      // to that loop in between, until the library's own timer has fired.
      for (let elapsed = 0; elapsed < advanceMs * 3 && !settled; elapsed += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      return pending
    }

    it('TLS established, no greeting: GREETING_TIMEOUT (16 s) -> pre_greeting tag', async () => {
      const srv = await tlsWithoutGreeting()
      const res = await run(imapCfg(srv.port, true), 17_000)
      expect(srv.established()).toBeGreaterThan(0)
      expect(res.ok).toBe(false)
      expect(decodeErrorPresentation(res.error)).toBe('pre_greeting')
      expect(res.error).toContain('GREETING_TIMEOUT')
    })

    it('plain accepted socket, no greeting (STARTTLS port): GREETING_TIMEOUT -> pre_greeting tag', async () => {
      const srv = await silentTcp()
      const res = await run(imapCfg(srv.port, false), 17_000)
      expect(srv.accepted()).toBeGreaterThan(0)
      expect(decodeErrorPresentation(res.error)).toBe('pre_greeting')
    })

    it('TCP accepted on a TLS port, handshake never completes: CONNECT_TIMEOUT (90 s) -> pre_greeting tag', async () => {
      const srv = await silentTcp()
      const res = await run(imapCfg(srv.port, true), 91_000)
      expect(srv.accepted()).toBeGreaterThan(0)
      expect(decodeErrorPresentation(res.error)).toBe('pre_greeting')
    })

    it('control: an authentication refusal is not a pre-greeting failure', async () => {
      const srv = await startServer('imap', 'starttls', { immediateTls: true })
      const res = await run(imapCfg(srv.port, true), 100)
      expect(res.ok).toBe(false)
      expect(decodeErrorPresentation(res.error)).not.toBe('pre_greeting')
    })
  })
})
