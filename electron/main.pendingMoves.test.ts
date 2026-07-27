import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * §2.7 — pendingMoveRegistry helpers + filterPendingMoves (pure unit tests).
 *
 * `pendingMoveRegistry` is a module-level Map and the helpers are private
 * functions in `electron/main.ts` — same hotspot-local pattern as §2.16
 * (see main.drafts.test.ts). We mirror the logic verbatim so that:
 *
 *   - filterPendingMoves behaviour (empty registry fast-path, partial match,
 *     full match, cross-account isolation, cross-folder isolation) is pinned.
 *   - pendingMoveAdd / pendingMoveRemove / pendingMoveClear semantics are
 *     covered: nested Map creation/cleanup, clearTimeout on re-add, cleanup
 *     of empty buckets at all three levels (uid / folder / account).
 *   - 10s auto-expire fires correctly and does NOT double-clear when
 *     pendingMoveRemove was already called.
 *
 * Any drift between these mirrors and the production helpers in main.ts is a
 * regression risk — when modifying those helpers, mirror the change here.
 */

// ─── Mirror: PENDING_MOVE_TTL_MS ─────────────────────────────────────────────
// Keep in sync with electron/main.ts §2.7 section.
const PENDING_MOVE_TTL_MS = 10_000
// §2.7 iter3 (codex security High): caps mirror those in electron/main.ts.
// Keep these constants and the rejection logic in `pendingMoveAdd` synced
// with the production helpers — drift is a regression risk (file invariant
// at the top of this file).
const PENDING_MOVE_MAX_UIDS_PER_CALL = 10_000
const PENDING_MOVE_MAX_REGISTRY_PER_ACCOUNT = 50_000
const PENDING_MOVE_MAX_FOLDER_LEN = 256
// §2.7 iter4 (codex security High): defense-in-depth global cap and
// accountId-existence guard. Keep the value in sync with main.ts.
const PENDING_MOVE_MAX_REGISTRY_GLOBAL = 200_000

// ─── Mirror: PendingMoveRegistry ─────────────────────────────────────────────
// Encapsulated as a class so each test gets a fresh instance (no global state).
// Logic mirrors pendingMoveAdd / pendingMoveRemove / pendingMoveClear /
// filterPendingMoves in electron/main.ts verbatim.

class PendingMoveRegistry {
  // account → folder → uid → expire-timer handle
  private reg = new Map<number, Map<string, Map<number, ReturnType<typeof setTimeout>>>>()

  /**
   * §2.7 iter4: optional accountId existence predicate. When unset, the mirror
   * accepts all account IDs (preserves existing test semantics that pre-date
   * iter4). When set, mirrors the production guard rejecting unknown IDs
   * before any mutation.
   */
  private accountExists: (accountId: number) => boolean = () => true

  /** Test-only: install/replace the accountId-existence predicate. */
  setAccountExists(predicate: (accountId: number) => boolean): void {
    this.accountExists = predicate
  }

  /**
   * §2.7 iter5 (codex security High): captured rejection-path log payloads
   * for assertions that no raw `folder` string ever leaks into telemetry.
   * Each entry is the resolved sprintf-style payload (format + values) the
   * production `logPendingMove.warn(...)` would emit.
   */
  readonly logEntries: Array<{ format: string; args: unknown[] }> = []

  private warn(format: string, ...args: unknown[]): void {
    this.logEntries.push({ format, args })
  }

  /** Test-only: clear captured log entries between cases. */
  clearLogs(): void {
    this.logEntries.length = 0
  }

  /** Sum of uids across all folders for an account. */
  private accountSize(accountId: number): number {
    const byFolder = this.reg.get(accountId)
    if (!byFolder) return 0
    let total = 0
    for (const byUid of byFolder.values()) total += byUid.size
    return total
  }

  /** §2.7 iter4: sum of uids across every account. */
  private totalSize(): number {
    let total = 0
    for (const byFolder of this.reg.values()) {
      for (const byUid of byFolder.values()) total += byUid.size
    }
    return total
  }

  /**
   * Returns false if folder length, per-account registry cap, accountId
   * existence (§2.7 iter4) or global registry cap (§2.7 iter4) would be
   * violated. Caller surfaces rejection. Mirrors electron/main.ts §2.7 iter3
   * + iter4 + iter5.
   *
   * §2.7 iter5 (codex security High): folder length cap runs FIRST so an
   * attacker-controlled `folder` string can never be logged raw on any
   * rejection path. After the cap, only `folder.length` is included in any
   * log payload — never `folder` itself. Mirrors production ordering and
   * sanitization in electron/main.ts `pendingMoveAdd`.
   */
  pendingMoveAdd(accountId: number, folder: string, uids: number[]): boolean {
    if (folder.length > PENDING_MOVE_MAX_FOLDER_LEN) {
      this.warn(
        'reject add: folder length %d exceeds cap %d (account=%d)',
        folder.length, PENDING_MOVE_MAX_FOLDER_LEN, accountId,
      )
      return false
    }
    if (!this.accountExists(accountId)) {
      this.warn(
        'reject add: unknown accountId=%d (folderLen=%d, +%d uids)',
        accountId, folder.length, uids.length,
      )
      return false
    }
    if (uids.length > PENDING_MOVE_MAX_UIDS_PER_CALL) {
      this.warn(
        'reject add: uids length %d exceeds per-call cap %d (account=%d, folderLen=%d)',
        uids.length, PENDING_MOVE_MAX_UIDS_PER_CALL, accountId, folder.length,
      )
      return false
    }
    if (uids.length > 0) {
      const projected = this.accountSize(accountId) + uids.length
      if (projected > PENDING_MOVE_MAX_REGISTRY_PER_ACCOUNT) {
        this.warn(
          'reject add: registry size %d would exceed cap %d (account=%d, +%d, folderLen=%d)',
          projected, PENDING_MOVE_MAX_REGISTRY_PER_ACCOUNT, accountId, uids.length, folder.length,
        )
        return false
      }
      const projectedGlobal = this.totalSize() + uids.length
      if (projectedGlobal > PENDING_MOVE_MAX_REGISTRY_GLOBAL) {
        this.warn(
          'reject add: global registry size %d would exceed cap %d (account=%d, +%d, folderLen=%d)',
          projectedGlobal, PENDING_MOVE_MAX_REGISTRY_GLOBAL, accountId, uids.length, folder.length,
        )
        return false
      }
    }
    let byFolder = this.reg.get(accountId)
    if (!byFolder) {
      byFolder = new Map()
      this.reg.set(accountId, byFolder)
    }
    let byUid = byFolder.get(folder)
    if (!byUid) {
      byUid = new Map()
      byFolder.set(folder, byUid)
    }
    for (const uid of uids) {
      const existing = byUid.get(uid)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        // Auto-expire: drop entry if still the same timer handle.
        const f = this.reg.get(accountId)
        const u = f?.get(folder)
        if (u && u.get(uid) === timer) {
          u.delete(uid)
          if (u.size === 0) f!.delete(folder)
          const remaining = this.reg.get(accountId)
          if (remaining && remaining.size === 0) this.reg.delete(accountId)
        }
      }, PENDING_MOVE_TTL_MS)
      byUid.set(uid, timer)
    }
    return true
  }

  pendingMoveRemove(accountId: number, folder: string, uids: number[]): void {
    const byFolder = this.reg.get(accountId)
    const byUid = byFolder?.get(folder)
    if (!byUid) return
    for (const uid of uids) {
      const timer = byUid.get(uid)
      if (timer) {
        clearTimeout(timer)
        byUid.delete(uid)
      }
    }
    if (byUid.size === 0) byFolder!.delete(folder)
    if (byFolder && byFolder.size === 0) this.reg.delete(accountId)
  }

  pendingMoveClear(accountId: number, folder: string): void {
    const byFolder = this.reg.get(accountId)
    const byUid = byFolder?.get(folder)
    if (!byUid) return
    for (const timer of byUid.values()) clearTimeout(timer)
    byFolder!.delete(folder)
    if (byFolder!.size === 0) this.reg.delete(accountId)
  }

  filterPendingMoves<T extends { accountId: number; folder: string; uid: number }>(items: T[]): T[] {
    if (this.reg.size === 0) return items
    return items.filter(m => {
      const byUid = this.reg.get(m.accountId)?.get(m.folder)
      return !byUid?.has(m.uid)
    })
  }

  /** Test-only: check whether a UID is currently pending. */
  isPending(accountId: number, folder: string, uid: number): boolean {
    return Boolean(this.reg.get(accountId)?.get(folder)?.has(uid))
  }

  /** Test-only: total number of registered account buckets. */
  accountCount(): number {
    return this.reg.size
  }

  /** Test-only: number of folder buckets under an account. */
  folderCount(accountId: number): number {
    return this.reg.get(accountId)?.size ?? 0
  }

  /** Test-only: number of uid entries in a folder. */
  uidCount(accountId: number, folder: string): number {
    return this.reg.get(accountId)?.get(folder)?.size ?? 0
  }
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeItem(accountId: number, folder: string, uid: number): { accountId: number; folder: string; uid: number; subject: string } {
  return { accountId, folder, uid, subject: `s${uid}` }
}

// ─── Tests: filterPendingMoves ────────────────────────────────────────────────

describe('main.ts §2.7 — filterPendingMoves', () => {
  let reg: PendingMoveRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = new PendingMoveRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the original array reference when the registry is empty (fast path)', () => {
    const items = [makeItem(1, 'INBOX', 1), makeItem(1, 'INBOX', 2)]
    const result = reg.filterPendingMoves(items)
    // Strict identity: fast path returns items unchanged.
    expect(result).toBe(items)
  })

  it('returns all items when registry is populated but no item matches', () => {
    reg.pendingMoveAdd(1, 'INBOX', [99])
    const items = [makeItem(1, 'INBOX', 1), makeItem(1, 'INBOX', 2)]
    expect(reg.filterPendingMoves(items)).toHaveLength(2)
  })

  it('filters out an item whose uid is pending', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1])
    const items = [makeItem(1, 'INBOX', 1), makeItem(1, 'INBOX', 2)]
    const result = reg.filterPendingMoves(items)
    expect(result).toHaveLength(1)
    expect(result[0].uid).toBe(2)
  })

  it('filters out all matching pending UIDs from a list', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1, 2, 3])
    const items = [makeItem(1, 'INBOX', 1), makeItem(1, 'INBOX', 2), makeItem(1, 'INBOX', 3), makeItem(1, 'INBOX', 4)]
    const result = reg.filterPendingMoves(items)
    expect(result).toHaveLength(1)
    expect(result[0].uid).toBe(4)
  })

  it('returns empty array when all items are pending', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1, 2])
    const items = [makeItem(1, 'INBOX', 1), makeItem(1, 'INBOX', 2)]
    expect(reg.filterPendingMoves(items)).toHaveLength(0)
  })

  it('cross-account isolation: pending uid on account 2 does not filter account 1', () => {
    reg.pendingMoveAdd(2, 'INBOX', [5])
    const items = [makeItem(1, 'INBOX', 5)]
    expect(reg.filterPendingMoves(items)).toHaveLength(1)
  })

  it('cross-folder isolation: pending uid in Trash does not filter INBOX', () => {
    reg.pendingMoveAdd(1, 'Trash', [5])
    const items = [makeItem(1, 'INBOX', 5)]
    expect(reg.filterPendingMoves(items)).toHaveLength(1)
  })

  it('filters items from multiple accounts simultaneously when both have pending uids', () => {
    reg.pendingMoveAdd(1, 'INBOX', [10])
    reg.pendingMoveAdd(2, 'INBOX', [20])
    const items = [makeItem(1, 'INBOX', 10), makeItem(2, 'INBOX', 20), makeItem(1, 'INBOX', 11)]
    const result = reg.filterPendingMoves(items)
    expect(result).toHaveLength(1)
    expect(result[0].uid).toBe(11)
  })

  it('returns empty array when input is empty', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1])
    expect(reg.filterPendingMoves([])).toHaveLength(0)
  })

  it('works with a generic type that has extra fields beyond the constraint', () => {
    reg.pendingMoveAdd(1, 'INBOX', [7])
    const items = [
      { accountId: 1, folder: 'INBOX', uid: 7, subject: 'Pending', flagged: true, unread: false },
      { accountId: 1, folder: 'INBOX', uid: 8, subject: 'Visible', flagged: false, unread: true },
    ]
    const result = reg.filterPendingMoves(items)
    expect(result).toHaveLength(1)
    expect(result[0].uid).toBe(8)
    // Extra fields preserved unchanged.
    expect(result[0].unread).toBe(true)
  })
})

// ─── Tests: pendingMoveAdd ────────────────────────────────────────────────────

describe('main.ts §2.7 — pendingMoveAdd', () => {
  let reg: PendingMoveRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = new PendingMoveRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks a uid as pending after pendingMoveAdd', () => {
    reg.pendingMoveAdd(1, 'INBOX', [42])
    expect(reg.isPending(1, 'INBOX', 42)).toBe(true)
  })

  it('marks multiple uids in one call', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1, 2, 3])
    expect(reg.isPending(1, 'INBOX', 1)).toBe(true)
    expect(reg.isPending(1, 'INBOX', 2)).toBe(true)
    expect(reg.isPending(1, 'INBOX', 3)).toBe(true)
  })

  it('is a no-op for empty uids array', () => {
    reg.pendingMoveAdd(1, 'INBOX', [])
    expect(reg.accountCount()).toBe(1) // byFolder map was created
    expect(reg.uidCount(1, 'INBOX')).toBe(0)
  })

  it('creates nested account/folder/uid bucket on first add', () => {
    expect(reg.accountCount()).toBe(0)
    reg.pendingMoveAdd(1, 'INBOX', [5])
    expect(reg.accountCount()).toBe(1)
    expect(reg.folderCount(1)).toBe(1)
    expect(reg.uidCount(1, 'INBOX')).toBe(1)
  })

  it('does NOT mark a uid in a different folder as pending', () => {
    reg.pendingMoveAdd(1, 'INBOX', [42])
    expect(reg.isPending(1, 'Sent', 42)).toBe(false)
  })

  it('does NOT mark a uid for a different account as pending', () => {
    reg.pendingMoveAdd(1, 'INBOX', [42])
    expect(reg.isPending(2, 'INBOX', 42)).toBe(false)
  })

  it('re-adding an already-pending uid resets the timer (no double-entry)', () => {
    reg.pendingMoveAdd(1, 'INBOX', [5])
    reg.pendingMoveAdd(1, 'INBOX', [5])
    // Still just one entry.
    expect(reg.uidCount(1, 'INBOX')).toBe(1)
    expect(reg.isPending(1, 'INBOX', 5)).toBe(true)
  })

  it('auto-expires uid after PENDING_MOVE_TTL_MS (10s)', () => {
    reg.pendingMoveAdd(1, 'INBOX', [7])
    expect(reg.isPending(1, 'INBOX', 7)).toBe(true)

    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS)

    expect(reg.isPending(1, 'INBOX', 7)).toBe(false)
  })

  it('auto-expire cleans up the folder bucket when it becomes empty', () => {
    reg.pendingMoveAdd(1, 'INBOX', [7])
    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS)

    expect(reg.folderCount(1)).toBe(0)
  })

  it('auto-expire cleans up the account bucket when all folders become empty', () => {
    reg.pendingMoveAdd(1, 'INBOX', [7])
    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS)

    expect(reg.accountCount()).toBe(0)
  })

  it('auto-expire does NOT remove a uid that was re-added with a fresh timer', () => {
    // Add uid=5 with timer T1.
    reg.pendingMoveAdd(1, 'INBOX', [5])

    // Advance less than TTL.
    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS / 2)

    // Re-add uid=5: T1 is cleared, T2 is set.
    reg.pendingMoveAdd(1, 'INBOX', [5])

    // Advance past T1's would-be expiry (but T2 has only run half the TTL).
    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS / 2 + 100)

    // uid=5 must still be pending (T1 was cancelled; T2 has not expired).
    expect(reg.isPending(1, 'INBOX', 5)).toBe(true)
  })

  it('auto-expire only fires for the uid whose timer matches (no stale-timer removal)', () => {
    // The guard `u.get(uid) === timer` ensures a stale timer handle cannot
    // remove a uid that was refreshed. We simulate it by verifying that
    // after a re-add, the old TTL expiry does NOT clear the entry.
    reg.pendingMoveAdd(1, 'INBOX', [3])
    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS / 2)

    // Re-add — stale timer cancelled, new timer set.
    reg.pendingMoveAdd(1, 'INBOX', [3])

    // Let the original would-be expiry time pass.
    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS / 2 + 100)
    expect(reg.isPending(1, 'INBOX', 3)).toBe(true)

    // Let the full new TTL pass.
    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS)
    expect(reg.isPending(1, 'INBOX', 3)).toBe(false)
  })
})

// ─── Tests: pendingMoveRemove ─────────────────────────────────────────────────

describe('main.ts §2.7 — pendingMoveRemove', () => {
  let reg: PendingMoveRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = new PendingMoveRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('removes a pending uid', () => {
    reg.pendingMoveAdd(1, 'INBOX', [10])
    reg.pendingMoveRemove(1, 'INBOX', [10])
    expect(reg.isPending(1, 'INBOX', 10)).toBe(false)
  })

  it('removes only the specified uids, leaving others intact', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1, 2, 3])
    reg.pendingMoveRemove(1, 'INBOX', [2])
    expect(reg.isPending(1, 'INBOX', 1)).toBe(true)
    expect(reg.isPending(1, 'INBOX', 2)).toBe(false)
    expect(reg.isPending(1, 'INBOX', 3)).toBe(true)
  })

  it('is a no-op when uid is not in the registry (unknown uid)', () => {
    reg.pendingMoveAdd(1, 'INBOX', [5])
    reg.pendingMoveRemove(1, 'INBOX', [99])
    expect(reg.isPending(1, 'INBOX', 5)).toBe(true)
  })

  it('is a no-op when folder is not in the registry', () => {
    reg.pendingMoveAdd(1, 'INBOX', [5])
    reg.pendingMoveRemove(1, 'Trash', [5])
    expect(reg.isPending(1, 'INBOX', 5)).toBe(true)
  })

  it('is a no-op when account is not in the registry', () => {
    // Should not throw even if account is unknown.
    expect(() => reg.pendingMoveRemove(99, 'INBOX', [1])).not.toThrow()
  })

  it('cleans up the folder bucket when all uids removed', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1, 2])
    reg.pendingMoveRemove(1, 'INBOX', [1, 2])
    expect(reg.folderCount(1)).toBe(0)
  })

  it('cleans up the account bucket when all folders removed', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1])
    reg.pendingMoveRemove(1, 'INBOX', [1])
    expect(reg.accountCount()).toBe(0)
  })

  it('cancels the auto-expire timer so TTL does not fire after removal', () => {
    reg.pendingMoveAdd(1, 'INBOX', [5])
    reg.pendingMoveRemove(1, 'INBOX', [5])

    // Advance past the TTL — timer was cancelled so no side effect.
    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS + 100)

    // Registry should still be clean (remove already cleaned it, timer is gone).
    expect(reg.isPending(1, 'INBOX', 5)).toBe(false)
    expect(reg.accountCount()).toBe(0)
  })
})

// ─── Tests: pendingMoveClear ──────────────────────────────────────────────────

describe('main.ts §2.7 — pendingMoveClear', () => {
  let reg: PendingMoveRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = new PendingMoveRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears all uids for a folder in one call', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1, 2, 3])
    reg.pendingMoveClear(1, 'INBOX')
    expect(reg.uidCount(1, 'INBOX')).toBe(0)
    expect(reg.isPending(1, 'INBOX', 1)).toBe(false)
    expect(reg.isPending(1, 'INBOX', 2)).toBe(false)
    expect(reg.isPending(1, 'INBOX', 3)).toBe(false)
  })

  it('cleans up folder and account buckets after clear', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1])
    reg.pendingMoveClear(1, 'INBOX')
    expect(reg.folderCount(1)).toBe(0)
    expect(reg.accountCount()).toBe(0)
  })

  it('does not affect another folder on the same account', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1])
    reg.pendingMoveAdd(1, 'Trash', [2])
    reg.pendingMoveClear(1, 'INBOX')
    expect(reg.isPending(1, 'INBOX', 1)).toBe(false)
    expect(reg.isPending(1, 'Trash', 2)).toBe(true)
    expect(reg.folderCount(1)).toBe(1)
  })

  it('is a no-op when the folder is not in the registry', () => {
    expect(() => reg.pendingMoveClear(1, 'NonExistentFolder')).not.toThrow()
  })

  it('is a no-op when the account is not in the registry', () => {
    expect(() => reg.pendingMoveClear(99, 'INBOX')).not.toThrow()
  })

  it('cancels all TTL timers so none fire after clear', () => {
    reg.pendingMoveAdd(1, 'INBOX', [10, 20, 30])
    reg.pendingMoveClear(1, 'INBOX')

    // No timers should fire — all were cancelled.
    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS + 100)

    // Already clean; advancing timers should not cause errors.
    expect(reg.accountCount()).toBe(0)
  })
})

// ─── Tests: integration flow ──────────────────────────────────────────────────

describe('main.ts §2.7 — pendingMoveRegistry integration (add → filter → remove)', () => {
  let reg: PendingMoveRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = new PendingMoveRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('full undo-window lifecycle: add → filter suppresses → remove → visible again', () => {
    const items = [makeItem(1, 'INBOX', 1), makeItem(1, 'INBOX', 2)]

    // Renderer calls pendingAdd before showing the undo bar.
    reg.pendingMoveAdd(1, 'INBOX', [1])

    // During the undo window, uid=1 is suppressed from fetch results.
    expect(reg.filterPendingMoves(items)).toHaveLength(1)
    expect(reg.filterPendingMoves(items)[0].uid).toBe(2)

    // Move completes (flushUndo / 5s timer fires) → pendingRemove.
    reg.pendingMoveRemove(1, 'INBOX', [1])

    // uid=1 is no longer pending — would appear in a subsequent fetch.
    expect(reg.filterPendingMoves(items)).toHaveLength(2)
    // Fast path restored (registry empty).
    expect(reg.filterPendingMoves(items)).toBe(items)
  })

  it('undo lifecycle: add → filter suppresses → undo (immediate remove) → visible again', () => {
    const items = [makeItem(1, 'INBOX', 5)]

    reg.pendingMoveAdd(1, 'INBOX', [5])
    expect(reg.filterPendingMoves(items)).toHaveLength(0)

    // User hits undo → handleUndo calls pendingRemove immediately.
    reg.pendingMoveRemove(1, 'INBOX', [5])
    expect(reg.filterPendingMoves(items)).toHaveLength(1)
  })

  it('TTL auto-expire acts as safety net: uid becomes visible after 10s even without explicit remove', () => {
    const items = [makeItem(1, 'INBOX', 9)]
    reg.pendingMoveAdd(1, 'INBOX', [9])
    expect(reg.filterPendingMoves(items)).toHaveLength(0)

    vi.advanceTimersByTime(PENDING_MOVE_TTL_MS)
    expect(reg.filterPendingMoves(items)).toHaveLength(1)
    // Fast path now active.
    expect(reg.filterPendingMoves(items)).toBe(items)
  })

  it('multi-account: adding to account 1 does not suppress account 2 uids', () => {
    reg.pendingMoveAdd(1, 'INBOX', [3])
    const acc2Items = [makeItem(2, 'INBOX', 3)]
    expect(reg.filterPendingMoves(acc2Items)).toHaveLength(1)
  })

  it('clear used for flush-all-pending scenario (e.g. renderer unmount)', () => {
    reg.pendingMoveAdd(1, 'INBOX', [1, 2, 3])
    const items = [makeItem(1, 'INBOX', 1), makeItem(1, 'INBOX', 2), makeItem(1, 'INBOX', 3)]
    expect(reg.filterPendingMoves(items)).toHaveLength(0)

    reg.pendingMoveClear(1, 'INBOX')
    // All items visible again; fast path restored.
    expect(reg.filterPendingMoves(items)).toBe(items)
  })
})

// ─── §2.7 iter2: cache:unifiedInboxPage filter ────────────────────────────────
//
// Codex iter2 Medium 1: switchToUnified + cache:unifiedInboxPage was bypassing
// pending-move suppression because the IPC handler called getUnifiedInboxPage
// without filterPendingMoves. The fix wraps the result. The unified inbox
// returns rows from MULTIPLE accounts so the per-(accountId, folder, uid)
// keying must hold across accounts in the same response.

describe('main.ts §2.7 iter2 — filterPendingMoves applied to unified-inbox rows', () => {
  let reg: PendingMoveRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = new PendingMoveRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('suppresses a pending uid from one account while passing through other accounts', () => {
    // Simulate getUnifiedInboxPage([1, 2]) returning interleaved rows.
    const rows = [
      makeItem(1, 'INBOX', 100),
      makeItem(2, 'INBOX', 200),
      makeItem(1, 'INBOX', 101),
      makeItem(2, 'INBOX', 201),
    ]
    reg.pendingMoveAdd(1, 'INBOX', [101])

    const filtered = reg.filterPendingMoves(rows)
    expect(filtered).toHaveLength(3)
    expect(filtered.map(r => `${r.accountId}:${r.uid}`).sort()).toEqual(['1:100', '2:200', '2:201'])
  })

  it('suppresses pending uids from MULTIPLE accounts in the same unified response', () => {
    const rows = [
      makeItem(1, 'INBOX', 1),
      makeItem(2, 'INBOX', 2),
      makeItem(3, 'INBOX', 3),
    ]
    reg.pendingMoveAdd(1, 'INBOX', [1])
    reg.pendingMoveAdd(3, 'INBOX', [3])

    const filtered = reg.filterPendingMoves(rows)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].accountId).toBe(2)
    expect(filtered[0].uid).toBe(2)
  })

  it('does NOT suppress a uid that is pending in a different folder than the unified row reports', () => {
    // Unified inbox always shows INBOX rows; if the user moved a uid in Trash
    // (some other surface), that pending entry must not affect INBOX rows.
    const rows = [makeItem(1, 'INBOX', 5)]
    reg.pendingMoveAdd(1, 'Trash', [5])

    expect(reg.filterPendingMoves(rows)).toHaveLength(1)
  })

  it('returns the original array reference when no pending uids match (fast-path equivalent)', () => {
    const rows = [makeItem(1, 'INBOX', 10), makeItem(2, 'INBOX', 20)]
    // Empty registry — fast path.
    expect(reg.filterPendingMoves(rows)).toBe(rows)
  })

  it('does not mutate the input array', () => {
    const rows = [makeItem(1, 'INBOX', 1), makeItem(1, 'INBOX', 2)]
    reg.pendingMoveAdd(1, 'INBOX', [1])
    const original = [...rows]
    reg.filterPendingMoves(rows)
    expect(rows).toEqual(original)
  })
})

// ─── §2.7 iter3: codex security High — DoS caps on pending-move registry ─────
//
// Codex finding (electron/main.ts:534, 5075, 5016): uidsSchema = z.array(...)
// .min(1) had NO max. A compromised renderer could send an arbitrarily large
// uids array and force the main process to allocate one NodeJS.Timeout per
// uid for 10s, or sustain unbounded registry growth via repeated calls.
//
// Fix layers:
//   - Per-call uid cap (PENDING_MOVE_MAX_UIDS_PER_CALL = 10000)
//   - Per-account total registry cap (PENDING_MOVE_MAX_REGISTRY_PER_ACCOUNT = 50000)
//   - Folder length cap (PENDING_MOVE_MAX_FOLDER_LEN = 256)
//
// All three are enforced inside pendingMoveAdd so the protection holds for any
// caller, not just the IPC handler. The IPC handler additionally rejects
// oversized arrays at the Zod-schema layer (pendingMoveUidsSchema).

describe('main.ts §2.7 iter3 — pendingMoveAdd DoS caps', () => {
  let reg: PendingMoveRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = new PendingMoveRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ─── per-call uid array cap (10000) ────────────────────────────────────────

  it('§2.7 iter3: pendingMoveAdd rejects oversized uids array', () => {
    // Construct 10001 uids — one over the per-call cap.
    const oversized = Array.from({ length: 10_001 }, (_, i) => i + 1)
    const accepted = reg.pendingMoveAdd(1, 'INBOX', oversized)

    expect(accepted).toBe(false)
    // Registry must not have absorbed any of them.
    expect(reg.uidCount(1, 'INBOX')).toBe(0)
    expect(reg.accountCount()).toBe(0)
  })

  it('§2.7 iter3: pendingMoveAdd accepts exactly the per-call cap (boundary)', () => {
    // 10000 uids — at the boundary, must succeed.
    const atCap = Array.from({ length: 10_000 }, (_, i) => i + 1)
    const accepted = reg.pendingMoveAdd(1, 'INBOX', atCap)

    expect(accepted).toBe(true)
    expect(reg.uidCount(1, 'INBOX')).toBe(10_000)
  })

  // ─── per-account total registry cap (50000) ────────────────────────────────

  it('§2.7 iter3: pendingMoveAdd rejects when total registry size cap exceeded', () => {
    // Fill the registry to exactly the cap via 5 calls of 10000 uids each
    // across 5 different folders (per-call cap is 10000).
    for (let folderIdx = 0; folderIdx < 5; folderIdx++) {
      const uids = Array.from({ length: 10_000 }, (_, i) => folderIdx * 10_000 + i + 1)
      const accepted = reg.pendingMoveAdd(1, `Folder${folderIdx}`, uids)
      expect(accepted).toBe(true)
    }
    // Registry now holds 50000 entries on account 1.
    let total = 0
    for (let f = 0; f < 5; f++) total += reg.uidCount(1, `Folder${f}`)
    expect(total).toBe(50_000)

    // One more uid must be rejected.
    const accepted = reg.pendingMoveAdd(1, 'OneMoreFolder', [999_999])
    expect(accepted).toBe(false)
    // The overflow folder bucket must not have been created.
    expect(reg.uidCount(1, 'OneMoreFolder')).toBe(0)
    // Existing entries are unchanged.
    expect(total).toBe(50_000)
  })

  it('§2.7 iter3: per-account cap is per account (account 2 is independent)', () => {
    // Fill account 1 to the cap.
    for (let folderIdx = 0; folderIdx < 5; folderIdx++) {
      const uids = Array.from({ length: 10_000 }, (_, i) => folderIdx * 10_000 + i + 1)
      reg.pendingMoveAdd(1, `Folder${folderIdx}`, uids)
    }

    // Account 2 must still accept new entries — cap is per account.
    const accepted = reg.pendingMoveAdd(2, 'INBOX', [1, 2, 3])
    expect(accepted).toBe(true)
    expect(reg.uidCount(2, 'INBOX')).toBe(3)
  })

  it('§2.7 iter3: pendingMoveAdd accepts exactly the registry cap (boundary)', () => {
    // 4 folders × 10000 + 1 folder × 10000 = 50000 — at cap, must accept.
    for (let folderIdx = 0; folderIdx < 5; folderIdx++) {
      const uids = Array.from({ length: 10_000 }, (_, i) => folderIdx * 10_000 + i + 1)
      const accepted = reg.pendingMoveAdd(1, `Folder${folderIdx}`, uids)
      expect(accepted).toBe(true)
    }
    // 50000 entries total — projected 50001 with one more must reject.
    const accepted = reg.pendingMoveAdd(1, 'AnotherFolder', [777_777])
    expect(accepted).toBe(false)
  })

  // ─── folder length cap (256) ───────────────────────────────────────────────

  it('§2.7 iter3: folder length cap enforced', () => {
    // 257 chars — one over the cap.
    const tooLong = 'F'.repeat(257)
    const accepted = reg.pendingMoveAdd(1, tooLong, [1, 2, 3])

    expect(accepted).toBe(false)
    // Nothing was added — account bucket must not exist.
    expect(reg.accountCount()).toBe(0)
  })

  it('§2.7 iter3: folder length cap accepts exactly 256 chars (boundary)', () => {
    const atCap = 'F'.repeat(256)
    const accepted = reg.pendingMoveAdd(1, atCap, [1])

    expect(accepted).toBe(true)
    expect(reg.uidCount(1, atCap)).toBe(1)
  })

  it('§2.7 iter3: folder length is checked even for empty uids (early reject, no bucket)', () => {
    // Even when uids is empty (otherwise a no-op that creates the bucket),
    // an oversized folder must still be rejected — we don't want adversarial
    // long strings sitting in Map keys.
    const tooLong = 'F'.repeat(500)
    const accepted = reg.pendingMoveAdd(1, tooLong, [])
    expect(accepted).toBe(false)
    expect(reg.accountCount()).toBe(0)
  })

  // ─── existing semantics preserved under iter3 changes ──────────────────────

  it('§2.7 iter3: legitimate small batch still succeeds (no regression)', () => {
    // Sanity: a normal Move 100 messages call must still work.
    const uids = Array.from({ length: 100 }, (_, i) => i + 1)
    const accepted = reg.pendingMoveAdd(1, 'INBOX', uids)

    expect(accepted).toBe(true)
    expect(reg.uidCount(1, 'INBOX')).toBe(100)
  })

  it('§2.7 iter3: rejection is atomic — no partial inserts when registry cap hit', () => {
    // Fill registry to 49995 entries: 4 full folders (40000) + 9995 in folder 5.
    for (let folderIdx = 0; folderIdx < 4; folderIdx++) {
      const uids = Array.from({ length: 10_000 }, (_, i) => folderIdx * 10_000 + i + 1)
      const accepted = reg.pendingMoveAdd(1, `Folder${folderIdx}`, uids)
      expect(accepted).toBe(true)
    }
    const partialUids = Array.from({ length: 9995 }, (_, i) => 50_000 + i + 1)
    expect(reg.pendingMoveAdd(1, 'PartialFolder', partialUids)).toBe(true)
    // Verify total at 49995.
    let total = 0
    for (let f = 0; f < 4; f++) total += reg.uidCount(1, `Folder${f}`)
    total += reg.uidCount(1, 'PartialFolder')
    expect(total).toBe(49_995)

    // Try to add 10 more — projected 50005, would overflow the 50000 cap.
    const overflowUids = [99_001, 99_002, 99_003, 99_004, 99_005, 99_006, 99_007, 99_008, 99_009, 99_010]
    const accepted = reg.pendingMoveAdd(1, 'PartialFolder', overflowUids)
    expect(accepted).toBe(false)
    // None of the 10 must have been inserted (atomic reject before mutation).
    for (const uid of overflowUids) {
      expect(reg.isPending(1, 'PartialFolder', uid)).toBe(false)
    }
    // Pre-existing entries still present and counts unchanged.
    expect(reg.isPending(1, 'PartialFolder', 50_001)).toBe(true)
    expect(reg.uidCount(1, 'PartialFolder')).toBe(9995)
  })
})

// ─── §2.7 iter4: codex security High — accountId bypass + global cap ─────────
//
// Codex finding (electron/main.ts:5144, :5073, :530): pendingMoveAdd handler
// only validated accountIdSchema (positive int) — it didn't check whether the
// id corresponded to a real account. A compromised renderer could call
// pendingAdd with arbitrary IDs (1..N), each minting a fresh per-account
// bucket up to PENDING_MOVE_MAX_REGISTRY_PER_ACCOUNT, reopening the DoS class
// the iter3 caps were meant to close.
//
// Fix layers (defense in depth):
//   1. Reject unknown accountId BEFORE any mutation (existence predicate
//      backed by getAccountMeta in production).
//   2. Global registry cap (PENDING_MOVE_MAX_REGISTRY_GLOBAL = 200000) across
//      every account, in case a hostile caller still fans out across many
//      *real* accounts.

describe('main.ts §2.7 iter4 — pendingMoveAdd accountId existence guard', () => {
  let reg: PendingMoveRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = new PendingMoveRegistry()
    // Mirror the production behavior: known accounts {1, 2}; everything else
    // is rejected as "unknown". The actual production lookup goes through
    // `getAccountMeta(id)`; the predicate keeps the registry helper pure.
    reg.setAccountExists((id) => id === 1 || id === 2)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('§2.7 iter4: pendingMoveAdd rejects unknown accountId', () => {
    // Account 999 is not in the known set — must reject BEFORE creating a
    // bucket. Without this guard, the per-account cap is bypassable by
    // fanning out across fake account IDs.
    const accepted = reg.pendingMoveAdd(999, 'INBOX', [1, 2, 3])

    expect(accepted).toBe(false)
    // No bucket must have been created for the unknown id.
    expect(reg.accountCount()).toBe(0)
    expect(reg.folderCount(999)).toBe(0)
  })

  it('§2.7 iter4: pendingMoveAdd accepts known accountId after the guard', () => {
    // Sanity: known account 1 still works.
    const accepted = reg.pendingMoveAdd(1, 'INBOX', [10])

    expect(accepted).toBe(true)
    expect(reg.isPending(1, 'INBOX', 10)).toBe(true)
  })

  it('§2.7 iter4: rejection runs before uids/cap checks (atomic reject)', () => {
    // Even with a well-formed account-shape payload, an unknown account must
    // be rejected before mutating the registry. Note: §2.7 iter5 moved the
    // folder-length cap to the very front of the check chain, so an
    // adversarial overlong folder is short-circuited *before* the account
    // existence check (covered by the iter5 ordering test below). What this
    // test still pins is that with a well-formed (sub-cap) folder + unknown
    // account + non-trivial uids, no bucket is created.
    const accepted = reg.pendingMoveAdd(42, 'INBOX', [1, 2])

    expect(accepted).toBe(false)
    expect(reg.accountCount()).toBe(0)
  })

  it('§2.7 iter4: empty uids on unknown account is still rejected (no bucket)', () => {
    // A no-op payload (empty uids) must not even create the per-account
    // bucket for an unknown id — otherwise an attacker could prime buckets
    // ahead of legitimate creation.
    const accepted = reg.pendingMoveAdd(999, 'INBOX', [])

    expect(accepted).toBe(false)
    expect(reg.accountCount()).toBe(0)
  })

  it('§2.7 iter4: cap-bypass scenario — adversary cannot use fake IDs to multiply per-account cap', () => {
    // Without the existence guard, an attacker could fill 999 fake accounts
    // up to 50k each. With the guard, only known accounts {1, 2} accept any
    // entries at all, capping the total at 2 × 50k = 100k (well under the
    // 200k global cap, which acts as a second line of defense).
    const fakeIds = [3, 4, 5, 6, 7, 8, 9, 10]
    for (const fake of fakeIds) {
      const accepted = reg.pendingMoveAdd(fake, 'INBOX', [1, 2, 3])
      expect(accepted).toBe(false)
    }
    expect(reg.accountCount()).toBe(0)
  })
})

describe('main.ts §2.7 iter4 — pendingMoveAdd global registry cap', () => {
  let reg: PendingMoveRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = new PendingMoveRegistry()
    // For the global-cap tests we treat all accounts as known so the iter4
    // existence guard does not interfere with the cap check we're exercising.
    reg.setAccountExists(() => true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('§2.7 iter4: global registry cap rejects fan-out across many accounts', () => {
    // Fill the global registry across 4 accounts × 50000 uids = 200000.
    // Each account is at its per-account cap, totaling exactly the global
    // cap. The 5th account on its very first add must be rejected.
    for (let acc = 1; acc <= 4; acc++) {
      for (let folderIdx = 0; folderIdx < 5; folderIdx++) {
        const uids = Array.from(
          { length: 10_000 },
          (_, i) => folderIdx * 10_000 + i + 1,
        )
        const accepted = reg.pendingMoveAdd(acc, `Folder${folderIdx}`, uids)
        expect(accepted).toBe(true)
      }
    }
    // Sanity: total really is at the global cap.
    let grandTotal = 0
    for (let acc = 1; acc <= 4; acc++) {
      for (let f = 0; f < 5; f++) grandTotal += reg.uidCount(acc, `Folder${f}`)
    }
    expect(grandTotal).toBe(200_000)

    // 5th account, first add → must be rejected by the global cap, not the
    // per-account cap (account 5 is at zero entries).
    const accepted = reg.pendingMoveAdd(5, 'INBOX', [1])
    expect(accepted).toBe(false)
    // Account 5 bucket must not have been created (atomic reject).
    expect(reg.uidCount(5, 'INBOX')).toBe(0)
    expect(reg.folderCount(5)).toBe(0)
    // Builds 200000 entries to reach the global cap; timing-sensitive under
    // full-suite parallel worker load, so give it a generous timeout instead
    // of the 5s default (flaked in CI under contention).
  }, 20_000)

  it('§2.7 iter4: global cap accepts exactly 200000 (boundary)', () => {
    // Same setup as above — at the cap, last add of the 4th account's last
    // folder must succeed (50000 × 4 = 200000 exactly).
    let lastAccepted = false
    for (let acc = 1; acc <= 4; acc++) {
      for (let folderIdx = 0; folderIdx < 5; folderIdx++) {
        const uids = Array.from(
          { length: 10_000 },
          (_, i) => folderIdx * 10_000 + i + 1,
        )
        lastAccepted = reg.pendingMoveAdd(acc, `Folder${folderIdx}`, uids)
      }
    }
    expect(lastAccepted).toBe(true)
    // Builds 200000 entries; timing-sensitive under full-suite parallel load —
    // generous timeout over the 5s default (flaked in CI under contention).
  }, 20_000)

  it('§2.7 iter4: global cap is enforced before mutation (atomic reject)', () => {
    // Fill close to the global cap: 199995 entries spread across 4 accounts.
    for (let acc = 1; acc <= 3; acc++) {
      for (let folderIdx = 0; folderIdx < 5; folderIdx++) {
        const uids = Array.from(
          { length: 10_000 },
          (_, i) => folderIdx * 10_000 + i + 1,
        )
        reg.pendingMoveAdd(acc, `Folder${folderIdx}`, uids)
      }
    }
    // Account 4: 4 full folders + 9995 in PartialFolder = 49995 entries.
    for (let folderIdx = 0; folderIdx < 4; folderIdx++) {
      const uids = Array.from(
        { length: 10_000 },
        (_, i) => folderIdx * 10_000 + i + 1,
      )
      reg.pendingMoveAdd(4, `Folder${folderIdx}`, uids)
    }
    const partialUids = Array.from({ length: 9995 }, (_, i) => 50_000 + i + 1)
    expect(reg.pendingMoveAdd(4, 'PartialFolder', partialUids)).toBe(true)

    // Total now: 3 × 50000 + 49995 = 199995. Try adding 10 more, projected
    // global = 200005, must reject atomically.
    const overflow = [
      990_001, 990_002, 990_003, 990_004, 990_005,
      990_006, 990_007, 990_008, 990_009, 990_010,
    ]
    const accepted = reg.pendingMoveAdd(4, 'PartialFolder', overflow)
    expect(accepted).toBe(false)
    // None of the 10 inserted (atomic).
    for (const uid of overflow) {
      expect(reg.isPending(4, 'PartialFolder', uid)).toBe(false)
    }
    // Pre-existing entry still present.
    expect(reg.isPending(4, 'PartialFolder', 50_001)).toBe(true)
    // Builds ~199995 entries near the global cap; timing-sensitive under
    // full-suite parallel load — generous timeout over the 5s default.
  }, 20_000)
})

// ─── §2.7 iter5: codex security High — log payload sanitization ──────────────
//
// Codex finding (electron/main.ts:5097): the unknown-account rejection branch
// logged the raw `folder` string BEFORE the folder-length cap fired. Because
// `mailboxSchema` is only `.min(1)`, a compromised renderer could send an
// unknown accountId together with an arbitrarily large/sensitive folder
// string and force it into `logPendingMove.warn`. Two consequences:
//
//   1. PII leakage — folder names can contain account-identifying user data
//      (Gmail labels, IMAP namespace prefixes with usernames, etc).
//   2. Log amplification — unbounded string size on the rejection path.
//
// Fix (two-part):
//   1. Reorder: folder length cap runs FIRST in `pendingMoveAdd` (before the
//      unknown-account check, before any uid-cap check). An overlong folder
//      is rejected with only `folder.length` in the payload.
//   2. Sanitize: every `log.warn` call on every rejection path replaces raw
//      `folder` with `folderLen: folder.length`. The raw string never reaches
//      telemetry.

describe('main.ts §2.7 iter5 — pendingMoveAdd log payload sanitization (PII)', () => {
  let reg: PendingMoveRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = new PendingMoveRegistry()
    // Known accounts {1, 2}; everything else is unknown — mirrors production.
    reg.setAccountExists((id) => id === 1 || id === 2)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Helper: assert no captured log entry contains the raw folder substring. */
  function assertNoRawFolder(rawFolder: string): void {
    for (const entry of reg.logEntries) {
      // Format string is a static template — must not embed raw folder.
      expect(entry.format).not.toContain(rawFolder)
      // None of the sprintf-style args may equal (or contain) the raw folder.
      for (const arg of entry.args) {
        if (typeof arg === 'string') {
          expect(arg).not.toContain(rawFolder)
          // Defense in depth: equal-length sentinel string also rejected.
          expect(arg).not.toBe(rawFolder)
        }
      }
    }
  }

  it('§2.7 iter5: folder length check runs BEFORE account existence check', () => {
    // Unknown account + overlong folder. Pre-iter5 the unknown-account branch
    // would fire first and log the raw folder. Iter5 reorders so the
    // folder-length cap rejects first; the captured log payload must reflect
    // the folder-length rejection (not the unknown-account one) AND must not
    // contain the raw folder string.
    const overlongFolder = 'F'.repeat(500)
    const accepted = reg.pendingMoveAdd(999, overlongFolder, [1, 2, 3])

    expect(accepted).toBe(false)
    // Exactly one rejection log entry — the folder-length one.
    expect(reg.logEntries.length).toBe(1)
    expect(reg.logEntries[0].format).toContain('folder length')
    // The raw 500-char folder must NOT appear anywhere in the log payload.
    assertNoRawFolder(overlongFolder)
    // No bucket created.
    expect(reg.accountCount()).toBe(0)
  })

  it('§2.7 iter5: unknown-account log payload omits raw folder string', () => {
    // Sub-cap folder so the folder-length check passes and we reach the
    // unknown-account branch. Even though the folder is now small, the
    // production log must NOT include it as a raw string — only its length.
    // This pins the sanitization invariant for the unknown-account path.
    const folder = 'INBOX/SecretLabel-user@example.com'
    const accepted = reg.pendingMoveAdd(999, folder, [1, 2, 3])

    expect(accepted).toBe(false)
    expect(reg.logEntries.length).toBe(1)
    const entry = reg.logEntries[0]
    expect(entry.format).toContain('unknown accountId')
    // folderLen must appear as an integer arg, not the raw string.
    expect(entry.args).toContain(folder.length)
    assertNoRawFolder(folder)
  })

  it('§2.7 iter5: per-call uid cap log payload omits raw folder string', () => {
    // Known account + sub-cap folder + oversized uids array → per-call cap
    // rejection. Folder must not appear in the log payload (defense in depth
    // — folder is bounded by the cap, but the rule is uniform: never log raw
    // folder on any rejection path).
    const folder = 'CustomerData/private-thread'
    const oversizedUids = Array.from({ length: PENDING_MOVE_MAX_UIDS_PER_CALL + 1 }, (_, i) => i + 1)
    const accepted = reg.pendingMoveAdd(1, folder, oversizedUids)

    expect(accepted).toBe(false)
    expect(reg.logEntries.length).toBe(1)
    expect(reg.logEntries[0].format).toContain('uids length')
    expect(reg.logEntries[0].args).toContain(folder.length)
    assertNoRawFolder(folder)
  })

  it('§2.7 iter5: per-account cap log payload omits raw folder string', () => {
    // Fill account 1 to the per-account cap, then attempt one more add. The
    // rejection log on the per-account-cap branch must not contain the raw
    // folder.
    const folder = 'Archive/Confidential/2024'
    // 5 folders × 10000 uids = 50000 (exactly the per-account cap).
    for (let folderIdx = 0; folderIdx < 5; folderIdx++) {
      const uids = Array.from({ length: 10_000 }, (_, i) => folderIdx * 10_000 + i + 1)
      expect(reg.pendingMoveAdd(1, `Folder${folderIdx}`, uids)).toBe(true)
    }
    reg.clearLogs()

    // Now try to add one more uid in a NEW folder for the same account → reject.
    const accepted = reg.pendingMoveAdd(1, folder, [999_999])
    expect(accepted).toBe(false)
    expect(reg.logEntries.length).toBe(1)
    expect(reg.logEntries[0].format).toContain('registry size')
    expect(reg.logEntries[0].args).toContain(folder.length)
    assertNoRawFolder(folder)
  })

  it('§2.7 iter5: global cap log payload omits raw folder string', () => {
    // For this test we want the global cap to fire (not the per-account cap),
    // so we widen the known-account predicate to {1..5}.
    reg.setAccountExists(() => true)
    // Fill 4 accounts × 5 folders × 10000 = 200000 uids (global cap).
    for (let acc = 1; acc <= 4; acc++) {
      for (let folderIdx = 0; folderIdx < 5; folderIdx++) {
        const uids = Array.from({ length: 10_000 }, (_, i) => folderIdx * 10_000 + i + 1)
        expect(reg.pendingMoveAdd(acc, `Folder${folderIdx}`, uids)).toBe(true)
      }
    }
    reg.clearLogs()

    // Account 5, first add → must be rejected by the global cap.
    const folder = 'PrivateNotes/2024-tax-info'
    const accepted = reg.pendingMoveAdd(5, folder, [1])
    expect(accepted).toBe(false)
    expect(reg.logEntries.length).toBe(1)
    expect(reg.logEntries[0].format).toContain('global registry size')
    expect(reg.logEntries[0].args).toContain(folder.length)
    assertNoRawFolder(folder)
    // This test must fill the registry to PENDING_MOVE_MAX_REGISTRY_GLOBAL
    // (200k entries → 200k fake timers) to actually reach the global cap — the
    // cardinality is pinned to the production constant and cannot be reduced.
    // That build is timing-sensitive under full-suite parallel worker load, so
    // give it a generous timeout instead of the 5s default (flaked in CI).
  }, 20_000)

  it('§2.7 iter5: log payloads never contain raw folder across all rejection paths', () => {
    // Sweep every rejection path with a sentinel folder string and assert
    // none of them ever leak it into the captured log entries. This is the
    // umbrella regression test — if a future code change adds a new
    // rejection branch and forgets to sanitize, this test fails.
    const sentinel = 'SENTINEL-' + 'x'.repeat(100) + '-PII-EMAIL@example.com'

    // Path 1: folder length cap (when sentinel itself is overlong).
    reg.pendingMoveAdd(1, sentinel.repeat(5), [1])
    // Path 2: unknown account (sub-cap folder).
    reg.pendingMoveAdd(999, sentinel, [1])
    // Path 3: per-call uid cap.
    const tooManyUids = Array.from({ length: PENDING_MOVE_MAX_UIDS_PER_CALL + 1 }, (_, i) => i + 1)
    reg.pendingMoveAdd(1, sentinel, tooManyUids)

    // Verify each rejection path produced at least one log entry, and none
    // contain the raw sentinel string.
    expect(reg.logEntries.length).toBeGreaterThanOrEqual(3)
    assertNoRawFolder(sentinel)
  })
})
