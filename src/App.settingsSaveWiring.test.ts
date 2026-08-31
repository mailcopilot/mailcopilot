import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Pins the shape of every `settings:save` call in App.tsx: the payload carries
 * ONLY the field being changed, never a spread of `settings:get()`.
 *
 * Why this needs a test rather than a comment. `settings:get` returns main-only
 * fields (`launchAtLoginStatus`, `aiApiKeySaved`, `telemetryConsent`,
 * `mcpEnableStdio`, `spellcheckAvailable`). The §3.10 P0 gate refuses the WHOLE
 * request when it sees any of them, so a read-modify-write silently persists
 * NOTHING.
 *
 * The refusal is invisible because the handler RETURNS
 * `{ ok: false, reason: 'forbidden_field' }` rather than throwing, and none of
 * these fire-and-forget call sites inspects the reply. (The surrounding
 * `catch { /* ignore *\/ }` is NOT what hid it — nothing was thrown. An earlier
 * revision of this comment claimed otherwise; cross-family review caught it.)
 *
 * Measured on the Windows stand 2026-08-27 against a real profile:
 *
 *   settings:save rejected: forbidden main-only field attempt
 *     [ 'launchAtLoginStatus', 'aiApiKeySaved', 'telemetryConsent',
 *       'mcpEnableStdio', 'spellcheckAvailable' ]
 *   mcp.stdio.connect_blocked { reason: 'forbidden_field' }
 *
 * The worst consequence was on `handleAiSettingsChange`, the AI panel's
 * onboarding provider pick: the write was refused, the provider never
 * persisted, and the panel went on asking the user to choose the provider they
 * had just chosen — a loop with no exit.
 *
 * `Settings.tsx` was never affected: it builds an explicit field list, and its
 * own §2.167 comment warns against exactly this spread. That comment is the
 * documentation; this file is the enforcement, because a comment in one file
 * cannot stop the pattern reappearing in another.
 *
 * App.tsx is a §5 hotspot that cannot be mounted in jsdom, so this mirrors the
 * source-text approach already used by App.unreadOverridesWiring.test.ts.
 */
const APP_TSX = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8')

/**
 * Every `settings:save` invocation in `source`, with its payload argument.
 *
 * Takes the source as a parameter rather than closing over `APP_TSX` so the
 * mutation-control case below can run this exact parser over a deliberately
 * broken copy — a mutation test that does not exercise the real check proves
 * nothing about it.
 */
function settingsSavePayloads(source: string): string[] {
  const out: string[] = []
  const marker = "invoke('settings:save',"
  let from = 0
  for (;;) {
    const at = source.indexOf(marker, from)
    if (at === -1) break
    // Take the balanced argument list that follows the marker.
    let depth = 1
    let i = at + marker.length
    while (i < source.length && depth > 0) {
      const ch = source[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    out.push(source.slice(at + marker.length, i - 1).trim())
    from = i
  }
  return out
}

describe('App.tsx — settings:save sends only the changed field', () => {
  it('finds every settings:save call site (guards against the scan silently matching nothing)', () => {
    const payloads = settingsSavePayloads(APP_TSX)
    expect(payloads.length).toBeGreaterThanOrEqual(4)
  })

  it('no payload spreads another object into settings:save', () => {
    const offenders = settingsSavePayloads(APP_TSX).filter(p => p.includes('...'))
    expect(offenders).toEqual([])
  })

  it('no settings:save call site reads settings:get first', () => {
    // The read-modify-write shape is the thing being banned, not the spread
    // token alone: a future rewrite could assemble the object in a variable and
    // reintroduce the same defect without ever typing `...` next to the invoke.
    const readThenWrite =
      /invoke\('settings:get'\)[\s\S]{0,400}?invoke\('settings:save'/.test(APP_TSX)
    expect(readThenWrite).toBe(false)
  })

  it('keeps the four known single-field payloads', () => {
    expect(APP_TSX).toContain("invoke('settings:save', { groupConversations: next })")
    expect(APP_TSX).toContain("invoke('settings:save', { aiPanelOpen: next })")
    expect(APP_TSX).toContain("invoke('settings:save', { [key]: value })")
    expect(APP_TSX).toContain("invoke('settings:save', { workOffline: next })")
  })

  it('mutation control: the spread check fails once a spread is reintroduced', () => {
    const mutated = APP_TSX.replace(
      "invoke('settings:save', { workOffline: next })",
      "invoke('settings:save', { ...s, workOffline: next })",
    )
    expect(mutated).not.toBe(APP_TSX)

    // Run the REAL parser over the mutated source. The earlier version of this
    // test only asserted that `String.replace` had replaced something, which
    // proves nothing about the check that guards the invariant.
    const offenders = settingsSavePayloads(mutated).filter(p => p.includes('...'))
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('...s')
  })
})
