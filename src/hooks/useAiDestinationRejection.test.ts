// @vitest-environment jsdom
/**
 * Unit tests for src/hooks/useAiDestinationRejection.ts — BACKLOG §2.119.
 *
 * The single load-bearing claim: a `settings:save` reply that carries
 * `aiDestinationRejected` is NOT a completed save. Everything else here
 * (per-reason parsing, malformed payload tolerance) exists to keep that claim
 * true for replies this build did not anticipate.
 */
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  parseAiDestinationRejection,
  useAiDestinationRejection,
} from './useAiDestinationRejection'

const REASONS = ['declined', 'invalid', 'busy'] as const

describe('§2.119 parseAiDestinationRejection', () => {
  it('returns null for a plain successful save', () => {
    expect(parseAiDestinationRejection({ ok: true })).toBeNull()
  })

  it('returns null for replies that are not objects', () => {
    expect(parseAiDestinationRejection(undefined)).toBeNull()
    expect(parseAiDestinationRejection(null)).toBeNull()
    expect(parseAiDestinationRejection('ok')).toBeNull()
    expect(parseAiDestinationRejection(42)).toBeNull()
  })

  it.each(REASONS)('carries reason, fields and main\'s message for %s', reason => {
    const parsed = parseAiDestinationRejection({
      ok: true,
      aiDestinationRejected: {
        reason,
        fields: ['aiOpenAiBaseUrl'],
        message: `localized ${reason}`,
      },
    })
    expect(parsed).toEqual({
      reason,
      fields: ['aiOpenAiBaseUrl'],
      message: `localized ${reason}`,
    })
  })

  it('keeps both fields when both addresses were held back', () => {
    const parsed = parseAiDestinationRejection({
      ok: true,
      aiDestinationRejected: {
        reason: 'declined',
        fields: ['aiOpenAiBaseUrl', 'aiProxyUrl'],
        message: 'm',
      },
    })
    expect(parsed?.fields).toEqual(['aiOpenAiBaseUrl', 'aiProxyUrl'])
  })

  it('drops field names it does not know instead of rendering them', () => {
    const parsed = parseAiDestinationRejection({
      ok: true,
      aiDestinationRejected: { reason: 'declined', fields: ['aiProxyUrl', 'nope', 7], message: 'm' },
    })
    expect(parsed?.fields).toEqual(['aiProxyUrl'])
  })

  // REGRESSION GUARD — a future main with a fourth reason must not be read as
  // a success. That would silently reinstate the closed-window-on-refusal bug.
  it('still reports a rejection when the reason is unknown', () => {
    const parsed = parseAiDestinationRejection({
      ok: true,
      aiDestinationRejected: { reason: 'quantum', fields: ['aiProxyUrl'], message: 'm' },
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.reason).toBe('declined')
    expect(parsed?.message).toBe('m')
  })

  it('still reports a rejection when message and fields are missing', () => {
    const parsed = parseAiDestinationRejection({ ok: true, aiDestinationRejected: {} })
    expect(parsed).toEqual({ reason: 'declined', fields: [], message: '' })
  })

  it('never invents a message of its own', () => {
    const parsed = parseAiDestinationRejection({
      ok: true,
      aiDestinationRejected: { reason: 'invalid', fields: ['aiProxyUrl'], message: 12 },
    })
    expect(parsed?.message).toBe('')
  })
})

describe('§2.119 useAiDestinationRejection', () => {
  it('starts with nothing to show', () => {
    const { result } = renderHook(() => useAiDestinationRejection())
    expect(result.current.aiDestinationRejection).toBeNull()
  })

  // REGRESSION GUARD — the boolean is what the caller uses to decide whether to
  // close the settings window.
  it('reports a clean save as applied and shows no notice', () => {
    const { result } = renderHook(() => useAiDestinationRejection())
    let applied = false
    act(() => { applied = result.current.recordSettingsSaveResult({ ok: true }) })
    expect(applied).toBe(true)
    expect(result.current.aiDestinationRejection).toBeNull()
  })

  it.each(REASONS)('reports %s as not applied and raises the notice', reason => {
    const { result } = renderHook(() => useAiDestinationRejection())
    let applied = true
    act(() => {
      applied = result.current.recordSettingsSaveResult({
        ok: true,
        aiDestinationRejected: { reason, fields: ['aiProxyUrl'], message: 'from main' },
      })
    })
    expect(applied).toBe(false)
    expect(result.current.aiDestinationRejection).toEqual({
      reason,
      fields: ['aiProxyUrl'],
      message: 'from main',
    })
  })

  it('clears a stale notice once a later save goes through', () => {
    const { result } = renderHook(() => useAiDestinationRejection())
    act(() => {
      result.current.recordSettingsSaveResult({
        ok: true,
        aiDestinationRejected: { reason: 'busy', fields: ['aiProxyUrl'], message: 'busy' },
      })
    })
    expect(result.current.aiDestinationRejection).not.toBeNull()
    act(() => { result.current.recordSettingsSaveResult({ ok: true }) })
    expect(result.current.aiDestinationRejection).toBeNull()
  })

  it('clears on request', () => {
    const { result } = renderHook(() => useAiDestinationRejection())
    act(() => {
      result.current.recordSettingsSaveResult({
        ok: true,
        aiDestinationRejected: { reason: 'invalid', fields: [], message: 'bad' },
      })
    })
    act(() => { result.current.clearAiDestinationRejection() })
    expect(result.current.aiDestinationRejection).toBeNull()
  })
})
