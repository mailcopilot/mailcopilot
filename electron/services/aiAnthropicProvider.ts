/**
 * Anthropic language model + provider-executed tools for the shared Vercel
 * streaming path (§2.283).
 *
 * WHY THIS FILE EXISTS. `electron/services/ai.ts` is a hotspot (CLAUDE.md §5),
 * and the Anthropic contour needs three things that are pure construction:
 * a `LanguageModelV3`, the two server-side web tools, and the pinned host they
 * both talk to. Keeping them here means the provider surface can be read and
 * reviewed on its own, and `ai.ts` only decides WHETHER to ask for them.
 *
 * WHAT REPLACED WHAT. Until §2.283 the Claude provider ran through
 * `@anthropic-ai/claude-agent-sdk` — a proprietary package ("All rights
 * reserved", Anthropic PBC) whose runtime was bundled into `dist-electron` and
 * therefore shipped inside `app.asar`. That blocked free installer signing
 * (SignPath Foundation terms forbid any proprietary component in the project)
 * and it also meant the shipped Claude provider depended on the user having a
 * `claude` CLI installed: the package sat in `devDependencies`, so
 * electron-builder never packed it and the SDK's own CLI fallback could not
 * resolve in a shipped build. `@ai-sdk/anthropic` is Apache-2.0, is the
 * first-party Vercel provider for the `ai` package we already use, and needs
 * no external binary.
 *
 * VERSION LINE. Pinned to the `ai-v6` line (`@ai-sdk/anthropic@^3.0.115`,
 * `@ai-sdk/provider@3.0.15`) to match `ai@6` and `@ai-sdk/openai-compatible@2`.
 * The `latest` tag (4.x) belongs to the `ai@7` line and carries
 * `@ai-sdk/provider@4`; installing it would either fail to typecheck against
 * our provider interface or silently drag a major upgrade of `ai` behind it.
 */

import { anthropic, createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModelV3, LanguageModelV3Middleware, LanguageModelV3Prompt } from '@ai-sdk/provider'
import { wrapLanguageModel } from 'ai'

/**
 * The pinned Anthropic host. Stated here so the pinning is visible next to the
 * model construction: `AiChatStopReason` treats Anthropic as a PINNED contour
 * (unrecognised `stop_reason` ⇒ `interrupted`, fail-closed — CLAUDE.md §5), and
 * that verdict is only honest while the vocabulary really is Anthropic's own.
 * There is deliberately NO user-configurable base URL for this provider; the
 * open-set contour with a user-supplied base URL is `openai-api`, and it is the
 * one that gets the `unknown` relaxation.
 */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com/v1'

/**
 * Mark the two cache breakpoints Anthropic prompt caching needs, and nothing else.
 *
 * Anthropic caches by prefix, in the order tools, system, messages, and only up
 * to a `cache_control` marker (reads cost 0.1x, 5-minute writes 1.25x; at most 4
 * markers per request). Without markers nothing is cached, and every step of the
 * tool loop re-sends and re-bills the whole prefix: the tool definitions and the
 * system prompt are ~20k tokens here, repeated on every step of every question.
 *
 *  1. The LAST system message. The marker caches everything before it, so it
 *     covers the tool definitions and the system prompt in one breakpoint. Both
 *     are identical across steps and across questions, so it is the one read
 *     that survives between conversations.
 *  2. The LAST message of the prompt. Step N+1 of a tool loop sends step N's
 *     whole prompt plus the new assistant and tool turns, so the entry written
 *     at the end of step N is read by step N+1. The marker moves forward on every
 *     call because it is recomputed from the prompt each time.
 *
 * Two of four slots are used, so an explicit marker added by anything else
 * cannot push the request over the limit. A prefix shorter than the model's
 * minimum cacheable size is silently not cached (no error). The 5-minute TTL is
 * the default and is kept: a longer one doubles the write price and only pays
 * off for pauses between questions that this panel does not have.
 *
 * Existing `providerOptions.anthropic` entries are preserved, and a message
 * that already carries its own `cacheControl` is left as it was. Pure: returns
 * a new prompt, never mutates the one it was given.
 */
export function withPromptCacheBreakpoints(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
  if (prompt.length === 0) return prompt
  let lastSystem = -1
  for (let i = 0; i < prompt.length; i++) {
    if (prompt[i]!.role === 'system') lastSystem = i
  }
  const marked = new Set<number>([prompt.length - 1])
  if (lastSystem >= 0) marked.add(lastSystem)
  return prompt.map((message, i) => {
    if (!marked.has(i)) return message
    const existing = message.providerOptions?.anthropic
    if (existing && 'cacheControl' in existing) return message
    return {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        anthropic: { ...existing, cacheControl: { type: 'ephemeral' } },
      },
    } as typeof message
  })
}

const promptCacheMiddleware: LanguageModelV3Middleware = {
  specificationVersion: 'v3',
  transformParams: async ({ params }) => ({ ...params, prompt: withPromptCacheBreakpoints(params.prompt) }),
}

/**
 * Build the Anthropic chat model for one request.
 *
 * `fetch` is the proxy seam. The Agent SDK received the user's proxy as
 * `HTTPS_PROXY` in the environment of the CLI it spawned; with no child process
 * to configure, the proxy is an ordinary custom fetch, exactly as the
 * OpenAI-compatible contour already does it.
 */
export function createAnthropicChatModel(opts: {
  apiKey: string
  model: string
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}): LanguageModelV3 {
  const provider = createAnthropic({
    apiKey: opts.apiKey,
    baseURL: ANTHROPIC_API_BASE_URL,
    fetch: opts.fetch as never,
  })
  // Applied in the model, not in the streamer: it sees the exact prompt of every
  // step of the loop, and the vendor-specific part stays in this file.
  return wrapLanguageModel({ model: provider(opts.model), middleware: promptCacheMiddleware })
}

/**
 * Anthropic's SERVER-EXECUTED web tools.
 *
 * §3.10 P2 — THE IMPORTANT PROPERTY: these do not run here. Anthropic performs
 * the search and the fetch inside its own `/v1/messages` call and hands back
 * results, so there is no local execution point for `interceptInternetTool` to
 * sit on and no way to raise a consent prompt while the call is in flight.
 * Consent is therefore applied by the CALLER, by deciding whether to include
 * this record in the request at all (see `streamAnthropicChat`). Never call
 * this function unconditionally.
 *
 * Tool KEYS are the names Anthropic itself uses (`web_search`, `web_fetch`), so
 * the `tool-call` / `tool-result` events the panel renders, the audit log and
 * the taint bookkeeping all speak one vocabulary rather than three.
 *
 * Dated variants: the 2025 revisions are chosen over the 2026 ones on purpose —
 * they are the generally available versions across the Claude models this app
 * defaults to, whereas the newer dates are only served by the newest models and
 * would turn "search does not work on your model" into a request error. Bump
 * them together with the default model, not on their own.
 */
export function anthropicWebTools(): Record<string, unknown> {
  // The exported default instance is a pure tool-definition factory here: the
  // tools it mints carry only their schema and their provider id, never the
  // request credentials. The MODEL is built separately, per request, with the
  // user's key.
  return {
    web_search: anthropic.tools.webSearch_20250305(),
    web_fetch: anthropic.tools.webFetch_20250910(),
  }
}
