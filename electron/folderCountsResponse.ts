/**
 * Builds the `folder:refreshCounts` reply: cached unread/total per folder,
 * plus an EXPLICIT zero for every folder the local cache is authoritative
 * about but currently holds no rows for.
 *
 * WHY AN EXPLICIT ZERO IS NEEDED
 * ------------------------------
 * `listFolderStats` is a `GROUP BY folder_path` over `messages`. A folder with
 * no rows produces no group, so it is simply ABSENT from the result. The
 * renderer merges the reply into its cached mailbox list as
 *
 *     const c = counts[f.path]; return c ? { ...f, unread: c.unread } : f
 *
 * i.e. it reads "key absent" as "no news about this folder" and keeps the
 * previous badge. That reading is right for a folder we never synced and wrong
 * for a folder whose last message just left: the badge freezes at the last
 * non-zero number. It is reachable whenever the last local row of a folder
 * disappears — the observed case is the assistant bulk-archiving an entire
 * INBOX (list shows "Inbox Zero", folder and account badges keep showing 7
 * until a restart re-reads the server counts). The manual UI paths hid the
 * same hole behind their compensating optimistic delta
 * (`bumpFolderUnreadPending(-unread)`); the assistant path issues no delta, so
 * nothing cancelled the frozen number.
 *
 * The fix is for the main process to say explicitly WHICH folders it is
 * answering about, instead of letting "row exists" decide it by accident.
 *
 * WHY NOT "ABSENT KEY MEANS ZERO" IN THE RENDERER
 * ----------------------------------------------
 * Because absence is genuinely ambiguous. A folder with
 * `headerSyncMode: 'on_open'` that the user has never opened also has zero
 * local rows, and today its badge honestly shows the SERVER number obtained
 * from `LIST-STATUS` when the mailbox list was fetched. Blind zeroing would
 * wipe the badges of every folder the user deliberately included in badges but
 * never synced. Only the main process knows the difference, so only the main
 * process may collapse it.
 *
 * WHAT MAKES THE CACHE AUTHORITATIVE — `covered_full` AND NOTHING ELSE
 * -------------------------------------------------------------------
 * The claim being made is narrow and absolute: "this folder has no unread mail
 * at all". Only a crawl that reached the BOTTOM of the folder can back it.
 * `covered_full` is that status.
 *
 * `covered_recent` is deliberately excluded, even though it also means "a
 * crawl pass finished". It means a PARTIAL, RESUMABLE pass: main.ts resumes
 * such a folder from `watermarkUid` downwards on the next full sync
 * (`resumingPartialCrawl`), precisely because older messages have not been
 * looked at yet. So a `covered_recent` folder can simultaneously hold zero
 * local rows and carry unread mail on the server below the covered range —
 * and this helper would be asserting a zero it has no way of knowing. That is
 * exactly the class of defect this whole change set exists to remove, so it
 * must not be reintroduced inside the fix.
 *
 * KNOWN COST OF THAT NARROWING (accepted, and the reason §2.272 exists)
 * --------------------------------------------------------------------
 * A `covered_recent` folder whose local rows all disappear goes back to the
 * sticky badge: the key stays absent, the renderer keeps the previous number
 * until the next successful full crawl or a restart. The original symptom is
 * therefore fixed more narrowly than it first appeared. This is the honest
 * trade: a stale number is recoverable and visibly "old", a confidently wrong
 * zero is neither. The real answer is server reconciliation (a fresh
 * `STATUS (UNSEEN)` after a mutation), tracked as §2.272 — not widening the
 * set of statuses we are willing to speak for.
 *
 * Also NOT authoritative:
 *  - no `folder_crawl_state` row at all, and `'not_started'` — never crawled;
 *    this is the `on_open`-never-opened folder above.
 *  - `'crawling'` — a FIRST pass is in flight (a re-sync of an already covered
 *    folder keeps its covered status, main.ts only writes `'crawling'` when
 *    `!isCovered`), so the cache is mid-fill and an empty cache means
 *    "nothing fetched yet", not "nothing there".
 *  - `'error'` — the last pass failed and overwrote whatever status preceded
 *    it. Losing authority here costs us a stale badge until the next
 *    successful sync, which is the safe direction to fail.
 *
 * Note this reply intentionally does NOT ask the server for a fresh
 * `STATUS (UNSEEN)` after a mutation — that is the separate reconciliation
 * work tracked as §2.272. This module only stops the renderer from mistaking
 * "the cache says zero" for "the cache said nothing".
 */

export type FolderCountsInput = {
  /**
   * The account the reply speaks for. Folder paths are only unique WITHIN an
   * account ('INBOX' exists in every mailbox), and the reply is keyed by path
   * alone, so crawl states of other accounts are filtered out here rather than
   * left to the caller — a same-named covered folder in another mailbox would
   * otherwise synthesise `{ unread: 0, total: 0 }` and blank out a legitimate
   * server badge.
   */
  accountId: number
  /** Rows from `listFolderStats(accountId)` — already single-account by query. */
  stats: readonly { folderPath: string; messageCount: number; unreadCount: number }[]
  /** Rows from `listFolderCrawlStates([...])`; rows of other accounts are dropped. */
  crawlStates: readonly { accountId: number; folderPath: string; status: string }[]
}

export type FolderCounts = Record<string, { unread: number; total: number }>

/**
 * Crawl statuses under which an empty local cache is a statement about the
 * folder rather than an absence of one.
 *
 * NOT the same predicate as `hasCompletedSync` in `electron/main.ts`, and not
 * kept in sync with it. That one answers "did a pass finish, so may we take
 * the cheap FLAGS-only path?" and legitimately accepts `covered_recent`; this
 * one answers "may we assert that the folder is empty?", which a partial pass
 * cannot support (see the module docblock). Two different questions about the
 * same column — sharing one constant would only make the next reader assume
 * they must move together. If a new "covered" status is ever added, it lands
 * here as non-authoritative by default, i.e. it degrades to a stale badge
 * rather than to a wrong zero.
 */
const CACHE_AUTHORITATIVE_CRAWL_STATUSES: ReadonlySet<string> = new Set(['covered_full'])

export function isCacheAuthoritativeForFolder(status: string | null | undefined): boolean {
  return typeof status === 'string' && CACHE_AUTHORITATIVE_CRAWL_STATUSES.has(status)
}

export function buildFolderCountsResponse(input: FolderCountsInput): FolderCounts {
  const result: FolderCounts = {}
  for (const s of input.stats) {
    // SUM() over an empty match set is NULL in SQLite; a folder always has at
    // least one row here (it produced a group), but the coercion keeps the
    // reply numeric regardless of what the query shape becomes later.
    result[s.folderPath] = {
      unread: s.unreadCount ?? 0,
      total: s.messageCount ?? 0,
    }
  }
  for (const c of input.crawlStates) {
    if (c.accountId !== input.accountId) continue
    if (result[c.folderPath] !== undefined) continue
    if (!isCacheAuthoritativeForFolder(c.status)) continue
    result[c.folderPath] = { unread: 0, total: 0 }
  }
  return result
}
