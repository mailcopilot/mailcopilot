import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §2.99 — pins the three bare `applyUnreadOverrides(..., 'remote')` call sites
 * in App.tsx.
 *
 * The BEHAVIOUR these calls trigger (pruning a pending unread override once a
 * REMOTE list confirms the server caught up) is real, unit-tested production
 * logic — see `src/hooks/useUnreadPending.test.ts` describe block
 * "applyOverrides reconciliation". What that file cannot prove is that
 * App.tsx still CALLS it: these are side-effecting statements whose return
 * value is discarded, exactly the shape an eslint `no-unused-expressions`
 * pass, a "dead code" cleanup, or a well-meaning "this does nothing, the
 * return value is never used" refactor would delete — and the renderer author
 * flagged this file specifically as the risk (§2.99 diff notes).
 *
 * App.tsx is a §5 hotspot (5000+ lines, module-scope hook wiring) that cannot
 * be mounted in jsdom the way Settings.bodyRetention.test.ts documents for
 * its own file; this mirrors main.standaloneWindows.test.ts's approach for
 * the same reason. Each assertion is anchored to the literal call text, so it
 * fails the moment a site is deleted, its source argument changes away from
 * 'remote', or the surrounding "why this must stay" comment is dropped
 * without the call going with it (comment-only drift is not what this guards
 * — call-site presence is).
 */
const APP_TSX = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8')

describe('App.tsx §2.99 — bare applyUnreadOverrides(..., \'remote\') call sites', () => {
  it('reconciles the background-refresh path (a.id / INBOX)', () => {
    expect(APP_TSX).toContain("applyUnreadOverrides(a.id, 'INBOX', raw, 'remote')")
  })

  it('reconciles the context-switch path (id / INBOX, via the stable ref)', () => {
    expect(APP_TSX).toContain("applyUnreadOverridesRef.current(id, 'INBOX', raw, 'remote')")
  })

  it('reconciles the account sync-status path (id / INBOX)', () => {
    expect(APP_TSX).toContain("applyUnreadOverrides(id, 'INBOX', raw, 'remote')")
  })

  it('all three call sites are actually reached (three occurrences of the exact statement or its ref variant)', () => {
    // Two of the three calls share verbatim text
    // (`applyUnreadOverrides(a.id, ...)` is unique, the other two use `id`
    // via different bindings) — count occurrences of the bare-call PATTERN
    // rather than one exact string, so a duplicate-vs-missing mistake in
    // either of the `id`-based sites cannot hide behind the other.
    const calls = APP_TSX.match(/applyUnreadOverrides(?:Ref\.current)?\([a-zA-Z.]+, 'INBOX', \w+, 'remote'\)/g) ?? []
    expect(calls).toHaveLength(3)
  })
})
