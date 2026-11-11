import http from 'node:http'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import tls from 'node:tls'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch } from 'undici'

const mockGetCombinedCa = vi.hoisted(() => vi.fn<() => string[] | null>())
vi.mock('../../packages/net/tls', () => ({
  getCombinedCaCertificates: mockGetCombinedCa,
}))

const mockLog = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../logger', () => ({ createLogger: vi.fn(() => mockLog) }))

import { getAiDispatcher, resetAiDispatchers, resolveFetchInput } from './aiHttpDispatcher'
// Shared with aiHttpDispatcher.streaming.test.ts — see that module's header
// for why the chain lives in one place. The server presents LEAF + ROOT,
// which reproduces the reported failure exactly: a chain ending at a root
// that Node's bundled store does not know → SELF_SIGNED_CERT_IN_CHAIN.
import { ROOT_CERT, LEAF_CERT, LEAF_KEY, errorCodes } from './aiHttpDispatcherTestCerts'

let server: https.Server
let origin: string
let proxy: http.Server
let proxyUrl: string
let proxyConnects = 0
// TLS-terminated CONNECT proxy for the `proxyTls` test (MEDIUM-1): unlike
// `proxy` above (plain HTTP listener), the client TLS-handshakes with THIS
// proxy before it ever sends CONNECT, so `getAiDispatcher`'s `proxyTls`
// secureContext is the one actually exercised.
let tlsProxy: https.Server
let tlsProxyUrl: string
let tlsProxyConnects = 0
// Server-side latch for `/v1/slow`: re-armed before each test, released by the
// in-flight test at the moment it chooses, and unconditionally in afterEach so
// a failing test cannot leave a response (and the suite) hanging.
let releaseSlow: () => void = () => {}
let slowLatch: Promise<void> = Promise.resolve()
function armSlowLatch(): void {
  slowLatch = new Promise<void>(resolve => { releaseSlow = resolve })
}

beforeAll(async () => {
  server = https.createServer({ key: LEAF_KEY, cert: LEAF_CERT + ROOT_CERT }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      // A request carrying `x-close: 1` gets `Connection: close` on the
      // RESPONSE, so a test can force a fresh TLS socket per request (see the
      // per-socket trust-store test).
      const headers: Record<string, string> = { 'content-type': 'text/plain' }
      if (req.headers['x-close'] === '1') headers.connection = 'close'
      // `/v1/slow` (MEDIUM-2): headers + first chunk immediately, then the
      // response is held open until the test calls `releaseSlow()` — an
      // explicit latch, not a timer, so "still in flight" is a fact rather
      // than a race against the clock.
      if (req.url === '/v1/slow') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('first-chunk ')
        void slowLatch.then(() => { if (!res.destroyed) res.end('second-chunk') })
        return
      }
      res.writeHead(200, headers)
      res.end(`${req.method} ${Buffer.concat(chunks).toString('utf8')}`)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `https://localhost:${(server.address() as AddressInfo).port}`

  // Minimal CONNECT proxy: tunnels TLS to the test server untouched, so the
  // certificate the client verifies is the target's, through `requestTls`.
  proxy = http.createServer((_req, res) => { res.writeHead(405).end() })
  proxy.on('connect', (req, clientSocket, head) => {
    proxyConnects++
    const [host, port] = (req.url ?? '').split(':')
    // `wrong-name.test` also lands on the test server, so the client sees a
    // chain it trusts for a name the leaf does not cover.
    const loopback = host === 'localhost' || host === 'wrong-name.test'
    const upstream = net.connect(Number(port), loopback ? '127.0.0.1' : host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`

  // Same LEAF+ROOT chain, this time as the proxy's OWN certificate — the
  // proxy is loopback-only "localhost", same as the target.
  tlsProxy = https.createServer({ key: LEAF_KEY, cert: LEAF_CERT + ROOT_CERT }, (_req, res) => {
    res.writeHead(405).end()
  })
  tlsProxy.on('connect', (req, clientSocket, head) => {
    tlsProxyConnects++
    const [host, port] = (req.url ?? '').split(':')
    const upstream = net.connect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise<void>(resolve => tlsProxy.listen(0, '127.0.0.1', resolve))
  tlsProxyUrl = `https://localhost:${(tlsProxy.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  proxy.closeAllConnections()
  tlsProxy.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await new Promise<void>(resolve => proxy.close(() => resolve()))
  await new Promise<void>(resolve => tlsProxy.close(() => resolve()))
})

beforeEach(() => {
  resetAiDispatchers()
  mockGetCombinedCa.mockReset()
  mockLog.warn.mockReset()
  proxyConnects = 0
  tlsProxyConnects = 0
  armSlowLatch()
})

afterEach(() => {
  releaseSlow()
  vi.restoreAllMocks()
  resetAiDispatchers()
})

describe('aiHttpDispatcher — direct path', () => {
  it('trusts a root that is only in the combined (OS) list', async () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const { dispatcher, proxyAgentCreated } = getAiDispatcher()
    expect(proxyAgentCreated).toBe(false)
    const res = await undiciFetch(`${origin}/v1/models`, { dispatcher })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('GET ')
  })

  it('degrades to Node default trust when the combined list is null — the chain is rejected by TLS, not refused by us', async () => {
    mockGetCombinedCa.mockReturnValue(null)
    const { dispatcher } = getAiDispatcher()
    const err = await undiciFetch(`${origin}/v1/models`, { dispatcher }).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (e: unknown) => e,
    )
    expect(errorCodes(err)).toContain('SELF_SIGNED_CERT_IN_CHAIN')
    // A null list is logged once per process by packages/net/tls.ts (its only
    // null path); the dispatcher must not log it a second time.
    expect(mockLog.warn).not.toHaveBeenCalled()
  })

  it('logs an EMPTY combined list (not seen by tls.ts) once, without any address, and uses default trust', async () => {
    mockGetCombinedCa.mockReturnValue([])
    const { dispatcher } = getAiDispatcher()
    getAiDispatcher(proxyUrl)
    getAiDispatcher('http://127.0.0.1:9')
    expect(mockLog.warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mockLog.warn.mock.calls)).not.toContain('127.0.0.1')
    const err = await undiciFetch(`${origin}/v1/models`, { dispatcher }).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (e: unknown) => e,
    )
    expect(errorCodes(err)).toContain('SELF_SIGNED_CERT_IN_CHAIN')
  })

  it('falls back to default trust (logged once) when the trust context cannot be built', async () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    vi.spyOn(tls, 'createSecureContext').mockImplementationOnce(() => { throw new Error('boom') })
    const { dispatcher } = getAiDispatcher()
    expect(mockLog.warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mockLog.warn.mock.calls)).not.toContain('BEGIN CERTIFICATE')
    const err = await undiciFetch(`${origin}/v1/models`, { dispatcher }).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (e: unknown) => e,
    )
    expect(errorCodes(err)).toContain('SELF_SIGNED_CERT_IN_CHAIN')
  })

  it('memoizes the dispatcher and the trust context — one CA read shared by direct and proxy agents', () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const a = getAiDispatcher().dispatcher
    const b = getAiDispatcher().dispatcher
    expect(a).toBe(b)
    getAiDispatcher(proxyUrl)
    getAiDispatcher('http://127.0.0.1:9')
    expect(mockGetCombinedCa).toHaveBeenCalledTimes(1)
  })

  it('builds the trust store once, not once per TLS socket (§2.156 cost)', async () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    // tls.connect builds a context via tls.createSecureContext whenever it is
    // handed raw `ca` instead of a `secureContext`; counting calls therefore
    // counts per-socket trust-store builds.
    const build = vi.spyOn(tls, 'createSecureContext')
    const { dispatcher } = getAiDispatcher()
    for (let i = 0; i < 3; i++) {
      // `x-close` makes the server close the connection → a new socket per request.
      const res = await undiciFetch(`${origin}/v1/models`, { dispatcher, headers: { 'x-close': '1' } })
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('accepts a Request object with a streamed body end to end', async () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const { dispatcher } = getAiDispatcher()
    const request = new Request(`${origin}/v1/chat`, { method: 'POST', body: 'hello' })
    const { url, init } = resolveFetchInput(request)
    const res = await undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])
    expect(await res.text()).toBe('POST hello')
  })

  it('accepts a keepalive Request with a string body end to end (keepalive is not forwarded)', async () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const { dispatcher } = getAiDispatcher()
    const request = new Request(`${origin}/v1/chat`, { method: 'POST', body: 'hello', keepalive: true })
    const { url, init } = resolveFetchInput(request)
    const res = await undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1])
    expect(await res.text()).toBe('POST hello')
  })
})

describe('aiHttpDispatcher — proxy path', () => {
  it('verifies the tunnelled target against the combined list', async () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const { dispatcher, proxyAgentCreated } = getAiDispatcher(proxyUrl)
    expect(proxyAgentCreated).toBe(true)
    const res = await undiciFetch(`${origin}/v1/models`, { dispatcher })
    expect(res.status).toBe(200)
    expect(proxyConnects).toBeGreaterThan(0)
  })

  it('keeps hostname verification with the shared context: a trusted chain for the wrong name is rejected', async () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const { dispatcher } = getAiDispatcher(proxyUrl)
    const port = (server.address() as AddressInfo).port
    const err = await undiciFetch(`https://wrong-name.test:${port}/v1/models`, { dispatcher }).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (e: unknown) => e,
    )
    expect(errorCodes(err)).toContain('ERR_TLS_CERT_ALTNAME_INVALID')
    expect(proxyConnects).toBeGreaterThan(0)
  })

  it('degrades to default trust through the proxy when the list is null', async () => {
    mockGetCombinedCa.mockReturnValue(null)
    const { dispatcher } = getAiDispatcher(proxyUrl)
    const err = await undiciFetch(`${origin}/v1/models`, { dispatcher }).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (e: unknown) => e,
    )
    expect(errorCodes(err)).toContain('SELF_SIGNED_CERT_IN_CHAIN')
    expect(proxyConnects).toBeGreaterThan(0)
  })

  it('rebuilds only when the proxy URL changes, and reports creation to the caller', () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const first = getAiDispatcher(proxyUrl)
    const same = getAiDispatcher(proxyUrl)
    expect(same.dispatcher).toBe(first.dispatcher)
    expect(same.proxyAgentCreated).toBe(false)
    const other = getAiDispatcher('http://127.0.0.1:9')
    expect(other.proxyAgentCreated).toBe(true)
    expect(other.dispatcher).not.toBe(first.dispatcher)
    // The direct dispatcher is a separate cache entry.
    expect(getAiDispatcher().dispatcher).not.toBe(other.dispatcher)
  })

  it('throws synchronously on a malformed proxy URL and keeps the previous agent', () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const good = getAiDispatcher(proxyUrl).dispatcher
    expect(() => getAiDispatcher('not-a-valid-proxy-url')).toThrow()
    const again = getAiDispatcher(proxyUrl)
    expect(again.dispatcher).toBe(good)
    expect(again.proxyAgentCreated).toBe(false)
  })

  // MEDIUM-1: every other proxy test above uses a PLAIN-HTTP CONNECT proxy —
  // the client never TLS-handshakes with the proxy itself, so `proxyTls`
  // (as opposed to `requestTls`, already covered above) is never exercised.
  // `tlsProxy` is TLS-terminated, so reaching it at all proves `proxyTls`'s
  // secureContext is the one undici actually used for that handshake.
  it('trusts the proxy itself only through the combined list, over a TLS-wrapped CONNECT proxy', async () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const { dispatcher } = getAiDispatcher(tlsProxyUrl)
    const res = await undiciFetch(`${origin}/v1/models`, { dispatcher })
    expect(res.status).toBe(200)
    expect(tlsProxyConnects).toBeGreaterThan(0)
  })

  it('rejects the TLS-wrapped proxy itself when the combined list is null (proxyTls, not requestTls)', async () => {
    mockGetCombinedCa.mockReturnValue(null)
    const { dispatcher } = getAiDispatcher(tlsProxyUrl)
    const err = await undiciFetch(`${origin}/v1/models`, { dispatcher }).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (e: unknown) => e,
    )
    // The failure is on the PROXY handshake (self-signed root, not in Node's
    // default store) — the request never reaches the CONNECT stage.
    expect(errorCodes(err)).toContain('SELF_SIGNED_CERT_IN_CHAIN')
    expect(tlsProxyConnects).toBe(0)
  })

  // MEDIUM-2: `getAiDispatcher` closes the OLD ProxyAgent (`.close()`) the
  // moment a caller asks for a different proxy URL. undici's `close()` waits
  // for in-flight requests to finish rather than aborting them (unlike
  // `destroy()`) — if a future change swapped it for `destroy()`, request A
  // below would lose its connection before the latch releases the second
  // chunk, and reading its body would fail instead of completing.
  it('does not abort a request already in flight through the proxy being replaced', async () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const dispatcherA = getAiDispatcher(proxyUrl).dispatcher
    // Await the Response itself first — that resolves once headers arrive
    // (the server sends them, plus the first chunk, immediately), so the
    // request is provably in the response phase, not merely enqueued, before
    // the dispatcher swap below. The server holds `/v1/slow` open until the
    // latch is released, which happens only AFTER the swap.
    const resA = await undiciFetch(`${origin}/v1/slow`, { dispatcher: dispatcherA })
    const { dispatcher: dispatcherB, proxyAgentCreated } = getAiDispatcher('http://127.0.0.1:9')
    expect(proxyAgentCreated).toBe(true)
    expect(dispatcherB).not.toBe(dispatcherA)

    releaseSlow()
    expect(await resA.text()).toBe('first-chunk second-chunk')

    // A fresh request through a live proxy still works — the cache was not
    // left in a broken state by the replacement.
    const { dispatcher: dispatcherC } = getAiDispatcher(proxyUrl)
    const resC = await undiciFetch(`${origin}/v1/models`, { dispatcher: dispatcherC })
    expect(resC.status).toBe(200)
  })
})

describe('aiHttpDispatcher — resetAiDispatchers', () => {
  // LOW-1: this is NOT what lets `settings:save` pick up a changed CA
  // snapshot — OS roots are frozen for the process lifetime (CLAUDE.md §5
  // "TLS trust"), and a changed proxy URL already triggers a rebuild without
  // any reset (see "rebuilds only when the proxy URL changes" above).
  // `resetAiDispatchers` exists for test isolation between suites: if it
  // forgot to drop EITHER cached agent, that one would keep serving requests
  // under an identity built by an earlier, unrelated test.
  it('drops both the direct and the proxy dispatcher identities', () => {
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const directBefore = getAiDispatcher().dispatcher
    const proxyBefore = getAiDispatcher(proxyUrl).dispatcher
    resetAiDispatchers()
    mockGetCombinedCa.mockReturnValue([ROOT_CERT])
    const directAfter = getAiDispatcher().dispatcher
    const proxyAfter = getAiDispatcher(proxyUrl).dispatcher
    expect(directAfter).not.toBe(directBefore)
    expect(proxyAfter).not.toBe(proxyBefore)
  })
})

describe('resolveFetchInput', () => {
  it('passes a string URL and init through', () => {
    const init = { method: 'POST' }
    expect(resolveFetchInput('https://a.example/x', init)).toEqual({ url: 'https://a.example/x', init })
  })

  it('uses href for a URL object', () => {
    expect(resolveFetchInput(new URL('https://a.example/y?q=1')).url).toBe('https://a.example/y?q=1')
  })

  it('unpacks a Request instead of stringifying it, with explicit init winning', () => {
    const request = new Request('https://a.example/z', { method: 'PUT', headers: { 'x-a': '1' } })
    const { url, init } = resolveFetchInput(request, { method: 'POST' })
    expect(url).toBe('https://a.example/z')
    expect(url).not.toContain('[object')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('x-a')).toBe('1')
    expect(init.body ?? null).toBeNull()
    expect((init as { duplex?: string }).duplex).toBeUndefined()
  })

  it('keeps the Request abort signal when init carries an explicit `signal: undefined`', () => {
    const controller = new AbortController()
    const request = new Request('https://a.example/z', { signal: controller.signal })
    const { init } = resolveFetchInput(request, { signal: undefined, method: undefined })
    expect(init.signal).toBeDefined()
    expect(init.method).toBe('GET')
    expect(init.signal?.aborted).toBe(false)
    controller.abort()
    expect(init.signal?.aborted).toBe(true)
  })

  it('lets a concrete replacement signal override the Request signal', () => {
    const original = new AbortController()
    const replacement = new AbortController()
    const request = new Request('https://a.example/z', { signal: original.signal })
    const { init } = resolveFetchInput(request, { signal: replacement.signal })
    expect(init.signal).toBe(replacement.signal)
  })

  it('preserves the rest of the Request state (redirect, integrity, cache, credentials, mode, referrer policy) and drops keepalive', () => {
    const request = new Request('https://a.example/z', {
      redirect: 'manual',
      integrity: 'sha256-abc',
      cache: 'no-store',
      credentials: 'omit',
      keepalive: true,
      mode: 'same-origin',
      referrerPolicy: 'no-referrer',
    })
    const { init } = resolveFetchInput(request, { redirect: undefined, integrity: undefined })
    expect(init).toMatchObject({
      redirect: 'manual',
      integrity: 'sha256-abc',
      cache: 'no-store',
      credentials: 'omit',
      mode: 'same-origin',
      referrerPolicy: 'no-referrer',
    })
    expect(init).not.toHaveProperty('keepalive')
  })

  it('derives duplex from the effective body: stream body → half, explicit `body: null` wins and drops it', () => {
    const request = new Request('https://a.example/z', { method: 'POST', body: 'payload' })
    const streamed = resolveFetchInput(request)
    expect(streamed.init.body).toBeInstanceOf(ReadableStream)
    expect((streamed.init as { duplex?: string }).duplex).toBe('half')

    const request2 = new Request('https://a.example/z', { method: 'POST', body: 'payload' })
    const cleared = resolveFetchInput(request2, { body: null })
    expect(cleared.init.body).toBeNull()
    expect((cleared.init as { duplex?: string }).duplex).toBeUndefined()

    const request3 = new Request('https://a.example/z', { method: 'POST', body: 'payload' })
    const kept = resolveFetchInput(request3, { body: undefined })
    expect(kept.init.body).toBeInstanceOf(ReadableStream)
  })

  // MEDIUM-3: the "explicit init winning" test above only exercises `method`.
  // `headers` goes through the SAME overlay loop but is a distinct field with
  // its own merge risk (a naive `{ ...request.headers, ...init.headers }`
  // would silently keep BOTH sets instead of the caller's headers replacing
  // the Request's — Headers objects do not spread like plain objects).
  it('lets explicit init headers replace the Request headers outright, not merge with them', () => {
    const request = new Request('https://a.example/z', { headers: { 'x-a': 'from-request', 'x-b': 'from-request' } })
    const { init } = resolveFetchInput(request, { headers: { 'x-a': 'from-init' } })
    const headers = new Headers(init.headers)
    expect(headers.get('x-a')).toBe('from-init')
    expect(headers.get('x-b')).toBeNull()
  })

  // A non-stream body override (e.g. a caller re-serialising the request as a
  // plain string) must NOT inherit `duplex: 'half'` from the Request's own
  // (always-streamed) body — `instanceof ReadableStream` is what the function
  // gates on, and this is the one case in the existing suite that never
  // replaces the stream body with a non-stream value.
  it('does not set duplex when an explicit body override is not a stream', () => {
    const request = new Request('https://a.example/z', { method: 'POST', body: 'original' })
    const { init } = resolveFetchInput(request, { body: 'plain-string-override' })
    expect(init.body).toBe('plain-string-override')
    expect((init as { duplex?: string }).duplex).toBeUndefined()
  })
})
