/**
 * `classifyAiFailure` — the closed category of a failed AI request, read from the STRUCTURE of the error
 * (status code, error `type`, system code) and never from its message text.
 */
import { describe, expect, it } from 'vitest'
import { APICallError, RetryError } from 'ai'
import { classifyAiFailure } from './aiFailureKind'

const withStatus = (statusCode: number, message = 'provider said something') => Object.assign(new Error(message), { statusCode })
const withCode = (code: string) => Object.assign(new Error('socket trouble'), { code })
/** `new Error(msg, { cause })` needs a newer lib than the project's tsconfig; the property is all the classifier reads. */
const wrapping = (message: string, cause: unknown) => Object.assign(new Error(message), { cause })

const apiError = (statusCode: number | undefined, extra: { responseBody?: string; cause?: unknown } = {}) => new APICallError({
  message: 'call failed', url: 'https://api.example.test/v1/chat', requestBodyValues: {}, statusCode, ...extra,
})

describe('classifyAiFailure — HTTP status', () => {
  it.each([[401, 'access'], [403, 'access']] as const)('reads %i as %s', (status, kind) => {
    expect(classifyAiFailure(withStatus(status))).toBe(kind)
  })

  it.each([[402, 'limit'], [429, 'limit']] as const)('reads %i as %s', (status, kind) => {
    expect(classifyAiFailure(withStatus(status))).toBe(kind)
  })

  it('reads 408 as timeout', () => {
    expect(classifyAiFailure(withStatus(408))).toBe('timeout')
  })

  // A bare 404 names a route, not a model: a wrong path prefix on an OpenAI-compatible server answers it for every
  // request, and choosing another model would fix nothing. Only a model marker in the answer makes it a model failure.
  it('reads a bare 404 as endpoint, not as model', () => {
    expect(classifyAiFailure(withStatus(404))).toBe('endpoint')
    expect(classifyAiFailure(Object.assign(new Error('x'), { statusCode: 404, data: { error: { message: 'Not Found' } } }))).toBe('endpoint')
  })

  it.each([
    ['OpenAI error.code', { error: { code: 'model_not_found', type: 'invalid_request_error' } }],
    ['Anthropic error.type', { type: 'error', error: { type: 'not_found_error' } }],
  ])('reads a 404 carrying a model marker (%s) as model', (_n, data) => {
    expect(classifyAiFailure(Object.assign(new Error('x'), { statusCode: 404, data }))).toBe('model')
  })

  it('reads a model marker without a status as model', () => {
    expect(classifyAiFailure({ code: 'model_not_found' })).toBe('model')
  })

  it.each([400, 413, 422, 500, 502, 503, 529, 599])('reads %i as provider', status => {
    expect(classifyAiFailure(withStatus(status))).toBe('provider')
  })

  it.each([200, 301, 399, 600, 0, -401])('reads %i as nothing: not an error status', status => {
    expect(classifyAiFailure(withStatus(status))).toBeUndefined()
  })

  it.each([['a string', '401'], ['a float', 401.5], ['NaN', Number.NaN]])('ignores a status that is %s', (_n, status) => {
    expect(classifyAiFailure(Object.assign(new Error('x'), { statusCode: status }))).toBeUndefined()
  })

  it('also reads the `status` property some SDKs use', () => {
    expect(classifyAiFailure(Object.assign(new Error('x'), { status: 401 }))).toBe('access')
  })

  it('reads the status of a real APICallError', () => {
    expect(classifyAiFailure(apiError(429))).toBe('limit')
    expect(classifyAiFailure(apiError(401))).toBe('access')
  })

  it('claims nothing for an APICallError with no status, no cause and no structure, whatever its body text says', () => {
    // The body text names a rate limit; the structure does not, so no category is claimed.
    expect(classifyAiFailure(apiError(undefined, { responseBody: '{"error":{"message":"rate limit"}}' }))).toBeUndefined()
  })
})

describe('classifyAiFailure — a real APICallError / RetryError (transport failures sit in `cause`)', () => {
  // A request that never got a response has no `statusCode`; the system code is on the error beneath it.
  it.each([
    ['ECONNREFUSED', 'network'],
    ['ENOTFOUND', 'network'],
    ['ECONNRESET', 'network'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['ETIMEDOUT', 'timeout'],
  ] as const)('an APICallError without a status whose cause carries %s is %s', (code, kind) => {
    expect(classifyAiFailure(apiError(undefined, { cause: withCode(code) }))).toBe(kind)
  })

  it('follows the cause of a status-less APICallError through a wrapper layer (fetch failed -> socket error)', () => {
    const fetchFailed = wrapping('fetch failed', withCode('ECONNREFUSED'))
    expect(classifyAiFailure(apiError(undefined, { cause: fetchFailed }))).toBe('network')
  })

  it('an APICallError WITH status 401 is still access', () => {
    expect(classifyAiFailure(apiError(401))).toBe('access')
  })

  it('the status wins over a system code in the cause of the same APICallError', () => {
    expect(classifyAiFailure(apiError(401, { cause: withCode('ECONNREFUSED') }))).toBe('access')
    expect(classifyAiFailure(apiError(429, { cause: withCode('ETIMEDOUT') }))).toBe('limit')
  })

  it('a status-less APICallError whose cause has no recognisable structure is undefined', () => {
    expect(classifyAiFailure(apiError(undefined, { cause: new Error('ECONNREFUSED 127.0.0.1:1') }))).toBeUndefined()
    expect(classifyAiFailure(apiError(undefined, { cause: withCode('EWHATEVER') }))).toBeUndefined()
  })

  it('a RetryError whose last error is a status-less APICallError is classified through that error\'s cause', () => {
    const retry = new RetryError({
      message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded',
      errors: [apiError(undefined), apiError(undefined), apiError(undefined, { cause: withCode('ECONNREFUSED') })],
    })
    expect(classifyAiFailure(retry)).toBe('network')
  })

  it('a RetryError whose last error says nothing falls back to an earlier attempt that carries a status', () => {
    const retry = new RetryError({
      message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded',
      errors: [apiError(503), apiError(undefined), new Error('no structure at all')],
    })
    expect(classifyAiFailure(retry)).toBe('provider')
  })

  it('a RetryError tries the earlier attempts in order and takes the first that classifies', () => {
    const retry = new RetryError({
      message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded',
      errors: [apiError(401), apiError(503), new Error('no structure at all')],
    })
    expect(classifyAiFailure(retry)).toBe('access')
  })

  it('the final attempt wins over an earlier one when both classify', () => {
    const retry = new RetryError({
      message: 'Failed after 2 attempts', reason: 'maxRetriesExceeded',
      errors: [apiError(503), apiError(undefined, { cause: withCode('ENOTFOUND') })],
    })
    expect(classifyAiFailure(retry)).toBe('network')
  })

  it('a RetryError of unrecognised errors is undefined', () => {
    const retry = new RetryError({
      message: 'Failed after 2 attempts', reason: 'maxRetriesExceeded',
      errors: [new Error('first'), apiError(undefined), apiError(undefined, { responseBody: 'rate limit' })],
    })
    expect(classifyAiFailure(retry)).toBeUndefined()
  })

  it('message text alone never classifies a real APICallError or RetryError', () => {
    const noisy = new APICallError({ message: '401 Unauthorized rate limit ECONNREFUSED', url: 'https://api.example.test', requestBodyValues: {} })
    expect(classifyAiFailure(noisy)).toBeUndefined()
    const retry = new RetryError({ message: 'Failed after 3 attempts. Last error: 429 rate limit', reason: 'maxRetriesExceeded', errors: [noisy] })
    expect(classifyAiFailure(retry)).toBeUndefined()
  })
})

describe('classifyAiFailure — system codes', () => {
  it.each(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])('reads %s as timeout', code => {
    expect(classifyAiFailure(withCode(code))).toBe('timeout')
  })

  it.each(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'])('reads %s as network', code => {
    expect(classifyAiFailure(withCode(code))).toBe('network')
  })

  it('reads an unknown code as nothing', () => {
    expect(classifyAiFailure(withCode('EWHATEVER'))).toBeUndefined()
  })

  it('ignores a non-string code', () => {
    expect(classifyAiFailure(Object.assign(new Error('x'), { code: 401 }))).toBeUndefined()
  })

  it('lets a status win over a code on the same error', () => {
    expect(classifyAiFailure(Object.assign(new Error('x'), { statusCode: 401, code: 'ECONNRESET' }))).toBe('access')
  })
})

describe('classifyAiFailure — error type sent inside an open stream', () => {
  it.each([['rate_limit_error', 'limit'], ['rate_limit_exceeded', 'limit'], ['insufficient_quota', 'limit']] as const)('reads %s as %s', (type, kind) => {
    expect(classifyAiFailure({ type })).toBe(kind)
  })

  it.each(['authentication_error', 'permission_error', 'invalid_api_key'])('reads %s as access', type => {
    expect(classifyAiFailure({ type })).toBe('access')
  })

  it.each(['overloaded_error', 'api_error', 'server_error', 'invalid_request_error'])('reads %s as provider', type => {
    expect(classifyAiFailure({ type })).toBe('provider')
  })

  it('finds the type of a payload nested under `error`', () => {
    expect(classifyAiFailure({ error: { type: 'rate_limit_error' } })).toBe('limit')
  })

  it('reads an unknown type as nothing', () => {
    expect(classifyAiFailure({ type: 'something_new' })).toBeUndefined()
  })
})

describe('classifyAiFailure — nested errors', () => {
  it('follows `cause`', () => {
    expect(classifyAiFailure(wrapping('wrapper', withStatus(403)))).toBe('access')
  })

  it('follows `cause` several levels down', () => {
    const inner = withCode('ECONNRESET')
    const mid = wrapping('mid', inner)
    expect(classifyAiFailure(wrapping('outer', mid))).toBe('network')
  })

  it('follows `errors` of an aggregate and takes the first attempt that can be classified', () => {
    const aggregate = Object.assign(new Error('all failed'), { errors: [new Error('unclassifiable'), withCode('ENOTFOUND'), withStatus(500)] })
    expect(classifyAiFailure(aggregate)).toBe('network')
  })

  it('reads the LAST error of a RetryError: what the provider finally said', () => {
    const retry = new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [withStatus(500), withStatus(500), withStatus(429)] })
    expect(classifyAiFailure(retry)).toBe('limit')
  })

  it('stops at a self-referencing cause chain instead of looping', () => {
    const a: Error & { cause?: unknown } = new Error('a')
    const b: Error & { cause?: unknown } = new Error('b')
    a.cause = b
    b.cause = a
    expect(classifyAiFailure(a)).toBeUndefined()
  })

  it('gives up past the depth bound', () => {
    let chain: unknown = withStatus(401)
    for (let i = 0; i < 8; i++) chain = wrapping(`level ${i}`, chain)
    expect(classifyAiFailure(chain)).toBeUndefined()
  })

  it('survives a property getter that throws', () => {
    const hostile = {}
    Object.defineProperty(hostile, 'statusCode', { get() { throw new Error('boom') } })
    expect(classifyAiFailure(hostile)).toBeUndefined()
  })
})

describe('classifyAiFailure — nothing recognised', () => {
  it.each([['null', null], ['undefined', undefined], ['a string', 'ECONNRESET'], ['a number', 429], ['a plain Error', new Error('boom')], ['an empty object', {}]])(
    'is undefined for %s',
    (_name, value) => {
      expect(classifyAiFailure(value)).toBeUndefined()
    },
  )

  it('never reads message text: "401 rate limit" with no structure is undefined', () => {
    expect(classifyAiFailure(new Error('401 rate limit exceeded: ETIMEDOUT, ECONNRESET, authentication_error'))).toBeUndefined()
    expect(classifyAiFailure('HTTP 429 Too Many Requests')).toBeUndefined()
  })

  it('does not let message text override the structure either', () => {
    expect(classifyAiFailure(withStatus(500, '401 Unauthorized, rate limit'))).toBe('provider')
  })
})
