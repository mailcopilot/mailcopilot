import { describe, it, expect } from 'vitest'
import { pruneUnknownAccountConsents, keepStoredConsents } from './accountKeyedConsents'

/**
 * §1.26.f2 — the write-side half of "a stored AI consent may only name a
 * mailbox that exists".
 *
 * The scenario these tests stand for: the settings window loads the four
 * consent maps once, an account is deleted (main purges its entries), and the
 * window's next ordinary save re-submits its stale snapshot. Without the prune
 * the purged `true` is merged back, and `max + 1` id reuse then hands it to a
 * mailbox whose owner was never asked.
 */
const FIELDS = [
  'aiThreadSummaryEnabled',
  'aiInstantReplyEnabled',
  'aiProofreadEnabled',
  'aiTranslateEnabled',
] as const

describe('pruneUnknownAccountConsents', () => {
  it('drops the entry a stale settings window re-submitted for a deleted mailbox', () => {
    const merged = {
      theme: 'dark',
      aiTranslateEnabled: { '1': true, '2': true },
      aiProofreadEnabled: { '2': true },
    }
    const result = pruneUnknownAccountConsents(merged, FIELDS, new Set([1]))

    expect(result.settings.aiTranslateEnabled).toEqual({ '1': true })
    expect(result.settings.aiProofreadEnabled).toEqual({})
    expect(result.droppedEntries).toBe(2)
    expect(result.changedFields).toEqual(['aiProofreadEnabled', 'aiTranslateEnabled'])
    // Every other field of the same save survives — the refusal is per entry,
    // not per payload (§2.167 form).
    expect(result.settings.theme).toBe('dark')
  })

  it('clears an entry an older build left in the store, not just one the payload carried', () => {
    // The prune runs over the MERGED object, so a stale entry that came from
    // `current` (never re-sent by any window) is cleaned by the same pass.
    const merged = { aiInstantReplyEnabled: { '7': true } }
    const result = pruneUnknownAccountConsents(merged, FIELDS, new Set([1, 2]))
    expect(result.settings.aiInstantReplyEnabled).toEqual({})
    expect(result.droppedEntries).toBe(1)
  })

  it('keeps a withdrawal on record for a live mailbox', () => {
    // `false` means "asked and refused" and is not noise to be tidied away.
    const merged = { aiTranslateEnabled: { '1': false, '2': true } }
    const result = pruneUnknownAccountConsents(merged, FIELDS, new Set([1, 2]))
    expect(result.settings.aiTranslateEnabled).toEqual({ '1': false, '2': true })
    expect(result.changedFields).toEqual([])
  })

  it('returns the same object when nothing was out of scope', () => {
    const merged = { aiTranslateEnabled: { '1': true } }
    const result = pruneUnknownAccountConsents(merged, FIELDS, new Set([1]))
    expect(result.settings).toBe(merged)
    expect(result.droppedEntries).toBe(0)
  })

  it('does not mutate the object it was given', () => {
    const map = { '1': true, '9': true }
    const merged = { aiTranslateEnabled: map }
    pruneUnknownAccountConsents(merged, FIELDS, new Set([1]))
    expect(map).toEqual({ '1': true, '9': true })
  })

  it('drops keys that are not the canonical form of a live id', () => {
    // Every writer keys with `String(accountId)` and `forgetAccountAiConsents`
    // deletes exactly that string, so these five shapes name a live mailbox in
    // a form nothing can withdraw. `1e100` is an integer to JS and is not an id.
    const merged = {
      aiTranslateEnabled: {
        '1': true,
        '01': true,
        '+1': true,
        ' 1': true,
        '1.0': true,
        '1e0': true,
        '1e100': true,
        '': true,
      },
    }
    const result = pruneUnknownAccountConsents(merged, FIELDS, new Set([1]))
    expect(result.settings.aiTranslateEnabled).toEqual({ '1': true })
    expect(result.droppedEntries).toBe(7)
  })

  it('leaves a field alone when its value is not a map', () => {
    // Narrowing a map is this module's job; deciding whether a non-map may be
    // persisted belongs to the two schemas around the handler.
    const merged = { aiTranslateEnabled: 5, aiProofreadEnabled: null }
    const result = pruneUnknownAccountConsents(merged, FIELDS, new Set([1]))
    expect(result.settings).toBe(merged)
    expect(result.changedFields).toEqual([])
  })

  it('empties every map when no mailbox is left', () => {
    const merged = { aiTranslateEnabled: { '1': true }, aiProofreadEnabled: { '1': true } }
    const result = pruneUnknownAccountConsents(merged, FIELDS, new Set<number>())
    expect(result.settings.aiTranslateEnabled).toEqual({})
    expect(result.settings.aiProofreadEnabled).toEqual({})
  })
})

describe('keepStoredConsents', () => {
  it('puts the stored map back when the payload carried one', () => {
    // The fallback for an unreadable account registry: no new grant is written,
    // and no recorded answer is destroyed.
    const stored = { aiTranslateEnabled: { '1': true } }
    const merged = { ...stored, aiTranslateEnabled: { '1': true, '2': true }, theme: 'dark' }
    const result = keepStoredConsents(merged, stored, FIELDS)

    expect(result.settings.aiTranslateEnabled).toBe(stored.aiTranslateEnabled)
    expect(result.settings.theme).toBe('dark')
    expect(result.changedFields).toEqual(['aiTranslateEnabled'])
    expect(result.droppedEntries).toBe(0)
  })

  it('does not withdraw anything when the registry cannot be read', () => {
    // Pruning against an empty set would be the safe DIRECTION and still wrong:
    // a transient read failure would silently erase every recorded answer.
    const stored = { aiTranslateEnabled: { '1': true }, aiProofreadEnabled: { '1': true } }
    const merged = { ...stored, aiTranslateEnabled: { '1': false } }
    const result = keepStoredConsents(merged, stored, FIELDS)
    expect(result.settings.aiTranslateEnabled).toEqual({ '1': true })
    expect(result.settings.aiProofreadEnabled).toEqual({ '1': true })
  })

  it('removes the key when the store has none', () => {
    const stored = {}
    const merged = { aiTranslateEnabled: { '2': true } }
    const result = keepStoredConsents(merged, stored, FIELDS)
    expect(Object.prototype.hasOwnProperty.call(result.settings, 'aiTranslateEnabled')).toBe(false)
  })

  it('returns the same object when the payload asked for no consent change', () => {
    const stored = { aiTranslateEnabled: { '1': true } }
    const merged = { ...stored, theme: 'dark' }
    const result = keepStoredConsents(merged, stored, FIELDS)
    expect(result.settings).toBe(merged)
    expect(result.changedFields).toEqual([])
  })
})
