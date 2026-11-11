/**
 * Real network / real SDK coverage for `aiHttpDispatcher.ts`.
 *
 * WHY THIS FILE IS SEPARATE FROM `aiHttpDispatcher.test.ts`. That file proves
 * the dispatcher's TRUST behaviour (which CA list wins, memoization, proxy
 * legs) against small non-streamed responses. It does not prove that a real,
 * chunked, streamed response — the shape a Vercel AI SDK streaming chat call
 * takes (Gemini's REST calls, `checkAuth`'s model list and `aiChatSimple` are
 * plain non-streaming JSON, not SSE) — survives the npm-undici body all the
 * way through the SDK's SSE parser. `ai.test.ts` cannot prove that either: it
 * partially mocks `undici`
 * (`fetch` routed to `globalThis.fetch`), which is deliberate there (see that
 * file's header) but means nothing in that suite ever touches a real
 * npm-undici `Response` body.
 *
 * WHICH SEAM THIS FILE DRIVES. `aiFetch` / `providerFetch` in `ai.ts` are not
 * exported — `ai.ts` is a hotspot (CLAUDE.md §5) and neither has a reason to
 * be public outside it. `composedFetch` below IS a reimplementation: a test
 * replica of `ai.ts`'s private `providerFetch`+`aiFetch` composition, built
 * from the three symbols `aiHttpDispatcher.ts` DOES export — `resolveFetchInput`
 * to unpack whatever the SDK hands it, `getAiDispatcher` for the CA-carrying
 * dispatcher, and npm undici's own `fetch` to dispatch. That `ai.ts` actually
 * wires those three together in this order is proven separately, by the
 * "really dispatches through aiHttpDispatcher" blocks in `ai.test.ts`; this
 * file's job is narrower — given that composition, does a real chunked body
 * survive it end to end.
 */
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch } from 'undici'
import { streamText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

const mockGetCombinedCa = vi.hoisted(() => vi.fn<() => string[] | null>())
vi.mock('../../packages/net/tls', () => ({
  getCombinedCaCertificates: mockGetCombinedCa,
}))

const mockLog = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../logger', () => ({ createLogger: vi.fn(() => mockLog) }))

import { getAiDispatcher, resetAiDispatchers, resolveFetchInput } from './aiHttpDispatcher'
import { ROOT_CERT, LEAF_CERT, LEAF_KEY } from './aiHttpDispatcherTestCerts'

function composedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const { url, init: resolved } = resolveFetchInput(input, init)
  const { dispatcher } = getAiDispatcher()
  return undiciFetch(url, { ...resolved, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
}

let server: https.Server
let origin: string
/**
 * Resolved by the server's `close` handler in the abort scenario — see below.
 * `close` fires for a normal `res.end()` too, so the verdict carries whether
 * the connection tore down BEFORE the latched completion could run
 * (`res.writableEnded === false`), not just that `close` happened at all.
 */
let onPrematureClose: ((verdict: { premature: boolean }) => void) | null = null
/**
 * Server-side latch for the abort scenario's second chunk: the server holds it
 * until released, instead of racing a fixed timer against the abort. Re-armed
 * in beforeEach, released in afterEach; a response whose connection already
 * closed never writes (see the handler), so a release after close is inert.
 */
let releaseSecondChunk: () => void = () => {}
let secondChunkLatch: Promise<void> = Promise.resolve()

function sendSse(res: ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

function handleChatCompletions(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1700000000, model: 'test-model' }
  if (req.headers['x-scenario'] === 'abort') {
    // First chunk arrives immediately; the second is held behind a latch the
    // test never releases before aborting, so a passing test proves the client
    // actually stopped waiting — there is no delayed write to race the abort.
    sendSse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }] })
    let closed = false
    res.on('close', () => {
      closed = true
      onPrematureClose?.({ premature: !res.writableEnded })
    })
    void secondChunkLatch.then(() => {
      if (closed || res.destroyed) return
      sendSse(res, { ...base, choices: [{ index: 0, delta: { content: 'never arrives' }, finish_reason: null }] })
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  // Default scenario: two real, delayed chunks then a clean finish + [DONE] —
  // exercising the SSE parser across multiple TCP writes, not one flat body.
  const steps: Array<() => void> = [
    () => sendSse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] }),
    () => sendSse(res, { ...base, choices: [{ index: 0, delta: { content: ', world' }, finish_reason: null }] }),
    () => {
      sendSse(res, {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    },
  ]
  let i = 0
  const tick = (): void => {
    steps[i]()
    i++
    if (i < steps.length) setTimeout(tick, 15)
  }
  tick()
}

beforeAll(async () => {
  server = https.createServer({ key: LEAF_KEY, cert: LEAF_CERT + ROOT_CERT }, (req, res) => {
    if (req.url === '/v1/chat/completions') return handleChatCompletions(req, res)
    if (req.url === '/v1/json') {
      // LOW-2: a non-200 status with real headers, through the real
      // dispatcher — the callers this protects (Gemini's REST calls,
      // checkAuth's model list, aiChatSimple) all read `.ok` / `.status` /
      // `.headers.get` / `.json()` off whatever `aiFetch` hands back.
      res.writeHead(429, { 'content-type': 'application/json', 'x-request-id': 'req-123', 'retry-after': '2' })
      res.end(JSON.stringify({ error: { message: 'rate limited', code: 'rate_limited' } }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `https://localhost:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(() => {
  resetAiDispatchers()
  mockGetCombinedCa.mockReturnValue([ROOT_CERT])
  onPrematureClose = null
  secondChunkLatch = new Promise<void>(resolve => { releaseSecondChunk = resolve })
})

afterEach(() => {
  releaseSecondChunk()
  vi.restoreAllMocks()
  resetAiDispatchers()
})

describe('aiHttpDispatcher — real SSE stream through the real undici body (HIGH-1)', () => {
  it('yields ordered text deltas and a clean finish from a real chunked SSE response', async () => {
    const provider = createOpenAICompatible({
      name: 'test-provider',
      baseURL: `${origin}/v1`,
      apiKey: 'test-key',
      fetch: composedFetch,
    })
    const result = streamText({ model: provider('test-model'), prompt: 'Say hello' })

    const deltas: string[] = []
    for await (const part of result.fullStream) {
      if (part.type === 'error') throw new Error(`unexpected stream error: ${String(part.error)}`)
      if (part.type === 'text-delta') deltas.push(part.text)
    }
    // ORDER matters here, not just membership: a parser that buffered and
    // reordered SSE events, or that dropped the mid-stream chunk boundary,
    // would still pass a `toContain` check but fail this one.
    expect(deltas).toEqual(['Hello', ', world'])
    expect(await result.finishReason).toBe('stop')
    expect((await result.usage).outputTokens).toBe(3)
  })
})

describe('aiHttpDispatcher — abort mid-stream over the real dispatcher (HIGH-2)', () => {
  it('rejects the in-flight read and the server observes the connection close', async () => {
    const provider = createOpenAICompatible({
      name: 'test-provider',
      baseURL: `${origin}/v1`,
      apiKey: 'test-key',
      headers: { 'x-scenario': 'abort' },
      fetch: composedFetch,
    })
    const closeSeen = new Promise<{ premature: boolean }>(resolve => { onPrematureClose = resolve })
    const controller = new AbortController()
    const result = streamText({ model: provider('test-model'), prompt: 'Say hello', abortSignal: controller.signal })

    const iterator = result.fullStream[Symbol.asyncIterator]()
    let sawFirstDelta = false
    for (;;) {
      const { value, done } = await iterator.next()
      if (done) throw new Error('stream ended before the first text delta arrived — nothing to abort mid-response')
      if (value.type === 'text-delta') { sawFirstDelta = true; break }
    }
    expect(sawFirstDelta).toBe(true)

    controller.abort()
    // The SDK surfaces a clean `abort` stream part rather than throwing from
    // `fullStream` (that path is for errors that terminate the stream
    // unexpectedly) — but it is still driven by the signal actually reaching
    // the fetch: a version of `resolveFetchInput` that dropped the Request's
    // signal, or a `composedFetch` that forgot to pass it to `undiciFetch`,
    // would instead hang here, since the second chunk is never released.
    const next = await iterator.next()
    expect(next.done).toBe(false)
    expect(next.value).toMatchObject({ type: 'abort' })
    // The server-side half of the guarantee: not just "the client SDK
    // observed an abort", but the underlying TCP connection actually tore
    // down BEFORE the held completion could run — `close` alone does not prove
    // this (it fires after a normal `res.end()` too), so the verdict is
    // checked explicitly rather than just awaiting the promise's resolution.
    const verdict = await closeSeen
    expect(verdict.premature).toBe(true)
  })
})

describe('aiHttpDispatcher — real Response for non-streaming callers (LOW-2)', () => {
  it('exposes status, headers and a parsed JSON body for a real non-200 response', async () => {
    const res = await composedFetch(`${origin}/v1/json`)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(429)
    expect(res.headers.get('x-request-id')).toBe('req-123')
    expect(res.headers.get('retry-after')).toBe('2')
    const body = await res.json()
    expect(body).toEqual({ error: { message: 'rate limited', code: 'rate_limited' } })
  })
})
