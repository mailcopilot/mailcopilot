// @vitest-environment jsdom
/**
 * Unit tests for src/hooks/useTelemetryConsent.ts (§2.82).
 *
 * Coverage:
 *   - `needed: true` → phase `required` (the gate that keeps <App/> unmounted,
 *     AC2/AC4); `needed: false` → `resolved`
 *   - disabled (child window) → `resolved` with no IPC at all
 *   - AC12: a throwing / missing / malformed `telemetry:consentState` releases
 *     the app instead of blocking it — but as `unresolved`, never `resolved`
 *   - §2.236: a timeout is not an answer. One expired attempt cannot resolve the
 *     gate, a slow `needed: true` still asks, and a main that never answers ends
 *     in the distinct `unresolved` terminal state with a usable app
 *   - AC5: Escape and `decide(false)` produce the byte-identical payload
 *     `{ granted: false }`, and the Escape binding only exists while the screen
 *     is up
 *   - the renderer sends `granted` and nothing else (main stamps version/at)
 *   - re-entrancy: a second click while the first is in flight is dropped
 *   - a failing `telemetry:setConsent` still releases the gate (fail-open UI,
 *     fail-closed sending — no record means the screen asks again next start),
 *     but lands `unresolved`, never `resolved`: main answers `{ ok: false }`
 *     without rejecting, so only a confirmed write may be claimed as a decision
 *   - useTelemetryConsentNeeded re-reads on settings:changed and unsubscribes
 *     the same listener instance on unmount (BACKLOG §2.25 leak class)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  CONSENT_STATE_MAX_ATTEMPTS,
  CONSENT_STATE_TIMEOUT_MS,
  parseConsentReply,
  parseSetConsentReply,
  reportConsentTreeError,
  useTelemetryConsent,
  useTelemetryConsentNeeded,
} from './useTelemetryConsent'

const mockOn = vi.fn()
const mockOff = vi.fn()
const mockInvoke = vi.fn()

Object.defineProperty(window, 'api', {
  value: { on: mockOn, off: mockOff, invoke: mockInvoke },
  writable: true,
  configurable: true,
})

const captureException = vi.fn()
vi.mock('../sentry', () => ({ captureException: (...args: unknown[]) => captureException(...args) }))

/** Replay a broadcast to every listener registered for `channel`. */
function fire(channel: string): void {
  const calls = mockOn.mock.calls as Array<[string, (payload: unknown) => void]>
  for (const [ch, fn] of calls) {
    if (ch === channel) fn(undefined)
  }
}

/** Default: nothing to ask, every other invoke resolves. */
function stateReply(needed: boolean) {
  return (channel: string) => {
    if (channel === 'telemetry:consentState') return Promise.resolve({ needed, version: 1 })
    return Promise.resolve({ ok: true, granted: true })
  }
}

// §2.236 AC1 — the handshake now narrates itself through `console`. Spied on
// rather than silenced: the diagnostics are part of what this file asserts, and
// a real `console.warn` per attempt would drown the reporter.
const consoleInfo = vi.fn()
const consoleWarn = vi.fn()

/** All `[TelemetryConsent] …` lines, whatever the level, in order. */
function consentLogLines(): string[] {
  return [...consoleInfo.mock.calls, ...consoleWarn.mock.calls]
    .map(call => String(call[0]))
    .filter(line => line.startsWith('[TelemetryConsent]'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => { consoleInfo(...args) })
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { consoleWarn(...args) })
  mockInvoke.mockImplementation(stateReply(false))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('parseConsentReply', () => {
  it('reads a well-formed reply as an answer, either way round', () => {
    expect(parseConsentReply({ needed: true, version: 1 })).toEqual({ kind: 'answer', needed: true })
    expect(parseConsentReply({ needed: false, version: 1 })).toEqual({ kind: 'answer', needed: false })
  })

  // §2.236 — an unrecognized shape is a protocol violation, not a permission to
  // skip the question. Before §2.236 every row below read as `false` and the
  // caller treated that as "main says there is nothing to ask".
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'needed'],
    ['a number', 7],
    ['an object without needed', { version: 1 }],
    ['needed as a truthy string', { needed: 'true' }],
    ['needed as 1', { needed: 1 }],
    ['needed as 0', { needed: 0 }],
  ])('reads %s as "could not determine", not as an answer', (_label, payload) => {
    expect(parseConsentReply(payload)).toEqual({ kind: 'unavailable', reason: 'malformed' })
  })

  // The type is narrowed to `{ needed }` — the field this hook actually reads
  // and validates — rather than promising main's `version`. This pins the
  // consequence: acceptance is unchanged, and a field nobody consumes can never
  // demote a well-formed `needed: true` into "could not determine" and, after
  // the retry budget, into a launch where the question is silently not asked.
  it('accepts a reply without version — the renderer reads only needed', () => {
    expect(parseConsentReply({ needed: true })).toEqual({ kind: 'answer', needed: true })
    expect(parseConsentReply({ needed: false })).toEqual({ kind: 'answer', needed: false })
    // Extra fields are main's business too, and are equally not a violation.
    expect(parseConsentReply({ needed: true, version: 2, extra: 'x' }))
      .toEqual({ kind: 'answer', needed: true })
  })
})

// Main answers a refused write with a RESOLVED `{ ok: false, reason }` — it does
// not reject. So "the promise resolved" is not evidence that anything was
// recorded, and this parser is where that distinction is drawn.
describe('parseSetConsentReply', () => {
  it('reads { ok: true } as a confirmed record', () => {
    expect(parseSetConsentReply({ ok: true })).toEqual({ kind: 'recorded' })
    expect(parseSetConsentReply({ ok: true, granted: false })).toEqual({ kind: 'recorded' })
  })

  it.each([
    ['save_failed', 'save_failed'],
    ['not_pending', 'not_pending'],
    ['forbidden_sender', 'forbidden_sender'],
    ['invalid_payload', 'invalid_payload'],
  ])('reads { ok: false, reason: %s } as "not recorded" and keeps the reason', (_label, reason) => {
    expect(parseSetConsentReply({ ok: false, reason })).toEqual({ kind: 'not_recorded', reason })
  })

  // The reason reaches a log line, and a log line may only carry a closed enum.
  it('reports a reason outside the closed set as unknown instead of echoing it', () => {
    expect(parseSetConsentReply({ ok: false, reason: 'ENOENT /home/realuser/settings.json' }))
      .toEqual({ kind: 'not_recorded', reason: 'unknown' })
    expect(parseSetConsentReply({ ok: false })).toEqual({ kind: 'not_recorded', reason: 'unknown' })
  })

  it.each([
    ['undefined (no bridge, or a handler returning nothing)', undefined],
    ['null', null],
    ['a string', 'ok'],
    ['an object without ok', { granted: true }],
    ['ok as a truthy string', { ok: 'true' }],
    ['ok as 1', { ok: 1 }],
  ])('reads %s as "not recorded", never as an acknowledgement', (_label, payload) => {
    expect(parseSetConsentReply(payload)).toEqual({ kind: 'not_recorded', reason: 'malformed' })
  })
})

describe('useTelemetryConsent — gate', () => {
  it('shows the screen when main reports needed: true', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))
    expect(mockInvoke).toHaveBeenCalledWith('telemetry:consentState')
  })

  it('resolves without a screen when a decision is already on record', async () => {
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
  })

  it('starts in checking so <App/> is never mounted behind the screen', () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent())
    expect(result.current.phase).toBe('checking')
  })

  it('never queries in a child window and resolves immediately (enabled: false)', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent({ enabled: false }))
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  // AC12 — the UI never blocks; telemetry stays off because main never wrote a
  // record. §2.236 sharpened the destination: `unresolved`, not `resolved`. A
  // rejection is "we could not determine it", exactly like a timeout.
  it('ends unresolved — not resolved — when every state query rejects', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'telemetry:consentState'
        ? Promise.reject(new Error('settings:get exploded'))
        : Promise.resolve({ ok: true }))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('unresolved'))
    expect(result.current.attempts).toBe(CONSENT_STATE_MAX_ATTEMPTS)
  })

  it('ends unresolved when the preload bridge is missing entirely', async () => {
    const api = window.api
    Object.defineProperty(window, 'api', { value: undefined, writable: true, configurable: true })
    try {
      const { result } = renderHook(() => useTelemetryConsent())
      await waitFor(() => expect(result.current.phase).toBe('unresolved'))
    } finally {
      Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true })
    }
  })

  it('ends unresolved when the reply is not the agreed shape', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'telemetry:consentState'
        ? Promise.resolve({ needed: 'yes' })
        : Promise.resolve({ ok: true }))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('unresolved'))
  })

  // ─── §2.236 — a timeout is not an answer ─────────────────────────────────

  it('does not resolve the gate when a single attempt times out', async () => {
    vi.useFakeTimers()
    try {
      mockInvoke.mockImplementation(() => new Promise(() => { /* never settles */ }))
      const { result } = renderHook(() => useTelemetryConsent())
      expect(result.current.phase).toBe('checking')
      await act(async () => { await vi.advanceTimersByTimeAsync(CONSENT_STATE_TIMEOUT_MS + 1) })
      // The pre-§2.236 code produced `resolved` here, which is what silently
      // skipped the question for a reply that was merely late.
      expect(result.current.phase).toBe('checking')
      expect(result.current.attempts).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // The load-bearing regression test: the reply main sent is `needed: true`, it
  // simply arrived after the stopwatch ran out. The question must still be asked.
  it('still asks when a needed: true reply arrives after the attempt timeout', async () => {
    vi.useFakeTimers()
    try {
      const late = CONSENT_STATE_TIMEOUT_MS + 1500
      mockInvoke.mockImplementation((channel: string) => {
        if (channel !== 'telemetry:consentState') return Promise.resolve({ ok: true })
        return new Promise(resolve => {
          setTimeout(() => resolve({ needed: true, version: 2 }), late)
        })
      })
      const { result } = renderHook(() => useTelemetryConsent())
      await act(async () => { await vi.advanceTimersByTimeAsync(CONSENT_STATE_TIMEOUT_MS + 1) })
      expect(result.current.phase).toBe('checking')
      await act(async () => { await vi.advanceTimersByTimeAsync(late) })
      expect(result.current.phase).toBe('required')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after the bounded number of attempts and reports unresolved, not resolved', async () => {
    vi.useFakeTimers()
    try {
      mockInvoke.mockImplementation(() => new Promise(() => { /* never settles */ }))
      const { result } = renderHook(() => useTelemetryConsent())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONSENT_STATE_TIMEOUT_MS * CONSENT_STATE_MAX_ATTEMPTS + 10)
      })
      expect(result.current.phase).toBe('unresolved')
      expect(result.current.attempts).toBe(CONSENT_STATE_MAX_ATTEMPTS)
      // Exactly one query per attempt — no unbounded retry loop.
      expect(mockInvoke.mock.calls.filter(([c]) => c === 'telemetry:consentState'))
        .toHaveLength(CONSENT_STATE_MAX_ATTEMPTS)
      // And nothing was written: `unresolved` records no decision, so telemetry
      // stays off (absence of a record is a refusal) and the question returns.
      expect(mockInvoke.mock.calls.some(([c]) => c === 'telemetry:setConsent')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an answer that arrives after it gave up — the app is already mounted', async () => {
    vi.useFakeTimers()
    try {
      const afterGiveUp = CONSENT_STATE_TIMEOUT_MS * CONSENT_STATE_MAX_ATTEMPTS + 5_000
      mockInvoke.mockImplementation((channel: string) => {
        if (channel !== 'telemetry:consentState') return Promise.resolve({ ok: true })
        return new Promise(resolve => {
          setTimeout(() => resolve({ needed: true, version: 2 }), afterGiveUp)
        })
      })
      const { result } = renderHook(() => useTelemetryConsent())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONSENT_STATE_TIMEOUT_MS * CONSENT_STATE_MAX_ATTEMPTS + 10)
      })
      expect(result.current.phase).toBe('unresolved')
      await act(async () => { await vi.advanceTimersByTimeAsync(afterGiveUp) })
      // Unmounting a running <App/> to put a modal in front of the user would be
      // worse than asking on the next launch, which is what happens instead.
      expect(result.current.phase).toBe('unresolved')
    } finally {
      vi.useRealTimers()
    }
  })
})

// §2.236 AC1(b,c) — the handshake has to be readable on the machine that
// reproduces the defect. Local console only: nothing here is telemetry, and
// nothing here carries an error message or anything about the user.
describe('useTelemetryConsent — diagnostics', () => {
  it('logs the reply it received together with the round-trip latency', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))

    const answered = consoleInfo.mock.calls
      .find(call => String(call[0]).includes('consentState answered'))
    expect(answered).toBeDefined()
    expect(answered?.[1]).toEqual(expect.objectContaining({ attempt: 1, needed: true }))
    expect((answered?.[1] as { elapsedMs: number }).elapsedMs).toBeTypeOf('number')
  })

  it('logs each timeout, each retry and the give-up', async () => {
    vi.useFakeTimers()
    try {
      mockInvoke.mockImplementation(() => new Promise(() => { /* never settles */ }))
      const { result } = renderHook(() => useTelemetryConsent())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONSENT_STATE_TIMEOUT_MS * CONSENT_STATE_MAX_ATTEMPTS + 10)
      })
      expect(result.current.phase).toBe('unresolved')
      const timeouts = consentLogLines().filter(line => line.includes('timed out'))
      expect(timeouts).toHaveLength(CONSENT_STATE_MAX_ATTEMPTS)
      expect(consentLogLines().some(line => line.includes('unresolved'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never logs the text of a failed query — closed reason enum only', async () => {
    const secret = 'ENOENT: /home/realuser/.config/mailcopilot/settings.json'
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'telemetry:consentState'
        ? Promise.reject(new Error(secret))
        : Promise.resolve({ ok: true }))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('unresolved'))

    const serialized = JSON.stringify([...consoleInfo.mock.calls, ...consoleWarn.mock.calls])
    expect(serialized).not.toContain('realuser')
    expect(serialized).toContain('rejected')
  })

  // AC1(d) — hypothesis 2 gets instrumentation, not a speculative fix.
  it('reports a tree crash while the consent screen is up, and only logs it otherwise', () => {
    const boom = new Error('dialog render exploded')

    reportConsentTreeError('required', boom)
    expect(captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ source: 'useTelemetryConsent.dialogRender', phase: 'required' }),
    )

    captureException.mockClear()
    reportConsentTreeError('resolved', boom)
    // Outside the consent screen the outer boundary already reports normally —
    // a second report would only duplicate it.
    expect(captureException).not.toHaveBeenCalled()
    expect(consentLogLines().filter(line => line.includes('crashed'))).toHaveLength(2)
  })
})

describe('useTelemetryConsent — decide', () => {
  it('sends exactly { granted } — main stamps the version and timestamp', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))

    act(() => { result.current.decide(true) })
    await waitFor(() => expect(result.current.phase).toBe('resolved'))

    const call = mockInvoke.mock.calls.find(([c]) => c === 'telemetry:setConsent')
    expect(call?.[1]).toEqual({ granted: true })
    expect(Object.keys(call?.[1] as object)).toEqual(['granted'])
  })

  // AC5 — refusing by keyboard and refusing by button must be one code path.
  it('Escape produces the same payload as the "don\'t allow" button', async () => {
    mockInvoke.mockImplementation(stateReply(true))

    const first = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(first.result.current.phase).toBe('required'))
    act(() => { first.result.current.decide(false) })
    await waitFor(() => expect(first.result.current.phase).toBe('resolved'))
    const byButton = mockInvoke.mock.calls.filter(([c]) => c === 'telemetry:setConsent')
    first.unmount()

    mockInvoke.mockClear()
    mockInvoke.mockImplementation(stateReply(true))
    const second = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(second.result.current.phase).toBe('required'))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    await waitFor(() => expect(second.result.current.phase).toBe('resolved'))
    const byEscape = mockInvoke.mock.calls.filter(([c]) => c === 'telemetry:setConsent')

    expect(byEscape).toEqual(byButton)
    expect(byEscape[0]?.[1]).toEqual({ granted: false })
  })

  it('ignores Escape once the decision is made (no listener left behind)', async () => {
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(mockInvoke.mock.calls.some(([c]) => c === 'telemetry:setConsent')).toBe(false)
  })

  it('ignores other keys while the screen is up', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    })
    expect(mockInvoke.mock.calls.some(([c]) => c === 'telemetry:setConsent')).toBe(false)
    expect(result.current.phase).toBe('required')
  })

  it('drops a second answer while the first is in flight', async () => {
    let release: ((value: unknown) => void) | undefined
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'telemetry:consentState') return Promise.resolve({ needed: true, version: 1 })
      return new Promise(resolve => { release = resolve })
    })
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))

    act(() => { result.current.decide(false) })
    act(() => { result.current.decide(true) })
    await waitFor(() => expect(result.current.submitting).toBe(true))

    const sends = mockInvoke.mock.calls.filter(([c]) => c === 'telemetry:setConsent')
    expect(sends).toHaveLength(1)
    expect(sends[0][1]).toEqual({ granted: false })

    await act(async () => { release?.({ ok: true, granted: false }) })
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
  })

  it('releases the gate when the write rejects — the app is never held hostage', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'telemetry:consentState'
        ? Promise.resolve({ needed: true, version: 1 })
        : Promise.reject(new Error('save_failed')))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))

    act(() => { result.current.decide(false) })
    // The app renders (fail-open UI) but the phase does not claim a decision:
    // the write never happened, so `unresolved` is the true state.
    await waitFor(() => expect(result.current.phase).toBe('unresolved'))
    expect(result.current.submitting).toBe(false)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'useTelemetryConsent.setConsent' }),
    )
  })
})

/**
 * §2.82 — main is the authority on what was recorded.
 *
 * `telemetry:setConsent` does NOT reject when main refuses to write: a failed
 * save, a sender that is not the main window and the `not_pending` race all come
 * back as a resolved `{ ok: false, reason }`. Before this, the renderer awaited
 * the call without looking at the result, logged "acknowledged" and settled
 * `resolved` — claiming an answer was on record when none was, in the one place
 * whose whole job is to not do that.
 */
describe('useTelemetryConsent — decide, an unconfirmed write is not a decision', () => {
  /** Show the screen, then answer with `reply` from `telemetry:setConsent`. */
  async function answerWith(reply: unknown, granted = false) {
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'telemetry:consentState'
        ? Promise.resolve({ needed: true, version: 1 })
        : Promise.resolve(reply))
    const hook = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(hook.result.current.phase).toBe('required'))
    act(() => { hook.result.current.decide(granted) })
    return hook
  }

  it('lands unresolved — not resolved — when main answers { ok: false, save_failed }', async () => {
    const { result } = await answerWith({ ok: false, reason: 'save_failed' })
    await waitFor(() => expect(result.current.phase).toBe('unresolved'))
    expect(result.current.submitting).toBe(false)
    // The line that used to lie. Nothing was acknowledged, so nothing may say so.
    expect(consentLogLines().some(line => line.includes('setConsent acknowledged'))).toBe(false)
    const refusal = consoleWarn.mock.calls
      .find(call => String(call[0]).includes('the answer was not recorded'))
    expect(refusal?.[1]).toEqual(expect.objectContaining({ granted: false, reason: 'save_failed' }))
    // Nothing here may report an error to Sentry: there is no error object, and
    // main already reports its own save failure from the side that has detail.
    expect(captureException).not.toHaveBeenCalled()
  })

  // The user-visible consequence of the fix: no record was written, so the next
  // launch must put the question back rather than treat it as answered.
  it('asks again on the next mount after a refused write', async () => {
    const { result, unmount } = await answerWith({ ok: false, reason: 'save_failed' })
    await waitFor(() => expect(result.current.phase).toBe('unresolved'))
    unmount()

    // Main still has no record, so it still reports needed: true.
    mockInvoke.mockImplementation(stateReply(true))
    const second = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(second.result.current.phase).toBe('required'))
  })

  it.each([
    ['not_pending — the question was already closed', { ok: false, reason: 'not_pending' }],
    ['forbidden_sender — the write was refused', { ok: false, reason: 'forbidden_sender' }],
    ['a reply that is not the agreed shape', { granted: true }],
    ['no reply at all', undefined],
  ])('lands unresolved on %s', async (_label, reply) => {
    const { result } = await answerWith(reply)
    await waitFor(() => expect(result.current.phase).toBe('unresolved'))
    expect(consentLogLines().some(line => line.includes('setConsent acknowledged'))).toBe(false)
  })

  it('settles resolved only on a confirmed { ok: true }', async () => {
    const { result } = await answerWith({ ok: true, granted: true }, true)
    await waitFor(() => expect(result.current.phase).toBe('resolved'))
    expect(consentLogLines().some(line => line.includes('setConsent acknowledged'))).toBe(true)
  })

  // `window.api?.invoke(...)` awaits `undefined` with no bridge — a resolved
  // promise for a call that never left the renderer, i.e. the success path.
  it('lands unresolved when the bridge disappears before the click', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsent())
    await waitFor(() => expect(result.current.phase).toBe('required'))

    const api = window.api
    Object.defineProperty(window, 'api', { value: undefined, writable: true, configurable: true })
    try {
      act(() => { result.current.decide(true) })
      await waitFor(() => expect(result.current.phase).toBe('unresolved'))
      const refusal = consoleWarn.mock.calls
        .find(call => String(call[0]).includes('the answer was not recorded'))
      expect(refusal?.[1]).toEqual(expect.objectContaining({ reason: 'no_bridge' }))
    } finally {
      Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true })
    }
  })

  // The refusal reason reaches a console line, which is a Sentry breadcrumb
  // source: closed enum only, never a string main happened to put there.
  it('never logs a refusal reason outside the closed set', async () => {
    const secret = 'ENOENT: /home/realuser/.config/mailcopilot/settings.json'
    const { result } = await answerWith({ ok: false, reason: secret })
    await waitFor(() => expect(result.current.phase).toBe('unresolved'))
    const serialized = JSON.stringify([...consoleInfo.mock.calls, ...consoleWarn.mock.calls])
    expect(serialized).not.toContain('realuser')
    expect(serialized).toContain('unknown')
  })
})

describe('useTelemetryConsentNeeded — Settings → About', () => {
  it('reports whether the About switch is currently clamped', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsentNeeded())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('re-reads after settings:changed so an answer elsewhere is picked up', async () => {
    mockInvoke.mockImplementation(stateReply(true))
    const { result } = renderHook(() => useTelemetryConsentNeeded())
    await waitFor(() => expect(result.current).toBe(true))

    mockInvoke.mockImplementation(stateReply(false))
    await act(async () => { fire('settings:changed') })
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('unsubscribes the same listener instance on unmount', () => {
    const { unmount } = renderHook(() => useTelemetryConsentNeeded())
    const registered = (mockOn.mock.calls as Array<[string, unknown]>)
      .find(([c]) => c === 'settings:changed')?.[1]
    unmount()
    const removed = (mockOff.mock.calls as Array<[string, unknown]>)
      .find(([c]) => c === 'settings:changed')?.[1]
    expect(registered).toBeTypeOf('function')
    expect(removed).toBe(registered)
  })

  it('stays false when the query fails (no scary hint on a broken IPC)', async () => {
    mockInvoke.mockImplementation(() => Promise.reject(new Error('nope')))
    const { result } = renderHook(() => useTelemetryConsentNeeded())
    await waitFor(() => expect(captureException).toHaveBeenCalled())
    expect(result.current).toBe(false)
  })
})
