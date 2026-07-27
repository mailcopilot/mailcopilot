import { describe, it, expect } from 'vitest'
import { isAiFeatureEnabledForAccount } from './aiAccountGate'

describe('isAiFeatureEnabledForAccount', () => {
  it('returns true when the map explicitly enables the account', () => {
    expect(isAiFeatureEnabledForAccount({ '1': true }, 1)).toBe(true)
  })

  it('returns false when the map explicitly disables the account', () => {
    expect(isAiFeatureEnabledForAccount({ '1': false }, 1)).toBe(false)
  })

  it('returns false (fail-closed) when the account has no entry in the map', () => {
    expect(isAiFeatureEnabledForAccount({ '2': true }, 1)).toBe(false)
  })

  it('returns false (fail-closed) when the map itself is undefined', () => {
    expect(isAiFeatureEnabledForAccount(undefined, 1)).toBe(false)
  })

  it('returns false (fail-closed) when the map is an empty object', () => {
    expect(isAiFeatureEnabledForAccount({}, 1)).toBe(false)
  })

  it('returns false (fail-closed) when accountId is null', () => {
    expect(isAiFeatureEnabledForAccount({ '1': true }, null)).toBe(false)
  })

  it('returns false (fail-closed) when accountId is undefined', () => {
    expect(isAiFeatureEnabledForAccount({ '1': true }, undefined)).toBe(false)
  })

  it('returns false when the map holds a truthy-but-not-strictly-true value for the account', () => {
    // The gate requires === true, not merely truthy — a stray '1'/1/'true'
    // string surviving a bad settings.json round-trip must still fail closed.
    expect(isAiFeatureEnabledForAccount({ '1': 'true' as unknown as boolean }, 1)).toBe(false)
    expect(isAiFeatureEnabledForAccount({ '1': 1 as unknown as boolean }, 1)).toBe(false)
  })

  it('keys the lookup by the STRINGIFIED accountId, distinguishing numerically-equal but differently-keyed accounts', () => {
    expect(isAiFeatureEnabledForAccount({ '10': true }, 10)).toBe(true)
    expect(isAiFeatureEnabledForAccount({ '10': true }, 1)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // M4 — cross-account thread gate. App.tsx resolves the ThreadView gate as
  // `isAiFeatureEnabledForAccount(map, active?.accountId ?? activeThread.lead?.accountId)`.
  // A cross-account thread can surface an active card whose account differs
  // from the thread's lead message — the gate MUST use the ACTIVE card's
  // account, never fall back to the lead, whenever `active` is present.
  // Gating on the lead would show/hide the strip for the wrong account.
  // -------------------------------------------------------------------------
  describe('M4 cross-account thread gate — active.accountId ?? activeThread.lead.accountId', () => {
    function resolveGateAccountId(
      active: { accountId: number } | null,
      leadAccountId: number | undefined,
    ): number | undefined {
      return active?.accountId ?? leadAccountId
    }

    it('uses the ACTIVE card account when active is set and differs from the thread lead', () => {
      const active = { accountId: 2 }
      const leadAccountId = 1
      const map = { '1': true, '2': false }
      const resolved = resolveGateAccountId(active, leadAccountId)
      expect(resolved).toBe(2)
      // Enabled for the lead's account (1) but the active card's account (2)
      // is OFF — the gate must reflect the ACTIVE account, i.e. false.
      expect(isAiFeatureEnabledForAccount(map, resolved)).toBe(false)
    })

    it('enables the strip when the active card account (not the lead) is opted in', () => {
      const active = { accountId: 2 }
      const leadAccountId = 1
      const map = { '1': false, '2': true }
      const resolved = resolveGateAccountId(active, leadAccountId)
      expect(resolved).toBe(2)
      expect(isAiFeatureEnabledForAccount(map, resolved)).toBe(true)
    })

    it('falls back to the thread lead account only when active is null (no card open yet)', () => {
      const leadAccountId = 1
      const map = { '1': true }
      const resolved = resolveGateAccountId(null, leadAccountId)
      expect(resolved).toBe(1)
      expect(isAiFeatureEnabledForAccount(map, resolved)).toBe(true)
    })

    it('resolves to undefined (fail-closed) when both active and the lead account are absent', () => {
      const resolved = resolveGateAccountId(null, undefined)
      expect(resolved).toBeUndefined()
      expect(isAiFeatureEnabledForAccount({ '1': true }, resolved)).toBe(false)
    })
  })
})
