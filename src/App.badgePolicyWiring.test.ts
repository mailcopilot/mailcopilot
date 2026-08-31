import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getFolderRole, isFolderCountedInBadges, sumBadgeUnread, type BadgeUnreadRow } from '@mailcopilot/core'

/**
 * §2.99 review H2 gap-fill (codex gap "os_badge_matches_renderer_folder_policy
 * _and_refreshes_after_local_mutations", residual half after the fix wave).
 *
 * The fix wave closed the main-process half thoroughly:
 *   - packages/core/unreadBadgePolicy.test.ts — the shared policy itself, 10
 *     tests.
 *   - electron/services/backgroundMail.test.ts "review H2" block — main's
 *     `computeBadgeTotal` / `isCountedInBadges` resolved through the SAME
 *     shared policy, using REAL `getFolderRole`/`isFolderCountedInBadges`/
 *     `sumBadgeUnread` (not mocked in that file).
 *
 * What none of that proves is that the RENDERER side (src/App.tsx
 * `accountUnread`, ~line 3575) still calls the same shared functions with the
 * same context shape — App.tsx is a §5 hotspot with module-level side effects
 * (5000+ lines) and cannot be mounted the way `backgroundMail.test.ts` mounts
 * its module. Two halves close that gap:
 *
 *   Part A — source-mirror (same technique as main.standaloneWindows.test.ts
 *   / App.openMessageRef.test.ts): pins that `accountUnread` imports
 *   `isFolderCountedInBadges` from `@mailcopilot/core`, resolves `role` via
 *   the shared `getFolderRole`, and passes `{ pref: prefs[f.path], role }` —
 *   NOT the legacy per-file `hiddenUnreadPaths` list that still exists in the
 *   same component for an unrelated call site (the folder-tree "hidden by
 *   legacy setting" badge). A future edit accidentally wiring accountUnread
 *   back onto `hiddenUnreadPaths` (the two are one `hiddenUnreadPaths.has(...)`
 *   substring away from each other, both live in the same 5000-line file, and
 *   the mistake would compile and even usually "look right") is exactly the
 *   drift the shared policy was built to prevent.
 *
 *   Part B — drift pin: feeds ONE identical fixture set through
 *   `sumBadgeUnread` (main's shape) and through a per-folder loop built from
 *   the EXACT resolver shape Part A pins for App.tsx (renderer's shape),
 *   using the REAL imported `isFolderCountedInBadges` / `getFolderRole` for
 *   both — no reimplementation of the policy, only the two resolver shapes
 *   that Part A proves the production code actually uses. If either resolver
 *   in production ever passes a different field (e.g. `pref.visible` instead
 *   of the full `{visible, includeInBadges}` shape, or a role source other
 *   than `getFolderRole`), Part A goes red first; this proves that AS LONG AS
 *   both resolvers match their pinned shape, the totals cannot disagree.
 */
const APP_TSX = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8')

describe('App.tsx §2.99 review H2 — accountUnread wiring (source-mirror)', () => {
  const start = APP_TSX.indexOf('const accountUnread = useMemo(() => {')
  const end = APP_TSX.indexOf('}, [accounts, folderUnreadPending])', start)
  const body = APP_TSX.slice(start, end)

  it('locates accountUnread', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('imports the shared badge policy from @mailcopilot/core', () => {
    expect(APP_TSX).toContain("import { isFolderCountedInBadges } from '@mailcopilot/core'")
  })

  it('resolves role via the shared getFolderRole and gates on isFolderCountedInBadges', () => {
    expect(body).toContain('const role = getFolderRole(f.path, f.specialUse, acRoles)')
    expect(body).toContain('if (!isFolderCountedInBadges({ pref: prefs[f.path], role })) continue')
  })

  it('does NOT fall back to the legacy hiddenUnreadPaths list for this rollup', () => {
    // hiddenUnreadPaths legitimately exists elsewhere in this file (the
    // folder-tree "hidden by legacy setting" badge) — the point is that
    // THIS computation, the one that also drives the window title and the
    // per-account avatar badge, does not silently start reading it too.
    expect(body).not.toContain('hiddenUnreadPaths')
  })

  it('role resolution runs BEFORE the gate that consumes it', () => {
    const roleIdx = body.indexOf('const role = getFolderRole(')
    const gateIdx = body.indexOf('if (!isFolderCountedInBadges(')
    expect(roleIdx).toBeGreaterThan(-1)
    expect(roleIdx).toBeLessThan(gateIdx)
  })
})

describe('§2.99 review H2 — drift pin: main total (sumBadgeUnread) === renderer total (accountUnread shape)', () => {
  // One fixture, account 1: INBOX counts by default, Archive does not, a
  // custom folder opted in counts, a folder hidden from the sidebar never
  // counts even though it opted in. Numbers chosen so a resolver mistake
  // (e.g. counting Archive, or not excluding the hidden opted-in folder)
  // changes the total rather than coincidentally matching it.
  const folders = [
    { path: 'INBOX', specialUse: null as string | null, unread: 5, pref: undefined as { visible?: boolean; includeInBadges?: boolean } | undefined },
    { path: 'Archive', specialUse: null as string | null, unread: 10, pref: undefined },
    { path: 'Projects', specialUse: null as string | null, unread: 7, pref: { includeInBadges: true } },
    { path: 'Digest', specialUse: null as string | null, unread: 3, pref: { visible: false, includeInBadges: true } },
  ]
  const roles = { archive: 'Archive' }
  const EXPECTED_TOTAL = 5 + 7 // INBOX + Projects; Archive excluded by default, Digest hidden

  it('renderer-shaped resolution (per-folder loop, App.tsx\'s pinned call shape) reaches the expected total', () => {
    let sum = 0
    for (const f of folders) {
      const role = getFolderRole(f.path, f.specialUse, roles)
      if (!isFolderCountedInBadges({ pref: f.pref, role })) continue
      sum += f.unread
    }
    expect(sum).toBe(EXPECTED_TOTAL)
  })

  it('main-shaped resolution (sumBadgeUnread, backgroundMail.ts\'s call shape) reaches the SAME total for the SAME fixture', () => {
    const rows: BadgeUnreadRow[] = folders.map(f => ({ accountId: 1, folder: f.path, unread: f.unread }))
    const total = sumBadgeUnread(rows, (_accountId, folderPath) => {
      const f = folders.find(x => x.path === folderPath)
      return { pref: f?.pref, role: getFolderRole(folderPath, f?.specialUse ?? null, roles) }
    })
    expect(total).toBe(EXPECTED_TOTAL)
  })

  it('the two resolution shapes agree across a second, independently varied fixture', () => {
    // Different numbers and a different opted-out inbox, so this is not the
    // same arithmetic coincidence as the fixture above.
    const other = [
      { path: 'INBOX', specialUse: null as string | null, unread: 2, pref: { includeInBadges: false } },
      { path: 'Support', specialUse: null as string | null, unread: 9, pref: { includeInBadges: true } },
      { path: 'Trash', specialUse: '\\Trash' as string | null, unread: 1, pref: undefined },
    ]

    let rendererTotal = 0
    for (const f of other) {
      const role = getFolderRole(f.path, f.specialUse, {})
      if (!isFolderCountedInBadges({ pref: f.pref, role })) continue
      rendererTotal += f.unread
    }

    const rows: BadgeUnreadRow[] = other.map(f => ({ accountId: 1, folder: f.path, unread: f.unread }))
    const mainTotal = sumBadgeUnread(rows, (_accountId, folderPath) => {
      const f = other.find(x => x.path === folderPath)
      return { pref: f?.pref, role: getFolderRole(folderPath, f?.specialUse ?? null, {}) }
    })

    expect(rendererTotal).toBe(9) // only Support opted in
    expect(mainTotal).toBe(rendererTotal)
  })
})
