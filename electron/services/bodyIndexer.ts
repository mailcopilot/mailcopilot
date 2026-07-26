/**
 * Background body text indexer for Search Excellence.
 *
 * Walks cached messages without body_text and fetches their body from IMAP
 * in small batches, filling the FTS5 index without requiring the user to open
 * each message manually.
 *
 * Semantics:
 * - body_text IS NULL → not indexed, will be retried
 * - body_text = ''    → indexed, message has no text/html parts (e.g. image-only)
 * - body_text = '...' → indexed with content
 *
 * Messages without text/plain or text/html BODYSTRUCTURE parts are marked as ''
 * (no retry).  The full-parse fallback (simpleParser) is intentionally skipped
 * to keep the indexer lightweight; users can still open such messages manually,
 * which triggers net:messageDetails with its full-parse path.
 *
 * Search Excellence Hardening additions:
 * - Per-folder error backoff with configurable max retries.
 * - Prioritized folder ordering: current folder → INBOX → standard roles → others.
 * - Checkpoint/resume: folders with errors are skipped and retried after backoff.
 */
import {
  getUidsWithoutBodyText,
  updateMessageBodyText,
  listIndexedFolders,
  getSearchIndexStats,
} from '../../packages/db'
import type { SearchIndexStats } from '../../packages/db'
import { createLogger } from '../logger'
import { captureException } from '../sentry'
import {
  recordEvent,
  recordHistogram,
  recordGauge,
  folderRoleFromPath,
  bucketBatchSize,
  startMetricSpan,
} from '../metrics'
import { bucketCount } from '../metricsBuckets'

const log = createLogger('BodyIndexer')

// --- captureException dedup gate ---
//
// The body indexer tick runs every ~2s. If a persistent (non-transient) bug
// flips the tick into a fail state, raw captureException would flood Sentry
// thousands of times per hour. We gate by error signature + cooldown so the
// SAME repeating bug emits at most once per CAPTURE_COOLDOWN_MS, while a NEW
// failure mode still gets captured immediately. log.error remains unguarded
// so local diagnostics see every occurrence.
//
// Map size is bounded: at most CAPTURE_KEY_LIMIT entries; on insertion past
// the cap the oldest entry is dropped (insertion-order LRU via Map iteration).
const CAPTURE_COOLDOWN_MS = 5 * 60 * 1000
const CAPTURE_KEY_LIMIT = 50
const captureLastSeen = new Map<string, number>()

export function captureOnce(
  key: string,
  err: unknown,
  context: Record<string, unknown>,
  cooldownMs: number = CAPTURE_COOLDOWN_MS,
): void {
  const now = Date.now()
  const last = captureLastSeen.get(key)
  if (last !== undefined && now - last < cooldownMs) return
  // Refresh insertion order: delete then set so the entry moves to the end.
  captureLastSeen.delete(key)
  captureLastSeen.set(key, now)
  // Cap size — drop oldest (Map iteration is insertion order).
  if (captureLastSeen.size > CAPTURE_KEY_LIMIT) {
    const oldest = captureLastSeen.keys().next().value
    if (oldest !== undefined) captureLastSeen.delete(oldest)
  }
  try {
    captureException(err, context)
  } catch {
    /* telemetry must not throw */
  }
}

function errorKey(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}:${(err.message ?? '').slice(0, 100)}`
  }
  return `Unknown:${String(err).slice(0, 100)}`
}

/** Reset capture dedup state (for testing). */
export function resetBodyIndexerCaptureGate(): void {
  captureLastSeen.clear()
}

/** Minimal callback interface so the indexer doesn't depend on the IMAP layer directly. */
export type FetchBodyFn = (
  accountId: number,
  folder: string,
  uid: number,
) => Promise<{ text?: string; html?: string } | null>

export type BodyIndexerOptions = {
  /** How many messages to index per tick (default: 50). */
  batchSize?: number
  /** Interval between ticks in ms (default: 5 000). */
  intervalMs?: number
  /** Callback to fetch body text from IMAP. */
  fetchBody: FetchBodyFn
  /** Returns true when work-offline mode is active (skip indexing). */
  isOffline?: () => boolean
  /** Returns true when header sync is active (pause indexing to avoid IMAP contention). */
  isPaused?: () => boolean
  /** Called with stats after each batch completes. */
  onProgress?: (stats: SearchIndexStats) => void
  /** Max consecutive errors before backing off a folder (default: 3). */
  maxFolderRetries?: number
}

function htmlToPlainText(html: string): string {
  return (html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function getSearchableBodyText(details: { text?: string; html?: string }): string | null {
  const text = (details.text || '').trim()
  if (text) return text
  const html = (details.html || '').trim()
  if (!html) return null
  const plain = htmlToPlainText(html)
  return plain || null
}

// --- Per-folder error backoff ---

type FolderErrorState = { count: number; nextRetryAt: number }
const folderErrors = new Map<string, FolderErrorState>()

function folderKey(accountId: number, folder: string): string { return `${accountId}:${folder}` }

function shouldSkipFolder(accountId: number, folder: string): boolean {
  const state = folderErrors.get(folderKey(accountId, folder))
  if (!state) return false
  // Always respect backoff timer; once it expires, allow retry regardless of count
  return Date.now() < state.nextRetryAt
}

function recordFolderError(accountId: number, folder: string): void {
  const k = folderKey(accountId, folder)
  const prev = folderErrors.get(k)
  const count = (prev?.count ?? 0) + 1
  // Exponential backoff: 30s, 60s, 120s, 240s...
  const backoffMs = Math.min(30_000 * Math.pow(2, count - 1), 600_000)
  folderErrors.set(k, { count, nextRetryAt: Date.now() + backoffMs })
  recordEvent('body_indexer.folder_error', {
    folder_role: folderRoleFromPath(folder),
    error_streak: count,
    backoff_ms: backoffMs,
  })
}

function clearFolderError(accountId: number, folder: string): void {
  folderErrors.delete(folderKey(accountId, folder))
}

/** Reset all error state (for testing). */
export function resetBodyIndexerErrors(): void {
  folderErrors.clear()
}

// --- Folder priority ---

function folderSortPriority(folder: string): number {
  if (folder === 'INBOX') return 0
  const lower = folder.toLowerCase()
  if (lower.includes('sent')) return 1
  if (lower.includes('archive') || lower.includes('all mail')) return 2
  if (lower.includes('draft') || lower.includes('trash') || lower.includes('junk') || lower.includes('spam')) return 3
  return 10
}

function sortFoldersByPriority(
  folders: Array<{ accountId: number; folder: string; count: number }>,
): Array<{ accountId: number; folder: string; count: number }> {
  return [...folders].sort((a, b) => folderSortPriority(a.folder) - folderSortPriority(b.folder))
}

// --- Span helper ---
//
// startMetricSpan is a thin wrapper around Sentry.startInactiveSpan and may
// return undefined when tracing is off or sampled out. It does not itself
// swallow errors from span.end()/setAttributes() — we do that here so a
// broken telemetry pipeline can never turn a successful indexer batch into
// a failure. Mirrors the safety invariants in packages/net/telemetry.ts.
type SafeSpanHandle = {
  setAttributes(attrs: Record<string, string | number | boolean | undefined>): void
  end(): void
}

function safeStartBatchSpan(attrs: Record<string, string | number | boolean | undefined>): SafeSpanHandle {
  let raw: ReturnType<typeof startMetricSpan> | undefined
  try {
    raw = startMetricSpan('body_indexer.batch', attrs)
  } catch {
    raw = undefined
  }
  return {
    setAttributes(extra) {
      if (!raw) return
      try {
        const r = raw as unknown as {
          setAttributes?: (a: Record<string, unknown>) => void
          setAttribute?: (k: string, v: unknown) => void
        }
        if (typeof r.setAttributes === 'function') {
          r.setAttributes(extra)
        } else if (typeof r.setAttribute === 'function') {
          for (const [k, v] of Object.entries(extra)) {
            if (v !== undefined) r.setAttribute(k, v)
          }
        }
      } catch { /* telemetry must not throw */ }
    },
    end() {
      if (!raw) return
      try {
        (raw as unknown as { end?: () => void }).end?.()
      } catch { /* telemetry must not throw */ }
    },
  }
}

// --- State ---

let timer: ReturnType<typeof setInterval> | null = null
let initialTimer: ReturnType<typeof setTimeout> | null = null
let running = false

export function startBodyIndexer(opts: BodyIndexerOptions): void {
  if (timer) return
  // Larger batch + tighter interval: each fetch is sequential per UID and
  // dominated by IMAP RTT, so we want to push more through per tick.
  // Per-folder error backoff still protects against runaway when something
  // is wrong with a folder.
  const batchSize = opts.batchSize ?? 200
  const intervalMs = opts.intervalMs ?? 2_000
  async function tick() {
    if (running) return
    if (opts.isOffline?.()) return
    if (opts.isPaused?.()) return
    running = true
    const tickStart = Date.now()
    try {
      const folders = sortFoldersByPriority(listIndexedFolders())
      let indexed = 0
      for (const { accountId, folder } of folders) {
        if (opts.isOffline?.() || opts.isPaused?.()) break

        // Skip folders with too many consecutive errors
        if (shouldSkipFolder(accountId, folder)) continue

        const uids = getUidsWithoutBodyText(accountId, folder, batchSize)
        if (uids.length === 0) continue

        // Process UIDs in small parallel groups. Each fetchBody uses the
        // per-account IMAP pool (MAX_CONNECTIONS_PER_ACCOUNT=3); we keep
        // CONCURRENCY=2 so other tasks (header sync, manual open) can still
        // grab a slot without queueing 30s for one. A single transient error
        // is no longer a fatal stop for the folder — we count consecutive
        // failures and only back off when the whole batch is dead.
        const CONCURRENCY = 2
        let consecutiveErr = 0
        let folderErr = false
        // Track success on THIS folder only — clearing the folder's error
        // state must not depend on `indexed` (which accumulates across all
        // folders in the tick), otherwise an earlier successful folder would
        // mask a still-broken one and short-circuit its exponential backoff.
        let folderSuccess = 0
        let folderFailed = 0
        // Open a span around this folder's batch processing. Attributes
        // known upfront (folder_role) go at open; counters (fetched_ok,
        // failed, batch_size_bucket) are set on end because they are only
        // known after the inner loop completes. Telemetry is wrapped in
        // safeStartBatchSpan so a broken pipeline cannot fail the batch.
        const batchSpan = safeStartBatchSpan({
          folder_role: folderRoleFromPath(folder),
        })
        try {
          for (let i = 0; i < uids.length && !folderErr; i += CONCURRENCY) {
            if (opts.isOffline?.() || opts.isPaused?.()) break
            const slice = uids.slice(i, i + CONCURRENCY)
            const results = await Promise.allSettled(slice.map(uid => opts.fetchBody(accountId, folder, uid)))
            for (let j = 0; j < results.length; j++) {
              const uid = slice[j]!
              const r = results[j]!
              if (r.status === 'rejected') {
                const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
                log.debug(`fetchBody ${accountId}/${folder}/${uid}: ${reason}`)
                consecutiveErr++
                folderFailed++
                if (consecutiveErr >= 3) {
                  log.warn(`Body indexer skipping ${accountId}/${folder} after ${consecutiveErr} errors (last: ${reason})`)
                  recordFolderError(accountId, folder)
                  folderErr = true
                  break
                }
                continue
              }
              consecutiveErr = 0
              folderSuccess++
              const body = r.value
              if (!body) {
                updateMessageBodyText(accountId, folder, uid, '')
                continue
              }
              const text = getSearchableBodyText(body)
              updateMessageBodyText(accountId, folder, uid, text ?? '')
              indexed++
            }
          }
        } finally {
          batchSpan.setAttributes({
            batch_size_bucket: bucketBatchSize(uids.length),
            fetched_ok_bucket: bucketCount(folderSuccess),
            failed_bucket: bucketCount(folderFailed),
          })
          batchSpan.end()
        }
        // Only clear backoff if THIS folder fetched something successfully.
        // Empty-body folders (all '') still count — the fetches succeeded.
        if (!folderErr && folderSuccess > 0) clearFolderError(accountId, folder)
      }
      const tickMs = Date.now() - tickStart
      if (indexed > 0) {
        log.info(`Indexed ${indexed} bodies in ${tickMs}ms`)
      }
      // Always record tick outcome — zero-work ticks matter for analytics
      // (tells us whether the backlog is drained or the indexer is stuck).
      recordHistogram('body_indexer.tick.duration_ms', tickMs, {
        indexed,
        folders_scanned: folders.length,
      })
      if (opts.onProgress || indexed > 0) {
        // Collect stats for all accounts
        const allAccountIds = [...new Set(folders.map(f => f.accountId))]
        const stats = getSearchIndexStats(allAccountIds)
        if (opts.onProgress) opts.onProgress(stats)
        // Coverage gauge — tells us at-a-glance how much of the corpus is
        // searchable by body text. Account id is non-PII (just an integer).
        if (stats.totalMessages > 0) {
          const pct = Math.round((stats.bodyIndexed / stats.totalMessages) * 100)
          recordGauge('body_indexer.coverage_pct', pct, {
            total_messages: stats.totalMessages,
            indexed_messages: stats.bodyIndexed,
          })
          recordGauge('body_indexer.backlog', stats.totalMessages - stats.bodyIndexed)
        }
      }
    } catch (e) {
      log.error('Body indexer tick error:', e)
      captureOnce(errorKey(e), e, { source: 'bodyIndexer' })
    } finally {
      running = false
    }
  }

  timer = setInterval(() => { void tick() }, intervalMs)
  // Initial run after a short delay
  initialTimer = setTimeout(() => { initialTimer = null; void tick() }, 5000)
  log.info(`Body indexer started (batch=${batchSize}, interval=${intervalMs}ms)`)
}

export function stopBodyIndexer(): void {
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
    log.info('Body indexer stopped')
  }
}

/**
 * Wait for any in-flight tick to complete. Used during shutdown to make sure
 * an awaited IMAP fetch does not race against PRAGMA wal_checkpoint(TRUNCATE).
 *
 * `stopBodyIndexer()` only clears future timers; a tick that is already past
 * the `running = true` barrier at line 262 can still be awaiting fetchBody()
 * (IMAP RTT), and its subsequent `updateMessageBodyText()` write would land
 * AFTER the checkpoint — re-growing the WAL with frames that the truncate
 * just reclaimed. This is the exact failure mode §2.15 targets.
 *
 * Polls `running` flag every 50ms up to `timeoutMs`. Returns true if the
 * indexer idled cleanly before the deadline, false if the timeout hit
 * (caller should log and continue — shutdown must not hang).
 */
export async function waitForIdle(timeoutMs = 3_000): Promise<boolean> {
  const start = Date.now()
  while (running) {
    if (Date.now() - start >= timeoutMs) return false
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  return true
}

/** Get current search index completeness stats. */
export function getIndexStats(accountIds: number[]): SearchIndexStats {
  return getSearchIndexStats(accountIds)
}
