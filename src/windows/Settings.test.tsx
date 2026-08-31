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
 *
 * Part C covers a second screen of the same window (§2.202, the rules list) on
 * the same principle: real component, real branch, no mirror.
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

  // §2.218 — 'subscription' is a REMOVED provider id that can still be sitting
  // in a stale settings record or an old renderer's state. It must never address
  // the key store: there is no key under that name, and `ai:deleteApiKey`
  // rejects it in main.
  it('rejects a removed provider id, empty, and non-string values', () => {
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

  it('never masks a removed provider id — it has no stored key', () => {
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

  it('does not delete anything for a removed provider id or for no provider', async () => {
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

function installApi(settings: SettingsBlob, rules: unknown[] = []): void {
  invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case 'settings:get': return settings
      case 'settings:save': return { ok: true }
      case 'accounts:list': return []
      case 'accounts:getCurrent': return null
      case 'mcpExport:status': return { status: 'stopped' }
      case 'mcp:status': return []
      case 'tls:listPins': return []
      case 'rules:list': return rules
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

  // §2.218 — SILENT RESET, renderer half. A settings record that still names the
  // removed `subscription` provider must land on the "choose a provider" state
  // rather than a half-configured saved view. The persistent half of this
  // (dropping the value on read) lives in `settingsSchema`; this is the
  // defence-in-depth half, because the window renders whatever `settings:get`
  // hands it. No notification, no migration UI — just the existing empty state.
  it('falls back to the provider picker when the stored provider was removed', async () => {
    installApi({ theme: 'light', aiProvider: 'subscription' })
    render(<Settings />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
    fireEvent.click(screen.getByTestId('settings-tab-ai'))
    await waitFor(() => expect(screen.getByTestId('settings-ai-provider')).toBeInTheDocument())
    // No saved-provider view: no reset link, and nothing was read or deleted
    // from the key store on the strength of an id that no longer exists.
    expect(document.querySelector('.ai-reset-link')).toBeNull()
    expect(invoke.mock.calls.some(([channel]) => channel === 'ai:deleteApiKey')).toBe(false)
  })

  // The picker offers exactly the key-based providers; the removed
  // "Claude subscription" entry must not be reachable from the UI.
  it('offers no subscription option in the provider picker', async () => {
    installApi({ theme: 'light' })
    render(<Settings />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
    fireEvent.click(screen.getByTestId('settings-tab-ai'))
    const picker = await screen.findByTestId('settings-ai-provider')
    expect(picker.querySelectorAll('button')).toHaveLength(3)
    expect(picker.textContent ?? '').not.toMatch(/subscription|подписк/i)
  })

  it('keeps the confirmation gate in front of the delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await openAiTab({ theme: 'light', aiProvider: 'openai-api', aiApiKeySaved: { 'openai-api': true } })
    await clickReset()
    expect(invoke.mock.calls.some(([channel]) => channel === 'ai:deleteApiKey')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Part C — §2.202: a rule the client refuses to run is marked in the LIST.
//
// Since §2.162 a stored rule whose firing cannot be justified is simply never
// applied. Nothing said so outside the editor, so the rule looked enabled and
// the user had no reason to open it. These tests mount the REAL Settings window
// (a hand-rolled mirror of the branch would keep passing after the badge was
// removed — the §2.66 precedent) and drive the rules tab as a user does.
//
// The verdict itself is `findEncodedMailRuleRefusal` from packages/core, tested
// in `src/components/ruleRefusalText.test.ts`; what is at stake here is the
// wiring: right badge, right rule, and a way into the editor.
// ---------------------------------------------------------------------------

/** A `rules:list` row exactly as main sends it. */
function ruleRow(
  name: string,
  conditions: unknown[],
  actions: unknown[],
  id = name,
): Record<string, unknown> {
  return {
    id,
    accountId: null,
    name,
    enabled: true,
    priority: 0,
    conditions: JSON.stringify(conditions),
    actions: JSON.stringify(actions),
    stopProcessing: false,
  }
}

/** Mount Settings, wait for the settings load, and open the Rules tab. */
async function openRulesTab(rules: unknown[]): Promise<void> {
  installApi({ theme: 'light' }, rules)
  render(<Settings />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
  fireEvent.click(screen.getByTestId('settings-tab-rules'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('rules:list'))
}

describe('§2.202 Settings rules list — a policy-refused rule is marked and opens', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
  })

  // REGRESSION GUARD — this rule is inert, and the list used to show it as a
  // perfectly ordinary "1 condition, 1 action" entry.
  it('marks a rule whose destructive action rests on the sender-written name', async () => {
    await openRulesTab([
      ruleRow('Trash by display name', [{ field: 'from_name', op: 'contains', value: 'Bank' }], [{ type: 'trash' }]),
    ])

    const badge = await screen.findByTestId('rule-refused-badge')
    expect(badge).toBeInTheDocument()
    expect(screen.queryByTestId('rule-malformed-badge')).not.toBeInTheDocument()
    // The one-line reason travels with the badge for pointer and screen reader
    // alike, and it is the reason for THIS verdict, not a generic sentence.
    expect(badge).toHaveAttribute('title', 'settings.rules.refusal.unverifiableSender')
    expect(badge).toHaveTextContent('settings.rules.refusal.unverifiableSender')
    expect(badge).toHaveTextContent('settings.rules.refusedBadge')
  })

  it('marks a condition on a field the client does not store', async () => {
    await openRulesTab([
      ruleRow('Archive by CC', [{ field: 'cc', op: 'contains', value: 'team@example.test' }], [{ type: 'archive' }]),
    ])

    const badge = await screen.findByTestId('rule-refused-badge')
    expect(badge).toHaveAttribute('title', 'settings.rules.refusal.unsupportedField')
  })

  it('opens the rule in the editor when the badge is clicked', async () => {
    await openRulesTab([
      ruleRow('Trash by display name', [{ field: 'from_name', op: 'contains', value: 'Bank' }], [{ type: 'trash' }]),
    ])

    fireEvent.click(await screen.findByTestId('rule-refused-badge'))

    const dialog = await waitFor(() => {
      const el = document.querySelector('.modal-dialog')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    // The editor opened on the refused rule, not on a blank new one.
    expect(dialog).toHaveTextContent('Trash by display name')
  })

  // NEGATIVE CONTROL — a badge that appears on healthy rules teaches the user
  // to ignore it, which costs more than showing nothing.
  it('leaves a rule the client can apply unmarked, with its counts', async () => {
    await openRulesTab([
      ruleRow('Archive newsletters', [{ field: 'from_address', op: 'contains', value: '@news.test' }], [{ type: 'archive' }]),
    ])

    await waitFor(() => expect(screen.getByText('Archive newsletters')).toBeInTheDocument())
    expect(screen.queryByTestId('rule-refused-badge')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rule-malformed-badge')).not.toBeInTheDocument()
    expect(document.querySelector('.rule-item')).toHaveTextContent(
      '1 settings.rules.conditions, 1 settings.rules.actions',
    )
  })

  // A disabled rule is not "already handled": the user turned it off, and the
  // reason it will not run once turned back on is the same one. Dropping the
  // badge here would hide the refusal exactly when the user is about to re-enable.
  it('keeps the badge on a refused rule the user has switched off', async () => {
    await openRulesTab([
      {
        ...ruleRow('Trash by display name', [{ field: 'from_name', op: 'contains', value: 'Bank' }], [{ type: 'trash' }]),
        enabled: false,
      },
    ])

    const badge = await screen.findByTestId('rule-refused-badge')
    expect(badge).toHaveAttribute('title', 'settings.rules.refusal.unverifiableSender')
    const checkbox = document.querySelector('.rule-item input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
  })

  // A rule with nothing in it is unfinished, not refused. The counts say so;
  // "not applied" would blame a policy that never spoke.
  it('shows counts, not a badge, for a rule with no conditions and no actions', async () => {
    await openRulesTab([ruleRow('Empty rule', [], [])])

    await waitFor(() => expect(screen.getByText('Empty rule')).toBeInTheDocument())
    expect(screen.queryByTestId('rule-refused-badge')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rule-malformed-badge')).not.toBeInTheDocument()
    expect(document.querySelector('.rule-item')).toHaveTextContent(
      '0 settings.rules.conditions, 0 settings.rules.actions',
    )
  })

  // Rule ids arrive over IPC, so one can be named after a member of
  // `Object.prototype`. Looked up in a plain object, `toString` answers with an
  // inherited function — truthy — and this healthy rule would be badged.
  it('leaves a healthy rule unmarked when its id names a prototype member', async () => {
    await openRulesTab([
      ruleRow('Archive newsletters', [{ field: 'from_address', op: 'contains', value: '@news.test' }], [{ type: 'archive' }], 'toString'),
    ])

    await waitFor(() => expect(screen.getByText('Archive newsletters')).toBeInTheDocument())
    expect(screen.queryByTestId('rule-refused-badge')).not.toBeInTheDocument()
    expect(document.querySelector('.rule-item')).toHaveTextContent(
      '1 settings.rules.conditions, 1 settings.rules.actions',
    )
  })

  // A malformed row is refused too (`malformed_rule`), but it keeps the older,
  // more specific badge: the editor cannot show what to fix in it.
  it('keeps the malformed badge for a row whose halves are not a rule', async () => {
    await openRulesTab([
      { id: 'broken', accountId: null, name: 'Broken rule', enabled: true, priority: 0, conditions: 'null', actions: '[]', stopProcessing: false },
    ])

    expect(await screen.findByTestId('rule-malformed-badge')).toBeInTheDocument()
    expect(screen.queryByTestId('rule-refused-badge')).not.toBeInTheDocument()
  })

  it('marks only the offending rule when a healthy one sits next to it', async () => {
    await openRulesTab([
      ruleRow('Archive newsletters', [{ field: 'from_address', op: 'contains', value: '@news.test' }], [{ type: 'archive' }], 'good'),
      ruleRow('Trash by display name', [{ field: 'from_name', op: 'contains', value: 'Bank' }], [{ type: 'trash' }], 'bad'),
    ])

    await waitFor(() => expect(screen.getAllByTestId('rule-refused-badge')).toHaveLength(1))
    const rows = Array.from(document.querySelectorAll('.rule-item'))
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('[data-testid="rule-refused-badge"]')).toBeNull()
    expect(rows[1].querySelector('[data-testid="rule-refused-badge"]')).not.toBeNull()
  })

  // §2.202 wiring gap: `mailRuleRefusals` is set beside `mailRules` inside the
  // SAME `loadMailRules` call, not computed once at mount. This proves the pair
  // stays coupled across a reload — every write path (`rules:update`,
  // `rules:delete`, save) reloads through that one function — so a badge for a
  // rule that has since been fixed cannot survive the next list refresh.
  it('recomputes the badge from the fresh reply on the next reload, not the one from mount', async () => {
    const refused = ruleRow(
      'Trash by display name',
      [{ field: 'from_name', op: 'contains', value: 'Bank' }],
      [{ type: 'trash' }],
      'r1',
    )
    const rules = [refused]
    installApi({ theme: 'light' }, rules)
    render(<Settings />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
    fireEvent.click(screen.getByTestId('settings-tab-rules'))
    await screen.findByTestId('rule-refused-badge')

    // Simulate the rule having been repaired through the editor: the next
    // `rules:list` reply for the same id no longer carries the refused halves.
    // Nothing re-renders yet — only the next reload (triggered below by the
    // enabled-toggle, exactly as `rules:update` triggers one for real) can see it.
    rules[0] = ruleRow(
      'Trash by display name',
      [{ field: 'from_address', op: 'contains', value: 'bank.example.test' }],
      [{ type: 'trash' }],
      'r1',
    )
    const checkbox = document.querySelector('.rule-item input[type="checkbox"]') as HTMLInputElement
    expect(checkbox).not.toBeNull()
    fireEvent.click(checkbox)

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('rules:update', 'r1', { enabled: false }))
    await waitFor(() => expect(screen.queryByTestId('rule-refused-badge')).not.toBeInTheDocument())
  })
})
