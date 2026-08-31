/**
 * Native context menu — BACKLOG §2.93(a).
 *
 * The load-bearing assertions here are the NEGATIVE ones: which items must be
 * ABSENT for which URL shapes. Every one of them corresponds to a guard in
 * electron/services/contextMenu.ts, and removing that guard must turn the test
 * red:
 *
 *   - a `javascript:` / `data:` / `cid:` link yields no link items at all
 *     (guard: normalizeExternalUrl's protocol allowlist in resolveLinkTarget);
 *   - the same holds when the disallowed URL is smuggled inside a
 *     `mailcopilot-link://` wrapper, which untrusted mail HTML can plant
 *     directly because rewriteMailHtmlLinks leaves an href it cannot normalise
 *     untouched;
 *   - "open link in browser" is absent on surfaces with no `mail:link`
 *     consumer (guard: canRouteLinks), and when present it routes through the
 *     window's mail:link funnel — never shell.openExternal / a new IPC;
 *   - the copied address is the resolved DESTINATION, not the internal
 *     `mailcopilot-link://` wrapper and not the sender-controlled link text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

const mocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
  writeText: vi.fn(),
  captureException: vi.fn(),
  recordEvent: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  clipboard: { writeText: mocks.writeText },
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: mocks.debug, info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}))
vi.mock('../sentry', () => ({ captureException: mocks.captureException }))
vi.mock('../metrics', () => ({ recordEvent: mocks.recordEvent }))

import {
  buildContextMenuPlan,
  resolveLinkTarget,
  attachContextMenu,
  contextMenuLabels,
  contextMenuContext,
  classifyContextMenuError,
  classifyContextMenuErrorKind,
  reportContextMenuFailure,
  MAX_LINK_ADDRESS_LENGTH,
  MAX_SPELL_SUGGESTIONS,
  MAX_MISSPELLED_WORD_LENGTH,
  type ContextMenuInput,
  type ContextMenuPlanItem,
  type MailLinkPayload,
} from './contextMenu'
// §2.135 cross-slice check: the routed-link `t` truncation lives in
// mailLinkRouter.ts (via parseRoutedMailLink), not in this module.
// resolveLinkTarget must inherit it through decideMailLinkAction rather than
// re-deriving `text` itself — importing the SAME constant the writer/reader
// pair uses is what lets the test below assert the exact number instead of
// an arbitrary "shorter than the input" claim.
import { MAX_ROUTED_LINK_TEXT_LENGTH } from '../mailLinkRouter'

// --- helpers ---------------------------------------------------------------

function params(over: Partial<ContextMenuInput> = {}): ContextMenuInput {
  return {
    linkURL: '',
    selectionText: '',
    isEditable: false,
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
    ...over,
  }
}

/** Build the `mailcopilot-link://` form rewriteMailHtmlLinks produces. */
function routed(href: string, text = ''): string {
  return `mailcopilot-link://open?u=${encodeURIComponent(href)}&t=${encodeURIComponent(text)}`
}

function kinds(plan: ContextMenuPlanItem[]): string[] {
  return plan.map(i => (i.kind === 'role' ? `role:${i.role}` : i.kind))
}

function addressOf(plan: ContextMenuPlanItem[]): string | undefined {
  const item = plan.find(i => i.kind === 'copyLinkAddress')
  return item?.kind === 'copyLinkAddress' ? item.address : undefined
}

function linkOf(plan: ContextMenuPlanItem[]): MailLinkPayload | undefined {
  const item = plan.find(i => i.kind === 'openLink')
  return item?.kind === 'openLink' ? item.link : undefined
}

const ROUTES = { canRouteLinks: true }
const NO_ROUTES = { canRouteLinks: false }

// --- link items: what appears --------------------------------------------

describe('buildContextMenuPlan — link items', () => {
  it('offers open + copy for a routed https link and copies the destination, not the wrapper', () => {
    const plan = buildContextMenuPlan(
      params({ linkURL: routed('https://example.com/path?a=1', 'Example') }),
      ROUTES,
    )
    expect(kinds(plan)).toEqual(['openLink', 'copyLinkAddress'])
    const address = addressOf(plan)
    expect(address).toBe('https://example.com/path?a=1')
    expect(address).not.toContain('mailcopilot-link')
    // The link text is sender-controlled and must never be what we copy.
    expect(address).not.toContain('Example')
  })

  it('forwards the routed link text so the renderer can still run its mismatch check', () => {
    const plan = buildContextMenuPlan(
      params({ linkURL: routed('https://evil.test/', 'paypal.com') }),
      ROUTES,
    )
    expect(linkOf(plan)).toEqual({ href: 'https://evil.test/', text: 'paypal.com' })
    // A routed link is NOT flagged unsafeBypass — identical to the click path.
    expect(linkOf(plan)?.unsafeBypass).toBeUndefined()
  })

  it('marks a raw (un-rewritten) link unsafeBypass so the phishing prompt always fires', () => {
    const plan = buildContextMenuPlan(params({ linkURL: 'https://raw.test/x' }), ROUTES)
    expect(linkOf(plan)).toEqual({ href: 'https://raw.test/x', text: '', unsafeBypass: true })
  })

  it('offers link items for http and mailto', () => {
    expect(kinds(buildContextMenuPlan(params({ linkURL: 'http://plain.test/' }), ROUTES)))
      .toEqual(['openLink', 'copyLinkAddress'])
    const mailtoPlan = buildContextMenuPlan(params({ linkURL: 'mailto:someone@example.com' }), ROUTES)
    expect(kinds(mailtoPlan)).toEqual(['openLink', 'copyLinkAddress'])
    expect(addressOf(mailtoPlan)).toBe('mailto:someone@example.com')
  })
})

// --- link items: what must be ABSENT (the security assertions) -------------

describe('buildContextMenuPlan — disallowed link shapes yield no link items', () => {
  const hostile: Array<[string, string]> = [
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
    ['cid:', 'cid:part1.abcdef@example.com'],
    ['file:', 'file:///etc/passwd'],
    ['blob:', 'blob:https://example.com/9b2f'],
    ['empty', ''],
    ['garbage', 'not a url at all'],
  ]

  for (const [name, url] of hostile) {
    it(`raw ${name} link → no openLink and no copyLinkAddress`, () => {
      const plan = buildContextMenuPlan(params({ linkURL: url }), ROUTES)
      expect(plan).toEqual([])
    })

    if (url) {
      it(`${name} smuggled inside a mailcopilot-link:// wrapper → no link items`, () => {
        // Untrusted mail HTML can plant a routed URL directly: the rewriter
        // leaves an href it cannot normalise untouched, so the `u` payload is
        // NOT trusted just because the wrapper is ours.
        const plan = buildContextMenuPlan(params({ linkURL: routed(url) }), ROUTES)
        expect(plan).toEqual([])
      })
    }
  }

  it('a mailcopilot-link:// wrapper with no `u` parameter yields nothing', () => {
    expect(buildContextMenuPlan(params({ linkURL: 'mailcopilot-link://open' }), ROUTES)).toEqual([])
  })
})

// --- link edge shapes ------------------------------------------------------

describe('buildContextMenuPlan — link edge shapes', () => {
  it('preserves embedded credentials rather than silently copying a different URL', () => {
    const url = 'https://user:pass@evil.test/login'
    const plan = buildContextMenuPlan(params({ linkURL: routed(url) }), ROUTES)
    expect(addressOf(plan)).toBe(url)
    // The click path applies no credential check either — the menu must not
    // diverge from it, in either direction.
    expect(linkOf(plan)?.href).toBe(url)
  })

  it('copies an IDN host in its punycode form — the address the browser resolves', () => {
    const plan = buildContextMenuPlan(params({ linkURL: routed('https://пример.рф/путь') }), ROUTES)
    const address = addressOf(plan)!
    expect(address.startsWith('https://xn--')).toBe(true)
    expect(address).not.toContain('пример')
  })

  it('keeps an already-punycode host as-is', () => {
    const plan = buildContextMenuPlan(params({ linkURL: 'https://xn--e1afmkfd.xn--p1ai/' }), ROUTES)
    expect(addressOf(plan)).toBe('https://xn--e1afmkfd.xn--p1ai/')
  })

  it('copies a long URL in full — never truncated', () => {
    const url = `https://track.test/?q=${'a'.repeat(4000)}`
    const address = addressOf(buildContextMenuPlan(params({ linkURL: routed(url) }), ROUTES))
    expect(address).toBe(url)
    expect(address!.length).toBe(url.length)
  })

  it('omits the link items entirely past the address bound instead of truncating', () => {
    const url = `https://track.test/?q=${'a'.repeat(MAX_LINK_ADDRESS_LENGTH)}`
    expect(buildContextMenuPlan(params({ linkURL: routed(url) }), ROUTES)).toEqual([])
  })

  // Exact-boundary pair for MAX_LINK_ADDRESS_LENGTH: the guard in
  // resolveLinkTarget is `address.length > MAX_LINK_ADDRESS_LENGTH`. The two
  // tests above only ever exercise "well under" (4000) and "well over"
  // (query alone is MAX_LINK_ADDRESS_LENGTH chars, so the full URL is ~8215),
  // so an off-by-one (`>=` instead of `>`) would pass both without being
  // caught. These pin the `>` at the boundary itself.
  it('offers link items for an address of exactly MAX_LINK_ADDRESS_LENGTH characters', () => {
    const prefix = 'https://track.test/?q='
    const url = prefix + 'a'.repeat(MAX_LINK_ADDRESS_LENGTH - prefix.length)
    expect(url.length).toBe(MAX_LINK_ADDRESS_LENGTH) // sanity: exactly at the bound
    const plan = buildContextMenuPlan(params({ linkURL: routed(url) }), ROUTES)
    expect(kinds(plan)).toEqual(['openLink', 'copyLinkAddress'])
    expect(addressOf(plan)).toBe(url)
  })

  it('omits link items for an address one character past MAX_LINK_ADDRESS_LENGTH', () => {
    const prefix = 'https://track.test/?q='
    const url = prefix + 'a'.repeat(MAX_LINK_ADDRESS_LENGTH + 1 - prefix.length)
    expect(url.length).toBe(MAX_LINK_ADDRESS_LENGTH + 1) // sanity: one past the bound
    expect(buildContextMenuPlan(params({ linkURL: routed(url) }), ROUTES)).toEqual([])
  })
})

// --- cross-slice: the §2.135 truncation of routed-link text ----------------

describe('buildContextMenuPlan — inherits the §2.135 routed-link text bound', () => {
  it('forwards an over-long display text already truncated to MAX_ROUTED_LINK_TEXT_LENGTH', () => {
    // resolveLinkTarget must read `text` off decideMailLinkAction's payload
    // (already bounded by parseRoutedMailLink), not re-parse the `t` query
    // param itself — a second, independent read would not inherit the fix.
    const hostile = 'x'.repeat(200_000)
    const plan = buildContextMenuPlan(
      params({ linkURL: routed('https://ok.example/', hostile) }),
      ROUTES,
    )
    const link = linkOf(plan)
    expect(link).toBeDefined()
    expect(link!.text.length).toBe(MAX_ROUTED_LINK_TEXT_LENGTH)
  })
})

// --- surfaces without a mail:link consumer ---------------------------------

describe('buildContextMenuPlan — surfaces that cannot route links', () => {
  it('offers copy address but never open when the window has no mail:link consumer', () => {
    const plan = buildContextMenuPlan(params({ linkURL: 'https://example.com/' }), NO_ROUTES)
    expect(kinds(plan)).toEqual(['copyLinkAddress'])
  })

  it('still refuses a disallowed scheme on such a surface', () => {
    expect(buildContextMenuPlan(params({ linkURL: 'javascript:alert(1)' }), NO_ROUTES)).toEqual([])
  })
})

// --- edit items ------------------------------------------------------------

describe('buildContextMenuPlan — edit items', () => {
  it('offers the full edit set in an editable field, honouring editFlags', () => {
    const plan = buildContextMenuPlan(
      params({
        isEditable: true,
        selectionText: 'abc',
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      }),
      ROUTES,
    )
    expect(kinds(plan)).toEqual(['role:cut', 'role:copy', 'role:paste', 'role:selectAll'])
    expect(plan.every(i => i.kind === 'role' && i.enabled)).toBe(true)
  })

  it('keeps unavailable edit actions visible but disabled (empty field: nothing to cut/copy)', () => {
    const plan = buildContextMenuPlan(
      params({
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
      }),
      ROUTES,
    )
    const enabled = Object.fromEntries(
      plan.flatMap(i => (i.kind === 'role' ? [[i.role, i.enabled]] : [])),
    )
    expect(enabled).toEqual({ cut: false, copy: false, paste: true, selectAll: true })
  })

  it('offers Copy only over a selection in non-editable content', () => {
    const plan = buildContextMenuPlan(
      params({
        selectionText: 'selected words',
        editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
      }),
      ROUTES,
    )
    expect(kinds(plan)).toEqual(['role:copy'])
  })

  it('offers nothing for a whitespace-only selection', () => {
    const plan = buildContextMenuPlan(
      params({
        selectionText: '   \n\t ',
        editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
      }),
      ROUTES,
    )
    expect(plan).toEqual([])
  })

  it('offers nothing when the renderer says the selection cannot be copied', () => {
    const plan = buildContextMenuPlan(
      params({
        selectionText: 'selected words',
        editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
      }),
      ROUTES,
    )
    expect(plan).toEqual([])
  })

  it('produces no menu at all for a plain right click (no link, no selection, not editable)', () => {
    // This is what keeps the native menu from stacking on top of the
    // renderer's own React menus (message row / folder).
    expect(buildContextMenuPlan(params(), ROUTES)).toEqual([])
  })
})

// --- section composition ---------------------------------------------------

describe('buildContextMenuPlan — sections', () => {
  it('separates link items from edit items', () => {
    const plan = buildContextMenuPlan(
      params({
        linkURL: routed('https://example.com/'),
        selectionText: 'text',
        editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
      }),
      ROUTES,
    )
    expect(kinds(plan)).toEqual(['openLink', 'copyLinkAddress', 'separator', 'role:copy'])
  })

  it('never emits a leading or trailing separator', () => {
    for (const plan of [
      buildContextMenuPlan(params({ linkURL: 'https://a.test/' }), ROUTES),
      buildContextMenuPlan(params({ isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }), ROUTES),
    ]) {
      expect(plan[0]?.kind).not.toBe('separator')
      expect(plan[plan.length - 1]?.kind).not.toBe('separator')
    }
  })

  it('classifies the menu context for telemetry without touching content', () => {
    expect(contextMenuContext(buildContextMenuPlan(params({ linkURL: 'https://a.test/' }), ROUTES))).toBe('link')
    expect(contextMenuContext(buildContextMenuPlan(params({ isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }), ROUTES))).toBe('editable')
    expect(contextMenuContext(buildContextMenuPlan(params({ selectionText: 'x', editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: false } }), ROUTES))).toBe('selection')
  })
})

// --- §2.103 spelling items -------------------------------------------------

const EDITABLE_FLAGS = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }

function suggestionsOf(plan: ContextMenuPlanItem[]): string[] {
  return plan.flatMap(i => (i.kind === 'spellSuggestion' ? [i.suggestion] : []))
}

describe('§2.103 buildContextMenuPlan — spelling items', () => {
  it('offers replacements plus "add to dictionary" for a misspelled word in a field', () => {
    const plan = buildContextMenuPlan(params({
      isEditable: true,
      editFlags: EDITABLE_FLAGS,
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello', 'helot'],
    }), ROUTES)
    expect(kinds(plan)).toEqual([
      'spellSuggestion', 'spellSuggestion', 'addToDictionary',
      'separator', 'role:cut', 'role:copy', 'role:paste', 'role:selectAll',
    ])
    expect(suggestionsOf(plan)).toEqual(['hello', 'helot'])
  })

  it('offers "add to dictionary" even when the dictionary suggests nothing', () => {
    // The common case for a name or a term: without this item the red
    // underline is permanent.
    const plan = buildContextMenuPlan(params({
      isEditable: true,
      editFlags: EDITABLE_FLAGS,
      misspelledWord: 'Popovss',
      dictionarySuggestions: [],
    }), ROUTES)
    expect(kinds(plan).filter(k => k.startsWith('spell') || k === 'addToDictionary'))
      .toEqual(['addToDictionary'])
  })

  it('offers NOTHING for a misspelled word in non-editable content', () => {
    // Chromium reports one for a message body too. `replaceMisspelling` cannot
    // write there, and "add to dictionary" would teach the personal dictionary
    // a word out of MAIL someone else wrote.
    const plan = buildContextMenuPlan(params({
      isEditable: false,
      selectionText: 'helo',
      editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: false },
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello'],
    }), ROUTES)
    expect(kinds(plan)).toEqual(['role:copy'])
  })

  it('offers nothing when there is no misspelled word', () => {
    for (const misspelledWord of ['', undefined]) {
      const plan = buildContextMenuPlan(params({
        isEditable: true,
        editFlags: EDITABLE_FLAGS,
        misspelledWord,
        dictionarySuggestions: ['hello'],
      }), ROUTES)
      expect(kinds(plan)).toEqual(['role:cut', 'role:copy', 'role:paste', 'role:selectAll'])
    }
  })

  it('omits the section for an overlong word rather than truncating it', () => {
    // A truncated word is a DIFFERENT word, and replaceMisspelling would then
    // write something the user never chose.
    const plan = buildContextMenuPlan(params({
      isEditable: true,
      editFlags: EDITABLE_FLAGS,
      misspelledWord: 'x'.repeat(MAX_MISSPELLED_WORD_LENGTH + 1),
      dictionarySuggestions: ['x'],
    }), ROUTES)
    expect(kinds(plan)).toEqual(['role:cut', 'role:copy', 'role:paste', 'role:selectAll'])
  })

  it('bounds a mail-derived suggestion list: caps, dedupes and drops unusable entries', () => {
    const plan = buildContextMenuPlan(params({
      isEditable: true,
      editFlags: EDITABLE_FLAGS,
      misspelledWord: 'helo',
      dictionarySuggestions: [
        'hello', 'hello', '  ', 'x'.repeat(MAX_MISSPELLED_WORD_LENGTH + 1),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        42 as any, 'a', 'b', 'c', 'd', 'e', 'f', 'g',
      ],
    }), ROUTES)
    const suggestions = suggestionsOf(plan)
    expect(suggestions).toHaveLength(MAX_SPELL_SUGGESTIONS)
    expect(suggestions[0]).toBe('hello')
    expect(new Set(suggestions).size).toBe(suggestions.length)
  })

  it('places the spelling section between the link and edit sections', () => {
    // §2.93(a) order is unchanged: link items still come first, edit items
    // still come last. Replacements sit where a person right-clicking a
    // red-underlined word will find them.
    const plan = buildContextMenuPlan(params({
      linkURL: routed('https://example.com/'),
      isEditable: true,
      editFlags: EDITABLE_FLAGS,
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello'],
    }), ROUTES)
    expect(kinds(plan)).toEqual([
      'openLink', 'copyLinkAddress',
      'separator', 'spellSuggestion', 'addToDictionary',
      'separator', 'role:cut', 'role:copy', 'role:paste', 'role:selectAll',
    ])
  })
})

// --- resolveLinkTarget directly -------------------------------------------

describe('resolveLinkTarget', () => {
  it('returns null for everything outside the http/https/mailto allowlist', () => {
    for (const url of ['javascript:alert(1)', 'data:text/plain,x', 'cid:abc', 'ftp://f.test/', '']) {
      expect(resolveLinkTarget(url)).toBeNull()
    }
  })

  it('de-references the routed wrapper', () => {
    expect(resolveLinkTarget(routed('https://a.test/x', 'A'))).toEqual({
      link: { href: 'https://a.test/x', text: 'A' },
      address: 'https://a.test/x',
    })
  })
})

// --- labels ----------------------------------------------------------------

/**
 * The locale files are read FROM DISK here, and the language list is the
 * directory listing rather than a literal.
 *
 * Both choices are the point of the assertion. main used to hold a second,
 * hand-written copy of these labels, and the failure mode was not a wrong
 * string — it was two sources drifting with nothing to notice. A test that
 * compared the module against a literal (or against its own import of the same
 * table) stays green through exactly that drift. Walking the directory adds
 * the other half: a SEVENTH locale file gets its `contextMenu.*` block from
 * the i18n merge gate, but only this test notices that the main-process
 * dictionary was never told the language exists.
 */
const LOCALE_DIR = fileURLToPath(new URL('../../src/i18n/locales', import.meta.url))
const SHIPPED_LOCALES = readdirSync(LOCALE_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.slice(0, -'.json'.length))
  .sort()

function localeFromDisk(lang: string): { contextMenu?: Record<string, string> } {
  return JSON.parse(readFileSync(join(LOCALE_DIR, `${lang}.json`), 'utf8')) as {
    contextMenu?: Record<string, string>
  }
}

describe('contextMenuLabels', () => {
  it('serves every locale that ships in src/i18n/locales, straight from that file', () => {
    expect(SHIPPED_LOCALES.length).toBeGreaterThanOrEqual(6)
    expect(SHIPPED_LOCALES).toContain('en')
    for (const lang of SHIPPED_LOCALES) {
      const onDisk = localeFromDisk(lang).contextMenu
      expect(onDisk, `${lang}.json is missing the contextMenu block`).toBeTruthy()
      // Equality, not "has values": a menu label that differs from the locale
      // file is the drift this test exists to catch, in either direction.
      expect(contextMenuLabels(lang), `${lang} menu labels`).toEqual(onDisk)
    }
  })

  it('covers the full key set in every shipped locale', () => {
    for (const lang of SHIPPED_LOCALES) {
      const labels = contextMenuLabels(lang)
      for (const key of ['openLink', 'copyLinkAddress', 'cut', 'copy', 'paste', 'selectAll', 'addToDictionary'] as const) {
        expect(labels[key], `${lang}.${key}`).toBeTruthy()
      }
    }
  })

  it('falls back to English for an unknown language and never returns an English label for a translated one', () => {
    expect(contextMenuLabels('xx')).toEqual(contextMenuLabels('en'))
    expect(contextMenuLabels('ru').copyLinkAddress).not.toBe(contextMenuLabels('en').copyLinkAddress)
  })
})

// --- attachment / wiring ---------------------------------------------------

interface FakeWindow {
  webContents: { on: (event: string, cb: (e: unknown, p: unknown) => void) => void }
  isDestroyed: () => boolean
}

function makeWindow(destroyed = false): { win: BrowserWindow; fire: (p: unknown) => void } {
  let handler: ((e: unknown, p: unknown) => void) | null = null
  const fake: FakeWindow = {
    webContents: {
      on: (event, cb) => { if (event === 'context-menu') handler = cb },
    },
    isDestroyed: () => destroyed,
  }
  return {
    win: fake as unknown as BrowserWindow,
    fire: (p: unknown) => handler?.({}, p),
  }
}

interface FakeSpellingWindow extends FakeWindow {
  webContents: FakeWindow['webContents'] & {
    replaceMisspelling: (text: string) => void
    session: { addWordToSpellCheckerDictionary: (word: string) => void }
  }
}

/**
 * Same shape as {@link makeWindow}, plus the two native spellchecker methods
 * `attachContextMenu`'s own default closures bind to when the caller injects
 * neither `replaceMisspelling` nor `addToDictionary` — see the two §2.103
 * tests below.
 */
function makeSpellingWindow(destroyed = false): {
  win: BrowserWindow
  fire: (p: unknown) => void
  replaceMisspelling: ReturnType<typeof vi.fn>
  addWordToSpellCheckerDictionary: ReturnType<typeof vi.fn>
} {
  let handler: ((e: unknown, p: unknown) => void) | null = null
  const replaceMisspelling = vi.fn()
  const addWordToSpellCheckerDictionary = vi.fn()
  const fake: FakeSpellingWindow = {
    webContents: {
      on: (event, cb) => { if (event === 'context-menu') handler = cb },
      replaceMisspelling,
      session: { addWordToSpellCheckerDictionary },
    },
    isDestroyed: () => destroyed,
  }
  return {
    win: fake as unknown as BrowserWindow,
    fire: (p: unknown) => handler?.({}, p),
    replaceMisspelling,
    addWordToSpellCheckerDictionary,
  }
}

function lastTemplate(): MenuItemConstructorOptions[] {
  const calls = mocks.buildFromTemplate.mock.calls
  const call = calls[calls.length - 1]
  return (call?.[0] ?? []) as MenuItemConstructorOptions[]
}

describe('attachContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildFromTemplate.mockImplementation(() => ({ popup: mocks.popup }))
  })

  const menuParams = (over: Partial<ContextMenuInput> & { menuSourceType?: string; x?: number; y?: number } = {}) => ({
    ...params(over),
    menuSourceType: over.menuSourceType ?? 'mouse',
    x: over.x ?? 10,
    y: over.y ?? 20,
  })

  it('pops a menu for a link and labels it in the current language', () => {
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'ru', emitMailLink: vi.fn() })
    fire(menuParams({ linkURL: routed('https://a.test/x') }))
    expect(mocks.popup).toHaveBeenCalledWith({ window: win })
    expect(lastTemplate().map(i => i.label)).toEqual([
      contextMenuLabels('ru').openLink,
      contextMenuLabels('ru').copyLinkAddress,
    ])
  })

  it('routes "open link" through the window mail:link funnel and touches nothing else', () => {
    const emitMailLink = vi.fn()
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink })
    fire(menuParams({ linkURL: routed('https://a.test/x', 'A') }))

    const open = lastTemplate()[0]
    open.click?.(undefined as never, undefined, undefined as never)
    expect(emitMailLink).toHaveBeenCalledWith({ href: 'https://a.test/x', text: 'A' })
    // No second route to the browser and no clipboard side effect.
    expect(mocks.writeText).not.toHaveBeenCalled()
    expect(mocks.recordEvent).toHaveBeenCalledWith('ui.context_menu_link_action', { action: 'open' })
  })

  it('writes the resolved destination to the clipboard for "copy link address"', () => {
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    fire(menuParams({ linkURL: routed('https://a.test/x?q=1', 'A') }))

    const copy = lastTemplate()[1]
    copy.click?.(undefined as never, undefined, undefined as never)
    expect(mocks.writeText).toHaveBeenCalledWith('https://a.test/x?q=1')
    expect(mocks.recordEvent).toHaveBeenCalledWith('ui.context_menu_link_action', { action: 'copy_address' })
  })

  it('maps edit items onto Electron roles with their enabled state', () => {
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    fire(menuParams({
      isEditable: true,
      editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
    }))
    expect(lastTemplate().map(i => ({ role: i.role, enabled: i.enabled }))).toEqual([
      { role: 'cut', enabled: false },
      { role: 'copy', enabled: false },
      { role: 'paste', enabled: true },
      { role: 'selectAll', enabled: true },
    ])
  })

  it('§2.103 applies a replacement through replaceMisspelling, never by its own text surgery', () => {
    const replaceMisspelling = vi.fn()
    const addToDictionary = vi.fn()
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', replaceMisspelling, addToDictionary })
    fire(menuParams({
      isEditable: true,
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello'],
    }))

    const template = lastTemplate()
    // The suggestion is its own label; "add to dictionary" is translated.
    expect(template[0].label).toBe('hello')
    expect(template[1].label).toBe(contextMenuLabels('en').addToDictionary)

    template[0].click?.(undefined as never, undefined, undefined as never)
    expect(replaceMisspelling).toHaveBeenCalledWith('hello')
    expect(mocks.writeText).not.toHaveBeenCalled()
    expect(addToDictionary).not.toHaveBeenCalled()

    template[1].click?.(undefined as never, undefined, undefined as never)
    expect(addToDictionary).toHaveBeenCalledWith('helo')
  })

  // The two tests above only prove attachContextMenu FORWARDS to whatever it is
  // given — every call site in this repo (main.ts wiring, both other tests
  // above) injects `replaceMisspelling`/`addToDictionary` explicitly, so the
  // PRODUCTION defaults inside attachContextMenu itself (`win.webContents
  // .replaceMisspelling` / `win.webContents.session.addWordToSpellCheckerDictionary`)
  // had never been exercised by any test. Left unchecked, a typo in either
  // default closure (wrong method name, wrong target) would compile, every
  // other §2.103 test would stay green, and the menu item would silently do
  // nothing in the shipped app.
  it('§2.103 defaults to webContents.replaceMisspelling / session.addWordToSpellCheckerDictionary when not injected', () => {
    const { win, fire, replaceMisspelling, addWordToSpellCheckerDictionary } = makeSpellingWindow()
    attachContextMenu(win, { getLanguage: () => 'en' })
    fire(menuParams({
      isEditable: true,
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello'],
    }))

    const template = lastTemplate()
    template[0].click?.(undefined as never, undefined, undefined as never)
    expect(replaceMisspelling).toHaveBeenCalledWith('hello')
    expect(addWordToSpellCheckerDictionary).not.toHaveBeenCalled()

    template[1].click?.(undefined as never, undefined, undefined as never)
    expect(addWordToSpellCheckerDictionary).toHaveBeenCalledWith('helo')
  })

  it('§2.103 default replaceMisspelling is a no-op on a window destroyed before the click fires', () => {
    let destroyed = false
    const { win, fire, replaceMisspelling } = makeSpellingWindow(false)
    // `isDestroyed` is read live in the fake above via a closure, so flip the
    // outer flag rather than rebuilding the window.
    ;(win as unknown as { isDestroyed: () => boolean }).isDestroyed = () => destroyed
    attachContextMenu(win, { getLanguage: () => 'en' })
    fire(menuParams({
      isEditable: true,
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello'],
    }))
    const template = lastTemplate()
    destroyed = true
    expect(() => template[0].click?.(undefined as never, undefined, undefined as never)).not.toThrow()
    expect(replaceMisspelling).not.toHaveBeenCalled()
  })

  // Same coverage gap the test above closed for replaceMisspelling, for the
  // OTHER default closure (codex low finding): `attachContextMenu`'s own
  // `addToDictionary` default also guards on `win.isDestroyed()`
  // (`electron/services/contextMenu.ts`, "no-op on a destroyed window" is not
  // free for the second closure just because it held for the first).
  it('§2.103 default addToDictionary is a no-op on a window destroyed before the click fires', () => {
    let destroyed = false
    const { win, fire, addWordToSpellCheckerDictionary } = makeSpellingWindow(false)
    ;(win as unknown as { isDestroyed: () => boolean }).isDestroyed = () => destroyed
    attachContextMenu(win, { getLanguage: () => 'en' })
    fire(menuParams({
      isEditable: true,
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello'],
    }))
    const template = lastTemplate()
    destroyed = true
    expect(() => template[1].click?.(undefined as never, undefined, undefined as never)).not.toThrow()
    expect(addWordToSpellCheckerDictionary).not.toHaveBeenCalled()
  })

  it('§2.103 never emits the word or the replacement in telemetry', () => {
    const { win, fire } = makeWindow()
    attachContextMenu(win, {
      getLanguage: () => 'en',
      replaceMisspelling: vi.fn(),
      addToDictionary: vi.fn(),
    })
    fire(menuParams({
      isEditable: true,
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      misspelledWord: 'sekrit',
      dictionarySuggestions: ['secret'],
    }))
    const template = lastTemplate()
    template[0].click?.(undefined as never, undefined, undefined as never)
    template[1].click?.(undefined as never, undefined, undefined as never)

    expect(mocks.recordEvent).toHaveBeenCalledWith('ui.context_menu_spell_action', { action: 'replace' })
    expect(mocks.recordEvent).toHaveBeenCalledWith('ui.context_menu_spell_action', { action: 'add_to_dictionary' })
    // In a reply the misspelled word is quoted mail; the user's own typing is
    // no more sendable than that.
    const emitted = JSON.stringify(mocks.recordEvent.mock.calls)
    expect(emitted).not.toContain('sekrit')
    expect(emitted).not.toContain('secret')
  })

  it('does not offer "open link" when the surface has no mail:link consumer', () => {
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en' })
    fire(menuParams({ linkURL: 'https://a.test/' }))
    expect(lastTemplate().map(i => i.label)).toEqual([contextMenuLabels('en').copyLinkAddress])
  })

  it('pops nothing when the plan is empty', () => {
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    fire(menuParams({ linkURL: 'javascript:alert(1)' }))
    expect(mocks.buildFromTemplate).not.toHaveBeenCalled()
    expect(mocks.popup).not.toHaveBeenCalled()
    expect(mocks.recordEvent).not.toHaveBeenCalled()
  })

  it('does not pop a menu on a destroyed window', () => {
    const { win, fire } = makeWindow(true)
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    fire(menuParams({ linkURL: 'https://a.test/' }))
    expect(mocks.popup).not.toHaveBeenCalled()
  })

  it('positions a keyboard-invoked menu at the reported coordinates', () => {
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    fire(menuParams({ linkURL: 'https://a.test/', menuSourceType: 'keyboard', x: 42, y: 84 }))
    expect(mocks.popup).toHaveBeenCalledWith({ window: win, x: 42, y: 84 })
  })

  it('records the shown event with a structural context tag only', () => {
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    fire(menuParams({ linkURL: routed('https://secret.test/token/abcdef') }))
    expect(mocks.recordEvent).toHaveBeenCalledWith('ui.context_menu_shown', { context: 'link' })
    const payloads = JSON.stringify(mocks.recordEvent.mock.calls)
    expect(payloads).not.toContain('secret.test')
  })

  it('survives a telemetry failure without losing the menu', () => {
    mocks.recordEvent.mockImplementation(() => { throw new Error('sink down') })
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    expect(() => fire(menuParams({ linkURL: 'https://a.test/' }))).not.toThrow()
    expect(mocks.popup).toHaveBeenCalled()
  })
})

// --- the failure telemetry boundary ---------------------------------------

/**
 * These are the load-bearing NEGATIVE assertions for the file's other half.
 *
 * Every failure this handler can catch carries text written by whoever threw:
 * the settings store behind `getLanguage` reports an `EACCES` with a filesystem
 * path in it, and a rejected menu template can quote what it was handed — which
 * on this handler is mail-supplied. So each case below throws a DISTINCTIVE
 * SENTINEL and asserts the two halves of the boundary at once: the sentinel is
 * absent from everything Sentry receives, and present in the local log, which
 * never leaves the machine and is where a real diagnosis has to start.
 *
 * Asserting only "message does not contain it" would miss the ways an exception
 * actually carries text — `cause`, `stack`, extra own properties — so
 * {@link capturedSurface} scans all of them.
 */
describe('attachContextMenu — failure telemetry never transmits the thrown value', () => {
  /** Distinctive enough that a substring match cannot collide by accident. */
  const SENTINEL = 'zq7x-sentinel-/home/user/.config/mailcopilot/settings.json'

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildFromTemplate.mockImplementation(() => ({ popup: mocks.popup }))
  })

  const menuParams = (over: Partial<ContextMenuInput> & { menuSourceType?: string } = {}) => ({
    ...params(over),
    menuSourceType: over.menuSourceType ?? 'mouse',
    x: 10,
    y: 20,
  })

  function lastCapture(): [Error & { cause?: unknown }, Record<string, unknown>] {
    const calls = mocks.captureException.mock.calls
    const call = calls[calls.length - 1]
    expect(call, 'captureException was not called').toBeDefined()
    return call as [Error & { cause?: unknown }, Record<string, unknown>]
  }

  /**
   * Everything a Sentry transport could serialise out of the capture.
   *
   * `String(err)` is in here on purpose: a captured value need not be an Error
   * (a bare `throw 'text'` is legal), and reading `.name` / `.message` off a
   * string yields `undefined` — so without it this scan would report "clean"
   * for the one shape that leaks whole.
   */
  function capturedSurface(): string {
    const [err, context] = lastCapture()
    const own = err === null || err === undefined
      ? []
      : Object.getOwnPropertyNames(err).map(k => (err as unknown as Record<string, unknown>)[k])
    return [
      String(err),
      err?.name,
      err?.message,
      err?.stack ?? '',
      String(err?.cause ?? ''),
      JSON.stringify(own),
      JSON.stringify(context),
    ].join(' | ')
  }

  /** The capture must be the module's OWN Error, not the thrown value passed
   *  through — checked separately because a non-Error throw has no fields for
   *  {@link capturedSurface} to find. */
  function expectSyntheticCapture(message: string): void {
    const [err] = lastCapture()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ContextMenuFailure')
    expect(err.message).toBe(message)
  }

  function loggedRaw(): string {
    return mocks.debug.mock.calls.flat().map(a => String(a)).join(' ')
  }

  /**
   * The four steps of menu construction, each forced to throw the sentinel, and
   * the phase each must be reported under. `plan` is reached through a throwing
   * property getter because the plan builder is pure — the point is that a
   * throw from ANY step lands in the same boundary, not that this particular
   * shape occurs in the wild.
   */
  const steps: Array<{
    phase: string
    fireIt: (fire: (p: unknown) => void, err: Error) => void
    deps?: (err: Error) => Partial<{ getLanguage: () => string }>
  }> = [
    {
      phase: 'plan',
      fireIt: (fire, err) => {
        const hostile = menuParams({ linkURL: 'https://a.test/' }) as Record<string, unknown>
        Object.defineProperty(hostile, 'linkURL', { get() { throw err } })
        fire(hostile)
      },
    },
    {
      phase: 'labels',
      deps: err => ({ getLanguage: () => { throw err } }),
      fireIt: fire => fire(menuParams({ linkURL: 'https://a.test/' })),
    },
    {
      phase: 'build',
      fireIt: (fire, err) => {
        mocks.buildFromTemplate.mockImplementation(() => { throw err })
        fire(menuParams({ linkURL: 'https://a.test/' }))
      },
    },
    {
      phase: 'popup',
      fireIt: (fire, err) => {
        mocks.popup.mockImplementation(() => { throw err })
        fire(menuParams({ linkURL: 'https://a.test/' }))
      },
    },
  ]

  for (const step of steps) {
    it(`a failing "${step.phase}" step reports the phase and no substring of the thrown message`, () => {
      const thrown = Object.assign(new Error(SENTINEL), { code: 'EACCES' })
      const { win, fire } = makeWindow()
      attachContextMenu(win, {
        getLanguage: () => 'en',
        emitMailLink: vi.fn(),
        ...step.deps?.(thrown),
      })

      // Never throws into Electron's event dispatch.
      expect(() => step.fireIt(fire, thrown)).not.toThrow()

      // What Sentry gets: synthetic, built from literals in the module.
      const [err, context] = lastCapture()
      expect(err).not.toBe(thrown)
      expect(err.name).toBe('ContextMenuFailure')
      expect(err.message).toBe(`context_menu_${step.phase}_permission`)
      expect(err.cause).toBeUndefined()
      expect(context).toEqual({
        source: 'contextMenu',
        phase: step.phase,
        error_class: 'permission',
        error_kind: 'Error',
      })
      expect(capturedSurface()).not.toContain(SENTINEL)
      // Not just the whole sentinel — no fragment of the thrown text either.
      expect(capturedSurface()).not.toContain('/home/user')
      expect(capturedSurface()).not.toContain('settings.json')

      // What the local log gets: the raw error, deliberately kept.
      expect(loggedRaw()).toContain(SENTINEL)
      // The persisted warn line stays aggregate-only.
      const warned = JSON.stringify(mocks.warn.mock.calls)
      expect(warned).not.toContain(SENTINEL)
      expect(mocks.warn).toHaveBeenCalledWith(
        'context menu failed',
        { phase: step.phase, errorClass: 'permission' },
      )
    })
  }

  /**
   * §2.103 (security review, Low): the two spelling items are the only entries
   * whose click callback calls out of this file, and a click callback is
   * dispatched by Electron LATER — outside the `context-menu` try/catch that
   * covers the four construction steps above. Left unwrapped, a throw from
   * either one escapes into Electron's event dispatch, is collected by the
   * global `uncaughtException` handler in main.ts and transmitted RAW.
   *
   * That is not merely an unhandled error: `addToDictionary` is called with
   * `params.misspelledWord`, i.e. text from the message body (on a reply, the
   * sender's prose), and a native call that rejects its argument may well quote
   * it. So this asserts the same property as the construction steps — synthetic
   * capture, word absent from everything Sentry could serialise, raw error kept
   * in the local log — under the new `action` phase.
   */
  const MISSPELLED = 'zq7x-confidential-word-from-the-message'

  it('an "addToDictionary" click that throws reports the word to nobody', () => {
    const thrown = Object.assign(
      // The shape being defended against: the native call quotes its argument.
      new Error(`cannot add "${MISSPELLED}" to the dictionary`),
      { code: 'EACCES' },
    )
    const { win, fire } = makeWindow()
    attachContextMenu(win, {
      getLanguage: () => 'en',
      replaceMisspelling: vi.fn(),
      addToDictionary: () => { throw thrown },
    })
    fire(menuParams({
      isEditable: true,
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      misspelledWord: MISSPELLED,
      dictionarySuggestions: ['hello'],
    }))

    // Nothing escapes into Electron's dispatch, so nothing reaches the global
    // uncaughtException handler.
    const template = lastTemplate()
    expect(() => template[1].click?.(undefined as never, undefined, undefined as never))
      .not.toThrow()

    const [err, context] = lastCapture()
    expect(err).not.toBe(thrown)
    expect(err.message).toBe('context_menu_action_permission')
    expect(context).toEqual({
      source: 'contextMenu',
      phase: 'action',
      error_class: 'permission',
      error_kind: 'Error',
    })
    // The whole point: the message word is in the thrown text and in no part of
    // what a Sentry transport could serialise.
    expect(capturedSurface()).not.toContain(MISSPELLED)
    expect(capturedSurface()).not.toContain('confidential')
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(MISSPELLED)
    // Kept where a real diagnosis starts, and nowhere else.
    expect(loggedRaw()).toContain(MISSPELLED)
  })

  it('a "spellSuggestion" click that throws goes through the same boundary', () => {
    const { win, fire } = makeWindow()
    attachContextMenu(win, {
      getLanguage: () => 'en',
      replaceMisspelling: () => { throw new Error(SENTINEL) },
      addToDictionary: vi.fn(),
    })
    fire(menuParams({
      isEditable: true,
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      misspelledWord: MISSPELLED,
      dictionarySuggestions: ['hello'],
    }))

    const template = lastTemplate()
    expect(() => template[0].click?.(undefined as never, undefined, undefined as never))
      .not.toThrow()
    expectSyntheticCapture('context_menu_action_unknown')
    expect(capturedSurface()).not.toContain(SENTINEL)
  })

  it('keeps the mail-supplied URL and selection out of the report entirely', () => {
    mocks.buildFromTemplate.mockImplementation(() => { throw new Error('boom') })
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    fire(menuParams({
      linkURL: routed('https://secret.test/token/abcdef'),
      selectionText: 'confidential selection',
    }))
    expectSyntheticCapture('context_menu_build_unknown')
    const surface = capturedSurface()
    expect(surface).not.toContain('secret.test')
    expect(surface).not.toContain('confidential')
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('secret.test')
  })

  it('degrades an unrecognised failure to the `unknown` class rather than describing it', () => {
    // No `code` at all — the common shape for an Electron-internal throw.
    mocks.buildFromTemplate.mockImplementation(() => { throw new TypeError(SENTINEL) })
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    expect(() => fire(menuParams({ linkURL: 'https://a.test/' }))).not.toThrow()

    const [err, context] = lastCapture()
    expect(err.message).toBe('context_menu_build_unknown')
    expect(context).toEqual({
      source: 'contextMenu',
      phase: 'build',
      error_class: 'unknown',
      error_kind: 'TypeError',
    })
    expect(capturedSurface()).not.toContain(SENTINEL)
  })

  it('degrades a code it does not know, instead of forwarding the string', () => {
    // A code invented by a third-party component is exactly the value that must
    // NOT travel: it is outside the allowlist, so it becomes `unknown`.
    mocks.buildFromTemplate.mockImplementation(() => {
      throw Object.assign(new Error('x'), { code: `E_${SENTINEL}` })
    })
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    fire(menuParams({ linkURL: 'https://a.test/' }))

    expect(lastCapture()[1].error_class).toBe('unknown')
    expect(capturedSurface()).not.toContain(SENTINEL)
  })

  it('reports a non-Error throw without stringifying it', () => {
    mocks.buildFromTemplate.mockImplementation(() => { throw SENTINEL })
    const { win, fire } = makeWindow()
    attachContextMenu(win, { getLanguage: () => 'en', emitMailLink: vi.fn() })
    expect(() => fire(menuParams({ linkURL: 'https://a.test/' }))).not.toThrow()

    expectSyntheticCapture('context_menu_build_unknown')
    expect(lastCapture()[1]).toEqual({
      source: 'contextMenu',
      phase: 'build',
      error_class: 'unknown',
      error_kind: 'UnknownError',
    })
    expect(capturedSurface()).not.toContain(SENTINEL)
    // The raw string is still the log's, and only the log's.
    expect(loggedRaw()).toContain(SENTINEL)
  })

  it('never throws even when the Sentry sink itself fails', () => {
    mocks.captureException.mockImplementation(() => { throw new Error('sentry down') })
    expect(() => reportContextMenuFailure('popup', new Error(SENTINEL))).not.toThrow()
  })

  it('never throws when the local log sink fails, and still reports', () => {
    mocks.warn.mockImplementation(() => { throw new Error('log down') })
    expect(() => reportContextMenuFailure('labels', new Error(SENTINEL))).not.toThrow()
    expect(capturedSurface()).not.toContain(SENTINEL)
  })
})

describe('classifyContextMenuError', () => {
  it('maps the allowlisted codes onto the closed class set', () => {
    const cases: Array<[string, string]> = [
      ['EACCES', 'permission'],
      ['EPERM', 'permission'],
      ['EROFS', 'permission'],
      ['ENOENT', 'not_found'],
      ['ENOTDIR', 'not_found'],
      ['EIO', 'io'],
      ['EBUSY', 'io'],
      ['EISDIR', 'io'],
      ['ENOSPC', 'io'],
      ['EMFILE', 'io'],
      ['ENFILE', 'io'],
      ['EAGAIN', 'io'],
      ['ERR_INVALID_ARG_TYPE', 'invalid_argument'],
      ['ERR_INVALID_ARG_VALUE', 'invalid_argument'],
      ['ERR_OUT_OF_RANGE', 'invalid_argument'],
    ]
    for (const [code, expected] of cases) {
      expect(classifyContextMenuError(Object.assign(new Error('x'), { code })), code).toBe(expected)
    }
  })

  it('matches case-insensitively so a lowercased code is still classified', () => {
    expect(classifyContextMenuError(Object.assign(new Error('x'), { code: 'eacces' }))).toBe('permission')
  })

  it('degrades everything else to `unknown`', () => {
    // The direction of failure must be "less information", never "leak" — so
    // each of these returns a literal rather than anything derived from input.
    expect(classifyContextMenuError(new Error('EACCES: permission denied, open /home/u/x'))).toBe('unknown')
    expect(classifyContextMenuError(Object.assign(new Error('x'), { code: 'EWHATEVER' }))).toBe('unknown')
    expect(classifyContextMenuError(Object.assign(new Error('x'), { code: 42 }))).toBe('unknown')
    expect(classifyContextMenuError('a bare string')).toBe('unknown')
    expect(classifyContextMenuError(null)).toBe('unknown')
    expect(classifyContextMenuError(undefined)).toBe('unknown')
    expect(classifyContextMenuError({})).toBe('unknown')
  })

  it('does not treat an inherited property as a code', () => {
    // hasOwnProperty guard: `toString` is on the map's prototype, not the map.
    expect(classifyContextMenuError(Object.assign(new Error('x'), { code: 'toString' }))).toBe('unknown')
    expect(classifyContextMenuError(Object.assign(new Error('x'), { code: 'constructor' }))).toBe('unknown')
  })
})

describe('classifyContextMenuErrorKind', () => {
  it('classifies by prototype chain, never by the assignable `name`', () => {
    expect(classifyContextMenuErrorKind(new TypeError('x'))).toBe('TypeError')
    expect(classifyContextMenuErrorKind(new RangeError('x'))).toBe('RangeError')
    expect(classifyContextMenuErrorKind(new SyntaxError('x'))).toBe('SyntaxError')
    expect(classifyContextMenuErrorKind(new ReferenceError('x'))).toBe('ReferenceError')
    expect(classifyContextMenuErrorKind(new Error('x'))).toBe('Error')
    expect(classifyContextMenuErrorKind('string')).toBe('UnknownError')
    expect(classifyContextMenuErrorKind(null)).toBe('UnknownError')

    // An arbitrary throw can set `name` to anything, including PII — the kind
    // must come from the class, so this stays `Error`.
    const spoofed = Object.assign(new Error('x'), { name: 'ivan@example.com' })
    expect(classifyContextMenuErrorKind(spoofed)).toBe('Error')
  })
})
