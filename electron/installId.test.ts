import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory store that simulates electron-store.
const storeData = new Map<string, unknown>()
vi.mock('electron-store', () => ({
  default: class MockStore {
    get(key: string) { return storeData.get(key) }
    set(key: string, value: unknown) { storeData.set(key, value) }
    delete(key: string) { storeData.delete(key) }
  },
}))

import {
  getInstallIdHash,
  getLastSeenAppVersion,
  setLastSeenAppVersion,
  markFirstHeadersSync,
  getFirstHeadersSyncAt,
  markFirstMessageOpened,
  markAccountSeen,
  getAccountSeenAt,
  resetInstallIdCache,
} from './installId'

describe('installId', () => {
  beforeEach(() => {
    storeData.clear()
    resetInstallIdCache()
  })

  describe('getInstallIdHash', () => {
    it('returns a 16-char hex string', () => {
      const hash = getInstallIdHash()
      expect(hash).toMatch(/^[0-9a-f]{16}$/)
    })

    it('returns the same hash on repeated calls (cached)', () => {
      const h1 = getInstallIdHash()
      const h2 = getInstallIdHash()
      expect(h1).toBe(h2)
    })

    it('persists install id to store and reuses it across resets', () => {
      const h1 = getInstallIdHash()
      // Reset in-memory cache but keep store data — simulates app restart.
      resetInstallIdCache()
      const h2 = getInstallIdHash()
      expect(h1).toBe(h2)
    })

    it('generates a new id if store is empty', () => {
      const h1 = getInstallIdHash()
      // Clear everything including persisted data — simulates fresh install.
      storeData.clear()
      resetInstallIdCache()
      const h2 = getInstallIdHash()
      // Different raw UUID → different hash (with overwhelming probability).
      expect(h2).toMatch(/^[0-9a-f]{16}$/)
      expect(h2).not.toBe(h1)
    })
  })

  describe('getLastSeenAppVersion / setLastSeenAppVersion', () => {
    it('returns null when no version is stored', () => {
      expect(getLastSeenAppVersion()).toBeNull()
    })

    it('returns the stored version', () => {
      setLastSeenAppVersion('2.1.0')
      // Reset cache to force re-read from store.
      resetInstallIdCache()
      expect(getLastSeenAppVersion()).toBe('2.1.0')
    })

    it('returns null for empty string value', () => {
      storeData.set('metrics.lastVersion', '')
      resetInstallIdCache()
      expect(getLastSeenAppVersion()).toBeNull()
    })
  })

  describe('markFirstHeadersSync', () => {
    it('returns timestamp on first call for an account', () => {
      const ts = markFirstHeadersSync(1)
      expect(ts).toBeTypeOf('number')
      expect(ts!).toBeGreaterThan(0)
    })

    it('returns null on subsequent calls for the same account', () => {
      markFirstHeadersSync(1)
      expect(markFirstHeadersSync(1)).toBeNull()
    })

    it('tracks accounts independently', () => {
      const ts1 = markFirstHeadersSync(1)
      const ts2 = markFirstHeadersSync(2)
      expect(ts1).toBeTypeOf('number')
      expect(ts2).toBeTypeOf('number')
      expect(markFirstHeadersSync(1)).toBeNull()
      expect(markFirstHeadersSync(2)).toBeNull()
    })
  })

  describe('getFirstHeadersSyncAt', () => {
    it('returns null when account has no sync record', () => {
      expect(getFirstHeadersSyncAt(999)).toBeNull()
    })

    it('returns the timestamp after markFirstHeadersSync', () => {
      const ts = markFirstHeadersSync(1)!
      expect(getFirstHeadersSyncAt(1)).toBe(ts)
    })
  })

  describe('markFirstMessageOpened', () => {
    it('returns true on first call', () => {
      expect(markFirstMessageOpened()).toBe(true)
    })

    it('returns false on subsequent calls', () => {
      markFirstMessageOpened()
      expect(markFirstMessageOpened()).toBe(false)
    })

    it('persists across cache resets', () => {
      markFirstMessageOpened()
      resetInstallIdCache()
      expect(markFirstMessageOpened()).toBe(false)
    })
  })

  describe('markAccountSeen / getAccountSeenAt', () => {
    it('returns null for unseen account', () => {
      expect(getAccountSeenAt(42)).toBeNull()
    })

    it('records first-seen timestamp', () => {
      markAccountSeen(1)
      const ts = getAccountSeenAt(1)
      expect(ts).toBeTypeOf('number')
      expect(ts!).toBeGreaterThan(0)
    })

    it('does not overwrite on repeated calls', () => {
      markAccountSeen(1)
      const ts1 = getAccountSeenAt(1)
      // Wait a tiny bit (Date.now resolution) — the point is the value should stay.
      markAccountSeen(1)
      const ts2 = getAccountSeenAt(1)
      expect(ts2).toBe(ts1)
    })

    it('tracks accounts independently', () => {
      markAccountSeen(1)
      markAccountSeen(2)
      expect(getAccountSeenAt(1)).toBeTypeOf('number')
      expect(getAccountSeenAt(2)).toBeTypeOf('number')
      expect(getAccountSeenAt(3)).toBeNull()
    })
  })
})
