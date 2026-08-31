import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * Trailing-edge debounce with ONE timer PER KEY.
 *
 * Why this exists: a single shared timer silently turns a burst of events
 * about DIFFERENT subjects into one event about the last subject. That is the
 * `mail:exists` defect in `src/App.tsx` — the main process emits one event per
 * affected (account, folder) pair in a single synchronous loop (an assistant
 * bulk action across four mailboxes emits ~8 events in one tick), and a single
 * `idleRefreshTimer` had every event clear its predecessor, so exactly one
 * mailbox got its counters refreshed and the rest kept stale badges until the
 * next restart.
 *
 * Debouncing is still wanted — the events do arrive in bursts and each one
 * costs an IMAP-less list fetch plus a SQLite counter read. What must not be
 * shared is the timer: coalescing may only merge events that speak about the
 * same subject. Choosing the key is the caller's job, and it is the whole
 * point of the hook, so it is a required argument with no default.
 *
 * Same shape as `useRefreshFolderCounts` (`Map<key, Timer>`, self-deleting
 * entries, clear-all on unmount); kept separate because that hook owns the
 * per-account IPC coalescing one layer down, while this one absorbs the raw
 * event burst one layer up. The two compose: several folders of one account
 * schedule several timers here and still produce a single
 * `folder:refreshCounts` call there.
 */
export type KeyedDebounceApi = {
  /**
   * Run `fn` after `delayMs` of quiet for THIS key. A second call with the
   * same key before it fires replaces the pending callback and restarts the
   * timer; calls with other keys are untouched.
   */
  schedule: (key: string, fn: () => void) => void
  /** Drop the pending timer for one key (no callback runs). */
  cancel: (key: string) => void
  /** Drop every pending timer. Also runs on unmount. */
  clearAll: () => void
}

export function useKeyedDebounce(delayMs: number): KeyedDebounceApi {
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // A ref, not the prop, so `schedule` can stay referentially stable across a
  // delay change (see the useMemo note below — a new API object would cancel
  // every pending timer). The delay is read at SCHEDULING time: a timer
  // already in flight keeps the delay it was armed with, and only the next
  // schedule() picks up the new value. Re-arming live timers on a prop change
  // is not wanted here — the prop is a constant at every call site today.
  const delayRef = useRef(delayMs)
  delayRef.current = delayMs

  const cancel = useCallback((key: string) => {
    const pending = timersRef.current.get(key)
    if (pending === undefined) return
    clearTimeout(pending)
    timersRef.current.delete(key)
  }, [])

  const clearAll = useCallback(() => {
    for (const t of timersRef.current.values()) clearTimeout(t)
    timersRef.current.clear()
  }, [])

  const schedule = useCallback((key: string, fn: () => void) => {
    const pending = timersRef.current.get(key)
    if (pending !== undefined) clearTimeout(pending)
    const timer = setTimeout(() => {
      // Delete BEFORE running: the callback may schedule the same key again
      // (a refresh that discovers more work), and deleting afterwards would
      // drop that fresh timer from the map and leak it past clearAll().
      timersRef.current.delete(key)
      fn()
    }, delayRef.current)
    timersRef.current.set(key, timer)
  }, [])

  // Capture the map inside the effect body — `timersRef.current` may be a
  // different object by the time the cleanup runs.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  // Referentially stable: callers list the API in effect dependency arrays,
  // and a fresh object every render would re-run those effects — including
  // their cleanup, which calls `clearAll()`. That would cancel every pending
  // timer on each render and quietly restore the "burst collapses" behaviour
  // this hook exists to prevent.
  return useMemo(() => ({ schedule, cancel, clearAll }), [schedule, cancel, clearAll])
}
