/**
 * Tests for the §3.10 P1 AI egress policy.
 *
 * Coverage matrix (kept tight to behaviour, not internals):
 *   - hasEmailContext: every EmailContext shape — null/undefined, empty
 *     compose, non-empty compose, selected email, thread, folder, multi-select.
 *   - createEgressGate / shouldDenyEgress: secure-by-default after wave 2.
 *     Default-deny denies regardless of email context, taint, or anything
 *     else; only `policy='allow'` or `perRequestConsent` lift the gate.
 *   - markEmailDataAccessed: tool name normalisation, idempotence, and
 *     the wave-2 invariant that taint is observability-only (does NOT
 *     change the gate).
 *   - computeAllowedTools / computeBuiltinTools / filterVercelTools: the
 *     exact set of tools stripped under deny, exact preservation under allow.
 *   - egressBlockedResponse: shape and absence of PII.
 *   - Telemetry helpers do not throw if recordEvent is missing/broken.
 *   - coerceEgressPolicy: defends against legacy / malformed settings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock recordEvent so we can assert telemetry calls without booting the
// metrics pipeline. The module under test imports it from '../metrics'.
const recordEventMock = vi.hoisted(() => vi.fn())
vi.mock('../metrics', () => ({
  recordEvent: recordEventMock,
}))

// createLogger is harmless but importing electron-log indirectly under
// vitest can be noisy; stub the logger module.
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import {
  EGRESS_TOOLS,
  EMAIL_DATA_TOOLS,
  isEgressTool,
  isEmailDataTool,
  hasEmailContext,
  createEgressGate,
  markEmailDataAccessed,
  shouldDenyEgress,
  computeAllowedTools,
  computeBuiltinTools,
  filterVercelTools,
  egressBlockedResponse,
  recordEgressBlocked,
  recordEgressAllowedOnce,
  coerceEgressPolicy,
  defaultEgressPolicy,
} from './aiEgressPolicy'
import type { EmailContext } from './ai'

beforeEach(() => {
  recordEventMock.mockReset()
})

describe('aiEgressPolicy / catalogues', () => {
  it('EGRESS_TOOLS lists every outbound tool exactly once', () => {
    expect(EGRESS_TOOLS).toEqual([
      'WebSearch',
      'WebFetch',
      'mcp__mailcopilot__list_external_tools',
      'mcp__mailcopilot__call_external_tool',
    ])
    // No duplicates
    expect(new Set(EGRESS_TOOLS).size).toBe(EGRESS_TOOLS.length)
  })

  it('EMAIL_DATA_TOOLS contains every read-side mailcopilot tool', () => {
    // Spot-check the canonical members. The full list is asserted by the
    // caller test (every mcp tool that calls user-data DB read).
    for (const name of [
      'get_email', 'list_emails', 'search_emails', 'get_thread',
      'get_contacts', 'list_attachments', 'read_attachment', 'query_db',
    ]) {
      expect(EMAIL_DATA_TOOLS.has(name)).toBe(true)
    }
  })

  it('isEgressTool matches only outbound tools', () => {
    expect(isEgressTool('WebSearch')).toBe(true)
    expect(isEgressTool('WebFetch')).toBe(true)
    expect(isEgressTool('mcp__mailcopilot__list_external_tools')).toBe(true)
    expect(isEgressTool('mcp__mailcopilot__call_external_tool')).toBe(true)
    expect(isEgressTool('mcp__mailcopilot__get_email')).toBe(false)
    expect(isEgressTool('')).toBe(false)
  })

  it('isEmailDataTool matches both bare and prefixed names', () => {
    expect(isEmailDataTool('get_email')).toBe(true)
    expect(isEmailDataTool('mcp__mailcopilot__get_email')).toBe(true)
    expect(isEmailDataTool('search_emails')).toBe(true)
    expect(isEmailDataTool('mcp__mailcopilot__query_db')).toBe(true)
    // Mutating tools are NOT email-data tools (they don't read mail by themselves)
    expect(isEmailDataTool('apply_mail_action')).toBe(false)
    expect(isEmailDataTool('WebSearch')).toBe(false)
    expect(isEmailDataTool('')).toBe(false)
  })
})

describe('hasEmailContext', () => {
  it('returns false for null/undefined/non-object data', () => {
    expect(hasEmailContext(null)).toBe(false)
    expect(hasEmailContext(undefined)).toBe(false)
    expect(hasEmailContext({ type: 'email', data: null })).toBe(false)
    expect(hasEmailContext({ type: 'email', data: undefined })).toBe(false)
  })

  it('returns true for non-empty selected email / thread / folder data', () => {
    expect(hasEmailContext({ type: 'email', data: { accountId: 1, folder: 'INBOX', uid: 42 } })).toBe(true)
    expect(hasEmailContext({ type: 'thread', data: { threadId: 't-1', uids: [1, 2] } })).toBe(true)
    expect(hasEmailContext({ type: 'folder', data: { folder: 'INBOX', count: 10 } })).toBe(true)
    expect(hasEmailContext({ type: 'multi-select', data: [{ uid: 1 }, { uid: 2 }] })).toBe(true)
  })

  it('compose context: empty string fields => false, any non-empty field => true', () => {
    expect(hasEmailContext({ type: 'compose', data: {} })).toBe(false)
    expect(hasEmailContext({ type: 'compose', data: { to: '', subject: '', body: '' } })).toBe(false)
    expect(hasEmailContext({ type: 'compose', data: { to: '', subject: 'Hi', body: '' } })).toBe(true)
    expect(hasEmailContext({ type: 'compose', data: { to: ['a@b.com'], subject: '', body: '' } })).toBe(true)
  })

  it('handles primitive data values', () => {
    expect(hasEmailContext({ type: 'email', data: '' })).toBe(false)
    expect(hasEmailContext({ type: 'email', data: 'something' })).toBe(true)
    expect(hasEmailContext({ type: 'email', data: 0 })).toBe(true)
    expect(hasEmailContext({ type: 'email', data: false })).toBe(true)
    expect(hasEmailContext({ type: 'email', data: [] })).toBe(false)
  })
})

describe('coerceEgressPolicy', () => {
  it('passes through valid policies', () => {
    expect(coerceEgressPolicy('default-deny')).toBe('default-deny')
    expect(coerceEgressPolicy('ask')).toBe('ask')
    expect(coerceEgressPolicy('allow')).toBe('allow')
  })

  it('defaults to default-deny for legacy/missing/garbage', () => {
    expect(coerceEgressPolicy(undefined)).toBe('default-deny')
    expect(coerceEgressPolicy(null)).toBe('default-deny')
    expect(coerceEgressPolicy('')).toBe('default-deny')
    expect(coerceEgressPolicy('block')).toBe('default-deny') // unknown
    expect(coerceEgressPolicy(42)).toBe('default-deny')
    expect(defaultEgressPolicy()).toBe('default-deny')
  })
})

describe('createEgressGate / shouldDenyEgress', () => {
  it('allow policy never denies — even with email context AND no consent', () => {
    const gate = createEgressGate({
      policy: 'allow',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    expect(shouldDenyEgress(gate)).toBe(false)
  })

  it('default-deny: denies when email context present and no consent', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    expect(shouldDenyEgress(gate)).toBe(true)
  })

  it('default-deny denies even when context empty AND no taint AND no consent (wave 2)', () => {
    // Wave 2 (2026-04-24): clean-context requests are NO LONGER allowed
    // by default. The SDK's tools[] is fixed at query() construction; if we
    // started clean and the model called get_email mid-turn, the SDK
    // already shipped WebFetch. Closing that vector requires deny-by-default
    // independent of context.
    const gate = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    expect(shouldDenyEgress(gate)).toBe(true)
  })

  it('default-deny: per-request consent overrides denial', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'thread', data: { threadId: 't-1' } } as EmailContext,
      perRequestConsent: true,
    })
    expect(shouldDenyEgress(gate)).toBe(false)
  })

  it('ask policy behaves like default-deny in the data layer', () => {
    // Wave 2 (2026-04-24): ask now denies unconditionally without consent.
    // The empty-context branch matches `default-deny`'s post-wave-2 behaviour.
    const denied = createEgressGate({
      policy: 'ask',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    expect(shouldDenyEgress(denied)).toBe(true)
    const stillDeniedNoCtx = createEgressGate({
      policy: 'ask',
      context: null,
      perRequestConsent: false,
    })
    expect(shouldDenyEgress(stillDeniedNoCtx)).toBe(true)
  })

  it('taint propagation does not change the gate (wave 2 — observability only)', () => {
    // Wave 2 (2026-04-24): taint flag is bookkeeping. The gate was already
    // denying egress under default-deny without consent; flipping the
    // taint flag must not regress that decision (ban) and must not lift it.
    const gate = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    expect(shouldDenyEgress(gate)).toBe(true) // already denied
    markEmailDataAccessed(gate, 'mcp__mailcopilot__search_emails')
    expect(gate.taintedByToolUse).toBe(true)
    expect(shouldDenyEgress(gate)).toBe(true) // still denied
  })

  it('taint flag is set only by email-data tools, not by mutating or unrelated names', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    markEmailDataAccessed(gate, 'mcp__mailcopilot__apply_mail_action')
    expect(gate.taintedByToolUse).toBe(false)
    markEmailDataAccessed(gate, 'WebSearch')
    expect(gate.taintedByToolUse).toBe(false)
    markEmailDataAccessed(gate, '')
    expect(gate.taintedByToolUse).toBe(false)
    markEmailDataAccessed(gate, 'unknown_tool')
    expect(gate.taintedByToolUse).toBe(false)
  })

  it('taint propagation is idempotent (no surprise from multiple calls)', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    markEmailDataAccessed(gate, 'mcp__mailcopilot__get_email')
    markEmailDataAccessed(gate, 'mcp__mailcopilot__list_emails')
    markEmailDataAccessed(gate, 'get_thread')
    expect(gate.taintedByToolUse).toBe(true)
  })

  it('per-request consent unlocks egress regardless of taint state', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: true,
    })
    markEmailDataAccessed(gate, 'mcp__mailcopilot__search_emails')
    expect(gate.taintedByToolUse).toBe(true)
    expect(shouldDenyEgress(gate)).toBe(false)
  })

  it('wave 2 — multi-step attack within a single query is blocked structurally', () => {
    // Threat model the wave 2 fix closes:
    //   turn 1 starts with no email context => old gate would have allowed
    //   tools[] to include WebFetch.
    //   turn 1 calls get_email mid-stream => taint flips, but SDK has
    //   already locked tools[] for the query lifetime.
    //   turn 1 calls WebFetch => SDK still has it available => exfil.
    //
    // After wave 2: clean-context default-deny gate denies before query()
    // even constructs. computeBuiltinTools and computeAllowedTools both
    // strip egress tools at query start. SDK never sees WebFetch.
    const gate = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    // Pre-flight gate decision (computed once before SDK query() is built).
    expect(shouldDenyEgress(gate)).toBe(true)
    // Even after taint propagates (which would have lifted gating in the
    // pre-wave-2 model), the gate stays closed. Note: in the live runtime
    // the SDK's tools[] are already fixed by this point — taint cannot
    // revoke them mid-call, so the structural fix is the pre-flight deny.
    markEmailDataAccessed(gate, 'mcp__mailcopilot__get_email')
    expect(shouldDenyEgress(gate)).toBe(true)
  })
})

describe('computeAllowedTools', () => {
  const baseAllowed = [
    'mcp__mailcopilot__get_email',
    'mcp__mailcopilot__search_emails',
    'mcp__mailcopilot__apply_mail_action',
    'mcp__mailcopilot__list_external_tools',
    'mcp__mailcopilot__call_external_tool',
    'WebSearch',
    'WebFetch',
  ]

  it('returns full list under allow policy', () => {
    const gate = createEgressGate({ policy: 'allow', context: null, perRequestConsent: false })
    expect(computeAllowedTools(baseAllowed, gate)).toEqual(baseAllowed)
  })

  it('strips egress tools when default-deny + no context (wave 2 — secure-by-default)', () => {
    // Wave 2 (2026-04-24): default-deny denies even with no email context.
    // The SDK's tools[] is fixed at query start, so the safe default is to
    // never include egress tools without explicit user consent.
    const gate = createEgressGate({ policy: 'default-deny', context: null, perRequestConsent: false })
    const filtered = computeAllowedTools(baseAllowed, gate)
    expect(filtered).not.toContain('WebSearch')
    expect(filtered).not.toContain('WebFetch')
    expect(filtered).not.toContain('mcp__mailcopilot__list_external_tools')
    expect(filtered).not.toContain('mcp__mailcopilot__call_external_tool')
    // Non-egress tools preserved.
    expect(filtered).toContain('mcp__mailcopilot__get_email')
    expect(filtered).toContain('mcp__mailcopilot__apply_mail_action')
  })

  it('strips egress tools when default-deny + email context', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    const filtered = computeAllowedTools(baseAllowed, gate)
    expect(filtered).toContain('mcp__mailcopilot__get_email')
    expect(filtered).toContain('mcp__mailcopilot__apply_mail_action')
    expect(filtered).not.toContain('WebSearch')
    expect(filtered).not.toContain('WebFetch')
    expect(filtered).not.toContain('mcp__mailcopilot__list_external_tools')
    expect(filtered).not.toContain('mcp__mailcopilot__call_external_tool')
  })

  it('returns full list when consent overrides denial', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'thread', data: { threadId: 't-1' } } as EmailContext,
      perRequestConsent: true,
    })
    expect(computeAllowedTools(baseAllowed, gate)).toEqual(baseAllowed)
  })

  it('returns a fresh array (does not mutate input)', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    const out = computeAllowedTools(baseAllowed, gate)
    expect(out).not.toBe(baseAllowed)
    // Original untouched
    expect(baseAllowed).toContain('WebSearch')
  })
})

describe('computeBuiltinTools', () => {
  it('returns [WebSearch, WebFetch] when egress allowed', () => {
    const gate = createEgressGate({ policy: 'allow', context: null, perRequestConsent: false })
    expect(computeBuiltinTools(gate)).toEqual(['WebSearch', 'WebFetch'])
  })

  it('returns [] when egress denied', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    expect(computeBuiltinTools(gate)).toEqual([])
  })
})

describe('filterVercelTools', () => {
  const sampleTools = {
    'mcp__mailcopilot__get_email': { description: 'Get email', schema: {} },
    'mcp__mailcopilot__search_emails': { description: 'Search', schema: {} },
    'mcp__mailcopilot__apply_mail_action': { description: 'Apply', schema: {} },
    'mcp__mailcopilot__list_external_tools': { description: 'List ext', schema: {} },
    'mcp__mailcopilot__call_external_tool': { description: 'Call ext', schema: {} },
  }

  it('passes through unchanged when egress allowed', () => {
    const gate = createEgressGate({ policy: 'allow', context: null, perRequestConsent: false })
    expect(filterVercelTools(sampleTools, gate)).toBe(sampleTools)
  })

  it('strips external_tools entries when egress denied', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    const out = filterVercelTools(sampleTools, gate)
    expect(out).toHaveProperty('mcp__mailcopilot__get_email')
    expect(out).toHaveProperty('mcp__mailcopilot__search_emails')
    expect(out).toHaveProperty('mcp__mailcopilot__apply_mail_action')
    expect(out).not.toHaveProperty('mcp__mailcopilot__list_external_tools')
    expect(out).not.toHaveProperty('mcp__mailcopilot__call_external_tool')
  })

  it('strips bare-name external tool entries (Vercel @ai-sdk/mcp shape)', () => {
    // Wave 3 BLOCKER fix (codex-security-review, 2026-04-24): @ai-sdk/mcp
    // exposes mailcopilot tools by their *bare* MCP name (no Claude-style
    // `mcp__mailcopilot__` prefix). Previously `filterVercelTools` only
    // stripped the prefixed form, so bare-keyed `list_external_tools` and
    // `call_external_tool` survived into `streamText({ tools })` and
    // reached OpenAI / Gemini. The handler-side `egressBlockedResponse`
    // guard still caught the actual exfil attempt, but §3.10 P1 AC is
    // structural removal at the SDK layer.
    const realisticVercelTools = {
      get_email: { description: 'Get email', schema: {} },
      search_emails: { description: 'Search', schema: {} },
      apply_mail_action: { description: 'Apply', schema: {} },
      // The two egress vectors as advertised by the Vercel client:
      list_external_tools: { description: 'List external', schema: {} },
      call_external_tool: { description: 'Call external', schema: {} },
    }
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    const out = filterVercelTools(realisticVercelTools, gate)
    expect(out).toHaveProperty('get_email')
    expect(out).toHaveProperty('search_emails')
    expect(out).toHaveProperty('apply_mail_action')
    expect(out).not.toHaveProperty('list_external_tools')
    expect(out).not.toHaveProperty('call_external_tool')
  })

  it('strips both bare and prefixed forms in a mixed map (defence-in-depth)', () => {
    // Some MCP client shapes might surface BOTH the prefixed and bare keys
    // for the same tool (older / newer @ai-sdk/mcp versions, custom mounts).
    // Both forms must be stripped — the predicate is form-agnostic.
    const mixed = {
      mcp__mailcopilot__list_external_tools: { description: 'prefixed list' },
      list_external_tools: { description: 'bare list' },
      mcp__mailcopilot__call_external_tool: { description: 'prefixed call' },
      call_external_tool: { description: 'bare call' },
      get_email: { description: 'bare safe' },
      mcp__mailcopilot__get_email: { description: 'prefixed safe' },
    }
    const gate = createEgressGate({
      policy: 'default-deny',
      context: null,
      perRequestConsent: false,
    })
    const out = filterVercelTools(mixed, gate)
    expect(out).not.toHaveProperty('mcp__mailcopilot__list_external_tools')
    expect(out).not.toHaveProperty('list_external_tools')
    expect(out).not.toHaveProperty('mcp__mailcopilot__call_external_tool')
    expect(out).not.toHaveProperty('call_external_tool')
    // Non-egress tools (get_email and any other read/mutate tool) survive.
    expect(out).toHaveProperty('get_email')
    expect(out).toHaveProperty('mcp__mailcopilot__get_email')
  })

  it('returns a fresh object when filtering (does not mutate input)', () => {
    const gate = createEgressGate({
      policy: 'default-deny',
      context: { type: 'email', data: { uid: 1, folder: 'INBOX', accountId: 1 } } as EmailContext,
      perRequestConsent: false,
    })
    const out = filterVercelTools(sampleTools, gate)
    expect(out).not.toBe(sampleTools)
    // Original still has all keys
    expect(Object.keys(sampleTools).length).toBe(5)
  })
})

describe('egressBlockedResponse', () => {
  it('returns a structured blocked payload with no PII', () => {
    const out = egressBlockedResponse('WebFetch')
    expect(out.blocked).toBe(true)
    expect(out.reason).toBe('egress_policy')
    expect(out.message).toContain('disabled')
    // No URL, no email content, no addresses
    expect(out.message).not.toMatch(/https?:\/\//)
    expect(out.message).not.toMatch(/@/)
  })
})

describe('telemetry helpers', () => {
  it('recordEgressBlocked emits ai.egress.blocked with the tool_name tag', () => {
    recordEgressBlocked({ toolName: 'WebFetch', accountId: 7 })
    expect(recordEventMock).toHaveBeenCalledWith('ai.egress.blocked', {
      tool_name: 'WebFetch',
      account_id: 7,
    })
  })

  it('recordEgressAllowedOnce emits ai.egress.allowed_once with the tool_name tag', () => {
    recordEgressAllowedOnce({ toolName: 'WebSearch' })
    expect(recordEventMock).toHaveBeenCalledWith('ai.egress.allowed_once', {
      tool_name: 'WebSearch',
    })
  })

  it('unknown tool names collapse to "other" to bound cardinality', () => {
    recordEgressBlocked({ toolName: 'NotAnEgressTool' })
    expect(recordEventMock).toHaveBeenCalledWith('ai.egress.blocked', {
      tool_name: 'other',
    })
  })

  it('telemetry helpers swallow recordEvent failures (CLAUDE.md §8)', () => {
    recordEventMock.mockImplementationOnce(() => { throw new Error('boom') })
    expect(() => recordEgressBlocked({ toolName: 'WebSearch' })).not.toThrow()
    recordEventMock.mockImplementationOnce(() => { throw new Error('boom') })
    expect(() => recordEgressAllowedOnce({ toolName: 'WebSearch' })).not.toThrow()
  })
})
