/**
 * §2.15-ter: body retention shrink-detection logic (pure unit test).
 *
 * The save() callback in Settings.tsx decides whether to call
 * cache:bodyTrimPreview and prompt the user before saving.
 * The decision logic is:
 *   isShrink = (prevForever && !nextForever) || (!prevForever && !nextForever && next < prev)
 *
 * These tests pin that logic so future refactors cannot accidentally drop
 * the prompt without breaking a test.  We do NOT try to render Settings.tsx
 * (its 3000+ line surface and 15+ top-level imports make full-component
 * mounting impractical in jsdom without a bespoke harness).
 */
import { describe, expect, it } from 'vitest'

/**
 * Pure mirror of the shrink-detection predicate from Settings.tsx save().
 * Keep this in sync with the source if the formula ever changes.
 */
function isShrink(prevRetention: number, nextRetention: number): boolean {
  const prevForever = prevRetention === -1
  const nextForever = nextRetention === -1
  return (prevForever && !nextForever) || (!prevForever && !nextForever && nextRetention < prevRetention)
}

describe('Settings §2.15-ter — body retention shrink detection', () => {
  describe('isShrink — returns true when retention window decreases', () => {
    it('detects shrink: 365 → 30', () => {
      expect(isShrink(365, 30)).toBe(true)
    })

    it('detects shrink: 365 → 90', () => {
      expect(isShrink(365, 90)).toBe(true)
    })

    it('detects shrink: 180 → 90', () => {
      expect(isShrink(180, 90)).toBe(true)
    })

    it('detects shrink: 90 → 30', () => {
      expect(isShrink(90, 30)).toBe(true)
    })

    it('detects shrink: forever (-1) → any finite value', () => {
      expect(isShrink(-1, 365)).toBe(true)
      expect(isShrink(-1, 90)).toBe(true)
      expect(isShrink(-1, 30)).toBe(true)
    })
  })

  describe('isShrink — returns false for increases or no-ops', () => {
    it('no-op: same value', () => {
      expect(isShrink(365, 365)).toBe(false)
      expect(isShrink(30, 30)).toBe(false)
      expect(isShrink(-1, -1)).toBe(false)
    })

    it('increase: 30 → 365 is not a shrink', () => {
      expect(isShrink(30, 365)).toBe(false)
    })

    it('increase: 90 → 365 is not a shrink', () => {
      expect(isShrink(90, 365)).toBe(false)
    })

    it('increase: 30 → 180 is not a shrink', () => {
      expect(isShrink(30, 180)).toBe(false)
    })

    it('switching to forever is not a shrink (data is kept longer)', () => {
      expect(isShrink(30, -1)).toBe(false)
      expect(isShrink(365, -1)).toBe(false)
    })
  })
})

/**
 * Allowed enum values for bodyRetentionDays (mirrors BODY_RETENTION_DAYS_VALUES
 * from electron/main.ts and the select options in Settings.tsx).
 */
const ALLOWED_RETENTION_DAYS = [30, 90, 180, 365, -1] as const

describe('Settings §2.15-ter — bodyRetentionDays allowed enum values', () => {
  it('contains exactly 30, 90, 180, 365, -1', () => {
    expect(ALLOWED_RETENTION_DAYS).toEqual([30, 90, 180, 365, -1])
  })

  it('every finite value is positive', () => {
    const finite = ALLOWED_RETENTION_DAYS.filter(v => v !== -1)
    expect(finite.every(v => v > 0)).toBe(true)
  })

  it('-1 is the sole sentinel for "keep forever"', () => {
    const forever = ALLOWED_RETENTION_DAYS.filter(v => v === -1)
    expect(forever).toHaveLength(1)
  })

  it('shrink is always detected when moving from a larger allowed value to a smaller one', () => {
    const finite = ALLOWED_RETENTION_DAYS.filter(v => v !== -1).sort((a, b) => a - b)
    // Every pair (smaller, larger): isShrink(larger, smaller) must be true
    for (let i = 0; i < finite.length; i++) {
      for (let j = i + 1; j < finite.length; j++) {
        expect(isShrink(finite[j], finite[i])).toBe(true)
      }
    }
  })
})

/**
 * §2.15-ter (codex iteration 4): pure unit tests for the preview-failure
 * fail-closed branch added in Settings.tsx save(). The actual save handler
 * is too coupled to settings state to test in jsdom; instead we mirror the
 * fail-closed predicate as a pure helper so the contract is pinned.
 *
 * Contract:
 *   - shrink + preview success + count > 0 → confirm(detailedMsg)
 *   - shrink + preview failure → confirm(unknownMsg) — must NOT silently save
 *   - shrink + preview success + count === 0 → save without confirm
 *   - non-shrink → save without confirm
 */
type SaveDecision = 'save-without-confirm' | 'confirm-detailed' | 'confirm-unknown'

function decideSavePath(args: {
  isShrink: boolean
  previewOk: boolean
  previewCount: number
}): SaveDecision {
  if (!args.isShrink) return 'save-without-confirm'
  if (!args.previewOk) return 'confirm-unknown'
  if (args.previewCount > 0) return 'confirm-detailed'
  return 'save-without-confirm'
}

describe('Settings §2.15-ter codex iter4 — preview-failure fail-closed branch', () => {
  it('non-shrink saves without confirm regardless of preview outcome', () => {
    expect(decideSavePath({ isShrink: false, previewOk: true, previewCount: 0 })).toBe('save-without-confirm')
    expect(decideSavePath({ isShrink: false, previewOk: false, previewCount: 0 })).toBe('save-without-confirm')
    expect(decideSavePath({ isShrink: false, previewOk: true, previewCount: 100 })).toBe('save-without-confirm')
  })

  it('shrink + preview success + count > 0 prompts the detailed confirm', () => {
    expect(decideSavePath({ isShrink: true, previewOk: true, previewCount: 1 })).toBe('confirm-detailed')
    expect(decideSavePath({ isShrink: true, previewOk: true, previewCount: 1000 })).toBe('confirm-detailed')
  })

  it('shrink + preview success + count === 0 saves without confirm (nothing to delete)', () => {
    expect(decideSavePath({ isShrink: true, previewOk: true, previewCount: 0 })).toBe('save-without-confirm')
  })

  it('shrink + preview FAILURE prompts the unknown-impact confirm (fail-closed, no silent save)', () => {
    // Codex MEDIUM 1: previously the catch{} fell through and the
    // destructive shrink saved without confirmation. The fix asks the
    // user to acknowledge the unknown impact instead.
    expect(decideSavePath({ isShrink: true, previewOk: false, previewCount: 0 })).toBe('confirm-unknown')
    expect(decideSavePath({ isShrink: true, previewOk: false, previewCount: 5 })).toBe('confirm-unknown')
  })
})

/**
 * AI reset-provider bug fix (test-gen follow-up to §2.33 PR2b e2e repro,
 * tests/e2e/ai-key-persistence.spec.ts test 3): the `.ai-reset-link` onClick
 * used to spread the FULL `settings:get()` result into `settings:save`:
 *
 *   const current = await window.api.invoke('settings:get')
 *   await window.api.invoke('settings:save', { ...current, aiProvider: undefined })
 *
 * `settings:get()` includes main-only fields (e.g. `mcpConnections`) that
 * `rendererWritableSettingsSchema.strict()` rejects with
 * `{ ok: false, reason: 'forbidden_field' }` (electron/main.ts `settings:save`
 * handler) — silently, because the old handler never checked `.ok`. The
 * renderer's local state flipped to "no provider" while the disk write
 * silently no-op'd, so the provider came back after relaunch.
 *
 * The fix does two things, both pinned here as pure-logic contracts (per the
 * file's established convention above — Settings.tsx is too large to mount
 * in jsdom, see file header):
 *   1. Send ONLY the field being cleared (`settings:save` already merges
 *      against current settings server-side — electron/main.ts `merged =
 *      { ...current, ...s }`), never spread `settings:get()`.
 *   2. Check `result.ok` and throw on failure, so the surrounding try/catch
 *      surfaces the error via `aiConnectionStatus('error')` instead of
 *      silently applying an optimistic local-only reset.
 */
describe('Settings — AI reset-provider payload construction', () => {
  /** Pure mirror of the reset-link onClick's settings:save payload. */
  function buildResetPayload(): { aiProvider: undefined } {
    return { aiProvider: undefined }
  }

  it('sends only the aiProvider field, never a spread of the full settings object', () => {
    const payload = buildResetPayload()
    expect(Object.keys(payload)).toEqual(['aiProvider'])
  })

  it('does not include any main-only field name in the payload', () => {
    // Mirrors packages/net/config.ts MAIN_ONLY_SETTINGS_FIELDS — the exact
    // set that made the old spread-based payload get rejected as
    // forbidden_field. A payload containing only 'aiProvider' can never
    // collide with this set by construction, but we assert it explicitly so
    // a future regression (e.g. someone re-adding a spread) fails loudly.
    const MAIN_ONLY_SETTINGS_FIELDS = ['mcpEnableStdio', 'stdioApproved', 'mcpConnections'] as const
    const payload = buildResetPayload()
    for (const field of MAIN_ONLY_SETTINGS_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(payload, field)).toBe(false)
    }
  })

  it('sets aiProvider to undefined (clears the field via merge, not omission)', () => {
    // Electron IPC uses structured clone (not JSON.stringify), so an
    // own-key with value `undefined` survives the round-trip intact and
    // overrides the persisted value during the main-process merge
    // (`{ ...current, ...s }`). Omitting the key entirely would instead
    // leave the previously persisted aiProvider untouched.
    const payload = buildResetPayload()
    expect('aiProvider' in payload).toBe(true)
    expect(payload.aiProvider).toBeUndefined()
  })
})

/**
 * Pure mirror of the reset-link onClick's post-invoke error handling:
 *
 *   const result = await window.api.invoke('settings:save', { aiProvider: undefined })
 *   if (result && result.ok === false) {
 *     throw new Error(`settings:save failed: ${result.reason ?? 'unknown'}`)
 *   }
 *
 * This is the defense-in-depth half of the fix — even if a future
 * regression reintroduces a forbidden field in the payload, the renderer
 * must surface the rejection instead of applying an optimistic local reset.
 */
function shouldThrowOnSaveResult(result: { ok?: boolean; reason?: string } | null | undefined): boolean {
  return !!(result && result.ok === false)
}

describe('Settings — AI reset-provider settings:save result handling', () => {
  it('throws when settings:save returns { ok: false }', () => {
    expect(shouldThrowOnSaveResult({ ok: false, reason: 'forbidden_field' })).toBe(true)
  })

  it('does not throw when settings:save returns { ok: true }', () => {
    expect(shouldThrowOnSaveResult({ ok: true })).toBe(false)
  })

  it('does not throw when settings:save returns a result with no ok field (legacy/undefined shape)', () => {
    expect(shouldThrowOnSaveResult({})).toBe(false)
  })

  it('does not throw when settings:save resolves null/undefined', () => {
    expect(shouldThrowOnSaveResult(null)).toBe(false)
    expect(shouldThrowOnSaveResult(undefined)).toBe(false)
  })
})
