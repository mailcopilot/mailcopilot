/**
 * §2.17 Phase 1 — priority scheduling for the IMAP locks.
 *
 * Phase 0 shipped a `priority` tag that was recorded and then thrown away: every
 * queue an IMAP operation can sit in was plain FIFO, so an interactive message
 * open waited behind whatever background work happened to be in front of it.
 * There are THREE such queues, not two — the singleton op lock and the
 * per-account op chain (both `chain = chain.then(fn)` promise chains), plus the
 * per-account connection-slot semaphore (`perAccountWaiters` in imap.ts, which
 * handed a freed slot to `shift()`). All three are priority-ordered now; naming
 * only the two op locks understates where an interactive open can be stuck.
 *
 * Field evidence (main.log 2026-08-26 22:58–22:59): `net:setSeen`, a single
 * STORE command, took 10 941 ms while the offline body sync was pushing 31 full
 * EML downloads through the same chain. The 10 s budget in `net:messageDetails`
 * then expired on OUR OWN queue and the renderer was told the body "is not
 * available offline".
 *
 * This module owns the ordering decision, split out of `imap.ts` so the policy
 * is unit-testable without an IMAP mock (the file is already a 3.5k-line
 * hotspot — CLAUDE.md §7 hotspot policy).
 *
 * Three properties the design has to hold, all of them load-bearing:
 *
 *  1. **Ordering only, never pre-emption.** A waiter is chosen when the lock is
 *     handed over; work that has already started runs to completion. Nothing
 *     here can cancel, close or reset a connection.
 *
 *  2. **No starvation of background tiers.** A stream of interactive requests
 *     must not freeze the body indexer forever. The mechanism is an *overtake
 *     counter*, not wall-clock aging: every time a waiter is passed over by a
 *     younger, higher-priority waiter its counter grows, and at
 *     `MAX_OVERTAKES_BEFORE_PROMOTION` it is promoted above every unpromoted
 *     tier (promoted waiters are then served oldest-first among themselves).
 *     Delay is therefore bounded in *operations*, not seconds.
 *
 *     Why not time-based aging: the clock is the wrong unit here. A laptop that
 *     suspends for an hour would resume with every queued waiter aged past any
 *     threshold, collapsing priority to FIFO exactly at the moment resume-storm
 *     sync contends with the user's first click. The overtake counter cannot be
 *     moved by the clock, needs no timers, and makes the guarantee testable
 *     without fake timers.
 *
 *  3. **IDLE is untouched.** The IDLE connection is a separate client that
 *     takes neither of these locks (see `idleClient` in imap.ts), so priority
 *     cannot give any tier the right to displace it — the §5 invariant
 *     "background does not block IDLE" is preserved by construction, not by a
 *     rule this module has to remember.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Identifies which subsystem is waiting on an IMAP lock.
 *
 * Phase 0 introduced this as a metric tag only; Phase 1 makes it the scheduling
 * key as well. The value space mirrors `DOMAINS.imap_pool_requester` in
 * electron/metricsSchema.ts.
 */
export type ImapPoolRequester = 'interactive' | 'background' | 'indexer' | 'sync' | 'other'

/**
 * Lower rank wins.
 *
 * `other` sits directly behind `interactive` on purpose: it is the tier of a
 * caller nobody has labelled yet, and an unlabelled caller may well be on a
 * user-facing path. Demoting "unknown" below the bulk producers would make
 * every future call site slow by default — the failure mode would be silent and
 * would look exactly like the bug this task fixes. The bulk producers are
 * explicitly labelled, so they are the ones that carry the risk of being wrong.
 */
export const IMAP_PRIORITY_RANK: Record<ImapPoolRequester, number> = {
  interactive: 0,
  other: 1,
  sync: 2,
  background: 3,
  indexer: 4,
}

/**
 * How many times a waiter may be overtaken before it outranks every unpromoted
 * tier.
 *
 * Eight is chosen against the shape of the work, not as a round number: the
 * operations that overtake a background waiter are interactive ones (a body
 * fetch, a STORE, a MOVE), which are sub-second on a healthy connection, so the
 * worst-case added delay for a body-indexer fetch is a handful of seconds —
 * invisible for a background producer. Raising it trades background latency for
 * interactive latency; lowering it towards 1 collapses the whole mechanism back
 * into FIFO.
 */
export const MAX_OVERTAKES_BEFORE_PROMOTION = 8

/** Minimal shape the selection algorithm needs. Exported for tests. */
export type SchedulerWaiter = {
  /** Priority rank at enqueue time (see IMAP_PRIORITY_RANK). */
  rank: number
  /** Monotonic enqueue sequence — the FIFO tie-breaker. */
  seq: number
  /** How many times this waiter has been passed over. */
  overtaken: number
}

/** A promoted waiter outranks every unpromoted tier (rank 0 is `interactive`). */
function effectiveRank(w: SchedulerWaiter): number {
  return w.overtaken >= MAX_OVERTAKES_BEFORE_PROMOTION ? -1 : w.rank
}

function outranks(a: SchedulerWaiter, b: SchedulerWaiter): boolean {
  const ra = effectiveRank(a)
  const rb = effectiveRank(b)
  if (ra !== rb) return ra < rb
  // Same effective rank — oldest first. This is what keeps the queue FIFO
  // within a tier, and what makes promoted waiters drain in arrival order.
  return a.seq < b.seq
}

/**
 * Remove and return the next waiter to run, charging an overtake to every
 * waiter that entered the queue earlier and did not win.
 *
 * Mutates `waiters` in place: the array is the queue. Returns `undefined` for
 * an empty queue.
 */
export function selectNextWaiter<T extends SchedulerWaiter>(waiters: T[]): T | undefined {
  if (waiters.length === 0) return undefined
  let bestIdx = 0
  for (let i = 1; i < waiters.length; i++) {
    if (outranks(waiters[i]!, waiters[bestIdx]!)) bestIdx = i
  }
  const chosen = waiters.splice(bestIdx, 1)[0]!
  for (const w of waiters) {
    if (w.seq < chosen.seq) w.overtaken += 1
  }
  return chosen
}

type MutexWaiter = SchedulerWaiter & { wake: () => void }

/**
 * Mutual exclusion with a priority queue.
 *
 * Replaces the `chain = chain.then(fn)` idiom: same guarantee (one operation at
 * a time, a rejecting operation still releases), different choice of who goes
 * next. Hand-over is direct — the lock is never released to the world between
 * two waiters, so a newly arriving low-priority caller cannot barge in front of
 * a waiter that has already been queued.
 */
export class PriorityMutex {
  private locked = false
  private waiters: MutexWaiter[] = []
  private seqCounter = 0

  /** True when an operation currently holds the lock. */
  get isLocked(): boolean {
    return this.locked
  }

  /** Number of queued (not yet running) operations. */
  get queueLength(): number {
    return this.waiters.length
  }

  private acquire(priority: ImapPoolRequester): Promise<void> | null {
    if (!this.locked) {
      this.locked = true
      return null
    }
    return new Promise<void>(resolve => {
      this.waiters.push({
        rank: IMAP_PRIORITY_RANK[priority] ?? IMAP_PRIORITY_RANK.other,
        seq: this.seqCounter++,
        overtaken: 0,
        wake: resolve,
      })
    })
  }

  private release(): void {
    const next = selectNextWaiter(this.waiters)
    if (!next) {
      this.locked = false
      return
    }
    // Ownership is transferred, not released: `locked` stays true.
    next.wake()
  }

  /** Run `fn` under the lock. Rejections propagate; the lock is always released. */
  async run<T>(priority: ImapPoolRequester, fn: () => Promise<T>): Promise<T> {
    const wait = this.acquire(priority)
    if (wait) await wait
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

/** Keyed collection of `PriorityMutex` (one per account key). */
export class KeyedPriorityMutex {
  private byKey = new Map<string, PriorityMutex>()

  run<T>(key: string, priority: ImapPoolRequester, fn: () => Promise<T>): Promise<T> {
    let mutex = this.byKey.get(key)
    if (!mutex) {
      mutex = new PriorityMutex()
      this.byKey.set(key, mutex)
    }
    return mutex.run(priority, fn)
  }

  /**
   * Drop the mutex for `key` **only if it is idle**.
   *
   * Deliberately not an unconditional delete, which is what the promise-chain
   * version effectively did on `disconnectPerAccount`: dropping a held lock
   * hands a fresh, unlocked mutex to the next caller and lets it issue commands
   * on the same account while the in-flight operation is still running. That is
   * exactly the mailbox-switching hazard the lock exists to prevent.
   */
  forgetIfIdle(key: string): void {
    const mutex = this.byKey.get(key)
    if (!mutex) return
    if (mutex.isLocked || mutex.queueLength > 0) return
    this.byKey.delete(key)
  }

  /** Drop every idle mutex (busy ones are kept — see `forgetIfIdle`). */
  forgetAllIdle(): void {
    for (const key of Array.from(this.byKey.keys())) this.forgetIfIdle(key)
  }
}

/**
 * Ambient priority for the current async context.
 *
 * Why ambient rather than an explicit parameter on every net function: the
 * tier is a property of *why* the work is happening, and that is known at the
 * entry point (an IPC handler, an indexer callback, a periodic timer) — not at
 * the twenty-odd `withImapRetry` call sites in between. Threading a parameter
 * through `setSeen`, `moveMessages`, `fetchMessageDetails`, `downloadRawMessage`
 * and friends would put the same value in every signature and still leave every
 * new function defaulting to "unlabelled" silently. An explicit `opts.priority`
 * remains available and always wins, so a call site that needs to differ from
 * its context can say so.
 *
 * AsyncLocalStorage is already the mechanism this module's neighbour uses for
 * the same reason (`outcomeReportingScope` in imap.ts): promise continuations
 * inherit the store, so the tag survives the awaits between the entry point and
 * the lock.
 *
 * What a scope does NOT promise — stated because the opposite is the easy thing
 * to assume, and a wrong assumption here is silent:
 *
 *  - **A scope is a context, not a decorator around one call.** It routinely
 *    covers a whole pass with several sequential IMAP calls inside it (offline
 *    replay's `executeBatch` is the plain case), and that is intended: the tier
 *    is a property of the reason, and the reason does not change between two
 *    STOREs of the same replay batch.
 *
 *  - **Work detached inside a scope keeps the tier.** Anything started with
 *    `void f()` / `f().catch(...)` inherits the ambient tier and keeps it after
 *    the scope's own promise settles — that is what context propagation means,
 *    not an accident. So a detached child silently takes the tier of whoever
 *    happened to start it, which may be a different tier at each call site.
 *    The rule for new detached work is therefore: **label it at its own
 *    boundary** (see `processMailRules` in electron/main.ts, which pins itself
 *    to `background` precisely so its seven callers cannot decide for it), or
 *    accept — deliberately, in writing — that its tier follows the caller.
 *
 *  - **A scope over a dedicated-connection call does nothing.** Dedicated
 *    connections (`createDedicatedConnection` in imap.ts) take neither op lock
 *    nor a pool slot, so there is no queue for a tier to order. Such a scope is
 *    inert by construction, not merely unused.
 */
const priorityScope = new AsyncLocalStorage<ImapPoolRequester>()

/** Run `fn` with `priority` as the ambient tier for every IMAP lock it takes. */
export function withImapPriority<T>(priority: ImapPoolRequester, fn: () => T): T {
  return priorityScope.run(priority, fn)
}

/** The ambient tier, or `'other'` when the caller is unlabelled. */
export function currentImapPriority(): ImapPoolRequester {
  return priorityScope.getStore() ?? 'other'
}

/** Resolve the tier for one operation: explicit wins over ambient. */
export function resolveImapPriority(explicit: ImapPoolRequester | undefined): ImapPoolRequester {
  return explicit ?? currentImapPriority()
}
