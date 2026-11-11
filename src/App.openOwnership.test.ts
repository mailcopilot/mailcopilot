import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §2.308 wiring pin. Mounting the real App.tsx is impractical (see Root.test.tsx),
 * so the behaviour lives in `useMailOpenOwnership` / `runMailOpen` and this suite
 * pins the three call sites that decide it, by reading the source:
 *
 *  - a sync of the folder already on screen invalidates the LIST only — if it
 *    called `invalidateContext()` (navigation) again, a refresh landing while
 *    the message body is in flight would discard the body and leave "Loading";
 *  - the open path runs through `mailOpen.run`, which releases the loading flag
 *    on every outcome for the request that owns it.
 */
const APP_TS = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8')

function sliceCallback(marker: string): string {
  const start = APP_TS.indexOf(marker)
  if (start < 0) throw new Error(`marker not found: ${marker}`)
  const end = APP_TS.indexOf('\n  }, [', start)
  if (end < 0) throw new Error(`end of callback not found: ${marker}`)
  return APP_TS.slice(start, end)
}

describe('App open-message ownership wiring (§2.308)', () => {
  it('syncFolder refreshes the list context, not the navigation context', () => {
    const body = sliceCallback('const syncFolder = useCallback(')
    expect(body).toContain('invalidateListContext()')
    expect(body).not.toMatch(/\binvalidateContext\(\)/)
  })

  it('the unified refresh in syncCurrentView refreshes the list context, not the navigation context', () => {
    const body = sliceCallback('const syncCurrentView = useCallback(')
    expect(body).toContain('invalidateListContext()')
    expect(body).not.toMatch(/\binvalidateContext\(\)/)
  })

  it('navigation invalidation also moves open ownership; list invalidation does not', () => {
    const nav = sliceCallback('const invalidateContext = useCallback(')
    expect(nav).toContain('mailOpen.invalidateNavigation()')
    const list = sliceCallback('const invalidateListContext = useCallback(')
    expect(list).not.toContain('invalidateNavigation')
  })

  it('openMail settles through the ownership hook and keeps no private sequence counters', () => {
    const body = sliceCallback('const openMail = useCallback(')
    expect(body).toContain('mailOpen.beginOpen()')
    expect(body).toContain('mailOpen.run(')
    expect(body).not.toMatch(/ctxSeq|openSeq/)
  })

  it('every navigation path still invalidates the navigation context', () => {
    for (const marker of [
      'const switchFolder = useCallback(',
      'const switchToUnified = useCallback(',
      'const selectAccount = useCallback(',
      'const onSearch = useCallback(',
    ]) {
      const body = sliceCallback(marker)
      expect(body, marker).toMatch(/\binvalidateContext\(\)/)
      expect(body, marker).not.toContain('invalidateListContext()')
    }
  })

  it('list-only invalidation has exactly the two sync call sites and nobody else', () => {
    expect(APP_TS.match(/\binvalidateListContext\(\)/g)).toHaveLength(2)
  })

  it('openMail releases the loading flag only through the owning request', () => {
    const body = sliceCallback('const openMail = useCallback(')
    // Also proves the slice reaches the end of the callback (not a truncated body).
    expect(body).toContain('releaseLoading: () => setLoadingBody(false)')
    expect(body.match(/setLoadingBody\(false\)/g)).toHaveLength(1)
    expect(body.match(/setLoadingBody\(true\)/g)).toHaveLength(1)
  })
})
