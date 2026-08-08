import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * electron/main.contextMenuWiring.test.ts — structural wiring guard for which
 * windows may route "open link in browser" through the native context menu
 * (BACKLOG §2.93(a), cross-checked against the §2.135 mail-link plumbing it
 * reuses).
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * `configureExternalLinks(w, { routesMailLinks })` is the single place every
 * window wires both its `mail:link` funnel AND its native context menu
 * (`attachContextMenu`). `routesMailLinks` decides whether the context menu's
 * "open link in browser" item is offered at all: `contextMenu.ts` passes
 * `emitMailLink: opts.routesMailLinks ? emitMailLink : undefined`, and an
 * `undefined` emitMailLink means `buildContextMenuPlan` never includes the
 * `openLink` item (unit-tested in `contextMenu.test.ts`, which cannot see
 * main.ts's own call sites).
 *
 * Three call sites decide this per window kind, and the reasoning for each is
 * a comment, not a check: the main window and the standalone message window
 * mount `useMailLinkClick` (so `mail:link` has a live consumer) and pass
 * `true`; Settings/Account/Compose do not and pass `false`. Nothing enforces
 * that the boolean actually matches which windows mount the hook — a
 * copy-paste that flips one of the three would silently degrade a window
 * (main window loses "open link"; a Settings-family window gains a dead menu
 * item — see contextMenu.ts's own comment: "an item that silently does
 * nothing is worse than an absent one").
 *
 * ── Why source-text assertions and not behavioural tests ─────────────────
 * `electron/main.ts` is a 10k+ LOC hotspot with module-load side effects that
 * no unit test in this repo imports — see `main.bodyIndexerBackoffWiring.test.ts`
 * for the identical rationale, which applies verbatim here.
 * ──────────────────────────────────────────────────────────────────────
 */

const MAIN_TS_PATH = path.join(__dirname, 'main.ts')
const source = fs.readFileSync(MAIN_TS_PATH, 'utf8')

/**
 * Asserts `call` appears shortly after `comment` in `source` — i.e. the call
 * is the one the comment actually documents, not some other occurrence of the
 * same call text elsewhere in the file. `maxGap` is generous (a couple of
 * short lines) but far tighter than "anywhere in a 10k-line file", so a
 * mismatched comment/call pairing cannot satisfy it by accident.
 */
function assertAdjacent(comment: string, call: string, maxGap = 200): void {
  const commentIdx = source.indexOf(comment)
  if (commentIdx === -1) throw new Error(`comment anchor not found in electron/main.ts: ${comment}`)
  const callIdx = source.indexOf(call, commentIdx)
  if (callIdx === -1) throw new Error(`call anchor not found after comment in electron/main.ts: ${call}`)
  const gap = callIdx - (commentIdx + comment.length)
  expect(gap, `expected "${call}" within ${maxGap} chars of "${comment}", was ${gap}`).toBeLessThanOrEqual(maxGap)
}

describe('main.ts §2.93(a) — which windows may route "open link in browser"', () => {
  it('the main window is configured with routesMailLinks: true (App.tsx mounts useMailLinkClick)', () => {
    assertAdjacent(
      '// Main window: App.tsx mounts useMailLinkClick',
      'configureExternalLinks(win, { routesMailLinks: true })',
    )
  })

  it('generic child windows (Settings / Account / Compose) are configured with routesMailLinks: false', () => {
    assertAdjacent(
      '// Settings / Account / Compose: no `mail:link` subscriber',
      'configureExternalLinks(child, { routesMailLinks: false })',
    )
  })

  it('the standalone message window is configured with routesMailLinks: true (MailWindow.tsx mounts useMailLinkClick)', () => {
    assertAdjacent(
      '// Standalone message window: MailWindow.tsx mounts useMailLinkClick',
      'configureExternalLinks(child, { routesMailLinks: true })',
    )
  })

  it('configureExternalLinks is the one place that wires attachContextMenu, gating emitMailLink on routesMailLinks', () => {
    // Every window goes through this one function, so a window that forgets
    // to call configureExternalLinks also gets no context menu at all — not a
    // silently different one built by a second code path.
    const fnStart = source.indexOf('function configureExternalLinks(w: BrowserWindow')
    expect(fnStart).toBeGreaterThan(-1)
    const attachIdx = source.indexOf('attachContextMenu(w, {', fnStart)
    expect(attachIdx).toBeGreaterThan(-1)
    const body = source.slice(attachIdx, attachIdx + 400)
    expect(body).toContain("getLanguage: () => getSettings().language ?? 'en'")
    expect(body).toContain('emitMailLink: opts.routesMailLinks ? emitMailLink : undefined')
  })

  it('exactly three call sites decide routesMailLinks — a fourth window kind must update this file too', () => {
    // Not a design constraint on main.ts, just keeping this test's own
    // coverage claim honest: if a new window kind is added without updating
    // the assertions above, this count changes and the test fails loudly
    // instead of silently covering only 3 of 4 windows forever.
    const trueCount = source.split('configureExternalLinks(win, { routesMailLinks: true })').length - 1
      + source.split('configureExternalLinks(child, { routesMailLinks: true })').length - 1
    const falseCount = source.split('configureExternalLinks(child, { routesMailLinks: false })').length - 1
    expect(trueCount).toBe(2)
    expect(falseCount).toBe(1)
  })
})

describe('main.ts §2.93(a) — mutation control (proves the checks above can actually fail)', () => {
  // Each case re-derives the same anchors as its assertion and mutates the
  // in-memory string only — the file on disk is never touched.

  it('main-window check fails once routesMailLinks flips to false', () => {
    const mutated = source.replace(
      'configureExternalLinks(win, { routesMailLinks: true })',
      'configureExternalLinks(win, { routesMailLinks: false })',
    )
    expect(mutated).not.toBe(source)
    const commentIdx = mutated.indexOf('// Main window: App.tsx mounts useMailLinkClick')
    const trueCallIdx = mutated.indexOf('configureExternalLinks(win, { routesMailLinks: true })', commentIdx)
    expect(trueCallIdx).toBe(-1)
  })

  it('child-window check fails once routesMailLinks flips to true for Settings/Account/Compose', () => {
    const mutated = source.replace(
      'configureExternalLinks(child, { routesMailLinks: false })',
      'configureExternalLinks(child, { routesMailLinks: true })',
    )
    expect(mutated).not.toBe(source)
    const commentIdx = mutated.indexOf('// Settings / Account / Compose: no `mail:link` subscriber')
    const falseCallIdx = mutated.indexOf('configureExternalLinks(child, { routesMailLinks: false })', commentIdx)
    expect(falseCallIdx).toBe(-1)
  })

  it('emitMailLink gating check fails once the ternary is collapsed to always pass emitMailLink', () => {
    const fnStart = source.indexOf('function configureExternalLinks(w: BrowserWindow')
    const attachIdx = source.indexOf('attachContextMenu(w, {', fnStart)
    const original = source.slice(attachIdx, attachIdx + 400)
    expect(original).toContain('emitMailLink: opts.routesMailLinks ? emitMailLink : undefined') // sanity
    const mutated = original.replace(
      'emitMailLink: opts.routesMailLinks ? emitMailLink : undefined',
      'emitMailLink: emitMailLink',
    )
    expect(mutated).not.toBe(original)
    expect(mutated).not.toContain('emitMailLink: opts.routesMailLinks ? emitMailLink : undefined')
  })

  it('call-site count check fails once a routesMailLinks: true call site is duplicated', () => {
    const mutated = `${source}\nconfigureExternalLinks(win, { routesMailLinks: true })\n`
    const trueCount = mutated.split('configureExternalLinks(win, { routesMailLinks: true })').length - 1
      + mutated.split('configureExternalLinks(child, { routesMailLinks: true })').length - 1
    expect(trueCount).toBe(3) // not the expected 2
  })
})
