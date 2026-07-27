import { describe, it, expect, beforeEach } from 'vitest'
import {
  featureReach,
  markFeatureReachFromEvent,
  markFeatureUsed,
  resetFeatureReach,
} from './featureReach'

describe('featureReach', () => {
  beforeEach(() => {
    resetFeatureReach()
  })

  describe('initial state', () => {
    it('all features are false after reset', () => {
      for (const v of Object.values(featureReach)) {
        expect(v).toBe(false)
      }
    })
  })

  describe('markFeatureReachFromEvent', () => {
    it('marks search for search.* events', () => {
      markFeatureReachFromEvent('search.executed')
      expect(featureReach.search).toBe(true)
    })

    it('marks search for any search-prefixed event', () => {
      markFeatureReachFromEvent('search.fts_query')
      expect(featureReach.search).toBe(true)
    })

    it('marks compose for compose.opened', () => {
      markFeatureReachFromEvent('compose.opened')
      expect(featureReach.compose).toBe(true)
    })

    it('marks compose for send_queue.* events', () => {
      markFeatureReachFromEvent('send_queue.enqueued')
      expect(featureReach.compose).toBe(true)
    })

    it('marks compose for misdirection.* events', () => {
      markFeatureReachFromEvent('misdirection.detected')
      expect(featureReach.compose).toBe(true)
    })

    it('marks templates for template.applied', () => {
      markFeatureReachFromEvent('template.applied')
      expect(featureReach.templates).toBe(true)
    })

    it('marks followup for followup.* events', () => {
      markFeatureReachFromEvent('followup.created')
      expect(featureReach.followup).toBe(true)
    })

    it('is a no-op for unrelated events', () => {
      markFeatureReachFromEvent('app.updated')
      markFeatureReachFromEvent('imap.sync_completed')
      markFeatureReachFromEvent('')
      for (const v of Object.values(featureReach)) {
        expect(v).toBe(false)
      }
    })

    it('does not mark other features when marking one', () => {
      markFeatureReachFromEvent('search.executed')
      expect(featureReach.search).toBe(true)
      expect(featureReach.compose).toBe(false)
      expect(featureReach.templates).toBe(false)
      expect(featureReach.followup).toBe(false)
    })

    it('is idempotent — repeated calls stay true', () => {
      markFeatureReachFromEvent('search.executed')
      markFeatureReachFromEvent('search.executed')
      expect(featureReach.search).toBe(true)
    })
  })

  describe('markFeatureUsed', () => {
    it('marks ai feature directly', () => {
      markFeatureUsed('ai')
      expect(featureReach.ai).toBe(true)
    })

    it('marks snooze feature directly', () => {
      markFeatureUsed('snooze')
      expect(featureReach.snooze).toBe(true)
    })

    it('marks read_later feature directly', () => {
      markFeatureUsed('read_later')
      expect(featureReach.read_later).toBe(true)
    })

    it('marks rules feature directly', () => {
      markFeatureUsed('rules')
      expect(featureReach.rules).toBe(true)
    })

    it('is idempotent', () => {
      markFeatureUsed('ai')
      markFeatureUsed('ai')
      expect(featureReach.ai).toBe(true)
    })
  })

  describe('resetFeatureReach', () => {
    it('clears all flags back to false', () => {
      markFeatureUsed('ai')
      markFeatureUsed('snooze')
      markFeatureReachFromEvent('search.executed')
      markFeatureReachFromEvent('compose.opened')

      resetFeatureReach()

      for (const v of Object.values(featureReach)) {
        expect(v).toBe(false)
      }
    })
  })
})
