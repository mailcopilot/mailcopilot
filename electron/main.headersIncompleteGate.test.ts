import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A sync run that could not store every header it fetched must not promote
 * the folder to 'covered_full'.
 *
 * Why this matters is a property of two files at once, which is why it is
 * pinned here rather than left to the net-layer suite. `fetchAllFolderHeaders`
 * drops a FETCH response with no usable UID (it cannot be stored — see
 * `readServerUid`). The dropped UID does NOT come back on its own: `newUids`
 * is a local array rebuilt from scratch each run, and the floor of the next
 * run is `sinceUid`, which main.ts derives from the highest UID that actually
 * LANDED. A neighbour with a higher UID stores fine, carries the watermark
 * past the hole, and the message becomes unreachable for good.
 *
 * The net layer therefore reports `headersIncomplete`, and EVERY crawl-state
 * writer fed by a header fetch must honour it. There are three: the
 * interactive sync, the periodic background loop, and the FLAGS-only branch
 * that fetches headers for newly discovered UIDs. The latter two are the easy
 * ones to forget — both pin 'covered_full' on any non-skipped result, with no
 * crawled-count check to fall back on.
 *
 * main.ts is not importable (module-level side effects), so this suite reads
 * the source, like main.standaloneWindows.test.ts and
 * main.parseCapIndexing.test.ts. What it establishes is the ROUTING decision
 * only; that the flag is raised at all is asserted against the real
 * implementation in packages/net/imap.test.ts.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')

describe('main.ts — an incomplete header run does not advance crawl state', () => {
  it('gates the interactive sync `completed` flag on headersIncomplete', () => {
    expect(MAIN_TS).toContain('completed = !stalewipeSuspect && !result.headersIncomplete')
  })

  it('gates the periodic background sync crawl-state write on headersIncomplete', () => {
    expect(MAIN_TS).toContain("if (!result.skipped && !result.headersIncomplete) {")
  })

  it('gates the FLAGS-only sync crawl-state write on headersIncomplete', () => {
    // The third `fetchAllFolderHeaders` call site, and the easiest to miss:
    // the non-CONDSTORE FLAGS-only branch fetches full headers for the UIDs
    // its cache diff reports as new, then writes 'covered_full' with
    // watermark = getMaxUidForFolder. It does NOT have the
    // crawled-count-vs-exists check the interactive path falls back on, so
    // the flag is the only thing standing between a dropped UID and a folder
    // pinned as fully covered above the hole.
    expect(MAIN_TS).toContain('newResultHeadersIncomplete = Boolean(newResult.headersIncomplete)')
    expect(MAIN_TS).toContain('&& !newResultHeadersIncomplete')
  })

  it('every fetchAllFolderHeaders call site inspects the flag before the next one', () => {
    // Why per call site and not `gates.length >= callSites.length`: that
    // comparison is decorative. Three call sites already carry FOUR
    // `.headersIncomplete` references (the interactive path reads the flag
    // twice — once to gate, once to log), so a fourth call site that never
    // looks at its result still satisfies "at least as many gates as calls".
    //
    // Each call site is therefore checked inside its OWN region: from the call
    // to the next call (or end of file), which is exactly the span where its
    // result variable is the one in scope. Every way of adding an ungated call
    // site is red — appended at the end it opens a region with no reference at
    // all, and inserted between an existing call and its gate it cuts that
    // call's region short of the gate.
    const callSites = [...MAIN_TS.matchAll(/await fetchAllFolderHeaders\(/g)].map(m => m.index)
    expect(callSites).toHaveLength(3) // guards against the loop below going vacuous
    callSites.forEach((start, n) => {
      const region = MAIN_TS.slice(start, callSites[n + 1] ?? MAIN_TS.length)
      expect({ callSite: n, readsTheFlag: region.includes('.headersIncomplete') })
        .toEqual({ callSite: n, readsTheFlag: true })
    })
  })

  it('has no crawl-state promotion left that ignores the flag', () => {
    // Every place that writes status: 'covered_full' from a
    // fetchAllFolderHeaders result has to sit behind one of the three gates
    // above. Whether each call site reads the flag is the previous test's job;
    // this one censuses the promotions themselves, so a new WRITER (rather than
    // a new call site) also has to come past a human.
    const promotions = MAIN_TS.match(/status: 'covered_full'/g) ?? []
    // Two literal promotions exist — the FLAGS-only sync and the periodic
    // loop. The interactive path writes `status: newStatus`, derived from
    // `trulyComplete` and therefore from `completed` — the flag gated in the
    // first assertion.
    expect(promotions).toHaveLength(2)
    expect(MAIN_TS).toContain("const newStatus = trulyComplete ? 'covered_full' : 'covered_recent'")
    expect(MAIN_TS).toContain('const trulyComplete = completed &&')
  })
})
