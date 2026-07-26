import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sendMailViaGraph, GraphSendError } from './graphSend'
import {
  setNetTelemetrySink,
  type NetSpanStarter,
} from './telemetry'
import type { SendMailOptions } from './smtp'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MinimalResponse = {
  status: number
  ok?: boolean
  text: () => Promise<string>
}

function makeResponse(status: number, body = ''): MinimalResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body),
  }
}

const baseOptions: SendMailOptions = {
  from: 'alice@outlook.com',
  to: 'bob@example.com',
  subject: 'Test subject',
  text: 'Hello world',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('packages/net/graphSend', () => {
  beforeEach(() => {
    // Restore default no-op sink before each test so tests that assert
    // on the span sink start from a known baseline.
    setNetTelemetrySink(null)
  })

  afterEach(() => {
    // Always clear any sink a test installed so the next test file
    // doesn't inherit assertion-capturing telemetry state.
    setNetTelemetrySink(null)
  })

  it('POSTs base64-encoded MIME to the correct Graph endpoint with bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(202))

    await sendMailViaGraph({
      accessToken: 'graph-token-xyz',
      options: baseOptions,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      Authorization: 'Bearer graph-token-xyz',
      'Content-Type': 'text/plain',
    })

    // Body is base64 of a RFC822 MIME message. Decoding must yield
    // something that includes From/To/Subject headers.
    expect(typeof init.body).toBe('string')
    const decoded = Buffer.from(init.body as string, 'base64').toString('utf8')
    expect(decoded).toMatch(/^From:\s*alice@outlook\.com/im)
    expect(decoded).toMatch(/^To:\s*bob@example\.com/im)
    expect(decoded).toMatch(/^Subject:\s*Test subject/im)
    // Body is included too
    expect(decoded).toContain('Hello world')
  })

  it('returns {messageId} extracted from the compiled MIME Message-ID header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(202))

    const result = await sendMailViaGraph({
      accessToken: 'tok',
      options: baseOptions,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    // MailComposer auto-generates `Message-ID: <local@domain>` during
    // compile(). We extract the angle-bracket contents. The exact value
    // varies per invocation (contains random token) — assert only shape.
    expect(result.messageId).toBeTypeOf('string')
    expect(result.messageId).toMatch(/^[^<>]+@[^<>]+$/)
    expect(result.messageId.length).toBeGreaterThan(0)
  })

  it('throws GraphSendError with status and body on non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(401, 'unauthorized body'))

    try {
      await sendMailViaGraph({
        accessToken: 'bad-token',
        options: baseOptions,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      expect.fail('should have thrown GraphSendError')
    } catch (err) {
      expect(err).toBeInstanceOf(GraphSendError)
      const gse = err as GraphSendError
      expect(gse.name).toBe('GraphSendError')
      expect(gse.status).toBe(401)
      expect(gse.body).toBe('unauthorized body')
      expect(gse.message).toMatch(/HTTP 401/)
    }
  })

  it('throws GraphSendError on 500 with empty body (text() rejects)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      text: () => Promise.reject(new Error('stream closed')),
    })

    const err = await sendMailViaGraph({
      accessToken: 'tok',
      options: baseOptions,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch(e => e)

    expect(err).toBeInstanceOf(GraphSendError)
    expect((err as GraphSendError).status).toBe(500)
    // When text() rejects, the body should fall back to empty string
    expect((err as GraphSendError).body).toBe('')
  })

  it('accepts 200-299 as success (201 Created)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(201))
    const result = await sendMailViaGraph({
      accessToken: 'tok',
      options: baseOptions,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.messageId).toBeTypeOf('string')
  })

  it('includes html content in the compiled MIME when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(202))

    await sendMailViaGraph({
      accessToken: 'tok',
      options: {
        ...baseOptions,
        html: '<p>Hello <b>world</b></p>',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const [, init] = fetchImpl.mock.calls[0]
    const decoded = Buffer.from(init.body as string, 'base64').toString('utf8')
    expect(decoded).toMatch(/<p>Hello <b>world<\/b><\/p>/)
    // Multipart structure expected when both text and html are present
    expect(decoded).toMatch(/multipart\/alternative/i)
  })

  it('uses global fetch when fetchImpl is not provided', async () => {
    const globalFetch = vi.fn().mockResolvedValue(makeResponse(202))
    vi.stubGlobal('fetch', globalFetch)

    try {
      await sendMailViaGraph({
        accessToken: 'tok',
        options: baseOptions,
      })
      expect(globalFetch).toHaveBeenCalledTimes(1)
      expect(globalFetch.mock.calls[0][0]).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fires a "smtp.send" telemetry span around the request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(202))

    const calls: Array<{ name: string; attrs: Record<string, unknown> }> = []
    const endFn = vi.fn()
    const starter: NetSpanStarter = (name, attrs) => {
      calls.push({ name, attrs: { ...attrs } })
      return { end: endFn }
    }
    setNetTelemetrySink(starter)

    try {
      await sendMailViaGraph({
        accessToken: 'tok',
        options: baseOptions,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    } finally {
      setNetTelemetrySink(null)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('smtp.send')
    // Attribute bag should carry provider and attachment flag
    expect(calls[0].attrs).toMatchObject({
      provider: expect.any(String),
      has_attachments: false,
    })
    expect(endFn).toHaveBeenCalledTimes(1)
  })

  it('ends the span and propagates the error when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))

    const endFn = vi.fn()
    setNetTelemetrySink(() => ({ end: endFn }))

    try {
      await expect(
        sendMailViaGraph({
          accessToken: 'tok',
          options: baseOptions,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toThrow('network down')
    } finally {
      setNetTelemetrySink(null)
    }

    // span.end() must be called on error path too
    expect(endFn).toHaveBeenCalledTimes(1)
  })

  it('marks has_attachments=true when attachments are present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(202))

    const calls: Array<{ name: string; attrs: Record<string, unknown> }> = []
    setNetTelemetrySink((name, attrs) => {
      calls.push({ name, attrs: { ...attrs } })
      return { end: vi.fn() }
    })

    try {
      await sendMailViaGraph({
        accessToken: 'tok',
        options: {
          ...baseOptions,
          attachments: [{
            filename: 'doc.txt',
            contentBase64: Buffer.from('hello').toString('base64'),
            contentType: 'text/plain',
          }],
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    } finally {
      setNetTelemetrySink(null)
    }

    expect(calls[0].attrs.has_attachments).toBe(true)
  })
})

describe('GraphSendError', () => {
  it('exposes status and body as readonly fields', () => {
    const err = new GraphSendError(403, 'forbidden')
    expect(err.status).toBe(403)
    expect(err.body).toBe('forbidden')
    expect(err.name).toBe('GraphSendError')
    expect(err).toBeInstanceOf(Error)
  })

  it('accepts a custom message override', () => {
    const err = new GraphSendError(429, 'throttled body', 'Rate limited')
    expect(err.message).toBe('Rate limited')
    expect(err.status).toBe(429)
    expect(err.body).toBe('throttled body')
  })

  it('builds a default message from status when no override is given', () => {
    const err = new GraphSendError(502, '')
    expect(err.message).toMatch(/Graph sendMail failed \(HTTP 502\)/)
  })
})
