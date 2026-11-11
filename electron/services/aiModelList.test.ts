import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
import { oneShotOpenAiParams, openAiReasoningRule } from './aiProviderTransform'
import {
  fetchAiModelList,
  parseAnthropicModels,
  parseCompatibleModels,
  parseGeminiModels,
  parseOpenAiModels,
} from './aiModelList'

// Response shapes are the ones the providers document (read 2026-11-11):
// Anthropic /v1/models, Gemini models.list, OpenAI /v1/models.

const ANTHROPIC_PAGE = {
  data: [
    { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', lifecycle: 'active', created_at: '2026-09-21T00:00:00Z' },
    { type: 'model', id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', lifecycle: 'deprecated', deprecated_at: '2026-10-01T00:00:00Z' },
    { type: 'model', id: 'claude-3-haiku-20240307', display_name: 'Claude Haiku 3', lifecycle: 'retired' },
    { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
  ],
  first_id: 'claude-opus-5-5',
  has_more: false,
  last_id: 'claude-sonnet-5-5',
}

const GEMINI_PAGE = {
  models: [
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', displayName: 'Gemini Embedding', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-live', displayName: 'Gemini 3.8 Live', supportedGenerationMethods: ['bidiGenerateContent'] },
    { name: 'models/aqa', displayName: 'Model that performs Attributed Question Answering', supportedGenerationMethods: ['generateAnswer'] },
  ],
}

const OPENAI_PAGE = {
  object: 'list',
  data: [
    { id: 'gpt-6-luna', object: 'model', created: 1790000000, owned_by: 'openai' },
    { id: 'gpt-6-astra', object: 'model', created: 1795000000, owned_by: 'openai' },
    { id: 'gpt-4o-mini', object: 'model', created: 1721172741, owned_by: 'system', shutdown_date: '2026-01-01' },
    { id: 'o3', object: 'model', created: 1744000000, owned_by: 'system' },
    { id: 'text-embedding-3-large', object: 'model', created: 1705953180, owned_by: 'system' },
    { id: 'whisper-1', object: 'model', created: 1677532384, owned_by: 'openai-internal' },
    { id: 'dall-e-3', object: 'model', created: 1698785189, owned_by: 'system' },
    { id: 'gpt-image-2.6-sunburst', object: 'model', created: 1790000001, owned_by: 'system' },
    { id: 'gpt-realtime-2.1', object: 'model', created: 1790000002, owned_by: 'system' },
    { id: 'gpt-4o-mini-tts', object: 'model', created: 1742000000, owned_by: 'system' },
    { id: 'gpt-4o-transcribe', object: 'model', created: 1742000001, owned_by: 'system' },
    { id: 'gpt-3.5-turbo-instruct', object: 'model', created: 1694122472, owned_by: 'system' },
    { id: 'omni-moderation-latest', object: 'model', created: 1731689265, owned_by: 'system' },
  ],
}

const NOW = Date.parse('2026-11-11T00:00:00Z')

describe('parseAnthropicModels', () => {
  it('keeps active models, drops deprecated and retired, reads a missing lifecycle as active', () => {
    expect(parseAnthropicModels(ANTHROPIC_PAGE).models.map(m => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
  })

  it('labels with display_name and falls back to the id', () => {
    const { models } = parseAnthropicModels({ data: [{ id: 'claude-x', lifecycle: 'active' }, { id: 'claude-y', display_name: 'Y' }] })
    expect(models).toEqual([{ id: 'claude-x', label: 'claude-x' }, { id: 'claude-y', label: 'Y' }])
  })

  it('hands back the cursor only while has_more is true', () => {
    expect(parseAnthropicModels({ data: [], has_more: true, last_id: 'abc' }).nextAfterId).toBe('abc')
    expect(parseAnthropicModels({ data: [], has_more: false, last_id: 'abc' }).nextAfterId).toBeUndefined()
  })

  it.each([null, 'x', 42, [], {}, { data: 'no' }, { data: [null, 1, {}] }])('survives malformed body %j', body => {
    expect(parseAnthropicModels(body).models).toEqual([])
  })
})

describe('parseGeminiModels', () => {
  it('keeps generateContent models, strips models/, drops embedding, answer, speech, image and live products', () => {
    expect(parseGeminiModels(GEMINI_PAGE).models).toEqual([
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
    ])
  })

  it('does not drop a chat model whose name merely contains a product word', () => {
    const body = { models: [{ name: 'models/gemini-3-flash-preview', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-liveliness', supportedGenerationMethods: ['generateContent'] }] }
    expect(parseGeminiModels(body).models.map(m => m.id)).toEqual(['gemini-3-flash-preview', 'gemini-liveliness'])
  })

  it('reads nextPageToken', () => {
    expect(parseGeminiModels({ models: [], nextPageToken: 'tok' }).nextPageToken).toBe('tok')
    expect(parseGeminiModels({ models: [] }).nextPageToken).toBeUndefined()
  })
})

describe('parseOpenAiModels', () => {
  it('keeps chat models newest first and drops other products and shut-down models', () => {
    expect(parseOpenAiModels(OPENAI_PAGE, NOW).map(m => m.id)).toEqual(['gpt-6-luna', 'o3'])
  })

  it('keeps a model whose shutdown_date is still ahead', () => {
    const body = { data: [{ id: 'gpt-4o-mini', created: 1, shutdown_date: '2027-01-01' }, { id: 'gpt-4o', created: 2, shutdown_date: null }] }
    expect(parseOpenAiModels(body, NOW).map(m => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })
})

describe('parseOpenAiModels: models this app cannot call', () => {
  // Our contour speaks Chat Completions with tools. `-pro` models are Responses-only: o3-pro "is available in the
  // Responses API only" and GPT-5.4 Pro likewise, both with Chat Completions "Not supported" in the endpoints table
  // (https://developers.openai.com/api/docs/models/o3-pro, .../gpt-5.4-pro); GPT-6 Astra, GPT-6.1 Sol and GPT-6.1
  // Terra "support Chat Completions, but tool calling requires Responses"
  // (https://developers.openai.com/api/docs/guides/latest-model).
  it.each([
    'o3-pro', 'o1-pro', 'o3-pro-2025-06-10', 'gpt-5.4-pro', 'gpt-5-pro', 'gpt-5.4-pro-2026-03-05', 'gpt-6-luna-pro',
    'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra',
  ])('does not offer %s', id => {
    const body = { data: [{ id, created: 5 }, { id: 'gpt-6-luna', created: 4 }] }
    expect(parseOpenAiModels(body, NOW).map(m => m.id)).toEqual(['gpt-6-luna'])
  })

  // Being listed is not compatibility: every offered model must also have the request the provider accepts. The
  // reasoning families therefore must resolve to a rule (no temperature, max_completion_tokens), and a plain chat model
  // keeps temperature and max_tokens.
  it.each([
    ['gpt-6-luna', true], ['gpt-6-sol', true], ['gpt-5', true], ['gpt-5-mini', true], ['gpt-5-nano', true],
    ['gpt-5.1', true], ['gpt-5.2', true], ['gpt-5.4', true], ['o3', true], ['o4-mini', true],
    ['gpt-4o', false], ['gpt-4o-mini', false], ['gpt-4.1', false], ['gpt-5-chat-latest', false],
  ])('offers %s and sends it a request of the right shape (reasoning family: %s)', (id, reasoning) => {
    expect(parseOpenAiModels({ data: [{ id, created: 1 }] }, NOW).map(m => m.id)).toEqual([id])
    const body = oneShotOpenAiParams(id, 100) as Record<string, unknown>
    expect(openAiReasoningRule(id) !== undefined).toBe(reasoning)
    expect('temperature' in body).toBe(!reasoning)
    expect('max_tokens' in body).toBe(!reasoning)
    expect('max_completion_tokens' in body).toBe(reasoning)
  })

  it('a custom OpenAI-compatible endpoint is not filtered by this rule', () => {
    expect(parseCompatibleModels({ data: [{ id: 'o3-pro' }, { id: 'gpt-6-astra' }] }).map(m => m.id)).toEqual(['o3-pro', 'gpt-6-astra'])
  })
})

describe('parseCompatibleModels', () => {
  it('returns every id as the server listed it, unfiltered', () => {
    expect(parseCompatibleModels({ data: [{ id: 'whisper-1' }, { id: 'text-embedding-3' }, { id: 'whisper-1' }, {}, { id: 7 }] }).map(m => m.id))
      .toEqual(['whisper-1', 'text-embedding-3'])
  })
})

describe('bounds on a custom endpoint answer', () => {
  it('caps the number of models and drops or trims oversized ids and labels', () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({ id: `m-${i}` }))
    expect(parseCompatibleModels({ data: many })).toHaveLength(2_000)
    const out = parseCompatibleModels({ data: [{ id: 'x'.repeat(300) }, { id: 'ok' }] })
    expect(out.map(m => m.id)).toEqual(['ok'])
    const longLabel = parseAnthropicModels({ data: [{ id: 'a', display_name: 'L'.repeat(400) }] }).models
    expect(longLabel[0].label).toBe('L'.repeat(400)) // the parser keeps it; fetchAiModelList trims below
  })

  it('fetchAiModelList trims a long label and enforces the cap on every provider', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'a', display_name: 'L'.repeat(400), lifecycle: 'active' }] }) }) as Response)
    const res = await fetchAiModelList('anthropic-api', 'k', undefined, { fetch })
    expect((res as { models: Array<{ label: string }> }).models[0].label).toHaveLength(256)
  })
})

describe('fetchAiModelList', () => {
  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response

  it('Anthropic: sends the key and version headers, follows the cursor, lists active models', async () => {
    const calls: Array<[string, RequestInit]> = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init])
      return calls.length === 1
        ? json({ data: [{ id: 'claude-a', lifecycle: 'active' }], has_more: true, last_id: 'claude-a' })
        : json({ data: [{ id: 'claude-b', lifecycle: 'active' }, { id: 'claude-a', lifecycle: 'active' }], has_more: false })
    })
    const result = await fetchAiModelList('anthropic-api', 'sk-ant-1', undefined, { fetch })
    expect(result).toEqual({ ok: true, models: [{ id: 'claude-a', label: 'claude-a' }, { id: 'claude-b', label: 'claude-b' }] })
    expect(calls[1][0]).toContain('after_id=claude-a')
    expect(calls[0][1].headers).toMatchObject({ 'x-api-key': 'sk-ant-1', 'anthropic-version': '2023-06-01' })
  })

  it('Gemini: pages with pageToken', async () => {
    const urls: string[] = []
    const fetch = vi.fn(async (url: string) => {
      urls.push(url)
      return urls.length === 1
        ? json({ models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'T' })
        : json({ models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] })
    })
    const result = await fetchAiModelList('gemini-api', 'AIza-key', undefined, { fetch })
    expect(result).toMatchObject({ ok: true })
    expect((result as { models: unknown[] }).models).toHaveLength(2)
    expect(urls[1]).toContain('pageToken=T')
  })

  it('OpenAI direct filters by chat id; a custom base URL does not', async () => {
    const fetch = vi.fn(async () => json(OPENAI_PAGE))
    const direct = await fetchAiModelList('openai-api', 'sk-1', undefined, { fetch, now: () => NOW })
    expect((direct as { models: Array<{ id: string }> }).models.map(m => m.id)).toEqual(['gpt-6-luna', 'o3'])
    expect(fetch).toHaveBeenLastCalledWith('https://api.openai.com/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer sk-1' } }))

    const custom = await fetchAiModelList('openai-api', 'sk-1', 'https://llm.example.org/v1', { fetch, now: () => NOW })
    expect((custom as { models: unknown[] }).models).toHaveLength(OPENAI_PAGE.data.length)
    expect(fetch).toHaveBeenLastCalledWith('https://llm.example.org/v1/models', expect.anything())
  })

  it.each([
    [401, 'invalid_key'],
    [403, 'invalid_key'],
    [404, 'provider'],
    [500, 'provider'],
  ])('status %i maps to %s', async (status, reason) => {
    const fetch = vi.fn(async () => json({}, status))
    expect(await fetchAiModelList('openai-api', 'k', undefined, { fetch })).toEqual({ ok: false, reason })
  })

  it('maps transport failures and timeouts to closed reasons without any provider text', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED secret-host'), { code: 'ECONNREFUSED' })
    expect(await fetchAiModelList('openai-api', 'k', undefined, { fetch: async () => { throw refused } })).toEqual({ ok: false, reason: 'network' })
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    expect(await fetchAiModelList('gemini-api', 'k', undefined, { fetch: async () => { throw timeout } })).toEqual({ ok: false, reason: 'timeout' })
  })

  it('an unusable base URL fails as provider before any request', async () => {
    const fetch = vi.fn()
    expect(await fetchAiModelList('openai-api', 'k', 'ftp://nope', { fetch })).toEqual({ ok: false, reason: 'provider' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a 200 with a non-JSON body is a provider failure', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x') } }) as unknown as Response)
    expect(await fetchAiModelList('anthropic-api', 'k', undefined, { fetch })).toEqual({ ok: false, reason: 'provider' })
  })
})
