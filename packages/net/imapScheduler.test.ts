import { describe, it, expect } from 'vitest'
import {
  PriorityMutex,
  KeyedPriorityMutex,
  selectNextWaiter,
  withImapPriority,
  currentImapPriority,
  resolveImapPriority,
  IMAP_PRIORITY_RANK,
  MAX_OVERTAKES_BEFORE_PROMOTION,
  type SchedulerWaiter,
} from './imapScheduler'

/**
 * §2.17 Phase 1 — scheduling policy tests.
 *
 * These sit one level below the imap.ts integration tests on purpose: the two
 * properties that matter (interactive first, background never starved) are
 * pure queue behaviour, and proving them through an IMAP mock would make them
 * hostage to connection timing.
 */

function waiter(rank: number, seq: number, overtaken = 0): SchedulerWaiter {
  return { rank, seq, overtaken }
}

describe('selectNextWaiter — ordering', () => {
  it('serves the highest-priority waiter, not the oldest', () => {
    const q = [
      waiter(IMAP_PRIORITY_RANK.indexer, 0),
      waiter(IMAP_PRIORITY_RANK.sync, 1),
      waiter(IMAP_PRIORITY_RANK.interactive, 2),
    ]
    expect(selectNextWaiter(q)!.seq).toBe(2)
    // Next in line is `sync`, still ahead of the older `indexer` entry.
    expect(selectNextWaiter(q)!.seq).toBe(1)
    expect(selectNextWaiter(q)!.seq).toBe(0)
  })

  it('is FIFO within one tier', () => {
    const q = [
      waiter(IMAP_PRIORITY_RANK.interactive, 5),
      waiter(IMAP_PRIORITY_RANK.interactive, 3),
      waiter(IMAP_PRIORITY_RANK.interactive, 4),
    ]
    expect([selectNextWaiter(q)!.seq, selectNextWaiter(q)!.seq, selectNextWaiter(q)!.seq])
      .toEqual([3, 4, 5])
  })

  it('returns undefined for an empty queue', () => {
    expect(selectNextWaiter([])).toBeUndefined()
  })

  it('ranks `other` (unlabelled callers) directly behind `interactive`', () => {
    // An unlabelled call site may still be user-facing; it must not sink below
    // the bulk producers, which is the failure mode nobody would notice.
    expect(IMAP_PRIORITY_RANK.other).toBeLessThan(IMAP_PRIORITY_RANK.sync)
    expect(IMAP_PRIORITY_RANK.other).toBeLessThan(IMAP_PRIORITY_RANK.background)
    expect(IMAP_PRIORITY_RANK.other).toBeLessThan(IMAP_PRIORITY_RANK.indexer)
    expect(IMAP_PRIORITY_RANK.interactive).toBeLessThan(IMAP_PRIORITY_RANK.other)
  })
})

describe('selectNextWaiter — anti-starvation', () => {
  it('charges an overtake only to waiters that were already queued', () => {
    const q = [waiter(IMAP_PRIORITY_RANK.indexer, 0), waiter(IMAP_PRIORITY_RANK.sync, 1)]
    // A younger interactive waiter jumps both.
    q.push(waiter(IMAP_PRIORITY_RANK.interactive, 2))
    selectNextWaiter(q)
    expect(q.map(w => w.overtaken)).toEqual([1, 1])

    // A waiter that entered AFTER the winner is not charged: it was never in
    // front of it, so nothing overtook it.
    const later = waiter(IMAP_PRIORITY_RANK.background, 99)
    q.push(later)
    q.push(waiter(IMAP_PRIORITY_RANK.interactive, 3))
    selectNextWaiter(q)
    expect(later.overtaken).toBe(0)
  })

  it('does not promote a waiter one overtake short of the threshold', () => {
    // Boundary check on the `>=` in `effectiveRank`: one short of the
    // threshold, the waiter is still ranked by its own (low) tier and a
    // younger interactive waiter still wins on rank alone.
    const bg = waiter(IMAP_PRIORITY_RANK.indexer, 0, MAX_OVERTAKES_BEFORE_PROMOTION - 1)
    const q: SchedulerWaiter[] = [bg, waiter(IMAP_PRIORITY_RANK.interactive, 1)]
    const chosen = selectNextWaiter(q)!
    expect(chosen.rank).toBe(IMAP_PRIORITY_RANK.interactive)
    expect(bg.overtaken).toBe(MAX_OVERTAKES_BEFORE_PROMOTION)
  })

  it('promotes exactly at the threshold, not one overtake later', () => {
    const bg = waiter(IMAP_PRIORITY_RANK.indexer, 0, MAX_OVERTAKES_BEFORE_PROMOTION)
    const q: SchedulerWaiter[] = [bg, waiter(IMAP_PRIORITY_RANK.interactive, 1)]
    // At exactly the threshold the promoted waiter now outranks every
    // unpromoted tier, including the younger interactive arrival.
    expect(selectNextWaiter(q)).toBe(bg)
  })

  it('promotes a waiter above every unpromoted tier after MAX_OVERTAKES_BEFORE_PROMOTION', () => {
    const bg = waiter(IMAP_PRIORITY_RANK.indexer, 0)
    const q: SchedulerWaiter[] = [bg]
    for (let i = 0; i < MAX_OVERTAKES_BEFORE_PROMOTION; i++) {
      q.push(waiter(IMAP_PRIORITY_RANK.interactive, 100 + i))
      const chosen = selectNextWaiter(q)!
      expect(chosen.rank).toBe(IMAP_PRIORITY_RANK.interactive)
    }
    expect(bg.overtaken).toBe(MAX_OVERTAKES_BEFORE_PROMOTION)

    // The next interactive arrival no longer wins: the promoted waiter does.
    q.push(waiter(IMAP_PRIORITY_RANK.interactive, 999))
    expect(selectNextWaiter(q)).toBe(bg)
  })

  it('drains promoted waiters oldest-first', () => {
    const a = waiter(IMAP_PRIORITY_RANK.indexer, 0, MAX_OVERTAKES_BEFORE_PROMOTION)
    const b = waiter(IMAP_PRIORITY_RANK.sync, 1, MAX_OVERTAKES_BEFORE_PROMOTION)
    const q = [b, a]
    expect(selectNextWaiter(q)).toBe(a)
    expect(selectNextWaiter(q)).toBe(b)
  })
})

describe('PriorityMutex', () => {
  it('runs one operation at a time', async () => {
    const mutex = new PriorityMutex()
    let concurrent = 0
    let peak = 0
    const op = () => mutex.run('other', async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise(r => setTimeout(r, 5))
      concurrent -= 1
    })
    await Promise.all([op(), op(), op()])
    expect(peak).toBe(1)
  })

  it('serves a queued interactive operation before older background ones', async () => {
    const mutex = new PriorityMutex()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstDone = new Promise<void>(r => { releaseFirst = r })

    // Hold the lock so everything else has to queue.
    const holder = mutex.run('sync', async () => {
      order.push('holder')
      await firstDone
    })
    // Let the holder actually take the lock before queueing.
    await Promise.resolve()

    const queued = [
      mutex.run('indexer', async () => { order.push('indexer') }),
      mutex.run('background', async () => { order.push('background') }),
      mutex.run('sync', async () => { order.push('sync') }),
      mutex.run('interactive', async () => { order.push('interactive') }),
    ]
    expect(mutex.queueLength).toBe(4)

    releaseFirst()
    await Promise.all([holder, ...queued])

    expect(order).toEqual(['holder', 'interactive', 'sync', 'background', 'indexer'])
  })

  it('does not let a background stream starve: the queued indexer op still runs', async () => {
    const mutex = new PriorityMutex()
    const order: string[] = []
    let releaseHolder!: () => void
    const holderGate = new Promise<void>(r => { releaseHolder = r })

    const holder = mutex.run('other', async () => { await holderGate })
    await Promise.resolve()

    // One indexer waiter, then a continuous stream of interactive work: more
    // arrivals than the promotion threshold, each one queued while the lock is
    // still held, i.e. the worst case for the background waiter.
    const indexerOp = mutex.run('indexer', async () => { order.push('indexer') })
    const interactiveOps: Promise<void>[] = []
    for (let i = 0; i < MAX_OVERTAKES_BEFORE_PROMOTION + 4; i++) {
      interactiveOps.push(mutex.run('interactive', async () => { order.push(`i${i}`) }))
    }

    releaseHolder()
    await Promise.all([holder, indexerOp, ...interactiveOps])

    const indexerPos = order.indexOf('indexer')
    expect(indexerPos).toBeGreaterThanOrEqual(0)
    // Bounded, and bounded by the promotion threshold rather than by the
    // length of the interactive stream: it ran before the last arrivals.
    expect(indexerPos).toBeLessThanOrEqual(MAX_OVERTAKES_BEFORE_PROMOTION)
    expect(order.length).toBe(MAX_OVERTAKES_BEFORE_PROMOTION + 5)
  })

  it('releases the lock when an operation rejects', async () => {
    const mutex = new PriorityMutex()
    await expect(mutex.run('other', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(mutex.isLocked).toBe(false)
    await expect(mutex.run('other', async () => 'ok')).resolves.toBe('ok')
  })

  it('a promoted waiter that rejects still hands the lock to the one queued behind it', async () => {
    // The ordinary form of an IMAP failure — a dropped connection, a NO
    // response — arrives on whichever waiter the scheduler just promoted,
    // with a third one already queued behind it. `run()`'s `finally { this.
    // release() }` is supposed to fire on the rejection path exactly as it
    // does on the success path; this proves the waiter standing behind a
    // throwing one is not left hanging on a lock nobody ever released, and
    // that the rejection itself still reaches ITS OWN caller (not swallowed,
    // not redirected to the next waiter).
    const mutex = new PriorityMutex()
    const order: string[] = []
    let releaseHolder!: () => void
    const gate = new Promise<void>(r => { releaseHolder = r })

    const holder = mutex.run('sync', async () => { order.push('holder'); await gate })
    await Promise.resolve()

    const middle = mutex.run('interactive', async () => {
      order.push('middle')
      throw new Error('imap NO: connection dropped mid-fetch')
    })
    const tail = mutex.run('interactive', async () => { order.push('tail') })

    releaseHolder()

    await holder
    await expect(middle).rejects.toThrow('imap NO: connection dropped mid-fetch')
    await tail

    expect(order).toEqual(['holder', 'middle', 'tail'])
    expect(mutex.isLocked).toBe(false)
  })

  it('a same-tier late arrival cannot barge ahead of an already-queued waiter', async () => {
    // Hand-over is direct: the lock is never released to the world between two
    // waiters, so an operation that arrives while the previous holder is
    // finishing joins the queue instead of grabbing a momentarily free lock.
    const mutex = new PriorityMutex()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const holder = mutex.run('interactive', async () => { await gate })
    await Promise.resolve()

    const queued = mutex.run('indexer', async () => { order.push('queued-indexer') })
    release()
    // Arrives while the hand-over is in flight — same tier, so FIFO decides.
    const late = mutex.run('indexer', async () => { order.push('late-indexer') })

    await Promise.all([holder, queued, late])
    expect(order).toEqual(['queued-indexer', 'late-indexer'])
  })

  it('a late arrival of a HIGHER tier does overtake — that is the feature', async () => {
    const mutex = new PriorityMutex()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const holder = mutex.run('sync', async () => { await gate })
    await Promise.resolve()

    const queued = mutex.run('indexer', async () => { order.push('queued-indexer') })
    release()
    const late = mutex.run('interactive', async () => { order.push('late-interactive') })

    await Promise.all([holder, queued, late])
    expect(order).toEqual(['late-interactive', 'queued-indexer'])
  })

  it('hand-over keeps the lock held: a reentrant capture issued the instant the promoted waiter resumes must queue, not run', async () => {
    // Guards the "Ownership is transferred, not released: `locked` stays
    // true" comment in `release()`. A waiter queued BEFORE the holder
    // releases (as in every test above) cannot catch a regression that flips
    // `locked = false` before waking the chosen waiter: `selectNextWaiter`
    // already picked it, so it runs regardless of what `locked` does in the
    // meantime. The only vantage point that can see the raw flag is a NEW
    // `run()` call issued synchronously, from inside the promoted waiter's
    // own body, at the earliest instant it resumes — before it does anything
    // that would itself depend on the lock still being held. If `release()`
    // ever set `locked = false` ahead of `next.wake()`, this reentrant call's
    // `acquire()` would see the lock as free, take the fast synchronous path
    // and run its body concurrently with the promoted waiter's — observable
    // here as a second concurrent occupant.
    const mutex = new PriorityMutex()
    let concurrent = 0
    let peak = 0

    let releaseHolder!: () => void
    const gate = new Promise<void>(r => { releaseHolder = r })
    const holder = mutex.run('sync', async () => { await gate })
    await Promise.resolve()

    let interloper!: Promise<void>
    const promoted = mutex.run('interactive', async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      // Fired synchronously, before this waiter's own first `await` — the
      // earliest an interloper could plausibly race the hand-over. NOT
      // awaited here: it is queued behind `promoted` in the correct
      // implementation and can only run once `promoted` returns and its
      // `finally { this.release() }` fires — awaiting it inline here would
      // deadlock.
      interloper = mutex.run('other', async () => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await Promise.resolve()
        concurrent -= 1
      })
      await Promise.resolve()
      concurrent -= 1
    })

    releaseHolder()
    await Promise.all([holder, promoted])
    await interloper

    expect(peak).toBe(1)
  })
})

describe('KeyedPriorityMutex', () => {
  it('serializes per key and runs different keys concurrently', async () => {
    const locks = new KeyedPriorityMutex()
    const active = new Map<string, number>()
    let crossKeyOverlap = false
    const op = (key: string) => locks.run(key, 'other', async () => {
      const n = (active.get(key) ?? 0) + 1
      active.set(key, n)
      if (n > 1) throw new Error('same-key concurrency')
      if (active.get('a') && active.get('b')) crossKeyOverlap = true
      await new Promise(r => setTimeout(r, 5))
      active.set(key, (active.get(key) ?? 1) - 1)
    })
    await Promise.all([op('a'), op('a'), op('b'), op('b')])
    expect(crossKeyOverlap).toBe(true)
  })

  it('forgetIfIdle keeps a held lock (dropping it would break serialization)', async () => {
    const locks = new KeyedPriorityMutex()
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let concurrent = 0
    let peak = 0
    const held = locks.run('k', 'other', async () => {
      concurrent += 1; peak = Math.max(peak, concurrent)
      await gate
      concurrent -= 1
    })
    await Promise.resolve()

    // A disconnect arrives mid-operation and tries to drop the lock.
    locks.forgetIfIdle('k')
    locks.forgetAllIdle()

    const next = locks.run('k', 'other', async () => {
      concurrent += 1; peak = Math.max(peak, concurrent)
      concurrent -= 1
    })
    release()
    await Promise.all([held, next])
    expect(peak).toBe(1)
  })
})

describe('ambient priority', () => {
  it('defaults to `other` outside any scope', () => {
    expect(currentImapPriority()).toBe('other')
    expect(resolveImapPriority(undefined)).toBe('other')
  })

  it('propagates across awaits', async () => {
    const observed = await withImapPriority('interactive', async () => {
      await new Promise(r => setTimeout(r, 1))
      return currentImapPriority()
    })
    expect(observed).toBe('interactive')
  })

  it('nests, and the inner scope wins for its own subtree', async () => {
    await withImapPriority('sync', async () => {
      expect(currentImapPriority()).toBe('sync')
      await withImapPriority('indexer', async () => {
        expect(currentImapPriority()).toBe('indexer')
      })
      expect(currentImapPriority()).toBe('sync')
    })
  })

  it('an explicit priority beats the ambient one', () => {
    withImapPriority('indexer', () => {
      expect(resolveImapPriority('interactive')).toBe('interactive')
      expect(resolveImapPriority(undefined)).toBe('indexer')
    })
  })

  it('restores the outer tier after an inner scope throws', async () => {
    // A rejecting net call must not corrupt ambient state for whatever runs
    // next in the same outer scope, or for the caller once the scope exits.
    await withImapPriority('sync', async () => {
      expect(currentImapPriority()).toBe('sync')
      await expect(withImapPriority('indexer', async () => {
        throw new Error('boom')
      })).rejects.toThrow('boom')
      expect(currentImapPriority()).toBe('sync')
    })
    expect(currentImapPriority()).toBe('other')
  })

  it('two concurrent sibling scopes do not see each other’s tier', async () => {
    // Not nesting — two independent async chains racing. Proves the store is
    // keyed per async-context, not a single mutable "current tier" that the
    // faster one could stomp on.
    const results = await Promise.all([
      withImapPriority('interactive', async () => {
        await new Promise(r => setTimeout(r, 5))
        return currentImapPriority()
      }),
      withImapPriority('indexer', async () => {
        await new Promise(r => setTimeout(r, 1))
        return currentImapPriority()
      }),
    ])
    expect(results).toEqual(['interactive', 'indexer'])
  })

  it('leaks into fire-and-forget work started synchronously inside the scope — this is the risk every call site must avoid by always awaiting its leaf', async () => {
    // Documents the mechanism, not a defect in imapScheduler.ts itself: every
    // production call site (imap.ts, main.ts, offlineReplay.ts) wraps exactly
    // one net call and is always awaited by its caller (see the corresponding
    // integration tests in imap.test.ts). If a future call site kicked off
    // work WITHOUT awaiting it from inside `withImapPriority`, that detached
    // work would keep the wrapper's tier for its entire lifetime, including
    // long after the wrapper itself has returned — exactly this scenario.
    let leaked: string | undefined
    let settled = false
    const detachedDone = new Promise<void>(resolve => {
      withImapPriority('interactive', () => {
        // Not returned, not awaited by the withImapPriority caller below —
        // a fire-and-forget continuation.
        void Promise.resolve().then(() => {
          leaked = currentImapPriority()
          settled = true
          resolve()
        })
      })
    })

    // The scope has already returned by this point (withImapPriority's
    // callback was synchronous) — ambient state here is back to the default.
    expect(currentImapPriority()).toBe('other')
    expect(settled).toBe(false)

    await detachedDone
    expect(leaked).toBe('interactive')
  })
})
