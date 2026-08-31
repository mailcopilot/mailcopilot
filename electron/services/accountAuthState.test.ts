import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * §2.157 — unit tests for the per-account "needs re-authentication" state.
 *
 * Covers the four transitions the acceptance criteria name, plus the
 * containment rules:
 *   - auth failures reaching the threshold raise the flag exactly once
 *   - network / cert / permanent failures never raise it
 *   - the first success clears it with no user action
 *   - a long run of failures produces ONE broadcast (no UI flicker)
 *   - snapshot is the authoritative pull answer for a window that opened late
 *   - no dependency failure (broadcast, classifier) propagates to the caller
 */

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('../logger', () => ({ createLogger: () => logMock }))

const captureExceptionMock = vi.hoisted(() => vi.fn())
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }))

const recordEventMock = vi.hoisted(() => vi.fn())
vi.mock('../metrics', () => ({ recordEvent: recordEventMock }))

import { METRIC_EVENTS, DOMAINS } from '../metricsSchema'
import {
  initAccountAuthState,
  AUTH_FAILURE_THRESHOLD,
  bucketReauthFlagDuration,
  authNotConfiguredError,
  imapAuthNotConfiguredError,
  isImapAuthNotConfiguredError,
  IMAP_AUTH_NOT_CONFIGURED_CODE,
  type AccountAuthStatePayload,
  type AccountAuthStateService,
  type ImapErrorClass,
} from './accountAuthState'

/** Errors carry no classification of their own here — the class is supplied by
 *  the injected classifier, exactly as `classifyImapError` does in production.
 *  `accountExists` defaults to "every account exists", which is the state the
 *  transition tests care about; the deletion-race tests override it. */
function makeService(
  classOf: (err: unknown) => ImapErrorClass = () => 'auth',
  existsOf: (accountId: number) => boolean = () => true,
) {
  const broadcast = vi.fn<(channel: 'accounts:authStateChanged', payload: AccountAuthStatePayload) => number>(
    () => 1,
  )
  const classifyError = vi.fn(classOf)
  const accountExists = vi.fn(existsOf)
  const svc = initAccountAuthState({ classifyError, broadcast, accountExists })
  return { svc, broadcast, classifyError, accountExists }
}

/**
 * §2.165 fix wave 4 — report a verdict the way the connection boundary does:
 * stamped with the generation the id holds when the operation STARTS.
 *
 * In every test that uses these helpers nothing is deleted between that moment
 * and the verdict, so the stamp is simply the current generation — which is
 * what makes them a faithful stand-in for the boundary. The tests that are
 * ABOUT identity pass explicit stamps instead, because the whole question there
 * is what happens when the two differ.
 */
function failNow(svc: AccountAuthStateService, accountId: number, err: unknown): void {
  svc.noteFailure(accountId, svc.currentGeneration(accountId), err)
}

function okNow(svc: AccountAuthStateService, accountId: number): void {
  svc.noteSuccess(accountId, svc.currentGeneration(accountId))
}

function rejectNow(svc: AccountAuthStateService, accountId: number, err: unknown): void {
  svc.noteLoginRejected(accountId, svc.currentGeneration(accountId), err)
}

/** "No credentials" reported by an operation that started now (§2.165 fix wave
 *  5 — this report is stamped like every other one). */
function noCredentialsNow(svc: AccountAuthStateService, accountId: number): void {
  svc.noteMissingCredentials(accountId, svc.currentGeneration(accountId))
}

/** Ids carried by the Nth broadcast (0-based). */
function payloadOf(broadcast: ReturnType<typeof vi.fn>, call = 0): number[] {
  return (broadcast.mock.calls[call]?.[1] as AccountAuthStatePayload).needsReauth
}

/** Tags of the Nth `recordEvent(name, tags)` call for a given metric name. */
function eventCalls(name: string): Array<Record<string, unknown>> {
  return recordEventMock.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => (c[1] ?? {}) as Record<string, unknown>)
}

beforeEach(() => {
  logMock.info.mockClear()
  logMock.warn.mockClear()
  logMock.error.mockClear()
  logMock.debug.mockClear()
  captureExceptionMock.mockClear()
  recordEventMock.mockReset()
})

describe('accountAuthState — raising the flag', () => {
  it('needs AUTH_FAILURE_THRESHOLD consecutive auth failures', () => {
    const { svc, broadcast } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD - 1; i++) {
      failNow(svc, 7, new Error('AUTHENTICATIONFAILED'))
      expect(svc.snapshot().needsReauth).toEqual([])
      expect(broadcast).not.toHaveBeenCalled()
    }
    failNow(svc, 7, new Error('AUTHENTICATIONFAILED'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('accounts:authStateChanged', { needsReauth: [7] })
  })

  it('keeps accounts independent and reports them sorted', () => {
    const { svc, broadcast } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 9, new Error('auth'))
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 2, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([2, 9])
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(payloadOf(broadcast, 0)).toEqual([9])
    expect(payloadOf(broadcast, 1)).toEqual([2, 9])
  })

  it('logs no server-supplied text when flagging', () => {
    const { svc } = makeService()
    const secret = new Error('NO LOGIN failed for user@example.com: wrong password')
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 3, secret)
    const logged = JSON.stringify(logMock.warn.mock.calls)
    expect(logged).not.toContain('example.com')
    expect(logged).not.toContain('wrong password')
  })
})

describe('accountAuthState — classes that must NOT raise the flag', () => {
  it.each<ImapErrorClass>(['network', 'cert', 'permanent'])('ignores %s failures entirely', (cls) => {
    const { svc, broadcast } = makeService(() => cls)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD * 5; i++) failNow(svc, 1, new Error('boom'))
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('does not let interleaved network failures reset the auth streak', () => {
    // A revoked credential on a flaky link produces auth, network, auth… If a
    // network blip reset the counter the badge would never appear.
    const classes: ImapErrorClass[] = ['auth', 'network', 'auth']
    let i = 0
    const { svc, broadcast } = makeService(() => classes[i++] ?? 'network')
    for (let n = 0; n < classes.length; n++) failNow(svc, 4, new Error('x'))
    expect(svc.snapshot().needsReauth).toEqual([4])
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('treats a throwing classifier as "not auth"', () => {
    const { svc, broadcast } = makeService(() => {
      throw new Error('classifier exploded')
    })
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD * 3; i++) failNow(svc, 5, new Error('x'))
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })
})

describe('accountAuthState — clearing the flag', () => {
  it('clears on the first success, with no user action', () => {
    const { svc, broadcast } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    broadcast.mockClear()
    okNow(svc, 7)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('accounts:authStateChanged', { needsReauth: [] })
  })

  it('a success also resets the streak, so the next single failure does not re-flag', () => {
    const { svc, broadcast } = makeService()
    failNow(svc, 7, new Error('auth'))
    okNow(svc, 7)
    broadcast.mockClear()
    failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('a success on an unflagged account broadcasts nothing', () => {
    const { svc, broadcast } = makeService()
    okNow(svc, 42)
    okNow(svc, 42)
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('noteSignedIn clears without a stamp — the OAuth reconnect has none to give', () => {
    // The OAuth handlers verify the fresh credentials on a throwaway connection
    // with no account id, so the boundary never sees it and there is no
    // operation to stamp. The evidence is an interactive flow that has just
    // written credentials for THIS id, so the incarnation is current by
    // construction. Mutation that fails this: routing the OAuth clear through
    // `noteSuccess` with a `null` stamp — the badge would then survive a
    // completed sign-in, which is the one moment it must disappear.
    const { svc, broadcast } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    broadcast.mockClear()
    recordEventMock.mockReset()
    svc.noteSignedIn(7)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(eventCalls('account.reauth_cleared')).toEqual([
      { reason: 'signed_in', flag_duration: '<1min' },
    ])
  })

  it('noteSignedIn also resets the streak and never throws on a broken broadcast', () => {
    const broadcast = vi.fn(() => {
      throw new Error('no windows')
    })
    const svc = initAccountAuthState({
      classifyError: () => 'auth',
      broadcast: broadcast as unknown as (c: 'accounts:authStateChanged', p: AccountAuthStatePayload) => number,
      accountExists: () => true,
    })
    failNow(svc, 7, new Error('auth'))
    expect(() => svc.noteSignedIn(7)).not.toThrow()
    // Streak gone: the next single failure must not complete a threshold.
    failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([])
  })

  it('forget() drops a flagged account and publishes the smaller set', () => {
    const { svc, broadcast } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    broadcast.mockClear()
    svc.forget(7)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).toHaveBeenCalledTimes(1)
    // Removing an unknown account is a silent no-op.
    svc.forget(7)
    expect(broadcast).toHaveBeenCalledTimes(1)
  })
})

/**
 * Removal is the one transition whose correctness lives in the ORDER of two
 * calls rather than inside this service: `accounts:remove` must delete the
 * account first and only then forget its flag. The structural half (that
 * main.ts really is written that way) is pinned in
 * `electron/main.accountAuthStateWiring.test.ts`; this is the behavioural half
 * — the model below is that handler's ordering, and it is what makes the
 * consequence of getting it wrong visible.
 */
async function removeAccountLikeHandler(
  svc: ReturnType<typeof makeService>['svc'],
  accountId: number,
  deleteAccount: () => Promise<void>,
): Promise<void> {
  await deleteAccount()
  svc.forget(accountId)
}

describe('accountAuthState — account removal that fails', () => {
  it('keeps the flag when deletion rejects: the mailbox still exists and is still broken', async () => {
    const { svc, broadcast } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    broadcast.mockClear()
    recordEventMock.mockReset()

    await expect(
      removeAccountLikeHandler(svc, 7, async () => {
        throw new Error('ENOSPC')
      }),
    ).rejects.toThrow()

    // The account survived, so its warning has to survive with it. Clearing it
    // here would leave the user with no signal until two fresh consecutive
    // auth failures accumulated — i.e. for as long as the next sync passes take.
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).not.toHaveBeenCalled()
    // …and nothing may report a clear that did not happen.
    expect(eventCalls('account.reauth_cleared')).toHaveLength(0)
  })

  it('a later retry that succeeds still clears the flag exactly once', async () => {
    const { svc, broadcast } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    broadcast.mockClear()
    recordEventMock.mockReset()

    await expect(
      removeAccountLikeHandler(svc, 7, async () => {
        throw new Error('ENOSPC')
      }),
    ).rejects.toThrow()
    await removeAccountLikeHandler(svc, 7, async () => {})

    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(eventCalls('account.reauth_cleared')).toEqual([
      { reason: 'account_removed', flag_duration: '<1min' },
    ])
  })
})

/**
 * ===========================================================================
 * CHARACTERISATION OF A SUSPECTED DEFECT — NOT A GUARANTEE WE WANT TO KEEP.
 * ===========================================================================
 *
 * Field incident 2026-08-24: one mailbox produced eight or more
 * `errorClass: 'auth'` failures between 20:45 and 21:10 while five other
 * accounts synced normally, and the "sign-in required" banner never appeared.
 * The user found out because mail stopped arriving.
 *
 * The tests below pin the behaviour that explains it, EXACTLY AS IT IS TODAY:
 * the threshold counts CONSECUTIVE failures (`AUTH_FAILURE_THRESHOLD`), and
 * `clearFlag` deletes the streak unconditionally, so any successful operation
 * on the same account resets the count to zero. A live account is worked by
 * IDLE, the periodic sync and the body indexer at once, so successes on some
 * folders are interleaved with auth failures on others — and a streak of two
 * may never form no matter how many failures occur.
 *
 * Read these as EVIDENCE, not as a specification:
 *   - a change that makes them fail is not automatically a regression;
 *   - it is the fix phase that decides whether the threshold, the reset, or
 *     neither is what should change. That decision belongs to the user
 *     (CLAUDE.md §7, "findings-as-queue" / requirement-vs-implementation), so
 *     nothing here is touched in the diagnosis phase.
 */
describe('accountAuthState — SUSPECTED DEFECT, characterisation: an interleaved success resets the streak', () => {
  it('DOCUMENTS TODAY\'S BEHAVIOUR (suspected defect): fail → success repeated N times NEVER raises the flag, for any N', () => {
    // "For any N": the interesting property is that the count of failures is
    // irrelevant — eight, as in the field, or twenty here, changes nothing.
    for (const n of [1, 2, 4, 8, 20]) {
      const { svc, broadcast } = makeService()
      for (let i = 0; i < n; i++) {
        failNow(svc, 7, new Error('AUTHENTICATIONFAILED'))
        okNow(svc, 7)
      }
      expect(svc.snapshot().needsReauth).toEqual([])
      // And nothing was ever pushed to the renderer, so no window could have
      // shown a badge either — this is the user's experience, exactly.
      expect(broadcast).not.toHaveBeenCalled()
    }
  })

  it('DOCUMENTS TODAY\'S BEHAVIOUR (suspected defect): one success between two auth failures is enough to prevent the raise', () => {
    const { svc, broadcast } = makeService()
    failNow(svc, 7, new Error('auth'))
    okNow(svc, 7) // a different folder syncing fine on the same account
    failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('CONTRAST: the same two auth failures with NO success between them DO raise the flag', () => {
    // Same account, same errors, same count — the ONLY difference from the test
    // above is the interleaved success. That is what makes the pair evidence:
    // it isolates interleaving as the single variable.
    const { svc, broadcast } = makeService()
    failNow(svc, 7, new Error('auth'))
    failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(payloadOf(broadcast, 0)).toEqual([7])
  })

  it('the reset is legible in the log: the streak line names the success as the cause', () => {
    // Diagnosis instrumentation (boundary ii). Without this line a field log
    // shows failures arriving and nothing happening, with no way to tell a
    // wiped streak from a discarded verdict.
    const { svc } = makeService()
    failNow(svc, 7, new Error('auth'))
    okNow(svc, 7)
    const streakLines = logMock.info.mock.calls
      .filter((c) => c[0] === 'auth failure streak changed')
      .map((c) => c[1] as Record<string, unknown>)
    expect(streakLines.map((f) => f.cause)).toEqual(['auth_failure', 'cleared_by_success'])
    expect(streakLines[1]).toMatchObject({ accountId: 7, from: 1, to: 0, threshold: AUTH_FAILURE_THRESHOLD })
  })
})

/**
 * Diagnosis instrumentation for the same incident (AC1). These tests exist so
 * the four boundaries a verdict crosses stay readable from ONE log file:
 * what arrived and how it was classified, every streak mutation with its cause,
 * every verdict discarded on the (id, generation) test, and every publish.
 *
 * Level matters as much as content: `initLogger` writes `info` and above to the
 * log FILE and drops `debug` entirely, so a line demoted to `debug` is invisible
 * in exactly the situation it exists for.
 */
describe('accountAuthState — diagnosis instrumentation (incident 2026-08-24)', () => {
  it('(i) records what reached noteFailure and how the classifier read it', () => {
    const { svc } = makeService(() => 'network')
    failNow(svc, 7, new Error('ETIMEDOUT'))
    const arrival = logMock.info.mock.calls.find((c) => c[0] === 'failure reported to the auth state')
    expect(arrival?.[1]).toMatchObject({ accountId: 7, reportedGeneration: 0, streak: 0, flagged: false })
    const classified = logMock.info.mock.calls.find((c) => c[0] === 'reported failure classified')
    expect(classified?.[1]).toMatchObject({ accountId: 7, errorClass: 'network', credentialsEvidence: false })
  })

  it('(iii) records a discarded verdict at INFO, where file logging can see it', () => {
    const { svc } = makeService()
    // Unattributable: the boundary could not stamp it (no generation provider).
    svc.noteFailure(7, null, new Error('auth'))
    const unattributable = logMock.info.mock.calls.find(
      (c) => c[0] === 'verdict discarded before it could move the flag',
    )
    expect(unattributable?.[1]).toMatchObject({ accountId: 7, reason: 'unattributable', reportedGeneration: 'absent' })
    // Stale: issued for the previous incarnation of a reused id.
    const stale = svc.currentGeneration(9)
    svc.forget(9)
    svc.noteFailure(9, stale, new Error('auth'))
    expect(
      logMock.info.mock.calls.some(
        (c) => c[0] === 'verdict discarded before it could move the flag'
          && (c[1] as Record<string, unknown>).reason === 'previous_incarnation',
      ),
    ).toBe(true)
    expect(logMock.debug).not.toHaveBeenCalled()
  })

  it('(iii) throttles the discard line so an unregistered provider cannot flood the file', () => {
    const { svc } = makeService()
    for (let i = 0; i < 25; i++) svc.noteFailure(7, null, new Error('auth'))
    const lines = logMock.info.mock.calls.filter(
      (c) => c[0] === 'verdict discarded before it could move the flag',
    )
    // 1st, 10th, 20th — and the running total is carried, so nothing is lost.
    expect(lines.length).toBe(3)
    expect(lines.map((c) => (c[1] as Record<string, unknown>).discardedTotal)).toEqual([1, 10, 20])
  })

  it('(ii) names every cause that can move the streak, with the correct before/after values', () => {
    // Only two of the six `StreakChangeCause` values (auth_failure,
    // cleared_by_success) are exercised by the tests above. This walks the
    // other four scenarios too, so a swapped `from`/`to` argument or a typo'd
    // cause string at any of the six call sites turns red — a plain string
    // like 'threshold-reached' or 'clearedByForget' would otherwise silently
    // break the field log this instrumentation exists for.
    function streakLines() {
      return logMock.info.mock.calls
        .filter((c) => c[0] === 'auth failure streak changed')
        .map((c) => [(c[1] as Record<string, unknown>).cause, (c[1] as Record<string, unknown>).from, (c[1] as Record<string, unknown>).to])
    }

    // auth_failure ×2, then threshold_reached, on the same pair of reports
    // that raise the flag.
    const { svc: reachesThreshold } = makeService()
    failNow(reachesThreshold, 1, new Error('auth'))
    failNow(reachesThreshold, 1, new Error('auth'))
    expect(streakLines()).toEqual([
      ['auth_failure', 0, 1],
      ['auth_failure', 1, 2],
      ['threshold_reached', 2, 2],
    ])
    logMock.info.mockClear()

    // cleared_by_sign_in: a streak below threshold, wiped by an interactive
    // sign-in rather than a connection-boundary success.
    const { svc: signsIn } = makeService()
    failNow(signsIn, 2, new Error('auth'))
    signsIn.noteSignedIn(2)
    expect(streakLines()).toEqual([
      ['auth_failure', 0, 1],
      ['cleared_by_sign_in', 1, 0],
    ])
    logMock.info.mockClear()

    // cleared_no_live_account: the streak reaches the threshold for an id
    // `accountExists` says nothing is behind — raiseFlag's own reset path.
    // Stamped explicitly with 0, like the deleted-account tests above: going
    // through `currentGeneration()` (what `failNow` uses) would answer `null`
    // for a non-existent account and the verdict would be dropped one step
    // earlier, on the identity test, before it ever reached the streak.
    const { svc: noLiveAccount } = makeService(() => 'auth', () => false)
    noLiveAccount.noteFailure(3, 0, new Error('auth'))
    noLiveAccount.noteFailure(3, 0, new Error('auth'))
    expect(streakLines()).toEqual([
      ['auth_failure', 0, 1],
      ['auth_failure', 1, 2],
      ['threshold_reached', 2, 2],
      ['cleared_no_live_account', 2, 0],
    ])
    logMock.info.mockClear()

    // cleared_by_forget: a streak below threshold, wiped by account removal.
    const { svc: forgotten } = makeService()
    failNow(forgotten, 4, new Error('auth'))
    forgotten.forget(4)
    expect(streakLines()).toEqual([
      ['auth_failure', 0, 1],
      ['cleared_by_forget', 1, 0],
    ])
  })

  it('(iv) records every publish and the size of the payload that left', () => {
    const { svc, broadcast } = makeService()
    broadcast.mockReturnValue(2)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    okNow(svc, 7)
    const published = logMock.info.mock.calls
      .filter((c) => c[0] === 'auth state published to the renderer')
      .map((c) => c[1] as Record<string, unknown>)
    expect(published).toEqual([
      { accountIds: [7], size: 1, windows: 2 },
      { accountIds: [], size: 0, windows: 2 },
    ])
  })

  it('changes nothing it observes: the instrumented paths still behave as the transition tests expect', () => {
    // Guard against the instrumentation itself acquiring a side effect (an
    // early return smuggled in with a log line, a streak read that writes).
    const { svc, broadcast } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    svc.noteSignedIn(7)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).toHaveBeenCalledTimes(2)
  })
})

describe('accountAuthState — debounce / no flicker', () => {
  it('a long run of auth failures produces exactly one broadcast', () => {
    const { svc, broadcast } = makeService()
    for (let i = 0; i < 50; i++) failNow(svc, 7, new Error('auth'))
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(svc.snapshot().needsReauth).toEqual([7])
  })

  it('fail → success → fail again produces one broadcast per real transition', () => {
    const { svc, broadcast } = makeService()
    for (let i = 0; i < 10; i++) failNow(svc, 7, new Error('auth'))
    okNow(svc, 7)
    for (let i = 0; i < 10; i++) failNow(svc, 7, new Error('auth'))
    expect(broadcast).toHaveBeenCalledTimes(3)
    expect(payloadOf(broadcast, 0)).toEqual([7])
    expect(payloadOf(broadcast, 1)).toEqual([])
    expect(payloadOf(broadcast, 2)).toEqual([7])
  })
})

describe('accountAuthState — containment', () => {
  it('a throwing broadcast neither propagates nor loses the state', () => {
    const broadcast = vi.fn(() => {
      throw new Error('no windows')
    })
    const svc = initAccountAuthState({
      classifyError: () => 'auth',
      broadcast: broadcast as unknown as (c: 'accounts:authStateChanged', p: AccountAuthStatePayload) => number,
      accountExists: () => true,
    })
    expect(() => {
      for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    }).not.toThrow()
    // The renderer can still pull the truth even though the push failed.
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(captureExceptionMock).toHaveBeenCalled()
  })

  it('a broadcast that reached no window is not treated as a failure', () => {
    const { svc, broadcast } = makeService()
    broadcast.mockReturnValue(0)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('snapshot returns a fresh array (callers cannot mutate service state)', () => {
    const { svc } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    const first = svc.snapshot().needsReauth
    first.push(999)
    expect(svc.snapshot().needsReauth).toEqual([7])
  })
})

/**
 * §2.165 — "IMAP authentication is not configured".
 *
 * This verdict never reaches the connection boundary: `assertImapAuth` rejects
 * before a connection is attempted, so no wrapped operation runs and no outcome
 * is produced. It is also the one account state where the failure threshold is
 * actively harmful — a mailbox that cannot even try to log in may never produce
 * a second attempt (every folder on manual sync), and there is no server race
 * for a second observation to disambiguate.
 */
describe('accountAuthState — credentials that are not configured', () => {
  it('raises on the FIRST report, without waiting for a threshold', () => {
    const { svc, broadcast } = makeService()
    noCredentialsNow(svc, 7)
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('accounts:authStateChanged', { needsReauth: [7] })
  })

  it('repeats produce no second broadcast and no second telemetry record', () => {
    const { svc, broadcast } = makeService()
    for (let i = 0; i < 20; i++) noCredentialsNow(svc, 7)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(eventCalls('account.reauth_flagged')).toHaveLength(1)
  })

  it('is cleared by the first success, like any other raise', () => {
    const { svc, broadcast } = makeService()
    noCredentialsNow(svc, 7)
    okNow(svc, 7)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(eventCalls('account.reauth_cleared')).toEqual([
      { reason: 'signed_in', flag_duration: '<1min' },
    ])
  })

  it('the same verdict arriving as a failure through the boundary also skips the threshold', () => {
    // The check can run inside an already-wrapped operation, in which case the
    // thrown error travels to `noteFailure` instead. Same meaning, same raise.
    const { svc, broadcast, classifyError } = makeService()
    failNow(svc, 7, imapAuthNotConfiguredError(7))
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
    // …and it never reaches the server-error classifier, which would file the
    // wording as 'network' and drop it.
    expect(classifyError).not.toHaveBeenCalled()
  })

  it('the discriminator is the code, not the wording', () => {
    const err = imapAuthNotConfiguredError(7)
    expect((err as Error & { code?: string }).code).toBe(IMAP_AUTH_NOT_CONFIGURED_CODE)
    expect(isImapAuthNotConfiguredError(err)).toBe(true)
    // A look-alike message with no code is NOT the same error: the wording is
    // reachable from server text, the code is ours.
    expect(isImapAuthNotConfiguredError(new Error(err.message))).toBe(false)
    expect(isImapAuthNotConfiguredError(undefined)).toBe(false)
    expect(isImapAuthNotConfiguredError('ERR_IMAP_AUTH_NOT_CONFIGURED')).toBe(false)
  })

  it('carries nothing but the account id in its message', () => {
    // The error reaches ~28 call sites, most of which log it.
    expect(imapAuthNotConfiguredError(7).message).toBe(
      'IMAP authentication for account #7 is not configured',
    )
  })

  it('never propagates a dependency failure to the caller', () => {
    const broadcast = vi.fn(() => {
      throw new Error('no windows')
    })
    const svc = initAccountAuthState({
      classifyError: () => 'auth',
      broadcast: broadcast as unknown as (c: 'accounts:authStateChanged', p: AccountAuthStatePayload) => number,
      accountExists: () => true,
    })
    expect(() => noCredentialsNow(svc, 7)).not.toThrow()
    expect(svc.snapshot().needsReauth).toEqual([7])
  })
})

/**
 * §2.165 (fix wave 2) — a login attempt the server rejected outright.
 *
 * IDLE's connect/authenticate/select prologue is a full login, and when it is
 * refused `startIdle` throws and stops: no retry inside it, no loop to produce
 * a second observation. The connection boundary reports that failure like any
 * other, so the counting rule leaves it one short of the threshold — forever,
 * for a mailbox whose folders are all on manual sync and whose only outward
 * connection IS the prologue. That is the §2.165 defect mirrored, so the
 * rejection is escalated: the raise transition, not another count.
 */
describe('accountAuthState — a rejected login attempt', () => {
  it('raises on the first rejection, without waiting for a threshold', () => {
    const { svc, broadcast } = makeService()
    rejectNow(svc, 7, new Error('AUTHENTICATIONFAILED'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledWith('accounts:authStateChanged', { needsReauth: [7] })
  })

  it.each<ImapErrorClass>(['network', 'cert', 'permanent'])(
    'ignores a %s rejection: a failed connection is not a failed password',
    (cls) => {
      // The single most important negative: every dropped Wi-Fi link rejects
      // the prologue too, and this path has no threshold left to absorb it.
      const { svc, broadcast } = makeService(() => cls)
      for (let i = 0; i < 5; i++) rejectNow(svc, 7, new Error('boom'))
      expect(svc.snapshot().needsReauth).toEqual([])
      expect(broadcast).not.toHaveBeenCalled()
    },
  )

  it('does not double-count when the boundary reported the same failure first', () => {
    // The production sequence: packages/net reports the outcome, then throws,
    // then the net:idleStart handler escalates the very same error. One failure
    // must stay one failure — one broadcast, one telemetry record.
    const { svc, broadcast } = makeService()
    const err = new Error('AUTHENTICATIONFAILED')
    failNow(svc, 7, err)
    rejectNow(svc, 7, err)
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(eventCalls('account.reauth_flagged')).toHaveLength(1)
  })

  it('is order-independent: escalation first, boundary report second', () => {
    // Nothing guarantees which of the two arrives first, so the property has to
    // hold both ways round — and the late count must not produce a second
    // raise once the flag already stands.
    const { svc, broadcast } = makeService()
    const err = new Error('AUTHENTICATIONFAILED')
    rejectNow(svc, 7, err)
    failNow(svc, 7, err)
    failNow(svc, 7, err)
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(eventCalls('account.reauth_flagged')).toHaveLength(1)
  })

  it('repeated rejections produce one broadcast, not a stream', () => {
    // The renderer re-arms IDLE after each failure, so this repeats for as long
    // as the credentials stay broken.
    const { svc, broadcast } = makeService()
    for (let i = 0; i < 20; i++) rejectNow(svc, 7, new Error('auth'))
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(eventCalls('account.reauth_flagged')).toHaveLength(1)
  })

  it('is cleared by the first success, like any other raise', () => {
    const { svc, broadcast } = makeService()
    rejectNow(svc, 7, new Error('auth'))
    okNow(svc, 7)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(eventCalls('account.reauth_cleared')).toEqual([
      { reason: 'signed_in', flag_duration: '<1min' },
    ])
  })

  it('routes the not-configured discriminator without asking the classifier', () => {
    const { svc, classifyError } = makeService()
    rejectNow(svc, 7, imapAuthNotConfiguredError(7))
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(classifyError).not.toHaveBeenCalled()
  })

  it('treats a throwing classifier as "not auth"', () => {
    const { svc, broadcast } = makeService(() => {
      throw new Error('classifier exploded')
    })
    rejectNow(svc, 7, new Error('x'))
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('drops a rejection for an account that no longer exists', () => {
    // The caller stamps the attempt before starting it, and an id that
    // addresses no account has no generation — so the stamp is absent and the
    // rejection is unattributable. (The stale-incarnation case, where the id
    // does exist but belongs to someone else now, is in the identity describe.)
    const { svc, broadcast } = makeService(() => 'auth', () => false)
    rejectNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('logs no server-supplied text and never propagates a dependency failure', () => {
    const broadcast = vi.fn(() => {
      throw new Error('no windows')
    })
    const svc = initAccountAuthState({
      classifyError: () => 'auth',
      broadcast: broadcast as unknown as (c: 'accounts:authStateChanged', p: AccountAuthStatePayload) => number,
      accountExists: () => true,
    })
    expect(() =>
      rejectNow(svc, 7, new Error('NO LOGIN failed for user@example.com: wrong password')),
    ).not.toThrow()
    expect(svc.snapshot().needsReauth).toEqual([7])
    const logged = JSON.stringify([...logMock.warn.mock.calls, ...logMock.error.mock.calls])
    expect(logged).not.toContain('example.com')
    expect(logged).not.toContain('wrong password')
  })
})

/**
 * §2.165 — verdicts that arrive after the account is gone.
 *
 * The connection boundary reports for a single process-wide subscriber and
 * cannot tell a live account id from a deleted one: an operation in flight at
 * deletion time reports AFTER `forget()`. Two things stop that verdict here —
 * the generation stamp it carries (the describe below) and, for the one report
 * that carries none, the existence lookup on the raise transition.
 */
describe('accountAuthState — late verdicts for a deleted account', () => {
  it('an id that addresses no account has no generation, so its verdicts are unattributable', () => {
    // Mutation that fails this: making `currentGeneration` return the map value
    // regardless of existence — the stamp would then be 0, match 0, and every
    // verdict about an id that belongs to nothing would be acted upon.
    const { svc, broadcast } = makeService(() => 'auth', () => false)
    expect(svc.currentGeneration(7)).toBeNull()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD * 5; i++) failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
    expect(eventCalls('account.reauth_flagged')).toHaveLength(0)
  })

  it('a missing-credentials verdict for a deleted account is a no-op too', () => {
    // Two independent guards have to hold here, so the stamp is supplied
    // explicitly rather than through `currentGeneration` (which would answer
    // `null` for a non-existent account and stop the verdict one step earlier).
    // With a MATCHING stamp, the existence lookup on the raise transition is
    // the only thing standing between this report and a badge nothing could
    // ever clear. Mutation that fails it: dropping the `accountStillExists`
    // check from `raiseFlag`.
    const { svc, broadcast } = makeService(() => 'auth', () => false)
    svc.noteMissingCredentials(7, 0)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('an unattributable missing-credentials verdict (null stamp) is dropped', () => {
    // `null` means the caller could not attribute the report — no reporter slot
    // filled, a throwing lookup — and an unattributable verdict may not move a
    // user-visible warning. Mutation that fails it: treating `null` as a
    // wildcard in `isCurrentIncarnation`.
    const { svc, broadcast } = makeService()
    svc.noteMissingCredentials(7, null)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })

  /**
   * §2.165 fix wave 5 — the same race the wave-4 stamp closed for the boundary,
   * on the report wave 4 itself added.
   *
   * "This account has no credentials" is discovered across an await (the secret
   * store lookup for a refresh token, the config load before `assertImapAuth`).
   * A mailbox deleted inside that window frees its id to the next account
   * created, so the verdict of the vanished mailbox must not raise a badge on
   * its successor.
   */
  it('a missing-credentials verdict issued before a deletion never reaches the id\'s next incarnation', () => {
    const { svc, broadcast } = makeService()
    // The operation starts: the caller stamps it before its first await.
    const inFlight = svc.currentGeneration(7)
    // …the user deletes the mailbox, and id 7 is handed to a new one.
    svc.forget(7)
    // …and only now does the lookup answer "no token stored".
    svc.noteMissingCredentials(7, inFlight)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
    expect(eventCalls('account.reauth_flagged')).toHaveLength(0)
  })

  it('…while the new incarnation\'s own verdict raises immediately, with no waiting period', () => {
    // The other half of the pair: a stamp taken after the deletion matches, so
    // a genuinely broken new mailbox is flagged at once. Without this the test
    // above would also pass on a service that had simply stopped raising.
    const { svc, broadcast } = makeService()
    const inFlight = svc.currentGeneration(7)
    svc.forget(7)
    svc.noteMissingCredentials(7, inFlight)
    expect(svc.snapshot().needsReauth).toEqual([])

    noCredentialsNow(svc, 7)
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('the real race: delete while an operation is in flight, verdict lands afterwards', () => {
    let exists = true
    const { svc, broadcast } = makeService(() => 'auth', () => exists)
    // The doomed operations were issued while the mailbox was alive, so they
    // carry the generation it had then.
    const inFlight = svc.currentGeneration(7)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) svc.noteFailure(7, inFlight, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])

    // The user deletes the account: main.ts calls forget() once the deletion
    // commits, and the account stops existing.
    svc.forget(7)
    exists = false
    broadcast.mockClear()

    // …and only now do they report.
    for (let i = 0; i < 10; i++) svc.noteFailure(7, inFlight, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('consults the account store once per raise, never once per verdict', () => {
    // The comparison is a pure map read, so a burst of failures on a broken
    // link costs no lookups at all; the raise transition asks once and then
    // returns early for as long as the flag stands. Mutation that fails this:
    // moving the existence check back onto every counted failure.
    const { svc, accountExists } = makeService()
    for (let i = 0; i < 50; i++) svc.noteFailure(7, 0, new Error('auth'))
    expect(accountExists).toHaveBeenCalledTimes(1)
  })

  it('does not consult the account store on the success path at all', () => {
    // Successes are the common outcome and the hot path.
    const { svc, accountExists } = makeService()
    for (let i = 0; i < 50; i++) svc.noteSuccess(7, 0)
    expect(accountExists).not.toHaveBeenCalled()
  })

  it('a re-created account with the same id flags normally again', () => {
    let exists = false
    const { svc, broadcast } = makeService(() => 'auth', () => exists)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    expect(broadcast).not.toHaveBeenCalled()
    exists = true
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
  })

  it('fails OPEN when the lookup itself throws, and reports the lookup failure', () => {
    // A wrong "yes" costs a badge for an id the renderer filters out against
    // its own account list; a wrong "no" costs the only warning a genuinely
    // broken mailbox produces. Identity does not depend on this answer any
    // more — the generation does the deciding — so failing open here cannot
    // resurrect a stale verdict. Mutation that fails this: returning false (or
    // rethrowing) from `accountStillExists`.
    const { svc, broadcast } = makeService(() => 'auth', () => {
      throw new Error('store unreadable')
    })
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(captureExceptionMock).toHaveBeenCalled()
    expect(JSON.stringify(logMock.warn.mock.calls)).not.toContain('store unreadable')
  })

  it('reports an unreadable store on the edge, not once per lookup', () => {
    // The lookup moved onto a per-operation path with the generation provider,
    // so a store that always throws would otherwise produce one Sentry event
    // per IMAP operation (CLAUDE.md §8: telemetry may not flood). Mutation that
    // fails this: dropping the latch and reporting inside every catch.
    let broken = true
    const { svc } = makeService(() => 'auth', () => {
      if (broken) throw new Error('store unreadable')
      return true
    })
    for (let i = 0; i < 20; i++) svc.currentGeneration(7)
    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    expect(logMock.warn).toHaveBeenCalledTimes(1)

    // A lookup that works re-arms it, so a separate later outage is reported.
    broken = false
    svc.currentGeneration(7)
    broken = true
    svc.currentGeneration(7)
    expect(captureExceptionMock).toHaveBeenCalledTimes(2)
  })
})

/**
 * §2.165 (fix wave 4) — identity is the PAIR (account id, generation).
 *
 * Account ids are reused ("max + 1"), so the id alone cannot say WHICH mailbox
 * a verdict is about, and neither ordering of "deleted / re-issued / reported"
 * is decidable from the payload: an account id and an error is all there is,
 * and any property of the account read at report time describes whatever holds
 * the id NOW. So the service mints a generation per id, bumps it on deletion,
 * hands `currentGeneration` to packages/net as the stamp source, and acts on a
 * verdict only while its stamp still matches.
 *
 * This replaced a 120-second quarantine on a freed id (fix wave 3). The tests
 * below are also the argument for the replacement: they pin behaviour a time
 * window got wrong in BOTH directions — a stray verdict is dropped however long
 * it took to arrive, and a re-created mailbox is flagged immediately rather
 * than after a waiting period.
 */
describe('accountAuthState — identity is the (account id, generation) pair', () => {
  it('a live id starts at generation 0, and 0 is an ordinary stamp that matches', () => {
    // The one value a "no stamp" sentinel would collide with. Mutation that
    // fails this: treating a falsy stamp as absent (`if (!accountGeneration)`).
    const { svc, broadcast } = makeService()
    expect(svc.currentGeneration(7)).toBe(0)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) svc.noteFailure(7, 0, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('forget() bumps the generation, monotonically', () => {
    // Mutation that fails this: `forget` resetting or not touching the counter.
    const { svc } = makeService()
    expect(svc.currentGeneration(7)).toBe(0)
    svc.forget(7)
    expect(svc.currentGeneration(7)).toBe(1)
    svc.forget(7)
    expect(svc.currentGeneration(7)).toBe(2)
    // …and it is per id: deleting one mailbox does not renumber its neighbours.
    expect(svc.currentGeneration(8)).toBe(0)
  })

  it('drops a stray verdict that lands after the id was re-issued', () => {
    // `accountExists` stays TRUE for the whole sequence — that is the point: by
    // the time the stray failure is reported, id 7 really does belong to a
    // brand-new mailbox, and existence is no evidence at all. Mutation that
    // fails this: comparing only the id (ignoring `accountGeneration`).
    const { svc, broadcast } = makeService(() => 'auth', () => true)
    const oldMailbox = svc.currentGeneration(7)

    svc.forget(7)                    // deletion commits; id 7 is freed
    // …the user immediately adds a new account, which is issued id 7 again.
    svc.noteFailure(7, oldMailbox, new Error('auth')) // the OLD mailbox reports
    svc.noteFailure(7, oldMailbox, new Error('auth')) // …twice, a full threshold

    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
    expect(eventCalls('account.reauth_flagged')).toHaveLength(0)

    // …and it left no half-streak behind: the new mailbox still needs a FULL
    // threshold of its own failures.
    const newMailbox = svc.currentGeneration(7)
    svc.noteFailure(7, newMailbox, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([])
    svc.noteFailure(7, newMailbox, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
  })

  it('does not lose the re-issued mailbox: its own verdicts work at once, with no waiting period', () => {
    // The other direction, and the reason the time window had to go: under the
    // 120 s quarantine this mailbox stayed silent for two minutes after being
    // created. Mutation that fails this: any "recently freed id" grace period
    // in front of the comparison.
    const { svc, broadcast } = makeService(() => 'auth', () => true)
    svc.forget(7)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('drops a stale SUCCESS, so it cannot clear a badge the new mailbox earned', () => {
    // The mirror of the failure case, and the reason the stamp is checked on
    // both verdicts: the dead mailbox's last in-flight operation may well have
    // succeeded. Mutation that fails this: skipping the comparison in
    // `noteSuccess` ("a success is always good news").
    const { svc, broadcast } = makeService(() => 'auth', () => true)
    const oldMailbox = svc.currentGeneration(7)
    svc.forget(7)

    const newMailbox = svc.currentGeneration(7)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) svc.noteFailure(7, newMailbox, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    broadcast.mockClear()
    recordEventMock.mockReset()

    svc.noteSuccess(7, oldMailbox) // the deleted mailbox's operation succeeded
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).not.toHaveBeenCalled()
    expect(eventCalls('account.reauth_cleared')).toHaveLength(0)

    // …while the new mailbox's own success clears it immediately.
    svc.noteSuccess(7, newMailbox)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('drops a stray rejected login, the raise-on-sight path with no threshold to absorb it', () => {
    // `noteLoginRejected` raises on the first report, so for it a single stray
    // verdict IS the whole defect. Mutation that fails this: dropping the
    // comparison from `noteLoginRejected` (or the stamp from its call site).
    const { svc, broadcast } = makeService(() => 'auth', () => true)
    const oldMailbox = svc.currentGeneration(7)
    svc.forget(7)
    svc.noteLoginRejected(7, oldMailbox, new Error('AUTHENTICATIONFAILED'))
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('treats an absent stamp as a mismatch, never as a wildcard — in both directions', () => {
    // `null` means the boundary could not attribute the verdict (no provider
    // registered, unknown id, misbehaving provider). Acting on it would move a
    // user-visible warning on evidence that names no mailbox. Mutation that
    // fails this: `accountGeneration ?? generationOf(accountId)`, i.e. letting
    // an absent stamp match anything.
    const { svc, broadcast } = makeService(() => 'auth', () => true)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD * 3; i++) svc.noteFailure(7, null, new Error('auth'))
    svc.noteLoginRejected(7, null, new Error('AUTHENTICATIONFAILED'))
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).not.toHaveBeenCalled()

    // …and an unstamped success cannot clear a flag either.
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    broadcast.mockClear()
    svc.noteSuccess(7, null)
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('never silences the accounts around a deleted one', () => {
    // Deleting one mailbox must not touch anything but its own id.
    const { svc, broadcast } = makeService(() => 'auth', () => true)
    svc.forget(7)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 8, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([8])
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('clears the flag as it bumps the generation, so the deleted mailbox leaves nothing behind', () => {
    const { svc, broadcast } = makeService(() => 'auth', () => true)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    expect(svc.snapshot().needsReauth).toEqual([7])
    svc.forget(7)
    expect(svc.snapshot().needsReauth).toEqual([])
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('logs no server-supplied text when discarding a stale verdict', () => {
    const { svc } = makeService(() => 'auth', () => true)
    const oldMailbox = svc.currentGeneration(7)
    svc.forget(7)
    svc.noteFailure(7, oldMailbox, new Error('NO LOGIN failed for user@example.com: wrong password'))
    const logged = JSON.stringify([
      ...logMock.debug.mock.calls,
      // The diagnosis instrumentation writes at `info` (that is the level file
      // logging keeps), so the privacy check has to read that level too — this
      // is the assertion that stops a future diagnostic line from carrying the
      // server's text into a log the user sends us.
      ...logMock.info.mock.calls,
      ...logMock.warn.mock.calls,
      ...logMock.error.mock.calls,
    ])
    expect(logged).not.toContain('example.com')
    expect(logged).not.toContain('wrong password')
    expect(logged).not.toContain('NO LOGIN')
  })
})

/**
 * §2.165 fix wave 4 — the OAuth mailbox that could never show the badge.
 *
 * A missing refresh token is discovered while BUILDING the config, before
 * `assertImapAuth` inspects the credentials and before any wrapped operation
 * exists — so neither the local precondition report nor the connection boundary
 * ever fired, and the mailbox just went quiet. Both providers now report
 * `noteMissingCredentials` and throw an error tagged with the SAME
 * discriminator, which is what makes this service's existing routing apply
 * unchanged. (That the providers really do it is pinned structurally in
 * `electron/main.accountAuthStateWiring.test.ts` for Gmail and behaviourally in
 * `electron/services/outlookOAuthService.test.ts` for Outlook.)
 */
describe('accountAuthState — the discriminator shared with the OAuth token paths', () => {
  it('recognises a provider-tagged error and raises without waiting for a threshold', () => {
    // Mutation that fails this: tagging the OAuth error with a second, private
    // code, or building it with a bare `new Error(...)`.
    const { svc, broadcast, classifyError } = makeService()
    const err = authNotConfiguredError('Google refresh token for account #7 not found (re-authorization required)')
    expect(isImapAuthNotConfiguredError(err)).toBe(true)
    failNow(svc, 7, err)
    expect(svc.snapshot().needsReauth).toEqual([7])
    expect(broadcast).toHaveBeenCalledTimes(1)
    // …and it never reaches the server-error classifier, which reads response
    // text and would file this wording as 'network'.
    expect(classifyError).not.toHaveBeenCalled()
  })

  it('carries the code, not the wording, and keeps the caller message intact', () => {
    const err = authNotConfiguredError('Microsoft refresh token for account #7 not found (re-authorization required)')
    expect((err as Error & { code?: string }).code).toBe(IMAP_AUTH_NOT_CONFIGURED_CODE)
    expect(err.message).toBe('Microsoft refresh token for account #7 not found (re-authorization required)')
    // The local precondition error is the same factory with a fixed message.
    expect((imapAuthNotConfiguredError(7) as Error & { code?: string }).code).toBe(
      IMAP_AUTH_NOT_CONFIGURED_CODE,
    )
    // A look-alike message with no code is NOT the same error.
    expect(isImapAuthNotConfiguredError(new Error(err.message))).toBe(false)
  })
})

/**
 * §2.157 telemetry (CLAUDE.md §8).
 *
 * The property under test is the one that decides whether the metric is worth
 * having: the events follow the STATE TRANSITION, exactly like the broadcast.
 * A per-attempt emission would turn `account.reauth_flagged` into a counter of
 * network weather (one record per folder, per pass, forever) and make the
 * flagged/cleared ratio meaningless.
 */
describe('accountAuthState — telemetry: flagged', () => {
  it('emits exactly one flagged event on the raise transition', () => {
    const { svc } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD - 1; i++) {
      failNow(svc, 7, new Error('auth'))
      expect(eventCalls('account.reauth_flagged')).toHaveLength(0)
    }
    failNow(svc, 7, new Error('auth'))
    expect(eventCalls('account.reauth_flagged')).toEqual([{ flagged_accounts_bucket: '1' }])
  })

  it('does NOT re-emit on further failures while the account stays flagged', () => {
    const { svc } = makeService()
    for (let i = 0; i < 50; i++) failNow(svc, 7, new Error('auth'))
    expect(eventCalls('account.reauth_flagged')).toHaveLength(1)
  })

  it('emits nothing at all for non-auth failures', () => {
    for (const cls of ['network', 'cert', 'permanent'] as ImapErrorClass[]) {
      recordEventMock.mockReset()
      const { svc } = makeService(() => cls)
      for (let i = 0; i < AUTH_FAILURE_THRESHOLD * 5; i++) failNow(svc, 1, new Error('x'))
      expect(recordEventMock).not.toHaveBeenCalled()
    }
  })

  it('reports the size of the flagged set, so a mass flag is distinguishable', () => {
    // Several accounts flagging at once is evidence about US (a classifier
    // reading a local failure as auth), not about the providers.
    const { svc } = makeService()
    for (const id of [1, 2, 3]) {
      for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, id, new Error('auth'))
    }
    expect(eventCalls('account.reauth_flagged')).toEqual([
      { flagged_accounts_bucket: '1' },
      { flagged_accounts_bucket: '2' },
      { flagged_accounts_bucket: '3-5' },
    ])
  })

  it('emits again after a clear — the metric counts transitions, not accounts', () => {
    const { svc } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    okNow(svc, 7)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    expect(eventCalls('account.reauth_flagged')).toHaveLength(2)
  })
})

describe('accountAuthState — telemetry: cleared', () => {
  it('reports a success-driven clear with how long the flag stood', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-09T00:00:00Z'))
      const { svc } = makeService()
      for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
      vi.setSystemTime(new Date('2026-08-09T03:00:00Z'))
      okNow(svc, 7)
      expect(eventCalls('account.reauth_cleared')).toEqual([
        { reason: 'signed_in', flag_duration: '1-6h' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports account deletion as its own reason — resolved, but not fixed', () => {
    const { svc } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    svc.forget(7)
    expect(eventCalls('account.reauth_cleared')).toEqual([
      { reason: 'account_removed', flag_duration: '<1min' },
    ])
  })

  it('emits nothing when there was no flag to clear', () => {
    const { svc } = makeService()
    okNow(svc, 42)
    svc.forget(42)
    expect(recordEventMock).not.toHaveBeenCalled()
  })

  it('does not re-emit on repeated successes after the flag is gone', () => {
    const { svc } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    okNow(svc, 7)
    okNow(svc, 7)
    okNow(svc, 7)
    expect(eventCalls('account.reauth_cleared')).toHaveLength(1)
  })
})

describe('bucketReauthFlagDuration', () => {
  it('maps each band to the bucket the schema declares', () => {
    expect(bucketReauthFlagDuration(0)).toBe('<1min')
    expect(bucketReauthFlagDuration(59_999)).toBe('<1min')
    expect(bucketReauthFlagDuration(60_000)).toBe('1-10min')
    expect(bucketReauthFlagDuration(9 * 60_000)).toBe('1-10min')
    expect(bucketReauthFlagDuration(10 * 60_000)).toBe('10-60min')
    expect(bucketReauthFlagDuration(59 * 60_000)).toBe('10-60min')
    expect(bucketReauthFlagDuration(60 * 60_000)).toBe('1-6h')
    expect(bucketReauthFlagDuration(5 * 3600_000)).toBe('1-6h')
    expect(bucketReauthFlagDuration(6 * 3600_000)).toBe('6-24h')
    expect(bucketReauthFlagDuration(23 * 3600_000)).toBe('6-24h')
    expect(bucketReauthFlagDuration(24 * 3600_000)).toBe('24h+')
    expect(bucketReauthFlagDuration(7 * 24 * 3600_000)).toBe('24h+')
  })

  it('reports an unusable measurement as unknown instead of guessing', () => {
    // A fabricated '<1min' would read as the healthy case and hide the bug.
    expect(bucketReauthFlagDuration(Number.NaN)).toBe('unknown')
    expect(bucketReauthFlagDuration(-1)).toBe('unknown')
    expect(bucketReauthFlagDuration(Number.POSITIVE_INFINITY)).toBe('unknown')
  })

  it('only ever returns values the schema domain allows', () => {
    const domain = DOMAINS.account_reauth_flag_duration as readonly string[]
    const samples = [Number.NaN, -1, 0, 1, 60_000, 600_000, 3600_000, 86_400_000, 1e12]
    for (const ms of samples) expect(domain).toContain(bucketReauthFlagDuration(ms))
  })
})

describe('accountAuthState — telemetry containment and privacy', () => {
  it('a throwing metrics sink changes neither the state nor the broadcast', () => {
    recordEventMock.mockImplementation(() => {
      throw new Error('metrics pipeline down')
    })
    const { svc, broadcast } = makeService()
    expect(() => {
      for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
      okNow(svc, 7)
    }).not.toThrow()
    expect(svc.snapshot().needsReauth).toEqual([])
    // Raise + clear still reached the renderer.
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('never puts an account id — or anything else identifying — in a tag', () => {
    const { svc } = makeService()
    const accountId = 987654
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) {
      failNow(svc, accountId, new Error('NO LOGIN failed for user@example.com'))
    }
    okNow(svc, accountId)
    const payload = JSON.stringify(recordEventMock.mock.calls)
    expect(payload).not.toContain(String(accountId))
    expect(payload).not.toContain('example.com')
    expect(payload).not.toContain('LOGIN')
    // And structurally: the only tag keys emitted are the three aggregates.
    const keys = new Set(
      recordEventMock.mock.calls.flatMap((c) => Object.keys((c[1] ?? {}) as object)),
    )
    expect([...keys].sort()).toEqual(['flag_duration', 'flagged_accounts_bucket', 'reason'])
  })
})

describe('§2.157 metric schema registration', () => {
  const funnel = [
    'account.reauth_flagged',
    'account.reauth_cleared',
    'account.reauth_badge_clicked',
  ] as const

  it('registers all three funnel events as counters with a purpose', () => {
    for (const name of funnel) {
      const def = (METRIC_EVENTS as Record<string, { kind: string; purpose: string }>)[name]
      expect(def, name).toBeDefined()
      expect(def.kind).toBe('event')
      expect(def.purpose.length).toBeGreaterThan(0)
    }
  })

  it('keeps the two main-emitted events off the renderer bridge', () => {
    const defs = METRIC_EVENTS as Record<string, { mainOnly?: boolean }>
    expect(defs['account.reauth_flagged'].mainOnly).toBe(true)
    expect(defs['account.reauth_cleared'].mainOnly).toBe(true)
    // The click is only observable in the renderer (main serves the same
    // `ui:openAccount` channel for the ordinary Settings path), so this one
    // cannot be mainOnly — and carries no tags to smuggle anything through.
    expect(defs['account.reauth_badge_clicked'].mainOnly).toBeUndefined()
    expect(
      Object.keys((METRIC_EVENTS as Record<string, { tags: object }>)['account.reauth_badge_clicked'].tags),
    ).toEqual([])
  })

  it('declares no tag that could carry an identifier', () => {
    const defs = METRIC_EVENTS as Record<string, { tags: Record<string, string> }>
    // Exact key sets: an aggregate added later has to be argued for here, and
    // an identifier smuggled in as a tag fails the assertion by name.
    expect(Object.keys(defs['account.reauth_flagged'].tags)).toEqual(['flagged_accounts_bucket'])
    expect(Object.keys(defs['account.reauth_cleared'].tags).sort()).toEqual([
      'flag_duration',
      'reason',
    ])
    for (const name of funnel) {
      for (const key of Object.keys(defs[name].tags)) {
        // `flagged_accounts_bucket` is a bucketed COUNT of accounts, which is
        // why "account" alone is not the tell — an identifier-shaped key is.
        expect(key, `${name}.${key}`).not.toMatch(
          /(^|_)id($|_)|account_id|host|address|email|subject|folder|user/i,
        )
      }
    }
    // Both cleared tags are CLOSED domains, not free-form strings.
    expect(defs['account.reauth_cleared'].tags.reason).toBe('account_reauth_clear_reason')
    expect(defs['account.reauth_cleared'].tags.flag_duration).toBe('account_reauth_flag_duration')
  })

  it('emits only reasons the clear-reason domain declares', () => {
    const { svc } = makeService()
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 7, new Error('auth'))
    okNow(svc, 7)
    for (let i = 0; i < AUTH_FAILURE_THRESHOLD; i++) failNow(svc, 8, new Error('auth'))
    svc.forget(8)
    const reasons = eventCalls('account.reauth_cleared').map((t) => t.reason)
    expect(reasons).toEqual(['signed_in', 'account_removed'])
    for (const r of reasons) {
      expect(DOMAINS.account_reauth_clear_reason as readonly string[]).toContain(r as string)
    }
  })
})

/**
 * IPC-boundary pins, same shape as electron/oauthProgress.channel.test.ts.
 * The whitelist and the renderer-facing channel unions are hand-maintained in
 * two files and drift silently: a missing entry makes the badge dead code, and
 * a channel on the wrong list turns a one-way notification into something the
 * renderer can call.
 */
function readSource(file: string): string {
  return readFileSync(resolve(__dirname, '..', file), 'utf8')
}

describe('§2.157 IPC channel whitelist', () => {
  it('accounts:authState is invoke-only', () => {
    const src = readSource('preload.ts')
    const invokeIdx = src.indexOf('const ALLOWED_INVOKE_CHANNELS')
    const listenIdx = src.indexOf('const ALLOWED_LISTEN_CHANNELS')
    expect(invokeIdx).toBeGreaterThan(-1)
    expect(listenIdx).toBeGreaterThan(invokeIdx)
    // Match the list entry exactly (quoted + trailing comma) so the assertion
    // cannot be satisfied by a prose mention in a neighbouring comment.
    expect(src.slice(invokeIdx, listenIdx)).toContain("'accounts:authState',")
    expect(src.slice(listenIdx)).not.toContain("'accounts:authState',")
  })

  it('accounts:authStateChanged is subscribe-only', () => {
    const src = readSource('preload.ts')
    const invokeIdx = src.indexOf('const ALLOWED_INVOKE_CHANNELS')
    const listenIdx = src.indexOf('const ALLOWED_LISTEN_CHANNELS')
    expect(src.slice(invokeIdx, listenIdx)).not.toContain("'accounts:authStateChanged',")
    expect(src.slice(listenIdx)).toContain("'accounts:authStateChanged',")
  })

  it('both channels are declared on every renderer-facing signature', () => {
    const src = readSource('electron-env.d.ts')
    // invoke carries one union; on / off / removeAll carry one each.
    expect(src.split("'accounts:authState'").length - 1).toBe(1)
    expect(src.split("'accounts:authStateChanged'").length - 1).toBe(3)
  })
})
