/**
 * §3.3 B2 Thread AI Summary — per-account opt-in toggle logic (pure unit test).
 *
 * The AI-tab toggle in Settings.tsx reads/writes a single entry in the
 * `aiThreadSummaryEnabled` Record keyed by stringified accountId, and the load
 * path normalizes any persisted shape so only strictly-true entries count as
 * opted in. Both are small pure transforms; we pin them here rather than
 * mounting Settings.tsx, whose 3000+ line surface and many top-level imports
 * make full-component mounting impractical in jsdom (same rationale as
 * Settings.bodyRetention.test.ts). Keep these mirrors in sync with the source.
 */
import { describe, expect, it } from 'vitest'

/**
 * Pure mirror of the checkbox `checked` predicate in the AI-tab toggle:
 *   checked={typeof accountId === 'number' && aiThreadSummaryEnabled[String(accountId)] === true}
 */
function isChecked(
  record: Record<string, boolean>,
  accountId: number | null,
): boolean {
  return typeof accountId === 'number' && record[String(accountId)] === true
}

/**
 * Pure mirror of the checkbox `onChange` writer:
 *   setAiThreadSummaryEnabled(prev => ({ ...prev, [String(accountId)]: next }))
 */
function writeToggle(
  record: Record<string, boolean>,
  accountId: number,
  next: boolean,
): Record<string, boolean> {
  return { ...record, [String(accountId)]: next }
}

/**
 * Pure mirror of the load-path normalization (both Settings.tsx and App.tsx):
 * only strictly-true entries survive; any other value/shape defaults OFF.
 */
function normalize(raw: unknown): Record<string, boolean> {
  if (raw && typeof raw === 'object') {
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v === true
    }
    return out
  }
  return {}
}

describe('Settings §3.3 B2 — Thread AI Summary per-account toggle', () => {
  describe('isChecked — reflects only the current account entry', () => {
    it('is false when the account has no entry (default OFF)', () => {
      expect(isChecked({}, 1)).toBe(false)
    })

    it('is false when the entry is explicitly false', () => {
      expect(isChecked({ '1': false }, 1)).toBe(false)
    })

    it('is true only when the entry is strictly true', () => {
      expect(isChecked({ '1': true }, 1)).toBe(true)
    })

    it('is scoped per account — account 2 unaffected by account 1', () => {
      const rec = { '1': true }
      expect(isChecked(rec, 1)).toBe(true)
      expect(isChecked(rec, 2)).toBe(false)
    })

    it('is false when no account is selected', () => {
      expect(isChecked({ '1': true }, null)).toBe(false)
    })
  })

  describe('writeToggle — updates only the selected account, preserves others', () => {
    it('turns the current account ON without touching siblings', () => {
      const next = writeToggle({ '2': true }, 1, true)
      expect(next).toEqual({ '1': true, '2': true })
    })

    it('turns the current account OFF without touching siblings', () => {
      const next = writeToggle({ '1': true, '2': true }, 1, false)
      expect(next).toEqual({ '1': false, '2': true })
    })

    it('does not mutate the previous record (new reference)', () => {
      const prev = { '1': true }
      const next = writeToggle(prev, 1, false)
      expect(next).not.toBe(prev)
      expect(prev).toEqual({ '1': true })
    })
  })

  describe('normalize — coerces persisted shapes to a boolean Record', () => {
    it('keeps strictly-true entries', () => {
      expect(normalize({ '1': true, '2': true })).toEqual({ '1': true, '2': true })
    })

    it('coerces truthy-but-not-true values to false (default OFF)', () => {
      expect(normalize({ '1': 'yes', '2': 1, '3': {} })).toEqual({
        '1': false,
        '2': false,
        '3': false,
      })
    })

    it('returns an empty Record for missing / non-object values', () => {
      expect(normalize(undefined)).toEqual({})
      expect(normalize(null)).toEqual({})
      expect(normalize('nonsense')).toEqual({})
    })
  })
})
