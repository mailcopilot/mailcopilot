import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildFolderCountsResponse, isCacheAuthoritativeForFolder } from './folderCountsResponse'

/**
 * Defect: after an assistant bulk-archive emptied a folder, the folder and
 * account badges kept showing the pre-action number until the app was
 * restarted, while the message list correctly showed "Inbox Zero".
 *
 * Cause: `listFolderStats` is a `GROUP BY folder_path` — a folder with no rows
 * produces no group and is ABSENT from the reply, and the renderer merge reads
 * an absent key as "no news, keep the previous badge". The manual UI paths hid
 * it behind their compensating optimistic delta; the assistant path has none.
 *
 * The reply must therefore name the folders it speaks for. It may not simply
 * zero every absent folder: a folder with `headerSyncMode: 'on_open'` that was
 * never opened also has no rows, and its badge legitimately carries the server
 * LIST-STATUS number.
 *
 * The set of folders it may speak for is `covered_full` ONLY, and only within
 * the account being asked about. A `covered_recent` folder is a partial,
 * resumable crawl — an empty cache there says nothing about unread mail below
 * the covered range — and a folder path is unique only within one mailbox.
 */
describe('buildFolderCountsResponse', () => {
  const ACCOUNT = 1
  const covered = (folderPath: string, accountId = ACCOUNT) =>
    ({ accountId, folderPath, status: 'covered_full' })

  it('passes through the cached counts for folders that have rows', () => {
    const result = buildFolderCountsResponse({
      accountId: ACCOUNT,
      stats: [
        { folderPath: 'INBOX', messageCount: 12, unreadCount: 3 },
        { folderPath: 'Archive', messageCount: 400, unreadCount: 0 },
      ],
      crawlStates: [covered('INBOX'), covered('Archive')],
    })
    expect(result).toEqual({
      INBOX: { unread: 3, total: 12 },
      Archive: { unread: 0, total: 400 },
    })
  })

  it('reports an explicit zero for a fully crawled folder whose rows are gone', () => {
    // The incident shape: INBOX was covered_full, the assistant moved every
    // message out, so `listFolderStats` no longer mentions it at all.
    const result = buildFolderCountsResponse({
      accountId: ACCOUNT,
      stats: [{ folderPath: 'Archive', messageCount: 407, unreadCount: 7 }],
      crawlStates: [covered('INBOX'), covered('Archive')],
    })
    expect(result.INBOX).toEqual({ unread: 0, total: 0 })
  })

  it('stays SILENT about a partially crawled folder with no rows', () => {
    // `covered_recent` means a resumable pass: main.ts resumes such a folder
    // downwards from its watermark precisely because older messages have not
    // been looked at. Zero local rows there does NOT rule out unread mail
    // below the covered range, so the helper may not claim a zero. The key
    // must be ABSENT — the renderer then keeps the previous badge, which is
    // stale but recoverable, instead of a confidently wrong zero.
    const result = buildFolderCountsResponse({
      accountId: ACCOUNT,
      stats: [],
      crawlStates: [{ accountId: ACCOUNT, folderPath: 'INBOX', status: 'covered_recent' }],
    })
    expect(result).toEqual({})
    expect('INBOX' in result).toBe(false)
  })

  it('speaks only for the account it was asked about', () => {
    // Folder paths are unique only WITHIN an account and the reply is keyed by
    // path alone. A covered 'INBOX' belonging to another mailbox must not
    // synthesise a zero here and blank out this account's server badge.
    const result = buildFolderCountsResponse({
      accountId: ACCOUNT,
      stats: [],
      crawlStates: [covered('INBOX', ACCOUNT + 1)],
    })
    expect(result).toEqual({})
  })

  it('leaves a never-crawled folder absent so its server count survives', () => {
    // Regression guard for the `headerSyncMode: 'on_open'` folder the user put
    // in badges but never opened. Blind zeroing would wipe its badge.
    for (const status of ['not_started', 'crawling', 'error']) {
      const result = buildFolderCountsResponse({
        accountId: ACCOUNT,
        stats: [],
        crawlStates: [{ accountId: ACCOUNT, folderPath: 'Spam', status }],
      })
      expect(result.Spam, `status=${status}`).toBeUndefined()
    }
  })

  it('leaves a folder with no crawl-state row at all absent', () => {
    const result = buildFolderCountsResponse({ accountId: ACCOUNT, stats: [], crawlStates: [] })
    expect(result).toEqual({})
  })

  it('never lets a crawl state override a folder that has rows', () => {
    // Ordering guard: the explicit-zero pass runs after the stats pass and
    // must not clobber a real count for a folder listed in both.
    const result = buildFolderCountsResponse({
      accountId: ACCOUNT,
      stats: [{ folderPath: 'INBOX', messageCount: 5, unreadCount: 2 }],
      crawlStates: [covered('INBOX')],
    })
    expect(result.INBOX).toEqual({ unread: 2, total: 5 })
  })

  it('coerces a null SUM() to zero rather than emitting null', () => {
    const result = buildFolderCountsResponse({
      accountId: ACCOUNT,
      stats: [{
        folderPath: 'INBOX',
        messageCount: null as unknown as number,
        unreadCount: null as unknown as number,
      }],
      crawlStates: [],
    })
    expect(result.INBOX).toEqual({ unread: 0, total: 0 })
  })

  it('grants authority to a completed crawl only', () => {
    // Deliberately NOT `hasCompletedSync` from main.ts: that predicate answers
    // "may we take the cheap FLAGS-only path?" and accepts a partial pass.
    // Any new or unknown status degrades to a stale badge, never to a zero.
    expect(isCacheAuthoritativeForFolder('covered_full')).toBe(true)
    expect(isCacheAuthoritativeForFolder('covered_recent')).toBe(false)
    expect(isCacheAuthoritativeForFolder('some_future_status')).toBe(false)
    expect(isCacheAuthoritativeForFolder(undefined)).toBe(false)
    expect(isCacheAuthoritativeForFolder(null)).toBe(false)
  })
})

/**
 * Source-mirror half. `main.ts` cannot be imported in a unit test (module-level
 * side effects: DB open, window creation, IPC registration), so the wiring is
 * pinned against the production text — the same technique as
 * `main.standaloneWindows.test.ts`. Without the fix the handler builds its
 * record inline from `listFolderStats` alone and these assertions fail.
 */
describe('main.ts folder:refreshCounts wiring (source-mirror)', () => {
  const MAIN_TS = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
  const start = MAIN_TS.indexOf("handleIpc('folder:refreshCounts'")
  const body = MAIN_TS.slice(start, MAIN_TS.indexOf('\n})', start))

  it('locates the handler', () => {
    expect(start).toBeGreaterThan(-1)
  })

  it('imports the shared builder', () => {
    expect(MAIN_TS).toContain("import { buildFolderCountsResponse } from './folderCountsResponse'")
  })

  it('answers through the builder, fed with BOTH stats and crawl states', () => {
    expect(body).toContain('buildFolderCountsResponse(')
    expect(body).toContain('stats: listFolderStats(id)')
    expect(body).toContain('crawlStates: listFolderCrawlStates([id])')
  })

  it('names the account the reply speaks for', () => {
    // Without it the builder cannot drop crawl states of other mailboxes and
    // a same-named covered folder elsewhere would zero this account's badge.
    expect(body).toContain('accountId: id')
  })

  it('does not assemble the reply inline from stats alone', () => {
    // The pre-fix shape — a local record filled by looping over the stats — is
    // exactly what made an empty folder unmentionable.
    expect(body).not.toContain('for (const s of stats)')
  })
})
