/**
 * The provider's own list of models, for the Settings model picker.
 *
 * Each vendor publishes a list endpoint and clients are expected to read it
 * instead of freezing ids into the app (a frozen list is how the Gemini picker
 * ended up offering Claude models and a shut-down default):
 *
 *   - Anthropic `GET /v1/models`: `lifecycle` is `active | deprecated | retired`
 *     (https://platform.claude.com/docs/en/api/models/list, read 2026-11-11).
 *   - Gemini `GET /v1beta/models`: `supportedGenerationMethods` names what a
 *     model can do, pages of up to 1000 with `nextPageToken`
 *     (https://aistudio.google.com/api-reference/models/list-models, 2026-11-11).
 *   - OpenAI `GET /v1/models`: `id`, `created`, `owned_by`, optional
 *     `shutdown_date`, and NO capability field
 *     (https://developers.openai.com/api/reference/resources/models/methods/list, 2026-11-11).
 *
 * This module only parses and fetches. The key is read by the caller from the
 * secret store; nothing here accepts one from the renderer, and no provider
 * text is returned: a failure is one word from a closed set.
 */
import type { AiModelListFailure, AiModelListResult, AiModelOption } from '@mailcopilot/core'
import { classifyAiFailure } from './aiFailureKind'
import { DEFAULT_OPENAI_BASE_URL, openAiBaseUrlForRequest } from './aiDestination'
import { isResponsesOnlyOpenAiModel } from './aiProviderTransform'

export type ModelListProvider = 'anthropic-api' | 'openai-api' | 'gemini-api'

export interface ModelListDeps {
  /** The AI egress point with the proxy already bound (same path as chat). */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** Overridable for tests. */
  now?: () => number
}

/** One page is up to 1000 models; the cap only stops a server that never ends. */
const MAX_PAGES = 5
const REQUEST_TIMEOUT_MS = 15_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Bounds on what a custom endpoint can make us hold and ship over IPC (it may be a buggy or hostile local server). */
const MAX_MODELS = 2_000
const MAX_TEXT_LENGTH = 256

function dedupe(options: AiModelOption[]): AiModelOption[] {
  const seen = new Set<string>()
  return options
    .filter(o => o.id.length <= MAX_TEXT_LENGTH && (seen.has(o.id) ? false : (seen.add(o.id), true)))
    .slice(0, MAX_MODELS)
    .map(o => (o.label.length > MAX_TEXT_LENGTH ? { ...o, label: o.label.slice(0, MAX_TEXT_LENGTH) } : o))
}

/**
 * Anthropic: keep `active` models. `deprecated` ones stay callable only for
 * organizations that already had access and are closed to new adopters, so
 * offering them to a fresh key would invite a 404; a model the user saved stays
 * selected by the picker anyway. `retired` fail every request. A missing
 * `lifecycle` reads as `active`, the documented default.
 */
export function parseAnthropicModels(body: unknown): { models: AiModelOption[]; nextAfterId?: string } {
  const root = asRecord(body)
  const data = Array.isArray(root?.data) ? root.data : []
  const models: AiModelOption[] = []
  for (const raw of data) {
    const m = asRecord(raw)
    if (!m || typeof m.id !== 'string' || !m.id) continue
    const lifecycle = m.lifecycle === undefined ? 'active' : m.lifecycle
    if (lifecycle !== 'active') continue
    models.push({ id: m.id, label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id })
  }
  const nextAfterId = root?.has_more === true && typeof root.last_id === 'string' && root.last_id ? root.last_id : undefined
  return { models, nextAfterId }
}

/**
 * Ids of Gemini models that produce speech, images or audio streams rather than
 * chat text. They answer `generateContent` too, so the method list cannot tell
 * them apart; the Gemini models page names them as separate products
 * (`*-tts`, `*-image`, `*-live`).
 */
const GEMINI_NON_CHAT_ID = /(?:^|-)(?:tts|image|live|audio|embedding|transcribe)(?:-|$)/

/** Gemini: models that can `generateContent`, minus the non-chat products above. */
export function parseGeminiModels(body: unknown): { models: AiModelOption[]; nextPageToken?: string } {
  const root = asRecord(body)
  const list = Array.isArray(root?.models) ? root.models : []
  const models: AiModelOption[] = []
  for (const raw of list) {
    const m = asRecord(raw)
    if (!m || typeof m.name !== 'string') continue
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : []
    if (!methods.includes('generateContent')) continue
    const id = m.name.replace(/^models\//, '')
    if (!id || GEMINI_NON_CHAT_ID.test(id)) continue
    models.push({ id, label: typeof m.displayName === 'string' && m.displayName ? m.displayName : id })
  }
  const nextPageToken = typeof root?.nextPageToken === 'string' && root.nextPageToken ? root.nextPageToken : undefined
  return { models, nextPageToken }
}

/**
 * OpenAI has no capability field, so chat models are told apart by id: the
 * `gpt-` / `chatgpt-` / `o<digit>` families, minus the ids OpenAI's models page
 * lists as other products (image, realtime, live, transcription, speech,
 * audio, embeddings, moderation, completions-only `instruct`) and minus models that need the Responses API
 * (any `-pro` model such as o3-pro and gpt-5.4-pro; GPT-6 Astra/6.1 Sol/6.1 Terra, whose tools need Responses), which this app cannot call. A model whose
 * `shutdown_date` has passed is gone. Newest first.
 */
const OPENAI_CHAT_ID = /^(?:gpt-|chatgpt-|o\d)/
const OPENAI_NON_CHAT_ID = /(?:^|-)(?:image|realtime|live|transcribe|tts|audio|embedding|moderation|instruct)(?:-|$)/

export function parseOpenAiModels(body: unknown, now: number): AiModelOption[] {
  const root = asRecord(body)
  const data = Array.isArray(root?.data) ? root.data : []
  const rows: Array<{ id: string; created: number }> = []
  for (const raw of data) {
    const m = asRecord(raw)
    if (!m || typeof m.id !== 'string') continue
    if (!OPENAI_CHAT_ID.test(m.id) || OPENAI_NON_CHAT_ID.test(m.id)) continue
    // Models this app's Chat Completions + tools contour cannot drive (see aiProviderTransform).
    if (isResponsesOnlyOpenAiModel(m.id)) continue
    if (typeof m.shutdown_date === 'string') {
      const shutdown = Date.parse(m.shutdown_date)
      if (Number.isFinite(shutdown) && shutdown <= now) continue
    }
    rows.push({ id: m.id, created: typeof m.created === 'number' ? m.created : 0 })
  }
  rows.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
  return dedupe(rows.map(r => ({ id: r.id, label: r.id })))
}

/**
 * A custom OpenAI-compatible endpoint (OpenRouter, LiteLLM, a local server):
 * whatever the server lists, in its order, with no filter. We know nothing
 * about its ids, so any rule would hide models the user can actually use.
 */
export function parseCompatibleModels(body: unknown): AiModelOption[] {
  const root = asRecord(body)
  const data = Array.isArray(root?.data) ? root.data : []
  const out: AiModelOption[] = []
  for (const raw of data) {
    const m = asRecord(raw)
    if (m && typeof m.id === 'string' && m.id) out.push({ id: m.id, label: m.id })
  }
  return dedupe(out)
}

class ListFailure extends Error {
  constructor(readonly reason: AiModelListFailure) { super(reason) }
}

async function getJson(deps: ModelListDeps, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await deps.fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (res.status === 401 || res.status === 403) throw new ListFailure('invalid_key')
  if (!res.ok) throw new ListFailure('provider')
  try {
    return await res.json()
  } catch {
    throw new ListFailure('provider')
  }
}

function failureOf(err: unknown): AiModelListFailure {
  if (err instanceof ListFailure) return err.reason
  const kind = classifyAiFailure(err)
  if (kind === 'network' || kind === 'timeout') return kind
  // An abort from our own timer carries no system code.
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout'
  return 'provider'
}

/**
 * Load the model list of one provider with the stored `key`.
 * `openAiBaseUrl` is the effective OpenAI-compatible endpoint setting (empty =
 * the vendor).
 */
export async function fetchAiModelList(
  provider: ModelListProvider,
  key: string,
  openAiBaseUrl: string | undefined,
  deps: ModelListDeps,
): Promise<AiModelListResult> {
  try {
    if (provider === 'anthropic-api') {
      const models: AiModelOption[] = []
      let afterId: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `https://api.anthropic.com/v1/models?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`
        const parsed = parseAnthropicModels(await getJson(deps, url, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }))
        models.push(...parsed.models)
        afterId = parsed.nextAfterId
        if (!afterId) break
      }
      return { ok: true, models: dedupe(models) }
    }
    if (provider === 'gemini-api') {
      const models: AiModelOption[] = []
      let pageToken: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
        const parsed = parseGeminiModels(await getJson(deps, url, {}))
        models.push(...parsed.models)
        pageToken = parsed.nextPageToken
        if (!pageToken) break
      }
      return { ok: true, models: dedupe(models) }
    }
    const base = openAiBaseUrlForRequest(openAiBaseUrl)
    const body = await getJson(deps, `${base}/v1/models`, { Authorization: `Bearer ${key}` })
    const models = base === DEFAULT_OPENAI_BASE_URL
      ? parseOpenAiModels(body, (deps.now ?? Date.now)())
      : parseCompatibleModels(body)
    return { ok: true, models }
  } catch (err) {
    return { ok: false, reason: failureOf(err) }
  }
}
