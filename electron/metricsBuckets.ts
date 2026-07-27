/**
 * Pure bucketing helpers for telemetry tags. Zero runtime dependencies so
 * this module can be imported from both the main process and the renderer
 * bundle without dragging electron-log, Sentry, or electron-store along.
 *
 * Keeping bucket boundaries in one place prevents dashboards from drifting
 * when the same metric is emitted from both sides.
 */

export function bucketQueryLen(len: number): string {
  if (len <= 2) return '1-2'
  if (len <= 5) return '3-5'
  if (len <= 10) return '6-10'
  if (len <= 20) return '11-20'
  if (len <= 50) return '21-50'
  return '50+'
}

export function bucketResultCount(n: number): string {
  if (n === 0) return '0'
  if (n <= 5) return '1-5'
  if (n <= 20) return '6-20'
  if (n <= 50) return '21-50'
  if (n <= 100) return '51-100'
  return '100+'
}

export function bucketDuration(ms: number): string {
  if (ms < 50) return '<50'
  if (ms < 100) return '50-100'
  if (ms < 250) return '100-250'
  if (ms < 500) return '250-500'
  if (ms < 1000) return '500-1000'
  if (ms < 2500) return '1000-2500'
  if (ms < 5000) return '2500-5000'
  return '5000+'
}

export function bucketBodySize(bytes: number): string {
  if (bytes < 1024) return '<1KB'
  if (bytes < 10 * 1024) return '1-10KB'
  if (bytes < 100 * 1024) return '10-100KB'
  if (bytes < 1024 * 1024) return '100KB-1MB'
  return '1MB+'
}

/**
 * §2.15-ter: total bytes reclaimed by a body retention sweep (cache.eml_pruned)
 * or a body-trim preview. Spans 1 KB to 10 GB range — body retention prunes
 * routinely free megabytes (single-folder period sweep) and can hit GB scale
 * on a 1-year retention drop on large mailboxes.
 */
export function bucketFreedBytes(bytes: number): string {
  if (bytes <= 0) return '0'
  if (bytes < 1024 * 1024) return '<1MB'
  if (bytes < 10 * 1024 * 1024) return '1-10MB'
  if (bytes < 100 * 1024 * 1024) return '10-100MB'
  if (bytes < 1024 * 1024 * 1024) return '100MB-1GB'
  if (bytes < 10 * 1024 * 1024 * 1024) return '1-10GB'
  return '10GB+'
}

export function bucketFolderCount(n: number): string {
  if (n <= 5) return '1-5'
  if (n <= 15) return '6-15'
  if (n <= 40) return '16-40'
  return '40+'
}

export function bucketFollowupDays(days: number): string {
  if (days <= 1) return '1'
  if (days <= 3) return '2-3'
  if (days <= 7) return '4-7'
  if (days <= 30) return '8-30'
  return '30+'
}

export function bucketTimeSinceSync(ms: number): string {
  if (ms < 5_000) return '<5s'
  if (ms < 30_000) return '5-30s'
  if (ms < 2 * 60_000) return '30s-2min'
  if (ms < 10 * 60_000) return '2-10min'
  if (ms < 60 * 60_000) return '10-60min'
  return '60min+'
}

export function bucketSessionLength(ms: number): string {
  const min = ms / 60_000
  if (min < 1) return '<1min'
  if (min < 5) return '1-5min'
  if (min < 30) return '5-30min'
  if (min < 120) return '30min-2h'
  return '2h+'
}

/**
 * IDLE cycle duration bucket. IDLE cycles are expected to live for minutes
 * (refresh at 24 min per RFC 2177 / K-9 pattern), so sub-second buckets
 * would waste cardinality. A "<1s" bucket still exists to catch immediate
 * failure modes (auth rejection, socket death).
 */
export function bucketIdleDuration(ms: number): string {
  if (ms < 1_000) return '<1s'
  if (ms < 30_000) return '1-30s'
  if (ms < 5 * 60_000) return '30s-5min'
  if (ms < 20 * 60_000) return '5-20min'
  if (ms < 30 * 60_000) return '20-30min'
  return '30min+'
}

/**
 * Number of full-header rows actually fetched inside a sync batch.
 * Low cardinality, order-of-magnitude resolution so dashboards can see
 * whether a given provider tends to produce small deltas (inbox)
 * vs large ones (first sync of an Archive folder).
 *
 * Note: this is the count of rows that went through the header FETCH —
 * not the size of the CHANGEDSINCE UID window (which includes flag-only
 * changes and can be much larger). CONDSTORE skip-paths report 0.
 */
export function bucketFetchedHeaders(count: number): string {
  if (count <= 0) return '0'
  if (count <= 10) return '1-10'
  if (count <= 100) return '11-100'
  if (count <= 1000) return '101-1000'
  if (count <= 10_000) return '1001-10000'
  return '10000+'
}

/**
 * Body indexer batch size bucket. The inner batch loop processes a slice
 * of UIDs per folder per tick; typical batches are 1-200. Low cardinality
 * buckets keep the span attribute space sane on dashboards.
 */
export function bucketBatchSize(n: number): string {
  if (n <= 0) return '0'
  if (n <= 10) return '1-10'
  if (n <= 50) return '11-50'
  if (n <= 100) return '51-100'
  if (n <= 200) return '101-200'
  return '200+'
}

/**
 * Offline replay queue size bucket. The offline_ops table accumulates while
 * the device is offline and drains on reconnect; typical drains are 1-50 ops
 * but a long offline window can push into the hundreds. Low-cardinality
 * buckets keep dashboards readable without leaking the exact queue depth.
 */
export function bucketOpsCount(n: number): string {
  if (n <= 0) return '0'
  if (n <= 5) return '1-5'
  if (n <= 20) return '6-20'
  if (n <= 50) return '21-50'
  if (n <= 100) return '51-100'
  return '100+'
}

/**
 * Generic small-integer counter bucket. Used for span attributes that need
 * fine-grained resolution at the low end (where 0 vs 1 vs 2 actually matters
 * — e.g. body indexer success/failure within a batch, offline replay failure
 * count) but still cap cardinality with coarse buckets above. Distinct from
 * bucketOpsCount, which is tuned for total queue depth (typically tens to
 * hundreds), not per-batch counters.
 */
export function bucketCount(n: number): string {
  if (n <= 0) return '0'
  if (n === 1) return '1'
  if (n === 2) return '2'
  if (n <= 5) return '3-5'
  if (n <= 10) return '6-10'
  if (n <= 20) return '11-20'
  if (n <= 50) return '21-50'
  return '51+'
}

/**
 * Canonical mail provider inferred from an IMAP/SMTP host. Matches
 * DOMAINS.provider in metricsSchema.ts. Privacy-safe — never emits the
 * raw host, only a well-known enum.
 */
export type ProviderTag = 'gmail' | 'icloud' | 'yandex' | 'mailru' | 'outlook' | 'other'

export function providerFromHost(host: string): ProviderTag {
  const h = (host || '').toLowerCase()
  if (h.includes('gmail') || h.includes('googlemail')) return 'gmail'
  if (h.includes('icloud') || h.includes('me.com')) return 'icloud'
  if (h.includes('yandex')) return 'yandex'
  if (h.includes('mail.ru') || h.includes('list.ru') || h.includes('bk.ru') || h.includes('inbox.ru')) return 'mailru'
  if (h.includes('outlook') || h.includes('hotmail') || h.includes('office365') || h.includes('live.com')) return 'outlook'
  return 'other'
}

/** Canonical folder role — keeps metrics cardinality low and PII-free. */
export type FolderRole = 'inbox' | 'sent' | 'archive' | 'drafts' | 'trash' | 'spam' | 'other'

export function folderRoleFromPath(path: string): FolderRole {
  const lower = path.toLowerCase()
  if (lower === 'inbox' || lower.endsWith('/inbox')) return 'inbox'
  if (lower.includes('sent')) return 'sent'
  if (lower.includes('draft')) return 'drafts'
  if (lower.includes('trash') || lower.includes('deleted')) return 'trash'
  if (lower.includes('spam') || lower.includes('junk')) return 'spam'
  if (lower.includes('archive') || lower.includes('all mail')) return 'archive'
  return 'other'
}
