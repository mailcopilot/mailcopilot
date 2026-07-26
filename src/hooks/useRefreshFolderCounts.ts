import { useCallback, useEffect, useRef } from 'react'

/**
 * Per-account debounced refresh of cached folder unread/total counts.
 *
 * Background (§1.4 cold-start IPC stampede, renderer side):
 * On cold start, `folder:refreshCounts` is called for each account from
 * three sequential control-flow paths in App.tsx:
 *   1. init loop (apply DB counts to cached mailboxes for instant badges)
 *   2. post-IMAP header sync per account (refresh counters after IDLE primes)
 *   3. `mail:exists` IDLE handler (600ms debounced, fires on INBOX EXISTS bump)
 * All three are legitimate individually — none is a render-loop bug — but
 * their combined cold-start storm hammers better-sqlite3 inside the main
 * event loop and contributes to the 20s freeze observed 2026-04-23. A
 * per-account debounce coalesces these into one effective call per account
 * within the boot window.
 *
 * Design choices (see brief §1.4 part 1):
 * - `Map<accountId, Timer>` — coalescing key matches the identity of the
 *   resource (an IMAP account); fault isolation (one slow account can't
 *   delay another); mirrors `outlookOAuthService.ts:75` inflight-dedup.
 * - `source: 'user'` skips the debounce — explicit user actions (pull-to-
 *   refresh, folder-switch) must feel immediate; the debounce only exists
 *   to absorb automated back-to-back fires.
 * - Cleanup on unmount clears all pending timers so a rapid remount cannot
 *   resurrect stale refreshes.
 */

// Why 500ms: matches the ipcSingleFlight default TTL and covers the cold-
// start storm (three sequential call sites fire within ~1-2s on a warm
// machine and longer on cold boot; 500ms absorbs the burst without making
// a manual folder-list refresh feel sluggish).
const REFRESH_COUNTS_DEBOUNCE_MS = 500

export type RefreshCountsSource = 'user' | 'background'

export type RefreshCountsRunner = (accountId: number) => Promise<void>

export type RefreshFolderCountsApi = {
  /**
   * Schedule (or coalesce) a refresh for the given account.
   * - `source: 'background'` (default) — debounced; concurrent calls within
   *   the window are merged and fire once at the tail.
   * - `source: 'user'` — bypasses the debounce and runs immediately.
   */
  schedule: (accountId: number, source?: RefreshCountsSource) => void
  /** Fire immediately without scheduling. Used by call sites that already
   * serialize themselves (e.g. awaited inside `syncFolder`). */
  runNow: (accountId: number) => Promise<void>
  /** Drop any pending timer for `accountId`. */
  cancel: (accountId: number) => void
}

/**
 * Hook that returns a stable API for refreshing folder counts per account.
 * Pass the actual IPC runner from the owning component — keeping the hook
 * transport-agnostic makes testing trivial without window.api mocks.
 */
export function useRefreshFolderCounts(
  runner: RefreshCountsRunner,
  options: { debounceMs?: number; onSuppressed?: () => void } = {},
): RefreshFolderCountsApi {
  const debounceMs = options.debounceMs ?? REFRESH_COUNTS_DEBOUNCE_MS
  // Timers keyed by accountId — per-account isolation is intentional.
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  // Keep the latest runner accessible inside the setTimeout callback without
  // re-subscribing on every render.
  const runnerRef = useRef(runner)
  runnerRef.current = runner
  const onSuppressedRef = useRef(options.onSuppressed)
  onSuppressedRef.current = options.onSuppressed

  const runNow = useCallback(async (accountId: number) => {
    // Cancel any pending debounced run so we don't double-fire.
    const pending = timersRef.current.get(accountId)
    if (pending) {
      clearTimeout(pending)
      timersRef.current.delete(accountId)
    }
    await runnerRef.current(accountId)
  }, [])

  const schedule = useCallback(
    (accountId: number, source: RefreshCountsSource = 'background') => {
      if (source === 'user') {
        // User action — bypass debounce entirely.
        void runNow(accountId)
        return
      }
      const existing = timersRef.current.get(accountId)
      if (existing) {
        // A timer is already pending for this account; a second background
        // request arrived inside the window — count it as suppressed and
        // extend the timer (trailing edge).
        clearTimeout(existing)
        try {
          onSuppressedRef.current?.()
        } catch {
          /* telemetry must never throw */
        }
      }
      const timer = setTimeout(() => {
        timersRef.current.delete(accountId)
        void runnerRef.current(accountId).catch(() => {
          /* individual account failures are logged by the runner itself */
        })
      }, debounceMs)
      timersRef.current.set(accountId, timer)
    },
    [debounceMs, runNow],
  )

  const cancel = useCallback((accountId: number) => {
    const pending = timersRef.current.get(accountId)
    if (pending) {
      clearTimeout(pending)
      timersRef.current.delete(accountId)
    }
  }, [])

  // Cleanup on unmount — clear every pending timer. Must capture the ref's
  // current value inside the effect body because `timersRef.current` may
  // be reassigned by React's concurrent features in edge cases.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  return { schedule, runNow, cancel }
}

export const REFRESH_COUNTS_DEBOUNCE_MS_EXPORT = REFRESH_COUNTS_DEBOUNCE_MS
