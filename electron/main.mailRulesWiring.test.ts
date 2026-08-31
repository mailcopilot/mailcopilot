import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * electron/main.mailRulesWiring.test.ts — structural wiring guard for §2.86.
 *
 * ── Why this exists (2026-07-30 incident) ────────────────────────────────
 * §2.86 fixed a defect where several code paths in electron/main.ts persisted
 * messages into the local cache without ever triggering static mail-rule
 * evaluation. `net:inboxSummaries` and the tail of the full sync were the two
 * places that DID call the pipeline; everything else that wrote messages —
 * `net:folderPage` pagination, the FLAGS-only sync early-return branch, a full
 * sync that threw after committing its batches, the periodic background sync,
 * `search:remoteSearch` hydration — wrote them silently. Because "new" was then
 * derived from `MAX(uid) FROM messages`, each of those writers also pushed the
 * bar above its own message, so no rule could ever see it again.
 *
 * `mailRulesRunner.test.ts` covers the FIXED discovery logic — the
 * watermark-based runner — as a real unit test with dependency injection. It
 * cannot cover the OTHER half of the bug: whether `electron/main.ts` actually
 * calls into that runner from the paths that persist messages.
 *
 * `main.ts` is a 10k+ LOC hotspot with module-load side effects (IPC
 * registration, DB open, Sentry wiring) that no test in this repo imports
 * directly — see `main.pendingMoves.test.ts` / `main.periodicSync.test.ts`
 * for the established alternative (hand-mirrored logic, with an explicit
 * drift-risk disclaimer). A mirror cannot catch THIS class of bug by
 * construction: a mirror that simply forgets to reproduce a call stays
 * green forever, because nothing in it is compared back to the source it
 * was copied from. That is exactly how the original defect stayed
 * uncaught — every call site "looked" correct locally.
 *
 * So instead of mirroring behaviour, this file inspects the ACTUAL SOURCE
 * TEXT of `electron/main.ts` and asserts that each KNOWN message-persisting
 * exit calls `processMailRules(`. This is a STRUCTURAL check, not a
 * behavioural one:
 *   - It proves the call is textually present inside each exit, and — for the
 *     branch-sensitive ones (FLAGS-only early return, the throwing sync path,
 *     the periodic loop's per-folder `catch`) — present in the part of the
 *     control flow the failing case actually reaches. Every assertion has a
 *     matching mutation-control test below that strips the exact call text and
 *     proves the assertion then fails.
 *   - It does NOT prove the list of exits is COMPLETE. Nothing mechanical here
 *     enumerates the writers of the `messages` table, so a NEW persisting path
 *     added tomorrow without a rule trigger would keep this file green. That
 *     gap is what BACKLOG.md §2.74 (`npm run check:wiring`) proposes to close
 *     generally; this file is a one-feature, hand-written instance of the idea.
 *     What blunts the consequence meanwhile: the watermark now belongs to the
 *     runner, so a missed trigger DELAYS evaluation instead of losing it
 *     permanently. It does NOT follow that every folder gets a pass on its own
 *     — the periodic background sync only visits folders whose
 *     `folder_prefs.headerSyncMode` is `full` or `period` (see
 *     `syncOneAccountFolders`), and the startup seed only anchors a starting
 *     position, it evaluates nothing. A folder on the default `on_open` mode
 *     is still evaluated only when a user-facing path (open, paginate, sync,
 *     remote search) touches it.
 *   - It does NOT prove the call receives the right accountId/folder, that it
 *     is correctly fire-and-forget (`.catch(...)`, not `await`ed into a
 *     blocking path), or that `buildMailRulesDeps()` wires correct
 *     collaborators (e.g. the `getUidValidity` mapping to
 *     `getSyncState(...)?.uidValidity ?? null`). Those need either a refactor
 *     that makes the wiring importable in isolation, or e2e coverage.
 * ──────────────────────────────────────────────────────────────────────
 */

const MAIN_TS_PATH = path.join(__dirname, 'main.ts')
const source = fs.readFileSync(MAIN_TS_PATH, 'utf8')

/**
 * Slice `text` from the first occurrence of `startAnchor` up to the next
 * occurrence of `endAnchor` that follows it. Throws if either anchor is
 * missing — a missing anchor means the source shape changed enough that
 * this test needs to be re-pointed, which must fail loudly rather than
 * silently matching nothing.
 */
function sliceBetween(text: string, startAnchor: string, endAnchor: string): string {
  const startIdx = text.indexOf(startAnchor)
  if (startIdx === -1) throw new Error(`start anchor not found in electron/main.ts: ${startAnchor}`)
  const endIdx = text.indexOf(endAnchor, startIdx + startAnchor.length)
  if (endIdx === -1) throw new Error(`end anchor not found after start in electron/main.ts: ${endAnchor}`)
  return text.slice(startIdx, endIdx)
}

/**
 * Slice helpers, shared by the assertions and their mutation controls. Each
 * slice is anchored tightly to the exit it describes: a loose slice can contain
 * an unrelated `processMailRules(` (its own declaration, a neighbouring
 * handler), which would let a mutated copy still pass `toContain`.
 */
const slices = {
  inboxSummaries: () =>
    sliceBetween(source, `handleIpc('net:inboxSummaries'`, `return filterPendingMoves(result)\n})`),
  folderPage: () =>
    sliceBetween(source, `handleIpc('net:folderPage'`, `return filterPendingMoves(page)\n})`),
  // `runSyncFolderHeaders` sets `syncSucceeded = true` twice: once in the
  // FLAGS-only branch right before its early `return`, and once at the very end
  // of the function. `indexOf` always finds the FIRST occurrence, which is the
  // FLAGS-only one — the pair we need here.
  flagsOnlyBranch: () =>
    sliceBetween(source, 'syncSucceeded = true', 'return { ok: true as const, fetched, completed }'),
  // Everything between the rethrow and the function's success tail is the
  // `finally` block — the only part of the sync body the THROWING path still
  // reaches.
  fullSyncFinally: () =>
    sliceBetween(source, 'throw syncErr', 'syncSucceeded = true\n  return { ok: true as const'),
  remoteSearch: () =>
    sliceBetween(source, `handleIpc('search:remoteSearch'`, `return summaries\n})`),
  // From the periodic loop's per-folder `catch` body to the end of that
  // function: the trigger has to live after it (in `finally`), because a
  // `fetchAllFolderHeaders` that threw may already have committed batches.
  periodicSyncAfterCatch: () =>
    sliceBetween(source, 'logPeriodic.warn(`Periodic sync failed for folder', 'async function runOneAccountPeriodicSync'),
  // Module scope, ahead of `whenReady` and of anything that can sync.
  startupSeed: () =>
    sliceBetween(source, '// --- Static mail rules ---', 'async function executeRuleAction'),
}

describe('main.ts §2.86 — known message-persisting exits trigger the rule pipeline', () => {
  it('net:inboxSummaries handler calls processMailRules', () => {
    // This handler already had a rule tail before §2.86 — it is listed here to
    // pin it, not because it was one of the leaks.
    expect(slices.inboxSummaries()).toContain('processMailRules(')
  })

  it('net:folderPage handler calls processMailRules (2026-07-30 leak: pagination persisted headers with no rule tail)', () => {
    expect(slices.folderPage()).toContain('processMailRules(')
  })

  it('the FLAGS-only sync early-return branch calls processMailRules BEFORE returning, not after (a call after the return would be dead code)', () => {
    expect(slices.flagsOnlyBranch()).toContain('processMailRules(')
  })

  it('the full-sync trigger sits in `finally`, so a sync that throws after committing batches still evaluates rules (§2.86 iter2, finding 6)', () => {
    // The first cut put this call at the tail of the `try`; the `catch`
    // rethrows, so a sync that failed after persisting batches never reached
    // it — while those batches were already in the cache.
    expect(slices.fullSyncFinally()).toContain('processMailRules(')
  })

  it('search:remoteSearch calls processMailRules after hydrating server hits into the cache (§2.86 iter2, finding 7)', () => {
    // `fetchSummariesByUids` upserts, so this handler is a message-persisting
    // exit exactly like the sync paths.
    expect(slices.remoteSearch()).toContain('processMailRules(')
  })

  it('the periodic background sync calls processMailRules per folder, after the per-folder catch (§2.86 iter2, finding 1)', () => {
    // This loop is a SEPARATE sync path from `net:syncFolderHeaders` and runs
    // with no user present. Without a trigger here, a user who never opens a
    // folder in the UI got no static rules at all. It must be reachable from
    // the failing branch too, hence the slice starting at the `catch` body.
    expect(slices.periodicSyncAfterCatch()).toContain('processMailRules(')
  })

  it('seeds the rule watermark for every known folder at module scope, before any sync can run (§2.86 iter2, finding 2)', () => {
    // The runner's lazy baseline runs AFTER a fetch has persisted its batch, so
    // on the first launch of this build `MAX(uid)` would already include mail
    // that had just arrived — declared old forever. The seed therefore has to
    // happen earlier than anything that can sync, which is why it is a
    // module-scope statement and not a `whenReady` callback. Coverage of the
    // seed itself (which folders it anchors, and at what) lives in
    // `packages/db/index.test.ts`; this only pins WHERE it is called.
    expect(slices.startupSeed()).toContain('seedMailRulesStateFromCache()')
  })
})

describe('main.ts §2.86 — mutation control (proves the checks above can actually fail)', () => {
  // Each case here re-derives the same slice as the corresponding assertion
  // above, then removes the exact call text a regression would remove, and
  // asserts the mutated copy fails the same `toContain` check. This never
  // touches the file on disk — it operates on the in-memory string only.

  function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /** Regex for one fire-and-forget call site, identified by its log message. */
  function callRe(logMessage: string, args = 'id, parsedFolder'): RegExp {
    return new RegExp(
      `processMailRules\\(${escapeRe(args)}\\)\\.catch\\(err =>\\n\\s*logRules\\.error\\('${escapeRe(logMessage)}', err\\)\\n\\s*\\)\\n`
    )
  }

  function expectMutationRemovesCall(body: string, re: RegExp): void {
    expect(body).toContain('processMailRules(') // sanity: real source passes
    const mutated = body.replace(re, '')
    expect(mutated).not.toBe(body) // sanity: the mutation actually changed something
    expect(mutated).not.toContain('processMailRules(')
  }

  it('inboxSummaries check fails once the processMailRules call is removed', () => {
    expectMutationRemovesCall(
      slices.inboxSummaries(),
      callRe('Background processMailRules (inboxSummaries) failed:'),
    )
  })

  it('folderPage check fails once the processMailRules call is stripped from a mutated copy', () => {
    expectMutationRemovesCall(
      slices.folderPage(),
      callRe('Background processMailRules (folderPage) failed:'),
    )
  })

  it('FLAGS-only branch check fails once the processMailRules call is removed from before the early return', () => {
    // This is the exact regression the assertion guards against: moving (or
    // deleting) the call so nothing between `syncSucceeded = true` and the
    // early `return` invokes the rule pipeline — the FLAGS-only sync would
    // once again leak messages past static rules.
    expectMutationRemovesCall(
      slices.flagsOnlyBranch(),
      callRe('Background processMailRules (FLAGS-only sync) failed:'),
    )
  })

  it('full-sync check fails once the processMailRules call is moved out of `finally` (i.e. off the throwing path)', () => {
    expectMutationRemovesCall(
      slices.fullSyncFinally(),
      callRe('Background processMailRules failed:'),
    )
  })

  it('remoteSearch check fails once the processMailRules call is removed', () => {
    expectMutationRemovesCall(
      slices.remoteSearch(),
      callRe('Background processMailRules (remoteSearch) failed:'),
    )
  })

  it('periodic-sync check fails once the processMailRules call is removed from the per-folder loop', () => {
    expectMutationRemovesCall(
      slices.periodicSyncAfterCatch(),
      callRe('Background processMailRules (periodic sync) failed:', 'aid, folder'),
    )
  })

  it('startup-seed check fails once the seed call is removed', () => {
    const body = slices.startupSeed()
    expect(body).toContain('seedMailRulesStateFromCache()') // sanity: real source passes

    const mutated = body.replace(/const seeded = seedMailRulesStateFromCache\(\)\n/, '')
    expect(mutated).not.toBe(body) // sanity: the mutation actually changed something
    expect(mutated).not.toContain('seedMailRulesStateFromCache()')
  })
})

/**
 * §2.162 — the two enforcement points that live in `electron/main.ts`.
 *
 * The DECISION is a pure function in `packages/core` and is covered
 * behaviourally in `packages/core/mailRules.test.ts`; what cannot be covered
 * there is whether main.ts actually asks it. Same technique and same limits as
 * the §2.86 block above: structural, with a mutation control per assertion.
 */
const guardSlices = {
  create: () =>
    sliceBetween(source, `handleIpc('rules:create'`, `handleIpc('rules:update'`),
  update: () =>
    sliceBetween(source, `handleIpc('rules:update'`, `handleIpc('rules:delete'`),
  // Only up to the message loop: the check has to happen BEFORE any message is
  // touched, so a call that appears after `for (const msg of messages)` must
  // not satisfy the assertion.
  applyToFolderPreamble: () =>
    sliceBetween(source, `handleIpc('rules:applyToFolder'`, 'for (const msg of messages)'),
  test: () =>
    sliceBetween(source, `handleIpc('rules:test'`, 'const messages = getMessagesForRuleTest'),
}

describe('main.ts §2.162 — rule save and retroactive apply ask the core decision', () => {
  it('rules:create validates before storing', () => {
    expect(guardSlices.create()).toContain('assertMailRuleAllowed(')
  })

  it('rules:update validates the rule as it will be after the patch, not the patch alone', () => {
    const body = guardSlices.update()
    expect(body).toContain('assertMailRuleAllowed(')
    // The stored halves must be read back, otherwise a patch that only swaps
    // the actions to `trash` sails past a stored legacy-`from` condition.
    expect(body).toContain('getMailRule(rid)')
  })

  it('rules:applyToFolder refuses BEFORE it touches any message', () => {
    expect(guardSlices.applyToFolderPreamble()).toContain('findEncodedMailRuleRefusal(')
  })

  it('rules:applyToFolder parses the stored rule structurally instead of casting it', () => {
    // `JSON.parse(row) as MailRule['conditions']` is what let a structurally
    // broken stored rule reach `matchRule` and throw there.
    const body = guardSlices.applyToFolderPreamble()
    expect(body).toContain('parseMailRuleParts(')
    expect(body).not.toContain('JSON.parse(ruleRow.conditions)')
  })

  it('rules:test parses the submitted conditions structurally too', () => {
    const body = guardSlices.test()
    expect(body).toContain('parseMailRuleParts(')
    expect(body).not.toContain('JSON.parse(parsed.conditions)')
  })

  it('the executor refuses an action it cannot actually perform', () => {
    // Depth for rows written before the shape check: a `move` with no target
    // and an action type with no branch both used to fall through to `break`,
    // so the executor reported success and the caller wrote a rule_log row for
    // work that never happened. Both must be distinguishable from success.
    const body = sliceBetween(source, 'async function executeRuleAction', '\n}\n')
    expect(body).toContain('mail rule move action has no target folder')
    expect(body).toContain('unsupported mail rule action type')
    expect(body).toMatch(/default: \{/)
  })

  it('the enforcement points import the decision from core rather than deciding locally', () => {
    // A second list of fields or destructive actions inside the hotspot is the
    // failure mode this pins: two lists drift, and the one in main.ts is the
    // one nobody updates.
    expect(source).toMatch(/import \{[^}]*parseMailRuleParts[^}]*\} from '\.\.\/packages\/core'/)
    expect(source).toMatch(/import \{[^}]*findEncodedMailRuleRefusal[^}]*\} from '\.\.\/packages\/core'/)
  })
})

describe('main.ts §2.162 — mutation control', () => {
  it('create check fails once the assertion call is removed', () => {
    const body = guardSlices.create()
    const mutated = body.replace('assertMailRuleAllowed(parsed.conditions, parsed.actions)', '')
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain('assertMailRuleAllowed(')
  })

  it('applyToFolder check fails once the refusal lookup is removed', () => {
    const body = guardSlices.applyToFolderPreamble()
    const mutated = body.replace(/const refusal = findEncodedMailRuleRefusal\([^)]*\)/, '')
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain('findEncodedMailRuleRefusal(')
  })
})

/**
 * §2.162 (review round 3) — `executeRuleAction`'s `switch` on `action.type`
 * must have a `default` case that THROWS, not one that falls through.
 *
 * Before this, a legacy row holding an action type `parseMailRuleParts` would
 * now reject (a row written before that check existed) reached the switch,
 * matched no `case`, and did NOTHING — while the caller still wrote a
 * `rule_log` row saying the action was applied. That is worse than a dropped
 * rule: an audit trail reporting work that never happened. This is structural,
 * not behavioural, for the same reason as the §2.86 / §2.162 blocks above —
 * `executeRuleAction` touches live IMAP collaborators and cannot be imported or
 * called directly from a test in this repo. The BEHAVIOURAL half — that the
 * runner counts a throwing action as failed rather than applied, and that a
 * `rule_log` row is never written for it — is covered by
 * `mailRulesRunner.test.ts` ("drops a rule whose action type the executor has
 * no branch for, before it can be logged as applied"), which injects a fake
 * `executeRuleAction` that throws to stand in for this real one.
 */
const executeRuleActionSwitch = () =>
  sliceBetween(source, 'async function executeRuleAction', 'const mailRulesInflight = new Set<string>()')

describe('main.ts §2.162 — executeRuleAction refuses an unknown action type instead of doing nothing', () => {
  it('the switch has a default case that throws', () => {
    const body = executeRuleActionSwitch()
    expect(body).toContain('default: {')
    expect(body).toContain("throw new Error('unsupported mail rule action type')")
  })

  it('mutation control: the assertion fails once the throw is replaced with a silent fall-through', () => {
    const body = executeRuleActionSwitch()
    const mutated = body.replace("throw new Error('unsupported mail rule action type')", '// no-op')
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain("throw new Error('unsupported mail rule action type')")
  })
})

/**
 * §2.203 — the `move` branch specifically, same depth-for-legacy-rows reason as
 * the `default` case above: `findMailRuleRefusal`/`parseMailRuleParts` refuse a
 * folderless `move` at save time now, but a row written before that check
 * existed can still hold one. Before this throw existed, `if (action.folder &&
 * action.folder !== folder)` treated an absent/blank folder as "nothing to do"
 * and fell through to `break` — success from the executor's point of view,
 * while the caller wrote a `rule_log` row for a move that never happened.
 *
 * The BEHAVIOURAL half (the runner counting this as a failed action, no
 * `rule_log` row) is out of reach here for the same reason as every other
 * `executeRuleAction` case — see the file-level doc above. §2.86-style: text
 * assertion with a matching mutation control, same technique as the block
 * above it.
 */
describe('main.ts §2.203 — executeRuleAction refuses a move with no target folder', () => {
  it('the move branch throws before attempting anything when the folder is missing or blank', () => {
    const body = executeRuleActionSwitch()
    expect(body).toContain("throw new Error('mail rule move action has no target folder')")
    // The check must run BEFORE the moveMessages call, not after — an empty
    // folder must never reach the IMAP client.
    const throwIdx = body.indexOf("throw new Error('mail rule move action has no target folder')")
    const moveCallIdx = body.indexOf('await moveMessages(cfg.imap, folder, action.folder')
    expect(throwIdx).toBeGreaterThan(-1)
    expect(moveCallIdx).toBeGreaterThan(-1)
    expect(throwIdx).toBeLessThan(moveCallIdx)
  })

  it('mutation control: the assertion fails once the folderless-move throw is removed', () => {
    const body = executeRuleActionSwitch()
    const mutated = body.replace(
      /if \(!action\.folder \|\| !action\.folder\.trim\(\)\) \{\s*throw new Error\('mail rule move action has no target folder'\)\s*\}/,
      '',
    )
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain("throw new Error('mail rule move action has no target folder')")
  })
})
