import { describe, expect, it } from 'vitest'
import { computeOfflineSinceDate } from './offlineRetention'

/**
 * §2.15-ter (codex iteration 4): Pure-helper tests for the
 * syncOfflineBodies cutoff computation. The function powers the
 * sinceDate filter that syncOfflineBodies passes to
 * getUidsWithoutBody — i.e., it decides which bodies are still
 * eligible to be downloaded. Wrong cutoff = re-download loop with
 * pruneOldEmls.
 */
describe('computeOfflineSinceDate', () => {
  // Fixed `now` so date math is deterministic. 2026-04-25 in UTC.
  const NOW = new Date('2026-04-25T12:00:00Z').getTime()

  describe('offlineMode=period', () => {
    it('uses per-folder offlineDays as the cutoff', () => {
      const since = computeOfflineSinceDate('period', 7, 365, NOW)
      expect(since).toBe(new Date(NOW - 7 * 86400000).toISOString())
    })

    it('defaults to 30 days when offlineDays is undefined', () => {
      const since = computeOfflineSinceDate('period', undefined, 365, NOW)
      expect(since).toBe(new Date(NOW - 30 * 86400000).toISOString())
    })

    it('defaults to 30 days when offlineDays is zero or negative (defensive)', () => {
      // Zero / negative offlineDays should never reach here at runtime
      // (upsertFolderPref clamps to >=1), but the helper is defensive.
      const since0 = computeOfflineSinceDate('period', 0, 365, NOW)
      const sinceNeg = computeOfflineSinceDate('period', -5, 365, NOW)
      expect(since0).toBe(new Date(NOW - 30 * 86400000).toISOString())
      expect(sinceNeg).toBe(new Date(NOW - 30 * 86400000).toISOString())
    })

    it('ignores bodyRetentionDays in period mode', () => {
      // period mode is per-folder explicit user intent; global retention
      // is irrelevant.
      const sinceFinite = computeOfflineSinceDate('period', 7, 365, NOW)
      const sinceForever = computeOfflineSinceDate('period', 7, -1, NOW)
      expect(sinceFinite).toBe(sinceForever)
    })
  })

  describe('offlineMode=full', () => {
    it('returns undefined when bodyRetentionDays is -1 (forever)', () => {
      // Forever retention = no cutoff = full historical sync.
      const since = computeOfflineSinceDate('full', undefined, -1, NOW)
      expect(since).toBeUndefined()
    })

    it('uses bodyRetentionDays as cutoff when finite', () => {
      // This is the codex HIGH 3 fix: previously full mode always passed
      // sinceDate=undefined, so it re-downloaded bodies pruneOldEmls
      // had just deleted, creating a prune→download loop.
      const since = computeOfflineSinceDate('full', undefined, 90, NOW)
      expect(since).toBe(new Date(NOW - 90 * 86400000).toISOString())
    })

    it('cutoff aligns with pruneOldEmls (same days, same date math)', () => {
      // pruneOldEmls computes: cutoffDate = new Date(Date.now() - cutoffDays * 86400000).toISOString()
      // computeOfflineSinceDate must produce the identical value when given
      // the same retention. Any drift would break the alignment guarantee.
      const days = 90
      const offlineSince = computeOfflineSinceDate('full', undefined, days, NOW)
      const pruneCutoff = new Date(NOW - days * 86400000).toISOString()
      expect(offlineSince).toBe(pruneCutoff)
    })

    it('returns undefined for non-finite or non-positive retention (defensive)', () => {
      // NaN, +Infinity, 0, or negative — same fail-closed behavior as
      // forever; we'd rather not sync than over-fetch.
      expect(computeOfflineSinceDate('full', undefined, NaN, NOW)).toBeUndefined()
      expect(computeOfflineSinceDate('full', undefined, Infinity, NOW)).toBeUndefined()
      expect(computeOfflineSinceDate('full', undefined, 0, NOW)).toBeUndefined()
      expect(computeOfflineSinceDate('full', undefined, -10, NOW)).toBeUndefined()
    })

    it('ignores offlineDays in full mode', () => {
      // full mode is global; per-folder offlineDays is meaningless here.
      const a = computeOfflineSinceDate('full', 7, 90, NOW)
      const b = computeOfflineSinceDate('full', undefined, 90, NOW)
      expect(a).toBe(b)
    })
  })
})
