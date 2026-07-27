import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// Mock nodemailer — we don't want real SMTP connections.
// createTransport is called inside each function, so the mock transporter is created
// via closure: vi.mock factory runs before imports.
const mockVerify = vi.fn()
const mockSendMail = vi.fn()
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: mockVerify,
      sendMail: mockSendMail,
    })),
  },
}))

// Mock DNS — for testing retry by direct IPv4 probe on timeout
const mockDnsResolve4 = vi.fn<(host: string) => Promise<string[]>>()
vi.mock('node:dns', () => ({
  default: {
    promises: {
      resolve4: (...args: unknown[]) => mockDnsResolve4(args[0] as string),
    },
  },
}))

// Mock net — for TCP probe in DNS fallback
let netConnectBehavior: 'connect' | 'error' | 'timeout' = 'connect'
vi.mock('node:net', () => ({
  default: {
    connect: vi.fn().mockImplementation(() => {
      const s = new EventEmitter() as EventEmitter & { setTimeout: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; removeAllListeners: ReturnType<typeof vi.fn> }
      s.setTimeout = vi.fn()
      s.destroy = vi.fn()
      const origRemove = s.removeAllListeners.bind(s)
      s.removeAllListeners = vi.fn().mockImplementation((...args: Parameters<typeof origRemove>) => {
        origRemove(...args)
        return s
      })
      process.nextTick(() => {
        if (netConnectBehavior === 'connect') s.emit('connect')
        else if (netConnectBehavior === 'error') s.emit('error', new Error('ECONNREFUSED'))
        else s.emit('timeout')
      })
      return s
    }),
  },
}))

import nodemailer from 'nodemailer'
import { testSmtpConnection, sendMail, buildRawMessage, resolveIpv4All, findReachableIp, classifySmtpError, SMTP_RETRY_DELAYS_MS } from './smtp'
import type { SmtpConfig } from './types'

const cfg: SmtpConfig = {
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  user: 'alice@example.test',
  pass: 'secret',
}

describe('packages/net/smtp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    netConnectBehavior = 'connect'
    mockDnsResolve4.mockResolvedValue(['1.2.3.4'])
  })

  it('testSmtpConnection returns {ok: true} on successful check', async () => {
    mockVerify.mockResolvedValueOnce(true)
    const result = await testSmtpConnection(cfg)
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('testSmtpConnection returns error on failed check', async () => {
    mockVerify.mockRejectedValueOnce(new Error('Connection refused'))
    const result = await testSmtpConnection(cfg)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Connection refused')
  })

  it('sendMail calls transporter.sendMail with correct parameters', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: '<test@example.test>' })
    const result = await sendMail(cfg, {
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'Test',
      text: 'Hello',
    })
    expect(result.messageId).toBe('<test@example.test>')
    expect(mockSendMail).toHaveBeenCalled()
    const callArgs = mockSendMail.mock.calls[0][0]
    expect(callArgs.from).toBe('alice@example.test')
    expect(callArgs.to).toBe('bob@example.test')
    expect(callArgs.subject).toBe('Test')
  })

  it('sendMail with attachments converts base64 to Buffer', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: '<att@test>' })
    const b64 = Buffer.from('hello file', 'utf8').toString('base64')
    await sendMail(cfg, {
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'With att',
      text: 'See attached',
      attachments: [{ filename: 'test.txt', contentBase64: b64, contentType: 'text/plain' }],
    })
    const callArgs = mockSendMail.mock.calls[0][0]
    expect(callArgs.attachments).toBeDefined()
    expect(callArgs.attachments.length).toBe(1)
    expect(callArgs.attachments[0].filename).toBe('test.txt')
    expect(Buffer.isBuffer(callArgs.attachments[0].content)).toBe(true)
    expect(callArgs.attachments[0].content.toString('utf8')).toBe('hello file')
  })

  it('sendMail without attachments — attachments is undefined', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: '<noatt@test>' })
    await sendMail(cfg, {
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'No att',
      text: 'No att',
    })
    const callArgs = mockSendMail.mock.calls[0][0]
    expect(callArgs.attachments).toBeUndefined()
  })

  it('testSmtpConnection with OAuth2 configuration', async () => {
    mockVerify.mockResolvedValueOnce(true)
    const oauthCfg: SmtpConfig = {
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      user: 'alice@gmail.com',
      accessToken: 'ya29.token',
    }
    const result = await testSmtpConnection(oauthCfg)
    expect(result.ok).toBe(true)
    expect(nodemailer.createTransport).toHaveBeenCalled()
  })

  it('sendMail throws error on send failure', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('Send failed'))
    await expect(sendMail(cfg, {
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'Fail',
      text: 'x',
    })).rejects.toThrow('Send failed')
  })

  it('buildRawMessage creates Buffer with RFC822 content', async () => {
    const raw = await buildRawMessage({
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'Test raw',
      text: 'Body text',
    })
    expect(Buffer.isBuffer(raw)).toBe(true)
    const str = raw.toString('utf8')
    expect(str).toContain('From: alice@example.test')
    expect(str).toContain('To: bob@example.test')
    expect(str).toContain('Subject: Test raw')
    expect(str).toContain('Body text')
  })

  it('buildRawMessage with attachment includes MIME part', async () => {
    const b64 = Buffer.from('attachment data', 'utf8').toString('base64')
    const raw = await buildRawMessage({
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'With att',
      text: 'See attached',
      attachments: [{ filename: 'data.bin', contentBase64: b64, contentType: 'application/octet-stream' }],
    })
    const str = raw.toString('utf8')
    expect(str).toContain('data.bin')
    expect(str).toContain('multipart')
  })

  it('buildRawMessage with HTML content', async () => {
    const raw = await buildRawMessage({
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'HTML',
      html: '<b>Bold</b>',
    })
    const str = raw.toString('utf8')
    expect(str).toContain('<b>Bold</b>')
  })

  it('buildRawMessage with custom headers', async () => {
    const raw = await buildRawMessage({
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'Draft',
      text: 'Draft body',
      headers: { 'X-MailCopilot-Draft-Id': 'abc-123' },
    })
    const str = raw.toString('utf8')
    // nodemailer normalizes headers, so we check case-insensitive
    expect(str.toLowerCase()).toContain('x-mailcopilot-draft-id')
    expect(str).toContain('abc-123')
  })
})

// ─── DNS retry tests ─────────────────────────────────────────────────────────

describe('DNS retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    netConnectBehavior = 'connect'
    mockDnsResolve4.mockResolvedValue(['1.2.3.4'])
  })

  describe('resolveIpv4All', () => {
    it('returns IPs from system DNS', async () => {
      mockDnsResolve4.mockResolvedValue(['10.0.0.1', '10.0.0.2'])
      const ips = await resolveIpv4All('example.com')
      expect(ips).toEqual(['10.0.0.1', '10.0.0.2'])
    })

    it('returns empty array on DNS errors', async () => {
      mockDnsResolve4.mockRejectedValue(new Error('SERVFAIL'))
      const ips = await resolveIpv4All('nonexistent.test')
      expect(ips).toEqual([])
    })
  })

  describe('findReachableIp', () => {
    it('returns first reachable IP', async () => {
      netConnectBehavior = 'connect'
      const ip = await findReachableIp('example.com', 465)
      expect(ip).toBe('1.2.3.4')
    })

    it('returns null if all IPs are unreachable', async () => {
      netConnectBehavior = 'error'
      const ip = await findReachableIp('example.com', 465)
      expect(ip).toBeNull()
    })

    it('returns null on probe timeout', async () => {
      netConnectBehavior = 'timeout'
      const ip = await findReachableIp('example.com', 465)
      expect(ip).toBeNull()
    })

    it('returns null on empty DNS', async () => {
      mockDnsResolve4.mockRejectedValue(new Error('NXDOMAIN'))
      const ip = await findReachableIp('nonexistent.test', 465)
      expect(ip).toBeNull()
    })
  })

  describe('sendMail DNS retry', () => {
    it('on timeout retries with a resolved IPv4', async () => {
      mockSendMail
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockResolvedValueOnce({ messageId: '<fallback@test>' })

      const result = await sendMail(cfg, {
        from: 'a@test',
        to: 'b@test',
        subject: 'x',
        text: 'x',
      })
      expect(result.messageId).toBe('<fallback@test>')
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(2)
      const secondCall = vi.mocked(nodemailer.createTransport).mock.calls[1][0] as { host: string }
      expect(secondCall.host).toBe('1.2.3.4')
    })

    it('on non-timeout error does NOT retry by IP', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('Authentication failed'))
      await expect(sendMail(cfg, {
        from: 'a@test',
        to: 'b@test',
        subject: 'x',
        text: 'x',
      })).rejects.toThrow('Authentication failed')
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1)
    })

    it('on timeout without reachable IPs throws original error', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('Connection timeout'))
      netConnectBehavior = 'error' // all IPs unreachable

      await expect(sendMail(cfg, {
        from: 'a@test',
        to: 'b@test',
        subject: 'x',
        text: 'x',
      })).rejects.toThrow('Connection timeout')
    })

    it('on ETIMEDOUT also retries by IP', async () => {
      mockSendMail
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce({ messageId: '<etm@test>' })

      const result = await sendMail(cfg, {
        from: 'a@test',
        to: 'b@test',
        subject: 'x',
        text: 'x',
      })
      expect(result.messageId).toBe('<etm@test>')
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(2)
    })
  })

  describe('testSmtpConnection DNS retry', () => {
    it('on timeout retries with a resolved IPv4', async () => {
      mockVerify
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockResolvedValueOnce(true)

      const result = await testSmtpConnection(cfg)
      expect(result.ok).toBe(true)
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(2)
    })

    it('on timeout without reachable IPs returns error', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Connection timeout'))
      netConnectBehavior = 'error'

      const result = await testSmtpConnection(cfg)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Connection timeout')
    })

    it('on non-timeout error does NOT use DNS fallback', async () => {
      mockVerify.mockRejectedValueOnce(new Error('Auth failed'))
      const result = await testSmtpConnection(cfg)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Auth failed')
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1)
    })
  })
})

// --- classifySmtpError ---

describe('classifySmtpError', () => {
  it('classifies 4xx as transient', () => {
    const err = Object.assign(new Error('Greylisted'), { responseCode: 450 })
    expect(classifySmtpError(err)).toEqual({ code: 450, isTransient: true })
  })

  it('classifies 421 (too many connections) as transient', () => {
    const err = Object.assign(new Error('Too many connections'), { responseCode: 421 })
    expect(classifySmtpError(err)).toEqual({ code: 421, isTransient: true })
  })

  it('classifies 451 (greylisting) as transient', () => {
    const err = Object.assign(new Error('Try again later'), { responseCode: 451 })
    expect(classifySmtpError(err)).toEqual({ code: 451, isTransient: true })
  })

  it('classifies 5xx as permanent', () => {
    const err = Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 })
    expect(classifySmtpError(err)).toEqual({ code: 550, isTransient: false })
  })

  it('classifies 553 as permanent', () => {
    const err = Object.assign(new Error('Bad address'), { responseCode: 553 })
    expect(classifySmtpError(err)).toEqual({ code: 553, isTransient: false })
  })

  it('classifies 554 as permanent', () => {
    const err = Object.assign(new Error('Transaction failed'), { responseCode: 554 })
    expect(classifySmtpError(err)).toEqual({ code: 554, isTransient: false })
  })

  it('classifies network errors as transient (no code)', () => {
    expect(classifySmtpError(new Error('ECONNRESET'))).toEqual({ code: null, isTransient: true })
    expect(classifySmtpError(new Error('ETIMEDOUT'))).toEqual({ code: null, isTransient: true })
    expect(classifySmtpError(new Error('socket timeout'))).toEqual({ code: null, isTransient: true })
  })

  it('treats unknown errors as permanent', () => {
    expect(classifySmtpError(new Error('Something weird'))).toEqual({ code: null, isTransient: false })
  })
})

// --- SMTP_RETRY_DELAYS_MS ---

describe('SMTP_RETRY_DELAYS_MS', () => {
  it('has 5 delay values with increasing backoff', () => {
    expect(SMTP_RETRY_DELAYS_MS).toHaveLength(5)
    for (let i = 1; i < SMTP_RETRY_DELAYS_MS.length; i++) {
      expect(SMTP_RETRY_DELAYS_MS[i]).toBeGreaterThan(SMTP_RETRY_DELAYS_MS[i - 1])
    }
  })
})

// --- nodemailer v9 — targeted regression coverage ---
// Verifies behaviours that could silently regress on a nodemailer major bump:
//   1. MailComposer (deep-import) handles `alternatives` → RSVP calendar path §2.22.
//   2. sendMail spreads `alternatives` into the transport call.
//   3. OAuth2 auth object structure passed to createTransport.
//   4. TLS `servername` carried to the second createTransport on IP-fallback retry.

describe('nodemailer v9 — MailComposer alternatives passthrough', () => {
  it('buildRawMessage with alternatives produces multipart/alternative with calendar part', async () => {
    const icsContent = 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR'
    const raw = await buildRawMessage({
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'Meeting RSVP',
      text: 'I will attend',
      alternatives: [{ contentType: 'text/calendar; method=REPLY', content: icsContent }],
    })
    expect(Buffer.isBuffer(raw)).toBe(true)
    const str = raw.toString('utf8')
    // MailComposer wraps text + alternative in a multipart/alternative envelope
    expect(str.toLowerCase()).toContain('multipart/alternative')
    expect(str.toLowerCase()).toContain('text/calendar')
    expect(str.toLowerCase()).toContain('method=reply')
    expect(str).toContain('BEGIN:VCALENDAR')
  })

  it('buildRawMessage without alternatives stays plain text/plain — no calendar part leaked', async () => {
    const raw = await buildRawMessage({
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'Plain',
      text: 'Just text, no RSVP',
    })
    const str = raw.toString('utf8')
    expect(str).not.toContain('text/calendar')
    expect(str).not.toContain('BEGIN:VCALENDAR')
  })
})

describe('nodemailer v9 — sendMail alternatives thread-through', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDnsResolve4.mockResolvedValue(['1.2.3.4'])
  })

  it('passes alternatives array to transport sendMail without dropping or mutating it', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: '<rsvp@test>' })
    const alt = { contentType: 'text/calendar; method=REPLY', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }
    await sendMail(cfg, {
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'RSVP',
      text: 'I will attend',
      alternatives: [alt],
    })
    const callArgs = mockSendMail.mock.calls[0][0] as Record<string, unknown>
    const alts = callArgs.alternatives as Array<{ contentType: string; content: string | Buffer }>
    expect(alts).toBeDefined()
    expect(alts).toHaveLength(1)
    expect(alts[0].contentType).toBe('text/calendar; method=REPLY')
  })

  it('alternatives is absent from transport call when not supplied', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: '<no-alt@test>' })
    await sendMail(cfg, {
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'No alts',
      text: 'text only',
    })
    const callArgs = mockSendMail.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs.alternatives).toBeUndefined()
  })
})

describe('nodemailer v9 — createTransport auth and TLS config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    netConnectBehavior = 'connect'
    mockDnsResolve4.mockResolvedValue(['1.2.3.4'])
  })

  it('OAuth2 config passes auth.type="OAuth2", user and accessToken to createTransport', async () => {
    mockVerify.mockResolvedValueOnce(true)
    const oauthCfg: SmtpConfig = {
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      user: 'alice@gmail.com',
      accessToken: 'ya29.token',
    }
    await testSmtpConnection(oauthCfg)
    const callArg = vi.mocked(nodemailer.createTransport).mock.calls[0][0] as Record<string, unknown>
    const auth = callArg.auth as { type: string; user: string; accessToken: string }
    expect(auth.type).toBe('OAuth2')
    expect(auth.user).toBe('alice@gmail.com')
    expect(auth.accessToken).toBe('ya29.token')
  })

  it('password config passes user and pass (no type field) to createTransport', async () => {
    mockVerify.mockResolvedValueOnce(true)
    await testSmtpConnection(cfg)
    const callArg = vi.mocked(nodemailer.createTransport).mock.calls[0][0] as Record<string, unknown>
    const auth = callArg.auth as { user: string; pass: string; type?: string }
    expect(auth.user).toBe('alice@example.test')
    expect(auth.pass).toBe('secret')
    expect(auth.type).toBeUndefined()
  })

  it('on IP-fallback retry second createTransport call carries tls.servername = original hostname', async () => {
    mockVerify
      .mockRejectedValueOnce(new Error('Connection timeout'))
      .mockResolvedValueOnce(true)

    const result = await testSmtpConnection(cfg)
    expect(result.ok).toBe(true)
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(2)
    const secondCallArg = vi.mocked(nodemailer.createTransport).mock.calls[1][0] as Record<string, unknown>
    // The fallback transport connects by IP but must identify itself by the original hostname
    expect(secondCallArg.host).toBe('1.2.3.4')
    const tlsOpts = secondCallArg.tls as { servername?: string } | undefined
    expect(tlsOpts?.servername).toBe('smtp.example.test')
  })

  it('direct connect (no fallback, no pins) passes combined-CA tls options without weakening verification', async () => {
    mockVerify.mockResolvedValueOnce(true)
    await testSmtpConnection(cfg)
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1)
    const callArg = vi.mocked(nodemailer.createTransport).mock.calls[0][0] as Record<string, unknown>
    // buildTlsOptions(cfg) with no tlsPinsSha256 and no servername: on Node
    // builds with tls.getCACertificates the transport gets the combined
    // default + system CA list; on older builds it degrades to undefined
    // (Node's own default verification). Either way verification is never
    // weakened: rejectUnauthorized is stated EXPLICITLY as true, so no
    // transport library's own default can relax it, and there is no
    // checkServerIdentity override on the no-pin path.
    const { getCombinedCaCertificates } = await import('./tls')
    const combined = getCombinedCaCertificates()
    if (combined) {
      expect(callArg.tls).toEqual({ rejectUnauthorized: true, ca: combined })
    } else {
      expect(callArg.tls).toBeUndefined()
    }
  })

  it('pinned SMTP endpoint gets the same two-mode identity policy as IMAP', async () => {
    // SMTP has no TLS policy of its own — it hands buildTlsOptions() straight
    // to nodemailer (which merges `options.tls` last, so our
    // checkServerIdentity survives). This asserts the policy reaches the
    // sending path intact for a FINGERPRINT-ONLY pin, the mode that a
    // compromised renderer can create via `tls:addPin`: the hostname check
    // must still apply. The anchored mode (identity established by the pinned
    // certificate body) is covered against real handshakes in tls.test.ts.
    mockVerify.mockResolvedValueOnce(true)
    const pin = 'AA:BB:CC:DD'
    await testSmtpConnection({ ...cfg, tlsPinsSha256: [pin] })
    const callArg = vi.mocked(nodemailer.createTransport).mock.calls[0][0] as Record<string, unknown>
    const tlsOpts = callArg.tls as {
      rejectUnauthorized: boolean
      checkServerIdentity: (hostname: string, cert: unknown) => Error | undefined
    }
    expect(tlsOpts.rejectUnauthorized).toBe(true)

    // Pin matches, certificate names a different host → refused.
    const redirected = { fingerprint256: pin, subjectaltname: 'DNS:mail.other.test' }
    expect(tlsOpts.checkServerIdentity('smtp.example.test', redirected)).toBeInstanceOf(Error)

    // Pin matches and the name matches → accepted.
    const legit = { fingerprint256: pin, subjectaltname: 'DNS:smtp.example.test' }
    expect(tlsOpts.checkServerIdentity('smtp.example.test', legit)).toBeUndefined()

    // Rotated certificate → refused as a pin mismatch.
    const rotated = { fingerprint256: '11:22:33:44', subjectaltname: 'DNS:smtp.example.test' }
    const err = tlsOpts.checkServerIdentity('smtp.example.test', rotated)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('TLS pin mismatch')
  })
})

// --- smtp.send span instrumentation ----------------------------------------
// These tests verify that sendMail wires a telemetry span via the injected
// sink, surfaces bucketed attributes (never PII), and — critically — never
// fails the send when the telemetry layer is broken.

import { setNetTelemetrySink, setNetErrorReporter } from './telemetry'

describe('sendMail — smtp.send telemetry span', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    netConnectBehavior = 'connect'
    mockDnsResolve4.mockResolvedValue(['1.2.3.4'])
  })

  afterEach(() => {
    setNetTelemetrySink(null)
    setNetErrorReporter(null)
  })

  it('opens smtp.send span with provider + has_attachments + size_bucket', async () => {
    const end = vi.fn()
    const starter = vi.fn<(name: string, attrs: Record<string, unknown>) => { end: typeof end }>(() => ({ end }))
    setNetTelemetrySink(starter)
    mockSendMail.mockResolvedValueOnce({ messageId: '<spanned@test>' })

    await sendMail(
      { host: 'smtp.gmail.com', port: 587, secure: false, user: 'alice@gmail.com', pass: 'x' },
      { from: 'alice@gmail.com', to: 'bob@example.test', subject: 'Hi', text: 'tiny body' },
    )

    expect(starter).toHaveBeenCalledTimes(1)
    const [name, attrs] = starter.mock.calls[0]
    expect(name).toBe('smtp.send')
    expect(attrs).toEqual({
      provider: 'gmail',
      has_attachments: false,
      size_bucket: '<1KB',
    })
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('flags has_attachments=true and buckets the raw body size', async () => {
    const end = vi.fn()
    const starter = vi.fn<(name: string, attrs: Record<string, unknown>) => { end: typeof end }>(() => ({ end }))
    setNetTelemetrySink(starter)
    mockSendMail.mockResolvedValueOnce({ messageId: '<att@test>' })

    // ~5KB base64 -> ~3.75KB decoded, well inside the 1-10KB bucket.
    const big = Buffer.alloc(5 * 1024, 0x41).toString('base64')
    await sendMail(
      { host: 'mail.yandex.ru', port: 465, secure: true, user: 'alice@yandex.ru', pass: 'x' },
      {
        from: 'alice@yandex.ru',
        to: 'bob@example.test',
        subject: 'With att',
        text: 'body',
        attachments: [{ filename: 'photo.jpg', contentBase64: big, contentType: 'image/jpeg' }],
      },
    )

    const attrs = starter.mock.calls[0][1] as Record<string, unknown>
    expect(attrs.provider).toBe('yandex')
    expect(attrs.has_attachments).toBe(true)
    expect(attrs.size_bucket).toBe('1-10KB')
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('calls end() on error and reports to the error sink', async () => {
    const end = vi.fn()
    setNetTelemetrySink(() => ({ end }))
    const reporter = vi.fn()
    setNetErrorReporter(reporter)

    mockSendMail.mockRejectedValueOnce(new Error('permanent 550'))
    await expect(
      sendMail(cfg, { from: 'a@x', to: 'b@x', subject: 's', text: 't' }),
    ).rejects.toThrow('permanent 550')

    expect(end).toHaveBeenCalledTimes(1)
    expect(reporter).toHaveBeenCalledTimes(1)
    expect(reporter.mock.calls[0][0]).toBe('smtp.send')
  })

  it('a broken telemetry sink must not break the actual send', async () => {
    setNetTelemetrySink(() => { throw new Error('sentry exploded') })
    setNetErrorReporter(() => { throw new Error('reporter exploded') })
    mockSendMail.mockResolvedValueOnce({ messageId: '<resilient@test>' })

    const result = await sendMail(cfg, {
      from: 'alice@example.test',
      to: 'bob@example.test',
      subject: 'still works',
      text: 'body',
    })

    expect(result.messageId).toBe('<resilient@test>')
  })
})
