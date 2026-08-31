import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import {
  buildTlsOptions,
  isTlsTrustError,
  normalizeFingerprintSha256,
  __resetCombinedCaCacheForTest,
} from './tls'

// ---------------------------------------------------------------------------
// §2.156 test-gap (codex-bg-review + codex-security-review, both flagged
// Medium independently): `buildTlsOptions()` now hands transports a prebuilt
// `tls.SecureContext` instead of a `ca: string[]` array. That change is
// correct ONLY if ImapFlow and nodemailer forward the WHOLE `options.tls`
// object into `tls.connect()` rather than picking specific keys off it.
//
// Confirmed by reading node_modules source (both do
// `Object.assign(base, this.options.tls || {})` right before calling
// `tls.connect` / `connector.connect`):
//   - imapflow implicit TLS  : imap-flow.js `connect()`            (~L1775)
//   - imapflow STARTTLS      : imap-flow.js `upgradeToSTARTTLS()`  (~L1262)
//   - nodemailer implicit TLS: smtp-connection/index.js `connect()`(~L310)
//   - nodemailer STARTTLS    : smtp-connection/index.js `_upgradeConnection()` (~L1015)
//
// but nothing in the test suite exercised it. A dependency bump that narrows
// that merge to an allowlist of keys would silently drop `secureContext` and
// fall back to Node's implicit default trust store — losing BOTH the OS
// system roots (the whole point of §2.156's predecessor fix, "TLS trust is
// additive") AND every pinned anchor — with no error anywhere in the app.
//
// This file proves propagation on all four transport paths with a REAL TLS
// handshake against REAL `ImapFlow` / `nodemailer` instances (neither library
// is mocked here — see the imports above). The server presents a self-signed
// certificate that Node's default trust store rejects; the only way any of
// these connections can succeed is if the `SecureContext` `buildTlsOptions()`
// builds from the pinned anchor actually reaches `tls.connect()`. Each
// positive ("anchored pin") case is paired with a negative control (same
// server, no anchor) so a test that always passes regardless of the anchor
// would be caught immediately.
// ---------------------------------------------------------------------------

// Reused verbatim from tls.test.ts's long-lived fixture (CN=localhost, SAN
// DNS:localhost + IP:127.0.0.1, valid until 2126) — duplicated rather than
// imported so this file stays a self-contained contract test with no
// dependency on tls.test.ts internals.
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUYng5+qY6Pz46P5ifBIu+lAFktvIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDcyNDE4MTgzN1oYDzIxMjYw
NjMwMTgxODM3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDF3DgKj1p4qNx9UWyatjUgvIGU93QAbuAq4c1a9UqM
Dj4TdkIhTNAn2TuD9J07KZkUPFlU5M0vOljU+Z/Agsk35FnNs6CKvQ9sKNUnFcEt
XwcRkZhzMeKRxSx5qQ8PoOxDiZwS6etyU9/9STOx8yiURpNlJ5SXWzp5Bl/7KcXt
INfjERMr28Uc51/plidqsfS1/4AMtk6ir9DvmZpl2WZPz0z4xwqOLBFzEb790URo
ENcCJ7QXQk5JV88Bl4Z5Rqs91hUln2lpZpwdhpIfDgaOTfo5NOTsxs3kTiG0QKbf
hCk26ow95V5n0ftSLQUl16WyfVTQxsI7LRqyHNAuoZKjAgMBAAGjbzBtMB0GA1Ud
DgQWBBSMTxdZnzw8MvXge35dWww4KdH4nDAfBgNVHSMEGDAWgBSMTxdZnzw8MvXg
e35dWww4KdH4nDAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAryaBVnesyINfE6tpzrAZCyf2z6c9
h8vK1yrDxZ44KaMUzANWouAIEjtJy39da8RvoFZdLL67CAlFmXMedc0cHUijspgh
vuL8qmUsrzYNAeg5gQpsbTsFfMgvJhAYHHimOwDj0KbikjVb+PZrWVAUZn6fHu1S
UP6vvf7JoDZz0a99xeUa3S3nzL0JT6b9+vXoL0AoV7vTfUA02zO5gaH1+r62QYbj
z8X97d/SjBh4NEJfO+hrky9+uj4/H1EKdjSxzScjmT5QMHenlq1Xboek5IRSiTkm
u2Ka43+yHsBbQMfubE4Ku4jiDZeMmJQEWFQEYErb1LrG09pC5nAbYnl/rg==
-----END CERTIFICATE-----
`

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDF3DgKj1p4qNx9
UWyatjUgvIGU93QAbuAq4c1a9UqMDj4TdkIhTNAn2TuD9J07KZkUPFlU5M0vOljU
+Z/Agsk35FnNs6CKvQ9sKNUnFcEtXwcRkZhzMeKRxSx5qQ8PoOxDiZwS6etyU9/9
STOx8yiURpNlJ5SXWzp5Bl/7KcXtINfjERMr28Uc51/plidqsfS1/4AMtk6ir9Dv
mZpl2WZPz0z4xwqOLBFzEb790URoENcCJ7QXQk5JV88Bl4Z5Rqs91hUln2lpZpwd
hpIfDgaOTfo5NOTsxs3kTiG0QKbfhCk26ow95V5n0ftSLQUl16WyfVTQxsI7LRqy
HNAuoZKjAgMBAAECggEAC34YcznoaLcbjNvnPFqhCLRqV8YXzX6jNAUcRyWVnZT7
iL3cZtAYtyJ9u9MViZOHpLlB/GsIeq8flx9OEYHcljaD+4LCLHeBfH19WWErcKs4
XzjfFgcrwIknZYRVr561RSb/vcmAjN96VIf6ogzG//XUJz1T+tv9sCdCo/Vv3a9p
tEouUjbWOOqGFUR9X2Aq05DGTrNQMNWZGSIXMDJeeF51ZC69p8w/BS5u+B3NWTdx
wDbuq5/ivkdFbdKYaF4g7DXksmr6nxE6/70ls68R24/tIuBnWuB/g183ye61lY+w
00LX9jd26sVnPdebbs6Slu4dcek/H1TU80ohdvJhAQKBgQD8X48Mq26Egc8oVTNs
Pej1Hf6d1gN54CdrKxxJ1BlMD/KmHK1aa+gOz+Xz8oDTcqFgtsPFZppZrx9rZs1e
+gWDOGF5XyJ5jGTWWlPx0UJfAmSo4gwKiWfGbGRr1zEneq42kO6124f/PYHNcMF3
x7iOeFO5TnG1y4/1i9TUPSlQwwKBgQDItB2DHNF4kydZOAji6BYNx3bZdink49u/
bjHLFI9S0x9s2MYVjl28EBvSfpMOHyrBukNHYNwSftNxhOjCmfvvpIPhbQWcEO8p
fzhbkBjvA39IuSbo33sGIdP6SrwjvFragjqRLfKuXtYvoo0XeOMCabp8CL3jxyHV
bVwE1maYoQKBgFAtt8/Joxn796mTr/uii6FcPyk79ezBdySIFLur48GTi36Uu8pv
X9Fc4WyoTZ9f2r9UMUxEtaLqjSvdBEA5ZIj035rky5ocLWkgV20LE3AF3Z79+d9b
GhojE6BjRJ2LT0/Mqdoi/cjsbJGtUfnQ/ORefBLyRhQAsSLMovgu2jJrAoGAIfZo
sBEmWTL9i5lx14PSh45jTDU0rajpPKGXB3h5MFjNjou4KVmn/vTy4FHO7KrVf2bX
j7KSSwbvHNySzqtj+I9sSa87Lcen0OvYS5Y8weVjmpjKPsnidY0v48DVyW5MKYG0
C3EtCdi+gd0N5xTrxTLC/c404+CElyskUSU+w0ECgYEA60LNY+vXKCWtiN9qXVXw
4EDTmkPg0H2aDy2Re2mnfQD4o2JNjpWCwq8IQOSsMThV8txsgbggCfOJIy6cQA/D
Sa14BqPVPhCVkpSW7H79Od3aanjvCegr+plZJq3/QX9bIYYgIVJ7OstPDD07jbIt
hkvgyFLB4X4z08gl6re3vDw=
-----END PRIVATE KEY-----
`

const SELF_SIGNED_FP = normalizeFingerprintSha256(
  new crypto.X509Certificate(SELF_SIGNED_CERT).fingerprint256,
)

const noop = () => {}
/** Mirrors packages/net/imap.ts's `silentLogger` so the suite does not spam
 *  stdout with ImapFlow's pino-shaped debug output. */
const silentImapLogger = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop }

/**
 * Spy on `node:tls`'s `connect` WITHOUT replacing its behaviour: every call
 * still performs a real handshake, but the exact options object handed to it
 * is captured first. This is what lets a single assertion check BOTH the
 * observable effect (does the handshake succeed?) and the exact
 * `SecureContext` reference that reached the call — a mismatch there would
 * mean some copy/rebuild happened between `buildTlsOptions()` and the socket,
 * silently defeating the shared-context cache from §2.156.
 */
function spyOnRealTlsConnect(): { captured: tls.ConnectionOptions[] } {
  const original = tls.connect.bind(tls)
  const captured: tls.ConnectionOptions[] = []
  vi.spyOn(tls, 'connect').mockImplementation(((opts: tls.ConnectionOptions, cb?: () => void) => {
    captured.push(opts)
    return original(opts, cb)
  }) as typeof tls.connect)
  return { captured }
}

type Mode = 'implicit' | 'starttls'

/** Settle a promise into `{ error }` instead of throwing, so both branches of
 *  a positive/negative pair can be written the same way. */
async function settle(p: Promise<unknown>): Promise<{ error: unknown }> {
  try {
    await p
    return { error: null }
  } catch (e) {
    return { error: e }
  }
}

// ---------------------------------------------------------------------------
// Minimal "yes-man" IMAP server: a real greeting/CAPABILITY/STARTTLS/LOGIN/
// NAMESPACE dialog, generic enough to drive a REAL ImapFlow instance all the
// way to `usable === true`. Building this (instead of stubbing the TLS layer
// directly) is what lets the positive-path tests below observe a genuine
// production-shaped login success, not merely "no error was thrown yet".
//
// NAMESPACE is deliberately left OUT of the advertised capabilities: if
// ImapFlow believes the server supports the NAMESPACE extension it issues the
// NAMESPACE command and expects real namespace data back, which this
// yes-man does not attempt to synthesize correctly. Leaving it unadvertised
// makes ImapFlow fall back to `LIST "" ""` instead, which this server's
// generic "any other tagged command gets a bare OK" branch already answers
// without error.
// ---------------------------------------------------------------------------
function createImapYesManServer(mode: Mode): net.Server | tls.Server {
  const secureContext = tls.createSecureContext({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT })

  const attach = (socket: net.Socket | tls.TLSSocket, sendGreeting: boolean) => {
    socket.on('error', () => {})
    const preTls = !(socket instanceof tls.TLSSocket)
    if (sendGreeting) {
      const advertise = mode === 'starttls' && preTls ? ' STARTTLS' : ''
      socket.write(`* OK [CAPABILITY IMAP4rev1${advertise}] yes-man ready\r\n`)
    }
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      let eol = buffer.indexOf('\r\n')
      while (eol >= 0) {
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 2)
        eol = buffer.indexOf('\r\n')
        const m = /^(\S+)\s+(\S+)/.exec(line)
        if (!m) continue
        const [, tag, cmdRaw] = m
        const cmd = cmdRaw.toUpperCase()
        if (cmd === 'CAPABILITY') {
          const advertise = mode === 'starttls' && !(socket instanceof tls.TLSSocket) ? ' STARTTLS' : ''
          socket.write(`* CAPABILITY IMAP4rev1${advertise}\r\n`)
          socket.write(`${tag} OK Completed\r\n`)
        } else if (cmd === 'STARTTLS' && mode === 'starttls' && !(socket instanceof tls.TLSSocket)) {
          socket.write(`${tag} OK Begin TLS negotiation now\r\n`)
          socket.removeListener('data', onData)
          const secured = new tls.TLSSocket(socket as net.Socket, { isServer: true, secureContext })
          attach(secured, false)
        } else {
          // LOGIN, LIST "" "", ID, etc. — a plain tagged OK is enough for
          // every command ImapFlow issues on the way to `usable = true`.
          socket.write(`${tag} OK Completed\r\n`)
        }
      }
    }
    socket.on('data', onData)
  }

  if (mode === 'implicit') {
    return tls.createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (socket) => attach(socket, true))
  }
  const server = net.createServer((socket) => attach(socket, true))
  return server
}

// ---------------------------------------------------------------------------
// Minimal "yes-man" SMTP server: greeting + EHLO (+ STARTTLS upgrade for the
// STARTTLS variant). AUTH is deliberately never advertised, so nodemailer's
// `verify()` completes right after a successful EHLO without attempting a
// login — see smtp-transport/index.js `verify()`: `connection.allowsAuth`
// stays false, so it calls `finalize()` directly instead of `connection.login()`.
// ---------------------------------------------------------------------------
function createSmtpYesManServer(mode: Mode): net.Server | tls.Server {
  const secureContext = tls.createSecureContext({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT })

  const attach = (socket: net.Socket | tls.TLSSocket, sendGreeting: boolean) => {
    socket.on('error', () => {})
    if (sendGreeting) socket.write('220 localhost ESMTP yes-man ready\r\n')
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      let eol = buffer.indexOf('\r\n')
      while (eol >= 0) {
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 2)
        eol = buffer.indexOf('\r\n')
        if (/^EHLO\b/i.test(line)) {
          const advertiseStartTls = mode === 'starttls' && !(socket instanceof tls.TLSSocket)
          socket.write(
            '250-localhost greets you\r\n' + (advertiseStartTls ? '250 STARTTLS\r\n' : '250 SIZE 10485760\r\n'),
          )
        } else if (/^STARTTLS\b/i.test(line)) {
          socket.write('220 2.0.0 Ready to start TLS\r\n')
          socket.removeListener('data', onData)
          const secured = new tls.TLSSocket(socket as net.Socket, { isServer: true, secureContext })
          attach(secured, false)
        } else {
          // QUIT and anything else this contract does not exercise — a
          // generic completion reply is enough (AUTH is never advertised, so
          // `verify()` never sends anything but EHLO and QUIT).
          socket.write('221 2.0.0 Bye\r\n')
        }
      }
    }
    socket.on('data', onData)
  }

  if (mode === 'implicit') {
    return tls.createServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (socket) => attach(socket, true))
  }
  return net.createServer((socket) => attach(socket, true))
}

describe('packages/net — SecureContext really reaches tls.connect() through real transports (§2.156 contract)', () => {
  beforeEach(() => {
    __resetCombinedCaCacheForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetCombinedCaCacheForTest()
  })

  describe.each(['implicit', 'starttls'] as const)('IMAP (ImapFlow, real handshake) — %s', (mode) => {
    let server: net.Server | tls.Server
    let port: number

    beforeEach(async () => {
      server = createImapYesManServer(mode)
      server.on('error', () => {})
      if (mode === 'implicit') (server as tls.Server).on('tlsClientError', () => {})
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as net.AddressInfo).port
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('anchored pin trusts the certificate -> real ImapFlow LOGIN completes end to end', async () => {
      const tlsOptions = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
        servername: 'localhost',
      })!
      expect(tlsOptions.secureContext).toBeDefined()

      const { captured } = spyOnRealTlsConnect()
      const client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: mode === 'implicit',
        auth: { user: 'u', pass: 'p' },
        tls: tlsOptions,
        logger: silentImapLogger,
        disableCompression: true,
        disableAutoEnable: true,
        greetingTimeout: 5_000,
      })

      await client.connect()
      expect(client.usable).toBe(true)

      // Every tls.connect() call on this path — the initial implicit
      // handshake, or the STARTTLS upgrade — used the EXACT SecureContext
      // buildTlsOptions() produced, not a copy, not a default.
      expect(captured.length).toBeGreaterThan(0)
      for (const opts of captured) expect(opts.secureContext).toBe(tlsOptions.secureContext)

      await client.logout().catch(() => {})
      try { client.close() } catch { /* already closed */ }
    })

    it('control: WITHOUT the anchor, the same server/certificate is rejected as untrusted', async () => {
      // Same server, same certificate — only the trust config changes. If
      // this control did not fail, the positive test above would not be
      // proving anything about the anchor.
      const tlsOptions = buildTlsOptions({ servername: 'localhost' })!
      const client = new ImapFlow({
        host: '127.0.0.1',
        port,
        secure: mode === 'implicit',
        auth: { user: 'u', pass: 'p' },
        tls: tlsOptions,
        logger: silentImapLogger,
        disableCompression: true,
        disableAutoEnable: true,
        greetingTimeout: 5_000,
      })

      const { error } = await settle(client.connect())
      expect(error).not.toBeNull()
      expect(isTlsTrustError(error)).toBe(true)
      try { client.close() } catch { /* already closed */ }
    })
  })

  describe.each(['implicit', 'starttls'] as const)('SMTP (nodemailer, real handshake) — %s', (mode) => {
    let server: net.Server | tls.Server
    let port: number

    beforeEach(async () => {
      server = createSmtpYesManServer(mode)
      server.on('error', () => {})
      if (mode === 'implicit') (server as tls.Server).on('tlsClientError', () => {})
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as net.AddressInfo).port
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('anchored pin trusts the certificate -> real nodemailer verify() completes end to end', async () => {
      const tlsOptions = buildTlsOptions({
        tlsPinsSha256: [SELF_SIGNED_FP],
        tlsPinnedCertsPem: [SELF_SIGNED_CERT],
        servername: 'localhost',
      })!
      expect(tlsOptions.secureContext).toBeDefined()

      const { captured } = spyOnRealTlsConnect()
      const transport = nodemailer.createTransport({
        host: '127.0.0.1',
        port,
        secure: mode === 'implicit',
        auth: { user: 'u', pass: 'p' },
        tls: tlsOptions,
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 5_000,
      })

      const ok = await transport.verify()
      expect(ok).toBe(true)

      expect(captured.length).toBeGreaterThan(0)
      for (const opts of captured) expect(opts.secureContext).toBe(tlsOptions.secureContext)

      transport.close()
    })

    it('control: WITHOUT the anchor, the same server/certificate is rejected as untrusted', async () => {
      const tlsOptions = buildTlsOptions({ servername: 'localhost' })!
      const transport = nodemailer.createTransport({
        host: '127.0.0.1',
        port,
        secure: mode === 'implicit',
        auth: { user: 'u', pass: 'p' },
        tls: tlsOptions,
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 5_000,
      })

      const { error } = await settle(transport.verify())
      expect(error).not.toBeNull()
      expect(isTlsTrustError(error)).toBe(true)

      transport.close()
    })
  })
})
