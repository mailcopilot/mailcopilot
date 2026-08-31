import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as ts from 'typescript'

// The behavioural mirror at the bottom of this file instantiates the REAL
// account-auth-state service, which pulls the main-process logger, Sentry and
// metrics into the graph. Stubbed so the mirror exercises state transitions
// only. The source-text assertions above are unaffected — they read main.ts
// from disk.
vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('./sentry', () => ({ captureException: vi.fn() }))
vi.mock('./metrics', () => ({ recordEvent: vi.fn() }))

import { initAccountAuthState, type AccountAuthStatePayload } from './services/accountAuthState'

/**
 * electron/main.accountAuthStateWiring.test.ts — structural wiring guard for
 * the "this mailbox needs signing in again" flag (§2.157, re-wired by §2.165).
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * `electron/services/accountAuthState.test.ts` covers the STATE MACHINE in
 * isolation (thresholds, debounce, containment, the deletion race) via
 * dependency injection. It cannot cover the OTHER half: WHO reports outcomes to
 * it. That half is now an invariant rather than a list of call sites, and it is
 * the whole point of §2.165:
 *
 *     the IMAP connection/retry boundary reports; callers do not.
 *
 * §2.157 attached reporting to three chosen sync paths, all of them header
 * fetches. Two defects followed by construction: a mailbox with every folder on
 * manual sync ran none of the three, so a badge raised once could never come
 * down; and a repaired login waited up to a full periodic cycle to be noticed
 * while the user was already proving it worked through half a dozen other
 * paths. The fix moves reporting into `packages/net/imap` (wave A) and leaves
 * main.ts with ONE subscriber.
 *
 * That invariant is only worth anything if nothing creeps back on top of it:
 * the threshold is two, so a single surviving per-caller `noteFailure` stacked
 * on the boundary's own report raises the badge after ONE failed login. Hence
 * the negative assertions below — they are the load-bearing ones.
 *
 * `main.ts` is a 10k+ LOC hotspot with module-load side effects that no test in
 * this repo imports directly (see `main.mailRulesWiring.test.ts` for the
 * established rationale), so this inspects the ACTUAL SOURCE TEXT and pins:
 *   1. exactly one connection-outcome subscriber, registered at module scope
 *      (i.e. before any sync or IDLE can run) and forwarding both verdicts;
 *   2. none of the four formerly-wired sync paths reports anything any more,
 *      and `noteFailure` has no call site outside the subscriber;
 *   3. the two verdicts that legitimately live outside the boundary because
 *      they never reach it: `assertImapAuth` (a local precondition, rejected
 *      before any connection) and the OAuth reconnect handlers (verification on
 *      a throwaway connection with no account id attached);
 *   4. `accounts:remove` tears down per-account state only AFTER the deletion
 *      commits — the flag, the auth-refresh handler and the cert subscription
 *      alike.
 *
 * Each assertion has a matching mutation-control test that reintroduces or
 * strips the exact text and proves the assertion then fails — same discipline
 * as `main.mailRulesWiring.test.ts`.
 *
 * ── Fix wave 2 additions (cross-family review gaps) ─────────────────────
 * Two of the checks above only prove that a token appears in the source TEXT,
 * which a plausible mutation slips past: wrapping the subscriber registration
 * in `if (IS_E2E) { ... }` keeps every string check green while disabling
 * reporting in production. The `describe` below titled "AST-verified
 * subscriber shape" parses `main.ts` with the TypeScript compiler API and
 * asserts the registration is a real top-level statement (present directly in
 * `sourceFile.statements`, therefore not nested inside any `if`/block) whose
 * handler body is EXACTLY the two forwarding calls — nothing added before,
 * after, or inside either branch. That closes both the conditional-wrapping
 * mutation and every variant of "log the raw server error somewhere inside
 * the handler" (`console.warn(outcome.error)`, `captureException(outcome.error)`,
 * a destructured `const { error } = outcome` that dodges a textual
 * `outcome.error` grep) — all of them add a statement the AST shape check
 * rejects, regardless of what the leak is textually spelled.
 *
 * A second `describe` pins the escalation path added by fix wave 2 itself:
 * `net:idleStart`'s catch calls `noteIdleLoginRejected(id, idleGeneration, err)`
 * then rethrows `err` unchanged, and the named helper forwards all three
 * arguments to `accountAuthState.noteLoginRejected` and does nothing else.
 *
 * ── Fix wave 4 additions (identity, and the OAuth hole) ─────────────────
 * Verdicts now carry a generation stamp, and the service acts on one only while
 * the stamp matches the generation the id holds. Two halves of that live here
 * because they are wiring, not policy:
 *
 *   5. the generation PROVIDER is registered, at module scope, and STRICTLY
 *      BEFORE the outcome subscriber. An absent stamp is a mismatch by
 *      contract, so a provider registered late (or not at all) does not degrade
 *      the feature — it silences it completely. The order is therefore not
 *      cosmetic and is pinned by source position plus a mutation control.
 *   6. the two OAuth token paths raise the badge when there is no stored
 *      refresh token, BEFORE they throw, and the error they throw carries the
 *      shared discriminator rather than a bare `new Error`. Gmail's provider
 *      lives in main.ts (pinned textually here); Outlook's lives in its own
 *      service and is wired through a reporter slot main.ts fills at module
 *      scope (the behavioural half is in
 *      `electron/services/outlookOAuthService.test.ts`).
 * ──────────────────────────────────────────────────────────────────────
 */

const MAIN_TS_PATH = path.join(__dirname, 'main.ts')
const source = fs.readFileSync(MAIN_TS_PATH, 'utf8')

function sliceBetween(text: string, startAnchor: string, endAnchor: string): string {
  const startIdx = text.indexOf(startAnchor)
  if (startIdx === -1) throw new Error(`start anchor not found in electron/main.ts: ${startAnchor}`)
  const endIdx = text.indexOf(endAnchor, startIdx + startAnchor.length)
  if (endIdx === -1) throw new Error(`end anchor not found after start in electron/main.ts: ${endAnchor}`)
  return text.slice(startIdx, endIdx)
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

const slices = {
  subscriber: () =>
    sliceBetween(source, 'registerConnectionOutcomeHandler((outcome)', '\n})'),
  serviceInit: () => sliceBetween(source, 'const accountAuthState = initAccountAuthState({', '\n})'),
  assertImapAuth: () =>
    sliceBetween(source, 'function assertImapAuth(', 'function assertSmtpAuth('),
  // The four paths §2.157 used to report from. Named after what they were, so
  // a future reader can find the removed calls in the history.
  idleStart: () =>
    sliceBetween(source, `handleIpc('net:idleStart'`, `handleIpc('net:idleStop'`),
  syncFolderHeaders: () =>
    sliceBetween(source, `handleIpc('net:syncFolderHeaders'`, `async function runSyncFolderHeaders(`),
  runSyncFolderHeadersTail: () =>
    sliceBetween(source, 'if (syncSucceeded) {', 'const seenAt = getAccountSeenAt(id)'),
  // Same slice `main.mailRulesWiring.test.ts` uses for the periodic loop's rule
  // trigger — reused here to prove removing the §2.157 report left the §2.86
  // trigger untouched.
  periodicSyncFolder: () =>
    sliceBetween(source, 'logPeriodic.warn(`Periodic sync failed for folder', 'async function runOneAccountPeriodicSync'),
  periodicSyncWide: () =>
    sliceBetween(source, 'async function syncOneAccountFolders(', 'async function runOneAccountPeriodicSync'),
  accountsRemove: () =>
    sliceBetween(source, `handleIpc('accounts:remove'`, `handleIpc('oauth:google:connect'`),
  // Fix wave 5 — the teardown both removal paths share, and the store lookup
  // that decides whether the rejecting path is one of them.
  completeAccountRemoval: () =>
    sliceBetween(source, 'function completeAccountRemoval(id: number): void {', `\nhandleIpc('accounts:remove'`),
  accountRecordIsGone: () =>
    sliceBetween(source, 'function accountRecordIsGone(id: number): boolean {', '\n/**'),
  googleConnect: () =>
    sliceBetween(source, `handleIpc('oauth:google:connect'`, `handleIpc('oauth:microsoft:connect'`),
  microsoftConnect: () =>
    sliceBetween(source, `handleIpc('oauth:microsoft:connect'`, '\n})'),
  // Fix wave 2 — the module-scope helper `net:idleStart` calls to escalate a
  // rejected login. Bounded by the next function declaration so an
  // accidental extra statement appended after the intended one-liner is still
  // inside the slice.
  noteIdleLoginRejectedFn: () =>
    sliceBetween(
      source,
      'function noteIdleLoginRejected(accountId: number, accountGeneration: number | null, err: unknown): void {',
      '\nfunction errCodeOf(',
    ),
  // Fix wave 4 — the Gmail token provider, whose missing-refresh-token branch
  // is the second place that reports "this account cannot even try to log in".
  googleAccessToken: () =>
    sliceBetween(source, 'async function getGoogleAccessToken(', '\nfunction normalizeFingerprintSha256('),
}

describe('main.ts §2.165 — the connection boundary is the only writer', () => {
  it('registers exactly one connection-outcome subscriber', () => {
    // The boundary keeps a single slot and the last registration wins, so a
    // second call anywhere in main.ts would silently disable the first.
    expect(countOccurrences(source, 'registerConnectionOutcomeHandler(')).toBe(1)
    // Imported by name (no call parens), so the count above is calls only.
    expect(source).toContain('registerConnectionOutcomeHandler,')
  })

  it('registers at module scope, so no sync or IDLE can start unobserved', () => {
    // A verdict produced while no subscriber is installed is dropped silently
    // by the boundary, and the failures worth seeing are exactly the ones on
    // the first pass after launch. Column 0 == module scope: a registration
    // moved inside `app.whenReady`, an IPC handler or any other block would be
    // indented.
    expect(source).toMatch(/\nregisterConnectionOutcomeHandler\(\(outcome\)/)
    // …and after the service it forwards to exists.
    expect(source.indexOf('registerConnectionOutcomeHandler((outcome)')).toBeGreaterThan(
      source.indexOf('const accountAuthState = initAccountAuthState({'),
    )
  })

  it('forwards both verdicts, and only the id and the original error', () => {
    const body = slices.subscriber()
    expect(body).toContain('accountAuthState.noteSuccess(outcome.accountId, outcome.accountGeneration)')
    expect(body).toContain('accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)')
    // Success is gated on `outcome.ok`: a subscriber that reported success
    // unconditionally would clear the badge on every failed login.
    const okIdx = body.indexOf('if (outcome.ok)')
    expect(okIdx).toBeGreaterThan(-1)
    expect(body.indexOf('accountAuthState.noteSuccess(outcome.accountId, outcome.accountGeneration)')).toBeGreaterThan(okIdx)
    // …and `noteFailure` must be the ELSE branch of that same `if`, not an
    // unconditional second statement — the two textual `.toContain` /
    // `.indexOf` checks above cannot tell "if (ok) A; B" from "if (ok) A;
    // else B", and only the latter is correct: the former reports a failure
    // on EVERY outcome, success included, which raises the badge after a
    // single successful login just as fast as after two failed ones.
    expect(body).toContain('else accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)')
    // Nothing derived from the server's error text may be logged here — it
    // echoes the user name and host (CLAUDE.md §8).
    expect(body).not.toMatch(/log[A-Za-z]*\.(warn|error|info)\(/)
  })

  it('passes an account-existence lookup, so a verdict for a deleted account is droppable', () => {
    // The boundary cannot know which ids still exist; the service can, and only
    // because main.ts hands it this lookup.
    const body = slices.serviceInit()
    expect(body).toContain('accountExists:')
    expect(body).toContain('getAccountMeta(id) !== undefined')
  })
})

/**
 * Fix wave 4 — the generation provider, and the one thing about it that is not
 * a matter of taste: it must be registered BEFORE the outcome subscriber.
 *
 * The stamp contract is fail-quiet by design: an outcome the boundary cannot
 * attribute carries `accountGeneration: null`, and the service treats `null` as
 * a mismatch. That is the right failure direction (a badge that does not move
 * beats a badge that moves for the wrong mailbox) but it means a missing or
 * late provider does not degrade the feature — it turns it off, silently, with
 * every verdict still flowing and every test of the state machine still green.
 * Nothing at runtime can notice. So it is pinned here.
 */
describe('main.ts §2.165 (fix wave 4) — the generation provider is registered first', () => {
  it('registers exactly one provider, at module scope, forwarding to the service', () => {
    expect(countOccurrences(source, 'registerAccountGenerationProvider(')).toBe(1)
    // Imported by name from packages/net/imap alongside the other registries.
    expect(source).toContain('registerAccountGenerationProvider }')
    // Column 0 == module scope (same reasoning as the subscriber above).
    expect(source).toMatch(/\nregisterAccountGenerationProvider\(\(id\) => accountAuthState\.currentGeneration\(id\)\)/)
  })

  it('registers the provider BEFORE the outcome subscriber', () => {
    const providerIdx = source.indexOf('registerAccountGenerationProvider((id) => accountAuthState.currentGeneration(id))')
    const subscriberIdx = source.indexOf('registerConnectionOutcomeHandler((outcome)')
    expect(providerIdx).toBeGreaterThan(-1)
    expect(subscriberIdx).toBeGreaterThan(-1)
    expect(providerIdx).toBeLessThan(subscriberIdx)
    // …and both after the service they forward to exists.
    expect(providerIdx).toBeGreaterThan(source.indexOf('const accountAuthState = initAccountAuthState({'))
  })

  it('mutation: the order check fails once the two registrations are swapped', () => {
    const provider = 'registerAccountGenerationProvider((id) => accountAuthState.currentGeneration(id))'
    const subscriber = 'registerConnectionOutcomeHandler((outcome)'
    // The mutant registers the provider LATER — still at module scope, still
    // exactly once, so only the relative position changed.
    const mutated = `${source.replace(`${provider}\n`, '')}\n${provider}\n`
    expect(mutated).not.toBe(source)
    // The mutant still contains both registrations, still at module scope —
    // only their ORDER changed, which is exactly what the assertion above
    // measures.
    expect(countOccurrences(mutated, 'registerAccountGenerationProvider(')).toBe(1)
    expect(mutated.indexOf(provider)).toBeGreaterThan(mutated.indexOf(subscriber))
  })

  it('mutation: the presence check fails once the provider registration is dropped', () => {
    // The mutation with no runtime symptom: every verdict still arrives, every
    // one of them unattributable, and the badge never moves again.
    const mutated = source.replace(
      'registerAccountGenerationProvider((id) => accountAuthState.currentGeneration(id))\n',
      '',
    )
    expect(mutated).not.toBe(source)
    expect(countOccurrences(mutated, 'registerAccountGenerationProvider(')).toBe(0)
  })
})

/**
 * Fix wave 4 — the OAuth mailbox that could never show the badge.
 *
 * `getGoogleAccessToken` (here) and `getOutlookAccessToken` (in its own
 * service) reject while BUILDING a config when the account has no stored
 * refresh token: before `assertImapAuth` inspects credentials, before any
 * wrapped operation exists. Neither the precondition report nor the connection
 * boundary ever saw it, so the mailbox stopped syncing with nothing in the
 * window to say why. Both must raise the flag BEFORE they throw, and both must
 * throw the SHARED discriminator rather than a bare `new Error` — otherwise the
 * copies of this verdict that do travel through the boundary get classified as
 * 'network' by wording and dropped.
 */
describe('main.ts §2.165 (fix wave 4) — an OAuth account with no refresh token raises the flag', () => {
  it('the Gmail token path reports before it throws, and throws the discriminated error', () => {
    const body = slices.googleAccessToken()
    const reportIdx = body.indexOf('accountAuthState.noteMissingCredentials(accountId, accountGeneration)')
    const throwIdx = body.indexOf('throw authNotConfiguredError(`Google refresh token for account #${accountId} not found')
    expect(reportIdx).toBeGreaterThan(-1)
    expect(throwIdx).toBeGreaterThan(-1)
    // Order is load-bearing: every caller of this function catches the
    // rejection somewhere, and most only log it.
    expect(reportIdx).toBeLessThan(throwIdx)
    // No bare Error left on this path — that is the variant that silently
    // classifies as 'network'.
    expect(body).not.toContain('throw new Error(`Google refresh token')
  })

  it('the Gmail token path reads its stamp BEFORE the awaited secret-store lookup', () => {
    // Fix wave 5. The discovery below happens after an await, and ids are
    // reused: a mailbox deleted while the lookup is in flight hands its id to
    // the next account created, so an unstamped (or report-time-stamped) report
    // raises the badge on that new, healthy mailbox. A stamp read at report time
    // always matches and therefore proves nothing — the position is the whole
    // guarantee, which is why it is pinned rather than merely its presence.
    // The state-machine half of this is in
    // `electron/services/accountAuthState.test.ts`; the same sequence is
    // exercised end-to-end for the two Outlook token paths in
    // `electron/services/outlookOAuthService.test.ts` (main.ts cannot be
    // imported, so the Gmail provider can only be pinned structurally here).
    const body = slices.googleAccessToken()
    const stampIdx = body.indexOf('const accountGeneration = accountAuthState.currentGeneration(accountId)')
    const asyncBodyIdx = body.indexOf('const p = (async () => {')
    const lookupIdx = body.indexOf("await getOauthRefreshTokenWithSource('gmail', accountId)")
    expect(stampIdx).toBeGreaterThan(-1)
    expect(asyncBodyIdx).toBeGreaterThan(-1)
    expect(lookupIdx).toBeGreaterThan(-1)
    // Before the async body opens — hence before every await in this function.
    expect(stampIdx).toBeLessThan(asyncBodyIdx)
    expect(stampIdx).toBeLessThan(lookupIdx)
    // …and the service is not consulted again once the lookup has answered.
    expect(countOccurrences(body, 'accountAuthState.currentGeneration(')).toBe(1)
  })

  it('the Outlook service gets the same report through a registered slot, stamp included', () => {
    // Its token provider lives in a service that cannot import main.ts, so the
    // service owns the slot and main.ts fills it — at module scope, like the
    // other registries. Fix wave 5: the slot carries the stamp SOURCE as well,
    // because the provider has to read the generation before its own await; a
    // slot with only the report would be the unstamped path again.
    expect(countOccurrences(source, 'registerMissingCredentialsReporter(')).toBe(1)
    expect(source).toContain(
      'registerMissingCredentialsReporter({\n' +
      '  currentGeneration: (id) => accountAuthState.currentGeneration(id),\n' +
      '  noteMissingCredentials: (id, generation) => accountAuthState.noteMissingCredentials(id, generation),\n' +
      '})',
    )
    // Column 0 == module scope (same reasoning as the other registries).
    expect(source).toMatch(/\nregisterMissingCredentialsReporter\(\{/)
  })

  it('mutation: the Gmail stamp check fails once the read moves inside the async body', () => {
    // The mutant with the right shape and the wrong timing — the exact defect
    // this wave closes: a generation read after the await describes whichever
    // mailbox holds the id by then, so it always matches.
    const body = slices.googleAccessToken()
    const stamp = 'const accountGeneration = accountAuthState.currentGeneration(accountId)'
    const mutated = body
      .replace(`  ${stamp}\n`, '')
      .replace(
        'accountAuthState.noteMissingCredentials(accountId, accountGeneration)',
        'accountAuthState.noteMissingCredentials(accountId, accountAuthState.currentGeneration(accountId))',
      )
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain(stamp)
    expect(mutated.indexOf('accountAuthState.currentGeneration(accountId)')).toBeGreaterThan(
      mutated.indexOf('const p = (async () => {'),
    )
  })

  it('mutation: the Outlook slot check fails once the stamp source is dropped from it', () => {
    // A slot that only carries the report compiles on the service side (the
    // provider would fall back to `null`), and `null` is a mismatch — so the
    // mutant silently turns the Outlook badge off rather than misfiring it.
    const registration =
      'registerMissingCredentialsReporter({\n' +
      '  currentGeneration: (id) => accountAuthState.currentGeneration(id),\n' +
      '  noteMissingCredentials: (id, generation) => accountAuthState.noteMissingCredentials(id, generation),\n' +
      '})'
    expect(source).toContain(registration)
    const mutated = source.replace(
      registration,
      'registerMissingCredentialsReporter({\n' +
      '  noteMissingCredentials: (id, generation) => accountAuthState.noteMissingCredentials(id, generation),\n' +
      '})',
    )
    expect(mutated).not.toBe(source)
    expect(mutated).not.toContain(registration)
  })

  it('mutation: the Gmail check fails once the report is dropped or moved after the throw', () => {
    const body = slices.googleAccessToken()
    const report = 'accountAuthState.noteMissingCredentials(accountId, accountGeneration)'
    const withoutReport = body.replace(`${report}\n`, '')
    expect(withoutReport).not.toBe(body)
    expect(withoutReport).not.toContain(report)

    // …and the subtler one: reported, but only after the throw, i.e. never.
    const throwLine = 'throw authNotConfiguredError(`Google refresh token for account #${accountId} not found (re-authorization required)`)'
    const reordered = withoutReport.replace(throwLine, `${throwLine}\n      ${report}`)
    expect(reordered).not.toBe(withoutReport)
    expect(reordered.indexOf(report)).toBeGreaterThan(reordered.indexOf(throwLine))
  })

  it('mutation: the Gmail check fails once the discriminated error becomes a bare one', () => {
    const body = slices.googleAccessToken()
    const mutated = body.replace(
      'throw authNotConfiguredError(`Google refresh token',
      'throw new Error(`Google refresh token',
    )
    expect(mutated).not.toBe(body)
    expect(mutated).toContain('throw new Error(`Google refresh token')
  })
})

/**
 * Fix wave 2 — AST-verified shape of the subscriber registered above.
 *
 * `sliceBetween` + `toContain` proves a token is present in the source TEXT.
 * It cannot prove WHERE in the control flow that token lives: wrapping the
 * whole registration in `if (IS_E2E) { ... }` leaves every string check above
 * green (the call is still there, still followed by the service init, still
 * textually "after" it) while turning off reporting in every real build.
 * Likewise, a leak of the raw error — `console.warn(outcome.error)`,
 * `captureException(outcome.error)`, a `const { error } = outcome` that never
 * spells the literal substring `outcome.error` — only has to avoid the ONE
 * regex above (`/log[A-Za-z]*\.(warn|error|info)\(/`) to pass silently.
 *
 * Both close the same way: parse `main.ts` with the TypeScript compiler API
 * and check the SHAPE of the syntax tree, not its text.
 *   - "top-level, unconditional" is not a string pattern — it is "this
 *     `ExpressionStatement` is a direct member of `sourceFile.statements`",
 *     which by construction excludes anything nested inside an `if`, a block,
 *     a function, or a ternary passed as the argument itself.
 *   - "the handler does nothing but forward" is not "these two substrings are
 *     present somewhere" — it is "the arrow function's body has exactly one
 *     statement, and that statement is the `if`/`else` with exactly these two
 *     calls as its branches, each unwrapped or a single-statement block".
 *     Any additional statement — before the `if`, after it, or stuffed into
 *     either branch as a second line inside `{ }` — changes the statement
 *     count and fails the shape check, regardless of what that statement
 *     is textually.
 */
describe('main.ts §2.165 — AST-verified subscriber shape (structural, not textual)', () => {
  /**
   * Locate the arrow function passed to `registerConnectionOutcomeHandler`
   * ONLY if that call is a direct top-level statement of the module — i.e.
   * present in `sourceFile.statements`, not nested inside any `if`, block or
   * conditional expression. Returns null if no such top-level call exists
   * (wrapped in a conditional, turned into a variable + call, etc.) or if the
   * argument is not an arrow/function expression with a block body.
   */
  function getTopLevelSubscriberBody(sourceText: string): ts.Block | null {
    const sourceFile = ts.createSourceFile(
      'main.ts',
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    )
    for (const stmt of sourceFile.statements) {
      if (!ts.isExpressionStatement(stmt)) continue
      const expr = stmt.expression
      if (!ts.isCallExpression(expr)) continue
      if (!ts.isIdentifier(expr.expression)) continue
      if (expr.expression.text !== 'registerConnectionOutcomeHandler') continue
      const [handler] = expr.arguments
      if (!handler) return null
      if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return null
      if (!ts.isBlock(handler.body)) return null
      return handler.body
    }
    return null
  }

  /** A statement, or — if it is a single-statement block — that one
   *  statement. Returns null for anything else (multi-statement block, no
   *  statement at all), so a branch that grew a second line no longer
   *  unwraps to a single call. */
  function unwrapSingleStatement(stmt: ts.Statement | undefined): ts.Statement | null {
    if (!stmt) return null
    if (!ts.isBlock(stmt)) return stmt
    return stmt.statements.length === 1 ? stmt.statements[0] : null
  }

  /** Exact source text of a bare `expr.stmt;`-shaped statement, or null if the
   *  statement is not a plain expression statement (covers the "unwraps to
   *  null" case above too, since `unwrapSingleStatement` already filtered). */
  function callText(stmt: ts.Statement | null): string | null {
    if (!stmt || !ts.isExpressionStatement(stmt)) return null
    return stmt.expression.getText()
  }

  it('the registration is a real top-level statement whose handler is EXACTLY the if/else forwarding, nothing more', () => {
    const body = getTopLevelSubscriberBody(source)
    expect(body).not.toBeNull()
    // Exactly one statement in the handler body — no leak statement anywhere
    // in the block, before or after the if/else.
    expect(body!.statements.length).toBe(1)
    const ifStmt = body!.statements[0]
    expect(ts.isIfStatement(ifStmt)).toBe(true)
    if (!ts.isIfStatement(ifStmt)) return
    expect(ifStmt.expression.getText()).toBe('outcome.ok')
    expect(callText(unwrapSingleStatement(ifStmt.thenStatement))).toBe(
      'accountAuthState.noteSuccess(outcome.accountId, outcome.accountGeneration)',
    )
    expect(ifStmt.elseStatement).toBeDefined()
    expect(callText(unwrapSingleStatement(ifStmt.elseStatement))).toBe(
      'accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)',
    )
  })

  it('mutation: wrapping the registration in `if (IS_E2E) { ... }` is no longer found as a top-level call', () => {
    // The exact mutation the reviewer named: the string checks in the
    // describe above all still pass on this mutant (the call is still there,
    // still followed by the service init) — only the AST walk, which only
    // ever looks at `sourceFile.statements`, notices the call moved one level
    // deeper.
    const original =
      'registerConnectionOutcomeHandler((outcome) => {\n' +
      '  if (outcome.ok) accountAuthState.noteSuccess(outcome.accountId, outcome.accountGeneration)\n' +
      '  else accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)\n' +
      '})'
    expect(source).toContain(original)
    const wrapped = `if (IS_E2E) {\n${original}\n}`
    const mutated = source.replace(original, wrapped)
    expect(mutated).not.toBe(source)
    // The old string-based checks are unaffected by this mutation…
    expect(mutated).toContain('registerConnectionOutcomeHandler((outcome)')
    expect(mutated).toContain('accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)')
    // …but the AST check catches it: no top-level call survives.
    expect(getTopLevelSubscriberBody(mutated)).toBeNull()
  })

  it('mutation: an extra statement leaking the raw error inside the else branch fails the shape check', () => {
    // Covers every textual disguise a leak can take — `console.warn`,
    // `captureException`, `reportNetError`, or a destructured `const { error
    // } = outcome` that never spells `outcome.error` at all. All of them add
    // a second statement to a branch that must contain exactly one.
    const originalElse = 'else accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)'
    expect(source).toContain(originalElse)
    const leaking =
      'else {\n' +
      '    accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)\n' +
      '    console.warn(outcome.error)\n' +
      '  }'
    const mutated = source.replace(originalElse, leaking)
    expect(mutated).not.toBe(source)
    const body = getTopLevelSubscriberBody(mutated)
    expect(body).not.toBeNull()
    const ifStmt = body!.statements[0]
    expect(ts.isIfStatement(ifStmt)).toBe(true)
    if (!ts.isIfStatement(ifStmt)) return
    // The branch no longer unwraps to a single call — the mutant fails here,
    // exactly where the positive test asserted the exact call text.
    expect(callText(unwrapSingleStatement(ifStmt.elseStatement))).toBeNull()
  })

  it('mutation: an extra statement anywhere in the handler body (before or after the if/else) fails the statement-count check', () => {
    const original =
      'registerConnectionOutcomeHandler((outcome) => {\n' +
      '  if (outcome.ok) accountAuthState.noteSuccess(outcome.accountId, outcome.accountGeneration)\n' +
      '  else accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)\n' +
      '})'
    expect(source).toContain(original)
    const withTrailingLeak =
      'registerConnectionOutcomeHandler((outcome) => {\n' +
      '  if (outcome.ok) accountAuthState.noteSuccess(outcome.accountId, outcome.accountGeneration)\n' +
      '  else accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)\n' +
      '  captureException(outcome.error)\n' +
      '})'
    const mutated = source.replace(original, withTrailingLeak)
    expect(mutated).not.toBe(source)
    const body = getTopLevelSubscriberBody(mutated)
    expect(body).not.toBeNull()
    expect(body!.statements.length).not.toBe(1)
  })
})

/**
 * Fix wave 2 — the IDLE prologue is a full login with no retry inside it, so
 * a rejection has to be escalated rather than folded into the same counted
 * stream the connection boundary already feeds. See
 * `electron/services/accountAuthState.test.ts` ("a rejected login attempt")
 * for the state-machine half — raises on the first call, no threshold, no
 * double-count when the boundary's own report of the same error arrives too.
 * This describe pins the OTHER half: that `net:idleStart` really takes this
 * path, unconditionally, and rethrows the original error.
 */
describe('main.ts §2.165 (fix wave 2) — the IDLE prologue escalates a rejected login', () => {
  it('wraps startIdle in try/catch: the catch escalates via the named helper, then rethrows the ORIGINAL error unchanged', () => {
    const body = slices.idleStart()
    expect(body).toContain(
      '  try {\n    await startIdle(id, cfg.imap, parsedMailbox, (data) => {',
    )
    // Exact catch block: escalate, then rethrow — nothing else, in that
    // order. A catch that also called `accountAuthState.` directly here
    // would stack a second report on top of the boundary's own, defeating
    // the threshold (see the wiring invariant in the describe above: "no
    // caller reports outcomes any more").
    expect(body).toContain(
      '  } catch (err) {\n    noteIdleLoginRejected(id, idleGeneration, err)\n    throw err\n  }',
    )
    // The handler touches the service exactly once, and not to report: it reads
    // the stamp before the attempt starts (fix wave 4), the same way the
    // boundary reads its own before awaiting anything. A prologue still running
    // while the account is deleted must escalate the incarnation it was started
    // for, so the report is discarded rather than landing on the mailbox that
    // inherited the id.
    expect(countOccurrences(body, 'accountAuthState.')).toBe(1)
    expect(body).toContain('const idleGeneration = accountAuthState.currentGeneration(id)')
    // …and it is read BEFORE the attempt, not inside the catch (where it would
    // read the generation of whatever holds the id by then — the very bug).
    expect(body.indexOf('const idleGeneration = accountAuthState.currentGeneration(id)')).toBeLessThan(
      body.indexOf('await startIdle('),
    )
  })

  it('noteIdleLoginRejected forwards both arguments to accountAuthState.noteLoginRejected unchanged, and does nothing else', () => {
    const body = slices.noteIdleLoginRejectedFn()
    // Exact one-statement body: signature to closing brace, nothing between
    // the forward call and the `}` — a second statement (a stray log, a
    // duplicate `noteFailure`) would break this literal match.
    expect(body).toContain(
      'function noteIdleLoginRejected(accountId: number, accountGeneration: number | null, err: unknown): void {\n' +
      '  accountAuthState.noteLoginRejected(accountId, accountGeneration, err)\n' +
      '}',
    )
  })
})

describe('main.ts §2.165 — no caller reports outcomes any more', () => {
  it.each([
    ['net:syncFolderHeaders', () => slices.syncFolderHeaders()],
    ['runSyncFolderHeaders success tail', () => slices.runSyncFolderHeadersTail()],
    ['periodic sync', () => slices.periodicSyncWide()],
  ])('%s reports nothing to accountAuthState', (_name, slice) => {
    // Load-bearing: the threshold is two, so ONE surviving per-caller report
    // stacked on the boundary's own verdict raises the badge after a single
    // failed login — the debounce that keeps a flaky link from flagging a
    // healthy account would be gone.
    expect(slice()).not.toContain('accountAuthState.')
  })

  it('net:idleStart reports no OUTCOME — its one reference reads the stamp', () => {
    // Listed separately from the three above since fix wave 4: the handler does
    // touch the service, but only to read the generation it escalates with. The
    // negative that matters is that it reports no success and no failure of its
    // own on top of the boundary's.
    const body = slices.idleStart()
    for (const reporter of [
      'accountAuthState.noteSuccess(',
      'accountAuthState.noteFailure(',
      'accountAuthState.noteSignedIn(',
      'accountAuthState.noteLoginRejected(',
      'accountAuthState.noteMissingCredentials(',
    ]) {
      expect(body, reporter).not.toContain(reporter)
    }
  })

  it('noteFailure has exactly one call site in the whole file: the subscriber', () => {
    expect(countOccurrences(source, 'accountAuthState.noteFailure(')).toBe(1)
    expect(slices.subscriber()).toContain('accountAuthState.noteFailure(')
  })

  it('noteSuccess has exactly one call site in the whole file: the subscriber', () => {
    // Fix wave 4 split the two clears apart. Only a stamped verdict from the
    // boundary may use `noteSuccess`; the OAuth reconnects — which have no
    // operation to stamp — use `noteSignedIn`. Keeping them one method would
    // have meant either a `null` stamp on the reconnect (discarded, so the
    // badge survives a completed sign-in) or a stamp read at report time on the
    // boundary path (which is the stale-verdict bug itself).
    expect(countOccurrences(source, 'accountAuthState.noteSuccess(')).toBe(1)
    expect(countOccurrences(slices.subscriber(), 'accountAuthState.noteSuccess(')).toBe(1)
  })

  it('noteSignedIn call sites are the two OAuth reconnects, and nothing else', () => {
    expect(countOccurrences(source, 'accountAuthState.noteSignedIn(')).toBe(2)
    expect(countOccurrences(slices.googleConnect(), 'accountAuthState.noteSignedIn(')).toBe(1)
    expect(countOccurrences(slices.microsoftConnect(), 'accountAuthState.noteSignedIn(')).toBe(1)
  })

  it('the periodic loop still triggers the §2.86 rules pass on every exit', () => {
    // Removing the §2.157 report from this catch must not disturb the
    // neighbouring feature that shares the try/catch/finally.
    const body = slices.periodicSyncFolder()
    expect(body).toContain('processMailRules(aid, folder)')
    const finallyIdx = body.indexOf('} finally {')
    expect(finallyIdx).toBeGreaterThan(-1)
    expect(body.indexOf('processMailRules(aid, folder)', finallyIdx)).toBeGreaterThan(finallyIdx)
  })
})

describe('main.ts §2.165 — the two verdicts the boundary can never see', () => {
  it('assertImapAuth reports missing credentials and throws the discriminated error', () => {
    const body = slices.assertImapAuth()
    expect(body).toContain('accountAuthState.noteMissingCredentials(accountId, accountGeneration)')
    // The error carries the discriminator, so the report is still correct if
    // the check ever runs inside an already-wrapped operation and the failure
    // travels to the service through the boundary instead.
    expect(body).toContain('throw imapAuthNotConfiguredError(accountId)')
    // Reported BEFORE the throw: ~28 call sites catch this error and most only
    // log it, so the raise may not depend on which of them caught it.
    expect(body.indexOf('accountAuthState.noteMissingCredentials(accountId, accountGeneration)')).toBeLessThan(
      body.indexOf('throw imapAuthNotConfiguredError(accountId)'),
    )
    // No bare Error left behind: a second throw path would be a silent hole.
    expect(body).not.toContain('throw new Error(')
  })

  it('assertImapAuth takes the stamp as a REQUIRED parameter, minted by the one config loader', () => {
    // Fix wave 5. Every `cfg` handed to `assertImapAuth` comes from
    // `requireAccountConfig`, which reads the generation before its own first
    // await; the verdict is a statement about the record that load produced, and
    // an id can change hands between the load and the check. Required rather
    // than optional so that a new call site fails to COMPILE instead of silently
    // reporting unstamped — the compiler is the enforcement here, this
    // assertion only keeps the signature from being loosened back.
    expect(source).toContain(
      "function assertImapAuth(accountId: number, cfg: AccountConfig['imap'], accountGeneration: number | null) {",
    )
    // No call site left behind: every `assertImapAuth(` call passes three
    // arguments. (`cfg.imap` never contains a comma, so counting commas at the
    // top level of the argument list is exact here.)
    const calls = source.match(/assertImapAuth\([^)]*\)/g) ?? []
    // The declaration plus 28 call sites.
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      if (call.startsWith('assertImapAuth(accountId: number')) continue // the declaration
      expect(call.split(',')).toHaveLength(3)
    }
  })

  it('requireAccountConfig mints that stamp before its first await', () => {
    const loader = sliceBetween(
      source,
      'async function requireAccountConfig(accountIdRaw: unknown)',
      '\nfunction assertImapAuth(',
    )
    const stampIdx = loader.indexOf('const accountGeneration = accountAuthState.currentGeneration(id)')
    expect(stampIdx).toBeGreaterThan(-1)
    // `getAccountMeta` is synchronous; the first await is the config load.
    const firstAwaitIdx = loader.indexOf('await getAccountConfig(id)')
    expect(firstAwaitIdx).toBeGreaterThan(-1)
    expect(stampIdx).toBeLessThan(firstAwaitIdx)
    // …and it is returned, or nothing downstream could use it.
    expect(loader).toContain('accountGeneration,')
  })

  it('mutation: the loader check fails once the stamp is read after the config load', () => {
    const loader = sliceBetween(
      source,
      'async function requireAccountConfig(accountIdRaw: unknown)',
      '\nfunction assertImapAuth(',
    )
    const stamp = '  const accountGeneration = accountAuthState.currentGeneration(id)\n'
    expect(loader).toContain(stamp)
    const mutated = loader
      .replace(stamp, '')
      .replace(
        '  const base = await getAccountConfig(id)\n',
        '  const base = await getAccountConfig(id)\n' + stamp,
      )
    expect(mutated).not.toBe(loader)
    expect(mutated.indexOf('const accountGeneration = accountAuthState.currentGeneration(id)')).toBeGreaterThan(
      mutated.indexOf('await getAccountConfig(id)'),
    )
  })

  it('the Google reconnect clears the flag only when the IMAP test actually passed', () => {
    const body = slices.googleConnect()
    expect(body).toContain('if (!tlsCertImap) accountAuthState.noteSignedIn(id)')
    // Gate and clear must reference the same variable the TLS branch sets: a
    // `tlsCertImap` endpoint means the login was never reached (handshake
    // failed) and the account is saved only so the user can accept the cert.
    expect(body).toContain('tlsCertImap = { host: imapMeta.host, port: imapMeta.port }')
    // …and it happens after the account has an id to report against.
    expect(body.indexOf('if (!tlsCertImap) accountAuthState.noteSignedIn(id)')).toBeGreaterThan(
      body.indexOf('const { id } = await saveAccount({'),
    )
  })

  it('the Microsoft reconnect clears the flag on the same condition', () => {
    const body = slices.microsoftConnect()
    expect(body).toContain('if (!res.tlsCertRequired?.imap) accountAuthState.noteSignedIn(res.id)')
    // The handler must await the service call to have a result to inspect —
    // a fire-and-forget `return connectOutlookAccount(...)` cannot clear.
    expect(body).toContain('const res = await connectOutlookAccount({')
  })

  it('saving an account with a new password does not clear the flag', () => {
    // A stored string is not proof of a working login; the first real operation
    // through the boundary clears it moments later.
    const body = sliceBetween(source, `handleIpc('accounts:save'`, `handleIpc('accounts:removePreview'`)
    expect(body).not.toContain('accountAuthState.')
  })
})

describe('main.ts §2.165 — accounts:remove tears down only after the deletion, and only for a record that is gone', () => {
  it('the shared teardown keeps the order the survivors depend on', () => {
    // Fix wave 5 moved these three out of the handler into
    // `completeAccountRemoval`, because a deletion can now finish the teardown
    // from either of two places. Their ORDER and their membership are unchanged
    // and still pinned:
    //  - forget: bumps the generation, which is what stops verdicts of the
    //    vanished mailbox from landing on the id's next owner;
    //  - unregisterAuthErrorHandler / certRecovery.unregisterAccount: the two
    //    per-account registries whose closures hold token caches.
    const body = slices.completeAccountRemoval()
    const order = ['unregisterAuthErrorHandler(id)', 'certRecovery.unregisterAccount(id)', 'accountAuthState.forget(id)']
    let previous = -1
    for (const call of order) {
      const idx = body.indexOf(call)
      expect(idx, call).toBeGreaterThan(previous)
      previous = idx
    }
    expect(body).toContain("broadcast('accounts:changed', { kind: 'removed', id })")
  })

  it('every teardown call follows deleteAccount, on both exits', () => {
    // `deleteAccount` can reject and the handler propagates that rejection.
    // Tearing down first left a SURVIVING account without a token-refresh
    // handler (condemned to auth failures nothing can repair), without a cert
    // subscription (a TLS interception on it would pass in silence) and without
    // its badge (the only warning the user had).
    const body = slices.accountsRemove()
    const deleteIdx = body.indexOf('await deleteAccount(id)')
    expect(deleteIdx).toBeGreaterThan(-1)
    for (const call of ['accountAuthState.forget(id)', 'unregisterAuthErrorHandler(id)', 'certRecovery.unregisterAccount(id)']) {
      // …and none of them appears in the handler at all any more: the handler
      // calls the shared teardown, which is defined ABOVE it.
      expect(body, call).not.toContain(call)
    }
    for (const idx of [...body.matchAll(/completeAccountRemoval\(id\)/g)].map(m => m.index ?? -1)) {
      expect(idx).toBeGreaterThan(deleteIdx)
    }
    expect(countOccurrences(body, 'completeAccountRemoval(id)')).toBe(2)
  })

  it('a rejecting deleteAccount still reaches the caller', () => {
    // The rejection is caught now (fix wave 5), but only to finish the cleanup
    // a partial deletion left behind — it is re-thrown unconditionally, so
    // "teardown runs after delete" never becomes "the failure is swallowed".
    const body = slices.accountsRemove()
    expect(body).toContain(
      '  try {\n' +
      '    await deleteAccount(id)\n' +
      '  } catch (err) {\n' +
      '    if (accountRecordIsGone(id)) {\n',
    )
    // The re-throw is the LAST statement of the catch, outside the `if`: it runs
    // whether or not the record turned out to be gone.
    expect(body).toContain(
      '      completeAccountRemoval(id)\n' +
      '    }\n' +
      '    throw err\n' +
      '  }\n',
    )
  })

  it('the failure path decides by looking at the store, never at the error', () => {
    // Fix wave 5. `deleteAccount` removes the account record before work that
    // can fail (secret cleanup, the settings write), so a rejection says nothing
    // about whether the record survived — and its message says even less. A
    // record that is gone with no `forget()` leaves the freed id carrying the
    // generation of the mailbox that is gone, so the next account to be issued
    // that id inherits its verdicts.
    const body = slices.accountRecordIsGone()
    expect(body).toContain('return getAccountMeta(id) === undefined')
    // Fail-CLOSED on an unreadable store: claiming "gone" wrongly tears down a
    // LIVE mailbox's auth-refresh handler and cert subscription.
    expect(body).toContain('return false')
    // No error-text matching anywhere on this path (CLAUDE.md §5: one
    // classifier, and it is for server failures).
    expect(slices.accountsRemove()).not.toMatch(/err\s*(instanceof Error\s*\?\s*err\.)?\.?message/)
  })

  it('nothing on either removal path logs or reports the raw rejection', () => {
    // The rejection comes from the secret backend or the settings writer: its
    // message quotes filesystem paths (the user's home directory) and stored
    // values (CLAUDE.md §8). Only the code may leave the process.
    const body = slices.accountsRemove() + slices.accountRecordIsGone()
    expect(body).toContain('code: errCodeOf(err)')
    expect(body).not.toMatch(/captureException\(err\b/)
    expect(body).not.toMatch(/\berr\.message\b/)
  })
})

describe('main.ts §2.165 — mutation control (proves the checks above can actually fail)', () => {
  it('the single-subscriber check fails once a second registration appears', () => {
    const mutated = source.replace(
      'registerConnectionOutcomeHandler((outcome)',
      'registerConnectionOutcomeHandler((o) => {})\nregisterConnectionOutcomeHandler((outcome)',
    )
    expect(countOccurrences(mutated, 'registerConnectionOutcomeHandler(')).toBe(2)
  })

  it('the module-scope check fails once the registration is indented into a block', () => {
    const mutated = source.replace(
      '\nregisterConnectionOutcomeHandler((outcome)',
      '\n  registerConnectionOutcomeHandler((outcome)',
    )
    expect(mutated).not.toBe(source)
    expect(mutated).not.toMatch(/\nregisterConnectionOutcomeHandler\(\(outcome\)/)
  })

  it('the forwarding check fails once the failure verdict is dropped', () => {
    const body = slices.subscriber()
    const mutated = body.replace('accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)', '')
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain('accountAuthState.noteFailure(')
  })

  it('the else-branch check fails once noteFailure becomes unconditional', () => {
    // The mutation the plain `.toContain` checks above cannot catch: both
    // calls still present, both still textually after `if (outcome.ok)` —
    // only the missing `else` makes this wrong, and only the `else`-prefixed
    // assertion notices.
    const body = slices.subscriber()
    const mutated = body.replace(
      'else accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)',
      'accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)',
    )
    expect(mutated).not.toBe(body)
    // The individual containment checks the other test runs would still pass
    // on this mutant — both calls are still there, in the same relative
    // order — which is exactly why the `else`-prefixed string is required.
    expect(mutated).toContain('accountAuthState.noteSuccess(outcome.accountId, outcome.accountGeneration)')
    expect(mutated).toContain('accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)')
    expect(mutated).not.toContain('else accountAuthState.noteFailure(outcome.accountId, outcome.accountGeneration, outcome.error)')
  })

  it('the "no caller reports" check fails once a per-caller report is reintroduced', () => {
    // This is the exact §2.157 shape the fix removed, and the one a future
    // "let me also report it here" would recreate. Since fix wave 4 the check
    // is per-reporter rather than "mentions the service at all" (the handler
    // legitimately reads the generation), so the mutant has to be caught by
    // name.
    const body = slices.idleStart()
    const mutated = body.replace(
      'await startIdle(',
      'accountAuthState.noteSuccess(id, idleGeneration)\n  await startIdle(',
    )
    expect(mutated).not.toBe(body)
    expect(mutated).toContain('accountAuthState.noteSuccess(')
    expect(body).not.toContain('accountAuthState.noteSuccess(')
  })

  it('the noteSuccess call-site count fails once a second appears', () => {
    const mutated = source.replace(
      'broadcast(\'accounts:changed\', { kind: \'removed\', id })',
      'accountAuthState.noteSuccess(id, 0)\n  broadcast(\'accounts:changed\', { kind: \'removed\', id })',
    )
    expect(countOccurrences(mutated, 'accountAuthState.noteSuccess(')).toBe(2)
  })

  it('the noteSignedIn call-site count fails once a third appears', () => {
    const mutated = source.replace(
      'broadcast(\'accounts:changed\', { kind: \'removed\', id })',
      'accountAuthState.noteSignedIn(id)\n  broadcast(\'accounts:changed\', { kind: \'removed\', id })',
    )
    expect(countOccurrences(mutated, 'accountAuthState.noteSignedIn(')).toBe(3)
  })

  it('the idleStart stamp check fails once the generation is read inside the catch', () => {
    // The mutation with the right shape and the wrong timing: a stamp read at
    // report time describes whatever holds the id THEN, which is precisely the
    // stale-verdict bug the pair was introduced to close.
    const body = slices.idleStart()
    const mutated = body
      .replace('  const idleGeneration = accountAuthState.currentGeneration(id)\n', '')
      .replace(
        'noteIdleLoginRejected(id, idleGeneration, err)',
        'noteIdleLoginRejected(id, accountAuthState.currentGeneration(id), err)',
      )
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain('const idleGeneration = accountAuthState.currentGeneration(id)')
    expect(mutated.indexOf('accountAuthState.currentGeneration(id)')).toBeGreaterThan(
      mutated.indexOf('await startIdle('),
    )
  })

  it('the assertImapAuth check fails once the report is removed', () => {
    const body = slices.assertImapAuth()
    const mutated = body.replace('accountAuthState.noteMissingCredentials(accountId, accountGeneration)\n', '')
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain('accountAuthState.noteMissingCredentials(accountId, accountGeneration)')
  })

  it('the assertImapAuth stamp check fails once the parameter becomes optional', () => {
    // The loosening that would let a new call site drop the stamp without the
    // compiler noticing — and an omitted stamp is `undefined`, which is not even
    // the `null` the service reads as "unattributable".
    const mutated = source.replace(
      "function assertImapAuth(accountId: number, cfg: AccountConfig['imap'], accountGeneration: number | null) {",
      "function assertImapAuth(accountId: number, cfg: AccountConfig['imap'], accountGeneration?: number | null) {",
    )
    expect(mutated).not.toBe(source)
    expect(mutated).not.toContain(
      "function assertImapAuth(accountId: number, cfg: AccountConfig['imap'], accountGeneration: number | null) {",
    )
  })

  it('the assertImapAuth check fails once the discriminated error is replaced by a bare one', () => {
    const body = slices.assertImapAuth()
    const mutated = body.replace(
      'throw imapAuthNotConfiguredError(accountId)',
      'throw new Error(`IMAP authentication for account #${accountId} is not configured`)',
    )
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain('throw imapAuthNotConfiguredError(accountId)')
    expect(mutated).toContain('throw new Error(')
  })

  it('the OAuth gate checks fail once the clear becomes unconditional', () => {
    const google = slices.googleConnect()
    const mutatedGoogle = google.replace(
      'if (!tlsCertImap) accountAuthState.noteSignedIn(id)',
      'accountAuthState.noteSignedIn(id)',
    )
    expect(mutatedGoogle).not.toBe(google)
    expect(mutatedGoogle).not.toContain('if (!tlsCertImap) accountAuthState.noteSignedIn(id)')

    const ms = slices.microsoftConnect()
    const mutatedMs = ms.replace(
      'if (!res.tlsCertRequired?.imap) accountAuthState.noteSignedIn(res.id)',
      'accountAuthState.noteSignedIn(res.id)',
    )
    expect(mutatedMs).not.toBe(ms)
    expect(mutatedMs).not.toContain('if (!res.tlsCertRequired?.imap) accountAuthState.noteSignedIn(res.id)')
  })

  it('the accounts:remove ordering check fails once the teardown moves ahead of the deletion', () => {
    // The regression this pins is exactly the pre-§2.165 code: the auth handler
    // and the cert subscription were dropped BEFORE the deletion that can fail.
    const body = slices.accountsRemove()
    const mutated = body.replace('  try {\n    await deleteAccount(id)', '  completeAccountRemoval(id)\n  try {\n    await deleteAccount(id)')
    expect(mutated).not.toBe(body)
    expect(mutated.indexOf('completeAccountRemoval(id)')).toBeLessThan(mutated.indexOf('await deleteAccount(id)'))
  })

  it('the partial-deletion check fails once the rejecting path stops finishing the teardown', () => {
    // Fix wave 5. The mutant is the pre-wave-5 handler: a rejection propagates
    // untouched, so a record that is gone keeps its generation and the next
    // account to be issued that id inherits every stale verdict.
    const body = slices.accountsRemove()
    const rescue =
      '    if (accountRecordIsGone(id)) {\n'
    expect(body).toContain(rescue)
    const mutated = body.replace(rescue, '    if (false) {\n')
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain(rescue)
  })

  it('the partial-deletion check fails once the rejection is swallowed instead of re-thrown', () => {
    // The other direction: finishing the teardown must not turn a failed
    // deletion into a reported success.
    const body = slices.accountsRemove()
    const rethrow = '    }\n    throw err\n  }\n'
    expect(body).toContain(rethrow)
    const mutated = body.replace(rethrow, '    }\n  }\n')
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain(rethrow)
  })

  it('the store-lookup check fails once the decision is made from the error text', () => {
    const body = slices.accountRecordIsGone()
    const lookup = 'return getAccountMeta(id) === undefined'
    expect(body).toContain(lookup)
    const mutated = body.replace(lookup, "return /not found/i.test(String((err as Error).message))")
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain(lookup)
  })

  // --- Fix wave 2: the IDLE-prologue escalation ---

  it('the idleStart catch check fails once the rethrow is replaced by a different error', () => {
    const body = slices.idleStart()
    const mutated = body.replace(
      '  } catch (err) {\n    noteIdleLoginRejected(id, idleGeneration, err)\n    throw err\n  }',
      '  } catch (err) {\n    noteIdleLoginRejected(id, idleGeneration, err)\n    throw new Error(\'IDLE failed\')\n  }',
    )
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain(
      '  } catch (err) {\n    noteIdleLoginRejected(id, idleGeneration, err)\n    throw err\n  }',
    )
  })

  it('the idleStart catch check fails once the escalation is dropped (the rejection is swallowed silently)', () => {
    const body = slices.idleStart()
    const mutated = body.replace(
      '  } catch (err) {\n    noteIdleLoginRejected(id, idleGeneration, err)\n    throw err\n  }',
      '  } catch (err) {\n    throw err\n  }',
    )
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain('noteIdleLoginRejected(id, idleGeneration, err)')
  })

  it('the idleStart catch check fails once the error argument is dropped from the escalation call', () => {
    const body = slices.idleStart()
    const mutated = body.replace('noteIdleLoginRejected(id, idleGeneration, err)', 'noteIdleLoginRejected(id)')
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain(
      '  } catch (err) {\n    noteIdleLoginRejected(id, idleGeneration, err)\n    throw err\n  }',
    )
  })

  it('the noteIdleLoginRejected check fails once the forward drops the error argument', () => {
    const body = slices.noteIdleLoginRejectedFn()
    const mutated = body.replace(
      'accountAuthState.noteLoginRejected(accountId, accountGeneration, err)',
      'accountAuthState.noteLoginRejected(accountId)',
    )
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain(
      'function noteIdleLoginRejected(accountId: number, accountGeneration: number | null, err: unknown): void {\n' +
      '  accountAuthState.noteLoginRejected(accountId, accountGeneration, err)\n' +
      '}',
    )
  })

  it('the noteIdleLoginRejected check fails once a second statement is added to its body', () => {
    const body = slices.noteIdleLoginRejectedFn()
    const mutated = body.replace(
      'accountAuthState.noteLoginRejected(accountId, accountGeneration, err)\n}',
      'accountAuthState.noteLoginRejected(accountId, accountGeneration, err)\n  console.warn(errCodeOf(err))\n}',
    )
    expect(mutated).not.toBe(body)
    expect(mutated).not.toContain(
      'function noteIdleLoginRejected(accountId: number, accountGeneration: number | null, err: unknown): void {\n' +
      '  accountAuthState.noteLoginRejected(accountId, accountGeneration, err)\n' +
      '}',
    )
  })
})

/**
 * §2.165 fix wave 5 — the removal path, in real time.
 *
 * The assertions above pin the SHAPE of `accounts:remove` in the source. They
 * cannot show what the shape is for, and the defect this closes is a sequence,
 * not a token: `deleteAccount` removes the account record BEFORE work that can
 * fail (secret cleanup, the settings write that moves `currentAccountId`), so a
 * rejection can leave the record gone with none of the teardown done. The
 * generation is then never bumped, and because ids are handed out as "max + 1"
 * they are reused — the next account created inherits both the id AND every
 * verdict still in flight for the mailbox that is gone.
 *
 * `electron/main.ts` cannot be imported in unit tests (module-level side
 * effects: BrowserWindow, IPC registration, DB open — the constraint documented
 * in `main.certRecovery.test.ts` / `main.pendingMoves.test.ts`), so the handler
 * is mirrored here with injected dependencies and the REAL state service. The
 * mirror is kept honest by the source-text assertions above, which fail if the
 * production handler drifts from this shape; when changing one, change both.
 */
describe('main.ts §2.165 (fix wave 5) — a deletion that rejects after removing the record', () => {
  /** Mirror: `completeAccountRemoval` (electron/main.ts). Only the calls whose
   *  ORDER and presence the tests are about; the token-cache deletes and the
   *  EML cleanup have no observable state here. */
  function makeTeardown(svc: ReturnType<typeof initAccountAuthState>) {
    const calls: string[] = []
    const unregisterAuthErrorHandler = vi.fn<(id: number) => void>(() => { calls.push('unregisterAuthErrorHandler') })
    const unregisterCertAccount = vi.fn<(id: number) => void>(() => { calls.push('certRecovery.unregisterAccount') })
    const broadcastRemoved = vi.fn<(id: number) => void>(() => { calls.push('broadcast:removed') })
    const completeAccountRemoval = (id: number) => {
      unregisterAuthErrorHandler(id)
      unregisterCertAccount(id)
      calls.push('forget')
      svc.forget(id)
      broadcastRemoved(id)
    }
    return { calls, completeAccountRemoval, unregisterAuthErrorHandler, unregisterCertAccount, broadcastRemoved }
  }

  /** Mirror: the `accounts:remove` handler body after the e2e branch and the
   *  IDLE stop (electron/main.ts). */
  async function accountsRemove(
    id: number,
    deps: {
      deleteAccount: (id: number) => Promise<void>
      accountRecordIsGone: (id: number) => boolean
      completeAccountRemoval: (id: number) => void
    },
  ): Promise<{ ok: true }> {
    try {
      await deps.deleteAccount(id)
    } catch (err) {
      if (deps.accountRecordIsGone(id)) {
        deps.completeAccountRemoval(id)
      }
      throw err
    }
    deps.completeAccountRemoval(id)
    return { ok: true as const }
  }

  function makeService(accountExists: () => boolean = () => true) {
    const broadcast = vi.fn<(channel: 'accounts:authStateChanged', payload: AccountAuthStatePayload) => number>(() => 1)
    const svc = initAccountAuthState({ classifyError: () => 'auth', broadcast, accountExists })
    return { svc, broadcast }
  }

  it('finishes the teardown and bumps the generation when the record is gone', async () => {
    // Mutation that fails this: dropping the `accountRecordIsGone` branch from
    // the catch (the pre-wave-5 handler), or moving `forget` out of the shared
    // teardown.
    const { svc } = makeService()
    const teardown = makeTeardown(svc)
    // An operation of the doomed mailbox is already in flight; it stamped
    // itself before the deletion started.
    const inFlight = svc.currentGeneration(7)

    await expect(accountsRemove(7, {
      // The record is removed first, then the settings write fails.
      deleteAccount: async () => { throw new Error('settings write failed') },
      accountRecordIsGone: () => true,
      completeAccountRemoval: teardown.completeAccountRemoval,
    })).rejects.toThrow('settings write failed')

    expect(teardown.calls).toEqual([
      'unregisterAuthErrorHandler',
      'certRecovery.unregisterAccount',
      'forget',
      'broadcast:removed',
    ])
    // The generation moved, so the in-flight verdict of the deleted mailbox no
    // longer describes the id — even though the id now belongs to a new
    // account (`accountExists` still answers true).
    svc.noteMissingCredentials(7, inFlight)
    svc.noteFailure(7, inFlight, new Error('auth'))
    svc.noteFailure(7, inFlight, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([])
    // …while the new mailbox's own verdict is acted on at once.
    svc.noteMissingCredentials(7, svc.currentGeneration(7))
    expect(svc.snapshot().needsReauth).toEqual([7])
  })

  it('touches nothing when the rejection left the record in place', async () => {
    // The survivor case, and the reason the check is fail-CLOSED: this account
    // still exists, still needs its auth-refresh handler and its cert
    // subscription, and still deserves the badge it earned.
    const { svc, broadcast } = makeService()
    const teardown = makeTeardown(svc)
    svc.noteMissingCredentials(7, svc.currentGeneration(7))
    expect(svc.snapshot().needsReauth).toEqual([7])
    broadcast.mockClear()

    await expect(accountsRemove(7, {
      deleteAccount: async () => { throw new Error('disk failure') },
      accountRecordIsGone: () => false,
      completeAccountRemoval: teardown.completeAccountRemoval,
    })).rejects.toThrow('disk failure')

    expect(teardown.calls).toEqual([])
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).not.toHaveBeenCalled()
    // The surviving mailbox's own verdicts still land: its generation is
    // untouched, so an operation stamped before the failed deletion still
    // matches.
    expect(svc.currentGeneration(7)).toBe(0)
  })

  it('the ordinary deletion is unchanged: teardown once, after the deletion, in the same order', async () => {
    const { svc } = makeService()
    const teardown = makeTeardown(svc)
    const order: string[] = []
    const inFlight = svc.currentGeneration(7)

    const res = await accountsRemove(7, {
      deleteAccount: async () => { order.push('deleteAccount') },
      accountRecordIsGone: () => {
        order.push('accountRecordIsGone')
        return true
      },
      completeAccountRemoval: (id) => {
        order.push('completeAccountRemoval')
        teardown.completeAccountRemoval(id)
      },
    })

    expect(res).toEqual({ ok: true })
    // The store is not consulted at all on the happy path.
    expect(order).toEqual(['deleteAccount', 'completeAccountRemoval'])
    expect(teardown.calls).toEqual([
      'unregisterAuthErrorHandler',
      'certRecovery.unregisterAccount',
      'forget',
      'broadcast:removed',
    ])
    svc.noteMissingCredentials(7, inFlight)
    expect(svc.snapshot().needsReauth).toEqual([])
  })
})
