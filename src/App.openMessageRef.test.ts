import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §2.99 — `openMessageRef` is the merged resolver behind both the AI-source
 * link (`openAiSource`, pre-existing behaviour: an unresolved reference shows
 * an error banner) and the new main-process notification click
 * (`useMailOpenRef`, new behaviour: a stale ref degrades silently to
 * selecting the folder, because "message was deleted between the toast and
 * the click" is ordinary, not a bug worth interrupting the user over).
 *
 * `useMailOpenRef` itself (subscription + payload validation) has its own 24
 * tests. What is NOT covered anywhere else is that App.tsx wires the two
 * call sites to OPPOSITE values of `silentIfMissing`, and that the function's
 * internal branch order actually honours the flag before touching the error
 * banner. App.tsx cannot be mounted here (§5 hotspot — see
 * Settings.bodyRetention.test.ts and main.standaloneWindows.test.ts for the
 * established precedent of reading the source instead), so this pins the
 * literal wiring: it fails the moment either call site's opts argument
 * changes, or the missing-summary branch stops checking the flag first.
 */
const APP_TSX = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8')

describe('App.tsx §2.99 — openMessageRef call sites use opposite silentIfMissing values', () => {
  it('the AI-source link path calls openMessageRef with NO opts (preserves the pre-§2.99 error banner)', () => {
    const start = APP_TSX.indexOf('const openAiSource = useCallback(')
    expect(start).toBeGreaterThan(-1)
    const end = APP_TSX.indexOf('\n  )', start)
    const body = APP_TSX.slice(start, end)
    expect(body).toContain('(ref: MessageRef) => openMessageRef(ref)')
    // Not silent — a stray second argument here would swallow the error a
    // user who typed/clicked a bad AI source link is supposed to see.
    expect(body).not.toContain('silentIfMissing')
  })

  it('the notification-click path calls openMessageRef with silentIfMissing: true', () => {
    expect(APP_TSX).toContain('useMailOpenRef(ref => openMessageRef(ref, { silentIfMissing: true }))')
  })
})

describe('App.tsx §2.99 — openMessageRef branch order: the flag is checked before the error banner', () => {
  const start = APP_TSX.indexOf('const openMessageRef = useCallback(')
  const end = APP_TSX.indexOf('}, [currentAccountId, currentFolder, openMail, selectAccount, t, viewMode])', start)
  const body = APP_TSX.slice(start, end)

  it('locates the function', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it('checks opts?.silentIfMissing and returns before ever calling setError', () => {
    const flagIdx = body.indexOf('if (opts?.silentIfMissing) {')
    const setErrorIdx = body.indexOf('setError(')
    expect(flagIdx).toBeGreaterThan(-1)
    expect(setErrorIdx).toBeGreaterThan(-1)
    expect(flagIdx).toBeLessThan(setErrorIdx)
    // The silent branch must itself return, so execution cannot fall through
    // into the setError call below it.
    const flagBlockEnd = body.indexOf('\n      }', flagIdx)
    expect(body.slice(flagIdx, flagBlockEnd)).toContain('return')
  })

  it('the silent branch still selects the referenced account/folder, so the window lands somewhere useful', () => {
    const flagIdx = body.indexOf('if (opts?.silentIfMissing) {')
    const flagBlockEnd = body.indexOf('\n      }', flagIdx)
    expect(body.slice(flagIdx, flagBlockEnd)).toContain('if (needsSelection) selectAccount(accountId, folder)')
  })

  it('both the missing-summary branches are guarded by the SAME `if (!summary)` — silence is not a separate early return', () => {
    const notFoundIdx = body.indexOf('if (!summary) {')
    const flagIdx = body.indexOf('if (opts?.silentIfMissing) {')
    expect(notFoundIdx).toBeGreaterThan(-1)
    expect(notFoundIdx).toBeLessThan(flagIdx)
  })
})
