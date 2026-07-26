import Database from 'better-sqlite3'
import os from 'node:os'
import path from 'node:path'
import { isAdvancedSearch, parseSearchQuery } from '@mailcopilot/core'
import type {
  FolderCrawlState,
  MessageRow,
  SearchCoverageStats,
  SearchIndexStats,
} from '../../packages/db'

type RawMessageRow = Omit<MessageRow, 'unread' | 'flagged' | 'hasAttachments' | 'pinned' | 'bodyText' | 'attachmentFilenames'> & {
  unread: number
  flagged: number
  has_attachments: number
  pinned?: number
  body_text?: string | null
  attachment_filenames?: string | null
}

type RawCrawlRow = {
  account_id: number
  folder_path: string
  status: string
  watermark_uid: number | null
  total_exists: number | null
  crawled_count: number | null
  highest_modseq: string | null
  last_attempt_at: string | null
  completed_at: string | null
  error: string | null
}

type RawFolderPrefRow = {
  folderPath: string
  headerSyncMode: 'full' | 'on_open' | 'period' | 'off'
}

const dataDir = process.env.MAILCOPILOT_DATA_DIR || path.join(os.homedir(), '.mailcopilot')
const dbPath = path.join(dataDir, 'cache.db')

const REQUIRED_FTS_COLUMNS = ['subject', 'from_addr', 'from_name', 'to_addr', 'body_text', 'attachment_filenames']

let dbInstance: Database.Database | null = null
let ftsEnabledCached: boolean | null = null

function db(): Database.Database {
  if (dbInstance) return dbInstance
  // Open lazily so the worker survives starting before main has bootstrapped cache.db
  // (e.g. early IPC, e2e with a fresh MAILCOPILOT_DATA_DIR).
  const instance = new Database(dbPath, { readonly: true, fileMustExist: true })
  instance.pragma('query_only = ON')
  instance.pragma('busy_timeout = 5000')
  // Performance tuning for repeated FTS queries on a large message corpus.
  // - cache_size: negative value = KiB; -64000 = 64 MiB page cache (default 2 MiB).
  // - mmap_size: 256 MiB memory-mapped I/O — SQLite reads pages directly from the
  //   OS page cache without copying, which dramatically speeds up repeated reads.
  // - temp_store=MEMORY: ORDER BY sort buffers stay in RAM instead of spilling to
  //   a temp file on disk; helps BM25/date sort on large result sets.
  instance.pragma('cache_size = -64000')
  instance.pragma('mmap_size = 268435456')
  instance.pragma('temp_store = MEMORY')
  // Warm up the page cache with trivial touches into the FTS5 virtual table and the
  // main messages table. This loads the index root + top-level b-tree pages into the
  // freshly-allocated cache so the first real search doesn't pay a cold-start penalty
  // (which on a large partially-indexed corpus can easily be 10+ seconds).
  try {
    instance.prepare(`SELECT rowid FROM messages_fts LIMIT 1`).get()
    instance.prepare(`SELECT id FROM messages LIMIT 1`).get()
  } catch {
    // FTS table or messages table may not exist in a freshly-created DB — non-fatal.
  }
  dbInstance = instance
  return instance
}

function ftsEnabled(): boolean {
  if (ftsEnabledCached !== null) return ftsEnabledCached
  try {
    const hasTable = Boolean(db().prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_fts'`,
    ).get())
    if (!hasTable) {
      ftsEnabledCached = false
      return false
    }
    const cols = db().prepare(`PRAGMA table_info(messages_fts)`).all() as Array<{ name?: unknown }>
    const names = new Set(cols.map(c => String(c.name || '')))
    ftsEnabledCached = REQUIRED_FTS_COLUMNS.every(name => names.has(name))
    return ftsEnabledCached
  } catch {
    ftsEnabledCached = false
    return false
  }
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&')
}

function mapRow(row: RawMessageRow): MessageRow {
  const { has_attachments, body_text, attachment_filenames, pinned, ...rest } = row
  const mapped: MessageRow = {
    ...rest,
    unread: row.unread === 1,
    flagged: row.flagged === 1,
    hasAttachments: has_attachments === 1,
  }
  if (pinned === 1) mapped.pinned = true
  if (body_text != null) mapped.bodyText = body_text
  if (attachment_filenames != null) mapped.attachmentFilenames = attachment_filenames
  return mapped
}

function mapCrawlRow(row: RawCrawlRow): FolderCrawlState {
  return {
    accountId: row.account_id,
    folderPath: row.folder_path,
    status: (['not_started', 'crawling', 'covered_recent', 'covered_full', 'error'] as const).includes(row.status as FolderCrawlState['status'])
      ? row.status as FolderCrawlState['status']
      : 'not_started',
    watermarkUid: row.watermark_uid,
    totalExists: row.total_exists,
    crawledCount: row.crawled_count ?? 0,
    highestModseq: row.highest_modseq,
    lastAttemptAt: row.last_attempt_at,
    completedAt: row.completed_at,
    error: row.error,
  }
}

function dayStartIso(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString()
}

/**
 * Build an FTS5 MATCH expression for search-as-you-type.
 * Every token of length ≥3 gets a `*` prefix wildcard — this is required for
 * morphologically rich languages (Russian: "лариса" must match "ларису",
 * "ларисой", etc.) and for partial-word matching while typing. Tokens shorter
 * than 3 chars are kept exact because a 1-2 letter prefix would expand to a
 * huge slice of the term dictionary.
 */
function buildFtsMatch(tokens: string[]): string {
  if (tokens.length === 0) return ''
  return tokens.map(t => (t.length >= 3 ? `${t}*` : t)).join(' AND ')
}

function makeLikeGroup(params: unknown[], cols: string[], term: string): string {
  const pat = `%${escapeLike(term.toLowerCase())}%`
  for (let i = 0; i < cols.length; i++) params.push(pat)
  return '(' + cols.map(col => `LOWER(${col}) LIKE ? ESCAPE '\\'`).join(' OR ') + ')'
}

function addLikeGroup(where: string[], params: unknown[], cols: string[], terms: string[], negate = false): void {
  if (terms.length === 0) return
  if (terms.length === 1) {
    const cond = makeLikeGroup(params, cols, terms[0]!)
    where.push(negate ? `NOT ${cond}` : cond)
    return
  }
  const parts = terms.map(term => makeLikeGroup(params, cols, term))
  const group = '(' + parts.join(' OR ') + ')'
  where.push(negate ? `NOT ${group}` : group)
}

export type SearchSort = 'relevance' | 'date'

export function searchMessagesReadOnly(
  accountId: number,
  folder: string,
  queryRaw: string,
  limit = 100,
  offset = 0,
  sort: SearchSort = 'date',
): MessageRow[] {
  const query = queryRaw.trim()
  if (!query) return []

  const parsed = parseSearchQuery(query)
  const advanced = isAdvancedSearch(parsed)

  if (!advanced && ftsEnabled()) {
    try {
      const tokens = query
        .split(/[^\p{L}\p{N}_]+/gu)
        .filter(Boolean)
      if (tokens.length === 0) throw new Error('empty fts tokens')
      const fts = buildFtsMatch(tokens)
      const ftsOrderBy = sort === 'relevance'
        ? 'bm25(messages_fts, 10.0, 5.0, 5.0, 3.0, 1.0, 2.0)'
        : 'm.date DESC, m.uid DESC'

      const rows = db().prepare(`SELECT
          m.account_id as accountId,
          m.folder_path as folder,
          m.uid,
          m.subject,
          COALESCE(NULLIF(TRIM(m.from_name), ''), m.from_addr) as 'from',
          m.from_addr as fromAddr,
          m.from_name as fromName,
          m.to_addr as toAddr,
          m.message_id as messageId,
          m.in_reply_to as inReplyTo,
          m."references" as "references",
          m.date,
          m.unread,
          m.flagged,
          m.has_attachments as has_attachments,
          m.pinned,
          snippet(messages_fts, 4, '«', '»', '…', 40) as matchSnippet
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE m.account_id=? AND m.folder_path=? AND messages_fts MATCH ?
          AND NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=m.account_id AND s.folder=m.folder_path AND s.uid=m.uid)
        ORDER BY ${ftsOrderBy}
        LIMIT ? OFFSET ?`).all(accountId, folder, fts, limit, offset) as Array<RawMessageRow & { matchSnippet?: string }>

      return rows.map(row => {
        const mapped = mapRow(row)
        if (row.matchSnippet) mapped.matchSnippet = row.matchSnippet
        return mapped
      })
    } catch {
      // Fall back to LIKE below.
    }
  }

  if (advanced) {
    const where: string[] = ['m.account_id=?']
    const params: unknown[] = [accountId]

    const scopeFolder = parsed.anywhere ? null : (parsed.folder || folder)
    if (scopeFolder) {
      where.push('m.folder_path=?')
      params.push(scopeFolder)
    }

    where.push(`NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=m.account_id AND s.folder=m.folder_path AND s.uid=m.uid)`)
    // §2.15-ter (codex iteration 4): mirror packages/db/index.ts. Read-only
    // search worker must apply the same indexInSearch=false filter to the
    // advanced/LIKE fallback paths — the FTS path is already correct
    // because excluded rows are not in messages_fts.
    where.push(`NOT EXISTS (SELECT 1 FROM folder_prefs fp WHERE fp.account_id=m.account_id AND fp.folder_path=m.folder_path AND fp.index_in_search=0)`)

    if (typeof parsed.isUnread === 'boolean') { where.push('m.unread=?'); params.push(parsed.isUnread ? 1 : 0) }
    if (typeof parsed.isFlagged === 'boolean') { where.push('m.flagged=?'); params.push(parsed.isFlagged ? 1 : 0) }
    if (typeof parsed.hasAttachment === 'boolean') { where.push('m.has_attachments=?'); params.push(parsed.hasAttachment ? 1 : 0) }

    if (parsed.uids.length > 0) {
      const placeholders = parsed.uids.map(() => '?').join(',')
      where.push(`m.uid IN (${placeholders})`)
      params.push(...parsed.uids)
    }

    if (parsed.after) { where.push('m.date >= ?'); params.push(dayStartIso(parsed.after)) }
    if (parsed.before) { where.push('m.date < ?'); params.push(dayStartIso(parsed.before)) }

    for (const term of parsed.text) addLikeGroup(where, params, ['m.subject', 'm.from_addr', 'm.from_name', 'm.to_addr'], [term], false)
    for (const term of parsed.notText) addLikeGroup(where, params, ['m.subject', 'm.from_addr', 'm.from_name', 'm.to_addr'], [term], true)
    addLikeGroup(where, params, ['m.from_addr', 'm.from_name'], parsed.from, false)
    addLikeGroup(where, params, ['m.from_addr', 'm.from_name'], parsed.notFrom, true)
    addLikeGroup(where, params, ['m.to_addr'], parsed.to, false)
    addLikeGroup(where, params, ['m.to_addr'], parsed.notTo, true)
    addLikeGroup(where, params, ['m.subject'], parsed.subject, false)
    addLikeGroup(where, params, ['m.subject'], parsed.notSubject, true)
    addLikeGroup(where, params, ['m.body_text'], parsed.body, false)
    addLikeGroup(where, params, ['m.body_text'], parsed.notBody, true)
    addLikeGroup(where, params, ['m.attachment_filenames'], parsed.filename, false)
    addLikeGroup(where, params, ['m.attachment_filenames'], parsed.notFilename, true)

    // Advanced/LIKE paths have no relevance signal — sort='relevance' falls back to date order.
    const orderBy = 'm.date DESC, m.uid DESC'
    void sort // chosen ordering is identical for both sort modes on this path
    const rows = db().prepare(`SELECT
        m.account_id as accountId,
        m.folder_path as folder,
        m.uid,
        m.subject,
        COALESCE(NULLIF(TRIM(m.from_name), ''), m.from_addr) as 'from',
        m.from_addr as fromAddr,
        m.from_name as fromName,
        m.to_addr as toAddr,
        m.message_id as messageId,
        m.in_reply_to as inReplyTo,
        m."references" as "references",
        m.date,
        m.unread,
        m.flagged,
        m.has_attachments as has_attachments,
        m.pinned
      FROM messages m
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`).all(...params, limit, offset) as RawMessageRow[]

    return rows.map(mapRow)
  }

  const like = `%${escapeLike(query)}%`
  const rows = db().prepare(`SELECT
      account_id as accountId,
      folder_path as folder,
      uid,
      subject,
      COALESCE(NULLIF(TRIM(from_name), ''), from_addr) as 'from',
      from_addr as fromAddr,
      from_name as fromName,
      to_addr as toAddr,
      message_id as messageId,
      in_reply_to as inReplyTo,
      "references" as "references",
      date,
      unread,
      flagged,
      has_attachments,
      pinned
    FROM messages
    WHERE account_id=? AND folder_path=? AND (
      subject LIKE ? ESCAPE '\\'
      OR from_addr LIKE ? ESCAPE '\\'
      OR from_name LIKE ? ESCAPE '\\'
      OR to_addr LIKE ? ESCAPE '\\'
      OR body_text LIKE ? ESCAPE '\\'
      OR attachment_filenames LIKE ? ESCAPE '\\'
    )
    AND NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=messages.account_id AND s.folder=messages.folder_path AND s.uid=messages.uid)
    AND NOT EXISTS (SELECT 1 FROM folder_prefs fp WHERE fp.account_id=messages.account_id AND fp.folder_path=messages.folder_path AND fp.index_in_search=0)
    ORDER BY date DESC, uid DESC
    LIMIT ? OFFSET ?`).all(accountId, folder, like, like, like, like, like, like, limit, offset) as RawMessageRow[]

  return rows.map(mapRow)
}

export function searchUnifiedInboxReadOnly(
  accountIds: number[],
  queryRaw: string,
  limit = 100,
  offset = 0,
  scope: 'inbox' | 'all' = 'all',
  sort: SearchSort = 'date',
): MessageRow[] {
  const ids = accountIds.map(n => Math.floor(Number(n))).filter(n => Number.isFinite(n) && n > 0)
  const query = queryRaw.trim()
  if (!query || ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  const folderFilter = scope === 'inbox'

  const parsed = parseSearchQuery(query)
  const advanced = isAdvancedSearch(parsed)

  if (!advanced && ftsEnabled()) {
    try {
      const tokens = query
        .split(/[^\p{L}\p{N}_]+/gu)
        .filter(Boolean)
      if (tokens.length === 0) throw new Error('empty fts tokens')
      const fts = buildFtsMatch(tokens)
      const folderWhere = folderFilter ? `AND m.folder_path='INBOX'` : ''
      const ftsOrderBy = sort === 'relevance'
        ? 'bm25(messages_fts, 10.0, 5.0, 5.0, 3.0, 1.0, 2.0)'
        : 'm.date DESC, m.account_id DESC, m.uid DESC'

      const rows = db().prepare(`SELECT
          m.account_id as accountId,
          m.folder_path as folder,
          m.uid,
          m.subject,
          COALESCE(NULLIF(TRIM(m.from_name), ''), m.from_addr) as 'from',
          m.from_addr as fromAddr,
          m.from_name as fromName,
          m.to_addr as toAddr,
          m.message_id as messageId,
          m.in_reply_to as inReplyTo,
          m."references" as "references",
          m.date,
          m.unread,
          m.flagged,
          m.has_attachments as has_attachments,
          m.pinned,
          snippet(messages_fts, 4, '«', '»', '…', 40) as matchSnippet
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE m.account_id IN (${placeholders}) ${folderWhere} AND messages_fts MATCH ?
          AND NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=m.account_id AND s.folder=m.folder_path AND s.uid=m.uid)
        ORDER BY ${ftsOrderBy}
        LIMIT ? OFFSET ?`).all(...ids, fts, limit, offset) as Array<RawMessageRow & { matchSnippet?: string }>

      return rows.map(row => {
        const mapped = mapRow(row)
        if (row.matchSnippet) mapped.matchSnippet = row.matchSnippet
        return mapped
      })
    } catch {
      // Fall back to LIKE below.
    }
  }

  if (advanced) {
    const where: string[] = [`m.account_id IN (${placeholders})`]
    const params: unknown[] = [...ids]

    const scopeFolder = parsed.anywhere ? null : (parsed.folder || (folderFilter ? 'INBOX' : null))
    if (scopeFolder) {
      where.push('m.folder_path=?')
      params.push(scopeFolder)
    }

    where.push(`NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=m.account_id AND s.folder=m.folder_path AND s.uid=m.uid)`)
    // §2.15-ter (codex iteration 4): filter excluded folders from advanced
    // path. Same rationale as searchMessagesReadOnly above.
    where.push(`NOT EXISTS (SELECT 1 FROM folder_prefs fp WHERE fp.account_id=m.account_id AND fp.folder_path=m.folder_path AND fp.index_in_search=0)`)

    if (typeof parsed.isUnread === 'boolean') { where.push('m.unread=?'); params.push(parsed.isUnread ? 1 : 0) }
    if (typeof parsed.isFlagged === 'boolean') { where.push('m.flagged=?'); params.push(parsed.isFlagged ? 1 : 0) }
    if (typeof parsed.hasAttachment === 'boolean') { where.push('m.has_attachments=?'); params.push(parsed.hasAttachment ? 1 : 0) }

    if (parsed.uids.length > 0) {
      const uidPlaceholders = parsed.uids.map(() => '?').join(',')
      where.push(`m.uid IN (${uidPlaceholders})`)
      params.push(...parsed.uids)
    }

    if (parsed.after) { where.push('m.date >= ?'); params.push(dayStartIso(parsed.after)) }
    if (parsed.before) { where.push('m.date < ?'); params.push(dayStartIso(parsed.before)) }

    for (const term of parsed.text) addLikeGroup(where, params, ['m.subject', 'm.from_addr', 'm.from_name', 'm.to_addr'], [term], false)
    for (const term of parsed.notText) addLikeGroup(where, params, ['m.subject', 'm.from_addr', 'm.from_name', 'm.to_addr'], [term], true)
    addLikeGroup(where, params, ['m.from_addr', 'm.from_name'], parsed.from, false)
    addLikeGroup(where, params, ['m.from_addr', 'm.from_name'], parsed.notFrom, true)
    addLikeGroup(where, params, ['m.to_addr'], parsed.to, false)
    addLikeGroup(where, params, ['m.to_addr'], parsed.notTo, true)
    addLikeGroup(where, params, ['m.subject'], parsed.subject, false)
    addLikeGroup(where, params, ['m.subject'], parsed.notSubject, true)
    addLikeGroup(where, params, ['m.body_text'], parsed.body, false)
    addLikeGroup(where, params, ['m.body_text'], parsed.notBody, true)
    addLikeGroup(where, params, ['m.attachment_filenames'], parsed.filename, false)
    addLikeGroup(where, params, ['m.attachment_filenames'], parsed.notFilename, true)

    // No relevance signal outside FTS — both sort modes collapse to date order here.
    void sort
    const rows = db().prepare(`SELECT
        m.account_id as accountId,
        m.folder_path as folder,
        m.uid,
        m.subject,
        COALESCE(NULLIF(TRIM(m.from_name), ''), m.from_addr) as 'from',
        m.from_addr as fromAddr,
        m.from_name as fromName,
        m.to_addr as toAddr,
        m.message_id as messageId,
        m.in_reply_to as inReplyTo,
        m."references" as "references",
        m.date,
        m.unread,
        m.flagged,
        m.has_attachments as has_attachments,
        m.pinned
      FROM messages m
      WHERE ${where.join(' AND ')}
      ORDER BY m.date DESC, m.account_id DESC, m.uid DESC
      LIMIT ? OFFSET ?`).all(...params, limit, offset) as RawMessageRow[]

    return rows.map(mapRow)
  }

  // LIKE fallback (no FTS, no operators) — collapse relevance to date order.
  const like = `%${escapeLike(query)}%`
  const folderWhere = folderFilter ? `AND folder_path='INBOX'` : ''
  const rows = db().prepare(`SELECT
      account_id as accountId,
      folder_path as folder,
      uid,
      subject,
      COALESCE(NULLIF(TRIM(from_name), ''), from_addr) as 'from',
      from_addr as fromAddr,
      from_name as fromName,
      to_addr as toAddr,
      message_id as messageId,
      in_reply_to as inReplyTo,
      "references" as "references",
      date,
      unread,
      flagged,
      has_attachments,
      pinned
    FROM messages
    WHERE account_id IN (${placeholders}) ${folderWhere} AND (
      subject LIKE ? ESCAPE '\\'
      OR from_addr LIKE ? ESCAPE '\\'
      OR from_name LIKE ? ESCAPE '\\'
      OR to_addr LIKE ? ESCAPE '\\'
      OR body_text LIKE ? ESCAPE '\\'
      OR attachment_filenames LIKE ? ESCAPE '\\'
    )
    AND NOT EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id=messages.account_id AND s.folder=messages.folder_path AND s.uid=messages.uid)
    AND NOT EXISTS (SELECT 1 FROM folder_prefs fp WHERE fp.account_id=messages.account_id AND fp.folder_path=messages.folder_path AND fp.index_in_search=0)
    ORDER BY date DESC, account_id DESC, uid DESC
    LIMIT ? OFFSET ?`).all(...ids, like, like, like, like, like, like, limit, offset) as RawMessageRow[]

  return rows.map(mapRow)
}

export function getSearchIndexStatsReadOnly(accountIds: number[]): SearchIndexStats {
  if (accountIds.length === 0) return { totalMessages: 0, bodyIndexed: 0, filenamesIndexed: 0 }
  const placeholders = accountIds.map(() => '?').join(',')
  // §2.15-ter (codex iteration 4): mirror the writer-side filter. Excluded
  // folders (indexInSearch=false) are intentionally not body-indexed, so
  // they must not contribute to the body-indexing coverage statusbar metric.
  const row = db().prepare(`SELECT
      COUNT(*) as total,
      SUM(CASE WHEN m.body_text IS NOT NULL THEN 1 ELSE 0 END) as body_indexed,
      SUM(CASE WHEN m.attachment_filenames IS NOT NULL THEN 1 ELSE 0 END) as filenames_indexed
    FROM messages m
    WHERE m.account_id IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM folder_prefs fp WHERE fp.account_id=m.account_id AND fp.folder_path=m.folder_path AND fp.index_in_search=0)`).get(...accountIds) as {
      total: number
      body_indexed: number
      filenames_indexed: number
    } | undefined

  return {
    totalMessages: row?.total ?? 0,
    bodyIndexed: row?.body_indexed ?? 0,
    filenamesIndexed: row?.filenames_indexed ?? 0,
  }
}

export function listFolderCrawlStatesReadOnly(accountIds: number[]): FolderCrawlState[] {
  if (accountIds.length === 0) return []
  const placeholders = accountIds.map(() => '?').join(',')
  const rows = db().prepare(
    `SELECT * FROM folder_crawl_state WHERE account_id IN (${placeholders}) ORDER BY account_id, folder_path`,
  ).all(...accountIds) as RawCrawlRow[]
  return rows.map(mapCrawlRow)
}

function listFolderPrefsReadOnly(accountId: number): RawFolderPrefRow[] {
  return db().prepare(`
    SELECT
      folder_path as folderPath,
      header_sync_mode as headerSyncMode
    FROM folder_prefs
    WHERE account_id=?
    ORDER BY folder_path ASC
  `).all(accountId) as RawFolderPrefRow[]
}

export function getSearchCoverageStatsReadOnly(accountIds: number[]): SearchCoverageStats {
  const indexStats = getSearchIndexStatsReadOnly(accountIds)
  const crawlStates = listFolderCrawlStatesReadOnly(accountIds)
  const indexablePaths = new Set<string>()

  for (const accountId of accountIds) {
    const prefs = listFolderPrefsReadOnly(accountId)
    const prefsByPath = new Map(prefs.map(pref => [pref.folderPath, pref]))
    const row = db().prepare(`SELECT mailboxes_json FROM cached_mailboxes WHERE account_id=?`).get(accountId) as { mailboxes_json: string } | undefined

    if (row) {
      try {
        const boxes = JSON.parse(row.mailboxes_json) as Array<{ path?: string }>
        for (const box of boxes) {
          const folderPath = box.path
          if (!folderPath) continue
          const pref = prefsByPath.get(folderPath)
          if (!pref || pref.headerSyncMode !== 'off') {
            indexablePaths.add(`${accountId}:${folderPath}`)
          }
        }
      } catch {
        // Ignore malformed cache rows; crawl states below are still a fallback.
      }
    } else {
      for (const state of crawlStates) {
        if (state.accountId === accountId) indexablePaths.add(`${accountId}:${state.folderPath}`)
      }
    }
  }

  const folderCoverage = {
    total: indexablePaths.size,
    coveredFull: 0,
    coveredRecent: 0,
    crawling: 0,
    notStarted: 0,
    error: 0,
  }

  for (const state of crawlStates) {
    if (!indexablePaths.has(`${state.accountId}:${state.folderPath}`)) continue
    switch (state.status) {
      case 'covered_full': folderCoverage.coveredFull++; break
      case 'covered_recent': folderCoverage.coveredRecent++; break
      case 'crawling': folderCoverage.crawling++; break
      case 'error': folderCoverage.error++; break
      default: folderCoverage.notStarted++; break
    }
  }

  return {
    totalMessages: indexStats.totalMessages,
    bodyIndexed: indexStats.bodyIndexed,
    filenamesIndexed: indexStats.filenamesIndexed,
    folderCoverage,
  }
}

export function closeSearchReadOnlyDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
    ftsEnabledCached = null
  }
}
