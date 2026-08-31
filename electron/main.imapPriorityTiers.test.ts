import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §2.17 Phase 1 — pins two things review found untested at the main.ts level:
 *
 *  1. Which of `buildOfflineFallback`'s three reasons ('offline' | 'timeout' |
 *     'unavailable') each of the five call sites passes. The whole point of
 *     the field is that "budget expired while online", "genuinely offline"
 *     and "the attempt failed and we do not know why" are told apart; a call
 *     site silently drifting back to the wrong reason is exactly the defect
 *     this task fixes, and nothing short of reading the actual call sites can
 *     catch that drift.
 *  2. Which tier (`imapInteractive` / `imapBackground` / `imapSync` /
 *     `withImapPriority('indexer', …)`) is assigned at the entry points named
 *     in the incident: the interactive open path, the offline body sync loop
 *     (the literal call site that queued the 10 941 ms `net:setSeen` behind
 *     31 EML downloads), the body indexer, the two mutating IPC handlers the
 *     user waits on directly, the periodic sync timer, and static mail rules.
 *
 * main.ts is not importable (module-level side effects: window creation, IPC
 * registration, DB open at import time) — this suite reads the source, the
 * same approach main.parseCapIndexing.test.ts, main.standaloneWindows.test.ts
 * and main.backgroundMail.test.ts already take for pinning main.ts internals.
 * Every assertion below is anchored to production text, so it fails the
 * moment a call site's reason or tier changes without a deliberate edit here.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
const OFFLINE_REPLAY_TS = fs.readFileSync(path.join(__dirname, 'services/offlineReplay.ts'), 'utf8')

function sliceFunction(marker: string): string {
  const start = MAIN_TS.indexOf(marker)
  if (start < 0) throw new Error(`marker not found: ${marker}`)
  const end = MAIN_TS.indexOf('\n}', start)
  return MAIN_TS.slice(start, end)
}

/** Slices an IPC handler body by its registration text, the way
 *  main.parseCapIndexing.test.ts / main.standaloneWindows.test.ts already do:
 *  handler bodies are arrow functions passed to `handleIpc()`, not named
 *  `function` declarations, so `sliceFunction`'s `function name(` marker
 *  doesn't apply to them. `\n})` is the closing of the arrow-function-plus-
 *  handleIpc-call, matching the codebase's own two-space indentation. */
function sliceHandler(channel: string): string {
  const start = MAIN_TS.indexOf(`handleIpc('${channel}'`)
  if (start < 0) throw new Error(`handler not found: ${channel}`)
  const end = MAIN_TS.indexOf('\n})', start)
  return MAIN_TS.slice(start, end)
}

describe('§2.17 Phase 1 — offlineFallbackReason at each buildOfflineFallback call site', () => {
  it('reason is a required parameter, not optional or defaulted', () => {
    const sig = sliceFunction('function buildOfflineFallback(')
    const sigHead = sig.slice(0, sig.indexOf('): MessageDetails | null'))
    // Neither `reason?:` nor a default value — a new call site cannot compile
    // without deciding what to tell the user, which is the property that
    // matters here (an optional-with-default would silently reintroduce the
    // original bug for any future branch).
    expect(sigHead).not.toMatch(/reason\?/)
    expect(sigHead).not.toMatch(/reason\s*=\s*['"]offline['"]/)
    expect(sigHead).toMatch(/reason: NonNullable<MessageDetails\['offlineFallbackReason'\]>/)
  })

  it('the workOffline branch (server never contacted) reports offline', () => {
    expect(MAIN_TS).toMatch(/Work-offline fallback for uid[\s\S]{0,120}buildOfflineFallback\(cached, 'offline'\)/)
  })

  it('the offline-mode raw-download timeout reports timeout, not offline', () => {
    expect(MAIN_TS).toMatch(/Offline-mode raw download timed out[\s\S]{0,200}buildOfflineFallback\(cached, 'timeout'\)/)
  })

  it('the normal-mode IMAP fetch timeout reports timeout, not offline', () => {
    expect(MAIN_TS).toMatch(/IMAP fetch timed out[\s\S]{0,200}buildOfflineFallback\(cached, 'timeout'\)/)
  })

  it('the catch-all (the body load threw) reports unavailable — neither offline nor timeout', () => {
    // The log line is emitted AFTER the fallback is built (only once
    // `fallback` is truthy), so the anchor order is reversed from the other
    // call sites — the build call comes first here.
    //
    // Fix wave: this branch used to say 'offline'. It catches EVERYTHING the
    // try block can throw — a rejected password, a TLS trust failure, a
    // vanished mailbox, `assertImapAuth` refusing before a socket opened —
    // and only the dead-network case makes "you are offline" true. The
    // expired-password case is the one that showed: the §2.165 "sign in
    // again" badge and a "you are offline" placeholder on one screen.
    //
    // The block is wider than the transport, too: saveEml, parseEmlBuffer,
    // the invite enrichment and the cache writes all sit inside the same try,
    // so a full disk arrives here with the message already downloaded. Hence
    // "Body load failed" in the log line and in the user-facing sentence —
    // naming the mail server would be a guess in exactly that case.
    expect(MAIN_TS).toMatch(/buildOfflineFallback\(cached, 'unavailable'\)[\s\S]{0,200}Body load failed for message/)
    expect(MAIN_TS).not.toMatch(/buildOfflineFallback\(cached, 'offline'\)[\s\S]{0,200}Body load failed for message/)
    // The catch parameter is named for what actually failed, not for the half
    // of the block that usually does.
    expect(MAIN_TS).toMatch(/catch \(bodyLoadErr\)/)
  })

  it("the ONLY 'offline' call site is work-offline mode — the one case we know for certain", () => {
    // `'offline'` is a claim, and the single situation in which we can make it
    // authoritatively is the user having asked for work-offline mode: the
    // server was never contacted, so "only headers are cached" is a fact
    // rather than a guess. Counting the call sites is what stops a future
    // branch from quietly reaching for the reassuring-sounding word again.
    const offlineSites = MAIN_TS.match(/buildOfflineFallback\([A-Za-z]+, 'offline'\)/g) || []
    expect(offlineSites).toHaveLength(1)
  })

  it('the catch-all classifies the error for the LOG only, never for the wording', () => {
    // classifyImapError is the project's single canonical classifier
    // (CLAUDE.md §5) and it is used here — but a misfiled class must cost
    // nothing, so it may reach the log line and must not reach a t() key or a
    // reason. Its 'network' bucket is the classifier's DEFAULT (unrecognised
    // errors land there) and the local `assertImapAuth` refusal is
    // deliberately outside it, so a per-class sentence would be a guess
    // dressed as a diagnosis.
    expect(MAIN_TS).toMatch(/Body load failed for message uid=\$\{parsedUid\} \(class=\$\{classifyImapError\(bodyLoadErr\)\}\)/)
    expect(MAIN_TS).not.toMatch(/buildOfflineFallback\([A-Za-z]+, classifyImapError/)
  })

  it('both minimal (no-cached-headers) fallback objects also carry reason: timeout', () => {
    // These are the objects returned when a timeout fires and there is no DB
    // row to fall back to (e.g. a message never synced yet) — the shape a
    // brand-new account actually hits. Both of the timeout branches build one;
    // neither of the offline branches does (an offline miss rethrows instead
    // — see the catch-all test above), so the count pins exactly two.
    const matches = MAIN_TS.match(/offlineFallback: true,\s*\n\s*offlineFallbackReason: 'timeout',/g) || []
    expect(matches).toHaveLength(2)
    // And the general offline-fallback shape never hardcodes the opposite
    // reason next to it.
    expect(MAIN_TS).not.toMatch(/offlineFallback: true,\s*\n\s*offlineFallbackReason: 'offline',/)
  })
})

describe('§2.17 Phase 1 — tier assigned at the entry points named in the incident', () => {
  it('the interactive open path (fetchMessageDetailsWithTimeout) uses the interactive tier', () => {
    const body = sliceFunction('async function fetchMessageDetailsWithTimeout(')
    expect(body).toMatch(/imapInteractive\(\(\) => fetchMessageDetails\(/)
  })

  it('the offline body sync loop — THE call site from the incident — uses the sync tier', () => {
    const body = sliceFunction('async function syncOfflineBodies(')
    expect(body).toMatch(/imapSync\(\(\) => downloadRawMessage\(/)
    // Not tagged interactive and not left unlabelled (which would rank as
    // `other`, still ahead of `sync` — see IMAP_PRIORITY_RANK).
    expect(body).not.toMatch(/imapInteractive\(\(\) => downloadRawMessage\(/)
  })

  it('the body indexer callback uses the lowest (indexer) tier', () => {
    expect(MAIN_TS).toMatch(/withImapPriority\('indexer', \(\) => fetchMessageBody\(/)
  })

  it('net:setSeen and net:setFlagged — the two handlers a user waits on directly — use the interactive tier', () => {
    expect(MAIN_TS).toMatch(/imapInteractive\(\(\) => setSeen\(cfg\.imap, parsedMailbox, parsedUids, parsedSeen, id\)\)/)
    expect(MAIN_TS).toMatch(/imapInteractive\(\(\) => setFlagged\(cfg\.imap, parsedMailbox, parsedUids, parsedFlagged, id\)\)/)
  })

  it('the periodic sync timer wraps its whole pass at the sync tier, not one call inside it', () => {
    const body = sliceFunction('async function runOneAccountPeriodicSync(')
    // Tagging the trigger rather than the shared helper: the same
    // `runOneAccountPeriodicSyncPass` stays unlabelled when a person asked
    // for it directly and only drops to `sync` when the timer did.
    expect(body).toMatch(/return imapSync\(\(\) => runOneAccountPeriodicSyncPass\(aid\)\)/)
  })

  it('static mail-rule actions run at the background tier, not interactive', () => {
    const body = sliceFunction('async function executeRuleAction(')
    expect(body).toMatch(/return imapBackground\(async \(\) => \{/)
    expect(body).not.toMatch(/imapInteractive/)
  })

  it('the three tier helpers all route through the single ambient-scope primitive', () => {
    // Nothing here should be re-deriving priority some other way (e.g. a
    // second AsyncLocalStorage, or an explicit opts.priority threaded by
    // hand) — every helper is `withImapPriority` under a descriptive name.
    expect(MAIN_TS).toMatch(/function imapInteractive<T>\(fn: \(\) => Promise<T>\): Promise<T> \{\s*\n\s*return withImapPriority\('interactive', fn\)/)
    expect(MAIN_TS).toMatch(/function imapBackground<T>\(fn: \(\) => Promise<T>\): Promise<T> \{\s*\n\s*return withImapPriority\('background', fn\)/)
    expect(MAIN_TS).toMatch(/function imapSync<T>\(fn: \(\) => Promise<T>\): Promise<T> \{\s*\n\s*return withImapPriority\('sync', fn\)/)
  })
})

/**
 * §2.17 Phase 1 fix wave (codex-bg-review LOW 1) — the tier-assignment suite
 * above pinned only the entry points named directly in the incident write-up.
 * A reviewer noted that leaving move, delete, attachments, remote search,
 * pagination, AI actions, the send-queue archive move and offline replay
 * unpinned meant reverting several of those wrappers independently would
 * leave the whole file green — the untested attachment download callback
 * (`setDownloadAttachmentCallback`) was the concrete demonstration. This
 * block closes that gap for every entry point that actually takes a lock;
 * see the `net:folderPage` case below for the two call sites that are
 * DELIBERATELY excluded, and why.
 */
describe('§2.17 Phase 1 — tier coverage for the rest of the named-but-unpinned entry points', () => {
  it('net:move (user-initiated move) uses the interactive tier', () => {
    const handler = sliceHandler('net:move')
    expect(handler).toMatch(/imapInteractive\(\(\) => moveMessages\(cfg\.imap, parsedFrom, parsedTo, parsedUids, id\)\)/)
  })

  it('net:delete (user-initiated delete) uses the interactive tier', () => {
    const handler = sliceHandler('net:delete')
    expect(handler).toMatch(/imapInteractive\(\(\) => deleteMessagesRemote\(cfg\.imap, parsedMailbox, parsedUids, id\)\)/)
  })

  it('net:saveAttachment and net:attachmentBase64 (attachment downloads) use the interactive tier', () => {
    const saveAttachment = sliceHandler('net:saveAttachment')
    const attachmentBase64 = sliceHandler('net:attachmentBase64')
    expect(saveAttachment).toMatch(/imapInteractive\(\(\) => downloadMessagePart\(/)
    expect(attachmentBase64).toMatch(/imapInteractive\(\(\) => downloadMessagePart\(/)
  })

  it('search:remoteSearch (both the UID search and the summary fetch) uses the interactive tier', () => {
    const handler = sliceHandler('search:remoteSearch')
    expect(handler).toMatch(/imapInteractive\(\(\) => imapSearchFolder\(/)
    expect(handler).toMatch(/imapInteractive\(\(\) => fetchSummariesByUids\(/)
  })

  it('net:folderPage (pagination) tags the call interactive but the tag is INERT on this path — deliberately, and the file says so', () => {
    // `fetchFolderSummariesPage` goes through `withDedicatedImapRetry`, which
    // opens its own connection and never touches either op lock — the same
    // reason `fetchAllFolderHeaders` is out of scope for this suite. Reverting
    // the `imapInteractive(...)` wrapper here changes nothing observable
    // through the scheduler, so this test cannot and does not claim ordering
    // for this path; it pins that the inertness is written down at the call
    // site, so a future reader (or a future call site that switches
    // `fetchFolderSummariesPage` onto the pooled connection family) doesn't
    // have to rediscover it. Text as of this test's writing — if the comment
    // is reworded without changing the underlying fact, update the match
    // rather than deleting the test.
    const handlerStart = MAIN_TS.indexOf("handleIpc('net:folderPage'")
    const handler = MAIN_TS.slice(handlerStart, MAIN_TS.indexOf('\n})', handlerStart))
    expect(handler).toMatch(/imapInteractive\(\(\) => fetchFolderSummariesPage\(/)
    expect(handler).toContain('INERT here')
    expect(handler).toContain('bypasses both op locks and the pool')
  })

  it('the send-queue archive-after-send move (processSendQueue) uses the background tier', () => {
    const body = sliceFunction('async function processSendQueue(')
    expect(body).toMatch(/imapBackground\(\(\) => moveMessages\(cfg\.imap, ref\.folder, ref\.archiveFolder, \[ref\.uid\], ref\.accountId\)\)/)
    expect(body).not.toMatch(/imapInteractive\(\(\) => moveMessages\(cfg\.imap, ref\.folder/)
  })

  it('offline replay (executeBatch) runs at the sync tier, scoped to the whole batch', () => {
    // §5 invariant: replay carries the user's own past intent and must
    // complete, but nobody is watching one particular op land — it must not
    // outrank the interactive open the way the incident's body-sync loop did.
    // Lives in electron/services/offlineReplay.ts, not main.ts.
    const start = OFFLINE_REPLAY_TS.indexOf('async function executeBatch(')
    expect(start).toBeGreaterThan(-1)
    const body = OFFLINE_REPLAY_TS.slice(start, OFFLINE_REPLAY_TS.indexOf('\n}', start))
    expect(body).toMatch(/return withImapPriority\('sync', \(\) => executeBatchOps\(cfg, folder, batch, accountId\)\)/)
  })

  it('AI mail-action apply (mail_action tool) scopes the WHOLE callback as interactive, not just its net calls', () => {
    // A person just confirmed this in the chat and is waiting on the
    // response — every IMAP call the callback makes on the way there
    // (including listMailboxes, a leaf nobody would think to tag by hand)
    // deserves the tier, which is why the wrap is on the callback, not on
    // each net call inside it.
    const start = MAIN_TS.indexOf('setMailActionCallback(async (input: MailActionApplyRequest) =>')
    expect(start).toBeGreaterThan(-1)
    const head = MAIN_TS.slice(start, start + 200)
    expect(head).toContain('imapInteractive(async () => {')
  })

  it('AI attachment tools (list + download) scope their WHOLE callback as interactive', () => {
    // Same reasoning as mail_action apply: a person asked the assistant about
    // this message and is waiting. The download callback in particular makes
    // TWO pooled calls (downloadMessagePart, then fetchMessageDetails for
    // metadata) and both must inherit the tier from the outer scope.
    const listStart = MAIN_TS.indexOf('setListAttachmentsCallback(async (accountId, folder, uid) =>')
    const downloadStart = MAIN_TS.indexOf('setDownloadAttachmentCallback(async (accountId, folder, uid, part) =>')
    expect(listStart).toBeGreaterThan(-1)
    expect(downloadStart).toBeGreaterThan(-1)
    expect(MAIN_TS.slice(listStart, listStart + 120)).toContain('imapInteractive(async () => {')
    expect(MAIN_TS.slice(downloadStart, downloadStart + 120)).toContain('imapInteractive(async () => {')
  })

  it('AI flag and move tools (mail_action-adjacent single-op callbacks) use the interactive tier', () => {
    const flagStart = MAIN_TS.indexOf('setFlagCallback(async (input: FlagRequest) =>')
    const moveStart = MAIN_TS.indexOf('setMoveCallback(async (input: MoveRequest) =>')
    expect(flagStart).toBeGreaterThan(-1)
    expect(moveStart).toBeGreaterThan(-1)
    const flagBody = MAIN_TS.slice(flagStart, MAIN_TS.indexOf('\n})', flagStart))
    const moveBody = MAIN_TS.slice(moveStart, MAIN_TS.indexOf('\n})', moveStart))
    expect(flagBody).toMatch(/imapInteractive\(\(\) => setFlagged\(cfg\.imap, input\.folder, input\.uids, input\.flagged, input\.accountId\)\)/)
    expect(moveBody).toMatch(/imapInteractive\(\(\) => moveMessages\(cfg\.imap, input\.fromFolder, input\.toFolder, input\.uids, input\.accountId\)\)/)
  })
})
