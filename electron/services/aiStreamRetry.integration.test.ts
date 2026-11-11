/**
 * §2.288 — the retry gate against REAL execution, not substituted stream parts.
 *
 * Everything between the provider's HTTP response and the tool handler is the
 * real thing here: `@ai-sdk/openai-compatible` parses a scripted SSE body,
 * `streamText` drives the step loop, `@ai-sdk/mcp` talks to a real MCP server
 * over an `InMemoryTransport`, and the handler of the real `create_draft` tool
 * is the counter. Only the network edge (`fetch`) and the process-level
 * services are faked. The unit suite in `ai.test.ts` feeds `fullStream` by hand,
 * which cannot see a tool the SDK starts on its own while the consumer has
 * already stopped reading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSecretStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}))


vi.mock('./secretStore', () => ({
  secretStore: mockSecretStore,
}))


// `aiFetch` now always dispatches through npm undici (with the mail CA set, see
// aiHttpDispatcher.ts). The suite's many `vi.spyOn(globalThis, 'fetch')` stubs
// stay the network seam: undici's `fetch` is routed to whatever `globalThis.fetch`
// is at call time. `Agent` / `ProxyAgent` stay REAL — the proxy tests rely on the
// real constructor throwing on a malformed URL. The dispatcher's own trust
// behaviour is proven against a live TLS server in aiHttpDispatcher.test.ts.
vi.mock('undici', async (importActual) => {
  const actual = await importActual<typeof import('undici')>()
  return {
    ...actual,
    fetch: vi.fn((url: string, init?: RequestInit & { dispatcher?: unknown }) => {
      const rest: RequestInit & { dispatcher?: unknown } = { ...init }
      delete rest.dispatcher
      return globalThis.fetch(url, rest)
    }),
  }
})

// Controlled consumer. `streamText` runs the SDK's step loop independently of
// whoever reads `fullStream` (it starts a tool the moment it parses the tool
// call), so what a test can pin is the order between "the tool started" and "the
// consumer read the stream". When `streamGate.hold` is set, the result's
// `fullStream` is pumped into a buffer straight away (the SDK runs ahead, as it
// does with a slow consumer) but is handed to the reader only after `hold()`
// resolves. Everything else on the result, and every call made while the hold is
// unset, is the real SDK.
const streamGate = vi.hoisted(() => ({ hold: null as null | (() => Promise<void>) }))

function holdBack<T>(source: AsyncIterable<T>, release: () => Promise<void>): AsyncIterable<T> {
  const parts: T[] = []
  let finished = false
  let failure: { error: unknown } | undefined
  let wake: (() => void) | undefined
  const notify = (): void => { const w = wake; wake = undefined; w?.() }
  void (async () => {
    try {
      for await (const part of source) { parts.push(part); notify() }
    } catch (error) {
      failure = { error }
    } finally {
      finished = true
      notify()
    }
  })()
  return (async function* () {
    await release()
    for (let i = 0; ;) {
      if (i < parts.length) { yield parts[i++]; continue }
      if (failure) throw failure.error
      if (finished) return
      await new Promise<void>(resolve => { wake = resolve })
    }
  })()
}

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>()
  return {
    ...actual,
    streamText: ((options: Parameters<typeof actual.streamText>[0]) => {
      const result = actual.streamText(options)
      const release = streamGate.hold
      if (!release) return result
      return new Proxy(result, {
        get(target, prop) {
          if (prop === 'fullStream') return holdBack(target.fullStream, release)
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }) as typeof actual.streamText,
  }
})

vi.mock('@napi-rs/canvas', () => ({
  createCanvas: vi.fn(() => ({
    getContext: vi.fn(() => ({
      drawImage: vi.fn(),
      createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(16) })),
      putImageData: vi.fn(),
    })),
    toBuffer: vi.fn(() => Buffer.from('resized-img')),
  })),
  loadImage: vi.fn(async () => ({ width: 100, height: 100 })),
}))


const mockDbPrepare = vi.hoisted(() => vi.fn(() => ({
  all: vi.fn(() => []),
})))

// §2.162 — stored rule behind `getMailRule`. The update tools judge a refusal on
// the rule as it will be after the patch, so a test that submits only one half
// (actions, say) drives what the other half is by setting this.
const mockGetMailRule = vi.hoisted(() =>
  vi.fn((): { conditions: string; actions: string } | undefined => undefined),
)

// §2.51 — hoisted so both the db-mock `sumAiCostSince` export AND the
// `admitAiReservation` mock (which reproduces the primitive's projected cap check
// against the same ledger sum) read ONE controllable source. Tests drive over-cap
// vs within-budget by setting this mock's return value.
const mockSumAiCostSince = vi.hoisted(() => vi.fn((sinceIso?: string): number => {
  void sinceIso
  return 0
}))

// §2.51 — real-shaped `AiBudgetReserveError` hoisted so the db-mock export and the
// `admitAiReservation` mock throw the SAME class → `err instanceof
// AiBudgetReserveError` in `admitBudgetedCall` matches when a test drives the
// fail-closed deny.
const MockAiBudgetReserveError = vi.hoisted(() => class AiBudgetReserveError extends Error {
  readonly reason: 'invalid-amount' | 'ledger-write-failed'
  readonly cause?: unknown
  constructor(reason: 'invalid-amount' | 'ledger-write-failed', message: string, cause?: unknown) {
    super(message)
    this.name = 'AiBudgetReserveError'
    this.reason = reason
    this.cause = cause
  }
})

// §2.51 — atomic admission mock reproducing the real db primitive's contract:
// projected `currentSum + reservationUsd > limit` over each active window (using
// the shared `mockSumAiCostSince`), returning `{ ok: false, reason: 'over-cap' }`
// on breach and inserting a reservation otherwise. A non-finite/non-positive
// amount THROWS (fail-closed), matching the primitive. Tests can override this
// with `mockAdmitAiReservation.mockImplementationOnce(...)` for edge cases.
const mockAdmitAiReservation = vi.hoisted(() => vi.fn((
  _accountId: string,
  _provider: string,
  _model: string | null,
  reservationUsd: number,
  windows: ReadonlyArray<{ sinceIso: string; limitUsd: number }>,
) => {
  if (!Number.isFinite(reservationUsd) || reservationUsd <= 0) {
    throw new MockAiBudgetReserveError('invalid-amount', `bad amount: ${String(reservationUsd)}`)
  }
  for (const w of windows) {
    if (!Number.isFinite(w.limitUsd) || w.limitUsd <= 0) continue
    const currentSum = mockSumAiCostSince(w.sinceIso)
    if (currentSum + reservationUsd > w.limitUsd) {
      return { ok: false as const, reason: 'over-cap' as const }
    }
  }
  return {
    ok: true as const,
    reservation: { id: 42, reservedUsd: reservationUsd, sessionId: '__ai_cost_ledger__', createdAt: '2024-01-01T00:00:00Z' },
  }
}))

vi.mock('../../packages/db', () => ({
  default: { prepare: mockDbPrepare },
  getMessages: vi.fn(() => []),
  getMessageByUid: vi.fn(),
  countUnreadMessages: vi.fn(() => 0),
  getThreadMessages: vi.fn(() => []),
  getMessagesBeforeUid: vi.fn(() => []),
  searchMessages: vi.fn(() => []),
  searchContacts: vi.fn(() => []),
  listFolderPrefs: vi.fn(() => []),
  listFolderStats: vi.fn(() => []),
  sumAiCostSince: mockSumAiCostSince,
  // §2.51 — atomic, fail-closed budget admission primitives. `admitAiReservation`
  // does the projected cap check + reservation insert in ONE tx (used by aiChat /
  // generateQuickActionRewrite / generateInstantReplyDrafts for admission);
  // `reconcileAiReservation` settles to the actual cost after the provider returns.
  admitAiReservation: mockAdmitAiReservation,
  reconcileAiReservation: vi.fn((_reservation: unknown, actualUsd: number) => ({
    settled: true,
    finalUsd: Number.isFinite(actualUsd) && actualUsd > 0 ? actualUsd : 0,
  })),
  // Real class so `err instanceof AiBudgetReserveError` in admitBudgetedCall works
  // when a test drives admitAiReservation to throw the fail-closed deny signal.
  AiBudgetReserveError: MockAiBudgetReserveError,
  // §3.3 B1 — audit log functions used in aiChat() finally block.
  appendAiActionLog: vi.fn(),
  listAiActionLog: vi.fn(() => ({ rows: [], total: 0 })),
  aggregateAiUsage: vi.fn(() => []),
  softDeleteAiActionEntry: vi.fn(() => true),
  clearAiActionLog: vi.fn(() => 0),
  exportAiActionLog: vi.fn(() => '[]'),
  listMailRules: vi.fn(() => []),
  // §2.162 — the update path reads the stored rule back so a refusal is judged
  // on the rule as it will be AFTER the patch, not on the submitted half alone.
  getMailRule: mockGetMailRule,
  createMailRule: vi.fn(),
  updateMailRule: vi.fn(),
  deleteMailRule: vi.fn(),
  listRuleLog: vi.fn(() => []),
}))

// §2.122 — the non-secret "a key for this provider was saved" marker. Mocked
// here so the save/delete tests can assert that main (and only main) writes it,
// without an electron-store on disk.
const mockSetAiApiKeySavedFlag = vi.hoisted(() => vi.fn())

vi.mock('../../packages/net/config', () => ({
  listAccounts: vi.fn(() => []),
  getAccountMeta: vi.fn(),
  getSettings: vi.fn(() => ({})),
  setAiApiKeySavedFlag: mockSetAiApiKeySavedFlag,
}))

const mockUserDataDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), 'mailcopilot-ai-test-'))
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => mockUserDataDir),
  },
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => '/usr/local/bin/claude\n'),
}))

const mockLogAI = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => mockLogAI),
}))

const mockSpan = vi.hoisted(() => ({
  setAttributes: vi.fn(),
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
}))

const mockSentryLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  fmt: vi.fn(),
}))

const mockStartInactiveSpan = vi.hoisted(() => vi.fn(() => mockSpan))
const mockReportKeychainUnavailable = vi.hoisted(() => vi.fn())
const mockCaptureException = vi.hoisted(() => vi.fn())

vi.mock('../sentry', () => ({
  startInactiveSpan: mockStartInactiveSpan,
  sentryLogger: mockSentryLogger,
  wrapMcpServerWithSentry: vi.fn((server: unknown) => server),
  captureException: mockCaptureException,
  reportKeychainUnavailable: mockReportKeychainUnavailable,
}))

// §2.82 — metric spans (and every other telemetry sink) are gated on the
// recorded consent decision, which defaults to "not allowed" in a fresh
// process. This suite asserts on the spans the AI service opens, so it has to
// describe the consented state explicitly; the gate itself is covered in
// electron/telemetryGate.test.ts.
import { setTelemetryCollectionAllowed } from '../telemetryGate'
setTelemetryCollectionAllowed(true)

import { aiChat, setDraftCallback, STREAM_MAX_RETRIES, type AiStreamEvent } from './ai'
import { getSettings } from '../../packages/net/config'
import { appendAiActionLog } from '../../packages/db'



const TOOL_CALL_CHUNK = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{
    index: 0,
    delta: {
      role: 'assistant',
      tool_calls: [{
        index: 0,
        id: 'call_1',
        type: 'function',
        function: {
          name: 'create_draft',
          arguments: JSON.stringify({ accountId: 1, to: 'a@example.com', subject: 'Hi', body: 'Hello' }),
        },
      }],
    },
    finish_reason: null,
  }],
})

/** An SSE body: each entry is one `data:` event; the stream then simply closes. */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${e}\n\n`))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const SERVER_ERROR_EVENT = JSON.stringify({ error: { type: 'server_error', message: 'upstream unavailable' } })

async function drainStepping(gen: AsyncGenerator<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = []
  let finished = false
  const pending = (async () => { for await (const e of gen) events.push(e) })().finally(() => { finished = true })
  while (!finished) await vi.advanceTimersByTimeAsync(1000)
  await pending
  return events
}

describe('§2.288 retry gate against real tool execution (real SDK, MCP and provider adapters)', () => {
  const drafts = vi.fn()
  /**
   * Holds the consumer back until the real `create_draft` handler has been
   * entered. Bounded by event-loop TURNS, not by time: if the handler never
   * starts, the consumer is released anyway and the test fails on its own
   * precondition message instead of waiting for the suite timeout.
   */
  const untilHandlerStarted = async (): Promise<void> => {
    for (let turn = 0; turn < 2000 && drafts.mock.calls.length === 0; turn++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  const PRECONDITION = 'precondition: the tool handler must have started before the consumer read the stream'

  beforeEach(() => {
    vi.clearAllMocks()
    streamGate.hold = null
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mockSecretStore.get.mockResolvedValue('sk-test-key')
    vi.mocked(getSettings).mockReturnValue({ aiProvider: 'openai-api', aiMaxBudgetPerRequest: 5, aiDailyBudgetUsd: 5 } as never)
    setDraftCallback(drafts)
  })

  afterEach(() => {
    streamGate.hold = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not replay a tool that already ran when the NEXT step fails in-stream, and ends with a terminal error', async () => {
    // Step 1 is a complete, finished tool call: the handler ran and its result
    // is back before step 2 is requested, so "the tool ran once" holds by
    // construction rather than by a race. Step 2 then answers with an in-stream
    // retryable error — the case the gate exists for: the failure is transient,
    // but the attempt has already done something and must not be re-issued.
    let n = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n++
      return n === 1
        ? sseResponse([
            TOOL_CALL_CHUNK,
            JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
            '[DONE]',
          ])
        : sseResponse([SERVER_ERROR_EVENT])
    })

    const events = await drainStepping(aiChat({ requestId: 'real-exec-1', prompt: 'Draft a reply' }))

    expect(drafts).toHaveBeenCalledTimes(1)
    // Two requests, one per step: a replay would show up as a third.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(events.filter(e => e.type === 'error')).toHaveLength(1)
    expect(events.some(e => e.type === 'result')).toBe(false)
    expect(events.some(e => e.type === 'status' && (e as { status: string }).status === 'done')).toBe(false)
    // One named start, before the error, and the audit row carries the tool.
    const starts = events.filter(e => e.type === 'tool_use_start') as Array<{ toolName: string }>
    expect(starts.map(e => e.toolName)).toEqual(['create_draft'])
    expect(events.findIndex(e => e.type === 'tool_use_start')).toBeLessThan(events.findIndex(e => e.type === 'error'))
    expect(vi.mocked(appendAiActionLog)).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'create_draft', outcome: 'error' }))
  })

  it('does not re-issue the request when a tool STARTED before the consumer read its tool-call part', async () => {
    // The OpenAI-compatible adapter emits `tool-call` after the `error` part of
    // the same body, so the consumer meets the error first and never reads the
    // tool call. The consumer is held back until the real handler has been
    // entered: the tool started strictly before the failure was seen, which is
    // the state §2.288 is about. The retry decision then rests on the fence's
    // own mark made when `execute` is entered — no stream part carries it.
    streamGate.hold = untilHandlerStarted
    // One step only: while the consumer is held the SDK keeps running ahead, and
    // without this cap it would start further steps (and run the tool again)
    // before the consumer is released. Then "one request" and "one execution"
    // read off the counters are exact, whatever the scheduling.
    vi.mocked(getSettings).mockReturnValue({ aiProvider: 'openai-api', aiMaxBudgetPerRequest: 5, aiDailyBudgetUsd: 5, aiMaxTurns: 1 } as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse([TOOL_CALL_CHUNK, SERVER_ERROR_EVENT]))

    const events = await drainStepping(aiChat({ requestId: 'real-exec-started-first', prompt: 'Draft a reply' }))

    expect(drafts.mock.calls.length, PRECONDITION).toBeGreaterThan(0)
    expect(drafts, 'the tool must run exactly once, never replayed').toHaveBeenCalledTimes(1)
    // No second request: a retry of this failure would show up as a second fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(events.filter(e => e.type === 'error')).toHaveLength(1)
    expect(events.some(e => e.type === 'result')).toBe(false)
    expect(events.some(e => e.type === 'status' && (e as { status: string }).status === 'done')).toBe(false)
    // The tool-call part was never read, so the failure handler names the start
    // itself, before the error, and the audit row carries the tool.
    const starts = events.filter(e => e.type === 'tool_use_start') as Array<{ toolName: string }>
    expect(starts.map(e => e.toolName)).toEqual(['create_draft'])
    expect(events.findIndex(e => e.type === 'tool_use_start')).toBeLessThan(events.findIndex(e => e.type === 'error'))
    expect(vi.mocked(appendAiActionLog)).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'create_draft', outcome: 'error' }))
  })

  it('never runs a tool queued behind an in-stream error more than once, whichever side wins the race', async () => {
    // The OpenAI-compatible adapter emits its `tool-call` part only when the
    // body ends, i.e. AFTER the `error` part of the same body. The SDK starts
    // the tool on its own while the consumer fails the attempt, so the order is
    // up to the runtime's scheduling and cannot be pinned from the stub:
    //  - the tool starts first: the fence sees it, the failure is terminal, and
    //    the handler runs once (or its call is cancelled before it is entered);
    //  - the failure closes the fence first: the tool is refused, nothing ran,
    //    and the retry of a failure with no side effect is legitimate.
    // Both are safe; what must hold in every interleaving is "at most once" and
    // a single terminal error. The exact-once assertion lives in the tests that
    // can make "the tool ran" a precondition.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse([TOOL_CALL_CHUNK, SERVER_ERROR_EVENT]))

    const events = await drainStepping(aiChat({ requestId: 'real-exec-race', prompt: 'Draft a reply' }))

    expect(drafts.mock.calls.length).toBeLessThanOrEqual(1)
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1 + STREAM_MAX_RETRIES)
    expect(events.filter(e => e.type === 'error')).toHaveLength(1)
    expect(events.some(e => e.type === 'result')).toBe(false)
    expect(events.some(e => e.type === 'status' && (e as { status: string }).status === 'done')).toBe(false)
  })

  it('runs a tool ONCE when the Anthropic contour fails right after the tool call', async () => {
    vi.mocked(getSettings).mockReturnValue({ aiProvider: 'anthropic-api', aiMaxBudgetPerRequest: 5, aiDailyBudgetUsd: 5, aiMaxTurns: 1 } as never)
    mockSecretStore.get.mockResolvedValue('sk-ant-test-key')
    const anthropicToolCall = [
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-test', stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'create_draft', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ accountId: 1, to: 'a@example.com', subject: 'Hi', body: 'Hello' }) } },
      { type: 'content_block_stop', index: 0 },
    ].map(e => JSON.stringify(e))
    const anthropicError = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
    streamGate.hold = untilHandlerStarted
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse([...anthropicToolCall, anthropicError]))

    const events = await drainStepping(aiChat({ requestId: 'real-exec-anthropic', prompt: 'Draft a reply' }))

    expect(drafts.mock.calls.length, PRECONDITION).toBeGreaterThan(0)
    expect(drafts, 'the tool must run exactly once, never replayed').toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(events.filter(e => e.type === 'error')).toHaveLength(1)
    expect(events.some(e => e.type === 'result')).toBe(false)
  })

  it('keeps the request body (the prompt) out of stderr when the provider fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const marker = 'CONFIDENTIAL-MAIL-BODY-9f3a'
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ error: { message: 'backend exploded', type: 'server_error' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ))

    const events = await drainStepping(aiChat({ requestId: 'no-body-in-stderr', prompt: `Summarise: ${marker}` }))

    expect(events.filter(e => e.type === 'error')).toHaveLength(1)
    const printed = [...consoleError.mock.calls, ...consoleWarn.mock.calls].map(c => c.map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a) } catch { return String(a) }
    }).join(' ')).join('\n')
    expect(printed).not.toContain(marker)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('still retries a failure that happened before anything was generated (control)', async () => {
    let n = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n++
      return n === 1
        ? sseResponse([SERVER_ERROR_EVENT])
        : sseResponse([
            JSON.stringify({ id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }] }),
            JSON.stringify({ id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
            '[DONE]',
          ])
    })

    const events = await drainStepping(aiChat({ requestId: 'real-exec-2', prompt: 'Hi' }))

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(drafts).not.toHaveBeenCalled()
    expect(events.filter(e => e.type === 'error')).toHaveLength(0)
    expect(events.filter(e => e.type === 'result')).toHaveLength(1)
    expect(STREAM_MAX_RETRIES).toBeGreaterThan(0)
  })
})
