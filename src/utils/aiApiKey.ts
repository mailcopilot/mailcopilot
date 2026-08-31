/**
 * §2.122 — the three AI API-key decisions the Settings AI tab makes.
 *
 * They live here rather than inline in `src/windows/Settings.tsx` for the
 * reason CLAUDE.md §5 gives for that file: it is a hotspot, and logic added
 * "in place" there cannot be reached by a unit test without mounting a
 * 3800-line component. Two of these decisions were wrong in exactly the way an
 * untested one-liner goes wrong:
 *
 *   - the key field was masked by matching the provider's NAME against a
 *     hand-written pair, so a stored Gemini key was never masked at all, and a
 *     provider with no stored key still showed dots. Masking now follows the
 *     fact that a key exists;
 *   - "Reset configuration" invoked `ai:deleteApiKey` with NO argument, which
 *     the main process read as "delete every provider's key" — five keys lost
 *     in one incident. The delete is now addressed.
 *
 * Everything here is presentation/dispatch only. Nothing in this module is
 * treated as proof that the key store holds a key: the field unmasks on focus,
 * so a stale marker can never stop anyone from entering a key.
 */

/**
 * The providers that actually own a stored API key. Since §2.218 that is every
 * provider, but the guard below is still keyed on membership rather than on
 * "any non-empty provider": the caller's value is unvalidated input (it can be
 * `''`, or an id persisted before a provider was removed).
 */
export const API_KEY_PROVIDERS = ['anthropic-api', 'openai-api', 'gemini-api'] as const
export type ApiKeyProviderId = typeof API_KEY_PROVIDERS[number]

/** Main-process record of "we wrote a key for this provider". Read-only for
 *  the renderer: it is absent from `rendererWritableSettingsSchema`. */
export type AiApiKeySavedMap = Partial<Record<ApiKeyProviderId, boolean>>

/**
 * The guard in front of every `ai:deleteApiKey` call. The main process now
 * REQUIRES a provider, so "no provider" and any id that is not in the live set
 * have to be answered here rather than by sending something the zod schema
 * rejects.
 */
export function isApiKeyProvider(value: unknown): value is ApiKeyProviderId {
  return typeof value === 'string' && (API_KEY_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Whether the API-key input starts masked.
 *
 * Keyed on the saved-key marker, NOT on the provider's name: the name-based
 * form is what left Gemini unmasked. A non-boolean marker counts as "no key"
 * (strict `=== true`) so a malformed settings blob cannot fake a stored key.
 */
export function isAiKeyFieldMasked(provider: unknown, saved: AiApiKeySavedMap | undefined): boolean {
  return isApiKeyProvider(provider) && saved?.[provider] === true
}

/** Narrowed shape of `window.api.invoke` for the one channel used below. The
 *  global type carries the full channel union; widening it here would let any
 *  channel through. */
export type DeleteApiKeyInvoke = (
  channel: 'ai:deleteApiKey',
  provider: ApiKeyProviderId,
) => Promise<unknown>

/**
 * Delete the stored key of the provider being reset — and only that one.
 *
 * The provider is passed explicitly (a bare call meant "delete all three"), and
 * nothing is deleted for "no provider" or for an id outside the live set, which
 * have no key to lose. Rejections propagate: the caller reports the failure
 * instead of resetting the UI as if the key were gone.
 */
export async function deleteAiApiKeyForProvider(
  invoke: DeleteApiKeyInvoke,
  provider: unknown,
): Promise<void> {
  if (!isApiKeyProvider(provider)) return
  await invoke('ai:deleteApiKey', provider)
}
