import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * electron/main.imapAuthLatchWiring.test.ts — structural wiring guard for the
 * per-account login latch (packages/net/authLoginLatch.ts).
 *
 * The latch's own admission/clearing rules are covered in
 * packages/net/authLoginLatch.test.ts, and the connection-boundary
 * enforcement (arming, gating, the interactive-tier exemption) is covered in
 * packages/net/imapAuthLatch.test.ts. Neither can see main.ts: it is a 10k+
 * LOC hotspot with module-load side effects nothing in this repo imports
 * directly (see electron/main.accountAuthStateWiring.test.ts and
 * electron/main.mailRulesWiring.test.ts for the established rationale), so
 * this inspects the ACTUAL SOURCE TEXT of the four places main.ts touches the
 * latch:
 *
 *   1. the periodic-sync folder loop stops walking the rest of an account's
 *      folders the moment a folder's error is either the latch's own
 *      synthetic refusal OR a fresh server-side auth rejection — one `break`
 *      guards both, because the FIRST real failure of a pass has not armed
 *      the latch yet (nothing to refuse the attempt with) and still deserves
 *      the same "stop wasting the walk" treatment as every attempt after it.
 *   2. that `break` sits inside the `catch`, not the `finally` — the
 *      `processMailRules` trigger and the body-indexer backoff reset in
 *      `finally` still run for the folder that just failed. Pinned by
 *      TEXTUAL POSITION (break appears before the loop's `finally`, and the
 *      `processMailRules` call is unconditional inside that `finally`) rather
 *      than a re-implementation of the loop: whether `break` inside a `catch`
 *      still runs an enclosing `finally` is JS language semantics, not
 *      something this project's code decides.
 *   3. `accounts:save` clears the latch AFTER `saveAccount` commits — new
 *      credentials are owed a real login at once, not the remainder of a
 *      backoff window earned by the credentials just replaced.
 *   4. both OAuth reconnect handlers (Gmail inline, Outlook delegated to
 *      outlookOAuthService) clear the latch UNCONDITIONALLY, even on the
 *      branch where `accountAuthState.noteSignedIn` is withheld because the
 *      IMAP side of the save never actually proved a login (a TLS cert
 *      needed acceptance first). That asymmetry is deliberate: the latch is
 *      about not hammering the OLD credentials, and by this point the
 *      account record already holds the new ones — but it is exactly the
 *      kind of thing a future "move it inside the `if`" edit gets tempted to
 *      align with `noteSignedIn`, so it is pinned by exact adjacent text.
 */

const MAIN_TS_PATH = path.join(__dirname, 'main.ts')
const source = fs.readFileSync(MAIN_TS_PATH, 'utf8')

function sliceBetween(text: string, startAnchor: string, endAnchor: string): string {
  const startIdx = text.indexOf(startAnchor)
  if (startIdx === -1) throw new Error(`start anchor not found: ${startAnchor}`)
  const endIdx = text.indexOf(endAnchor, startIdx + startAnchor.length)
  if (endIdx === -1) throw new Error(`end anchor not found after start: ${endAnchor}`)
  return text.slice(startIdx, endIdx)
}

const slices = {
  syncOneAccountFoldersBody: () =>
    sliceBetween(
      source,
      'async function syncOneAccountFolders(aid: number, isTimedOut: () => boolean): Promise<void> {',
      'async function runOneAccountPeriodicSyncPass(',
    ),
  accountsSave: () =>
    sliceBetween(source, `handleIpc('accounts:save'`, `handleIpc('accounts:removePreview'`),
  googleConnect: () =>
    sliceBetween(source, `handleIpc('oauth:google:connect'`, `handleIpc('oauth:microsoft:connect'`),
  microsoftConnect: () =>
    sliceBetween(source, `handleIpc('oauth:microsoft:connect'`, '// --- TLS cert recovery'),
}

describe('main.ts — login latch import surface', () => {
  it('imports the discriminator and the clear helper from the connection boundary, not reimplements them', () => {
    // Membership, not position: main.accountAuthStateWiring.test.ts already
    // pins the order of this import list, and two tests pinning one list's
    // order are guaranteed to disagree the next time it grows.
    const importList = source.match(/import \{([^}]*)\} from '\.\.\/packages\/net\/imap'/)?.[1] ?? ''
    const names = importList.split(',').map((n) => n.trim())
    expect(names).toContain('isImapAuthBackoffError')
    expect(names).toContain('clearImapAuthLatch')
    // No local redefinition shadowing the boundary's helpers.
    expect(source).not.toMatch(/function (isImapAuthBackoffError|clearImapAuthLatch)\b/)
  })
})

describe('main.ts — periodic sync stops on a rejected login', () => {
  it('breaks the folder loop on the latch refusal OR a fresh server auth rejection, not on any other error', () => {
    const body = slices.syncOneAccountFoldersBody()
    const catchBlock = sliceBetween(
      body,
      'logPeriodic.warn(`Periodic sync failed for folder',
      '} finally {',
    )
    const guardIdx = catchBlock.indexOf(
      `if (isImapAuthBackoffError(err) || classifyImapError(err) === 'auth') {`,
    )
    expect(guardIdx).toBeGreaterThan(-1)

    // A `break` STATEMENT — alone on its own line — as opposed to the word
    // "break" appearing inside a `//` comment (the catch block's own comment
    // explains "`break` still runs `finally`", which would false-positive a
    // plain substring search).
    const breakStatementRe = /^[ \t]*break[ \t]*$/m

    // Nothing before the guard breaks the loop — an unrelated folder error
    // (network blip, mailbox-not-found) must still let the pass continue to
    // the next folder.
    expect(catchBlock.slice(0, guardIdx)).not.toMatch(breakStatementRe)

    // The guard's own body is where the loop actually stops.
    const afterGuard = catchBlock.slice(guardIdx)
    expect(afterGuard).toMatch(breakStatementRe)
    // Exactly one break statement in the whole catch — the guard is the only exit.
    expect(catchBlock.match(new RegExp(breakStatementRe, 'gm'))).toHaveLength(1)
  })

  it('runs `break` inside the catch, leaving the folder\'s finally (processMailRules, indexer backoff reset) untouched', () => {
    const body = slices.syncOneAccountFoldersBody()
    // `break` sits BEFORE this anchor — i.e. textually inside the catch —
    // proving the guard does not reach into (or replace) the finally below.
    const catchBlock = sliceBetween(
      body,
      'logPeriodic.warn(`Periodic sync failed for folder',
      '} finally {',
    )
    expect(catchBlock).toMatch(/^[ \t]*break[ \t]*$/m)

    // The finally itself — everything from `} finally {` to the end of the
    // sliced function body — still unconditionally triggers static mail
    // rules and the body-indexer backoff reset for the folder that just
    // failed. A `break` reachable from `catch` does not skip an enclosing
    // `finally` (JS language semantics); what IS a project decision is that
    // nothing here special-cases the auth-rejection path to bypass it.
    const finallyBlock = body.slice(body.indexOf('} finally {'))
    expect(finallyBlock).toContain('processMailRules(aid, folder)')
    expect(finallyBlock).toContain('noteFolderSynced(aid, folder)')
  })
})

describe('main.ts — the latch is cleared wherever the credentials actually changed', () => {
  it('accounts:save clears the latch after the new credentials are committed, not on the E2E stub branch', () => {
    const body = slices.accountsSave()
    const savedIdx = body.indexOf('const { id, previous: previousLogin } = await saveAccountGuarded(parsed, {')
    const clearIdx = body.indexOf('clearImapAuthLatch(id)')
    expect(savedIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(savedIdx)
    // Exactly one call — the E2E early-return branch above `saveAccount`
    // never reaches it, and reads the same guarantee from the other side:
    // an account id used purely for the E2E stub broadcast never touches the
    // production latch.
    expect(body.split('clearImapAuthLatch(').length - 1).toBe(1)
  })

  // The clear is CONDITIONAL, and the condition is the point. `accounts:save`
  // is also how an avatar colour and a signature are stored: those payloads
  // carry the whole account record with `pass: undefined`, so an unconditional
  // clear released the latch for an edit that changes nothing about the login
  // and let the storm resume on a mailbox with a stale password. The decision
  // itself is unit-tested in electron/accountSaveLoginChange.test.ts; what
  // cannot be tested there is that main.ts asks it at all.
  it('accounts:save only clears the latch when the login itself changed', () => {
    const body = slices.accountsSave()
    expect(body).toContain('if (accountSaveChangesLogin(parsed, previousLogin)) clearImapAuthLatch(id)')
  })

  it('accounts:save takes the previous record from saveAccountGuarded, which reads it BEFORE the save', () => {
    // The read-before-write order itself is exercised as real code in
    // electron/googleConnectPolicy.test.ts (saveAccountGuarded). What only this
    // file can see is that main.ts takes `previous` from that call rather than
    // from a second read taken after the write — after `saveAccount` every
    // comparison reads equal and the gate silently degrades into "never clear".
    const body = slices.accountsSave()
    expect(body).toContain('previous: previousLogin } = await saveAccountGuarded(parsed, {')
    expect(body).toContain('getAccountMeta,')
    expect(body).not.toMatch(/await saveAccount\(parsed\)/)
    expect(body).not.toMatch(/getAccountMeta\(parsed\.id\)/)
  })

  it('imports the decision instead of restating it inline', () => {
    expect(source).toContain("import { accountSaveChangesLogin } from './accountSaveLoginChange'")
  })

  it('the Gmail OAuth reconnect clears the latch unconditionally, even when noteSignedIn is withheld', () => {
    const body = slices.googleConnect()
    // Adjacent, un-braced statements: `noteSignedIn` is gated on the TLS-cert
    // escape hatch, `clearImapAuthLatch` is not — a future edit that wraps
    // both in the same `if` changes this exact text.
    expect(body).toContain(
      'if (!res.tlsCertRequired?.imap) accountAuthState.noteSignedIn(res.id)\n  clearImapAuthLatch(res.id)',
    )
  })

  it('the Outlook OAuth reconnect clears the latch unconditionally, even when noteSignedIn is withheld', () => {
    const body = slices.microsoftConnect()
    expect(body).toContain(
      'if (!res.tlsCertRequired?.imap) accountAuthState.noteSignedIn(res.id)\n  clearImapAuthLatch(res.id)',
    )
  })
})
