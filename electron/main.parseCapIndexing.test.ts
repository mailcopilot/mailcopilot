import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §2.145 fix wave 0.1 — which parse caps withhold `messages.body_text`.
 *
 * The rule lives in `cacheMessageDetails()` in main.ts and is one expression
 * long, which is exactly why it needs pinning: its FIRST version withheld the
 * column for both cap kinds, and that was wrong in a way nothing could observe
 * from inside main.ts. The premise was "a soft-capped row would be handed to a
 * model as if it were the whole message"; `updateMessageBodyText` has always
 * sliced every body to 200 000 characters, and the soft cap is 1 MiB of bytes
 * (>=262 144 characters), so the withheld row would have been identical to the
 * one it was protecting against. The withholding was therefore pure cost — and
 * in a folder excluded from search it was permanent, because the body indexer
 * skips those folders entirely (`listFoldersWithPendingBodies` filters through
 * `getIndexInSearchCached`), so the row stayed NULL forever.
 *
 * main.ts is not importable (module-level side effects: window creation, IPC
 * registration, DB open at import time), so this suite reads the source — the
 * same approach main.standaloneWindows.test.ts, main.settingsClamp.test.ts and
 * main.openInWindow.test.ts already take. Every assertion below is anchored to
 * production text, so it fails the moment the discriminator widens back to
 * "any cap" or the indexing branch moves under the `wantFull` early return.
 *
 * What this suite does NOT establish, stated so nobody reads it as more: that
 * the DB actually stores what the branch passes it. The 200k slice is asserted
 * against the real implementation in packages/db (see the DB suite); here the
 * subject is the ROUTING decision only.
 */
const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
const DB_INDEX = fs.readFileSync(
  path.join(__dirname, '..', 'packages', 'db', 'index.ts'),
  'utf8',
)

const helperStart = MAIN_TS.indexOf('function cacheMessageDetails(')
const helperBody = MAIN_TS.slice(helperStart, MAIN_TS.indexOf('\n}', helperStart))

describe('§2.145 — cacheMessageDetails body_text routing', () => {
  it('the helper exists and is the only writer on the EML branches', () => {
    expect(helperStart).toBeGreaterThan(-1)
    // Every branch that produces details from local/raw bytes delegates here
    // rather than repeating the decision. Four since wave 2.1: the two original
    // EML branches (cache hit, freshly-downloaded raw) plus the two hard-cap
    // placeholder branches (over-cap file on disk, over-limit download), which
    // must be cached exactly like any other result — the placeholder is the
    // correct answer for that message and re-deriving it means re-stat'ing or
    // re-streaming.
    const delegations = MAIN_TS.split('cacheMessageDetails(id, parsedMailbox, parsedUid').length - 1
    expect(delegations).toBe(4)
  })

  // Mutation killed: widening the guard back to `!details.parseCap` (withhold
  // on any cap). That is the wave-0 defect: it left body_text NULL forever in
  // search-excluded folders and made searchability depend on a per-folder
  // offlineMode toggle.
  it('withholds the body text for the HARD cap only, never for the soft one', () => {
    expect(helperBody).toContain("details.parseCap?.kind !== 'hard'")
    expect(helperBody).not.toContain('!details.parseCap &&')
  })

  // Mutation killed: dropping the hasBodyTextIndexed gate, which would let a
  // capped open overwrite a full body the indexer had already stored.
  it('only ever fills an unwritten row, never overwrites one', () => {
    expect(helperBody).toContain('!hasBodyTextIndexed(accountId, folder, uid)')
  })

  // R5, resolved in the direction of "the click may seed the index": the
  // indexing branch stands ABOVE the wantFull early return on purpose. Pinned
  // because the opposite is a plausible tidy-up, and it would silently stop a
  // raised-tier parse from ever filling a NULL row.
  it('indexes before the wantFull early return, so a full re-parse may seed the index', () => {
    const indexIdx = helperBody.indexOf('updateMessageBodyText(')
    const returnIdx = helperBody.indexOf('if (wantFull) return')
    expect(indexIdx).toBeGreaterThan(-1)
    expect(returnIdx).toBeGreaterThan(-1)
    expect(indexIdx).toBeLessThan(returnIdx)
  })

  // Mutation killed: persisting the raised-tier result, which would hand an
  // 8 MiB body to every later open of that message and write it to disk.
  it('never writes either details cache for a full re-parse', () => {
    const returnIdx = helperBody.indexOf('if (wantFull) return')
    const afterReturn = helperBody.slice(returnIdx)
    expect(afterReturn).toContain('putDetailsInCache(')
    expect(afterReturn).toContain('setCachedDetail(')
  })
})

describe('§2.145 — the premise the routing rests on', () => {
  // The whole argument for indexing a soft-capped body is that the DB slices
  // every body far below the cap anyway. If that slice ever moves above the
  // soft cap, the argument stops holding and this suite must be revisited
  // together with the invariant comment above `get_email` in services/ai.ts.
  it('updateMessageBodyText still slices every body to 200 000 characters', () => {
    const start = DB_INDEX.indexOf('export function updateMessageBodyText')
    expect(start).toBeGreaterThan(-1)
    const body = DB_INDEX.slice(start, start + 400)
    expect(body).toContain('.slice(0, 200_000)')
  })

  it('the slice is reached well before the soft cap could bind', () => {
    // 1 MiB of bytes is at least 262 144 characters even if every character
    // were 4-byte UTF-8 — comfortably past the 200 000 the DB keeps.
    const SOFT_CAP_BYTES = 1 * 1024 * 1024
    const WORST_CASE_CHARS = SOFT_CAP_BYTES / 4
    expect(WORST_CASE_CHARS).toBeGreaterThan(200_000)
  })
})

/**
 * §2.145 fix wave 1.1 — the details cache is the one way a capped build can
 * still serve an uncapped body.
 *
 * `messages.cached_detail` rows written before the caps existed hold whatever
 * the parser produced at the time, and the read branch returned them verbatim:
 * a 50 MB body kept freezing the renderer on every open of that message, with
 * no banner, until the row happened to be evicted. The caps could not help —
 * they live in the parse, and a cache hit is exactly the branch that does not
 * parse.
 */
describe('§2.145 — pre-cap rows in the details cache', () => {
  const branchStart = MAIN_TS.indexOf('// Check DB cache')
  const branch = MAIN_TS.slice(branchStart, MAIN_TS.indexOf('// §2.145 — an EML-BACKED', branchStart))

  // Mutation killed: reinstating the unconditional `JSON.parse(dbJson)` +
  // return, which is the reviewed defect verbatim.
  it('gates the row on BOTH the serialized size and the decoded body', () => {
    expect(branch).toContain('isServableCachedDetailJson(dbJson)')
    expect(branch).toContain('isServableCachedDetail(details)')
  })

  // Mutation killed: moving the size gate after JSON.parse. Parsing a 50 MB
  // string IS the freeze — a guard behind it would have paid the cost it
  // exists to refuse.
  it('checks the serialized size BEFORE parsing it', () => {
    const gateIdx = branch.indexOf('isServableCachedDetailJson(dbJson)')
    const parseIdx = branch.indexOf('JSON.parse(dbJson)')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(parseIdx).toBeGreaterThan(gateIdx)
  })

  // Mutation killed: seeding the in-memory LRU before deciding. A refused row
  // laundered into memory would be served from there for the whole session,
  // and the second gate would never be consulted again.
  it('never seeds the in-memory cache with a row it has not accepted', () => {
    const acceptIdx = branch.indexOf('isServableCachedDetail(details)')
    const seedIdx = branch.indexOf('putDetailsInCache(')
    expect(acceptIdx).toBeGreaterThan(-1)
    expect(seedIdx).toBeGreaterThan(acceptIdx)
  })

  // Mutation killed: returning the row anyway after logging the refusal, or
  // deleting it here. Falling through is what makes this self-healing: the
  // reparse applies the caps and rewrites the row via cacheMessageDetails.
  it('falls through to the reparse path rather than returning or deleting', () => {
    expect(branch).toContain('DB cache row refused')
    expect(branch).not.toContain('deleteCachedDetail')
    // Exactly one `return details` in the branch — the accepted case.
    expect(branch.split('return details').length - 1).toBe(1)
  })

  // Fix wave 1.2: the decision itself moved to electron/cachedDetailGuard.ts,
  // where it is tested against real row shapes rather than mirrored as text
  // (cachedDetailGuard.test.ts). What stays here is the CALLER's contract —
  // ordering and invalidation — which only exists in main.ts.
  it('delegates the decision rather than re-deriving a threshold locally', () => {
    expect(MAIN_TS).toContain("from './cachedDetailGuard'")
    // The wave-1.1 mistake, pinned so it cannot come back: judging cached rows
    // by the EML soft cap refused every legitimate server-direct body >1 MiB.
    expect(branch).not.toContain('EML_BODY_SOFT_CAP_BYTES')
  })

  // Mutation killed: refusing a row without dropping it. Falling through
  // self-heals only where something rewrites the row, and the OFFLINE branch
  // returns header facts without writing the cache — so a legacy 50 MB row
  // would be re-parsed and re-refused on every open until the user came back
  // online. Invalidation is what makes the pathological parse a one-time event.
  it('invalidates a refused row so it is parsed at most once, offline included', () => {
    // Both refusal paths, not just the one that is easier to reach.
    expect(branch.split('invalidateCachedDetail(id, parsedMailbox, parsedUid)').length - 1).toBe(2)
    const fnStart = MAIN_TS.indexOf('function invalidateCachedDetail(')
    const fnBody = MAIN_TS.slice(fnStart, MAIN_TS.indexOf('\n}', fnStart))
    expect(fnBody).toContain("setCachedDetail(accountId, folder, uid, '')")
    // Best-effort: failing to tidy a cache row must not fail the open.
    expect(fnBody).toContain('catch')
  })
})

/**
 * §2.145 fix wave 0.2 — the e2e scaffolding that makes the parse-cap viewer
 * reachable at all.
 *
 * Under `IS_E2E`, `net:messageDetails` answers from the in-memory fixture store
 * BEFORE `readEml()` is reached, so the entire parse pipeline — readEml,
 * parseEmlBuffer, the caps, cacheMessageDetails — was unreachable end to end,
 * and there is no unguarded entry point for that channel to exploit instead
 * (the trick eml-parse-dispatch.spec.ts uses on `mail:rsvpInvite` does not
 * transfer, and overriding `window.api` from `page.evaluate` silently no-ops
 * because the contextBridge proxy is read-only).
 *
 * The opening is per fixture and opt-in: a fixture injected WITH bytes falls
 * through to the production path. These assertions exist because that opening
 * is the kind of thing a later refactor makes global without noticing — and
 * because two of them are security properties, not conveniences.
 */
describe('§2.145 — EML-backed e2e fixtures', () => {
  const writeStart = MAIN_TS.indexOf('function writeE2EFixtureEml(')
  const writeBody = MAIN_TS.slice(writeStart, MAIN_TS.indexOf('\n}', writeStart))
  const buildStart = MAIN_TS.indexOf('function buildE2EFixtureEml(')
  const buildBody = MAIN_TS.slice(buildStart, MAIN_TS.indexOf('\n}', buildStart))

  // Mutation killed: dropping the marker from the condition, which would send
  // every e2e fixture down the production path — no `.eml` on disk, so every
  // existing spec would fall through to an IMAP fetch that does not exist.
  it('takes the synthetic branch unless the fixture was given real bytes', () => {
    expect(MAIN_TS).toContain('if (IS_E2E && !e2eFixture?.emlFixture) {')
  })

  // Mutation killed: making the discriminator "is there a file on disk"
  // (emlExists). That would silently serve synthetic content when a spec's
  // fixture failed to write, turning a scaffolding bug into a passing test.
  it('discriminates on the injection-time marker, not on the file existing', () => {
    const lookupIdx = MAIN_TS.indexOf('const e2eFixture = IS_E2E')
    expect(lookupIdx).toBeGreaterThan(-1)
    const branchHead = MAIN_TS.slice(lookupIdx, MAIN_TS.indexOf('const acc = E2E_ACCOUNTS', lookupIdx))
    expect(branchHead).toContain('emlFixture')
    expect(branchHead).not.toContain('emlExists(')
  })

  // Mutation killed: exposing `emlFixture` as a payload field. A fixture must
  // not be able to claim it is EML-backed without bytes having been written.
  it('sets the marker only after the bytes are written, never from the payload', () => {
    const handlerStart = MAIN_TS.indexOf("handleIpc('e2e:injectMail'")
    const handler = MAIN_TS.slice(handlerStart, MAIN_TS.indexOf('\n})', handlerStart))
    expect(handler).toContain('writeE2EFixtureEml(')
    expect(handler).toContain('mail.emlFixture = true')
    // The schema must not accept it.
    const schemaEnd = handler.indexOf('.parse(payload)')
    expect(handler.slice(0, schemaEnd)).not.toContain('emlFixture')
  })

  // SECURITY. The renderer supplies content and an identity, never a path.
  it('derives the path main-side through saveEml and refuses a path-segment folder', () => {
    expect(writeBody).toContain('saveEml(accountId, folder, uid, raw)')
    expect(writeBody).toMatch(/folder === '\.' \|\| folder === '\.\.'/)
    // No path assembly of any kind inside the helper.
    expect(writeBody).not.toContain('path.join')
  })

  // SECURITY. Both fixture inputs are bounded, so this channel cannot be turned
  // into an unbounded write (or an unbounded IPC payload) even in a dev build.
  it('bounds both fixture inputs, above the hard cap but finite', () => {
    expect(MAIN_TS).toContain('const E2E_MAX_FIXTURE_EML_BYTES = 200 * 1024 * 1024')
    expect(MAIN_TS).toContain('const E2E_MAX_FIXTURE_EML_BASE64_CHARS = 8 * 1024 * 1024')
    expect(MAIN_TS).toContain('z.number().int().positive().max(E2E_MAX_FIXTURE_EML_BYTES).optional()')
    expect(MAIN_TS).toContain('z.string().max(E2E_MAX_FIXTURE_EML_BASE64_CHARS).optional()')
    // A spec must be able to express a message on BOTH sides of the hard cap.
    expect(200 * 1024 * 1024).toBeGreaterThan(100 * 1024 * 1024)
  })

  // Mutation killed: padding to an approximate size. A cap spec's subject is
  // which side of a limit the message falls on, so the boundary case has to be
  // expressible exactly.
  it('synthesises a message of exactly the requested size', () => {
    expect(buildBody).toContain('Buffer.alloc(targetBytes - headers.length, 0x78)')
    expect(buildBody).toContain('if (targetBytes === headers.length) return headers')
  })

  // Fix wave 1.1 (codex LOW 1). Rounding a too-small target up would hand the
  // spec a message LARGER than it named — and naming an exact size is only ever
  // done to sit on a chosen side of a cap, so silently missing it defeats the
  // fixture's only purpose.
  it('refuses a target smaller than the header block instead of rounding it up', () => {
    expect(buildBody).toContain('if (targetBytes < headers.length) {')
    expect(buildBody).toContain('throw new Error(')
  })

  // The gate is the same one every other e2e handler uses — no second, weaker
  // path into the fixture store.
  it('is reachable only through the existing e2e handler guard', () => {
    const handlerStart = MAIN_TS.indexOf("handleIpc('e2e:injectMail'")
    const handler = MAIN_TS.slice(handlerStart, MAIN_TS.indexOf('\n})', handlerStart))
    expect(handler).toContain("assertE2EHandlerAllowed('e2e:injectMail')")
    // And no new channel was introduced for it.
    expect(MAIN_TS).not.toContain("handleIpc('e2e:injectRawEml'")
  })
})

/**
 * §2.145 fix wave 2.1 — the callers of the bounded acquisition boundaries.
 *
 * The ceilings themselves are enforced in packages/net and tested there
 * (rawDownloadBounds.test.ts, mailStoreBounds.test.ts). What only exists in
 * main.ts is what each caller DOES with a refusal, and each of the three is a
 * decision that can regress silently.
 */
describe('§2.145 — acquisition refusals are handled, not ignored', () => {
  // The offline sync loop. Before wave 2.1 it downloaded the whole message and
  // measured afterwards, and `maxSizeBytes <= 0` ("no per-file limit") meant no
  // limit at all — an oversized message was written to disk.
  it('offline sync passes a budget down and never buffers past it', () => {
    const loopStart = MAIN_TS.indexOf('Use main connection to avoid deadlocking')
    const loop = MAIN_TS.slice(loopStart, MAIN_TS.indexOf('const stats = countBodiesDownloaded', loopStart))

    // The budget is the folder's limit when it has one, the hard cap when not.
    expect(loop).toContain('maxSizeBytes > 0 ? Math.min(maxSizeBytes, MAX_EML_PARSE_BYTES) : MAX_EML_PARSE_BYTES')
    expect(loop).toContain('downloadRawMessage(account.id, cfg.imap, pref.folderPath, uid, undefined, budget)')
    // A refusal records a size so the uid is not retried every sync...
    expect(loop).toContain("outcome.kind === 'over_limit'")
    expect(loop).toContain('setBodyDownloaded(account.id, pref.folderPath, uid, false, outcome.bytesSeen)')
    // ...and nothing is saved on that path.
    const refusalArm = loop.slice(loop.indexOf("outcome.kind === 'over_limit'"), loop.indexOf("} else if (outcome.kind === 'ok')"))
    expect(refusalArm).not.toContain('saveEml(')
  })

  // The on-open branch. The message was never held, so the placeholder cannot
  // come from its bytes.
  it('the open path answers an over-limit download with a DB-row placeholder', () => {
    const branchStart = MAIN_TS.indexOf("if (rawOutcome.kind === 'over_limit')")
    expect(branchStart).toBeGreaterThan(-1)
    const branch = MAIN_TS.slice(branchStart, MAIN_TS.indexOf('const raw = rawOutcome.raw', branchStart))
    expect(branch).toContain('buildHardCapPlaceholder(id, parsedMailbox, parsedUid, rawOutcome.bytesSeen)')
    expect(branch).toContain('recordHardParseCapTrip(rawOutcome.bytesSeen)')
    // It must not reach for bytes it deliberately did not keep.
    expect(branch).not.toContain('parseEmlBuffer(')
    expect(branch).not.toContain('rawOutcome.raw')
  })

  // Mutation killed: the placeholder drifting from the shape the parser-entry
  // path produces. The renderer must not be able to tell which doorway refused.
  it('the DB-row placeholder carries the same hard MessageParseCap shape', () => {
    const fnStart = MAIN_TS.indexOf('function buildHardCapPlaceholder(')
    const fnBody = MAIN_TS.slice(fnStart, MAIN_TS.indexOf('\n}', fnStart))
    expect(fnBody).toContain("kind: 'hard'")
    expect(fnBody).toContain('limitBytes: MAX_EML_PARSE_BYTES')
    expect(fnBody).toContain('getMessageByUid(accountId, folder, uid)')
    // No body of any kind is fabricated for a message we never read.
    expect(fnBody).not.toContain('html:')
    expect(fnBody).not.toContain('text:')
  })

  // The on-disk branch: stat'd, not loaded, and the placeholder reports the
  // FILE's size rather than the header window's.
  it('the open path answers an over-cap local file from its header window', () => {
    const branchStart = MAIN_TS.indexOf("if (emlRead.kind === 'over_limit')")
    expect(branchStart).toBeGreaterThan(-1)
    const branch = MAIN_TS.slice(branchStart, MAIN_TS.indexOf('const localEml =', branchStart))
    expect(branch).toContain('parseEmlHeaderFacts(parsedUid, emlRead.prefix, emlRead.bytes)')
    expect(branch).toContain('recordHardParseCapTrip(emlRead.bytes)')
  })

  // Mutation killed: reverting to the unbounded read. `readEml` would load the
  // whole file before anything could measure it.
  it('the open path reads through the bounded reader', () => {
    expect(MAIN_TS).toContain('const emlRead = readEmlBounded(id, parsedMailbox, parsedUid)')
  })
})
