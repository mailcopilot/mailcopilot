import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * §2.238 — source guard over `src/App.tsx`.
 *
 * The rule this file protects is a NEGATIVE one: no destructive IPC call may
 * carry a folder that was derived from the thread head (`items[0]`), from the
 * message the gesture started on, or from the folder the list happens to be
 * showing (`currentFolder`). A UID is unique only inside one mailbox (RFC 3501
 * §2.3.1.1), so such a call does not fail — it silently addresses a stranger,
 * and moves or deletes it. Reachable in ordinary use: all-folders search puts
 * rows from several mailboxes into one list, and a conversation freely spans
 * folders (a reply in Sent, an archived branch).
 *
 * The positive behaviour of the planners is covered by
 * `packages/core/threadActions.test.ts`, where the logic now lives (hotspot
 * policy: App.tsx only calls). What that suite cannot see is App.tsx quietly
 * growing the old derivation back, which is what these assertions watch, call
 * site by call site.
 */

const APP_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'App.tsx'),
  'utf8',
)

/**
 * Body of `const <name> = useCallback(...)` — matched by balancing parens so a
 * nested call or an object literal cannot cut it short.
 */
function callbackBody(name: string): string {
  const start = APP_SOURCE.indexOf(`const ${name} = useCallback(`)
  expect(start, `callback ${name} not found in src/App.tsx`).toBeGreaterThan(-1)
  let depth = 0
  let i = APP_SOURCE.indexOf('(', start)
  const from = i
  for (; i < APP_SOURCE.length; i++) {
    const ch = APP_SOURCE[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return APP_SOURCE.slice(from, i + 1)
    }
  }
  throw new Error(`unbalanced parens while reading ${name}`)
}

/**
 * The same body without `//` comments — the comments deliberately NAME the
 * banned constructs ("never `selectedKeys.has(leadKey)`"), so the negative
 * assertions have to look at code alone.
 */
function codeOf(name: string): string {
  return callbackBody(name).replace(/\/\/[^\n]*/g, '')
}

/**
 * Body of an inline JSX event handler — `<marker> => { ... }` — matched by
 * balancing braces from the FIRST `{` after `marker`. Used for handlers that
 * are not `useCallback`s (e.g. `onDrop` on the folder sidebar), where
 * `callbackBody` has nothing to anchor on. `marker` must be unique in
 * App.tsx — asserted below rather than silently reading the wrong handler.
 */
function jsxHandlerBody(marker: string): string {
  const occurrences = APP_SOURCE.split(marker).length - 1
  expect(occurrences, `marker "${marker}" must be unique in src/App.tsx`).toBe(1)
  const start = APP_SOURCE.indexOf(marker)
  let depth = 0
  let i = APP_SOURCE.indexOf('{', start)
  const from = i
  for (; i < APP_SOURCE.length; i++) {
    const ch = APP_SOURCE[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return APP_SOURCE.slice(from, i + 1)
    }
  }
  throw new Error(`unbalanced braces while reading handler at "${marker}"`)
}

describe('§2.238 — no destructive IPC call derives the folder from the thread head', () => {
  it('moveMessagesToFolder dispatches per group and never sends currentFolder (AC2)', () => {
    const body = codeOf('moveMessagesToFolder')
    expect(body).toContain('planMoveToFolder')
    expect(body).toMatch(/invoke\('net:move',\s*g\.accountId,\s*g\.folder,/)
    expect(body).not.toContain('currentFolder')
  })

  it('markReadThread writes \\Seen per group, not with the head folder (AC3)', () => {
    const body = codeOf('markReadThread')
    expect(body).toContain('planMarkSeenGroups')
    expect(body).toMatch(/invoke\('net:setSeen',\s*g\.accountId,\s*g\.folder,/)
    expect(body).not.toMatch(/items\[0\]/)
  })

  it('archiveThread plans per group instead of reading items[0] (AC4)', () => {
    const body = codeOf('archiveThread')
    expect(body).toContain('planRoleMove')
    expect(body).toContain('dispatchRoleMove')
    expect(body).not.toMatch(/items\[0\]/)
    expect(body).not.toContain('currentFolder')
  })

  it('deleteThread goes through the shared delete dispatcher on BOTH branches (AC5)', () => {
    const body = codeOf('deleteThread')
    expect(body).toContain('dispatchDelete')
    expect(body).not.toMatch(/items\[0\]/)
    expect(body).not.toContain('setConfirmDelete')
    expect(body).not.toContain('moveWithUndo')
  })

  it('dispatchDelete splits movable groups from the irreversible remainder (AC5)', () => {
    const body = callbackBody('dispatchDelete')
    expect(body).toContain('planRoleMove')
    // The confirmation dialog carries groups, each with its own folder.
    expect(body).toMatch(/setConfirmDelete\(\{\s*groups:/)
    expect(body).toContain('groupByAccountFolder')
  })

  it('confirmDeleteAction deletes group by group (AC5)', () => {
    const body = callbackBody('confirmDeleteAction')
    expect(body).toMatch(/for \(const g of confirmDelete\.groups\)/)
    expect(body).toMatch(/executeForeverDelete\(g\.accountId,\s*g\.folder,\s*g\.uids\)/)
  })

  it('onDragStartMail carries message refs, not row lead UIDs (AC6)', () => {
    const body = codeOf('onDragStartMail')
    expect(body).toContain('dragSelectionRefs')
    expect(body).toContain('serializeMailRefs')
    expect(body).not.toContain('r.lead.uid')
    // Row membership stays a row question (CLAUDE.md §5) — the helper asks it
    // through row.items; App.tsx must not reintroduce a lead-key lookup.
    expect(body).not.toContain('selectedKeys.has')
  })

  it('undo is offered only for a single-group plan and is never faked (AC7)', () => {
    const body = callbackBody('dispatchRoleMove')
    expect(body).toContain('soleGroup')
    expect(body).toMatch(/moveWithUndo\(sole\.accountId,\s*sole\.msgs,\s*sole\.folder,\s*sole\.targetFolder,/)
    // Everything that is not the sole in-view group moves per message, with the
    // folder that message came from.
    expect(body).toMatch(/moveMailToFolder\(m,\s*g\.targetFolder\)/)
  })

  it('snoozeMessage addresses UIDs inside their own folder', () => {
    const body = callbackBody('snoozeMessage')
    expect(body).toContain('groupByAccountFolder')
    expect(body).toMatch(/invoke\('mail:snoozeAdd',\s*g\.accountId,\s*g\.folder,\s*g\.uids,/)
  })

  it('no destructive IPC call in App.tsx passes currentFolder as the source folder', () => {
    const offenders = [...APP_SOURCE.matchAll(
      /invoke\('(net:move|net:setSeen|net:delete|net:setFlagged|mail:snoozeAdd)',\s*[^)]*?currentFolder/g,
    )].map(m => m[0])
    expect(offenders).toEqual([])
  })

  it('the drag payload MIME type matches the ref-carrying shape', () => {
    // The bare-UID payload type must not come back: a UID without its mailbox
    // is not an address.
    expect(APP_SOURCE).not.toContain('application/x-mailcopilot-uids')
    expect(APP_SOURCE).toContain('application/x-mailcopilot-mailrefs')
  })

  // These five call sites route through the guarded helpers above
  // (`dispatchRoleMove` / `dispatchDelete`) rather than dispatching their own
  // IPC or picking a target folder from `roles.<role>` / the head message. The
  // generic "no invoke(...) call carries currentFolder" check below cannot see
  // a regression here, because these functions do not call `invoke` at all —
  // reverting to the pre-§2.238 shape would route back through `moveWithUndo`
  // or `setConfirmDelete` directly, still with a syntactically valid but wrong
  // (single, head-derived) folder.

  it('bulkArchive plans per group and delegates, never touching roles.archive directly (AC1)', () => {
    const body = callbackBody('bulkArchive')
    expect(body).toContain('planRoleMove')
    expect(body).toContain('dispatchRoleMove')
    expect(body).not.toMatch(/roles\.archive/)
    expect(body).not.toContain('moveWithUndo')
    expect(body).not.toContain('currentFolder')
  })

  it('bulkSpam plans per group and delegates, never touching roles.junk directly (AC1)', () => {
    const body = callbackBody('bulkSpam')
    expect(body).toContain('planRoleMove')
    expect(body).toContain('dispatchRoleMove')
    expect(body).not.toMatch(/roles\.junk/)
    expect(body).not.toContain('moveWithUndo')
    expect(body).not.toContain('currentFolder')
  })

  it('bulkDelete delegates the whole split to dispatchDelete, not its own dialog state (AC5)', () => {
    const body = callbackBody('bulkDelete')
    expect(body).toContain('dispatchDelete')
    expect(body).not.toContain('setConfirmDelete')
    expect(body).not.toContain('moveWithUndo')
    expect(body).not.toMatch(/roles\.trash/)
    expect(body).not.toContain('currentFolder')
  })

  it('executeThreadAction routes delete through dispatchDelete and archive/spam through dispatchRoleMove, never msgs[0] (AC1, AC4, AC5)', () => {
    const body = callbackBody('executeThreadAction')
    expect(body).toContain('dispatchDelete')
    expect(body).toContain('planRoleMove')
    expect(body).toContain('dispatchRoleMove')
    expect(body).not.toMatch(/msgs\[0\]/)
    expect(body).not.toMatch(/\bm0\b/)
    expect(body).not.toContain('inCurrentView')
    expect(body).not.toContain('currentFolder')
    expect(body).not.toContain('moveWithUndo')
  })

  it('deleteMailTarget confirms through groupByAccountFolder, not the old flat {accountId,folder,uids} shape (AC5)', () => {
    const body = callbackBody('deleteMailTarget')
    expect(body).toMatch(/setConfirmDelete\(\{\s*groups:\s*groupByAccountFolder\(\[m\]\)/)
    // The old shape put accountId/folder/uids straight on the state object —
    // that is exactly the head-derived (well, single-message, but flat) form
    // §2.238 replaced. A one-message set still goes through the same grouping
    // helper as every other destructive path, not a shortcut around it.
    expect(body).not.toMatch(/setConfirmDelete\(\{\s*accountId:/)
  })

  it('the folder-sidebar onDrop resolves the payload against loaded rows before moving anything (AC2)', () => {
    // Anchored on the drop target's own handler open, not on `moveMessagesToFolder`
    // — several places in the file call that helper, but only the folder
    // sidebar's onDrop is the untrusted boundary where a drag payload from
    // `dataTransfer` first gets turned back into refs.
    const body = jsxHandlerBody("onDrop={(e) => {")
    expect(body).toContain('parseMailRefs')
    expect(body).toContain('DRAG_MAILREFS_MIME')
    // The payload is a SELECTOR over the loaded set, never an address: the refs
    // must be resolved against the rows this renderer holds, and only the
    // resolved MESSAGES may reach the move. Handing `parseMailRefs`' output
    // straight to `moveMessagesToFolder` would let a crafted drag payload name
    // any mailbox of the selected account.
    expect(body).toMatch(/resolveKnownRefs\(\s*parseMailRefs\([\s\S]*?threadRowsRef\.current/)
    expect(body).toMatch(/moveMessagesToFolder\(dropped,\s*f\.path\)/)
    expect(body).not.toMatch(/moveMessagesToFolder\(\s*(refs|parseMailRefs)/)
    // Fail-closed: a payload that resolves to nothing must return before calling
    // moveMessagesToFolder at all, and must NOT fall back to the open folder.
    expect(body).toMatch(/if \(dropped\.length === 0\) return/)
    expect(body).not.toContain('currentFolder')
    // The pre-§2.238 shape parsed a bare JSON array of UIDs straight off the
    // event and handed it to a "move out of currentFolder" call.
    expect(body).not.toMatch(/JSON\.parse/)
    expect(body).not.toContain('moveUidsToFolder')
  })
})
