import { describe, expect, it, vi } from 'vitest'
import { APICallError, RetryError } from 'ai'
import { abortableDelay, isRetryableStreamFailure, toStreamError, createAttemptFence, describeStreamErrorForLog } from './aiStreamRetry'

function apiError(statusCode: number | undefined, isRetryable: boolean, message = 'provider failed'): APICallError {
  return new APICallError({
    message,
    url: 'https://api.example/v1/messages',
    requestBodyValues: {},
    statusCode,
    isRetryable,
  })
}

describe('isRetryableStreamFailure', () => {
  it.each([
    ['a retryable provider error', apiError(503, true)],
    ['a rate limit', apiError(429, true)],
    ['a connection reset by code', Object.assign(new Error('x'), { code: 'ECONNRESET' })],
    ['a reset behind a fetch wrapper', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })],
    ['an aggregate with one transient member', Object.assign(new Error('x'), { errors: [{ code: 'EPIPE' }] })],
    ['an in-stream overloaded payload', { type: 'overloaded_error', message: 'Overloaded' }],
    ['a wrapped payload', { error: { type: 'rate_limit_error' } }],
    ['a bare status on a wrapper error', Object.assign(new Error('x'), { statusCode: 502 })],
  ])('retries %s', (_label, err) => {
    expect(isRetryableStreamFailure(err)).toBe(true)
  })

  it.each([
    ['a permanent 4xx', apiError(400, false)],
    ['an explicit do-not-retry on a 5xx', apiError(500, false)],
    ['a 401', apiError(401, false)],
    ['an unknown payload type', { type: 'invalid_request_error', message: 'bad' }],
    ['a plain error', new Error('boom')],
    ['a string', 'ECONNRESET'],
    ['null', null],
    ['an abort', Object.assign(new Error('aborted'), { name: 'AbortError' })],
  ])('does not retry %s', (_label, err) => {
    expect(isRetryableStreamFailure(err)).toBe(false)
  })

  it.each([408, 409, 429, 500, 502, 599])('treats a bare status %i as transient', (status) => {
    expect(isRetryableStreamFailure({ status })).toBe(true)
    expect(isRetryableStreamFailure({ statusCode: status })).toBe(true)
  })

  it.each([200, 400, 401, 404, 499, 600, 503.5, '503', Number.NaN])('does not treat a bare status %s as transient', (status) => {
    expect(isRetryableStreamFailure({ status })).toBe(false)
    expect(isRetryableStreamFailure({ statusCode: status })).toBe(false)
  })

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])(
    'retries the transport code %s',
    (code) => {
      expect(isRetryableStreamFailure(Object.assign(new Error('x'), { code }))).toBe(true)
    },
  )

  it.each(['ECONNREFUSED', 'EACCES', 'ERR_INVALID_URL', 42])('does not retry the code %s', (code) => {
    expect(isRetryableStreamFailure(Object.assign(new Error('x'), { code }))).toBe(false)
  })

  it.each(['overloaded_error', 'rate_limit_error', 'api_error', 'server_error', 'rate_limit_exceeded'])(
    'retries the in-stream payload type %s',
    (type) => {
      expect(isRetryableStreamFailure({ type })).toBe(true)
    },
  )

  it('finds a transient typed error nested under a wrapper', () => {
    expect(isRetryableStreamFailure(Object.assign(new Error('wrapper'), { cause: apiError(503, true) }))).toBe(true)
  })

  it('does not retry a RetryError wrapped inside another error', () => {
    const exhausted = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [apiError(503, true)],
    })
    expect(isRetryableStreamFailure(exhausted)).toBe(false)
    expect(isRetryableStreamFailure(Object.assign(new Error('wrapper'), { cause: exhausted }))).toBe(false)
  })

  it('looks through at most five levels of nesting', () => {
    const nest = (levels: number): unknown => {
      let node: unknown = { code: 'ECONNRESET' }
      for (let i = 0; i < levels; i++) node = { cause: node }
      return node
    }
    expect(isRetryableStreamFailure(nest(5))).toBe(true)
    expect(isRetryableStreamFailure(nest(6))).toBe(false)
  })

  it('does not read the message text', () => {
    expect(isRetryableStreamFailure(new Error('503 rate limit overloaded ECONNRESET'))).toBe(false)
    expect(isRetryableStreamFailure(apiError(400, false, '429 rate limit 503'))).toBe(false)
  })

  it('lets an explicit do-not-retry on a typed provider error stand over its cause', () => {
    const err = Object.assign(apiError(400, false), { cause: { code: 'ECONNRESET' } })
    expect(isRetryableStreamFailure(err)).toBe(false)
  })

  it('treats the SDK retry layer giving up as terminal', () => {
    const exhausted = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [apiError(503, true), apiError(503, true), apiError(503, true)],
    })
    expect(isRetryableStreamFailure(exhausted)).toBe(false)
  })

  it('terminates on cyclic causes and survives hostile values', () => {
    const a: Record<string, unknown> = {}
    a.cause = a
    expect(isRetryableStreamFailure(a)).toBe(false)
    const hostile = new Proxy({}, { get() { throw new Error('boom') }, has() { throw new Error('boom') } })
    expect(isRetryableStreamFailure(hostile)).toBe(false)
  })
})

describe('toStreamError', () => {
  it('returns an Error unchanged', () => {
    const e = new Error('x')
    expect(toStreamError(e)).toBe(e)
  })

  it('gives a payload object a readable message and keeps it as the cause', () => {
    const payload = { type: 'overloaded_error', message: 'Overloaded' }
    const e = toStreamError(payload)
    expect(e.message).toBe('Overloaded')
    expect((e as { cause?: unknown }).cause).toBe(payload)
    expect(isRetryableStreamFailure(e)).toBe(true)
  })

  it('digs the message out of a wrapped payload and falls back to a neutral text', () => {
    expect(toStreamError({ error: { message: 'inner' } }).message).toBe('inner')
    expect(toStreamError({ type: 'weird' }).message).toBe('weird')
    expect(toStreamError(42).message).toBe('AI provider stream error')
    expect(toStreamError(undefined).message).toBe('AI provider stream error')
  })

  it('uses a string payload as the message and keeps it as the cause', () => {
    const e = toStreamError('provider blew up')
    expect(e.message).toBe('provider blew up')
    expect((e as { cause?: unknown }).cause).toBe('provider blew up')
  })

  it('falls through empty message fields to the next source, then to the neutral text', () => {
    expect(toStreamError({ message: '', error: { message: 'inner' } }).message).toBe('inner')
    expect(toStreamError({ message: '', type: 'weird' }).message).toBe('weird')
    expect(toStreamError('').message).toBe('AI provider stream error')
    expect(toStreamError({}).message).toBe('AI provider stream error')
    expect(toStreamError(null).message).toBe('AI provider stream error')
  })

  it('never throws on a payload with hostile getters', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom') } })
    expect(toStreamError(hostile).message).toBe('AI provider stream error')
  })

  it('does not let an exotic thrown value escape as itself', () => {
    const hostile = new Proxy(new Error('x'), { getPrototypeOf() { throw new Error('boom') } })
    expect(toStreamError(hostile)).toBeInstanceOf(Error)
  })
})

describe('abortableDelay', () => {
  it('resolves true after the full wait with a clear signal', async () => {
    vi.useFakeTimers()
    try {
      const p = abortableDelay(1000, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(p).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves false at once when aborted during the wait, clearing the timer', async () => {
    vi.useFakeTimers()
    try {
      const ac = new AbortController()
      const p = abortableDelay(60_000, ac.signal)
      expect(vi.getTimerCount()).toBe(1)
      ac.abort()
      await expect(p).resolves.toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wait at all on an already-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(abortableDelay(60_000, ac.signal)).resolves.toBe(false)
  })

  it('removes its abort listener once the wait has elapsed', async () => {
    vi.useFakeTimers()
    try {
      const ac = new AbortController()
      const remove = vi.spyOn(ac.signal, 'removeEventListener')
      const p = abortableDelay(500, ac.signal)
      await vi.advanceTimersByTimeAsync(500)
      await expect(p).resolves.toBe(true)
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not resolve early before the wait has elapsed', async () => {
    vi.useFakeTimers()
    try {
      let settled = false
      const p = abortableDelay(1000, new AbortController().signal).then(v => { settled = true; return v })
      await vi.advanceTimersByTimeAsync(999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(p).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports false when the signal aborts exactly as the timer fires', async () => {
    vi.useFakeTimers()
    try {
      const ac = new AbortController()
      const p = abortableDelay(10, ac.signal)
      // Abort first, in the same tick the timer would otherwise win.
      ac.abort()
      await vi.advanceTimersByTimeAsync(10)
      await expect(p).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createAttemptFence', () => {
  it('raises progress when a tool starts, BEFORE running it, and passes arguments and result through', async () => {
    const fence = createAttemptFence()
    const order: string[] = []
    const execute = vi.fn(async (input: unknown, options: unknown) => {
      order.push(`execute:${fence.progressed}`)
      return { echoed: input, options }
    })
    const tools = fence.wrap({ create_draft: { description: 'd', execute } })
    expect(fence.progressed).toBe(false)

    const out = await (tools.create_draft.execute as (a: unknown, b: unknown) => Promise<unknown>)({ x: 1 }, { id: 'o' })

    expect(order).toEqual(['execute:true'])
    expect(out).toEqual({ echoed: { x: 1 }, options: { id: 'o' } })
    expect(tools.create_draft.description).toBe('d')
    expect(fence.progressed).toBe(true)
  })

  it('refuses every start after close() without touching the handler or the flag', () => {
    const fence = createAttemptFence()
    const execute = vi.fn()
    const tools = fence.wrap({ t: { execute } })
    fence.close()
    fence.close()

    expect(() => (tools.t.execute as () => void)()).toThrow(/abandoned/)
    expect(execute).not.toHaveBeenCalled()
    expect(fence.progressed).toBe(false)
  })

  it('keeps fences independent: a closed attempt does not close the next one', () => {
    const first = createAttemptFence()
    const second = createAttemptFence()
    const execute = vi.fn(() => 'ran')
    const a = first.wrap({ t: { execute } })
    const b = second.wrap({ t: { execute } })
    first.close()

    expect(() => (a.t.execute as () => void)()).toThrow()
    expect((b.t.execute as () => string)()).toBe('ran')
    expect(first.progressed).toBe(false)
    expect(second.progressed).toBe(true)
  })

  it('counts a start that then throws, and leaves tools without execute untouched', () => {
    const fence = createAttemptFence()
    const boom = new Error('boom')
    const providerTool = { type: 'provider-defined', id: 'web_search' }
    const tools = fence.wrap({ bad: { execute: () => { throw boom } }, web_search: providerTool })

    expect(() => (tools.bad.execute as () => void)()).toThrow(boom)
    expect(fence.progressed).toBe(true)
    expect(tools.web_search).toBe(providerTool)
  })

  it('does not mutate the toolset it wraps, so a later fence still reaches the original handler', () => {
    const base = { t: { execute: vi.fn(() => 'ran') } }
    const original = base.t.execute
    const first = createAttemptFence()
    const second = createAttemptFence()
    first.wrap(base)
    const fenced = second.wrap(base)
    first.close()

    expect(base.t.execute).toBe(original)
    expect((fenced.t.execute as () => string)()).toBe('ran')
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('records progress noted from stream parts', () => {
    const fence = createAttemptFence()
    fence.noteProgress()
    expect(fence.progressed).toBe(true)
  })
})

describe('describeStreamErrorForLog', () => {
  it('names the class and the status, and nothing of the request or response', () => {
    const err = new APICallError({
      message: 'boom with CONFIDENTIAL text',
      url: 'https://api.example/v1/messages?key=SECRET',
      requestBodyValues: { messages: [{ role: 'user', content: 'CONFIDENTIAL prompt' }] },
      statusCode: 529,
      responseBody: 'CONFIDENTIAL response',
      isRetryable: true,
    })
    const text = describeStreamErrorForLog(err)

    expect(text).toBe('AI_APICallError status=529')
    expect(text).not.toMatch(/CONFIDENTIAL|SECRET|api\.example/)
  })

  it('degrades to a type name for non-errors and survives hostile values', () => {
    expect(describeStreamErrorForLog({ type: 'overloaded_error', message: 'x' })).toBe('object')
    expect(describeStreamErrorForLog('str')).toBe('string')
    const hostile = new Proxy({}, { get() { throw new Error('boom') }, getPrototypeOf() { throw new Error('boom') } })
    expect(describeStreamErrorForLog(hostile)).toBe('unknown error')
  })
})

describe('createAttemptFence — started tools', () => {
  it('records name, call id and input of every started call, in order', () => {
    const fence = createAttemptFence()
    const tools = fence.wrap({ a: { execute: vi.fn() }, b: { execute: vi.fn() } })
    ;(tools.a.execute as (i: unknown, o: unknown) => void)({ n: 1 }, { toolCallId: 'c1' })
    ;(tools.b.execute as (i: unknown, o: unknown) => void)({ n: 2 }, { toolCallId: 'c2' })
    ;(tools.a.execute as (i: unknown) => void)({ n: 3 })

    expect(fence.startedTools()).toEqual([
      { toolName: 'a', toolCallId: 'c1', input: { n: 1 } },
      { toolName: 'b', toolCallId: 'c2', input: { n: 2 } },
      { toolName: 'a', toolCallId: undefined, input: { n: 3 } },
    ])
  })

  it('does not record a start the closed fence refused', () => {
    const fence = createAttemptFence()
    const tools = fence.wrap({ a: { execute: vi.fn() } })
    fence.close()
    expect(() => (tools.a.execute as () => void)()).toThrow()
    expect(fence.startedTools()).toEqual([])
  })
})
