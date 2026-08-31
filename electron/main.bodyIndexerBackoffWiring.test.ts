import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * electron/main.bodyIndexerBackoffWiring.test.ts — structural wiring guard for
 * the §2.115 body-indexer backoff reset.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * §2.115 made the body indexer's tick adaptive: the delay backs off
 * 2s → 4 → 8 → … → 120s for as long as a tick finds nothing to do. That is
 * correct for a drained mailbox and wrong the moment new mail lands, because
 * freshly synced rows carry no `body_text` and are precisely the work the
 * curve backed away from. `resetBodyIndexerBackoff()` was exported for callers
 * that learn about new work through another route; until it is called from
 * somewhere, the ceiling IS the staleness of body search.
 *
 * This file pins WHERE it is called from, and — just as importantly — pins the
 * GUARD. An unguarded reset is not a smaller bug than a missing one: resetting
 * on every sync tick, rather than on a sync that actually committed rows,
 * defeats the whole backoff and puts back the wake-up cost §2.115 removed.
 *
 * ── Why source-text assertions and not behavioural tests ─────────────────
 * `electron/main.ts` is a 10k+ LOC hotspot with module-load side effects (IPC
 * registration, DB open, Sentry wiring) that no unit test in this repo imports
 * — see `main.settingsClamp.test.ts`, `main.periodicSync.test.ts` and
 * especially `main.mailRulesWiring.test.ts`, whose §2.86 rationale applies
 * verbatim here: the bug class is "a call site that does not exist", and a
 * hand-mirrored copy of the logic cannot catch it, because a mirror that
 * forgets to reproduce a call stays green forever. So we inspect the real
 * source text of the real file.
 *
 * The two call sites chosen are the two paths that commit message rows into the
 * cache with no user-visible sync of their own to piggyback on:
 *   1. `runSyncFolderHeaders`' tail `finally` — the exit for the interactive
 *      sync, the startup folder walk, and the sync the renderer runs in
 *      response to an IDLE `mail:exists`. Guard: `fetched > 0`.
 *   2. the periodic background sync's per-folder `finally` — the path with no
 *      user present at all. Guard: `committedRows > 0`.
 *
 * What this file does NOT prove:
 *   - That the list of call sites is complete. `net:folderPage`,
 *     `net:inboxSummaries` and `search:remoteSearch` also hydrate rows; they
 *     were deliberately left out (see the report/followup) and nothing here
 *     would notice a new persisting path added tomorrow. The consequence is
 *     bounded: a missed reset DELAYS the ramp reset, it does not lose work —
 *     a tick that eventually fires still finds the backlog and drains it.
 *   - That the reset shortens the ALREADY-ARMED timer. It does — but the proof
 *     is not here and cannot be: this file reads source text, and a schedule is
 *     only observable by running one. `resetBodyIndexerBackoff()` now re-arms
 *     the pending timeout instead of only assigning `nextDelayMs` (which
 *     `scheduleNext()` would have read no earlier than the next tick, so work
 *     made visible right after a reset was first fetched a full ceiling later —
 *     999 ms of a 1000 ms ceiling when that was measured). The re-arm and its
 *     hazards — a reset landing mid-tick, a burst of resets, a stopped indexer —
 *     live in `electron/services/bodyIndexer.ts` and are covered by the
 *     TIME-TO-FIRST-FETCH tests in `electron/services/bodyIndexer.test.ts`
 *     ("resetBodyIndexerBackoff pulls the next tick forward", "a burst of
 *     resets neither stacks timers nor pushes the tick out"). What this file
 *     still owns is the other half of the same guarantee: that main actually
 *     CALLS the reset, and only on a sync that committed rows.
 * ──────────────────────────────────────────────────────────────────────
 */

const MAIN_TS_PATH = path.join(__dirname, 'main.ts')
const source = fs.readFileSync(MAIN_TS_PATH, 'utf8')

/**
 * Slice `text` from the first occurrence of `startAnchor` up to the next
 * occurrence of `endAnchor` that follows it. Throws if either anchor is
 * missing — a missing anchor means the source shape drifted enough that this
 * test needs re-pointing, which must fail loudly rather than silently matching
 * nothing. Same helper contract as `main.mailRulesWiring.test.ts`.
 */
function sliceBetween(text: string, startAnchor: string, endAnchor: string): string {
  const startIdx = text.indexOf(startAnchor)
  if (startIdx === -1) throw new Error(`start anchor not found in electron/main.ts: ${startAnchor}`)
  const endIdx = text.indexOf(endAnchor, startIdx + startAnchor.length)
  if (endIdx === -1) throw new Error(`end anchor not found after start in electron/main.ts: ${endAnchor}`)
  return text.slice(startIdx, endIdx)
}

/**
 * Slices are anchored tightly to the exit they describe. A loose slice can
 * swallow the other call site (or the import) and let a mutated copy still
 * satisfy `toContain`, which would make the mutation controls below vacuous.
 */
const slices = {
  /**
   * The tail `finally` of `runSyncFolderHeaders`: from the rethrow that ends
   * the `catch` to the function's success tail. This is the only part of the
   * sync body that BOTH the throwing path and the normal path reach, which is
   * why the reset lives here rather than at the end of the `try`.
   */
  headerSyncFinally: () =>
    sliceBetween(source, 'throw syncErr', 'syncSucceeded = true\n  return { ok: true as const'),
  /**
   * The periodic loop's per-folder tail: from the `catch` body to the end of
   * the enclosing function. Starting at the `catch` proves the reset is also
   * reachable when `fetchAllFolderHeaders` threw after committing batches.
   */
  periodicSyncAfterCatch: () =>
    sliceBetween(source, 'logPeriodic.warn(`Periodic sync failed for folder', 'async function runOneAccountPeriodicSync'),
  /**
   * The periodic loop's batch callback, where `committedRows` is maintained.
   * Bounded by the options object that follows the callback so the slice
   * cannot reach the `finally` that consumes the counter.
   */
  periodicBatchCallback: () =>
    sliceBetween(source, 'let committedRows = 0', 'batchSize: 500'),
  /**
   * The `startBodyIndexer({ ... })` options object. Bounded by the closing
   * `})` of the call so the slice cannot reach unrelated code; anchored on the
   * call itself so a second `startBodyIndexer` added elsewhere would not
   * satisfy these assertions by accident.
   */
  indexerStartOptions: () =>
    sliceBetween(source, 'startBodyIndexer({', '\n    })'),
}

describe('main.ts §2.115 — sync paths that commit rows reset the body-indexer backoff', () => {
  it('imports resetBodyIndexerBackoff from the body indexer service', () => {
    // Pins the contract direction: main.ts consumes the exported reset rather
    // than reaching into indexer internals or re-implementing a schedule.
    expect(source).toContain('resetBodyIndexerBackoff')
    expect(source).toMatch(/import \{[^}]*resetBodyIndexerBackoff[^}]*\} from '\.\/services\/bodyIndexer'/)
  })

  it('runSyncFolderHeaders resets the backoff from its tail `finally`, so a sync that throws after committing batches still counts', () => {
    // Same placement rationale as the §2.86 rule trigger next to it: `fetched`
    // is assigned as batches commit, so a sync that failed afterwards has
    // already put unindexed rows in the cache.
    expect(slices.headerSyncFinally()).toContain('resetBodyIndexerBackoff()')
  })

  it('the header-sync reset is guarded by `fetched > 0`, not by "a sync ran"', () => {
    // THE point of the guard. An incremental sync that matched no new UIDs, and
    // the FLAGS-only branch (flag changes on already-indexed rows, `fetched`
    // stays 0), must leave the curve alone — otherwise every sync tick resets
    // the backoff and §2.115 buys nothing.
    expect(slices.headerSyncFinally()).toMatch(/if \(fetched > 0\) \{\s*try \{ resetBodyIndexerBackoff\(\) \}/)
  })

  it('the periodic background sync resets the backoff per folder, after the per-folder catch', () => {
    // A separate sync path from `net:syncFolderHeaders`, running with no user
    // present — this is how mail that arrived overnight reaches the cache.
    expect(slices.periodicSyncAfterCatch()).toContain('resetBodyIndexerBackoff()')
  })

  it('the periodic reset is guarded by rows actually committed, not by the folder being visited', () => {
    // A periodic pass walks every full/period folder on a fixed timer. Guarding
    // on the visit rather than on committed rows would peg the indexer near the
    // periodic interval forever.
    expect(slices.periodicSyncAfterCatch()).toMatch(/if \(committedRows > 0\) \{\s*try \{ resetBodyIndexerBackoff\(\) \}/)
  })

  it('counts committed rows AFTER applyFolderSyncBatch returns, so a failed transaction is not reported as new work', () => {
    const body = slices.periodicBatchCallback()
    expect(body).toContain('committedRows += batch.length')
    // Ordering is the assertion: the increment must follow the commit call, not
    // precede it. A throw inside applyFolderSyncBatch means the rows are not in
    // the cache and there is no new indexer work to announce.
    expect(body.indexOf('applyFolderSyncBatch(')).toBeLessThan(body.indexOf('committedRows += batch.length'))
  })

  it('both resets are wrapped so a scheduling hint can never fail a sync', () => {
    // Cheapness/containment contract: one assignment, no await, no I/O, and it
    // cannot propagate into the sync path. Same shape as the
    // `certRecovery.noteSyncSuccess` call in the same function.
    for (const body of [slices.headerSyncFinally(), slices.periodicSyncAfterCatch()]) {
      expect(body).toContain('try { resetBodyIndexerBackoff() } catch { /* never break sync */ }')
    }
    // And it must stay synchronous fire-and-forget — never awaited into a
    // blocking position, never given its own timer (that would be a second
    // scheduler in main.ts; scheduling belongs in bodyIndexer.ts).
    expect(source).not.toContain('await resetBodyIndexerBackoff')
    expect(source).not.toMatch(/setTimeout\([^)]*resetBodyIndexerBackoff/)
    expect(source).not.toMatch(/setInterval\([^)]*resetBodyIndexerBackoff/)
  })
})

describe('main.ts §2.115 — the indexer is started with its pause and offline guards connected', () => {
  /**
   * These two options are part of §2.115's acceptance ("проверка isPaused …
   * и isOffline остаются"), and `isPaused` had silently regressed to unwired:
   * the service documented a pause that production never triggered, so the
   * performance work was being judged against a mitigation that was not
   * connected. Nothing behavioural can catch that from a unit test — an option
   * that is simply absent produces no call, no log and no failure — so the
   * wiring is pinned structurally, like the call sites above.
   */

  it('passes isPaused, wired to the same header-sync gate the other background services use', () => {
    const body = slices.indexerStartOptions()
    expect(body).toContain('isPaused:')
    // Specifically isHeaderSyncActive(), not a fresh predicate: syncOfflineBodies
    // and runPeriodicSync already gate on it, and a second, differently-defined
    // notion of "sync in progress" is how these guards drift apart.
    expect(body).toMatch(/isPaused: \(\) => isHeaderSyncActive\(\)/)
  })

  it('passes isOffline as a live read, so toggling work-offline takes effect without a restart', () => {
    const body = slices.indexerStartOptions()
    // A thunk, not a value: `isOffline: getSettings().workOffline === true`
    // would freeze the setting as it was at app start.
    expect(body).toMatch(/isOffline: \(\) => getSettings\(\)\.workOffline === true/)
  })

  it('isHeaderSyncActive is exported and backed by a counter with a balanced decrement', () => {
    // The pause is only as good as the flag behind it. If `activeHeaderSyncs`
    // could leak a permanent +1, the indexer would pause forever and the
    // backlog would never drain — a worse failure than not pausing at all.
    expect(source).toMatch(/export function isHeaderSyncActive\(\) \{ return activeHeaderSyncs > 0 \}/)
    expect(source).toContain('activeHeaderSyncs++')
    // The decrement must sit in a `finally`, so a sync that throws still
    // releases the pause.
    expect(source).toMatch(/\} finally \{\n\s*activeHeaderSyncs--/)
  })
})

describe('main.ts §2.115 — mutation control (proves the checks above can actually fail)', () => {
  // Each case re-derives the same slice as its assertion, removes (or rewrites)
  // exactly what a regression would, and proves the assertion then fails. This
  // never touches the file on disk — it operates on the in-memory string only.

  const CALL = 'try { resetBodyIndexerBackoff() } catch { /* never break sync */ }'

  it('header-sync check fails once the reset call is removed', () => {
    const body = slices.headerSyncFinally()
    expect(body).toContain('resetBodyIndexerBackoff()') // sanity: real source passes
    const mutated = body.replace(
      /if \(fetched > 0\) \{\n\s*try \{ resetBodyIndexerBackoff\(\) \} catch \{ \/\* never break sync \*\/ \}\n\s*\}\n/,
      '',
    )
    expect(mutated).not.toBe(body) // sanity: the mutation changed something
    expect(mutated).not.toContain('resetBodyIndexerBackoff()')
  })

  it('periodic-sync check fails once the reset call is removed from the per-folder loop', () => {
    const body = slices.periodicSyncAfterCatch()
    expect(body).toContain('resetBodyIndexerBackoff()') // sanity
    const mutated = body.replace(
      /if \(committedRows > 0\) \{\n\s*try \{ resetBodyIndexerBackoff\(\) \} catch \{ \/\* never break sync \*\/ \}\n\s*\}\n/,
      '',
    )
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain('resetBodyIndexerBackoff()')
  })

  it('guard checks fail once the reset is made unconditional (the "resets on every sync tick" regression)', () => {
    // The failure mode this pair guards is NOT a missing call — it is a call
    // that fires when nothing arrived. Dropping the `if` keeps the call text
    // present, so only the guard assertions can catch it.
    const headerBody = slices.headerSyncFinally()
    const headerUnguarded = headerBody.replace(
      /if \(fetched > 0\) \{\n\s*(try \{ resetBodyIndexerBackoff\(\) \} catch \{ \/\* never break sync \*\/ \})\n\s*\}/,
      '$1',
    )
    expect(headerUnguarded).not.toBe(headerBody)
    expect(headerUnguarded).toContain(CALL) // the call survives the mutation
    expect(headerUnguarded).not.toMatch(/if \(fetched > 0\) \{\s*try \{ resetBodyIndexerBackoff\(\) \}/)

    const periodicBody = slices.periodicSyncAfterCatch()
    const periodicUnguarded = periodicBody.replace(
      /if \(committedRows > 0\) \{\n\s*(try \{ resetBodyIndexerBackoff\(\) \} catch \{ \/\* never break sync \*\/ \})\n\s*\}/,
      '$1',
    )
    expect(periodicUnguarded).not.toBe(periodicBody)
    expect(periodicUnguarded).toContain(CALL)
    expect(periodicUnguarded).not.toMatch(/if \(committedRows > 0\) \{\s*try \{ resetBodyIndexerBackoff\(\) \}/)
  })

  it('commit-ordering check fails once the counter is moved ahead of the transaction', () => {
    const body = slices.periodicBatchCallback()
    expect(body.indexOf('applyFolderSyncBatch(')).toBeLessThan(body.indexOf('committedRows += batch.length')) // sanity

    // Simulate the regression: count first, commit second.
    const mutated = body
      .replace(/\n\s*\/\/ Counted AFTER the commit returns[\s\S]*?committedRows \+= batch\.length\n/, '\n')
      .replace('applyFolderSyncBatch(', 'committedRows += batch.length\n          applyFolderSyncBatch(')
    expect(mutated).not.toBe(body)
    expect(mutated.indexOf('applyFolderSyncBatch(')).toBeGreaterThan(mutated.indexOf('committedRows += batch.length'))
  })

  it('isPaused check fails once the option is dropped from the start call (the exact regression found here)', () => {
    const body = slices.indexerStartOptions()
    expect(body).toContain('isPaused:') // sanity: real source passes
    // Reproduce the state main.ts was actually in: the option simply absent,
    // everything else intact. Nothing else in the file changes.
    const mutated = body.replace(/\n\s*isPaused: \(\) => isHeaderSyncActive\(\),/, '')
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain('isPaused:')
    expect(mutated).toContain('isOffline:') // the other guard survives — the mutation is targeted
  })

  it('isOffline check fails once the thunk is collapsed into a start-time value', () => {
    const body = slices.indexerStartOptions()
    const mutated = body.replace(
      'isOffline: () => getSettings().workOffline === true',
      'isOffline: getSettings().workOffline === true',
    )
    expect(mutated).not.toBe(body)
    expect(mutated).not.toMatch(/isOffline: \(\) => getSettings\(\)\.workOffline === true/)
  })

  it('containment check fails once the try/catch wrapper is stripped', () => {
    const body = slices.headerSyncFinally()
    expect(body).toContain(CALL) // sanity
    const mutated = body.replace(CALL, 'resetBodyIndexerBackoff()')
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain(CALL)
  })
})
