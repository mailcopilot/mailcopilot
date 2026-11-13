/**
 * §2.283 — per-provider request normalisation.
 *
 * Both Anthropic rules here are guards against a HARD 400 that only shows up on
 * a live key, which is why they are pinned with unit tests rather than left to
 * the integration matrix: the mocked suites cannot see a vendor rejecting a
 * request shape, and `.env.integration` is not always present.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

// `ANTHROPIC_TOOL_NAME_RE` is asserted in `ai.test.ts` instead: the guard needs
// the real `ALLOWED_TOOLS`, and importing `ai.ts` here would pull in
// `packages/db` and its native module.
const {
  PROVIDER_MESSAGE_QUIRKS,
  normalizeMessagesForProvider,
  openAiReasoningRule,
  chatRequestParams,
  oneShotOpenAiParams,
  isResponsesOnlyOpenAiModel,
} = await import('./aiProviderTransform')

type Msg = { role: 'user' | 'assistant'; content: string }

describe('electron/services/aiProviderTransform', () => {
  describe('empty history messages (Anthropic rejects empty content)', () => {
    // REACHABLE, not hypothetical: `aiSession:addMessage` validates content as
    // `z.string()` with no `.min(1)`, so an empty assistant row can be written
    // into a session and would otherwise 400 every later Claude turn in it —
    // permanently, with nothing in the UI explaining why.
    it('drops an empty assistant message', () => {
      const messages: Msg[] = [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'second question' },
      ]

      expect(normalizeMessagesForProvider('anthropic-api', messages)).toEqual([
        { role: 'user', content: 'first question' },
        { role: 'user', content: 'second question' },
      ])
    })

    it('treats whitespace-only content as empty', () => {
      const messages: Msg[] = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '   \n\t ' },
      ]

      expect(normalizeMessagesForProvider('anthropic-api', messages)).toEqual([
        { role: 'user', content: 'q' },
      ])
    })

    it('leaves non-empty messages exactly as they are', () => {
      const messages: Msg[] = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'q2' },
      ]

      expect(normalizeMessagesForProvider('anthropic-api', messages)).toEqual(messages)
    })

    it('does NOT drop empty messages on the OpenAI-compatible contour', () => {
      // Open set of servers behind a user-supplied base URL: we do not know
      // what is on the other end, and quietly dropping messages there would
      // change what self-hosted users send for a rule none of them may have.
      const messages: Msg[] = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '' },
      ]

      expect(normalizeMessagesForProvider('openai-api', messages)).toEqual(messages)
    })
  })

  describe('leading assistant message (Anthropic requires a user turn first)', () => {
    // REACHABLE: `trimHistory` walks the history newest-first and stops on a
    // character budget, so a cut landing mid-pair leaves an assistant message
    // at the front. New surface — the Agent SDK resumed by session id and never
    // replayed messages.
    it('drops a leading assistant message left behind by the history budget', () => {
      const messages: Msg[] = [
        { role: 'assistant', content: 'answer to a question that was trimmed away' },
        { role: 'user', content: 'next question' },
      ]

      expect(normalizeMessagesForProvider('anthropic-api', messages)).toEqual([
        { role: 'user', content: 'next question' },
      ])
    })

    it('drops a whole run of leading assistant messages', () => {
      const messages: Msg[] = [
        { role: 'assistant', content: 'a1' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'q' },
      ]

      expect(normalizeMessagesForProvider('anthropic-api', messages)).toEqual([
        { role: 'user', content: 'q' },
      ])
    })

    it('never invents a user message to satisfy the rule', () => {
      // Synthesising a placeholder would put words in the user's mouth inside a
      // prompt. Dropping is the honest repair.
      const out = normalizeMessagesForProvider('anthropic-api', [
        { role: 'assistant', content: 'orphaned answer' },
      ])
      expect(out).toEqual([])
    })

    it('applies both rules together: empties go first, then the leading run', () => {
      const messages: Msg[] = [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'orphaned answer' },
        { role: 'user', content: 'real question' },
      ]

      // The empty USER message is removed first, which exposes the assistant
      // message as the leader; it goes too. Order of the two rules matters and
      // this pins it.
      expect(normalizeMessagesForProvider('anthropic-api', messages)).toEqual([
        { role: 'user', content: 'real question' },
      ])
    })
  })

  describe('general contract', () => {
    it('never mutates the input array', () => {
      const messages: Msg[] = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '' },
      ]
      const snapshot = JSON.parse(JSON.stringify(messages))

      normalizeMessagesForProvider('anthropic-api', messages)

      expect(messages).toEqual(snapshot)
    })

    it('only ever drops — the output is a subsequence of the input', () => {
      const messages: Msg[] = [
        { role: 'assistant', content: '' },
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ]

      const out = normalizeMessagesForProvider('anthropic-api', messages)
      let cursor = 0
      for (const m of out) {
        cursor = messages.indexOf(m, cursor)
        expect(cursor).toBeGreaterThanOrEqual(0)
        cursor += 1
      }
    })

    it('covers every provider in the union', () => {
      // Exhaustive by type, asserted at runtime too so a provider added with a
      // placeholder entry is at least visible here.
      expect(Object.keys(PROVIDER_MESSAGE_QUIRKS).sort()).toEqual([
        'anthropic-api', 'gemini-api', 'openai-api',
      ])
    })
  })
})

// OpenAI reasoning families, read 2026-11-11 (first-party):
//  GPT-6 (https://developers.openai.com/api/docs/guides/latest-model):
//   - "When reasoning effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`."
//   - "GPT-6 Sol and GPT-6 Luna support function calling in Chat Completions only with `reasoning_effort: "none"`."
//   - "GPT-6 Astra, GPT-6.1 Sol, and GPT-6.1 Terra support Chat Completions, but tool calling requires Responses."
//   - "GPT-6 Astra and GPT-6.1 Sol do not support `none`; use `low` instead." (Terra, Sol and Luna support `none`.)
//  GPT-5 (https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2): temperature, top_p and logprobs
//   are only supported on GPT-5.2 with effort `none`; gpt-5, gpt-5-mini and gpt-5-nano "are also listed as erroring when
//   these fields are included"; GPT-5.1 and GPT-5.2 default to `none`; the migration list is none|minimal|low|medium|
//   high|xhigh, `minimal` being the GPT-5 floor.
//  o-series (https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create):
//   `max_tokens` "is now deprecated in favor of max_completion_tokens, and is not compatible with o-series models".
//  `-pro` models: o3-pro and GPT-5.4 Pro are "available in the Responses API only" (Chat Completions "Not supported").
describe('OpenAI reasoning-family request rules', () => {
  it.each([
    ['gpt-6-luna', 'none', true], ['gpt-6-sol', 'none', true], ['gpt-6.1-terra', 'none', false],
    ['gpt-6-astra', 'low', false], ['gpt-6.1-sol', 'low', false],
    ['gpt-5', 'minimal', true], ['gpt-5-mini', 'minimal', true], ['gpt-5-nano', 'minimal', true],
    ['gpt-5.1', 'none', true], ['gpt-5.2', 'none', true],
    ['gpt-5.4', undefined, true], ['gpt-5.6-terra', undefined, true], ['o3', undefined, true], ['o4-mini', undefined, true],
    ['openai/gpt-6-luna', 'none', true], ['gpt-6-luna-2026-11-01', 'none', true], ['gpt-5-mini-2025-08-07', 'minimal', true],
  ])('knows %s: lowest effort %s, Chat Completions tools %s', (id, effort, tools) => {
    expect(openAiReasoningRule(id)).toEqual({ lowestEffort: effort, chatCompletionsTools: tools })
  })

  it.each(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5-chat-latest', 'gpt-5.2-chat-latest', 'claude-sonnet-5-5', 'llama3', 'gpt-6-luna-x1', ''])(
    'has no rule for %s', id => {
      expect(openAiReasoningRule(id)).toBeUndefined()
    })

  it('chat (tools are sent): a reasoning family never gets temperature, and gets its lowest documented effort', () => {
    expect(chatRequestParams('openai-api', 'gpt-6-luna')).toEqual({ providerOptions: { openaiCompatible: { reasoningEffort: 'none' } } })
    expect(chatRequestParams('openai-api', 'gpt-6-astra')).toEqual({ providerOptions: { openaiCompatible: { reasoningEffort: 'low' } } })
    expect(chatRequestParams('openai-api', 'gpt-5-mini')).toEqual({ providerOptions: { openaiCompatible: { reasoningEffort: 'minimal' } } })
    expect(chatRequestParams('openai-api', 'gpt-5.2')).toEqual({ providerOptions: { openaiCompatible: { reasoningEffort: 'none' } } })
    // No documented floor (o-series, newer GPT-5.x): the effort is left to the provider default, temperature still goes.
    expect(chatRequestParams('openai-api', 'o3')).toEqual({})
    expect(chatRequestParams('openai-api', 'gpt-5.4')).toEqual({})
  })

  it('everything else keeps temperature 0.2 and sends no provider options', () => {
    expect(chatRequestParams('openai-api', 'gpt-4o-mini')).toEqual({ temperature: 0.2 })
    expect(chatRequestParams('gemini-api', 'gemini-3.8-flash')).toEqual({ temperature: 0.2 })
  })

  // Anthropic's model reference: Sonnet 5.5 and Haiku 5.5 answer 400 to a non-default temperature/top_p/top_k, the
  // Opus 5.x, Sonnet 5 and Fable 5.x models have the parameters removed, and API version 2026-10-21 rejects them on
  // every model. Leaving them out is accepted everywhere, so the Claude chat sends no sampling parameters at all.
  it.each([
    'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-2',
    'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-8', '',
  ])('anthropic-api chat sends no sampling parameters for %s', model => {
    expect(chatRequestParams('anthropic-api', model)).toEqual({})
  })

  it('the OpenAI reasoning rule is for OpenAI ids only: another provider naming a model alike is untouched', () => {
    expect(chatRequestParams('anthropic-api', 'gpt-5-mini')).toEqual({})
    expect(chatRequestParams('gemini-api', 'gpt-5-mini')).toEqual({ temperature: 0.2 })
  })

  it.each([
    ['o3-pro', true], ['o1-pro-2025-03-19', true], ['openai/o3-pro', true], ['gpt-5.4-pro', true], ['gpt-5-pro', true],
    ['gpt-6-luna-pro', true], ['gpt-6-astra', true], ['gpt-6.1-sol', true], ['gpt-6.1-terra', true],
    ['gpt-6-luna', false], ['gpt-6-sol', false], ['o3', false], ['gpt-5-mini', false], ['gpt-4o', false], ['o3-mini', false],
    ['gpt-5.2-chat-latest', false],
  ])('%s needs the Responses API: %s', (id, expected) => {
    expect(isResponsesOnlyOpenAiModel(id)).toBe(expected)
  })

  it('one-shot bodies: reasoning families get max_completion_tokens, no temperature, and the lowest documented effort', () => {
    expect(oneShotOpenAiParams('gpt-6-luna', 900)).toEqual({ max_completion_tokens: 900, reasoning_effort: 'none' })
    expect(oneShotOpenAiParams('gpt-6-astra', 900)).toEqual({ max_completion_tokens: 900, reasoning_effort: 'low' })
    expect(oneShotOpenAiParams('gpt-5-mini', 900)).toEqual({ max_completion_tokens: 900, reasoning_effort: 'minimal' })
    expect(oneShotOpenAiParams('o3', 900)).toEqual({ max_completion_tokens: 900 })
    expect(oneShotOpenAiParams('gpt-4o-mini', 900)).toEqual({ max_tokens: 900, temperature: 0.2 })
  })
})
