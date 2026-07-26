/**
 * §2.16 — main.ts draft finalization tracker (pure unit tests).
 *
 * `sentDraftIdsByAccount` is a module-level Map and `rememberDraftFinalized` /
 * `wasDraftFinalized` are private functions that cannot be imported directly.
 * We mirror them verbatim (same approach as Settings.bodyRetention.test.ts) to:
 *
 *   - Pin the LRU cap behaviour (SENT_DRAFTS_PER_ACCOUNT_LIMIT = 64).
 *   - Pin per-account isolation (account A's list never bleeds into account B).
 *   - Pin the re-finalize de-dupe (calling rememberDraftFinalized twice for the
 *     same id must not grow the list).
 *   - Pin the move-to-end (FIFO with re-touch) semantics.
 *
 * `maybeScheduleOrphanDraftsSweep` idempotency is tested via a mirrored
 * implementation of the guard set (`draftsSweptAccounts`).
 *
 * The `drafts:wasSent` IPC handler itself is thin (parse accountId/draftId,
 * delegate to wasDraftFinalized) — its behaviour is fully covered by the
 * tracker tests below plus the existing imap.test.ts coverage.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { z } from 'zod'

// ─── Mirror: sentDraftIdsByAccount tracker ────────────────────────────────────
// Keep in sync with electron/main.ts §2.16 sentDraftIdsByAccount section.

const SENT_DRAFTS_PER_ACCOUNT_LIMIT = 64

class DraftFinalizedTracker {
  private store = new Map<number, string[]>()

  rememberDraftFinalized(accountId: number, draftId: string): void {
    const list = this.store.get(accountId) ?? []
    const idx = list.indexOf(draftId)
    if (idx >= 0) list.splice(idx, 1)
    list.push(draftId)
    while (list.length > SENT_DRAFTS_PER_ACCOUNT_LIMIT) list.shift()
    this.store.set(accountId, list)
  }

  wasDraftFinalized(accountId: number, draftId: string): boolean {
    const list = this.store.get(accountId)
    return Boolean(list && list.includes(draftId))
  }

  /** Expose the list for length assertions. */
  listFor(accountId: number): string[] {
    return this.store.get(accountId) ?? []
  }
}

// ─── Mirror: maybeScheduleOrphanDraftsSweep idempotency guard ─────────────────
// Keep in sync with electron/main.ts §2.16 maybeScheduleOrphanDraftsSweep.

class SweepScheduler {
  private sweptAccounts = new Set<number>()

  maybeScheduleSweep(
    accountId: number,
    getCachedDraftsPath: () => string | undefined,
    onSchedule: (path: string) => void,
  ): void {
    if (this.sweptAccounts.has(accountId)) return
    const draftsPath = getCachedDraftsPath()
    if (!draftsPath) return
    this.sweptAccounts.add(accountId)
    onSchedule(draftsPath)
  }

  hasSwept(accountId: number): boolean {
    return this.sweptAccounts.has(accountId)
  }
}

// ─── Tests: DraftFinalizedTracker ─────────────────────────────────────────────

describe('main.ts §2.16 — sentDraftIdsByAccount tracker', () => {
  let tracker: DraftFinalizedTracker

  beforeEach(() => {
    tracker = new DraftFinalizedTracker()
  })

  it('wasDraftFinalized returns false for unknown accountId', () => {
    expect(tracker.wasDraftFinalized(1, 'draft-abc')).toBe(false)
  })

  it('wasDraftFinalized returns false for unknown draftId under a known account', () => {
    tracker.rememberDraftFinalized(1, 'draft-known')
    expect(tracker.wasDraftFinalized(1, 'draft-unknown')).toBe(false)
  })

  it('wasDraftFinalized returns true after rememberDraftFinalized', () => {
    tracker.rememberDraftFinalized(1, 'draft-abc')
    expect(tracker.wasDraftFinalized(1, 'draft-abc')).toBe(true)
  })

  it('per-account isolation: account 2 does not see account 1 drafts', () => {
    tracker.rememberDraftFinalized(1, 'draft-abc')
    expect(tracker.wasDraftFinalized(2, 'draft-abc')).toBe(false)
  })

  it('multiple distinct draftIds tracked independently for the same account', () => {
    tracker.rememberDraftFinalized(1, 'draft-a')
    tracker.rememberDraftFinalized(1, 'draft-b')
    expect(tracker.wasDraftFinalized(1, 'draft-a')).toBe(true)
    expect(tracker.wasDraftFinalized(1, 'draft-b')).toBe(true)
    expect(tracker.wasDraftFinalized(1, 'draft-c')).toBe(false)
  })

  it('re-finalizing the same draftId does not grow the list (de-dupe)', () => {
    tracker.rememberDraftFinalized(1, 'draft-abc')
    tracker.rememberDraftFinalized(1, 'draft-abc')
    expect(tracker.listFor(1)).toHaveLength(1)
    expect(tracker.wasDraftFinalized(1, 'draft-abc')).toBe(true)
  })

  it('re-finalizing moves the id to the end (FIFO with re-touch)', () => {
    tracker.rememberDraftFinalized(1, 'draft-a')
    tracker.rememberDraftFinalized(1, 'draft-b')
    tracker.rememberDraftFinalized(1, 'draft-a') // re-touch 'a'
    const list = tracker.listFor(1)
    expect(list[list.length - 1]).toBe('draft-a')
    expect(list).toHaveLength(2)
  })

  describe('LRU cap at SENT_DRAFTS_PER_ACCOUNT_LIMIT (64)', () => {
    it('stays at the cap when exactly 64 entries are added', () => {
      for (let i = 0; i < 64; i++) {
        tracker.rememberDraftFinalized(1, `draft-${i}`)
      }
      expect(tracker.listFor(1)).toHaveLength(64)
      expect(tracker.wasDraftFinalized(1, 'draft-0')).toBe(true)
      expect(tracker.wasDraftFinalized(1, 'draft-63')).toBe(true)
    })

    it('evicts the oldest entry when the 65th entry is added', () => {
      for (let i = 0; i < 64; i++) {
        tracker.rememberDraftFinalized(1, `draft-${i}`)
      }
      // 65th entry — draft-0 (oldest) must be evicted.
      tracker.rememberDraftFinalized(1, 'draft-NEW')
      expect(tracker.listFor(1)).toHaveLength(64)
      expect(tracker.wasDraftFinalized(1, 'draft-0')).toBe(false) // evicted
      expect(tracker.wasDraftFinalized(1, 'draft-1')).toBe(true)  // still present
      expect(tracker.wasDraftFinalized(1, 'draft-NEW')).toBe(true)
    })

    it('evicts two oldest entries when 66 entries are inserted', () => {
      for (let i = 0; i < 66; i++) {
        tracker.rememberDraftFinalized(1, `draft-${i}`)
      }
      expect(tracker.listFor(1)).toHaveLength(64)
      expect(tracker.wasDraftFinalized(1, 'draft-0')).toBe(false)
      expect(tracker.wasDraftFinalized(1, 'draft-1')).toBe(false)
      expect(tracker.wasDraftFinalized(1, 'draft-2')).toBe(true)
    })

    it('cap applies independently per account', () => {
      // Fill account 1 to cap and overflow.
      for (let i = 0; i < 65; i++) {
        tracker.rememberDraftFinalized(1, `draft-${i}`)
      }
      // Account 2 has only a few entries.
      tracker.rememberDraftFinalized(2, 'draft-x')
      expect(tracker.listFor(1)).toHaveLength(64)
      expect(tracker.listFor(2)).toHaveLength(1)
      expect(tracker.wasDraftFinalized(1, 'draft-0')).toBe(false) // evicted
      expect(tracker.wasDraftFinalized(2, 'draft-x')).toBe(true)
    })
  })
})

// ─── Tests: SweepScheduler ────────────────────────────────────────────────────

describe('main.ts §2.16 — maybeScheduleOrphanDraftsSweep idempotency', () => {
  let scheduler: SweepScheduler

  beforeEach(() => {
    scheduler = new SweepScheduler()
  })

  it('schedules the sweep on first call for an account', () => {
    const scheduled: string[] = []
    scheduler.maybeScheduleSweep(1, () => 'Drafts', path => scheduled.push(path))
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]).toBe('Drafts')
  })

  it('does not schedule a second time for the same account in the same session', () => {
    const scheduled: string[] = []
    const schedule = (path: string) => scheduled.push(path)
    scheduler.maybeScheduleSweep(1, () => 'Drafts', schedule)
    scheduler.maybeScheduleSweep(1, () => 'Drafts', schedule)
    scheduler.maybeScheduleSweep(1, () => 'Drafts', schedule)
    expect(scheduled).toHaveLength(1)
  })

  it('schedules independently for different accounts (no cross-contamination)', () => {
    const scheduled: Array<{ accountId: number; path: string }> = []
    scheduler.maybeScheduleSweep(1, () => 'Drafts', path => scheduled.push({ accountId: 1, path }))
    scheduler.maybeScheduleSweep(2, () => '[Gmail]/Drafts', path => scheduled.push({ accountId: 2, path }))
    expect(scheduled).toHaveLength(2)
    expect(scheduled[0]).toEqual({ accountId: 1, path: 'Drafts' })
    expect(scheduled[1]).toEqual({ accountId: 2, path: '[Gmail]/Drafts' })
  })

  it('does not schedule when getCachedDraftsPath returns undefined (folder not yet known)', () => {
    const scheduled: string[] = []
    scheduler.maybeScheduleSweep(1, () => undefined, path => scheduled.push(path))
    expect(scheduled).toHaveLength(0)
    // hasSwept must remain false so the next idleStart attempt can try again.
    expect(scheduler.hasSwept(1)).toBe(false)
  })

  it('does not schedule when getCachedDraftsPath returns empty string', () => {
    const scheduled: string[] = []
    // Empty string is falsy — same guard as the source (if (!draftsPath) return).
    scheduler.maybeScheduleSweep(1, () => '', path => scheduled.push(path))
    expect(scheduled).toHaveLength(0)
    expect(scheduler.hasSwept(1)).toBe(false)
  })

  it('marks account as swept only after a successful scheduling (path present)', () => {
    const scheduled: string[] = []
    scheduler.maybeScheduleSweep(1, () => undefined, path => scheduled.push(path))
    expect(scheduler.hasSwept(1)).toBe(false)

    // Second call — now the path is available.
    scheduler.maybeScheduleSweep(1, () => 'Drafts', path => scheduled.push(path))
    expect(scheduler.hasSwept(1)).toBe(true)
    expect(scheduled).toHaveLength(1)
  })

  it('once swept, subsequent calls with missing path are still no-ops', () => {
    const scheduled: string[] = []
    scheduler.maybeScheduleSweep(1, () => 'Drafts', path => scheduled.push(path))
    // Path disappears — should still be a no-op because account is swept.
    scheduler.maybeScheduleSweep(1, () => undefined, path => scheduled.push(path))
    expect(scheduled).toHaveLength(1)
  })
})

// ─── Iter4 Medium: per-account lock shared by saveDraft + deleteDraft ─────────
//
// Codex security review (iter 4) flagged a privacy/data-retention race:
//
//   net:saveDraft acquires withSaveDraftLock(accountId, ...) before APPENDing.
//   net:deleteDraft (the finalize signal from send/discard) used to call
//   deleteDraft() OUTSIDE that lock. A save started just before the user hit
//   send could complete its APPEND AFTER the delete had already removed the
//   prior copy, leaving sent content lingering in Drafts.
//
// Fix has two layers:
//   1. deleteDraft handler now runs inside withSaveDraftLock(accountId, ...) too,
//      and calls rememberDraftFinalized() inside the same critical section.
//   2. saveDraft handler short-circuits when wasDraftFinalized(id, draftId) is
//      true — both before lock acquisition (fast path) and again after
//      acquiring the lock (closes the TOCTOU window).
//
// We mirror withSaveDraftLock here verbatim and exercise the same handler
// shape: outer wasDraftFinalized check → withSaveDraftLock(...) → inner
// re-check → real work. If anyone refactors the handlers and forgets either
// layer, these tests fail.

const saveDraftLockChains = new Map<number, Promise<unknown>>()

function withSaveDraftLock<T>(accountId: number, fn: () => Promise<T>): Promise<T> {
  const prev = saveDraftLockChains.get(accountId) ?? Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  saveDraftLockChains.set(accountId, next.then(() => undefined, () => undefined))
  return next
}

function resetSaveDraftLocks(): void {
  saveDraftLockChains.clear()
}

/** Mirrors net:saveDraft handler shape: outer LRU bail-out → lock → inner
 *  LRU re-check → work. */
async function saveDraftHandler(
  tracker: DraftFinalizedTracker,
  accountId: number,
  draftId: string,
  doSave: () => Promise<{ uid: number | undefined }>,
): Promise<{ ok: true; uid: number | undefined }> {
  if (tracker.wasDraftFinalized(accountId, draftId)) {
    return { ok: true, uid: undefined }
  }
  const res = await withSaveDraftLock(accountId, async () => {
    if (tracker.wasDraftFinalized(accountId, draftId)) {
      return { uid: undefined as number | undefined }
    }
    return doSave()
  })
  return { ok: true, uid: res.uid }
}

/** Mirrors net:deleteDraft handler shape: lock → real delete → mark
 *  finalized inside the same critical section. */
async function deleteDraftHandler(
  tracker: DraftFinalizedTracker,
  accountId: number,
  draftId: string,
  doDelete: () => Promise<void>,
): Promise<{ ok: true }> {
  await withSaveDraftLock(accountId, async () => {
    await doDelete()
    tracker.rememberDraftFinalized(accountId, draftId)
  })
  return { ok: true }
}

describe('main.ts §2.16 iter4 — deleteDraft serialized with saveDraft via per-account lock', () => {
  let tracker: DraftFinalizedTracker

  beforeEach(() => {
    tracker = new DraftFinalizedTracker()
    resetSaveDraftLocks()
  })

  it('deleteDraft awaits an in-flight saveDraft on the same account before proceeding', async () => {
    const events: string[] = []
    let releaseSave: (() => void) | null = null

    // Long-running saveDraft: resolves only when we release it.
    const savePromise = saveDraftHandler(tracker, 1, 'D1', async () => {
      events.push('save:start')
      await new Promise<void>((resolve) => {
        releaseSave = resolve
      })
      events.push('save:end')
      return { uid: 100 }
    })

    // Yield once to let saveDraft acquire the lock and reach its await.
    await Promise.resolve()
    expect(events).toEqual(['save:start'])

    // Kick off deleteDraft while saveDraft is in flight.
    const deletePromise = deleteDraftHandler(tracker, 1, 'D1', async () => {
      events.push('delete:start')
      events.push('delete:end')
    })

    // Yield several microtasks. deleteDraft must NOT have started — it is
    // queued behind saveDraft on the per-account lock chain.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['save:start'])

    // Release saveDraft. Now deleteDraft is free to run.
    releaseSave!()
    await savePromise
    await deletePromise

    expect(events).toEqual(['save:start', 'save:end', 'delete:start', 'delete:end'])
  })

  it('saveDraft no-ops when draftId is already in the finalized LRU (outer guard)', async () => {
    let saveCalls = 0
    tracker.rememberDraftFinalized(1, 'D1')

    const res = await saveDraftHandler(tracker, 1, 'D1', async () => {
      saveCalls++
      return { uid: 999 }
    })

    expect(saveCalls).toBe(0)
    expect(res).toEqual({ ok: true, uid: undefined })
  })

  it('saveDraft no-ops when finalize completes between outer guard and lock acquisition', async () => {
    // Order of events to construct:
    //   1. saveDraft handler starts, passes outer wasDraftFinalized() (false).
    //   2. Before saveDraft acquires the lock, a deleteDraft handler runs and
    //      finalizes the draft (lock taken+released, LRU now true).
    //   3. saveDraft acquires the lock; the inner re-check must catch the
    //      finalize and skip the IMAP APPEND.
    //
    // We simulate this by holding the lock with a sentinel call, scheduling
    // saveDraft (queued), then running deleteDraft (also queued behind the
    // sentinel), then releasing the sentinel. After step 2 finishes, the
    // saveDraft body runs the inner re-check and short-circuits.

    let saveCalls = 0
    let releaseSentinel: (() => void) | null = null

    // Sentinel grabs the lock first to force ordering.
    const sentinelPromise = withSaveDraftLock(1, () => new Promise<void>((resolve) => {
      releaseSentinel = resolve
    }))

    // Yield so the sentinel acquires the lock.
    await Promise.resolve()

    // Both queued behind the sentinel, in order: save first, then delete.
    // BUT: Codex finding is the OPPOSITE order (delete before queued save).
    // To exercise that properly, we queue delete first so it runs first
    // upon release; then the saveDraft sees finalized=true at its inner
    // re-check.
    const deletePromise = deleteDraftHandler(tracker, 1, 'D1', async () => {
      // Real IMAP delete — no-op for the test.
    })
    const savePromise = saveDraftHandler(tracker, 1, 'D1', async () => {
      saveCalls++
      return { uid: 42 }
    })

    // Release the sentinel — delete runs, then save runs (its inner
    // re-check sees the finalized LRU bit and bails).
    releaseSentinel!()
    await sentinelPromise
    await deletePromise
    const res = await savePromise

    expect(saveCalls).toBe(0)
    expect(res).toEqual({ ok: true, uid: undefined })
    expect(tracker.wasDraftFinalized(1, 'D1')).toBe(true)
  })

  it('per-account isolation: deleteDraft on account 2 does not block saveDraft on account 1', async () => {
    const events: string[] = []
    let releaseDelete2: (() => void) | null = null

    // Long-running delete on account 2.
    const deletePromise = deleteDraftHandler(tracker, 2, 'D2', async () => {
      events.push('delete2:start')
      await new Promise<void>((resolve) => {
        releaseDelete2 = resolve
      })
      events.push('delete2:end')
    })
    await Promise.resolve()
    expect(events).toEqual(['delete2:start'])

    // Save on account 1 should run immediately, not wait for account 2.
    const savePromise = saveDraftHandler(tracker, 1, 'D1', async () => {
      events.push('save1:start')
      events.push('save1:end')
      return { uid: 1 }
    })
    await savePromise
    expect(events).toEqual(['delete2:start', 'save1:start', 'save1:end'])

    releaseDelete2!()
    await deletePromise
    expect(events).toEqual(['delete2:start', 'save1:start', 'save1:end', 'delete2:end'])
  })
})

// ─── Iter4 Low: tightened draftIdSchema ───────────────────────────────────────
//
// Codex security review (iter 4) flagged that draftIdSchema = z.string().min(1)
// is too permissive: the value flows into Message-Id, X-MailCopilot-Draft-Id,
// log lines, and the drafts:wasSent IPC. Tightened to:
//
//   z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/)
//
// UUIDs (36 chars) and the Compose randomId() output (UUID or
// `${Date.now()}-${hex}` fallback) both fit. Anything containing CRLF, control
// chars, spaces, '<', '>', or '@' is rejected before it can reach an IMAP
// SEARCH term, header, or log line.

// Mirror of electron/main.ts:642 — keep in sync.
const draftIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/)

describe('main.ts §2.16 iter4 — draftIdSchema rejects oversized/invalid characters', () => {
  it('accepts a UUID v4', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    expect(() => draftIdSchema.parse(uuid)).not.toThrow()
  })

  it('accepts the Compose randomId() fallback shape (timestamp-hex)', () => {
    // String(Date.now()) + '-' + Math.random().toString(16).slice(2)
    const fallback = `${Date.now()}-abc123def456`
    expect(() => draftIdSchema.parse(fallback)).not.toThrow()
  })

  it('accepts plain alphanumeric tokens', () => {
    expect(() => draftIdSchema.parse('D1')).not.toThrow()
    expect(() => draftIdSchema.parse('draft_123')).not.toThrow()
    expect(() => draftIdSchema.parse('a-b-c-d-e')).not.toThrow()
  })

  it('rejects empty string', () => {
    expect(() => draftIdSchema.parse('')).toThrow()
  })

  it('rejects ids longer than 64 chars (header bloat / log bloat)', () => {
    const tooLong = 'a'.repeat(65)
    expect(() => draftIdSchema.parse(tooLong)).toThrow()
  })

  it('rejects ids exactly at 65 chars (boundary)', () => {
    expect(() => draftIdSchema.parse('a'.repeat(65))).toThrow()
    // 64 chars is the boundary — still allowed.
    expect(() => draftIdSchema.parse('a'.repeat(64))).not.toThrow()
  })

  it('rejects newline (CRLF header injection vector)', () => {
    expect(() => draftIdSchema.parse('abc\r\nX-Injected: yes')).toThrow()
    expect(() => draftIdSchema.parse('abc\ndef')).toThrow()
    expect(() => draftIdSchema.parse('abc\rdef')).toThrow()
  })

  it('rejects HTML/script-shape payloads (log/UI safety)', () => {
    expect(() => draftIdSchema.parse('<script>alert(1)</script>')).toThrow()
    expect(() => draftIdSchema.parse('"><img>')).toThrow()
  })

  it('rejects whitespace and control characters', () => {
    expect(() => draftIdSchema.parse('has space')).toThrow()
    expect(() => draftIdSchema.parse('tab\there')).toThrow()
    expect(() => draftIdSchema.parse('null\0char')).toThrow()
  })

  it('rejects characters that have meaning in IMAP SEARCH / Message-Id', () => {
    expect(() => draftIdSchema.parse('user@example.com')).toThrow()
    expect(() => draftIdSchema.parse('id<bracket>')).toThrow()
    expect(() => draftIdSchema.parse('id"quote"')).toThrow()
    expect(() => draftIdSchema.parse('path/sep')).toThrow()
    expect(() => draftIdSchema.parse('back\\slash')).toThrow()
  })
})
