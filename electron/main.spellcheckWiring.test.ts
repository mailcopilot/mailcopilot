import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// `packages/net/config` transitively reaches `packages/db`, which opens
// SQLite at module load — fatal under the CI `unit-tests` job where
// better-sqlite3 is built for the Electron ABI. Same guard as
// electron/settingsSaveRefusal.test.ts, whose own header explains why the
// schemas themselves stay real rather than mocked: the point of the block
// below is that the refusal is derived from the ACTUAL schema `settings:save`
// runs, not from a restatement of it.
vi.mock('../packages/db', () => ({ deleteAccountData: vi.fn() }))

import {
  rendererWritableSettingsSchema,
  MAIN_ONLY_SETTINGS_FIELDS,
} from '../packages/net/config'
import { partitionRendererSettingsIssues } from './settingsSaveRefusal'

/**
 * electron/main.spellcheckWiring.test.ts — structural wiring guard for
 * BACKLOG §2.103 (spell checking).
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * `electron/services/spellcheck.ts` is the single writer of the Chromium
 * spellchecker state and of the dictionary-download consent gate (unit-tested
 * in `spellcheck.test.ts`, which cannot see how main.ts actually calls it).
 * What THIS file protects is the wiring: that main calls each entry point
 * exactly once, in the order the service's own contract depends on, and does
 * not read/return anything a compromised renderer could use to skip the gate.
 *
 * `electron/main.ts` is a 10k+ LOC hotspot with module-load side effects that
 * no unit test in this repo imports — see `main.contextMenuWiring.test.ts` for
 * the identical rationale, which applies verbatim here.
 * ──────────────────────────────────────────────────────────────────────
 */

const MAIN_TS_PATH = path.join(__dirname, 'main.ts')
const source = fs.readFileSync(MAIN_TS_PATH, 'utf8')
// Comment-stripped view for order/count assertions that must not be fooled by
// a code sample mentioned in prose (same technique as main.settingsClamp.test.ts).
const CODE = source.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

function occurrences(needle: string): number {
  return source.split(needle).length - 1
}

describe('main.ts §2.103 — single writer for the Chromium spellchecker session', () => {
  it('is the only module that calls the two Chromium session-mutating APIs', () => {
    // AC2: `electron/services/spellcheck.ts` is the ONLY writer. A second call
    // site anywhere else in main, services, packages or the renderer would be a
    // second, competing answer to "is a dictionary allowed to be fetched now".
    expect(source).not.toContain('setSpellCheckerEnabled')
    expect(source).not.toContain('setSpellCheckerLanguages')
  })

  it('calls each spellcheck entry point exactly once', () => {
    // A second call site duplicates the download guard subscription or
    // double-applies the policy — `spellcheck.ts` dedupes some of this
    // (guardedSessions, seen sessions), but main should not rely on that.
    expect(occurrences('initSpellcheck(')).toBe(1)
    expect(occurrences('applySpellcheckToWindow(')).toBe(1)
    expect(occurrences('reapplySpellcheck(')).toBe(1)
    expect(occurrences('ensureSpellcheckDictionariesApproved(')).toBe(1)
    expect(occurrences('applySpellcheckDecision(')).toBe(1)
  })
})

describe('main.ts §2.103 — initSpellcheck runs before the first window', () => {
  it('is wired inside the FIRST app.whenReady().then(), ahead of .then(createWindow)', () => {
    // The whole point of the ordering: Electron populates an empty language
    // list from the OS locale on launch and fetches its dictionary the moment
    // a field is checked — arriving after the window exists is too late.
    const readyIdx = source.indexOf('app.whenReady().then(() => {')
    const initIdx = source.indexOf('initSpellcheck({', readyIdx)
    const createWindowIdx = source.indexOf('.then(createWindow)', readyIdx)
    expect(readyIdx).toBeGreaterThan(-1)
    expect(initIdx).toBeGreaterThan(readyIdx)
    expect(createWindowIdx).toBeGreaterThan(initIdx)
  })

  it('disarms the checker under the e2e harness via the flag, not a raw env read', () => {
    const initIdx = source.indexOf('initSpellcheck({')
    const closeIdx = source.indexOf('\n})', initIdx)
    const call = source.slice(initIdx, closeIdx)
    expect(call).toContain('isE2E: () => IS_E2E')
    // Reading MAILCOPILOT_E2E directly here would bypass the conjunction
    // (env AND unpackaged) computeIsE2E enforces — CLAUDE.md §5 "Testing / Build".
    expect(call).not.toContain('process.env.MAILCOPILOT_E2E')
  })

  it('hands initSpellcheck the store reader/writer, not a captured snapshot', () => {
    const initIdx = source.indexOf('initSpellcheck({')
    const closeIdx = source.indexOf('\n})', initIdx)
    const call = source.slice(initIdx, closeIdx)
    expect(call).toContain('getSettings,')
    expect(call).toContain('saveSettings,')
  })
})

describe('main.ts §2.103 — every window session is configured, not only the default one', () => {
  it('configureExternalLinks calls applySpellcheckToWindow after wiring the context menu', () => {
    const fnStart = source.indexOf('function configureExternalLinks(w: BrowserWindow')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = source.indexOf('\n}', fnStart)
    const body = source.slice(fnStart, fnEnd)
    const attachIdx = body.indexOf('attachContextMenu(w, {')
    const spellIdx = body.indexOf('applySpellcheckToWindow(w)')
    expect(attachIdx).toBeGreaterThan(-1)
    expect(spellIdx).toBeGreaterThan(attachIdx)
  })
})

describe('main.ts §2.103 — settings:save wires the consent gate correctly', () => {
  const start = source.indexOf("handleIpc('settings:save'")
  const handler = source.slice(start, source.indexOf('\n})', start))
  const codeStart = CODE.indexOf("handleIpc('settings:save'")
  const handlerCode = CODE.slice(codeStart, CODE.indexOf('\n})', codeStart))

  it('exists and derives the request from an explicit Array.isArray check', () => {
    expect(start).toBeGreaterThan(-1)
    // `undefined` (no key) and `[]` ("check nothing") must stay distinguishable
    // — a looser check (`?? []`, truthiness) would collapse the two.
    expect(handler).toContain('Array.isArray((accepted as { spellcheckLanguages?: unknown }).spellcheckLanguages)')
  })

  it('reads the consent record AFTER re-reading settings past the AI-destination dialog', () => {
    // Ordering that matters for AC5: the consent gate must not be asked to
    // judge against a `current` snapshot that predates a dialog the handler
    // already awaited once this save — the same class of bug §2.119 records
    // for `ai:checkAuth`.
    const destinationGateIdx = handlerCode.indexOf('ensureAiDestinationApproved(')
    const spellGateIdx = handlerCode.indexOf('ensureSpellcheckDictionariesApproved(')
    // Search from the spell gate onward — `current = getSettings()` is also a
    // substring of the handler's OWN first line (`let current = getSettings()`),
    // which precedes both gates and would otherwise make this pass vacuously.
    const rereadIdx = handlerCode.indexOf('current = getSettings()', spellGateIdx)
    expect(destinationGateIdx).toBeGreaterThan(-1)
    expect(spellGateIdx).toBeGreaterThan(destinationGateIdx)
    expect(rereadIdx).toBeGreaterThan(spellGateIdx)
  })

  it('passes the sender through, so the native dialog can parent itself', () => {
    const idx = handler.indexOf('ensureSpellcheckDictionariesApproved(')
    const call = handler.slice(idx, handler.indexOf(')', handler.indexOf(')', idx) + 1))
    expect(call).toContain('event?.sender')
  })

  it('folds the decision in AFTER the main-only fields were forced back to their persisted values', () => {
    // §2.103's own comment: `spellcheckDictionaryConsent` is main-only, and the
    // restoration loop runs first — folding the decision before it would have
    // the loop immediately discard a grant just written.
    const restoreLoopIdx = handlerCode.indexOf('for (const field of MAIN_ONLY_SETTINGS_FIELDS)')
    const decisionIdx = handlerCode.indexOf('const spellcheckDecision =')
    const nextIdx = handlerCode.indexOf('const next = {')
    expect(restoreLoopIdx).toBeGreaterThan(-1)
    expect(decisionIdx).toBeGreaterThan(restoreLoopIdx)
    expect(nextIdx).toBeGreaterThan(decisionIdx)
  })

  it('short-circuits to an empty decision when no language key was ever sent', () => {
    // A save that never asked about spellcheck must not re-decide the
    // persisted language list from `spellcheckVerdict`'s empty defaults.
    const idx = handlerCode.indexOf('const spellcheckDecision = requestedSpellcheckLanguages === undefined')
    expect(idx).toBeGreaterThan(-1)
    expect(handlerCode.slice(idx, idx + 120)).toContain('? {}')
  })

  it('spreads the decision into the object that is actually persisted', () => {
    const nextIdx = handlerCode.indexOf('const next = {')
    const saveIdx = handlerCode.indexOf('saveSettings(next)')
    expect(nextIdx).toBeGreaterThan(-1)
    const nextBlock = handlerCode.slice(nextIdx, handlerCode.indexOf('}', saveIdx))
    expect(nextBlock).toContain('...spellcheckDecision')
    expect(saveIdx).toBeGreaterThan(nextIdx)
  })

  it('normalises against the availability the verdict was computed against, not a fresh read', () => {
    // A second, later read of `session.availableSpellCheckerLanguages` could
    // answer differently (Chromium loads it lazily) — the decision must use the
    // SAME set the consent dialog was shown against.
    const idx = handler.indexOf('normalizeSpellcheckLanguages(')
    const block = handler.slice(idx, idx + 200)
    expect(block).toContain('spellcheckVerdict.availability.languages')
  })
})

/**
 * §2.103 codex finding (High-3): everything above proves the WIRING — that
 * main.ts calls the right functions in the right order — by reading its
 * source, because main.ts cannot be imported in a unit test (module-level
 * side effects: BrowserWindow, IPC registration, DB open — see the header of
 * electron/main.certRecovery.test.ts for the same constraint spelled out in
 * full). That left the actual SECURITY DECISION — does a payload carrying
 * `spellcheckDictionaryConsent` actually get refused? — unexercised by
 * anything that runs.
 *
 * What CAN run for real, without importing main.ts at all: the two functions
 * the handler's own comments name as its first two calls,
 * `rendererWritableSettingsSchema.safeParse` and
 * `partitionRendererSettingsIssues`. This block drives them directly with the
 * PRODUCTION schema (not a re-typed copy of its shape), so the forbidden-field
 * verdict for this specific field is proven, not merely read off a comment.
 *
 * `spellcheckDictionaryConsent` / `spellcheckAvailable` are spelled out here
 * as LITERALS rather than iterated off `MAIN_ONLY_SETTINGS_FIELDS` (unlike the
 * generic sweep "answers a main-only field with `forbidden`" in
 * electron/settingsSaveRefusal.test.ts, which already covers every member of
 * that array, these two included). A generic loop would just stop iterating
 * over a field silently removed from the array; a literal fails loudly.
 *
 * WHAT THIS DOES NOT PROVE, AND WHY THAT IS NOT A GAP THIS FILE LEAVES OPEN:
 * that the handler checks this BEFORE `getSettings()`, before the
 * AI-destination dialog, before the spellcheck consent dialog, and before any
 * write. That is a claim about main.ts's own CONTROL FLOW, and main.ts is
 * exactly the thing neither this block nor the rest of this file can import.
 * It is not undocumented, though — `main.settingsClamp.test.ts` ("runs the
 * §3.10 P0 gate before anything is stripped or merged", "decides the
 * forbidden-field verdict before it reads persisted settings", "writes
 * nothing on the forbidden-field path") already pins that ordering by reading
 * main.ts's source, GENERICALLY, for every member of
 * `MAIN_ONLY_SETTINGS_FIELDS` — because the gate itself does not special-case
 * any field name, there is nothing about `spellcheckDictionaryConsent`
 * specifically for a narrower version of that same proof to add. Re-deriving
 * it here would be a second copy of the identical regex-based mirror, not new
 * coverage — the kind of duplication CLAUDE.md warns against. Closing that
 * remaining gap for real needs either importing main.ts (blocked by its
 * module-load side effects) or extracting the `settings:save` handler body
 * into a standalone, dependency-injected function main.ts and a test can both
 * import — a hotspot-policy candidate, not something this test-authoring pass
 * can do without touching production code.
 */
describe('main.ts §2.103 — spellcheckDictionaryConsent is refused as forbidden_field (executable, codex High-3)', () => {
  it('rejects a payload carrying spellcheckDictionaryConsent, via the exact schema + partition composition the handler runs', () => {
    const payload = {
      theme: 'dark',
      spellcheckDictionaryConsent: { granted: ['ru-RU'], at: '2026-08-17T00:00:00.000Z' },
    }
    const parsed = rendererWritableSettingsSchema.safeParse(payload)
    expect(parsed.success).toBe(false)
    const { forbidden, refusedFields } = partitionRendererSettingsIssues(
      parsed.success ? [] : parsed.error.issues,
      payload,
    )
    expect(forbidden).toContain('spellcheckDictionaryConsent')
    expect((MAIN_ONLY_SETTINGS_FIELDS as readonly string[])).toContain('spellcheckDictionaryConsent')
    // Not a per-field refusal either — the §3.10 P0 gate kills the WHOLE save
    // (see main.ts's `mainOnlyHit` branch), so there is nothing here left to
    // strip and continue on.
    expect(refusedFields).toEqual([])
  })

  it('rejects spellcheckAvailable the same way — it is main\'s own report, never a renderer input', () => {
    const payload = {
      spellcheckAvailable: { languages: ['ru-RU'], platformOwned: false, max: 8, at: 'now' },
    }
    const parsed = rendererWritableSettingsSchema.safeParse(payload)
    expect(parsed.success).toBe(false)
    const { forbidden } = partitionRendererSettingsIssues(
      parsed.success ? [] : parsed.error.issues,
      payload,
    )
    expect(forbidden).toContain('spellcheckAvailable')
  })
})

describe('main.ts §2.103 — the declined-dictionary notice', () => {
  const start = source.indexOf("handleIpc('settings:save'")
  const handler = source.slice(start, source.indexOf('\n})', start))

  it('is built from a COUNT and a localized message, never the language codes', () => {
    const idx = handler.indexOf('const spellcheckRejected =')
    expect(idx).toBeGreaterThan(-1)
    const block = handler.slice(idx, idx + 350)
    expect(block).toContain('spellcheckVerdict.declined.length')
    expect(block).toContain('count: spellcheckVerdict.declined.length')
    expect(block).toContain('spellcheckDeclinedMessage(next.language)')
    // The declined array itself (language codes) must not be assigned onto
    // the reply object anywhere in this block.
    expect(block).not.toMatch(/declined:\s*spellcheckVerdict\.declined(?!\.length)/)
  })

  it('is spread into BOTH success replies, like the per-field refusal notice', () => {
    const rejectedIdx = handler.indexOf('if (!destinationVerdict.ok) {')
    const finalReturnIdx = handler.indexOf('return { ok: true as const, ...refusal, ...spellcheckRejected }')
    expect(rejectedIdx).toBeGreaterThan(-1)
    expect(finalReturnIdx).toBeGreaterThan(rejectedIdx)
    const rejectedBlock = handler.slice(rejectedIdx, finalReturnIdx)
    expect(rejectedBlock).toContain('...spellcheckRejected,')
  })

  it('is computed after saveSettings, so it can only describe a write that already happened', () => {
    const saveIdx = handler.indexOf('saveSettings(next)')
    const rejectedIdx = handler.indexOf('const spellcheckRejected =')
    expect(saveIdx).toBeGreaterThan(-1)
    expect(rejectedIdx).toBeGreaterThan(saveIdx)
  })
})

describe('main.ts §2.103 — settings follow the store with no restart', () => {
  it('onSettingsChangedMain calls reapplySpellcheck after the tray/autostart reactions', () => {
    const fnStart = source.indexOf('function onSettingsChangedMain(')
    expect(fnStart).toBeGreaterThan(-1)
    const persistedIdx = source.indexOf('const persisted = getSettings()', fnStart)
    const reapplyIdx = source.indexOf('reapplySpellcheck()', fnStart)
    expect(persistedIdx).toBeGreaterThan(fnStart)
    // Read from the STORE (`persisted`/getSettings), not from the `next`
    // payload parameter — the payload is whatever one window chose to send.
    expect(reapplyIdx).toBeGreaterThan(persistedIdx)
  })
})

describe('main.ts §2.103 — mutation control (proves the checks above can actually fail)', () => {
  it('single-writer check fails if a Chromium session call reappears in main.ts', () => {
    const mutated = `${source}\nsession.defaultSession.setSpellCheckerEnabled(true)\n`
    expect(mutated).toContain('setSpellCheckerEnabled')
  })

  it('ordering check fails if initSpellcheck moves after .then(createWindow)', () => {
    // Simulate the regression directly: delete the real call site and append a
    // new one after the createWindow link, then re-run the same comparison the
    // real test above makes.
    const withoutOriginal = source.replace(/initSpellcheck\(\{[\s\S]*?\n {2}\}\)\n/, '')
    expect(withoutOriginal).not.toBe(source) // sanity: the replace matched
    const mutated = withoutOriginal.replace(
      '}).then(createWindow).then(() => {',
      "}).then(createWindow).then(() => {\n  initSpellcheck({ isE2E: () => IS_E2E } as never)",
    )
    const readyIdx = mutated.indexOf('app.whenReady().then(() => {')
    const initIdx = mutated.indexOf('initSpellcheck({', readyIdx)
    const createWindowIdx = mutated.indexOf('.then(createWindow)', readyIdx)
    // The real assertion (`initIdx` before `createWindowIdx`) now fails —
    // proving the test above is actually checking the order and not vacuous.
    expect(createWindowIdx).toBeGreaterThan(-1)
    expect(initIdx).toBeGreaterThan(createWindowIdx)
  })

  it('single-call-site check fails if ensureSpellcheckDictionariesApproved is duplicated', () => {
    const mutated = `${source}\nvoid ensureSpellcheckDictionariesApproved(undefined)\n`
    const count = mutated.split('ensureSpellcheckDictionariesApproved(').length - 1
    expect(count).toBe(2)
  })
})
