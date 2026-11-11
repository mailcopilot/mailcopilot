/**
 * Provider model ids shared by main and renderer.
 *
 * ONE copy: the main process resolves an empty `aiModel` to these ids, and the
 * Settings provider switch pre-fills the same values. A second literal in
 * either place is how the Gemini default stayed on a model the provider had
 * already shut down.
 *
 * The ids come from each provider's first-party model page (read 2026-11-11):
 * Anthropic "Models overview", Gemini "Models" (new projects: "3.8 Flash"),
 * OpenAI "Models" (small, cost-efficient text model). They are product data:
 * bump them when the provider's page names a newer general-purpose model, and
 * never rewrite a model the user saved.
 */
export const DEFAULT_AI_MODELS = {
  'anthropic-api': 'claude-sonnet-5-5',
  'openai-api': 'gpt-6-luna',
  'gemini-api': 'gemini-3.8-flash',
} as const

/**
 * The model the Anthropic one-shot surfaces (quick actions, summaries, translation, rules) run on: a fixed small
 * model, independent of the chat model the user picks. Current Haiku per Anthropic "Models overview"
 * (https://platform.claude.com/docs/en/about-claude/models/overview, read 2026-11-11; priced in `CLAUDE_PRICES`).
 * A model id written into code goes stale: re-read that page when bumping the defaults above.
 */
export const ANTHROPIC_ONE_SHOT_MODEL = 'claude-haiku-5-5'

export type AiModelProvider = keyof typeof DEFAULT_AI_MODELS

/** One entry of the model picker. `label` is what the user reads, `id` what is sent. */
export interface AiModelOption {
  id: string
  label: string
}

/**
 * Why a model list could not be loaded. Closed set: the renderer maps each to
 * one translated sentence, and no provider text travels with it.
 */
export type AiModelListFailure =
  | 'no_key'
  | 'invalid_key'
  | 'store_unavailable'
  | 'destination_not_approved'
  | 'network'
  | 'timeout'
  | 'provider'

export type AiModelListResult =
  | { ok: true; models: AiModelOption[] }
  | { ok: false; reason: AiModelListFailure }
