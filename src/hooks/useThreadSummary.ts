import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ThreadSummary,
  ThreadSummaryGenerateRequest,
  ThreadSummaryMessageRef,
  ThreadSummaryRefusalReason,
  ThreadSummaryResult,
} from '@mailcopilot/types'
import { captureException } from '../sentry'

/**
 * useThreadSummary — B2 Thread AI Summary (renderer side).
 *
 * Owns the entire debounce / IPC / cache / refusal state machine for the
 * one-line summary strip shown above the stack-of-cards in ThreadView. The
 * component stays a thin renderer of this hook's output (CLAUDE.md §5 hotspot
 * policy: logic lives in hooks, ThreadView/App.tsx stay thin).
 *
 * Flow (single correct path over the shipped IPC contract):
 * - On thread open, when the account opted in AND the thread has ≥3 messages,
 *   debounce 300ms then call `ai:threadSummary:generate` with message REFS
 *   ONLY (folder + uid + optional messageId — never body text; main fetches
 *   bodies from the local cache). The generate handler is cache-or-generate:
 *   a cache hit returns `summary.cached === true` and resolves fast, so the
 *   renderer skips the spinner in that case; a miss shows the loading
 *   affordance while the provider runs.
 *
 *   We deliberately do NOT precompute a thread hash in the renderer to call
 *   `ai:threadSummary:get` first: the stable hash is derived from Message-IDs
 *   the way `computeThreadHash` does it in main, and duplicating that in the
 *   renderer would be a drift liability. `generate` already does the cache
 *   lookup internally, so a separate `get` round-trip buys nothing here.
 *
 * - Refusals are surfaced as structured state (never thrown): the discriminated
 *   `{ ok: false, reason }` result maps to a `refusal` value the component
 *   renders as a localized inline message. `too_short` / `opt_out` produce no
 *   visible strip (they are UI-gated anyway); `budget` / `no_provider` /
 *   `provider_error` render graceful inline copy.
 *
 * - The strip is gated OFF entirely (no IPC at all) when the account opt-in is
 *   false or the thread is shorter than the minimum. The main-side handler
 *   also enforces opt-in (`reason: 'opt_out'`), but gating here avoids a
 *   pointless IPC round-trip and keeps ambient/list-level processing out.
 */

/** Minimum messages before a thread is worth summarizing (matches main-side gate). */
export const THREAD_SUMMARY_MIN_MESSAGES = 3

/** Debounce before firing generate on thread open, per the brief. */
export const THREAD_SUMMARY_DEBOUNCE_MS = 300

/** Max refs the contract accepts per generate request. */
const THREAD_SUMMARY_MAX_REFS = 50

/**
 * Derive a cheap, stable signature of thread membership from the message refs.
 *
 * The effect keys on this (alongside `threadKey`) so that a change in the
 * thread's membership — a reply appended to the SAME open thread — re-triggers
 * the debounce+generate cycle, while unrelated re-renders that merely produce a
 * new array reference do NOT refetch (the derived string is identical). We use
 * the folder+uid pair (append-stable, unique per message) rather than the raw
 * array reference or the volatile `messageId` (which can be null before the
 * body is fetched).
 *
 * Encoding MUST be injective: two different capped ref sets must never
 * serialize to the same key, or a real membership change would be swallowed and
 * the summary would fail to regenerate (the exact bug this key exists to fix).
 * A naive `folder:uid` join with `,` separators is NOT injective — IMAP folder
 * names can legitimately contain `:` and `,`, so different ref lists can collide
 * on the same string. `JSON.stringify` of the `[folder, uid]` tuple array is
 * structurally framed (quotes + escaping), so distinct inputs always yield
 * distinct output, while identical membership yields an identical string.
 */
function membershipKey(messages: ThreadSummaryMessageInput[]): string {
  // Mirror the newest-50 cap used at request time so the signature reflects the
  // exact set of refs a generate would send (see toRefs).
  const capped = messages.slice(-THREAD_SUMMARY_MAX_REFS)
  return JSON.stringify(capped.map(m => [m.folder, m.uid]))
}

/**
 * The subset of a thread message the hook needs to build a `ThreadSummaryMessageRef`.
 * ThreadView passes its `MailSummary` items, which structurally satisfy this.
 */
export type ThreadSummaryMessageInput = {
  folder: string
  uid: number
  messageId?: string | null
}

export type ThreadSummaryStatus = 'idle' | 'loading' | 'ready' | 'refused'

export type UseThreadSummaryParams = {
  /** Account that owns the open thread. `null` when no thread is active. */
  accountId: number | null
  /**
   * Message refs of the actively-open thread, newest/oldest order irrelevant.
   * Pass an empty array (or fewer than the minimum) to keep the strip hidden.
   */
  messages: ThreadSummaryMessageInput[]
  /**
   * Per-account opt-in. When false the hook is inert: no IPC, no state churn.
   * Source of truth is `settings.aiThreadSummaryEnabled["<accountId>"]`, read
   * by the caller.
   */
  enabled: boolean
  /**
   * Stable key identifying the open thread (e.g. ThreadRow.key). Changing it
   * re-triggers the debounce+generate cycle. Kept separate from `messages` so
   * re-renders that produce a new array reference don't refetch.
   */
  threadKey: string | null
  /** Debounce override (tests). Defaults to {@link THREAD_SUMMARY_DEBOUNCE_MS}. */
  debounceMs?: number
  /**
   * Injectable generate runner (tests). Defaults to the real `window.api`
   * IPC bridge. Keeping it injectable makes the hook transport-agnostic.
   */
  generate?: (req: ThreadSummaryGenerateRequest) => Promise<ThreadSummaryResult>
}

export type UseThreadSummaryResult = {
  /** Whether the strip should render at all (opt-in ON and thread long enough). */
  active: boolean
  status: ThreadSummaryStatus
  /** The generated summary when `status === 'ready'`, else null. */
  summary: ThreadSummary | null
  /** Refusal reason when `status === 'refused'`, else null. */
  refusal: ThreadSummaryRefusalReason | null
  /**
   * Re-run generate for the current thread (used by the provider_error retry
   * affordance). No-op when the strip is inert.
   */
  retry: () => void
}

/** Default IPC runner — invokes the whitelisted `ai:threadSummary:generate` channel. */
async function defaultGenerate(req: ThreadSummaryGenerateRequest): Promise<ThreadSummaryResult> {
  return (await window.api.invoke('ai:threadSummary:generate', req)) as ThreadSummaryResult
}

/**
 * Map thread message inputs to the contract ref shape, capped at the max.
 *
 * Caps to the NEWEST 50 (`slice(-50)`), matching the main-side generate handler
 * (which also keeps the newest 50): for a summary the most recent messages
 * carry the current state of the conversation, so dropping the oldest overflow
 * is the useful policy. The two sides must agree or the renderer and main would
 * summarize different message sets for the same over-cap thread.
 */
function toRefs(messages: ThreadSummaryMessageInput[]): ThreadSummaryMessageRef[] {
  return messages.slice(-THREAD_SUMMARY_MAX_REFS).map(m => ({
    folder: m.folder,
    uid: m.uid,
    messageId: m.messageId ?? null,
  }))
}

export function useThreadSummary({
  accountId,
  messages,
  enabled,
  threadKey,
  debounceMs = THREAD_SUMMARY_DEBOUNCE_MS,
  generate = defaultGenerate,
}: UseThreadSummaryParams): UseThreadSummaryResult {
  const [status, setStatus] = useState<ThreadSummaryStatus>('idle')
  const [summary, setSummary] = useState<ThreadSummary | null>(null)
  const [refusal, setRefusal] = useState<ThreadSummaryRefusalReason | null>(null)

  // Keep the latest generate runner + messages reachable inside the async
  // timer callback without re-subscribing the effect on every render.
  const generateRef = useRef(generate)
  generateRef.current = generate
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // Monotonic request token so a stale in-flight generate (thread switched
  // mid-flight) cannot overwrite the current thread's state. The token is
  // bumped SYNCHRONOUSLY on effect cleanup / re-entry (thread identity or
  // membership change), NOT inside run(): the corrupting window is the NEW
  // thread's debounce period, during which run() has not fired yet, so a token
  // that only advances in run() would still equal the stale request's captured
  // token and let a late response for the superseded thread through. Bumping at
  // cleanup closes that window. run() captures the current value and drops any
  // response whose token no longer matches.
  const requestIdRef = useRef(0)
  // Bumped by retry() to force a re-run of the effect for the same thread.
  const [retryNonce, setRetryNonce] = useState(0)

  // Stable membership signature: changes when a message is appended to (or
  // removed from) the open thread, so a same-threadKey change in membership
  // re-triggers generate; unchanged across unrelated re-renders.
  const memberKey = membershipKey(messages)

  const active =
    enabled &&
    typeof accountId === 'number' &&
    !!threadKey &&
    messages.length >= THREAD_SUMMARY_MIN_MESSAGES

  const run = useCallback(async (accId: number, requestId: number) => {
    const refs = toRefs(messagesRef.current)
    if (refs.length < THREAD_SUMMARY_MIN_MESSAGES) return

    try {
      const result = await generateRef.current({ accountId: accId, messages: refs })
      // Discard if a newer thread superseded this request.
      if (requestId !== requestIdRef.current) return

      if (result.ok) {
        setSummary(result.summary)
        setRefusal(null)
        setStatus('ready')
        return
      }
      // Structured refusal — never a throw. `too_short` / `opt_out` are
      // UI-gated, so they leave the strip inert (idle) rather than showing
      // a message the user did not ask for.
      setSummary(null)
      if (result.reason === 'too_short' || result.reason === 'opt_out') {
        setRefusal(null)
        setStatus('idle')
      } else {
        setRefusal(result.reason)
        setStatus('refused')
      }
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      // The contract promises structured refusals, so a thrown error is an
      // unexpected transport failure. Degrade to the graceful provider_error
      // branch rather than surfacing a crash, and report for monitoring.
      captureException(err, { source: 'useThreadSummary.generate' })
      setSummary(null)
      setRefusal('provider_error')
      setStatus('refused')
    }
  }, [])

  useEffect(() => {
    // Capture the ref OBJECT (stable identity) into a local so the cleanup
    // reads the same counter without tripping react-hooks/exhaustive-deps on a
    // `.current` access in cleanup. requestIdRef is a plain monotonic token, not
    // a DOM node, so mutating it in cleanup is intentional.
    const tokenRef = requestIdRef
    // Invalidate any in-flight request from the previous thread/membership
    // SYNCHRONOUSLY on every (re-)entry. Capture the fresh token for this run
    // so a late response for the superseded request — even one that resolves
    // during THIS thread's debounce window — is dropped by run()'s guard.
    const requestId = ++tokenRef.current

    if (!active || typeof accountId !== 'number') {
      // Inert: reset to a clean idle state and drop any pending request.
      setStatus('idle')
      setSummary(null)
      setRefusal(null)
      return
    }

    let cancelled = false
    // Enter loading up front; a cache hit resolves fast enough that the
    // spinner is momentary, and the component only shows the loading
    // affordance while status === 'loading'.
    setStatus('loading')
    setRefusal(null)

    const timer = setTimeout(() => {
      if (cancelled) return
      void run(accountId, requestId)
    }, debounceMs)

    return () => {
      cancelled = true
      clearTimeout(timer)
      // Bump the token on cleanup so a response for this (now-superseded)
      // request is discarded even if it resolves during the next thread's
      // debounce window, before that thread's run() has fired.
      tokenRef.current++
    }
    // `messages` intentionally excluded — keying on the array reference would
    // refetch on unrelated re-renders. `threadKey` is the thread identity;
    // `memberKey` is a stable membership signature so an appended message in
    // the SAME open thread re-triggers generate. `messagesRef` supplies the
    // latest refs at fire time.
  }, [active, accountId, threadKey, memberKey, debounceMs, retryNonce, run])

  const retry = useCallback(() => {
    setRetryNonce(n => n + 1)
  }, [])

  return { active, status, summary, refusal, retry }
}
