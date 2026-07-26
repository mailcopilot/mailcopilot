/**
 * §2.15-ter (codex iteration 4): pure helper for the syncOfflineBodies
 * cutoff computation. Extracted from electron/main.ts so it can be
 * unit-tested without importing the whole main process (which boots
 * Sentry, IMAP pools, IDLE cycles, etc).
 *
 * Aligns offline body sync with pruneOldEmls so that:
 *   - `offlineMode='period'` uses per-folder `offlineDays` (default 30).
 *   - `offlineMode='full'` + `bodyRetentionDays === -1` (forever) → no cutoff.
 *   - `offlineMode='full'` + finite `bodyRetentionDays` → matching cutoff.
 *
 * Without the cutoff alignment, a `full`-mode folder with finite
 * retention would loop:
 *   pruneOldEmls deletes bodies older than retention → setBodyDownloaded(false)
 *   syncOfflineBodies runs with sinceDate=undefined → re-downloads them
 *   → next pruneOldEmls deletes them again → repeat.
 */
export type OfflineSyncMode = 'period' | 'full'

export function computeOfflineSinceDate(
  offlineMode: OfflineSyncMode,
  offlineDays: number | undefined,
  bodyRetentionDays: number,
  now: number = Date.now(),
): string | undefined {
  if (offlineMode === 'period') {
    const days = typeof offlineDays === 'number' && offlineDays > 0 ? offlineDays : 30
    return new Date(now - days * 86400000).toISOString()
  }
  // 'full' mode — global retention applies. -1 means forever (no cutoff).
  if (bodyRetentionDays === -1) return undefined
  if (!Number.isFinite(bodyRetentionDays) || bodyRetentionDays <= 0) return undefined
  return new Date(now - bodyRetentionDays * 86400000).toISOString()
}
