// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRecordMetric = vi.fn()
Object.defineProperty(window, 'api', {
  value: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    removeAll: vi.fn(),
    recordMetric: mockRecordMetric,
  },
  writable: true,
  configurable: true,
})

import { recordEvent, recordHistogram, recordGauge } from './metrics'

describe('renderer metrics bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('recordEvent', () => {
    it('sends event with correct name and kind', () => {
      recordEvent('compose.opened' as never)
      expect(mockRecordMetric).toHaveBeenCalledWith(
        'compose.opened',
        'event',
        null,
        undefined,
      )
    })

    it('passes tags through', () => {
      recordEvent('search.executed' as never, { query_len: '3-5' })
      expect(mockRecordMetric).toHaveBeenCalledWith(
        'search.executed',
        'event',
        null,
        { query_len: '3-5' },
      )
    })
  })

  describe('recordHistogram', () => {
    it('sends histogram with rounded value', () => {
      recordHistogram('app.startup_ms' as never, 1234.7)
      expect(mockRecordMetric).toHaveBeenCalledWith(
        'app.startup_ms',
        'histogram',
        1235,
        undefined,
      )
    })

    it('passes tags through', () => {
      recordHistogram('app.startup_ms' as never, 100, { accounts_count: 2 })
      expect(mockRecordMetric).toHaveBeenCalledWith(
        'app.startup_ms',
        'histogram',
        100,
        { accounts_count: 2 },
      )
    })
  })

  describe('recordGauge', () => {
    it('sends gauge with exact value', () => {
      recordGauge('app.accounts_count' as never, 3)
      expect(mockRecordMetric).toHaveBeenCalledWith(
        'app.accounts_count',
        'gauge',
        3,
        undefined,
      )
    })
  })

  describe('error safety', () => {
    it('does not throw when recordMetric throws', () => {
      mockRecordMetric.mockImplementation(() => { throw new Error('IPC dead') })
      expect(() => recordEvent('compose.opened' as never)).not.toThrow()
    })

    it('does not throw when window.api is undefined', () => {
      const saved = window.api
      Object.defineProperty(window, 'api', {
        value: undefined,
        writable: true,
        configurable: true,
      })

      expect(() => recordEvent('compose.opened' as never)).not.toThrow()
      expect(() => recordHistogram('app.startup_ms' as never, 100)).not.toThrow()
      expect(() => recordGauge('app.accounts_count' as never, 1)).not.toThrow()

      Object.defineProperty(window, 'api', {
        value: saved,
        writable: true,
        configurable: true,
      })
    })

    it('does not throw when recordMetric is undefined on api', () => {
      const saved = window.api
      Object.defineProperty(window, 'api', {
        value: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), removeAll: vi.fn() },
        writable: true,
        configurable: true,
      })

      expect(() => recordEvent('compose.opened' as never)).not.toThrow()

      Object.defineProperty(window, 'api', {
        value: saved,
        writable: true,
        configurable: true,
      })
    })
  })

  describe('re-exports from metricsBuckets', () => {
    it('re-exports bucket helpers', async () => {
      const mod = await import('./metrics')
      expect(mod.bucketQueryLen).toBeTypeOf('function')
      expect(mod.bucketResultCount).toBeTypeOf('function')
      expect(mod.bucketDuration).toBeTypeOf('function')
      expect(mod.bucketBodySize).toBeTypeOf('function')
      expect(mod.bucketFolderCount).toBeTypeOf('function')
      expect(mod.bucketFollowupDays).toBeTypeOf('function')
      expect(mod.bucketTimeSinceSync).toBeTypeOf('function')
      expect(mod.bucketSessionLength).toBeTypeOf('function')
      expect(mod.folderRoleFromPath).toBeTypeOf('function')
      expect(mod.providerFromHost).toBeTypeOf('function')
    })
  })
})
