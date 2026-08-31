import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Source-mirror pins for the two unread-counter defects fixed together.
 *
 * `src/App.tsx` is a §5 hotspot with module-level side effects and cannot be
 * mounted in a unit test, so — like `App.badgePolicyWiring.test.ts` and
 * `main.standaloneWindows.test.ts` — these assertions are anchored to the
 * production text. The behaviour itself is proven where it is importable:
 *   - `electron/folderCountsResponse.test.ts` — the main process now names the
 *     folders it speaks for, so an emptied folder arrives as an explicit zero
 *     instead of being absent.
 *   - `src/hooks/useKeyedDebounce.test.ts` — a burst about several mailboxes
 *     results in one run per mailbox.
 *   - `src/hooks/useUnreadPending.emptyFolderAck.test.ts` — the explicit zero
 *     discharges the manual path's compensating optimistic delta.
 * What only the source can show is that App.tsx still routes through them.
 */
const APP_TSX = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8')

describe('App.tsx mail:exists burst handling (source-mirror)', () => {
  const start = APP_TSX.indexOf('const onExists = (payload: unknown) => {')
  const end = APP_TSX.indexOf("window.api?.on('mail:exists', onExists)", start)
  const body = APP_TSX.slice(start, end)

  it('locates the handler', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it('imports the keyed debounce hook', () => {
    expect(APP_TSX).toContain("import { useKeyedDebounce } from './hooks/useKeyedDebounce'")
  })

  it('keys the debounce on the (account, folder) pair', () => {
    expect(body).toContain('existsDebounce.schedule(`${accountId}:${path}`')
  })

  it('holds no single app-wide timer for mail:exists', () => {
    // The defect: one shared `idleRefreshTimer` meant every incoming event
    // cleared its predecessor, so a burst across four mailboxes refreshed the
    // counters of exactly one of them. The identifier must not come back.
    expect(APP_TSX).not.toContain('idleRefreshTimer.current')
    expect(APP_TSX).not.toContain('const idleRefreshTimer =')
  })

  it('still refreshes the per-account counters at the tail of the run', () => {
    expect(body).toContain('refreshCountsRef.current.schedule(accountId)')
  })
})

describe('App.tsx refreshCachedFolderCounts merge (source-mirror)', () => {
  const start = APP_TSX.indexOf('const refreshCachedFolderCounts = useCallback(async (accountId: number) => {')
  const end = APP_TSX.indexOf('}, [ackMailboxes, currentAccountId])', start)
  const body = APP_TSX.slice(start, end)

  it('locates the merge', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it('treats a present key as authoritative and an absent one as no news', () => {
    // This asymmetry is deliberate and is the renderer half of the contract:
    // main decides which folders it can speak for (see
    // electron/folderCountsResponse.ts), the renderer must not second-guess
    // it in either direction. Zeroing absent keys here would wipe the badge
    // of every `on_open` folder the user never opened.
    expect(body).toContain('const c = counts[f.path]')
    expect(body).toContain('return c ? { ...f, unread: c.unread } : f')
  })

  it('feeds the merged list to ackMailboxes so the baseline moves with it', () => {
    // Without this the compensating delta of the manual path is never
    // discharged and the badge drifts in the opposite direction.
    expect(body).toContain('ackMailboxes(accountId, updated)')
  })
})
