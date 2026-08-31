/**
 * §2.157 (re-wired by §2.165) — per-account "the mailbox needs signing in
 * again" state.
 *
 * The problem this closes: when an IMAP password is changed elsewhere or an
 * OAuth refresh token is revoked, every sync path fails with an auth error,
 * `withImapRetry` has already spent its one token-refresh attempt, and the
 * only trace left is a `logPeriodic.warn` line in the log file. The mailbox
 * silently stops receiving mail for hours (observed on a live account
 * 2026-08-08) while the window shows nothing at all.
 *
 * This service owns exactly one thing: the mapping from a stream of per-account
 * IMAP connection outcomes to a boolean "this account needs re-authentication",
 * plus the broadcast that tells the renderer when that boolean flips. It deliberately
 * does NOT classify errors itself — the classification is `classifyImapError`
 * from packages/net/imap, injected by main.ts (CLAUDE.md §5: one classifier,
 * not two). The injection is a testability seam only; there is exactly one
 * production wiring.
 *
 * Policy, and why:
 *
 *   - ONLY `errorClass === 'auth'` counts. A network flap ('network') is the
 *     normal state of a laptop lid, and a TLS trust failure ('cert') has its
 *     own dedicated UX (electron/services/certRecovery.ts) that would be
 *     contradicted by a "sign in again" prompt. 'permanent' (NONEXISTENT
 *     mailbox) is a folder problem, not a credentials problem.
 *
 *   - Non-auth failures neither raise nor clear the flag. They are not
 *     evidence about credentials in either direction: an account whose
 *     password is revoked ALSO fails on network when the Wi-Fi drops, and
 *     letting that reset the streak would keep a genuinely broken mailbox
 *     below the threshold forever on a flaky link.
 *
 *   - Two consecutive auth failures are required (AUTH_FAILURE_THRESHOLD).
 *     One is not enough: an error only reaches us AFTER withImapRetry's single
 *     token-refresh retry, but a refresh that raced a server-side revocation
 *     window can still produce one isolated failure. Two also arrive fast in
 *     practice — a periodic pass walks several folders, so a truly dead
 *     credential trips the badge within the same pass rather than after two
 *     5-minute cycles.
 *
 *   - …except where a second observation will never come. The threshold buys
 *     one retry against a racing server, and it is only affordable where the
 *     stream keeps producing evidence. Two reports are exempt from it and raise
 *     on sight: `noteMissingCredentials` (a local precondition — no server, no
 *     race) and `noteLoginRejected` (a login attempt that the server itself
 *     rejected, reported by a caller that will now abandon the operation).
 *     Applying the threshold to a terminal event does not delay the badge, it
 *     cancels it: a mailbox with every folder on manual sync makes exactly one
 *     connection attempt, so "wait for the second" means "never".
 *
 *   - The broadcast is EDGE-triggered: it fires when the set of flagged
 *     accounts actually changes, never per failure. That is what keeps a long
 *     run of failures (one per folder, per pass, forever) from repainting the
 *     badge — the debounce required by the acceptance criteria is structural,
 *     not a timer.
 *
 *   - Clearing needs no user action and no threshold: the first reported
 *     success for the account clears both the streak and the flag. Success is
 *     proof of working credentials in a way that no count of failures can
 *     contradict.
 *
 * Where the reports come from (§2.165). Outcomes arrive from ONE place: the
 * IMAP connection/retry boundary in packages/net/imap, forwarded by the single
 * subscriber main.ts registers at startup. Callers report nothing. The
 * predecessor of this design attached `noteSuccess` to three chosen sync paths,
 * all of them header fetches, and it had two defects that no amount of care at
 * the call sites could fix: a mailbox whose folders are all on manual sync ran
 * none of the three, so a badge raised once could never come down; and every
 * other proof of a working login the user generated in the meantime (opening a
 * message, moving mail, listing folders) was invisible here. Reporting at the
 * boundary makes the set of observed operations equal to the set of operations
 * that actually talk to the server, by construction rather than by upkeep.
 *
 * Four entry points sit deliberately OUTSIDE that stream, because the events
 * they carry are either invisible to the boundary or conclusive in a way a
 * counted outcome is not:
 *
 *   - `noteMissingCredentials` — a local precondition check that rejects before
 *     any connection is attempted, so the boundary never sees it. Callers:
 *     `assertImapAuth` in main.ts (no password and no access token) and the
 *     three OAuth token paths when the account has no stored refresh token
 *     (§2.165 fix wave 4 — see below). Its JSDoc explains why it bypasses the
 *     threshold — and why it nonetheless carries a generation stamp like every
 *     other report (fix wave 5).
 *
 *   - `noteLoginRejected` — a caller that owns a whole login attempt (today:
 *     the `net:idleStart` handler, whose IDLE prologue connects, authenticates
 *     and selects a mailbox) reporting that the attempt was rejected and is
 *     being abandoned. The boundary DID see this failure and counted it; this
 *     report says the count will never grow, because there is no next attempt
 *     to count. It raises the flag rather than incrementing anything — see the
 *     method's JSDoc for why that cannot double-count.
 *
 *   - `noteSignedIn` from the OAuth reconnect handlers, whose IMAP verification
 *     runs on a throwaway connection (`testImapConnection`) with no account id
 *     attached and therefore outside the boundary. This is the one path that
 *     must clear the badge the instant the user finishes signing in again.
 *     Note what is NOT here: saving an account with a new password does not
 *     clear anything — a stored string is not proof, and the first real
 *     operation through the boundary will clear it moments later.
 *
 * The OAuth hole, closed (§2.165 fix wave 4). An OAuth account whose refresh
 * token is missing from the secret store used to be the one mailbox that could
 * never show the badge: the token providers throw while BUILDING the config,
 * i.e. before `assertImapAuth` looks at the credentials and before any wrapped
 * operation runs, so neither the precondition report nor the boundary ever
 * fired. The account simply went quiet. All three token paths (Gmail, Outlook
 * Exchange, Outlook Graph-send) now report `noteMissingCredentials` — stamped
 * with the generation read before their first await, see fix wave 5 above — and
 * throw an error tagged with the SAME
 * discriminator the local precondition uses (`IMAP_AUTH_NOT_CONFIGURED_CODE`) —
 * our own machine-readable marker, never a match against the provider's
 * response text, and never a second classifier.
 *
 * Verdicts that outlived the mailbox they belong to (§2.165, fix wave 4).
 * A single process-wide subscriber cannot tell a live account id from one that
 * was removed while an operation was in flight: `forget()` runs when the
 * deletion commits, and the doomed operation reports afterwards. Worse, account
 * ids are handed out as "max + 1" and are therefore REUSED, so the stray
 * verdict does not land on nothing — it lands on whatever mailbox was created
 * next. Neither ordering of those events can be decided from the payload (an
 * account id and an error, that is all) and no property of the account decides
 * it either: the verdict arrives after the new mailbox exists, so every
 * fingerprint taken at that moment describes the new one.
 *
 * So the identity of a mailbox is the PAIR (account id, generation), and this
 * service mints the generation. Every id starts at generation 0; `forget()` —
 * called precisely when a deletion commits — bumps it, monotonically and for
 * the life of the process. `currentGeneration()` is handed to packages/net as
 * the generation provider, the connection boundary stamps every outcome with
 * the generation read at the START of the operation, and a verdict is acted
 * upon only when its stamp still equals the generation the id holds. Both
 * orderings then fall out of one comparison: a verdict issued before a deletion
 * carries the pre-deletion generation and is discarded whether it lands before
 * or after the id is re-issued, while the new mailbox's own verdicts carry the
 * current generation and are acted on immediately — no waiting period, in
 * either direction.
 *
 * An absent stamp (`null`) is a MISMATCH, not a wildcard: it means the boundary
 * could not attribute the verdict (no provider registered, unknown id,
 * misbehaving provider), and an unattributable verdict may not move a
 * user-visible warning. The consequence is deliberate and load-bearing: if the
 * provider is never registered the badge stops moving entirely rather than
 * moving for the wrong mailbox. `electron/main.accountAuthStateWiring.test.ts`
 * pins the registration — and its ORDER, before the outcome subscriber — so a
 * broken wiring fails a test instead of silently disabling the feature.
 *
 * The rule reaches EVERY report, not just the boundary's (§2.165 fix wave 5).
 * Fix wave 4 left `noteMissingCredentials` unstamped on the argument that a
 * local precondition cannot be stale. It can: the precondition is evaluated
 * against a record fetched across an await (a refresh token read out of the
 * secret store, a config load), and a deletion inside that window frees the id
 * to the next account created. Our own new report was therefore the very defect
 * the wave was closing, one function along. The invariant is now stated
 * positively and has no exceptions: EVERY entry point that moves the flag takes
 * a generation, read before the first await of the operation that produced the
 * verdict — with exactly one deliberate exception, `noteSignedIn`, whose
 * evidence is a WRITE of fresh credentials to the id rather than an observation
 * of it (see its JSDoc).
 *
 * What this replaced: fix wave 3 answered the same question with a 120-second
 * quarantine on a freed id. A fixed window cannot be right in either direction
 * — a verdict can wait behind an arbitrarily long operation-lock queue and
 * outlive any window, while a freshly created mailbox with genuinely broken
 * credentials stayed silent for the whole of it. The pair decides exactly, so
 * the window, its constant, its map and its sweep are gone.
 *
 * `accountExists` survives that removal, in two places and for a different job:
 * inside `currentGeneration` (an id that addresses no live account has no
 * generation — the provider answers `null`, which is what makes a verdict for a
 * never-existing id unattributable rather than "generation 0") and on the raise
 * transition, where since fix wave 5 it is defence in depth rather than the
 * identity test for one unstamped report: a badge raised for an id that belongs
 * to nothing is invisible (the renderer filters the payload against its own
 * account list) and unclearable forever (an id with no mailbox produces no
 * successes), so the cheap edge-triggered lookup stays. It is NOT an identity
 * test; the pair is. See `accountStillExists` for what happens when the lookup
 * itself fails.
 *
 * Deliberately in-memory (same call as certRecovery): the state is derived
 * from live connection outcomes, so after a restart the first sync either
 * succeeds — and there was nothing to show — or fails again and re-raises it
 * within one pass. Persisting it would add a store that can only ever go
 * stale, and a stale "sign in again" badge on a healthy mailbox is worse than
 * a few minutes of delay.
 *
 * Error containment: nothing here may propagate into a sync path. Every entry
 * point is wrapped; failures are logged PII-free (account id, error class,
 * counters — never the server's error text, which echoes user/host strings)
 * and reported through captureException.
 *
 * Telemetry (CLAUDE.md §8): two of the three events of the §2.157 funnel are
 * emitted from here — `account.reauth_flagged` on the raise transition and
 * `account.reauth_cleared` on the fall, with the time between them as a coarse
 * bucket. The third, `account.reauth_badge_clicked`, can only be observed in
 * the renderer (see the schema entry). Both emissions here sit on the SAME edge
 * as the broadcast, so a mailbox failing once per folder forever produces one
 * record, not a per-failure counter of network weather. Emission is
 * fire-and-forget and wrapped: a telemetry failure may not change the state or
 * reach the caller.
 *
 * ---------------------------------------------------------------------------
 * Field diagnosis instrumentation (incident 2026-08-24). APPENDED — nothing
 * above this line changed, and neither did any behaviour.
 *
 * Observed: one mailbox produced eight or more `errorClass: 'auth'` failures
 * inside half an hour while five other accounts synced normally, and the badge
 * never appeared. Nothing in the log could say WHERE the verdict was lost, so
 * the four boundaries a verdict crosses are now each traceable from a single
 * log read:
 *
 *   (i)   what reached `noteFailure`, and how the classifier read it
 *         ("reported failure classified", errorClass enum);
 *   (ii)  every mutation of the streak with its cause ("auth failure streak
 *         changed"), including the deletions — the ones from `clearFlag` most
 *         of all, because a success wiping a streak is the leading suspect;
 *   (iii) every verdict discarded on the (id, generation) test ("verdict
 *         discarded before it could move the flag"), the second candidate:
 *         a stale or absent stamp drops a verdict in total silence;
 *   (iv)  every publish and the size of the payload that left ("auth state
 *         published to the renderer").
 *
 * All of it writes at `info`, deliberately. `initLogger` (electron/logger.ts)
 * puts `info` and above in the log FILE and drops `debug` entirely, so a
 * `debug` line is invisible in precisely the situation these lines exist for —
 * a user sending in a log after a mailbox went quiet. That is also why the two
 * pre-existing `debug` lines on the identity path were raised to `info`: they
 * carried (iii), and (iii) has never once been readable in the field.
 *
 * Throttling, where a line could flood: an unregistered generation provider
 * makes EVERY verdict unattributable, one per outward IMAP operation, so the
 * discard line is emitted for the 1st and then every 10th per account and
 * carries the running total. Volume elsewhere is bounded by the number of IMAP
 * failures (already one log line each in main) or by real flag transitions.
 *
 * PII: account ids, generations, counters and closed enums only — never a
 * host, an address, or any text that came from the server. Pinned by the
 * "logs no server-supplied text" test, which now reads the `info` calls too.
 */

import { createLogger } from '../logger'
import { captureException } from '../sentry'
import { recordEvent } from '../metrics'
import { bucketCount } from '../metricsBuckets'
import type { DOMAINS } from '../metricsSchema'
// Type-only: erased at build time, so importing the imap module (and ImapFlow
// with it) is not required to depend on its classification vocabulary. The
// runtime function is injected — see `AccountAuthStateDeps.classifyError`.
import type { classifyImapError } from '../../packages/net/imap'

const log = createLogger('AccountAuthState')

/** The four classes produced by `classifyImapError`. Derived from the function
 *  itself so a future class cannot drift out of sync with this service. */
export type ImapErrorClass = ReturnType<typeof classifyImapError>

/**
 * Consecutive auth failures required before an account is flagged. See the
 * module JSDoc — one failure is a plausible refresh race, two is a credential
 * that no longer works.
 */
export const AUTH_FAILURE_THRESHOLD = 2

/** Payload of the `accounts:authStateChanged` broadcast and of the
 *  `accounts:authState` pull channel. Ids only — no addresses, no host names,
 *  no server text: this reaches every open renderer window. */
export type AccountAuthStatePayload = {
  /** Account ids currently believed to need re-authentication. Ascending. */
  needsReauth: number[]
}

export type AccountAuthStateDeps = {
  /** `classifyImapError` from packages/net/imap. Injected rather than imported
   *  so the unit tests do not drag ImapFlow into the module graph — there is
   *  exactly one production wiring, in electron/main.ts. */
  classifyError: (err: unknown) => ImapErrorClass
  /** main.ts broadcast(). Returns the number of windows reached; a broadcast
   *  that reached nobody is not a problem here because the renderer pulls the
   *  current snapshot on mount (`accounts:authState`). */
  broadcast: (channel: 'accounts:authStateChanged', payload: AccountAuthStatePayload) => number
  /** Does this id address a live account?
   *
   *  Two consumers, neither of them an identity test (identity is the
   *  (id, generation) pair — see the module JSDoc):
   *    - `currentGeneration`, so an id that addresses nothing reports `null`
   *      rather than "generation 0" and its verdicts stay unattributable;
   *    - the raise transition, as defence in depth behind the stamp. Every
   *      entry point is stamped now, `noteMissingCredentials` included (fix
   *      wave 5 took its generation argument), but a caller that stamped an id
   *      from somewhere other than `currentGeneration` can still present
   *      generation 0 for an id that addresses nothing — and a badge raised for
   *      such an id would be invisible and unclearable (see `raiseFlag`).
   *
   *  Must be cheap and synchronous; the production wiring is the account store
   *  lookup main.ts already uses. It sits on the hot path via the generation
   *  provider (once per outward IMAP operation, not once per retry), which is
   *  what "cheap" has to mean here. */
  accountExists: (accountId: number) => boolean
}

/**
 * `code` carried by the error `assertImapAuth` (electron/main.ts) throws when
 * an account has neither a password nor an access token.
 *
 * Why a discriminator instead of a classifier case: this is a LOCAL
 * precondition violation, not a server response, and it is raised before any
 * connection is attempted. Routing it through `classifyImapError` would be
 * wrong twice over — the message never reaches the connection boundary, and its
 * wording ("authentication ... is not configured") does not match the auth
 * patterns anyway, so it would be filed as 'network' and silently ignored. The
 * project keeps exactly one classifier for SERVER failures (CLAUDE.md §5);
 * teaching it about our own preconditions would blur that.
 */
export const IMAP_AUTH_NOT_CONFIGURED_CODE = 'ERR_IMAP_AUTH_NOT_CONFIGURED'

/**
 * Build an error meaning "this account cannot even attempt a login", tagged
 * with the discriminator above.
 *
 * The message is the caller's, because the situations differ in a way worth
 * keeping in the log (no password at all vs. no stored OAuth refresh token) —
 * but the MACHINE-READABLE part is ours and identical for all of them, which is
 * what keeps the decision "is this a credentials problem" out of message
 * matching. Callers must keep the message free of secrets and of provider
 * response text: an account id is the only identifier allowed in it.
 */
export function authNotConfiguredError(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { code: string }).code = IMAP_AUTH_NOT_CONFIGURED_CODE
  return err
}

/** The error `assertImapAuth` throws, tagged with the discriminator above.
 *  The message stays free of secrets: an account id, nothing else. */
export function imapAuthNotConfiguredError(accountId: number): Error {
  return authNotConfiguredError(`IMAP authentication for account #${accountId} is not configured`)
}

/** Recognise the error above wherever it surfaces — including the case where
 *  the precondition is checked inside an already-wrapped operation and the
 *  failure therefore arrives through the connection boundary. */
export function isImapAuthNotConfiguredError(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === IMAP_AUTH_NOT_CONFIGURED_CODE
}

export type AccountAuthStateService = {
  /**
   * The current generation of an account id, or `null` when the id addresses no
   * live account. This is the function main.ts registers with packages/net as
   * the generation provider (`registerAccountGenerationProvider`), and the same
   * function callers use to stamp an operation they own before starting it.
   *
   * Synchronous, cheap and total by contract: it is read on the hot path of
   * every outward IMAP operation and may never throw, delay or otherwise change
   * that operation. `0` is a perfectly ordinary generation (an account that has
   * never had its id freed) and must not be confused with "no stamp" — the
   * absent value is `null`.
   */
  currentGeneration: (accountId: number) => number | null
  /**
   * Report a failed IMAP operation for an account, as seen by the connection
   * boundary, stamped with the generation read when the operation STARTED.
   *
   * Discarded unless the stamp still matches the id's generation — including
   * when the stamp is `null` (unattributable, see the module JSDoc). Discarding
   * moves nothing, but it is not silent: it leaves a throttled `info` line
   * (`traceDiscardedVerdict` — the 1st and then every 10th per account), which
   * is how an unregistered generation provider becomes visible instead of just
   * making the badge never move.
   * Non-auth classes are ignored entirely; an error carrying
   * `IMAP_AUTH_NOT_CONFIGURED_CODE` is treated as `noteMissingCredentials`
   * rather than handed to the server-error classifier. Never throws.
   */
  noteFailure: (accountId: number, accountGeneration: number | null, err: unknown) => void
  /**
   * Report a successful IMAP operation for an account, stamped like
   * `noteFailure`: clears the streak and, if the account was flagged, clears
   * the flag and broadcasts. Never throws.
   *
   * The stamp matters in this direction too, and not symmetrically for show: a
   * stale SUCCESS reported by an operation of a deleted mailbox would clear a
   * badge the mailbox that inherited the id had genuinely earned.
   */
  noteSuccess: (accountId: number, accountGeneration: number | null) => void
  /**
   * Report that the user has just finished signing in again for this account
   * (the OAuth reconnect handlers, whose IMAP verification runs on a throwaway
   * connection with no account id and therefore outside the boundary). Clears
   * the streak and the flag. Never throws.
   *
   * No generation stamp, and none is possible: the evidence is an interactive
   * flow that has just written credentials for the account with this id, so the
   * incarnation it refers to is by construction the current one. Callers must
   * report it only after the verification actually passed.
   */
  noteSignedIn: (accountId: number) => void
  /**
   * Report that the account cannot even attempt a login because it has no
   * credentials configured. Raises the flag immediately. Never throws.
   *
   * No threshold here, and that is the point. The threshold of two exists to
   * absorb ONE race against a live server (a token refresh that lost to a
   * server-side revocation); there is no server and no race in a local
   * precondition check, so a second observation would add nothing but delay —
   * and for a mailbox whose folders are all on manual sync there may never BE
   * a second attempt. Idempotent: the flag is edge-triggered, so repeating the
   * report on every blocked operation produces one broadcast, not a stream.
   *
   * Stamped, and required to be (§2.165 fix wave 5). "No credentials" is a
   * verdict about the record the caller read, and every caller reads it across
   * at least one await — the secret-store lookup for a refresh token, the
   * config load that precedes `assertImapAuth`. A mailbox deleted inside that
   * window frees its id to the next account created ("max + 1"), so an unstamped
   * report lands the badge on a brand-new, perfectly healthy mailbox. The rule
   * is the same one the boundary follows: read the generation BEFORE the first
   * await of the operation, hand it in here, and let the service drop the
   * verdict if the id has changed hands since.
   */
  noteMissingCredentials: (accountId: number, accountGeneration: number | null) => void
  /**
   * Report that a whole login attempt was REJECTED and abandoned: the caller
   * owns the attempt, has nothing left to retry, and the error it holds is the
   * server's verdict on the credentials. Raises the flag immediately when that
   * verdict is `auth`; ignores every other class exactly like `noteFailure`
   * (a network flap here is still weather, not a revoked password). Never
   * throws.
   *
   * Why this exists, and why it skips the threshold. The threshold of two
   * assumes the stream will keep producing evidence — true for the periodic
   * sync walking folders, false for a mailbox whose folders are all on manual
   * sync and whose only outward connection is the IDLE prologue. That prologue
   * is a full login; when it is refused, `startIdle` throws and stops, so the
   * second observation the threshold waits for is never made. Under the plain
   * counting rule such a mailbox would never show the badge at all — the exact
   * defect §2.165 set out to close, mirrored.
   *
   * Why it cannot double-count. This is not a second failure report: it does
   * not touch the streak, it performs the raise TRANSITION, and the transition
   * is edge-triggered (`raiseFlag` returns immediately for an already-flagged
   * account). The boundary's own report of the same failure only incremented a
   * counter whose purpose — deciding when to raise — has by then been served.
   * One rejected login therefore yields one broadcast and one telemetry record,
   * whichever of the two reports arrives first.
   *
   * Stamped like the boundary reports, with the generation read BEFORE the
   * login attempt started (the caller owns the attempt, so it can and must take
   * the stamp itself). Without it this raise-on-sight path would be the one
   * place where a login begun for a mailbox that was deleted mid-attempt could
   * still flag whatever inherited its id.
   */
  noteLoginRejected: (accountId: number, accountGeneration: number | null, err: unknown) => void
  /**
   * Drop all state for an account (deletion) and BUMP ITS GENERATION.
   * Broadcasts if it was flagged.
   *
   * Call only once the account is actually gone — the requirement is doubly
   * load-bearing. An account whose deletion failed still exists and is still
   * broken, and clearing its flag would remove the only warning the user has
   * until two fresh consecutive auth failures accumulate; on top of that, the
   * generation bump invalidates every verdict of every operation already in
   * flight for that id, so calling it for a mailbox that survived would discard
   * that mailbox's own verdicts. See the ordering pinned in
   * `electron/main.accountAuthStateWiring.test.ts` for `accounts:remove`.
   *
   * "Actually gone" is a property of the account store, not of the deletion
   * call's outcome (§2.165 fix wave 5). A deletion that rejects part-way can
   * still have removed the account record, so the caller must decide by looking
   * rather than by whether the promise resolved. A vanished record with no
   * `forget()` is the worst of both worlds: the id is free to be handed to the
   * next account created while its generation still admits every verdict of the
   * mailbox that is gone.
   */
  forget: (accountId: number) => void
  /** Current snapshot — served to a renderer window on mount. */
  snapshot: () => AccountAuthStatePayload
}

/** PII-safe error identifier: the Node error code when present, otherwise
 *  'unknown'. Never the raw message (IMAP servers echo user-supplied text). */
function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : 'unknown'
}

/** Closed bucket domain of `account.reauth_cleared.flag_duration`. */
export type ReauthFlagDurationBucket = (typeof DOMAINS)['account_reauth_flag_duration'][number]

/**
 * How long a flag stood, as one of the buckets the schema allows. Lives here
 * rather than in metricsBuckets.ts because it is the only user: the spans of
 * interest are minutes-to-days, which none of the shared bucketers cover
 * (the closest, bucketSessionLength, saturates at 2h — where this metric's
 * most interesting band, "silently broken all night", only starts).
 *
 * A missing or nonsensical raise time reports 'unknown' rather than guessing:
 * a fabricated '<1min' would read as the healthy case and hide the bug.
 */
export function bucketReauthFlagDuration(ms: number): ReauthFlagDurationBucket {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  const minutes = ms / 60_000
  if (minutes < 1) return '<1min'
  if (minutes < 10) return '1-10min'
  if (minutes < 60) return '10-60min'
  if (minutes < 6 * 60) return '1-6h'
  if (minutes < 24 * 60) return '6-24h'
  return '24h+'
}

export function initAccountAuthState(deps: AccountAuthStateDeps): AccountAuthStateService {
  /** accountId → consecutive auth failures observed since the last success. */
  const authFailureStreak = new Map<number, number>()
  /** accountId of every account currently flagged. This set IS the broadcast
   *  payload; nothing else may claim to be the state. */
  const flagged = new Set<number>()
  /** accountId → Date.now() at the moment the flag was raised. Telemetry only:
   *  it feeds the `flag_duration` bucket and never influences the state. */
  const flaggedAt = new Map<number, number>()
  /**
   * accountId → how many times this id has been freed (§2.165 fix wave 4).
   * Absent means zero: every id starts at generation 0, which is an ordinary
   * generation and not a marker.
   *
   * Written only by `forget()`, i.e. once per committed deletion, and never
   * pruned — a forgotten entry would reset the id to 0 and re-admit exactly the
   * verdicts the bump invalidated. That is affordable because it grows by one
   * per DELETION, holds a number per id, and dies with the process (the state
   * it protects is in-memory too, so a restart starts both from scratch).
   */
  const generations = new Map<number, number>()

  /**
   * accountId → how many verdicts have been discarded for it on the identity
   * test. Diagnosis only: it throttles the line below and never influences a
   * decision. Not pruned, for the same reason `generations` is not.
   */
  const discardedVerdicts = new Map<number, number>()

  /** Boundary (iii) — a verdict dropped before it could move anything. */
  function traceDiscardedVerdict(
    accountId: number,
    reason: 'unattributable' | 'previous_incarnation',
    reportedGeneration: number | null,
  ): void {
    const discarded = (discardedVerdicts.get(accountId) ?? 0) + 1
    discardedVerdicts.set(accountId, discarded)
    // 1st, then every 10th: an unregistered generation provider would otherwise
    // put one line in the file per outward IMAP operation.
    if (discarded !== 1 && discarded % 10 !== 0) return
    log.info('verdict discarded before it could move the flag', {
      accountId,
      reason,
      reportedGeneration: reportedGeneration ?? 'absent',
      currentGeneration: generationOf(accountId),
      discardedTotal: discarded,
    })
  }

  /** Boundary (i) — how the injected classifier read a reported failure. The
   *  two synthetic values are ours, not the classifier's vocabulary. */
  function traceClassification(
    accountId: number,
    errorClass: ImapErrorClass | 'not_configured' | 'classifier_failed',
  ): void {
    log.info('reported failure classified', {
      accountId,
      errorClass,
      credentialsEvidence: errorClass === 'auth' || errorClass === 'not_configured',
    })
  }

  /** Every cause that can move the streak. `cleared_*` are the deletions — the
   *  ones the interleaving hypothesis turns on. */
  type StreakChangeCause =
    | 'auth_failure'
    | 'threshold_reached'
    | 'cleared_by_success'
    | 'cleared_by_sign_in'
    | 'cleared_no_live_account'
    | 'cleared_by_forget'

  /** Boundary (ii) — one line per streak mutation, with what caused it. */
  function traceStreakChange(
    accountId: number,
    cause: StreakChangeCause,
    from: number,
    to: number,
  ): void {
    log.info('auth failure streak changed', {
      accountId,
      cause,
      from,
      to,
      threshold: AUTH_FAILURE_THRESHOLD,
      flagged: flagged.has(accountId),
    })
  }

  function snapshot(): AccountAuthStatePayload {
    return { needsReauth: [...flagged].sort((a, b) => a - b) }
  }

  /**
   * Fire-and-forget telemetry for one flag transition.
   *
   * `recordEvent` already swallows its own failures, but this wrapper is what
   * makes that a property of THIS service rather than of a module it happens to
   * import: a future sink, a mocked module or a partially-initialised metrics
   * pipeline must never turn a sync outcome into an exception.
   */
  function emitCleared(accountId: number, reason: 'signed_in' | 'account_removed'): void {
    const raisedAt = flaggedAt.get(accountId)
    flaggedAt.delete(accountId)
    try {
      recordEvent('account.reauth_cleared', {
        reason,
        flag_duration: bucketReauthFlagDuration(
          typeof raisedAt === 'number' ? Date.now() - raisedAt : Number.NaN,
        ),
      })
    } catch { /* telemetry must never break the transition */ }
  }

  /** Latch for the report below: true while the last lookup was a failure. */
  let existenceLookupFailing = false

  /**
   * Does this account still exist?
   *
   * Fail-OPEN on a throwing lookup: the cost of a wrong "yes" is a badge for an
   * id the renderer already filters out against its own account list, while the
   * cost of a wrong "no" is suppressing the only warning a genuinely broken
   * mailbox produces. A store read that throws is itself worth a report.
   *
   * Reported on the EDGE, not per call (§2.165 fix wave 4). This used to run
   * twice per failure streak; the generation provider put it on the path of
   * every outward IMAP operation, so an unreadable store would otherwise emit
   * one Sentry event per operation — telemetry may not turn a broken dependency
   * into a flood (CLAUDE.md §8). The latch clears on the first lookup that
   * works, so a later, separate outage is reported again.
   */
  function accountStillExists(accountId: number): boolean {
    try {
      const exists = deps.accountExists(accountId)
      existenceLookupFailing = false
      return exists
    } catch (err) {
      if (!existenceLookupFailing) {
        existenceLookupFailing = true
        log.warn('account existence lookup failed, assuming the account exists', {
          accountId,
          code: errCode(err),
        })
        captureException(err, { source: 'account_auth_state', step: 'account_exists' })
      }
      return true
    }
  }

  /**
   * The generation this id currently holds, as a pure map read.
   *
   * No store lookup on purpose: this runs on every verdict, and the question it
   * answers ("is the reporting operation still about the mailbox it was issued
   * for") is decided entirely by data this service owns. Existence belongs to
   * the two places that ask a different question — see `currentGeneration` and
   * `raiseFlag`.
   */
  function generationOf(accountId: number): number {
    return generations.get(accountId) ?? 0
  }

  /**
   * The generation provider handed to packages/net, and the stamp source for
   * callers that own a whole login attempt.
   *
   * `null` for an id that addresses no live account: without that, a verdict
   * about an id that never existed would carry generation 0, match, and be
   * acted upon. Never throws — `accountStillExists` absorbs a failing lookup —
   * because packages/net calls this synchronously on the path of a real IMAP
   * operation.
   */
  function currentGeneration(accountId: number): number | null {
    if (!accountStillExists(accountId)) return null
    return generationOf(accountId)
  }

  /**
   * Is this stamped verdict still about the mailbox that produced it?
   *
   * `null` is a MISMATCH, never a wildcard: the boundary could not attribute
   * the verdict, and an unattributable verdict may not move a user-visible
   * warning (module JSDoc). Same rule in both directions — a stale success is
   * as wrong as a stale failure, it just fails the other way.
   */
  function isCurrentIncarnation(accountId: number, accountGeneration: number | null): boolean {
    if (accountGeneration === null) {
      traceDiscardedVerdict(accountId, 'unattributable', accountGeneration)
      return false
    }
    if (accountGeneration === generationOf(accountId)) return true
    traceDiscardedVerdict(accountId, 'previous_incarnation', accountGeneration)
    return false
  }

  /** Edge-triggered publish. Called only from the places that mutate
   *  `flagged`, so a broadcast implies a real transition. */
  function publish(): void {
    try {
      // Boundary (iv): what left, and how many windows it reached. A badge that
      // never appears has to be told apart from a payload that never left.
      // Everything stays inside the try, so the containment this function had
      // before the instrumentation is unchanged, statement for statement.
      const payload = snapshot()
      const windows = deps.broadcast('accounts:authStateChanged', payload)
      log.info('auth state published to the renderer', {
        accountIds: payload.needsReauth,
        size: payload.needsReauth.length,
        windows,
      })
    } catch (err) {
      log.error('failed to broadcast account auth state', { code: errCode(err) })
      captureException(err, { source: 'account_auth_state', step: 'broadcast' })
    }
  }

  /**
   * Is this failure evidence about the credentials, and of which kind?
   *
   * Shared by every failure entry point so that "what counts as an auth
   * problem" is decided in one place: the two reports differ in what they do
   * with the verdict (count it vs. act on it), never in how they read it.
   * Returns null for anything that is not evidence — including a classifier
   * that throws, because an unknown outcome may never raise a credentials
   * warning.
   */
  function credentialsVerdict(accountId: number, err: unknown): 'auth' | 'missing_credentials' | null {
    // "No credentials configured" carries its own discriminator and means the
    // same thing wherever it surfaces — including from inside a wrapped
    // operation, where it reaches us through the connection boundary. It must
    // not be handed to the server-error classifier, which would file it as
    // 'network' and drop it (see IMAP_AUTH_NOT_CONFIGURED_CODE).
    if (isImapAuthNotConfiguredError(err)) {
      traceClassification(accountId, 'not_configured')
      return 'missing_credentials'
    }
    let errorClass: ImapErrorClass
    try {
      errorClass = deps.classifyError(err)
    } catch (classifyErr) {
      log.warn('error classification failed, ignoring failure', {
        accountId,
        code: errCode(classifyErr),
      })
      traceClassification(accountId, 'classifier_failed')
      return null
    }
    traceClassification(accountId, errorClass)
    // network / cert / permanent: not evidence about credentials in either
    // direction (see module JSDoc).
    return errorClass === 'auth' ? 'auth' : null
  }

  /**
   * Raise the flag for an account, once.
   *
   * Shared by the three ways an account can be judged signed-out: a streak of
   * auth failures reported by the connection boundary, a credentials
   * precondition that fails locally before any connection is attempted, and a
   * login attempt the server rejected outright.
   *
   * The existence check is NOT the identity test — that is the (id, generation)
   * pair, applied by every entry point before it gets here (since fix wave 5
   * that includes `noteMissingCredentials`, the last unstamped one). It stays as
   * defence in depth for the one thing the pair does not decide: an id that
   * never addressed anything at all still holds generation 0 for a caller that
   * stamped it from somewhere other than `currentGeneration`, and a badge raised
   * for such an id would be invisible to the user (the renderer filters the
   * payload against its own account list) and unclearable forever, since an id
   * with no mailbox behind it produces no successes. Edge-triggered, so a live
   * account costs one lookup per raise, never one per failure.
   */
  function raiseFlag(
    accountId: number,
    cause: 'auth_failures' | 'missing_credentials' | 'login_rejected',
  ): void {
    if (flagged.has(accountId)) return // already surfaced — no repaint
    if (!accountStillExists(accountId)) {
      // Nothing behind this id. Drop the streak along with the raise, so a
      // later report starts from zero instead of resuming a count that belongs
      // to no mailbox.
      const streak = authFailureStreak.get(accountId) ?? 0
      authFailureStreak.delete(accountId)
      log.info('refusing to flag an id that addresses no live account', { accountId, cause, streak })
      if (streak > 0) traceStreakChange(accountId, 'cleared_no_live_account', streak, 0)
      return
    }
    flagged.add(accountId)
    flaggedAt.set(accountId, Date.now())
    log.warn('account flagged as needing re-authentication', { accountId, cause })
    // On the transition only — the early return above is what keeps this from
    // becoming a counter of failed attempts.
    try {
      recordEvent('account.reauth_flagged', {
        flagged_accounts_bucket: bucketCount(flagged.size),
      })
    } catch { /* telemetry must never break the transition */ }
    publish()
  }

  /** Clear both halves of the per-account state and publish if that was a real
   *  transition. Shared by the two proofs of a working login: a success at the
   *  connection boundary and a completed interactive sign-in. */
  function clearFlag(accountId: number, cause: 'success' | 'signed_in'): void {
    // The deletion below is the leading suspect of the 2026-08-24 incident: it
    // is unconditional, so any success on the account wipes a streak that was
    // one report short of the threshold. `cause` exists only to name it in the
    // log — the clearing itself is unchanged, in both directions.
    const streak = authFailureStreak.get(accountId) ?? 0
    authFailureStreak.delete(accountId)
    if (streak > 0) {
      traceStreakChange(
        accountId,
        cause === 'success' ? 'cleared_by_success' : 'cleared_by_sign_in',
        streak,
        0,
      )
    }
    if (!flagged.delete(accountId)) return
    log.info('account re-authenticated, clearing flag', { accountId })
    emitCleared(accountId, 'signed_in')
    publish()
  }

  return {
    currentGeneration,

    noteFailure(accountId: number, accountGeneration: number | null, err: unknown): void {
      try {
        // Boundary (i), first half: this is what actually reached the service.
        // Printed before the identity test, so a verdict lost there still shows
        // that the failure arrived at all.
        log.info('failure reported to the auth state', {
          accountId,
          reportedGeneration: accountGeneration ?? 'absent',
          currentGeneration: generationOf(accountId),
          streak: authFailureStreak.get(accountId) ?? 0,
          flagged: flagged.has(accountId),
        })
        // Identity first, before the error is even classified: a verdict issued
        // for a different incarnation of this id is not evidence about the
        // mailbox that holds it now, whatever it says.
        if (!isCurrentIncarnation(accountId, accountGeneration)) return
        const verdict = credentialsVerdict(accountId, err)
        if (verdict === null) return // not evidence — the streak is left alone
        if (verdict === 'missing_credentials') {
          raiseFlag(accountId, 'missing_credentials')
          return
        }
        const before = authFailureStreak.get(accountId) ?? 0
        const streak = before + 1
        authFailureStreak.set(accountId, streak)
        traceStreakChange(accountId, 'auth_failure', before, streak)
        if (streak < AUTH_FAILURE_THRESHOLD) return
        traceStreakChange(accountId, 'threshold_reached', streak, streak)
        raiseFlag(accountId, 'auth_failures')
      } catch (unexpected) {
        log.error('noteFailure failed', { accountId, code: errCode(unexpected) })
        captureException(unexpected, { source: 'account_auth_state', step: 'note_failure', accountId })
      }
    },

    noteMissingCredentials(accountId: number, accountGeneration: number | null): void {
      try {
        // Identity first, exactly like the boundary reports: the caller read
        // "this account has no credentials" from a record it fetched across an
        // await, and an id can change hands inside that window.
        if (!isCurrentIncarnation(accountId, accountGeneration)) return
        raiseFlag(accountId, 'missing_credentials')
      } catch (unexpected) {
        log.error('noteMissingCredentials failed', { accountId, code: errCode(unexpected) })
        captureException(unexpected, {
          source: 'account_auth_state',
          step: 'note_missing_credentials',
          accountId,
        })
      }
    },

    noteLoginRejected(accountId: number, accountGeneration: number | null, err: unknown): void {
      try {
        if (!isCurrentIncarnation(accountId, accountGeneration)) return
        const verdict = credentialsVerdict(accountId, err)
        if (verdict === null) return
        // No streak arithmetic on purpose: this is the transition itself, not
        // another observation to count. See the interface JSDoc for why that is
        // what keeps one rejected login from being counted twice.
        raiseFlag(accountId, verdict === 'missing_credentials' ? 'missing_credentials' : 'login_rejected')
      } catch (unexpected) {
        log.error('noteLoginRejected failed', { accountId, code: errCode(unexpected) })
        captureException(unexpected, {
          source: 'account_auth_state',
          step: 'note_login_rejected',
          accountId,
        })
      }
    },

    noteSuccess(accountId: number, accountGeneration: number | null): void {
      try {
        // Same rule as the failure path, and needed just as much: a success
        // reported by an operation of the mailbox that used to hold this id
        // would clear a badge its successor genuinely earned.
        if (!isCurrentIncarnation(accountId, accountGeneration)) return
        clearFlag(accountId, 'success')
      } catch (unexpected) {
        log.error('noteSuccess failed', { accountId, code: errCode(unexpected) })
        captureException(unexpected, { source: 'account_auth_state', step: 'note_success', accountId })
      }
    },

    noteSignedIn(accountId: number): void {
      try {
        clearFlag(accountId, 'signed_in')
      } catch (unexpected) {
        log.error('noteSignedIn failed', { accountId, code: errCode(unexpected) })
        captureException(unexpected, { source: 'account_auth_state', step: 'note_signed_in', accountId })
      }
    },

    forget(accountId: number): void {
      try {
        // First, before anything that could fail: this call IS the deletion
        // signal, and the bump is what invalidates every verdict already in
        // flight for the mailbox that just went away — whether it lands before
        // or after the id is issued to a new one.
        generations.set(accountId, generationOf(accountId) + 1)
        const streak = authFailureStreak.get(accountId) ?? 0
        authFailureStreak.delete(accountId)
        log.info('account forgotten, generation bumped', {
          accountId,
          generation: generationOf(accountId),
          streak,
          wasFlagged: flagged.has(accountId),
        })
        if (streak > 0) traceStreakChange(accountId, 'cleared_by_forget', streak, 0)
        if (!flagged.delete(accountId)) {
          // Not flagged: drop any stale raise time and emit nothing — there was
          // no state to clear, so there is no transition to report.
          flaggedAt.delete(accountId)
          return
        }
        emitCleared(accountId, 'account_removed')
        publish()
      } catch (unexpected) {
        log.error('forget failed', { accountId, code: errCode(unexpected) })
        captureException(unexpected, { source: 'account_auth_state', step: 'forget', accountId })
      }
    },

    snapshot,
  }
}
