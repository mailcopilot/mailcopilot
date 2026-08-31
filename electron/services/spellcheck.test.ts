/**
 * Spell checking — BACKLOG §2.103.
 *
 * The load-bearing assertions here are the ones about what must NOT happen:
 *
 *   - no dictionary language is armed without a recorded consent, including
 *     one that reached the store by a path this build never gated (an older
 *     version, a hand-edited file);
 *   - a decline enables nothing and PERSISTS nothing — neither a language nor
 *     a refusal;
 *   - a dialog that fails, or one that arrives while another is open, is not
 *     an acceptance;
 *   - "spell check on, no language chosen" resolves to OFF, because Electron
 *     reads an empty language list as "use the OS locale" and fetches that
 *     dictionary — the silent request this feature exists to remove;
 *   - the language codes never reach a metric tag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  fromWebContents: vi.fn(() => null),
  getAllWindows: vi.fn(() => [] as unknown[]),
  isPackaged: false,
  captureException: vi.fn(),
  recordEvent: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  defaultSession: null as unknown,
}))

vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.isPackaged } },
  dialog: { showMessageBox: mocks.showMessageBox },
  BrowserWindow: {
    fromWebContents: mocks.fromWebContents,
    getAllWindows: mocks.getAllWindows,
  },
  session: { get defaultSession() { return mocks.defaultSession } },
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: mocks.debug, info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}))
vi.mock('../sentry', () => ({ captureException: mocks.captureException }))
vi.mock('../metrics', () => ({ recordEvent: mocks.recordEvent }))
// packages/net/config reaches electron-store, keytar and packages/db at import
// time; the service needs one constant from it. The value here is deliberately
// NOT the shipped one — the assertion below is that the service reads the
// constant rather than hardcoding a number. What the real cap is, is pinned
// where it is enforced: the `spellcheckLanguages` cases in
// packages/net/config.test.ts.
const MOCK_MAX_LANGUAGES = 3
vi.mock('../../packages/net/config', () => ({ SPELLCHECK_MAX_LANGUAGES: 3 }))

import {
  normalizeSpellcheckLanguages,
  planDictionaryConsent,
  resolveSpellcheckSession,
  applySpellcheckDecision,
  buildSpellcheckPrompt,
  spellcheckLabels,
  spellcheckDeclinedMessage,
  isPlatformOwnedSpellcheck,
  readSpellcheckAvailability,
  initSpellcheck,
  applySpellcheckToWindow,
  reapplySpellcheck,
  ensureSpellcheckDictionariesApproved,
  resetSpellcheckForTest,
  DICTIONARY_DOWNLOAD_ORIGIN,
  type SpellcheckDeps,
  type SpellcheckLabelKey,
} from './spellcheck'

// --- helpers ---------------------------------------------------------------

type DownloadListener = (event: unknown, languageCode: string) => void

function fakeSession(available: string[] = ['en-US', 'ru-RU', 'de-DE', 'fr-FR']) {
  const listeners: DownloadListener[] = []
  return {
    availableSpellCheckerLanguages: available,
    setSpellCheckerLanguages: vi.fn(),
    setSpellCheckerEnabled: vi.fn(),
    addWordToSpellCheckerDictionary: vi.fn(),
    on: vi.fn((event: string, listener: DownloadListener) => {
      if (event === 'spellcheck-dictionary-download-begin') listeners.push(listener)
    }),
    /** Test-only: simulate Chromium starting a dictionary download. */
    emitDownload(lang: string) { for (const l of listeners) l({}, lang) },
  }
}

type FakeSession = ReturnType<typeof fakeSession>

function deps(over: Partial<SpellcheckDeps> = {}, settings: Record<string, unknown> = {}): SpellcheckDeps {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSettings: vi.fn(() => settings as any),
    saveSettings: vi.fn(),
    getLanguage: () => 'en',
    isE2E: () => false,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSpellcheckForTest()
  mocks.isPackaged = false
  mocks.getAllWindows.mockReturnValue([])
  delete process.env.MAILCOPILOT_E2E
})

// --- normalisation ---------------------------------------------------------

describe('§2.103 normalizeSpellcheckLanguages', () => {
  const available = ['en-US', 'ru-RU', 'de-DE']

  it('keeps only languages the platform actually offers', () => {
    // The guard that matters: setSpellCheckerLanguages THROWS on an unknown
    // code, and this call sits on the settings-save path.
    expect(normalizeSpellcheckLanguages(['en-US', 'kl-GL'], available)).toEqual(['en-US'])
  })

  it('returns the availability list casing, not the caller casing', () => {
    expect(normalizeSpellcheckLanguages(['EN-us', ' ru-ru '], available)).toEqual(['en-US', 'ru-RU'])
  })

  it('drops duplicates that differ only in case', () => {
    expect(normalizeSpellcheckLanguages(['en-US', 'en-us'], available)).toEqual(['en-US'])
  })

  it('preserves the requested order', () => {
    expect(normalizeSpellcheckLanguages(['ru-RU', 'en-US'], available)).toEqual(['ru-RU', 'en-US'])
  })

  it('caps the list at the schema constant, not at a number of its own', () => {
    const many = Array.from({ length: 20 }, (_, i) => `l${i}`)
    const out = normalizeSpellcheckLanguages(many, many)
    expect(out).toHaveLength(MOCK_MAX_LANGUAGES)
  })

  // Exact-boundary pair for the cap (codex low finding): the two tests above
  // only ever exercise "well under" (a handful) and "well over" (20 against a
  // cap of 3), so an off-by-one (`> max` instead of `>= max` in the break
  // condition) would pass both without being caught.
  it('keeps every language when the request lands exactly on the cap', () => {
    const exact = Array.from({ length: MOCK_MAX_LANGUAGES }, (_, i) => `l${i}`)
    expect(normalizeSpellcheckLanguages(exact, exact)).toEqual(exact)
  })

  it('answers empty for absent, empty and non-array input', () => {
    expect(normalizeSpellcheckLanguages(undefined, available)).toEqual([])
    expect(normalizeSpellcheckLanguages([], available)).toEqual([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeSpellcheckLanguages(['ok', 5 as any], ['ok'])).toEqual(['ok'])
  })

  it('answers empty when availability could not be read (fail closed)', () => {
    expect(normalizeSpellcheckLanguages(['en-US'], [])).toEqual([])
  })
})

// --- consent planning ------------------------------------------------------

describe('§2.103 planDictionaryConsent', () => {
  it('asks about a language with no grant record', () => {
    expect(planDictionaryConsent({
      requested: ['en-US', 'ru-RU'],
      granted: ['en-US'],
      platformOwned: false,
    })).toEqual({ needed: ['ru-RU'] })
  })

  it('does not re-ask about a granted language, whatever its casing', () => {
    expect(planDictionaryConsent({
      requested: ['RU-ru'],
      granted: ['ru-RU'],
      platformOwned: false,
    })).toEqual({ needed: [] })
  })

  it('asks nothing where the OS owns the list (no download happens there)', () => {
    expect(planDictionaryConsent({
      requested: ['en-US', 'ru-RU'],
      granted: undefined,
      platformOwned: true,
    })).toEqual({ needed: [] })
  })
})

// --- session resolution ----------------------------------------------------

describe('§2.103 resolveSpellcheckSession', () => {
  const availability = { languages: ['en-US', 'ru-RU'], platformOwned: false }

  it('arms only consented languages', () => {
    expect(resolveSpellcheckSession({
      spellcheckEnabled: true,
      spellcheckLanguages: ['en-US', 'ru-RU'],
      spellcheckDictionaryConsent: { granted: ['en-US'], at: 'now' },
    }, availability)).toEqual({ enabled: true, languages: ['en-US'] })
  })

  it('ignores a language that reached the store without ever being consented', () => {
    // The path this covers: a value persisted by an older build, or one
    // hand-edited into the settings file — neither passed through the save gate.
    expect(resolveSpellcheckSession({
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU'],
    }, availability)).toEqual({ enabled: false, languages: [] })
  })

  it('is OFF when enabled but nothing is chosen', () => {
    // Electron reads an empty list as "use the OS locale" and downloads that
    // dictionary. "On with nothing chosen" must therefore not reach the session.
    expect(resolveSpellcheckSession({
      spellcheckEnabled: true,
      spellcheckLanguages: [],
      spellcheckDictionaryConsent: { granted: ['en-US'], at: 'now' },
    }, availability)).toEqual({ enabled: false, languages: [] })
  })

  it('is OFF when the switch is off, whatever is consented', () => {
    expect(resolveSpellcheckSession({
      spellcheckEnabled: false,
      spellcheckLanguages: ['en-US'],
      spellcheckDictionaryConsent: { granted: ['en-US'], at: 'now' },
    }, availability)).toEqual({ enabled: false, languages: [] })
  })

  it('needs no language on the platform that owns the list', () => {
    expect(resolveSpellcheckSession(
      { spellcheckEnabled: true },
      { languages: ['en-US'], platformOwned: true },
    )).toEqual({ enabled: true, languages: [] })
  })

  it('defaults to OFF for a settings object that never mentioned it', () => {
    expect(resolveSpellcheckSession({}, availability)).toEqual({ enabled: false, languages: [] })
  })
})

// --- decision folding ------------------------------------------------------

describe('§2.103 applySpellcheckDecision', () => {
  const base = { platformOwned: false, now: '2026-08-17T00:00:00.000Z' }

  it('enables an approved language and records the grant', () => {
    expect(applySpellcheckDecision({
      ...base,
      requested: ['ru-RU'],
      approvedNow: ['ru-RU'],
      previousConsent: undefined,
    })).toEqual({
      spellcheckLanguages: ['ru-RU'],
      spellcheckDictionaryConsent: { granted: ['ru-RU'], at: base.now },
    })
  })

  it('enables nothing and persists nothing when the download was declined', () => {
    expect(applySpellcheckDecision({
      ...base,
      requested: ['ru-RU'],
      approvedNow: [],
      previousConsent: undefined,
    })).toEqual({ spellcheckLanguages: [] })
  })

  it('keeps the previously granted languages while declining a new one', () => {
    const previousConsent = { granted: ['en-US'], at: 'earlier' }
    expect(applySpellcheckDecision({
      ...base,
      requested: ['en-US', 'ru-RU'],
      approvedNow: [],
      previousConsent,
    })).toEqual({ spellcheckLanguages: ['en-US'], spellcheckDictionaryConsent: previousConsent })
  })

  it('unions the grant record instead of replacing it', () => {
    expect(applySpellcheckDecision({
      ...base,
      requested: ['en-US', 'de-DE'],
      approvedNow: ['de-DE'],
      previousConsent: { granted: ['en-US'], at: 'earlier' },
    })).toEqual({
      spellcheckLanguages: ['en-US', 'de-DE'],
      spellcheckDictionaryConsent: { granted: ['en-US', 'de-DE'], at: base.now },
    })
  })

  it('writes no consent record where the OS owns the list', () => {
    expect(applySpellcheckDecision({
      ...base,
      platformOwned: true,
      requested: ['en-US'],
      approvedNow: [],
      previousConsent: undefined,
    })).toEqual({ spellcheckLanguages: ['en-US'] })
  })

  it('lets an explicit empty request clear the list', () => {
    expect(applySpellcheckDecision({
      ...base,
      requested: [],
      approvedNow: [],
      previousConsent: { granted: ['en-US'], at: 'earlier' },
    })).toEqual({
      spellcheckLanguages: [],
      spellcheckDictionaryConsent: { granted: ['en-US'], at: 'earlier' },
    })
  })
})

// --- prompt ----------------------------------------------------------------

describe('§2.103 consent prompt', () => {
  it('names the counterparty and the languages, and defaults to Cancel', () => {
    const prompt = buildSpellcheckPrompt(['ru-RU', 'de-DE'], spellcheckLabels('en'))
    expect(prompt.detail).toContain(DICTIONARY_DOWNLOAD_ORIGIN)
    expect(prompt.detail).toContain('ru-RU')
    expect(prompt.detail).toContain('de-DE')
    // Cancel is the FIRST button — the dialog uses index 0 as both defaultId
    // and cancelId, so a stray Enter or Esc refuses.
    expect(prompt.buttons[0]).toBe(spellcheckLabels('en').cancelButton)
    expect(prompt.detail).not.toContain('{{origin}}')
  })

  it('translates the prompt, falling back to English for an unknown language', () => {
    expect(spellcheckLabels('ru').consentTitle).not.toBe(spellcheckLabels('en').consentTitle)
    expect(spellcheckLabels('xx')).toBe(spellcheckLabels('en'))
    expect(spellcheckDeclinedMessage('ru')).toBe(spellcheckLabels('ru').declined)
  })

  it('covers every shipped locale', () => {
    // A locale file that exists but is missing from SPELLCHECK_LABELS would
    // silently show an English security prompt — same walk as contextMenu.test.
    const dir = join(fileURLToPath(new URL('.', import.meta.url)), '../../src/i18n/locales')
    const keys: SpellcheckLabelKey[] = [
      'consentTitle', 'consentMessage', 'consentDetail', 'consentLanguages',
      'consentButton', 'cancelButton', 'declined',
    ]
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const lang = file.replace(/\.json$/, '')
      const onDisk = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        spellcheck?: Record<string, string>
      }
      expect(onDisk.spellcheck, `${file} has no spellcheck block`).toBeTruthy()
      const labels = spellcheckLabels(lang)
      for (const key of keys) {
        expect(labels[key], `${lang}.${key}`).toBe(onDisk.spellcheck?.[key])
      }
    }
  })
})

// --- platform --------------------------------------------------------------

describe('§2.103 platform ownership', () => {
  it('reports macOS as owning the language list', () => {
    expect(isPlatformOwnedSpellcheck('darwin')).toBe(true)
    expect(isPlatformOwnedSpellcheck('linux')).toBe(false)
    expect(isPlatformOwnedSpellcheck('win32')).toBe(false)
  })

  it('reports an empty availability list when the session throws', () => {
    const broken = {
      get availableSpellCheckerLanguages(): string[] { throw new Error('boom') },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    expect(readSpellcheckAvailability(broken).languages).toEqual([])
  })
})

// --- macOS: setSpellCheckerLanguages is never called -----------------------

describe('§2.103 session application on a platform that owns the language list', () => {
  const ORIG_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!

  function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try { fn() } finally { Object.defineProperty(process, 'platform', ORIG_PLATFORM) }
  }

  it('never calls setSpellCheckerLanguages on macOS, on or off', () => {
    withPlatform('darwin', () => {
      const sess = fakeSession(['en-US'])
      mocks.defaultSession = sess
      initSpellcheck(deps({}, { spellcheckEnabled: true }))
      expect(sess.setSpellCheckerEnabled).toHaveBeenCalledWith(true)
      expect(sess.setSpellCheckerLanguages).not.toHaveBeenCalled()

      // A second session (a new window) gets the same treatment — the
      // platform check is read live on every apply, not cached from startup.
      const windowSession = fakeSession(['en-US'])
      applySpellcheckToWindow({
        isDestroyed: () => false,
        webContents: { session: windowSession },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      expect(windowSession.setSpellCheckerEnabled).toHaveBeenCalledWith(true)
      expect(windowSession.setSpellCheckerLanguages).not.toHaveBeenCalled()
    })
  })
})

// --- session application ---------------------------------------------------

describe('§2.103 session application', () => {
  it('arms the consented languages at startup', () => {
    const sess = fakeSession()
    mocks.defaultSession = sess
    initSpellcheck(deps({}, {
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU'],
      spellcheckDictionaryConsent: { granted: ['ru-RU'], at: 'now' },
    }))
    expect(sess.setSpellCheckerLanguages).toHaveBeenCalledWith(['ru-RU'])
    expect(sess.setSpellCheckerEnabled).toHaveBeenCalledWith(true)
  })

  it('disarms the checker and empties the language list by default', () => {
    // The default state of a fresh install: Chromium would otherwise pick the
    // OS locale and fetch its dictionary.
    const sess = fakeSession()
    mocks.defaultSession = sess
    initSpellcheck(deps({}, {}))
    expect(sess.setSpellCheckerLanguages).toHaveBeenCalledWith([])
    expect(sess.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
  })

  it('never arms the checker under the e2e harness', () => {
    const sess = fakeSession()
    mocks.defaultSession = sess
    initSpellcheck(deps({ isE2E: () => true }, {
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU'],
      spellcheckDictionaryConsent: { granted: ['ru-RU'], at: 'now' },
    }))
    expect(sess.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    expect(sess.setSpellCheckerLanguages).toHaveBeenCalledWith([])
  })

  it('disarms when applying the language list throws', () => {
    const sess = fakeSession()
    sess.setSpellCheckerLanguages.mockImplementation(() => { throw new Error('unknown code') })
    mocks.defaultSession = sess
    initSpellcheck(deps({}, {
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU'],
      spellcheckDictionaryConsent: { granted: ['ru-RU'], at: 'now' },
    }))
    expect(sess.setSpellCheckerEnabled).toHaveBeenLastCalledWith(false)
  })

  // §2.103 fix-wave (codex High-1): order follows the TARGET state, not one
  // fixed sequence — arming sets the languages before flipping the switch,
  // disarming flips the switch before clearing the languages. Two independent
  // `toHaveBeenCalledWith` assertions (as the tests above use) cannot catch the
  // two calls being made in the WRONG order; only a shared call log can.
  describe('order of the two Chromium calls (codex High-1)', () => {
    function orderedSession(available: string[] = ['en-US', 'ru-RU']) {
      const calls: string[] = []
      return {
        availableSpellCheckerLanguages: available,
        setSpellCheckerLanguages: vi.fn((langs: string[]) => { calls.push(`languages:${langs.join(',')}`) }),
        setSpellCheckerEnabled: vi.fn((v: boolean) => { calls.push(`enabled:${v}`) }),
        on: vi.fn(),
        calls,
      }
    }

    it('sets the language list before enabling the checker when arming', () => {
      const sess = orderedSession()
      mocks.defaultSession = sess
      initSpellcheck(deps({}, {
        spellcheckEnabled: true,
        spellcheckLanguages: ['ru-RU'],
        spellcheckDictionaryConsent: { granted: ['ru-RU'], at: 'now' },
      }))
      // A checker enabled while its language list is still the previous one
      // (or Electron's OS-locale default for an empty list) is exactly the
      // window in which an unconsented dictionary gets fetched.
      expect(sess.calls).toEqual(['languages:ru-RU', 'enabled:true'])
    })

    it('disables the checker before clearing the language list when disarming', () => {
      const sess = orderedSession()
      mocks.defaultSession = sess
      initSpellcheck(deps({}, {})) // nothing consented ⇒ disarm, the default case
      // The reverse order would clear the list while the checker is still on,
      // and Electron refills an empty list from the OS locale — reopening the
      // same unconsented-fetch window from the other side.
      expect(sess.calls).toEqual(['enabled:false', 'languages:'])
    })
  })

  // §2.103 fix-wave (codex Medium finding): applyToSession now returns what was
  // ACTUALLY applied, and both telemetry call sites are supposed to use it —
  // not the resolved desired state, which is a lie on the E2E and failure
  // paths. The tests above ("never arms… under the e2e harness",
  // "disarms when applying the language list throws") only check the Chromium
  // calls; these check the OTHER consumer of the return value.
  describe('telemetry reports the applied state, not the resolved one (codex finding)', () => {
    it('reports disarmed/zero under the e2e harness even though the settings asked for two languages', () => {
      const sess = fakeSession()
      mocks.defaultSession = sess
      initSpellcheck(deps({ isE2E: () => true }, {
        spellcheckEnabled: true,
        spellcheckLanguages: ['ru-RU', 'en-US'],
        spellcheckDictionaryConsent: { granted: ['ru-RU', 'en-US'], at: 'now' },
      }))
      const call = mocks.recordEvent.mock.calls.find(c => c[0] === 'spellcheck.configured')
      expect(call?.[1]).toEqual({ enabled: false, language_count: 0, platform_owned: false })
    })

    it('reports disarmed/zero when applying the language list throws', () => {
      const sess = fakeSession()
      sess.setSpellCheckerLanguages.mockImplementation(() => { throw new Error('unknown code') })
      mocks.defaultSession = sess
      initSpellcheck(deps({}, {
        spellcheckEnabled: true,
        spellcheckLanguages: ['ru-RU'],
        spellcheckDictionaryConsent: { granted: ['ru-RU'], at: 'now' },
      }))
      const call = mocks.recordEvent.mock.calls.find(c => c[0] === 'spellcheck.configured')
      expect(call?.[1]).toEqual({ enabled: false, language_count: 0, platform_owned: false })
    })
  })

  // §2.103 fix-wave (codex Medium finding): setSpellCheckerEnabled itself can
  // throw, not only setSpellCheckerLanguages — the existing throw test above
  // only exercises the languages call.
  describe('setSpellCheckerEnabled throws (codex Medium finding)', () => {
    it('disarms after enabling throws mid-arm, having already applied the language list', () => {
      const sess = fakeSession()
      // Throws once (the arming call); the RECOVERY call inside the catch
      // block succeeds normally.
      sess.setSpellCheckerEnabled.mockImplementationOnce(() => { throw new Error('boom') })
      mocks.defaultSession = sess
      initSpellcheck(deps({}, {
        spellcheckEnabled: true,
        spellcheckLanguages: ['ru-RU'],
        spellcheckDictionaryConsent: { granted: ['ru-RU'], at: 'now' },
      }))
      // Partial application: the language list DID reach the session (nothing
      // rolls that back), but the final state — what the caller reports and
      // what the checker is actually left in — is disarmed.
      expect(sess.setSpellCheckerLanguages).toHaveBeenCalledWith(['ru-RU'])
      expect(sess.setSpellCheckerEnabled).toHaveBeenLastCalledWith(false)
      const call = mocks.recordEvent.mock.calls.find(c => c[0] === 'spellcheck.configured')
      expect(call?.[1]).toEqual({ enabled: false, language_count: 0, platform_owned: false })
    })

    it('never throws out of initSpellcheck even when disarming itself fails on every attempt', () => {
      const sess = fakeSession()
      sess.setSpellCheckerEnabled.mockImplementation(() => { throw new Error('boom') })
      mocks.defaultSession = sess
      // Default (unconfigured) settings resolve to disarmed already, so the
      // FIRST call into setSpellCheckerEnabled(false) throws; the recovery
      // attempt inside the catch block throws too and is swallowed.
      expect(() => initSpellcheck(deps({}, {}))).not.toThrow()
      expect(sess.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
      const call = mocks.recordEvent.mock.calls.find(c => c[0] === 'spellcheck.configured')
      expect(call?.[1]).toEqual({ enabled: false, language_count: 0, platform_owned: false })
    })
  })

  it('publishes the platform language list into main-only settings', () => {
    const sess = fakeSession(['en-US', 'ru-RU'])
    mocks.defaultSession = sess
    const d = deps({}, {})
    initSpellcheck(d)
    expect(d.saveSettings).toHaveBeenCalledTimes(1)
    const written = (d.saveSettings as unknown as { mock: { calls: [Record<string, {
      languages: string[]; platformOwned: boolean
    }>][] } }).mock.calls[0][0]
    expect(written.spellcheckAvailable.languages).toEqual(['en-US', 'ru-RU'])
    expect(written.spellcheckAvailable.platformOwned).toBe(false)
  })

  it('does not rewrite an unchanged availability report', () => {
    const sess = fakeSession(['en-US'])
    mocks.defaultSession = sess
    const d = deps({}, {
      spellcheckAvailable: {
        languages: ['en-US'],
        platformOwned: false,
        // The reported cap is part of the comparison: a build that changed
        // SPELLCHECK_MAX_LANGUAGES must republish, or the Settings window keeps
        // enforcing the old bound.
        max: MOCK_MAX_LANGUAGES,
        at: 'earlier',
      },
    })
    initSpellcheck(d)
    expect(d.saveSettings).not.toHaveBeenCalled()
  })

  it('applies to a window session at creation time', () => {
    const startup = fakeSession()
    mocks.defaultSession = startup
    initSpellcheck(deps({}, {}))
    const windowSession = fakeSession()
    applySpellcheckToWindow({
      isDestroyed: () => false,
      webContents: { session: windowSession },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(windowSession.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
  })

  it('re-applies once per session, not once per window', () => {
    const shared = fakeSession()
    mocks.defaultSession = shared
    initSpellcheck(deps({}, {}))
    shared.setSpellCheckerEnabled.mockClear()
    const win = { isDestroyed: () => false, webContents: { session: shared } }
    mocks.getAllWindows.mockReturnValue([win, win, win])
    reapplySpellcheck()
    expect(shared.setSpellCheckerEnabled).toHaveBeenCalledTimes(1)
  })

  it('emits an aggregate configured event with a COUNT, never a language name', () => {
    const sess = fakeSession()
    mocks.defaultSession = sess
    initSpellcheck(deps({}, {
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU', 'en-US'],
      spellcheckDictionaryConsent: { granted: ['ru-RU', 'en-US'], at: 'now' },
    }))
    const call = mocks.recordEvent.mock.calls.find(c => c[0] === 'spellcheck.configured')
    expect(call?.[1]).toEqual({ enabled: true, language_count: 2, platform_owned: false })
    expect(JSON.stringify(mocks.recordEvent.mock.calls)).not.toContain('ru-RU')
  })
})

// --- fail-closed on an unreadable settings store (codex High-2) ------------

/**
 * §2.103 fix-wave: all three applying paths now use `safeSettings() ?? {}`
 * instead of `if (settings)` / `if (!settings) return`. Before the fix,
 * `applyToSession` was skipped entirely on a read failure and Chromium was
 * left at ITS OWN default — enabled, OS locale, fetch on the first
 * spellchecked field — which is the exact silent request this whole feature
 * exists to remove. `reapplySpellcheck` in particular used to `return` early,
 * leaving every live window at whatever it was last armed with.
 */
describe('§2.103 fail-closed when getSettings throws (codex High-2)', () => {
  it('disarms the default session at startup rather than skipping the apply', () => {
    const sess = fakeSession()
    mocks.defaultSession = sess
    const getSettings = vi.fn(() => { throw new Error('store unreadable') })
    initSpellcheck(deps({ getSettings }))
    expect(sess.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    expect(sess.setSpellCheckerLanguages).toHaveBeenCalledWith([])
  })

  it('disarms a window session created while the store is unreadable', () => {
    const startup = fakeSession()
    mocks.defaultSession = startup
    const getSettings = vi.fn(() => { throw new Error('store unreadable') })
    initSpellcheck(deps({ getSettings }))
    const windowSession = fakeSession()
    applySpellcheckToWindow({
      isDestroyed: () => false,
      webContents: { session: windowSession },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(windowSession.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    expect(windowSession.setSpellCheckerLanguages).toHaveBeenCalledWith([])
  })

  it('disarms every live window session when reapplySpellcheck cannot read settings, undoing a prior arm', () => {
    const shared = fakeSession()
    mocks.defaultSession = shared
    // `getSettings` starts out readable, so the checker is actually ARMED
    // first — otherwise "disarmed after the failure" would be
    // indistinguishable from "was never armed" (the old `if (!settings)
    // return` bug left this exact case silently untouched).
    const getSettings = vi.fn().mockReturnValue({
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU'],
      spellcheckDictionaryConsent: { granted: ['ru-RU'], at: 'now' },
    })
    initSpellcheck(deps({ getSettings }))
    expect(shared.setSpellCheckerEnabled).toHaveBeenLastCalledWith(true)
    shared.setSpellCheckerEnabled.mockClear()
    shared.setSpellCheckerLanguages.mockClear()
    mocks.getAllWindows.mockReturnValue([{ isDestroyed: () => false, webContents: { session: shared } }])

    getSettings.mockImplementation(() => { throw new Error('store unreadable') })
    reapplySpellcheck()

    expect(shared.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    expect(shared.setSpellCheckerLanguages).toHaveBeenCalledWith([])
  })
})

// --- download guard --------------------------------------------------------

describe('§2.103 unconsented download guard', () => {
  function armedSession(): FakeSession {
    const sess = fakeSession()
    mocks.defaultSession = sess
    initSpellcheck(deps({}, {
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU'],
      spellcheckDictionaryConsent: { granted: ['ru-RU'], at: 'now' },
    }))
    sess.setSpellCheckerEnabled.mockClear()
    return sess
  }

  it('stays quiet for a download of a granted language', () => {
    const sess = armedSession()
    sess.emitDownload('ru-RU')
    expect(sess.setSpellCheckerEnabled).not.toHaveBeenCalled()
    expect(mocks.captureException).not.toHaveBeenCalled()
  })

  it('disarms and reports a download nobody consented to', () => {
    const sess = armedSession()
    sess.emitDownload('fr-FR')
    expect(sess.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    expect(mocks.captureException).toHaveBeenCalledTimes(1)
    const [err, ctx] = mocks.captureException.mock.calls[0]
    // Synthetic, built from literals — the language code stays in the local log.
    expect((err as Error).message).toBe('spellcheck_dictionary_download_unconsented')
    expect(JSON.stringify(ctx)).not.toContain('fr-FR')
  })

  it('subscribes to a session only once', () => {
    const sess = armedSession()
    reapplySpellcheck()
    const subscriptions = sess.on.mock.calls
      .filter(c => c[0] === 'spellcheck-dictionary-download-begin')
    expect(subscriptions).toHaveLength(1)
  })

  // §2.103 fix-wave (codex Medium finding): the guard's own telemetry call can
  // itself fail — same "telemetry must not block the security decision" rule
  // as everywhere else in this file, but this is the one call site that runs
  // OUTSIDE the subscribe-time try/catch, in an Electron event callback.
  it('survives a Sentry failure inside the download-begin callback and still disarms', () => {
    const sess = armedSession()
    mocks.captureException.mockImplementation(() => { throw new Error('sentry down') })
    expect(() => sess.emitDownload('fr-FR')).not.toThrow()
    expect(sess.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
  })

  // §2.103 fix-wave: `guardedSessions` records "subscribed", not "tried". A
  // subscribe attempt that throws must leave the session eligible for another
  // one — marking it guarded first locked the failure in, and the session went
  // unguarded for the rest of its life with nothing but one warn line to say
  // so. De-duplication is unaffected: the mark is only reachable through a
  // `.on` call that returned.
  it('retries subscribing after the first attempt throws', () => {
    const sess = fakeSession()
    sess.on.mockImplementationOnce(() => { throw new Error('listener limit reached') })
    mocks.defaultSession = sess
    initSpellcheck(deps({}, {
      spellcheckEnabled: true,
      spellcheckLanguages: ['ru-RU'],
      spellcheckDictionaryConsent: { granted: ['ru-RU'], at: 'now' },
    }))
    expect(sess.on).toHaveBeenCalledTimes(1)
    expect(mocks.warn).toHaveBeenCalledWith(
      'subscribing to dictionary download events failed',
      expect.objectContaining({ errorKind: 'Error' }),
    )
    // Nothing is listening yet, so an unconsented download would go unnoticed.
    sess.emitDownload('fr-FR')
    expect(mocks.captureException).not.toHaveBeenCalled()

    // A second window commonly shares the SAME session
    // (`session.defaultSession`), and that apply is the retry.
    sess.on.mockClear()
    sess.setSpellCheckerEnabled.mockClear()
    applySpellcheckToWindow({
      isDestroyed: () => false,
      webContents: { session: sess },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(sess.on).toHaveBeenCalledTimes(1)

    // And the retry produced a WORKING guard, not just a second call.
    sess.setSpellCheckerEnabled.mockClear()
    sess.emitDownload('fr-FR')
    expect(sess.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    expect(mocks.captureException).toHaveBeenCalledTimes(1)

    // Still exactly once per session: the successful subscription marks it, so
    // a later re-apply that DOES reach `attachDownloadGuard` (a live window on
    // this session, not the windowless fallback) subscribes nothing further.
    sess.on.mockClear()
    mocks.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { session: sess } },
    ])
    reapplySpellcheck()
    expect(sess.on).not.toHaveBeenCalled()
  })
})

// --- consent gate ----------------------------------------------------------

describe('§2.103 ensureSpellcheckDictionariesApproved', () => {
  function setup(settings: Record<string, unknown> = {}, available?: string[]) {
    const sess = fakeSession(available)
    mocks.defaultSession = sess
    initSpellcheck(deps({}, settings))
    return sess
  }

  it('asks nothing when no language was requested', async () => {
    setup()
    const verdict = await ensureSpellcheckDictionariesApproved(undefined)
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(verdict).toMatchObject({ approved: [], declined: [] })
  })

  it('asks nothing when every requested language is already granted', async () => {
    setup({ spellcheckDictionaryConsent: { granted: ['ru-RU'], at: 'now' } })
    const verdict = await ensureSpellcheckDictionariesApproved(['ru-RU'])
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(verdict.approved).toEqual([])
  })

  it('approves only what the human accepted', async () => {
    setup()
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    const verdict = await ensureSpellcheckDictionariesApproved(['ru-RU'])
    expect(verdict).toMatchObject({ approved: ['ru-RU'], declined: [] })
  })

  it('treats Cancel, Esc and a destroyed parent (response −1) as a refusal', async () => {
    setup()
    for (const response of [0, -1]) {
      mocks.showMessageBox.mockResolvedValue({ response })
      const verdict = await ensureSpellcheckDictionariesApproved(['ru-RU'])
      expect(verdict).toMatchObject({ approved: [], declined: ['ru-RU'] })
    }
  })

  it('treats a dialog that throws as a refusal', async () => {
    setup()
    mocks.showMessageBox.mockRejectedValue(new Error('no display'))
    const verdict = await ensureSpellcheckDictionariesApproved(['ru-RU'])
    expect(verdict).toMatchObject({ approved: [], declined: ['ru-RU'] })
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      'spellcheck.dictionary_consent', { outcome: 'failed', language_count: 1 },
    )
  })

  it('refuses a second request while a dialog is open instead of queueing it', async () => {
    setup()
    let release: (v: { response: number }) => void = () => {}
    mocks.showMessageBox.mockReturnValueOnce(new Promise<{ response: number }>(r => { release = r }))
    const first = ensureSpellcheckDictionariesApproved(['ru-RU'])
    const second = await ensureSpellcheckDictionariesApproved(['de-DE'])
    expect(second).toMatchObject({ approved: [], declined: ['de-DE'] })
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      'spellcheck.dictionary_consent', { outcome: 'blocked_busy', language_count: 1 },
    )
    release({ response: 1 })
    expect((await first).approved).toEqual(['ru-RU'])
  })

  it('drops a language the platform does not offer before asking about it', async () => {
    setup({}, ['en-US'])
    const verdict = await ensureSpellcheckDictionariesApproved(['kl-GL'])
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(verdict.approved).toEqual([])
  })

  it('never puts a language code in telemetry', async () => {
    setup()
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    await ensureSpellcheckDictionariesApproved(['ru-RU'])
    const consent = mocks.recordEvent.mock.calls.filter(c => c[0] === 'spellcheck.dictionary_consent')
    expect(consent).toHaveLength(1)
    expect(JSON.stringify(consent)).not.toContain('ru-RU')
  })

  it('auto-accepts under the harness, and only on an unpackaged build', async () => {
    setup()
    process.env.MAILCOPILOT_E2E = '1'
    expect((await ensureSpellcheckDictionariesApproved(['ru-RU'])).approved).toEqual(['ru-RU'])
    expect(mocks.showMessageBox).not.toHaveBeenCalled()

    // A shipped build ignores the environment variable — anything running as
    // the user can set it, so it must buy nothing there.
    mocks.isPackaged = true
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    expect((await ensureSpellcheckDictionariesApproved(['de-DE'])).declined).toEqual(['de-DE'])
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
  })
})

// --- two settings:save requests racing on the consent gate (codex Medium finding) ---

/**
 * `main.ts` cannot be imported (module-level side effects — see the header of
 * electron/main.spellcheckWiring.test.ts), so this does not reproduce its
 * `settings:save` handler's own control flow. What it DOES reproduce, with the
 * real production functions and no restatement of their logic, is the
 * SEQUENCE the handler documents for itself: fold each request's verdict via
 * `applySpellcheckDecision` against a settings object read AFTER that
 * request's own gate call resolved (`current = getSettings()`, re-read
 * unconditionally — see the comment on that line in main.ts).
 *
 * The property under test is `applySpellcheckDecision`'s own contract
 * (grant list is a UNION, a refusal writes nothing) holding up under that
 * specific two-write sequence — not a claim about main.ts's IPC plumbing.
 */
describe('§2.103 a busy-refused save does not corrupt a concurrent grant (codex Medium finding)', () => {
  it('the request that loses the single-flight gate persists nothing, and does not erase the one that won it', async () => {
    let store: Record<string, unknown> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getSettings = () => store as any
    const saveSettings = (next: Record<string, unknown>) => { store = { ...next } }
    const sess = fakeSession(['ru-RU', 'de-DE'])
    mocks.defaultSession = sess
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initSpellcheck(deps({ getSettings, saveSettings: saveSettings as any }, {}))

    // First save (ru-RU) opens the dialog and holds it open.
    let release: (v: { response: number }) => void = () => {}
    mocks.showMessageBox.mockReturnValueOnce(new Promise(r => { release = r }))
    const firstVerdict = ensureSpellcheckDictionariesApproved(['ru-RU'])

    // Second save (de-DE) arrives while the first dialog is open. The
    // single-flight gate refuses it for busy — proven already above; here it
    // matters that its OWN save-fold, run immediately, writes nothing.
    const secondVerdict = await ensureSpellcheckDictionariesApproved(['de-DE'])
    expect(secondVerdict.declined).toEqual(['de-DE'])
    const secondDecision = applySpellcheckDecision({
      requested: ['de-DE'],
      approvedNow: secondVerdict.approved,
      previousConsent: (getSettings() as { spellcheckDictionaryConsent?: { granted: string[]; at: string } })
        .spellcheckDictionaryConsent,
      platformOwned: false,
      now: '2026-08-17T00:00:00.000Z',
    })
    saveSettings({ ...getSettings(), ...secondDecision })
    expect(
      (getSettings() as { spellcheckDictionaryConsent?: unknown }).spellcheckDictionaryConsent,
    ).toBeUndefined()

    // Now the first dialog resolves — accepted — and folds against the
    // settings re-read AFTER the second save already landed.
    release({ response: 1 })
    const first = await firstVerdict
    expect(first.approved).toEqual(['ru-RU'])
    const firstDecision = applySpellcheckDecision({
      requested: ['ru-RU'],
      approvedNow: first.approved,
      previousConsent: (getSettings() as { spellcheckDictionaryConsent?: { granted: string[]; at: string } })
        .spellcheckDictionaryConsent,
      platformOwned: false,
      now: '2026-08-17T00:00:01.000Z',
    })
    saveSettings({ ...getSettings(), ...firstDecision })

    // The winner's grant landed; the busy-refused loser left no trace to fight
    // it over, and did not silently reintroduce de-DE either.
    const finalConsent = (getSettings() as { spellcheckDictionaryConsent?: { granted: string[] } })
      .spellcheckDictionaryConsent
    expect(finalConsent?.granted).toEqual(['ru-RU'])
  })
})
