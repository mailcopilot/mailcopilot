/**
 * The `accounts:remove` sequence (§2.165), extracted from `electron/main.ts` so
 * its ordering can be exercised with the real `deleteAccount` and the real
 * account-state service instead of being read off the source.
 *
 * ## Order, and why each step sits where it does
 *
 *  1. `fence.begin(id)` — FIRST and synchronous, before any `await`. Account ids
 *     were once re-issued ("max + 1"; they are monotonic now), and `deleteAccount` removes
 *     the account RECORD before the asynchronous secret cleanup. Anything keyed by the id
 *     must stop mentioning the old account before the record goes. Whatever must stop mentioning
 *     the old account (anything keyed by the id) is stopped here, while the
 *     record still exists.
 *  2. idle stop, then `deleteAccount`.
 *  3. Teardown only for an account that is actually gone, on resolve AND on a
 *     rejection after the record left (the store is asked, not the error text).
 *  4. `fence.end(id)` last, in a `finally`: the fence also ends when the
 *     deletion failed before the record left, so a surviving mailbox is usable.
 *
 * The rejection is always re-thrown: the deletion did not complete.
 */
export interface AccountRemovalDeps {
  stopIdle: () => Promise<void>
  deleteAccount: (id: number) => Promise<void>
  /** Has the account record left the store? Fail-closed: `false` when unknown. */
  recordIsGone: (id: number) => boolean
  /** Everything owed once the record is gone (generation bump, caches, ...). */
  teardown: (id: number) => void
  /** Reports a deletion that failed after the record was removed. Must not throw. */
  onPartialDelete: (id: number, err: unknown) => void
  /** Optional: whatever must stop mentioning the account before its record can go. */
  fence?: { begin: (id: number) => void; end: (id: number) => void }
}

export async function removeAccount(id: number, deps: AccountRemovalDeps): Promise<void> {
  deps.fence?.begin(id)
  try {
    try { await deps.stopIdle() } catch { /* ignore */ }
    try {
      await deps.deleteAccount(id)
    } catch (err) {
      if (deps.recordIsGone(id)) {
        deps.onPartialDelete(id, err)
        deps.teardown(id)
      }
      throw err
    }
    deps.teardown(id)
  } finally {
    deps.fence?.end(id)
  }
}
