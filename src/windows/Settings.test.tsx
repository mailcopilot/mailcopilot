// @vitest-environment jsdom
/**
 * §2.122 — AI key handling in the Settings AI tab.
 *
 * Two decisions used to be made by looking at the provider's NAME instead of at
 * the key itself, and both misled the user:
 *   - the key field was masked for `anthropic-api` / `openai-api` only, so a
 *     stored Gemini key was never masked, and a provider with no stored key
 *     still showed dots;
 *   - "Reset configuration" invoked `ai:deleteApiKey` with NO argument, which
 *     the main process read as "delete every provider's key" (five keys lost in
 *     one incident). The channel now requires a provider, so the argument can
 *     no longer be left to chance.
 *
 * The logic lives in `src/utils/aiApiKey.ts` (extracted out of the Settings
 * hotspot precisely so it can be imported), and this file tests THAT module —
 * no hand-copied mirrors. A mirror would keep passing after the fix was
 * reverted, which is exactly what happened to the first version of this test.
 *
 * The second half mounts the real `Settings.tsx` and drives the two call sites,
 * because "the predicate is right" and "the component uses it" are different
 * claims: an inline re-implementation at the call site would satisfy the first
 * and break the user. Together the two halves fail if either the predicate or
 * its wiring regresses.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import {
  API_KEY_PROVIDERS,
  deleteAiApiKeyForProvider,
  isAiKeyFieldMasked,
  isApiKeyProvider,
  type AiApiKeySavedMap,
} from '../utils/aiApiKey'

// ---------------------------------------------------------------------------
// Part A — the extracted decisions, tested directly.
// ---------------------------------------------------------------------------

describe('§2.122 isApiKeyProvider', () => {
  it('accepts exactly the three key-owning providers', () => {
    for (const provider of API_KEY_PROVIDERS) {
      expect(isApiKeyProvider(provider)).toBe(true)
    }
  })

  it('rejects subscription, empty, and non-string values', () => {
    expect(isApiKeyProvider('subscription')).toBe(false)
    expect(isApiKeyProvider('')).toBe(false)
    expect(isApiKeyProvider(undefined)).toBe(false)
    expect(isApiKeyProvider(null)).toBe(false)
    expect(isApiKeyProvider(42)).toBe(false)
  })
})

describe('§2.122 key field masking follows the key, not the provider name', () => {
  it('masks every provider that has a saved key, Gemini included', () => {
    for (const provider of API_KEY_PROVIDERS) {
      expect(isAiKeyFieldMasked(provider, { [provider]: true })).toBe(true)
    }
  })

  it('does not mask a provider whose key was never saved', () => {
    expect(isAiKeyFieldMasked('anthropic-api', {})).toBe(false)
    expect(isAiKeyFieldMasked('openai-api', undefined)).toBe(false)
    expect(isAiKeyFieldMasked('gemini-api', { 'anthropic-api': true })).toBe(false)
  })

  it('does not mask a provider whose key was deleted', () => {
    expect(isAiKeyFieldMasked('openai-api', { 'openai-api': false })).toBe(false)
  })

  it('treats a non-boolean marker as "no key" rather than as a key', () => {
    const hostile = { 'openai-api': 'yes' } as unknown as AiApiKeySavedMap
    expect(isAiKeyFieldMasked('openai-api', hostile)).toBe(false)
  })

  it('never masks the subscription provider — it has no stored key', () => {
    const saved: AiApiKeySavedMap = { 'anthropic-api': true }
    expect(isAiKeyFieldMasked('subscription', saved)).toBe(false)
    expect(isAiKeyFieldMasked('', saved)).toBe(false)
    expect(isAiKeyFieldMasked(undefined, saved)).toBe(false)
  })
})

describe('§2.122 reset deletes exactly one provider key', () => {
  it('names the provider being reset', async () => {
    for (const provider of API_KEY_PROVIDERS) {
      const invoke = vi.fn().mockResolvedValue(undefined)
      await deleteAiApiKeyForProvider(invoke, provider)
      expect(invoke).toHaveBeenCalledWith('ai:deleteApiKey', provider)
    }
  })

  // REGRESSION GUARD — the argument-less call is what destroyed all three keys.
  it('never invokes the delete channel without a provider', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    await deleteAiApiKeyForProvider(invoke, 'openai-api')
    expect(invoke).not.toHaveBeenCalledWith('ai:deleteApiKey')
    expect(invoke).not.toHaveBeenCalledWith('ai:deleteApiKey', undefined)
  })

  it('does not delete anything for subscription or for no provider', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    await deleteAiApiKeyForProvider(invoke, 'subscription')
    await deleteAiApiKeyForProvider(invoke, '')
    await deleteAiApiKeyForProvider(invoke, undefined)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('propagates a failed delete instead of swallowing it', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('keytar unavailable'))
    await expect(deleteAiApiKeyForProvider(invoke, 'gemini-api')).rejects.toThrow('keytar unavailable')
  })
})

// ---------------------------------------------------------------------------
// Part B — the call sites in the real component.
// ---------------------------------------------------------------------------

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn(), language: 'en' } }),
}))
vi.mock('../i18n', () => ({
  default: { changeLanguage: vi.fn(), language: 'en' },
  SUPPORTED_LANGUAGES: ['en', 'ru', 'fr', 'de', 'es', 'it'],
  DEFAULT_LANGUAGE: 'en',
}))
vi.mock('../sentry', () => ({
  sendFeedback: vi.fn(),
  captureException: vi.fn(),
}))

import Settings from './Settings'

const MASK = '••••••••••••••••'

type SettingsBlob = Record<string, unknown>

let invoke: ReturnType<typeof vi.fn>

function installApi(settings: SettingsBlob): void {
  invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case 'settings:get': return settings
      case 'settings:save': return { ok: true }
      case 'accounts:list': return []
      case 'accounts:getCurrent': return null
      case 'mcpExport:status': return { status: 'stopped' }
      case 'mcp:status': return []
      case 'tls:listPins': return []
      case 'rules:list': return []
      case 'aiRules:list': return []
      case 'templates:list': return []
      case 'ai:memoryRead': return ''
      default: return undefined
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(), off: vi.fn(), initialTheme: 'light', installIdHash: '', sentryEnabled: false },
  })
}

/** Mount Settings, wait for the settings load to land, and open the AI tab. */
async function openAiTab(settings: SettingsBlob): Promise<void> {
  installApi(settings)
  render(<Settings />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
  fireEvent.click(screen.getByTestId('settings-tab-ai'))
  await screen.findByTestId('settings-ai-apikey')
}

describe('§2.122 Settings component — the AI key field is masked by the saved-key marker', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
  })

  // REGRESSION GUARD — the name-based predicate left this field empty.
  it('masks a stored Gemini key', async () => {
    await openAiTab({ theme: 'light', aiProvider: 'gemini-api', aiApiKeySaved: { 'gemini-api': true } })
    expect(screen.getByTestId('settings-ai-apikey')).toHaveValue(MASK)
  })

  it('masks a stored Anthropic key', async () => {
    await openAiTab({ theme: 'light', aiProvider: 'anthropic-api', aiApiKeySaved: { 'anthropic-api': true } })
    expect(screen.getByTestId('settings-ai-apikey')).toHaveValue(MASK)
  })

  // REGRESSION GUARD — the name-based predicate showed dots for a key that was
  // never stored, i.e. it claimed a configured provider that could not answer.
  it('shows an empty field when the provider has no stored key', async () => {
    await openAiTab({ theme: 'light', aiProvider: 'anthropic-api', aiApiKeySaved: {} })
    expect(screen.getByTestId('settings-ai-apikey')).toHaveValue('')
  })

  it('shows an empty field when another provider owns the only stored key', async () => {
    await openAiTab({ theme: 'light', aiProvider: 'openai-api', aiApiKeySaved: { 'gemini-api': true } })
    expect(screen.getByTestId('settings-ai-apikey')).toHaveValue('')
  })
})

describe('§2.122 Settings component — "reset provider" deletes one addressed key', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
  })

  async function clickReset(): Promise<void> {
    const reset = document.querySelector('.ai-reset-link')
    expect(reset).not.toBeNull()
    fireEvent.click(reset as Element)
  }

  // REGRESSION GUARD — a bare `ai:deleteApiKey` was read by main as
  // "delete every provider's key"; five keys were lost that way.
  it('passes the reset provider to ai:deleteApiKey', async () => {
    await openAiTab({ theme: 'light', aiProvider: 'gemini-api', aiApiKeySaved: { 'gemini-api': true } })
    await clickReset()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:deleteApiKey', 'gemini-api'))
    expect(invoke).not.toHaveBeenCalledWith('ai:deleteApiKey')
    expect(invoke).not.toHaveBeenCalledWith('ai:deleteApiKey', undefined)
  })

  it('does not touch the key store when resetting the subscription provider', async () => {
    installApi({ theme: 'light', aiProvider: 'subscription' })
    render(<Settings />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
    fireEvent.click(screen.getByTestId('settings-tab-ai'))
    await waitFor(() => expect(document.querySelector('.ai-reset-link')).not.toBeNull())
    await clickReset()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:save', { aiProvider: undefined }))
    expect(invoke.mock.calls.some(([channel]) => channel === 'ai:deleteApiKey')).toBe(false)
  })

  it('keeps the confirmation gate in front of the delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await openAiTab({ theme: 'light', aiProvider: 'openai-api', aiApiKeySaved: { 'openai-api': true } })
    await clickReset()
    expect(invoke.mock.calls.some(([channel]) => channel === 'ai:deleteApiKey')).toBe(false)
  })
})
