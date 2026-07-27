/**
 * Single-flight + short-cache wrapper for IPC calls from the renderer.
 *
 * Purpose: coalesce concurrent `window.api.invoke` calls with the same
 * (channel, key) pair into one actual IPC round-trip, and optionally serve
 * a short-lived cached result to follow-up callers that arrive within a
 * tight TTL window. This is the renderer-side answer to the cold-start IPC
 * stampede observed on 2026-04-23 where `ai:checkAuth` fires twice in
 * parallel from the AiPanel open-effect plus the `aiProvider` settle effect.
 *
 * Scope: per-renderer-process only. Each BrowserWindow runs its own module
 * instance, so cross-window dedup (e.g. Settings window + main window both
 * calling `ai:checkAuth` near-simultaneously) is NOT handled here — that
 * would require main-process coordination and is explicitly out of scope
 * for the renderer-only task §1.4 part 1.
 *
 * Invariants (CLAUDE.md §8):
 * - Telemetry never blocks: Sentry span usage is wrapped in try/catch.
 * - Wrapper never throws synchronously — failures propagate through the
 *   returned promise.
 * - User-initiated calls (`source: 'user'`) bypass the result cache but
 *   still JOIN an in-flight promise if one exists, so a user click cannot
 *   spawn a redundant IPC while a background request is already pending.
 * - Cache is invalidated on `settings:changed` broadcast (the real channel
 *   name in preload whitelist — `settings:save` is the invoke channel; the
 *   broadcast event emitted by main after save completes is `settings:changed`).
 */

import { startManualSpan } from '../sentry'

// Why 500ms: empirically covers the cold-start storm (AiPanel open-effect
// and aiProvider-settle effect can fire within ~tens of ms; StrictMode dev
// double-invoke fires synchronously). 500ms is short enough that stale data
// is not a UX concern for `ai:checkAuth` or `folder:refreshCounts`, but
// long enough to absorb the burst. Configurable per-channel via ttlMs.
const DEFAULT_CACHE_TTL_MS = 500

type IpcChannel = string

type SingleFlightOptions = {
  /** Cache TTL override for this channel (ms). Default 500. 0 disables caching. */
  ttlMs?: number
  /**
   * Explicit user-initiated call. Bypasses the result cache so a fresh
   * request is issued, but still joins any in-flight promise keyed the same
   * way (a user click should not double-fire against an already-pending call).
   */
  source?: 'user' | 'background'
}

type CacheEntry = {
  value: unknown
  expiresAt: number
}

type InflightEntry = Promise<unknown>

type Coalescer = {
  inflight: Map<string, InflightEntry>
  cache: Map<string, CacheEntry>
  dedupeCounter: number
  lastResetAt: number
  /**
   * Monotonic counter bumped on every {@link invalidateCache} call. Fresh-
   * invocation wrappers snapshot this value before awaiting IPC; if the
   * counter advances during the await, the result is considered stale and
   * is NOT written to cache (the waiter that owned the promise still
   * receives the value — IPC has no cancellation).
   *
   * Why this matters: before the generation guard, a background call could
   * start at t=0, the user could save settings at t=5ms (bumping the
   * broadcast and clearing the cache), and the stale IPC resolving at
   * t=20ms would repopulate the cache with pre-save data. Subsequent
   * callers would then be served stale auth state from the poisoned cache.
   */
  generation: number
}

/**
 * Module-scoped state. Exported for tests via the `__resetForTests` helper
 * only; consumers call `singleFlightInvoke`.
 */
const state: Coalescer = {
  inflight: new Map(),
  cache: new Map(),
  dedupeCounter: 0,
  lastResetAt: Date.now(),
  generation: 0,
}

/**
 * Stable key for the (channel, args) pair. Uses JSON.stringify — good enough
 * for primitive args (numbers, strings, flat objects). If a caller passes a
 * non-serializable argument (e.g. a Map with a function), JSON.stringify will
 * either throw or produce a lossy key; in that case we fall back to the
 * channel name alone, which still provides some dedup benefit and avoids a
 * crash. Rare in practice because IPC args are always structured-cloneable.
 */
function makeKey(channel: IpcChannel, args: unknown[]): string {
  try {
    return `${channel}::${JSON.stringify(args)}`
  } catch {
    return `${channel}::<unserializable>`
  }
}

/**
 * Get a cached value if it is still fresh. Prunes expired entries as a
 * side-effect (simple one-shot prune on read; no background interval).
 */
function readCache(key: string): { hit: boolean; value?: unknown } {
  const entry = state.cache.get(key)
  if (!entry) return { hit: false }
  if (entry.expiresAt <= Date.now()) {
    state.cache.delete(key)
    return { hit: false }
  }
  return { hit: true, value: entry.value }
}

/**
 * Increment the dedupe counter used by the Sentry cold-start span to attribute
 * coalesced calls. Wrapped so the span code path can read a consistent value
 * without mutating it itself.
 */
export function _recordDedupe(): void {
  state.dedupeCounter += 1
}

/** Read+reset the dedupe counter. Used by `renderer.cold_start_ipc` span. */
export function _readDedupeCounter(): number {
  return state.dedupeCounter
}

/**
 * Core entry point: run `window.api.invoke(channel, ...args)` with single-
 * flight coalescing and a short result cache.
 */
export async function singleFlightInvoke<T>(
  channel: IpcChannel,
  args: unknown[],
  options: SingleFlightOptions = {},
): Promise<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS
  const key = makeKey(channel, args)

  // Cache hit — only for background callers. User calls bypass the cache so
  // an explicit retry button or `Check again` UI actually re-runs the IPC.
  if (options.source !== 'user' && ttlMs > 0) {
    const cached = readCache(key)
    if (cached.hit) {
      _recordDedupe()
      return cached.value as T
    }
  }

  // In-flight join — both user and background callers share. A user click
  // while a background check is pending must NOT double-fire IPC; it joins.
  const existing = state.inflight.get(key)
  if (existing) {
    _recordDedupe()
    return existing as Promise<T>
  }

  // Fresh invocation. Build a promise that stores the result in cache on
  // resolve, always clears inflight, and rethrows on reject (so all joined
  // waiters see the same failure).
  // window.api.invoke has a strict InvokeChannel union type in electron-env.d.ts.
  // This wrapper is deliberately generic (any whitelisted channel), so we
  // widen through a local type alias rather than extending the global type.
  type InvokeFn = (channel: string, ...a: unknown[]) => Promise<unknown>
  const api = (typeof window !== 'undefined' ? window.api : undefined) as
    | { invoke?: InvokeFn }
    | undefined
  if (!api || typeof api.invoke !== 'function') {
    // Preserve existing contract: propagate via rejection, not sync throw.
    return Promise.reject(new Error('window.api.invoke is not available')) as Promise<T>
  }
  const invoke = api.invoke

  // Snapshot the generation counter BEFORE awaiting IPC. If the counter
  // advances mid-flight (e.g. settings:changed broadcast fires invalidateCache
  // while this IPC is pending), the result is considered stale and must NOT
  // be written to cache — otherwise the poisoned entry would serve pre-change
  // data to subsequent callers. Waiters already holding this promise still
  // resolve normally (IPC has no cancellation; rejecting them would be worse).
  const startGen = state.generation

  // Self-reference holder so the `finally` block can compare the current
  // inflight slot against THIS promise (guards against double-delete after
  // invalidateCache removed and a new fresh invocation claimed the key).
  const ref: { self?: Promise<unknown> } = {}

  const promise: Promise<T> = (async () => {
    try {
      const result = (await invoke(channel, ...args)) as T
      if (ttlMs > 0 && state.generation === startGen) {
        state.cache.set(key, {
          value: result,
          expiresAt: Date.now() + ttlMs,
        })
      }
      return result
    } finally {
      // Always clear inflight so a later call (post-TTL or user-forced) can
      // issue a new request. The `finally` runs after both resolve and
      // reject paths so rejected calls don't get stuck in the inflight map.
      // Guard: only delete the entry if it still points to THIS promise —
      // invalidateCache may have already removed and a new fresh invocation
      // may have claimed the slot while we were awaiting.
      if (ref.self !== undefined && state.inflight.get(key) === ref.self) {
        state.inflight.delete(key)
      }
    }
  })()

  ref.self = promise as Promise<unknown>
  state.inflight.set(key, ref.self)
  return promise
}

/**
 * Invalidate cached results AND pending inflight entries.
 *
 * Called automatically on `settings:changed` broadcast; also exposed for
 * manual invalidation from specific call sites (e.g. after `ai:saveApiKey`
 * where the next `ai:checkAuth` must see the new key).
 *
 * Three effects (all three are load-bearing):
 *   1. Bump {@link Coalescer.generation} — causes any fresh invocation
 *      currently awaiting IPC to skip the cache write on resolve, so a
 *      stale in-flight result cannot poison the cache for post-invalidation
 *      callers.
 *   2. Clear matching {@link Coalescer.cache} entries — the primary effect
 *      consumers rely on (`settings:changed` → next IPC is real).
 *   3. Clear matching {@link Coalescer.inflight} entries — so new callers
 *      arriving after the broadcast do NOT join the now-stale pending
 *      promise. Callers already holding a promise reference (joined before
 *      invalidate) still resolve with the old value (IPC has no
 *      cancellation; rejecting them would be worse than a brief window of
 *      stale data scoped to already-committed reads).
 *
 * When `channel` is omitted, all three effects apply globally.
 */
export function invalidateCache(channel?: IpcChannel): void {
  state.generation += 1
  if (!channel) {
    state.cache.clear()
    state.inflight.clear()
    return
  }
  const prefix = `${channel}::`
  for (const key of state.cache.keys()) {
    if (key.startsWith(prefix)) state.cache.delete(key)
  }
  for (const key of state.inflight.keys()) {
    if (key.startsWith(prefix)) state.inflight.delete(key)
  }
}

/** Wire up the `settings:changed` broadcast subscription exactly once. */
let _settingsSubscribed = false
function ensureSettingsSubscription(): void {
  if (_settingsSubscribed) return
  _settingsSubscribed = true
  try {
    const onFn = (window as { api?: { on?: (channel: string, cb: () => void) => void } }).api?.on
    if (typeof onFn !== 'function') return
    onFn('settings:changed', () => {
      // Conservative: wipe the entire cache on any settings change. Narrower
      // invalidation per-channel would require a channel->settingsKey mapping
      // that drifts; given cache TTL is 500ms, the cost of a full wipe is
      // at most one extra IPC per channel in the next user interaction.
      invalidateCache()
    })
  } catch {
    // Renderer may be in a test environment without `window.api.on` —
    // silently skip; tests invalidate manually via `invalidateCache`.
  }
}

// Auto-subscribe on module load when running in a real renderer with api.
// The window.api shape is declared in electron-env.d.ts as always present,
// but tests may `delete` it or define it partially — guard defensively.
if (typeof window !== 'undefined') {
  const maybeApi = (window as { api?: { on?: unknown } }).api
  if (maybeApi && typeof maybeApi.on === 'function') {
    ensureSettingsSubscription()
  }
}

/**
 * Cold-start IPC telemetry span. Started on first module import (renderer
 * side), ended ~12s later. Captures how many calls were coalesced during
 * the boot window so we can track regressions in the IPC stampede fix.
 *
 * Invariants:
 * - Never throws if Sentry is disabled or the SDK crashes.
 * - Window length 12s — long enough for first IDLE + first sync to complete
 *   on most accounts; short enough to bound span memory footprint.
 * - Runs once per renderer-process lifecycle (no re-entrancy).
 */
const COLD_START_SPAN_MS = 12_000
let _coldStartSpanStarted = false

export function startColdStartSpan(): void {
  if (_coldStartSpanStarted) return
  _coldStartSpanStarted = true
  // Use the manual-lifecycle span helper from src/sentry.ts. Critically NOT
  // `Sentry.startSpan`: that API ends the span the moment the sync callback
  // returns (see @sentry/core trace.js handleCallbackErrors), so attaching
  // attributes inside a `setTimeout` on an already-ended span is a no-op.
  // `startManualSpan` hands back a facade whose `.end()` we drive ourselves
  // from the timeout, keeping the span open for the full observation window.
  const handle = startManualSpan({
    name: 'renderer.cold_start_ipc',
    op: 'renderer.boot',
    attributes: { window_ms: COLD_START_SPAN_MS },
  })
  if (!handle) return // telemetry disabled / SDK unavailable
  const startedAt = Date.now()
  const baseline = state.dedupeCounter
  // setTimeout in test environments may fire on the microtask queue or be
  // faked; the facade is no-throw either way.
  ;(typeof window !== 'undefined' ? window : globalThis).setTimeout(() => {
    handle.setAttribute('calls_deduped', state.dedupeCounter - baseline)
    handle.setAttribute('duration_observed_ms', Date.now() - startedAt)
    handle.end()
  }, COLD_START_SPAN_MS)
}

// --- Test hooks ---

/**
 * Reset all module state. Test-only helper; not exported via the public
 * barrel. Tests that exercise concurrency guarantees must call this in
 * `beforeEach` to avoid leakage between cases.
 */
export function __resetForTests(): void {
  state.inflight.clear()
  state.cache.clear()
  state.dedupeCounter = 0
  state.lastResetAt = Date.now()
  state.generation = 0
  _coldStartSpanStarted = false
  _settingsSubscribed = false
}

export const __testables = {
  state,
  DEFAULT_CACHE_TTL_MS,
  COLD_START_SPAN_MS,
}
