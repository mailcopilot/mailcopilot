/**
 * §1.26.f2 — the two Settings.tsx facts about per-account AI consent that a
 * refactor can silently invert.
 *
 * Neither is enforcement. The enforcement point is main (`settings:save`,
 * electron/accountKeyedConsents.ts), because a second settings window, a save
 * already in flight and a compromised renderer all bypass anything this file
 * does. What is pinned here is the DISPLAY half — the grid must not keep
 * offering a mailbox that was deleted in this very window — and the compile-
 * time completeness the comment above the feature switch claims.
 *
 * Settings.tsx cannot be mounted in jsdom (3000+ lines, many top-level imports
 * — same rationale as Settings.threadSummary.test.ts), so both are asserted
 * against the source, like the main-side mirrors in electron/main.*.test.ts.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SETTINGS_TSX = fs.readFileSync(path.join(__dirname, 'Settings.tsx'), 'utf8')

describe('Settings.tsx per-account AI consent', () => {
  const start = SETTINGS_TSX.indexOf('const removeAccount = useCallback(')
  const removeAccount = SETTINGS_TSX.slice(start, SETTINGS_TSX.indexOf('\n  }, [', start))

  it('drops the removed mailbox from all four consent maps it holds', () => {
    // The maps are loaded ONCE (a `[]`-dependency effect) and re-submitted
    // whole on every save; the `accounts:changed` subscription re-reads only
    // `accounts:list`. Without this the window keeps a purged `true` and its
    // next unrelated save merges it back over main's purge.
    expect(start).toBeGreaterThan(-1)
    for (const setter of [
      'setAiThreadSummaryEnabled(withoutRemoved)',
      'setAiInstantReplyEnabled(withoutRemoved)',
      'setAiProofreadEnabled(withoutRemoved)',
      'setAiTranslateEnabled(withoutRemoved)',
    ]) {
      expect(removeAccount).toContain(setter)
    }
  })

  it('cleans the maps only after main confirmed the removal', () => {
    // A local cleanup ahead of the IPC would withdraw consents the user still
    // has if `accounts:remove` rejects.
    const removeCall = removeAccount.indexOf("invoke('accounts:remove'")
    const cleanup = removeAccount.indexOf('const withoutRemoved =')
    expect(removeCall).toBeGreaterThan(-1)
    expect(cleanup).toBeGreaterThan(removeCall)
  })

  it('writes the cleanup as an updater, never as a map built from render state', () => {
    // Same reason `useAiConsentMatrix` hands out updaters: two writes coalesced
    // into one React batch would resolve "last one wins over a stale snapshot",
    // and the write that can be lost that way is a withdrawal.
    expect(removeAccount).toMatch(
      /const withoutRemoved = \(prev: Record<string, boolean>\): Record<string, boolean> =>/,
    )
  })

  it('makes a fifth AI consent feature a compile error at the feature switch', () => {
    // The comment above the switch claims this. Without the `never` guard it
    // was not true: a switch is legal over any subset of a union, so the only
    // error a fifth feature raised was on `value` (a complete
    // `Record<AiConsentFeature, AiConsentMap>`) — and satisfying that one while
    // forgetting a branch here produced a checkbox that stored nothing.
    const switchStart = SETTINGS_TSX.indexOf('onChangeFeature={(feature, update) => {')
    expect(switchStart).toBeGreaterThan(-1)
    const block = SETTINGS_TSX.slice(switchStart, SETTINGS_TSX.indexOf('\n            />', switchStart))
    expect(block).toMatch(/default:\s*\{\s*const exhaustive: never = feature/)
    for (const branch of ['threadSummary', 'instantReply', 'proofread', 'translate']) {
      expect(block).toContain(`case '${branch}':`)
    }
  })
})
