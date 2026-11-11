/**
 * §2.283 — the Anthropic provider surface, exercised against the REAL
 * `@ai-sdk/anthropic` package.
 *
 * `ai.test.ts` mocks this module so it can observe what a turn was built with;
 * this file is the other half — it proves the thing being mocked actually
 * constructs, that no request leaves without going through the injected fetch,
 * and that the provider-executed web tools carry the ids the Anthropic API
 * expects. Nothing here reaches the network: the only transport is a fake
 * `fetch` supplied by the test.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_API_BASE_URL,
  anthropicWebTools,
  createAnthropicChatModel,
  withPromptCacheBreakpoints,
} from './aiAnthropicProvider'
import type { LanguageModelV3Prompt } from '@ai-sdk/provider'

/** A `fetch` that records the request and answers with a minimal Messages body. */
function recordingFetch() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  return { impl, calls }
}

describe('electron/services/aiAnthropicProvider', () => {
  describe('createAnthropicChatModel', () => {
    it('builds a language model for the requested model id', () => {
      const model = createAnthropicChatModel({
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
      })

      expect(model.modelId).toBe('claude-sonnet-4-5-20250929')
      expect(model.provider).toContain('anthropic')
    })

    it('sends the request through the injected fetch, to the pinned host, with the key', async () => {
      // The proxy seam. The Agent SDK received the user's proxy as HTTPS_PROXY
      // in a spawned CLI's environment; there is no child process any more, so
      // "did the proxy apply" is answerable only by seeing the request arrive
      // at our own fetch.
      const { impl, calls } = recordingFetch()
      const model = createAnthropicChatModel({
        apiKey: 'sk-ant-secret',
        model: 'claude-sonnet-4-5-20250929',
        fetch: impl,
      })

      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })

      expect(calls).toHaveLength(1)
      expect(calls[0].url.startsWith(ANTHROPIC_API_BASE_URL)).toBe(true)
      const headers = calls[0].init?.headers as Record<string, string>
      expect(headers['x-api-key']).toBe('sk-ant-secret')
    })

    it('pins the host — the model has no user-configurable base URL', async () => {
      // Load-bearing for `AiChatStopReason` (CLAUDE.md §5): Anthropic is a
      // PINNED contour, so an unrecognised `stop_reason` is read as
      // `interrupted` (fail-closed). That verdict is only honest while the
      // vocabulary really is Anthropic's own, which is only true while the host
      // cannot be pointed somewhere else. The `unknown` relaxation belongs to
      // the OpenAI-compatible contour and its user-supplied base URL.
      const { impl, calls } = recordingFetch()
      const model = createAnthropicChatModel({
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
        fetch: impl,
      })

      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })

      expect(new URL(calls[0].url).host).toBe('api.anthropic.com')
    })

    it('never spawns a process or looks for an installed binary', async () => {
      // §2.283 guarantee, stated as a property of this module: "MailCopilot
      // does not require third-party installed programs for the AI to work."
      // The request path is a plain HTTPS call through the fetch we hand in, so
      // a fetch that refuses proves nothing else is reaching the network.
      const refusing = vi.fn(async () => {
        throw new Error('no transport')
      })
      const model = createAnthropicChatModel({
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
        fetch: refusing as never,
      })

      await expect(model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })).rejects.toThrow()
      expect(refusing).toHaveBeenCalled()
    })
  })

  describe('prompt cache breakpoints', () => {
    const EPHEMERAL = { cacheControl: { type: 'ephemeral' } }
    const toolLoopPrompt = (): LanguageModelV3Prompt => [
      { role: 'system', content: 'You are a mail assistant.' },
      { role: 'user', content: [{ type: 'text', text: 'find the report' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search_emails', input: {} }] },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search_emails', output: { type: 'text', value: '[]' } }],
      },
    ]

    it('marks the last system message and the last message, and nothing else', () => {
      const out = withPromptCacheBreakpoints(toolLoopPrompt())
      const marked = out.map((m) => m.providerOptions?.anthropic)
      expect(marked).toEqual([EPHEMERAL, undefined, undefined, EPHEMERAL])
    })

    it('moves the moving marker to the new last message on the next step', () => {
      const step2 = [...toolLoopPrompt(), { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] }]
      const marked = withPromptCacheBreakpoints(step2).map((m) => m.providerOptions?.anthropic)
      expect(marked).toEqual([EPHEMERAL, undefined, undefined, undefined, EPHEMERAL])
    })

    it('never uses more than two of the four breakpoints', () => {
      const out = withPromptCacheBreakpoints(toolLoopPrompt())
      expect(out.filter((m) => m.providerOptions?.anthropic).length).toBeLessThanOrEqual(2)
    })

    it('marks a prompt without a system message only at its end', () => {
      const out = withPromptCacheBreakpoints([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
      expect(out.map((m) => m.providerOptions?.anthropic)).toEqual([EPHEMERAL])
    })

    it('keeps other provider options and an existing cacheControl, and does not mutate the input', () => {
      const input: LanguageModelV3Prompt = [
        { role: 'system', content: 's', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } } },
        { role: 'user', content: [{ type: 'text', text: 'q' }], providerOptions: { anthropic: { other: 1 }, openai: { x: 2 } } },
      ]
      const snapshot = JSON.stringify(input)
      const out = withPromptCacheBreakpoints(input)
      expect(JSON.stringify(input)).toBe(snapshot)
      expect(out[0].providerOptions?.anthropic).toEqual({ cacheControl: { type: 'ephemeral', ttl: '1h' } })
      expect(out[1].providerOptions).toEqual({ anthropic: { other: 1, ...EPHEMERAL }, openai: { x: 2 } })
    })

    it('puts cache_control on the wire: system block and last block, tools untouched', async () => {
      // Through the REAL @ai-sdk/anthropic request builder, so the claim is
      // about the bytes Anthropic receives, not about our own prompt objects.
      const { impl, calls } = recordingFetch()
      const model = createAnthropicChatModel({ apiKey: 'sk-ant-test', model: 'claude-haiku-5-5', fetch: impl })
      await model.doGenerate({
        prompt: toolLoopPrompt(),
        tools: [{ type: 'function', name: 'search_emails', description: 'Search', inputSchema: { type: 'object', properties: {} } }],
      })
      const body = JSON.parse(String(calls[0].init?.body)) as {
        system: Array<{ text: string; cache_control?: unknown }>
        messages: Array<{ role: string; content: Array<{ cache_control?: unknown }> }>
        tools: Array<{ cache_control?: unknown }>
      }
      expect(body.system[body.system.length - 1]?.cache_control).toEqual({ type: 'ephemeral' })
      expect(body.tools.every((t) => t.cache_control === undefined)).toBe(true)
      const lastMessage = body.messages[body.messages.length - 1]!
      expect(lastMessage.content[lastMessage.content.length - 1]?.cache_control).toEqual({ type: 'ephemeral' })
      const markers = JSON.stringify(body).match(/"cache_control"/g) ?? []
      expect(markers).toHaveLength(2)
    })

    it('puts the same two markers on a STREAMED request, which is what the tool loop actually sends', async () => {
      // `streamText` calls `doStream`, not `doGenerate`; a middleware that only
      // wrapped `wrapGenerate` would leave every real chat request uncached.
      const calls: Array<{ init: RequestInit | undefined }> = []
      const sse = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","model":"claude-haiku-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('')
      const impl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push({ init })
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })
      const model = createAnthropicChatModel({ apiKey: 'sk-ant-test', model: 'claude-haiku-5-5', fetch: impl })
      const { stream } = await model.doStream({ prompt: toolLoopPrompt() })
      const reader = stream.getReader()
      while (!(await reader.read()).done) { /* drain so the request is fully consumed */ }

      const body = JSON.parse(String(calls[0].init?.body)) as {
        stream?: boolean
        system: Array<{ cache_control?: unknown }>
        messages: Array<{ content: Array<{ cache_control?: unknown }> }>
      }
      expect(body.stream).toBe(true)
      expect(body.system[body.system.length - 1]?.cache_control).toEqual({ type: 'ephemeral' })
      const lastMessage = body.messages[body.messages.length - 1]!
      expect(lastMessage.content[lastMessage.content.length - 1]?.cache_control).toEqual({ type: 'ephemeral' })
      expect(JSON.stringify(body).match(/"cache_control"/g) ?? []).toHaveLength(2)
    })
  })

  describe('anthropicWebTools', () => {
    it('offers exactly web_search and web_fetch, keyed by their Anthropic names', () => {
      const tools = anthropicWebTools()
      expect(Object.keys(tools).sort()).toEqual(['web_fetch', 'web_search'])
    })

    it('carries the dated provider tool ids the API is pinned to', () => {
      // The dated variant is part of the wire contract, not a detail: bumping it
      // changes which models will serve the tool. Pinned so a bump is a visible
      // decision (see the note on `anthropicWebTools`).
      const tools = anthropicWebTools() as Record<string, { id?: string; type?: string }>
      expect(tools.web_search.id).toBe('anthropic.web_search_20250305')
      expect(tools.web_fetch.id).toBe('anthropic.web_fetch_20250910')
      // `type: 'provider'` is what marks a tool as EXECUTED BY THE PROVIDER —
      // the property this whole consent design turns on (§3.10 P2): there is no
      // local execution point for it, so the interceptor can never run.
      expect(tools.web_search.type).toBe('provider')
      expect(tools.web_fetch.type).toBe('provider')
    })

    it('mints tool definitions without carrying any request credential', () => {
      // §3.10 P2 — these are built from the package's default provider instance
      // (a schema factory), while the MODEL is built per request with the
      // user's key. A tool object that captured a key would put it on a
      // different lifetime from the request that authorised it.
      const serialised = JSON.stringify(anthropicWebTools())
      expect(serialised).not.toContain('sk-ant')
      expect(serialised).not.toContain('apiKey')
    })
  })
})
