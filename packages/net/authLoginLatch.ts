/**
 * Per-account login latch: after the server has refused this account's
 * credentials, stop opening new authenticated connections for it on a timer.
 *
 * Why this exists. A mailbox whose stored password is wrong (changed on the
 * server, app-password revoked, typo saved once) produced roughly twelve failed
 * LOGINs per folder per hour, forever: the periodic pass walks folders
 * sequentially, every folder opens its own dedicated connection, and nothing in
 * the chain remembered that the previous folder had just been told "no". Field
 * evidence: 2060 `imap.sync` auth failures for one mailbox over eight days, a
 * steady ~50/h. Servers read that as credential stuffing and lock the account
 * out; K-9 Mail and Thunderbird both stop retrying a rejected login on a timer
 * and wait for the user to fix the credentials instead.
 *
 * Shape of the guarantee: **a rejected account gets at most one login attempt
 * per window, and the window grows towards an hour.** It is not "no attempts
 * ever" — the latch has to be able to notice that the user fixed the password
 * without being told, so every window admits one probe whose success clears the
 * latch outright.
 *
 * Why escalating windows rather than one flat hour. The re-authentication badge
 * is raised after TWO consecutive auth verdicts (§2.165: one failure is a
 * plausible refresh race). A flat 60-minute window from the very first failure
 * would mean the second real login — the one the threshold needs — cannot
 * happen for an hour, so the storm would be traded for an hour of silence on a
 * mailbox that is visibly broken. That is the same defect §2.165 set out to
 * close, mirrored. The schedule below keeps the second attempt about a minute
 * away, then converges to one attempt per hour, which is the steady-state rate
 * the auth backoff asks for.
 *
 * Identity is the PAIR (accountId, generation), never the id alone — account
 * ids are reused ("max + 1"), so a latch keyed on the id would hold back a
 * brand-new mailbox that inherited the id of a broken one. A generation
 * mismatch drops the entry rather than consulting it.
 *
 * A `null` generation (no provider registered, id addresses nothing, provider
 * misbehaved) is a KEY, not a wildcard: it matches only another `null`. In the
 * only configuration where that happens in bulk — no provider registered at all
 * — every stamp is `null`, the comparison is consistent and the latch works
 * normally. Mixed with real generations it is treated as unattributable and
 * never displaces an attributable entry (`isStaleForEntry`), which is the same
 * direction §2.165 chose for the badge: a verdict nobody can attribute moves
 * nothing.
 *
 * Layer purity: no imports at all, in particular nothing from electron/. Tests
 * live next to the file, like ./authRefreshCooldown, whose shape this follows.
 */

/**
 * `code` carried by the error the connection boundary throws INSTEAD of opening
 * a connection while the latch is closed.
 *
 * A discriminator, not a classifier case, and not a message pattern — the same
 * reasoning as `IMAP_AUTH_NOT_CONFIGURED_CODE` in
 * electron/services/accountAuthState.ts: this is a LOCAL policy refusal decided
 * before any socket exists, and `classifyImapError` classifies what a SERVER
 * said. Teaching the classifier about our own preconditions would blur the one
 * classifier the project has (CLAUDE.md §5).
 */
export const IMAP_AUTH_BACKOFF_CODE = 'ERR_IMAP_AUTH_BACKOFF'

/** Recognise the refusal above wherever it surfaces. */
export function isImapAuthBackoffError(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === IMAP_AUTH_BACKOFF_CODE
}

/**
 * Build the refusal error.
 *
 * The wording is chosen to be inert for `classifyImapError`: it deliberately
 * avoids every token that classifier matches ("LOGIN", "CREDENTIALS",
 * "AUTHENTICATE", "AUTHENTICATIONFAILED", …) so that a copy of this error which
 * somehow reaches a classification path is filed as the harmless default rather
 * than counted as a second server rejection. The machine-readable part is the
 * `code` above; nothing downstream may decide anything from this text. It
 * carries an account id and a duration and nothing else — no host, no user, no
 * server text.
 */
export function imapAuthBackoffError(accountId: number, retryInMs: number): Error {
  const seconds = Math.max(0, Math.round(retryInMs / 1000))
  const err = new Error(
    `IMAP connection for account #${accountId} is held back after an authentication failure; next attempt in ${seconds}s`,
  )
  ;(err as Error & { code: string }).code = IMAP_AUTH_BACKOFF_CODE
  return err
}

export type LoginLatchEntry = {
  /** Generation of the account this latch belongs to; `null` is a real key. */
  generation: number | null
  /** Consecutive auth rejections observed for this incarnation. */
  authFailures: number
  /** No attempt is admitted before this instant. */
  nextAttemptAt: number
}

/**
 * Windows in ms, indexed by consecutive auth failures (clamped at the tail).
 *
 * The tail (60 min) is the `BACKOFF_MS.auth` figure the rest of the module
 * already uses for auth backoff (K-9: auth = 60 min); it is repeated as a
 * literal here because that table lives in ./imap and importing it back would
 * make the two files circular.
 */
export const LOGIN_LATCH_WINDOWS_MS: readonly number[] = [
  60_000,        // 1st rejection: 1 min — keeps the badge's second verdict close
  5 * 60_000,    // 2nd: 5 min
  30 * 60_000,   // 3rd: 30 min
  60 * 60_000,   // 4th and after: 1 h (cap) — the auth backoff rate
]

const state = new Map<number, LoginLatchEntry>()

/** Test-only: clock injection for deterministic latch tests. */
let nowImpl: () => number = () => Date.now()

/** Test-only: override the internal clock. Pass null to reset. */
export function __setLoginLatchClock(fn: (() => number) | null): void {
  nowImpl = fn ?? (() => Date.now())
}

/** Test-only: wipe all latch state. Call in afterEach. */
export function __resetLoginLatch(): void {
  state.clear()
}

/** Test-only / introspection: current snapshot for a given account. */
export function peekLoginLatchEntry(accountId: number): LoginLatchEntry | undefined {
  const entry = state.get(accountId)
  return entry ? { ...entry } : undefined
}

function windowForFailures(authFailures: number): number {
  if (authFailures <= 0) return 0
  const idx = Math.min(authFailures - 1, LOGIN_LATCH_WINDOWS_MS.length - 1)
  return LOGIN_LATCH_WINDOWS_MS[idx]
}

/**
 * Is `generation` a verdict about a mailbox that no longer holds this id, given
 * the incarnation the entry belongs to?
 *
 * Second line of defence. The production caller already drops a verdict whose
 * stamp differs from the generation the id holds NOW (see
 * `notifyConnectionOutcome`), so this is about what the DATA still allows: a
 * stale verdict must never be able to overwrite a newer entry, because the next
 * attempt of the newer incarnation would then read a generation mismatch, drop
 * the entry and connect — a stale verdict releasing a live throttle.
 *
 * Generations order: `accountAuthState.forget()` only ever increments them for
 * an id, so a strictly lower number is strictly older. `null` does not order at
 * all — it means unattributable, and an unattributable verdict must not be
 * allowed to displace an attributable entry (the reverse is fine: a real stamp
 * supersedes an entry we could not attribute).
 */
function isStaleForEntry(entry: LoginLatchEntry, generation: number | null): boolean {
  if (entry.generation === generation) return false
  if (typeof entry.generation === 'number' && typeof generation === 'number') {
    return generation < entry.generation
  }
  return generation === null
}

/** Remaining hold in ms for this incarnation, or 0 when an attempt is free to
 *  go out. Read-only: it reserves nothing (see `admitLoginAttempt`). */
export function remainingLoginLatchMs(accountId: number, generation: number | null): number {
  const entry = state.get(accountId)
  if (!entry || entry.generation !== generation || entry.authFailures <= 0) return 0
  const remaining = entry.nextAttemptAt - nowImpl()
  return remaining > 0 ? remaining : 0
}

/**
 * Decide whether an outward login may go out now, and RESERVE the window if it
 * may.
 *
 * The reservation is what makes this a rate limiter rather than a suggestion:
 * the periodic pass is sequential, but the indexer, offline replay and a folder
 * sync overlap constantly, and a pure read would let all of them through in the
 * same millisecond before any of their failures had been recorded. An admitted
 * probe therefore pushes `nextAttemptAt` forward immediately, before it has any
 * outcome; recording the outcome afterwards refines it.
 *
 * A generation mismatch (including the id's first sighting under a new
 * generation) drops the stale entry and admits: the latch belonged to a mailbox
 * that no longer holds this id.
 */
export function admitLoginAttempt(accountId: number, generation: number | null): boolean {
  const entry = state.get(accountId)
  if (!entry) return true
  if (entry.generation !== generation) {
    // A caller whose own stamp is older or unattributable does not get to
    // DELETE the entry — it would hand the next attempt of the current
    // incarnation a clean slate. It is still admitted: the stamp at this point
    // was taken microseconds ago by the boundary, so "older" here means the
    // generation provider is broken or absent, and refusing an operation we
    // cannot attribute would stop the app for a bookkeeping failure.
    if (!isStaleForEntry(entry, generation)) state.delete(accountId)
    return true
  }
  if (entry.authFailures <= 0) return true
  const now = nowImpl()
  if (now < entry.nextAttemptAt) return false
  entry.nextAttemptAt = now + windowForFailures(entry.authFailures)
  return true
}

/**
 * The server rejected this account's credentials — close the latch and widen
 * the window.
 *
 * Counted per incarnation: a verdict stamped with a generation other than the
 * one already latched starts its own streak rather than inheriting the previous
 * mailbox's.
 */
export function noteLatchAuthFailure(accountId: number, generation: number | null): void {
  const prev = state.get(accountId)
  // A verdict older than the entry is dropped rather than written: overwriting
  // would re-stamp the entry with the departed mailbox's generation, and the
  // next attempt of the live one would read a mismatch and be let straight
  // through. See `isStaleForEntry`.
  if (prev && isStaleForEntry(prev, generation)) return
  const authFailures = (prev && prev.generation === generation ? prev.authFailures : 0) + 1
  state.set(accountId, {
    generation,
    authFailures,
    nextAttemptAt: nowImpl() + windowForFailures(authFailures),
  })
}

/**
 * An outward operation for this account succeeded — the credentials work, so
 * the latch is gone entirely and the next failure starts from zero.
 *
 * Only the matching incarnation may clear: a success reported by an operation
 * of a mailbox that has since been deleted must not unlatch whatever inherited
 * its id.
 */
export function noteLatchSuccess(accountId: number, generation: number | null): void {
  const entry = state.get(accountId)
  if (!entry) return
  if (entry.generation !== generation) return
  state.delete(accountId)
}

/**
 * Drop the latch for an account unconditionally.
 *
 * For the events that change the INPUT rather than observe the outcome: the
 * user saved new credentials, finished an interactive re-authentication, or the
 * account was deleted. None of those are proof that the login works — they are
 * proof that the thing we were holding back on has changed, so the next attempt
 * is owed a real trip to the server.
 */
export function clearLoginLatch(accountId: number): void {
  state.delete(accountId)
}
