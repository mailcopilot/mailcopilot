// @vitest-environment jsdom
/**
 * BACKLOG §2.103 — the spell-checking section of the Settings window's
 * General tab.
 *
 * `electron/services/spellcheck.test.ts` pins the pure decisions
 * (`resolveSpellcheckSession`, `applySpellcheckDecision`, …) and
 * `tests/e2e/spellcheck.spec.ts` proves the whole round trip through a real
 * `settings:save`. What neither covers is the RENDER logic that lives only in
 * this component:
 *
 *   - AC6 (macOS owns the list): the picker must not be drawn at all when
 *     `spellcheckAvailable.platformOwned` is true — offering a control that
 *     changes nothing is the failure CLAUDE.md §5 "Кто владеет правдой"
 *     describes. This is the one branch the e2e spec cannot reach on a Linux
 *     runner (`isPlatformOwnedSpellcheck()` is `darwin`-only) and the one the
 *     domain agent's own report flagged as unverified — a mocked
 *     `settings:get` reply closes that gap without needing a macOS machine.
 *   - the "declined" notice this window renders when main answers
 *     `settings:save` with `spellcheckDeclined`, and the REACTIVE REPAIR that
 *     follows it (same shape as the `mcpExportWhitelist` repair in
 *     `Settings.mcpExportRefusal.test.tsx`): without the repair, a declined
 *     language stays in this window's state and is re-submitted — and
 *     re-refused — on every later save.
 *   - the save payload always carries `spellcheckEnabled` and
 *     `spellcheckLanguages` as concrete values (never an absent key or
 *     `undefined`), which is what lets main tell "no change requested" apart
 *     from "check nothing" (`Array.isArray` on the main side).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn(), language: 'en' } }),
}))
vi.mock('../i18n', () => ({
  default: { changeLanguage: vi.fn(), language: 'en' },
  SUPPORTED_LANGUAGES: ['en', 'ru', 'fr', 'de', 'es', 'it'],
  DEFAULT_LANGUAGE: 'en',
}))
vi.mock('../sentry', () => ({ sendFeedback: vi.fn(), captureException: vi.fn() }))

import Settings from './Settings'

type SettingsBlob = Record<string, unknown>
type SaveReply = Record<string, unknown> | undefined
type SaveResponder = SaveReply | ((payload: Record<string, unknown>) => SaveReply)

let invoke: ReturnType<typeof vi.fn>
let closeSpy: ReturnType<typeof vi.spyOn>

function installApi(settings: SettingsBlob, saveReply: SaveResponder = { ok: true }): void {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'settings:get': return settings
      case 'settings:save': return typeof saveReply === 'function'
        ? saveReply(args[0] as Record<string, unknown>)
        : saveReply
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

/** Mount and wait for the General tab (default) to have loaded settings. */
async function mountGeneralTab(settings: SettingsBlob, saveReply: SaveResponder = { ok: true }): Promise<void> {
  installApi(settings, saveReply)
  render(<Settings />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:get'))
  await screen.findByTestId('settings-spellcheck-enabled')
}

/** Payloads of every `settings:save` the window issued, in order. */
function savePayloads(): Record<string, unknown>[] {
  return invoke.mock.calls
    .filter(([channel]) => channel === 'settings:save')
    .map(([, payload]) => payload as Record<string, unknown>)
}

const BASE = { theme: 'light', language: 'en' }

beforeEach(() => {
  closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('§2.103 Settings — a fresh profile', () => {
  it('renders the switch OFF and "no dictionaries chosen" when nothing is persisted', async () => {
    await mountGeneralTab(BASE)
    expect(screen.getByTestId('settings-spellcheck-enabled')).not.toBeChecked()
    expect(screen.getByTestId('settings-spellcheck-none')).toBeInTheDocument()
  })

  // Regression guard for the comment in Settings.tsx: an explicit array must
  // travel on EVERY save, never an absent key — that is what lets main tell
  // "this save did not touch spellcheck" apart from "check nothing".
  it('always sends spellcheckEnabled and spellcheckLanguages as concrete values', async () => {
    await mountGeneralTab(BASE)
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(savePayloads().length).toBe(1))
    expect(savePayloads()[0].spellcheckEnabled).toBe(false)
    expect(savePayloads()[0].spellcheckLanguages).toEqual([])
  })
})

describe('§2.103 Settings — AC6: macOS owns the language list', () => {
  it('shows the platform-owned notice instead of a picker', async () => {
    await mountGeneralTab({
      ...BASE,
      spellcheckAvailable: { languages: ['en-US'], platformOwned: true, max: 8, at: 'now' },
    })
    expect(screen.getByTestId('settings-spellcheck-platform-owned')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-spellcheck-add-language')).toBeNull()
    // The on/off switch is the one control that does work there — CLAUDE.md
    // §5 "Кто владеет правдой" forbids offering the rest.
    expect(screen.getByTestId('settings-spellcheck-enabled')).toBeInTheDocument()
  })

  it('offers the picker on a platform that owns nothing (the non-macOS default)', async () => {
    await mountGeneralTab({
      ...BASE,
      spellcheckAvailable: { languages: ['en-US', 'ru-RU'], platformOwned: false, max: 8, at: 'now' },
    })
    expect(screen.queryByTestId('settings-spellcheck-platform-owned')).toBeNull()
    expect(screen.getByTestId('settings-spellcheck-add-language')).toBeInTheDocument()
  })
})

describe('§2.103 Settings — an empty availability report', () => {
  it('shows the "unavailable" hint rather than a silently empty picker', async () => {
    await mountGeneralTab({
      ...BASE,
      spellcheckAvailable: { languages: [], platformOwned: false, max: 8, at: 'now' },
    })
    expect(screen.getByTestId('settings-spellcheck-unavailable')).toBeInTheDocument()
  })

  it('shows the same hint before main has ever reported availability', async () => {
    await mountGeneralTab(BASE) // no spellcheckAvailable key at all
    expect(screen.getByTestId('settings-spellcheck-unavailable')).toBeInTheDocument()
  })
})

describe('§2.103 Settings — removing a chosen language', () => {
  it('drops it from the rendered list and from the next save payload', async () => {
    await mountGeneralTab({
      ...BASE,
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU', 'en-US'],
      spellcheckAvailable: { languages: ['ru-RU', 'en-US', 'de-DE'], platformOwned: false, max: 8, at: 'now' },
    })
    const list = screen.getByTestId('settings-spellcheck-languages')
    expect(list).toHaveTextContent('ru-RU')
    fireEvent.click(screen.getByRole('button', { name: /remove ru-RU/i }))
    await waitFor(() => expect(screen.getByTestId('settings-spellcheck-languages')).not.toHaveTextContent('ru-RU'))
    expect(screen.getByTestId('settings-spellcheck-languages')).toHaveTextContent('en-US')

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(savePayloads().length).toBe(1))
    expect(savePayloads()[0].spellcheckLanguages).toEqual(['en-US'])
  })

  it('shows the "none chosen" hint once the last language is removed', async () => {
    await mountGeneralTab({
      ...BASE,
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU'],
      spellcheckAvailable: { languages: ['ru-RU'], platformOwned: false, max: 8, at: 'now' },
    })
    expect(screen.queryByTestId('settings-spellcheck-none')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /remove ru-RU/i }))
    await waitFor(() => expect(screen.getByTestId('settings-spellcheck-none')).toBeInTheDocument())
  })
})

describe('§2.103 Settings — the language cap (codex low finding)', () => {
  // Exact-boundary pin for the picker's own guard (`max > 0 &&
  // spellcheckLanguages.length >= max` in Settings.tsx): an off-by-one there
  // (`>` instead of `>=`) would let a save exceed what `spellcheckAvailable`
  // reported, and the schema-level caps pinned in packages/net/config.test.ts
  // and electron/services/spellcheck.test.ts do not see this renderer-only
  // guard at all.
  it('does not add a language once spellcheckAvailable.max is already reached', async () => {
    await mountGeneralTab({
      ...BASE,
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU', 'en-US'],
      spellcheckAvailable: { languages: ['ru-RU', 'en-US', 'de-DE'], platformOwned: false, max: 2, at: 'now' },
    })
    const list = screen.getByTestId('settings-spellcheck-languages')
    expect(list).toHaveTextContent('ru-RU')
    expect(list).toHaveTextContent('en-US')

    const picker = screen.getByTestId('settings-spellcheck-add-language')
    fireEvent.click(picker)
    const options = await screen.findAllByRole('option')
    const deOption = options.find(o => (o.textContent ?? '').includes('de-DE'))
    expect(deOption).toBeTruthy()
    fireEvent.click(deOption!)

    // The cap silently refuses the pick — the list stays at exactly `max`.
    expect(screen.getByTestId('settings-spellcheck-languages')).not.toHaveTextContent('de-DE')

    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(savePayloads().length).toBe(1))
    expect(savePayloads()[0].spellcheckLanguages).toEqual(['ru-RU', 'en-US'])
  })
})

describe('§2.103 Settings — a declined dictionary download', () => {
  const DECLINED_REPLY = {
    ok: true,
    spellcheckDeclined: { count: 1, message: 'The Russian dictionary was not downloaded.' },
  }

  it('shows main\'s own message and keeps the window open', async () => {
    await mountGeneralTab({
      ...BASE,
      spellcheckAvailable: { languages: ['ru-RU'], platformOwned: false, max: 8, at: 'now' },
    }, DECLINED_REPLY)
    fireEvent.click(screen.getByTestId('settings-save'))
    const notice = await screen.findByTestId('settings-spellcheck-declined')
    expect(notice).toHaveTextContent('The Russian dictionary was not downloaded.')
    expect(closeSpy).not.toHaveBeenCalled()
  })

  // THE POINT OF THE REPAIR. Without it, the declined language stays selected
  // in this window's state and is resubmitted — and re-refused — forever.
  it('repairs its language list from a fresh settings:get after a decline', async () => {
    await mountGeneralTab({
      ...BASE,
      spellcheckAvailable: { languages: ['ru-RU'], platformOwned: false, max: 8, at: 'now' },
    }, payload => {
      // First save: main declines and does NOT persist the language.
      if (Array.isArray(payload.spellcheckLanguages) && payload.spellcheckLanguages.length > 0) {
        return DECLINED_REPLY
      }
      return { ok: true }
    })

    const picker = screen.getByTestId('settings-spellcheck-add-language')
    fireEvent.click(picker)
    // The rendered label may be "Russian (ru-RU)" (Intl.DisplayNames) or the
    // bare code, depending on ICU data — match on the code, which is always
    // present (see spellcheckLanguageLabel's fallback).
    const options = await screen.findAllByRole('option')
    const ruOption = options.find(o => (o.textContent ?? '').includes('ru-RU'))
    expect(ruOption).toBeTruthy()
    fireEvent.click(ruOption!)
    expect(screen.getByTestId('settings-spellcheck-languages')).toHaveTextContent('ru-RU')

    fireEvent.click(screen.getByTestId('settings-save'))
    await screen.findByTestId('settings-spellcheck-declined')

    // `settings:get` in this test's own mock never carried `spellcheckLanguages`
    // (main never persisted it — the decline gate dropped it before the write).
    // Without the reactive repair, this window would keep showing the pick the
    // user made locally; the "none chosen" hint appearing here is the fresh
    // `settings:get` reply overwriting that optimistic local state.
    await waitFor(() => expect(screen.getByTestId('settings-spellcheck-none')).toBeInTheDocument())
  })

  it('does not close the window on a declined save', async () => {
    await mountGeneralTab(BASE, DECLINED_REPLY)
    fireEvent.click(screen.getByTestId('settings-save'))
    await screen.findByTestId('settings-spellcheck-declined')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closeSpy).not.toHaveBeenCalled()
  })
})

describe('§2.103 Settings — an accepted save', () => {
  it('closes the window and shows no declined notice', async () => {
    await mountGeneralTab({
      ...BASE,
      spellcheckAvailable: { languages: ['ru-RU'], platformOwned: false, max: 8, at: 'now' },
    })
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(closeSpy).toHaveBeenCalled())
    expect(screen.queryByTestId('settings-spellcheck-declined')).toBeNull()
  })
})
