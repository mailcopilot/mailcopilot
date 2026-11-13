/**
 * Per-provider request normalisation for the shared streaming path (§2.283).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS A TABLE RATHER THAN AN `if`.
 *
 * Putting every tool-calling provider on one `streamText` loop removes the
 * second agentic implementation; it does NOT make the providers identical.
 * Underneath the shared loop each adapter still speaks its vendor's wire
 * format, and each vendor rejects a slightly different set of otherwise
 * reasonable requests. Those differences have to live somewhere, and the
 * somewhere must not be a chain of `if (provider === …)` inside the streamer:
 * §2.287 will bring Gemini onto this same path with a considerably longer list
 * (JSON-schema rewriting — integer enums to strings, multi-type arrays to
 * `anyOf`, a single `type` instead of an array), and a second provider must not
 * add a second branch to a hotspot. One table, one place where the divergences
 * are visible as a list.
 *
 * Prior art: opencode (open-source agent on the same Vercel AI SDK layer) keeps
 * exactly this — a single `provider/transform.ts` collecting the quirks of 30+
 * providers. We are adopting the shape, not the contents.
 *
 * SCOPE. This module only reshapes what we are about to SEND. It never
 * inspects, filters or rewrites model OUTPUT, and it is not a security
 * boundary: the whitelist (`filterToWhitelist`), the egress gate and
 * `wrapUntrusted()` all sit elsewhere and do not depend on anything here.
 */

import type { AiProvider } from './ai'
import { createLogger } from '../logger'

const log = createLogger('AI-ProviderTransform')

/** One multi-turn chat message as the shared streamer assembles it. */
export type ChatMessage = { role: 'user' | 'assistant'; content: string }

/**
 * The message-shape rules a provider enforces on the way in.
 *
 * Every field is a REJECTION the vendor performs, not a preference of ours —
 * add one only with a failure it prevents, so this does not silently become a
 * dumping ground for style.
 */
export type ProviderMessageQuirks = {
  /**
   * The vendor rejects a message whose content is empty.
   *
   * REACHABLE HERE, and not hypothetically. History comes from `ai_messages`,
   * and `aiSession:addMessage` validates content as `z.string()` with no
   * `.min(1)` — so an empty assistant row can be written by the renderer (an
   * interrupted turn, a turn that only called tools, or simply a bug) and then
   * sits in that session forever. Without this filter the FIRST such row turns
   * every later Claude turn in that conversation into a hard 400: the session
   * becomes permanently unusable and the user has no way to see why.
   */
  dropEmptyContent: boolean
  /**
   * The vendor requires the conversation to open with a `user` message.
   *
   * REACHABLE HERE for the same structural reason: `trimHistory` walks the
   * history newest-first and stops on a character budget, so a cut that lands
   * mid-pair leaves an assistant message at the front. The Agent SDK never
   * exposed this because it resumed a conversation by id instead of replaying
   * messages — this is new surface that arrived with the unified path, which is
   * exactly why it is written down rather than discovered on a live key.
   */
  requireLeadingUserMessage: boolean
}

/**
 * What each provider needs. Keyed by `AiProvider`, so adding a provider to the
 * union without deciding its quirks does not compile.
 *
 * Anthropic's two entries are sourced from its Messages API behaviour (empty
 * `text` blocks and a non-`user` first message are both `invalid_request_error`)
 * and match what opencode normalises for the same adapter.
 *
 * `openai-api` is deliberately all-false: it is an OPEN set of servers behind a
 * user-supplied base URL, so we do not know what is on the other end, and
 * quietly dropping messages there would change what self-hosted users send for
 * a rule none of them may have. Do not "harmonise" this to true.
 */
export const PROVIDER_MESSAGE_QUIRKS: Record<AiProvider, ProviderMessageQuirks> = {
  'anthropic-api': { dropEmptyContent: true, requireLeadingUserMessage: true },
  'openai-api': { dropEmptyContent: false, requireLeadingUserMessage: false },
  // Gemini does not reach the shared streamer yet (§2.287). Listed so the
  // record stays exhaustive; revisit both flags when it does.
  'gemini-api': { dropEmptyContent: false, requireLeadingUserMessage: false },
}

/**
 * Anthropic's tool-name grammar (`^[a-zA-Z0-9_-]{1,128}$`).
 *
 * Exported for the guard test rather than applied at runtime, and that is the
 * point: nothing sanitises tool names here because nothing needs to.
 * `filterToWhitelist` in `ai.ts` is a fail-closed allow list, so the only names
 * that can reach a provider are the ones written in `ALLOWED_TOOLS`, and the
 * test asserts every one of them already satisfies this. A runtime sanitiser
 * would be code that can never fire, hiding a whitelist mistake by rewriting it
 * instead of failing.
 */
export const ANTHROPIC_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/

/**
 * Reshape the outgoing messages for `provider`.
 *
 * Returns a NEW array; the input is never mutated. Dropping is the only
 * operation — no message is reworded, merged or reordered, so what the model
 * sees is always a subsequence of what we assembled.
 *
 * The current user prompt is the last element and is never empty (it is built
 * by `buildPrompt`), so no rule here can empty the array and leave the request
 * with nothing to answer.
 */
export function normalizeMessagesForProvider(
  provider: AiProvider,
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const quirks = PROVIDER_MESSAGE_QUIRKS[provider]
  // An unknown provider gets the input unchanged rather than a guess: silently
  // reshaping a request for a vendor whose rules we have not written down is
  // how a transform layer starts causing the failures it exists to prevent.
  if (!quirks) return [...messages]

  let out = [...messages]

  if (quirks.dropEmptyContent) {
    const before = out.length
    out = out.filter((m) => m.content.trim().length > 0)
    if (out.length !== before) {
      // Count only. The content is user mail and model output; the fact that a
      // row was empty is the whole diagnostic, and it carries no PII.
      log.info(`dropped ${before - out.length} empty history message(s) for ${provider}`)
    }
  }

  if (quirks.requireLeadingUserMessage) {
    // Drop from the FRONT until a user message leads. Dropping the leading
    // assistant turn is the honest repair: the user turn it answered was
    // already cut by the history budget, so keeping it would hand the model an
    // answer with no question. The alternative — synthesising a placeholder
    // user message — would put words in the user's mouth inside a prompt.
    let firstUser = out.findIndex((m) => m.role === 'user')
    if (firstUser === -1) firstUser = out.length
    if (firstUser > 0) {
      log.info(`dropped ${firstUser} leading assistant message(s) for ${provider}`)
      out = out.slice(firstUser)
    }
  }

  return out
}

// --- OpenAI reasoning families (o-series, GPT-5, GPT-6) -------------------------------------------------------
//
// A request that is fine for gpt-4o is refused by a reasoning model, and the refusal only shows on a live key. The rule is
// per FAMILY, found by model id, and every row below is a first-party statement (read 2026-11-11):
//
//  GPT-6 (https://developers.openai.com/api/docs/guides/latest-model, .../models/gpt-6-luna):
//   - "When reasoning effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`."
//   - "GPT-6 Sol and GPT-6 Luna support function calling in Chat Completions only with `reasoning_effort: "none"`."
//   - "GPT-6 Astra, GPT-6.1 Sol, and GPT-6.1 Terra support Chat Completions, but tool calling requires Responses."
//   - "GPT-6 Astra and GPT-6.1 Sol do not support `none`; use `low` instead." (Terra, Sol and Luna support `none`.)
//  GPT-5 (https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2): `temperature`, `top_p` and `logprobs`
//   are only supported on GPT-5.2 with effort `none`, and gpt-5, gpt-5-mini and gpt-5-nano are "also listed as erroring when
//   these fields are included"; GPT-5.1 and GPT-5.2 default to `none`; the migration list of values is
//   none|minimal|low|medium|high|xhigh, `minimal` being the floor of the original GPT-5 models (they have no `none`).
//  o-series (https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create):
//   `max_tokens` "is now deprecated in favor of max_completion_tokens, and is not compatible with o-series models".
//   The documentation names no per-model effort values for the o-series or for GPT-5.4 and later, so no effort is sent
//   for them (the provider default is accepted everywhere); temperature is still withheld, since leaving a parameter out
//   is always accepted and the same pages say parameter support differs "particularly for newer reasoning models".
//  `-pro` models: o3-pro and GPT-5.4 Pro are "available in the Responses API only" (endpoints table: Chat Completions
//   "Not supported"; .../models/o3-pro, .../models/gpt-5.4-pro).
//
// What a reasoning family gets: NO temperature, `max_completion_tokens` instead of `max_tokens`, and the lowest effort
// documented for it (`none` where supported, else `minimal`/`low`) — the app asks for answers and tool calls, not for
// deliberation, and `none` is also the only effort at which GPT-6 Luna/Sol accept tools in Chat Completions.
//
// The rule is keyed by model id, not by base URL: the same id behind a gateway (`openai/gpt-6-luna`) speaks the same
// parameters. A model with no row (gpt-4o and older, `-chat-latest`, other vendors, self-hosted servers) is sent exactly
// what it was sent before: this table lists what is KNOWN to fail, it does not guess for the rest.

export type OpenAiReasoningRule = {
  /** The lowest effort documented for the family; undefined when the documentation names none (send nothing). */
  lowestEffort: 'none' | 'minimal' | 'low' | undefined
  /** Function calling works over Chat Completions (with the effort above); otherwise it needs the Responses API. */
  chatCompletionsTools: boolean
}

const GPT6_RULES: Readonly<Record<string, OpenAiReasoningRule>> = {
  'gpt-6-luna': { lowestEffort: 'none', chatCompletionsTools: true },
  'gpt-6-sol': { lowestEffort: 'none', chatCompletionsTools: true },
  'gpt-6.1-terra': { lowestEffort: 'none', chatCompletionsTools: false },
  'gpt-6-astra': { lowestEffort: 'low', chatCompletionsTools: false },
  'gpt-6.1-sol': { lowestEffort: 'low', chatCompletionsTools: false },
}

/** Lower-cased id without an `openai/` gateway prefix and a `-YYYY-MM-DD` snapshot suffix. */
function baseOpenAiId(model: string): string {
  return model.trim().toLowerCase().replace(/^openai\//, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
}

const GPT5_ORIGINAL = /^gpt-5(?:-mini|-nano)?$/
const GPT5_NONE_DEFAULT = /^gpt-5\.[12]$/
// GPT-5.3 and later, with variants (`-terra`, `-luna`, ...); `-chat-latest` is a non-reasoning chat alias.
const GPT5_LATER = /^gpt-5\.\d+(?:-(?!chat)[a-z]+)*$/
const O_SERIES = /^o\d+(?:-mini)?$/

/** The documented rule of an OpenAI reasoning-family model id, or undefined for any other model. */
export function openAiReasoningRule(model: string): OpenAiReasoningRule | undefined {
  const id = baseOpenAiId(model)
  const gpt6 = /^gpt-6(?:\.\d+)?-[a-z]+$/.test(id) ? GPT6_RULES[id] : undefined
  if (gpt6) return gpt6
  if (GPT5_ORIGINAL.test(id)) return { lowestEffort: 'minimal', chatCompletionsTools: true }
  if (GPT5_NONE_DEFAULT.test(id)) return { lowestEffort: 'none', chatCompletionsTools: true }
  if (GPT5_LATER.test(id) || O_SERIES.test(id)) return { lowestEffort: undefined, chatCompletionsTools: true }
  return undefined
}

/**
 * True for a model this app cannot drive: its contour speaks Chat Completions with tools, and the model needs the
 * Responses API: any `-pro` model (o3-pro and GPT-5.4 Pro are documented Responses-only; the suffix is the rule), or a
 * GPT-6 model whose tool calling requires Responses.
 */
export function isResponsesOnlyOpenAiModel(model: string): boolean {
  if (/-pro$/.test(baseOpenAiId(model))) return true
  const rule = openAiReasoningRule(model)
  return rule !== undefined && !rule.chatCompletionsTools
}

export type ChatRequestParams = {
  temperature?: number
  providerOptions?: { openaiCompatible: { reasoningEffort: 'none' | 'minimal' | 'low' } }
}

const DEFAULT_TEMPERATURE = 0.2

/**
 * Sampling and reasoning parameters of an interactive chat turn (which always sends tools).
 * Claude: nothing. Reasoning family: no temperature, plus the lowest documented effort where there is one.
 * Everything else: temperature 0.2, as before. (`max_tokens` is not set on this path.)
 */
export function chatRequestParams(provider: AiProvider, model: string): ChatRequestParams {
  // Claude: no sampling parameters on any model. Sonnet 5.5 and Haiku 5.5 answer 400 to a non-default
  // temperature/top_p/top_k, newer models have them removed, API version 2026-10-21 rejects them everywhere, and
  // omitting them is accepted by every Claude model. (@ai-sdk/anthropic drops temperature only when thinking is on.)
  if (provider === 'anthropic-api') return {}
  const rule = provider === 'openai-api' ? openAiReasoningRule(model) : undefined
  if (!rule) return { temperature: DEFAULT_TEMPERATURE }
  return rule.lowestEffort ? { providerOptions: { openaiCompatible: { reasoningEffort: rule.lowestEffort } } } : {}
}

/**
 * The same decision for a one-shot Chat Completions body (translation, summaries, rules), as raw JSON fields.
 * `max_tokens` is "deprecated in favor of `max_completion_tokens`, and is not compatible with o-series models"
 * (chat completions reference), so a reasoning family gets the limit under its newer name.
 */
export function oneShotOpenAiParams(
  model: string,
  maxOutputTokens: number,
):
  | { max_tokens: number; temperature: number }
  | { max_completion_tokens: number; reasoning_effort?: 'none' | 'minimal' | 'low' } {
  const rule = openAiReasoningRule(model)
  if (!rule) return { max_tokens: maxOutputTokens, temperature: DEFAULT_TEMPERATURE }
  return rule.lowestEffort
    ? { max_completion_tokens: maxOutputTokens, reasoning_effort: rule.lowestEffort }
    : { max_completion_tokens: maxOutputTokens }
}
