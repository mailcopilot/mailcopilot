/**
 * Chat answers and the local search index (§3.3 B3).
 *
 * `search_emails` reads the local cache. A message whose body is not indexed
 * cannot be found by a body search, and a folder that was only crawled
 * "recently" has older mail missing altogether, so an empty or short result is
 * not proof that a message does not exist. When a request ran a mail search and
 * the index of a searched mailbox is incomplete, the panel says so under the
 * answer, in one line, as a separate event AFTER the answer. The count runs
 * beside the model's work and is never waited for.
 *
 * The figures are the search worker's coverage statistics (the same ones the
 * search bar shows). This module only turns them into a yes/no. Counters only:
 * no folder names, no ids, no mail content. A statistic that cannot be read
 * produces NO note: absence of the line never claims the index is complete, it
 * just says nothing, as before this signal existed.
 */

/** The slice of the worker's coverage statistics this module reads (`SearchCoverageStats`). */
export interface CoverageStatsView {
  totalMessages: number
  bodyIndexed: number
  folderCoverage: { total: number; coveredFull: number }
}

export type CoverageReader = (accountIds: number[]) => Promise<CoverageStatsView>

/** How long a count may run before it is given up (it never delays the answer). */
export const COVERAGE_WAIT_MS = 2000

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0)

let reader: CoverageReader | null = null
/** Registered from `main.ts`, where the search worker lives. */
export function setIndexCoverageReader(read: CoverageReader | null): void { reader = read }

/** `true` when the statistics show an incomplete index; `false` when they show a complete one or are unusable. */
export function isIndexIncomplete(stats: CoverageStatsView | null | undefined): boolean {
  if (!stats || typeof stats !== 'object' || !stats.folderCoverage || typeof stats.folderCoverage !== 'object') return false
  const messages = count(stats.totalMessages)
  const bodiesIndexed = Math.min(count(stats.bodyIndexed), messages)
  const folders = count(stats.folderCoverage.total)
  const foldersComplete = Math.min(count(stats.folderCoverage.coveredFull), folders)
  return bodiesIndexed < messages || foldersComplete < folders
}

const bareName = (toolName: string): string => toolName.replace(/^mcp__mailcopilot__/, '')

/** The figures for `accountIds`, or `null` when they could not be read in time. Never throws. */
async function readWithDeadline(accountIds: number[], signal: AbortSignal, waitMs: number): Promise<CoverageStatsView | null> {
  const read = reader
  if (!read || accountIds.length === 0 || signal.aborted) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      read(accountIds),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), waitMs)
        timer.unref?.()
        onAbort = () => resolve(null)
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One probe per request. The count starts the moment a mail search tool has
 * finished, runs beside the model's next step, and is NEVER awaited: the answer
 * does not wait for it by a millisecond. `incompleteNow()` is a synchronous
 * read of what has settled so far; a count that has not finished (or failed, or
 * timed out) is simply absent, which shows no note.
 */
export function createIndexProbe(signal: AbortSignal, waitMs: number = COVERAGE_WAIT_MS) {
  const named = new Set<number>()
  const started = new Set<number>()
  let incomplete = false
  return {
    /** The model called a tool: remember which mailbox a search names. */
    noteCall(toolName: string, input: unknown): void {
      if (bareName(toolName) !== 'search_emails') return
      const id = input && typeof input === 'object' ? (input as { accountId?: unknown }).accountId : undefined
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) named.add(id)
    },
    /** A tool finished: when it was a search, start counting for mailboxes not counted yet. */
    noteResult(toolName: string): void {
      if (bareName(toolName) !== 'search_emails') return
      const ids = [...named].filter(id => !started.has(id))
      if (ids.length === 0) return
      for (const id of ids) started.add(id)
      void readWithDeadline(ids, signal, waitMs).then(stats => { if (isIndexIncomplete(stats)) incomplete = true })
    },
    incompleteNow(): boolean { return incomplete },
  }
}
