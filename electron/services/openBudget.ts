/**
 * The budget of one user-visible message open (§2.308).
 *
 * `imapflow` has no real abort, so a fetch that stalls (TCP connects, TLS never
 * answers) can not be cancelled from outside. The open handler therefore races
 * the fetch against this budget: when it expires the handler answers from the
 * cache (`offlineFallback`) instead of leaving the renderer waiting, and the
 * abort signal short-circuits the fetch at its next logical boundary. One value,
 * one source: tests shrink the wait by passing `timeoutMs`, never by adding a
 * second timer.
 */
export const IMAP_FETCH_TIMEOUT_MS = 10_000

export type OpenBudgetOutcome<T> = { kind: 'ok'; value: T } | { kind: 'timeout' }

/**
 * Run `start` and settle with its result, or with `{ kind: 'timeout' }` once
 * `timeoutMs` has passed — whichever comes first. A slow `start` may still
 * complete in the background; its late result and its late `AbortError` are
 * swallowed. Any other failure of `start` propagates if it arrives before the
 * budget expires; one that arrives later is discarded by the already settled
 * race (the IMAP retry boundary still sees and reports it on its own).
 */
export async function raceWithOpenBudget<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = IMAP_FETCH_TIMEOUT_MS,
): Promise<OpenBudgetOutcome<T>> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<OpenBudgetOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      try { ac.abort() } catch { /* ignore */ }
      resolve({ kind: 'timeout' })
    }, timeoutMs)
    // unref: a pending open budget must not keep the process alive on its own.
    if (timer && typeof timer === 'object' && 'unref' in timer) {
      try { (timer as { unref?: () => void }).unref?.() } catch { /* ignore */ }
    }
  })
  try {
    const work = start(ac.signal)
      .then((value): OpenBudgetOutcome<T> => ({ kind: 'ok', value }))
      .catch((err): OpenBudgetOutcome<T> => {
        // If the abort fired between awaits, the fetch throws AbortError after
        // the race winner was already decided — swallow it so it does not
        // bubble as unhandled.
        if (err instanceof Error && err.name === 'AbortError') return { kind: 'timeout' }
        throw err
      })
    return await Promise.race([work, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
