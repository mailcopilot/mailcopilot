import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for electron/ipc.ts — the sole IPC boundary module owning
 * ipcMain, handleIpc(), the metrics:record bridge, and the UI-freeze watchdogs
 * (see BACKLOG.md §2.13 for the architectural rationale).
 *
 * Focus: behaviour that was extracted from main.ts as a pure refactor.
 * We explicitly guard:
 *   - handleIpc success + error + slow-IPC + exclude-list behaviour;
 *   - inflight-IPC tracking semantics (populate on entry / delete on exit);
 *   - registerUiFreezeHandler's round-1 regression guard — the freeze reporter
 *     filters its own channel out of the inflight snapshot so a single
 *     background IPC never appears as "inflight=2" in logs or metrics;
 *   - registerMetricsRecordHandler's schema validation / tag allow-listing.
 */

// --- Mocks -----------------------------------------------------------------

// Capture handlers registered via ipcMain.handle / ipcMain.on so tests can
// invoke them directly without a live Electron IPC channel.
const handleRegistrations = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const onRegistrations = new Map<string, (event: unknown, ...args: unknown[]) => void>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handleRegistrations.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
      onRegistrations.set(channel, handler)
    }),
  },
}))

// Capture logger output for assertions without touching electron-log file I/O.
const logCalls: Record<string, unknown[][]> = { info: [], warn: [], error: [], debug: [] }
vi.mock('./logger', () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => { logCalls.info.push(args) },
    warn: (...args: unknown[]) => { logCalls.warn.push(args) },
    error: (...args: unknown[]) => { logCalls.error.push(args) },
    debug: (...args: unknown[]) => { logCalls.debug.push(args) },
  }),
}))

const recordEventMock = vi.fn()
const recordHistogramMock = vi.fn()
const recordGaugeMock = vi.fn()
vi.mock('./metrics', () => ({
  recordEvent: (...args: unknown[]) => recordEventMock(...args),
  recordHistogram: (...args: unknown[]) => recordHistogramMock(...args),
  recordGauge: (...args: unknown[]) => recordGaugeMock(...args),
  bucketDuration: (ms: number) => `bucket_${ms}`,
}))

const markFeatureReachFromEventMock = vi.fn()
vi.mock('./featureReach', () => ({
  markFeatureReachFromEvent: (...args: unknown[]) => markFeatureReachFromEventMock(...args),
}))

// Sentry sink for the handleIpc error funnel. Mocked here so this unit test
// never pulls @sentry/node (and the vite-injected __SENTRY_DSN__ global) into
// its module graph; the PII/throttle behaviour of the real reporter is covered
// in electron/sentry.test.ts.
const reportIpcHandlerErrorMock = vi.fn()
vi.mock('./sentry', () => ({
  reportIpcHandlerError: (...args: unknown[]) => reportIpcHandlerErrorMock(...args),
}))

// §2.156 — the main-loop watchdog reads perf_hooks' event-loop delay histogram.
// Mocked so a test can dictate the observed delay instead of trying to block a
// real event loop for 200 ms.
const eventLoopDelay = { max: 0, enable: vi.fn(), reset: vi.fn(() => { eventLoopDelay.max = 0 }) }
vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: () => eventLoopDelay,
}))

// Import AFTER mocks so the module picks them up.
import {
  handleIpc,
  registerMetricsRecordHandler,
  registerUiFreezeHandler,
  startMainLoopFreezeWatchdog,
} from './ipc'

// --- Shared helpers --------------------------------------------------------

// tsconfig targets ES2020, so `AggregateError` has no type declaration here
// even though the runtime (Node 22 / Electron 43) provides it. Reach it
// structurally, like packages/core/transientErrors.ts does.
type AggErrCtor = new (errors: unknown[], message?: string) => Error & { errors: unknown[] }
const AggErr = (globalThis as unknown as { AggregateError: AggErrCtor }).AggregateError

/** Invoke a registered handler and resolve with whatever it rejected with. */
async function rejectionOf(channel: string, ...args: unknown[]): Promise<unknown> {
  const wrapped = handleRegistrations.get(channel)!
  try {
    await wrapped(null, ...args)
    return null
  } catch (e) {
    return e
  }
}

function resetLogs() {
  logCalls.info.length = 0
  logCalls.warn.length = 0
  logCalls.error.length = 0
  logCalls.debug.length = 0
}

beforeEach(() => {
  handleRegistrations.clear()
  onRegistrations.clear()
  resetLogs()
  recordEventMock.mockClear()
  recordHistogramMock.mockClear()
  recordGaugeMock.mockClear()
  markFeatureReachFromEventMock.mockClear()
  reportIpcHandlerErrorMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// handleIpc
// ---------------------------------------------------------------------------

describe('handleIpc', () => {
  it('registers the channel on ipcMain and resolves the handler result', async () => {
    handleIpc('test:echo', async (_e, value: unknown) => `echo:${value}`)
    const wrapped = handleRegistrations.get('test:echo')
    expect(wrapped).toBeTypeOf('function')

    const result = await wrapped!(null, 'hello')
    expect(result).toBe('echo:hello')
  })

  it('logs and re-throws errors from the handler', async () => {
    handleIpc('test:fail', async () => {
      throw new Error('boom')
    })
    const wrapped = handleRegistrations.get('test:fail')!

    await expect(wrapped(null)).rejects.toThrow('boom')

    // First logger arg is `[channel]`, second is the error message string.
    expect(logCalls.error).toHaveLength(1)
    expect(logCalls.error[0]?.[0]).toBe('[test:fail]')
    expect(logCalls.error[0]?.[1]).toBe('boom')
  })

  // --- Presentation tagging (BACKLOG §2.127) -------------------------------
  // Electron's IPC serializer hands the renderer a brand-new plain Error with
  // only `message` and `stack` — `.errors[]`, `.code` and `.cause` are gone
  // (measured on Electron 40 with a real main+preload+renderer round trip).
  // So the funnel classifies the LIVE error object here and encodes the verdict
  // into the message, the only carrier that survives.

  it('tags an AggregateError with a key derived from its inner errors, not from its (empty) message', async () => {
    const inner = Object.assign(new Error('connect ETIMEDOUT 203.0.113.10:993'), { code: 'ETIMEDOUT' })
    const agg = new AggErr([inner])
    expect(agg.message).toBe('') // the production symptom: nothing to render

    handleIpc('net:inboxSummaries', async () => {
      throw agg
    })
    const rejection = await rejectionOf('net:inboxSummaries')
    expect((rejection as Error).message.startsWith('[mcerr:timeout] ')).toBe(true)
    expect((rejection as { cause?: unknown }).cause).toBe(agg)
  })

  it('tags credential failures separately from network failures', async () => {
    handleIpc('net:testImap', async () => {
      throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true })
    })
    const rejection = await rejectionOf('net:testImap')
    expect((rejection as Error).message.startsWith('[mcerr:auth] ')).toBe(true)
  })

  it('tags an unrecognised failure with the neutral key instead of leaving it untagged', async () => {
    handleIpc('test:novel', async () => {
      throw new Error('something we have never seen')
    })
    const rejection = await rejectionOf('test:novel')
    expect((rejection as Error).message.startsWith('[mcerr:unknown] ')).toBe(true)
  })

  it('keeps the original text after the tag — two renderer consumers substring-match it', async () => {
    // src/hooks/useCertRecovery.ts maps `cert_trust_*` codes to inline dialog
    // errors, and src/sentry.ts beforeSend runs isTransientNetworkError over
    // the wrapped message to keep network noise out of Sentry. Both match by
    // substring, so the tag may be prepended but the text must survive.
    handleIpc('net:trustCert', async () => {
      throw new Error('cert_trust_fingerprint_mismatch')
    })
    const certRejection = await rejectionOf('net:trustCert')
    expect((certRejection as Error).message).toContain('cert_trust_fingerprint_mismatch')

    handleIpc('update:download', async () => {
      throw new Error('net::ERR_CONNECTION_RESET')
    })
    const netRejection = await rejectionOf('update:download')
    expect((netRejection as Error).message).toContain('net::ERR_CONNECTION_RESET')
  })

  it('logs the flattened AggregateError tree — the log line used to be empty', async () => {
    const agg = new AggErr([
      Object.assign(new Error('connect ETIMEDOUT 203.0.113.10:993'), { code: 'ETIMEDOUT' }),
    ])
    handleIpc('net:syncFolderHeaders', async () => {
      throw agg
    })
    await rejectionOf('net:syncFolderHeaders')

    expect(logCalls.error[0]?.[0]).toBe('[net:syncFolderHeaders]')
    expect(String(logCalls.error[0]?.[1])).toContain('connect ETIMEDOUT 203.0.113.10:993 (ETIMEDOUT)')
  })

  // --- Sentry error funnel -------------------------------------------------
  // Before this, electron/ipc.ts had zero captureException call sites: every
  // handler failure went to electron-log only, which has no Sentry bridge
  // (CLAUDE.md §8). Measured cost: 80 error-level lines in a user's local log
  // over 4 days (including TLS failures that broke their mailbox) against zero
  // events in Sentry over 30 days.

  it('reports exactly one Sentry event per handler failure, with the channel and without the arguments', async () => {
    const failure = new Error('550 5.1.1 <victim@example.com>: Recipient address rejected')
    handleIpc('net:sendMail', async () => {
      throw failure
    })
    const wrapped = handleRegistrations.get('net:sendMail')!

    // The renderer passes the full draft — body, recipients, subject.
    const draft = { accountId: 1, to: ['victim@example.com'], subject: 'Q3 payroll', body: 'secret contents' }
    await expect(wrapped(null, draft)).rejects.toThrow('550 5.1.1')

    expect(reportIpcHandlerErrorMock).toHaveBeenCalledTimes(1)
    const call = reportIpcHandlerErrorMock.mock.calls[0]!
    // EXACTLY two arguments — the channel name and the raw error, nothing else.
    // The handler's IPC arguments are structurally excluded here, so no
    // downstream sanitizer has to be trusted to strip the draft.
    expect(call).toHaveLength(2)
    expect(call[0]).toBe('net:sendMail')
    expect(call[1]).toBe(failure)
    expect(call).not.toContain(draft)
  })

  it('does not report anything when the handler succeeds', async () => {
    handleIpc('test:ok', async () => 'fine')
    await handleRegistrations.get('test:ok')!(null)
    expect(reportIpcHandlerErrorMock).not.toHaveBeenCalled()
  })

  it('reports non-Error throws too (the funnel must not depend on the thrown shape)', async () => {
    handleIpc('test:throwString', async () => {
      throw 'plain string failure'
    })
    // §2.127: the funnel re-throws a tagged Error rather than the raw value,
    // because the presentation key has to reach the renderer and the message
    // is the only field that survives Electron's IPC serializer. The original
    // value is preserved verbatim in the text and in `cause`.
    const rejection = await rejectionOf('test:throwString')
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toContain('plain string failure')
    expect((rejection as { cause?: unknown }).cause).toBe('plain string failure')

    expect(reportIpcHandlerErrorMock).toHaveBeenCalledTimes(1)
    expect(reportIpcHandlerErrorMock.mock.calls[0]![0]).toBe('test:throwString')
  })

  it('still rejects toward the renderer when the Sentry reporter itself throws', async () => {
    // CLAUDE.md §8: a broken telemetry sink must never break the feature. The
    // ORIGINAL error has to win — not the telemetry failure.
    reportIpcHandlerErrorMock.mockImplementation(() => {
      throw new Error('sentry transport exploded')
    })

    const original = new Error('original handler failure')
    handleIpc('test:sentryBroken', async () => {
      throw original
    })

    const rejection = await rejectionOf('test:sentryBroken')
    // The rejection describes the HANDLER failure (wrapped with its
    // presentation tag), not the telemetry failure, and keeps the original
    // object reachable through `cause`.
    expect((rejection as Error).message).toContain('original handler failure')
    expect((rejection as Error).message).not.toContain('sentry transport exploded')
    expect((rejection as { cause?: unknown }).cause).toBe(original)
    expect(reportIpcHandlerErrorMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the slow-IPC accounting intact when the Sentry reporter throws', async () => {
    // The reporter is called inside the catch block; the `finally` block that
    // owns inflight cleanup + the slow-IPC histogram must still run.
    reportIpcHandlerErrorMock.mockImplementation(() => {
      throw new Error('sentry transport exploded')
    })
    let t = 6_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => t)

    handleIpc('test:slowFail', async () => {
      t += 800
      throw new Error('boom')
    })
    await expect(handleRegistrations.get('test:slowFail')!(null)).rejects.toThrow('boom')

    expect(recordHistogramMock).toHaveBeenCalledWith(
      'ipc.slow_ms',
      800,
      expect.objectContaining({ channel: 'test:slowFail' }),
    )
    dateSpy.mockRestore()
  })

  it('emits slow-IPC warning and ipc.slow_ms histogram above threshold', async () => {
    let t = 1_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => t)

    handleIpc('test:slow', async () => {
      t += 700 // advance beyond SLOW_IPC_THRESHOLD_MS (500)
      return 'ok'
    })
    const wrapped = handleRegistrations.get('test:slow')!
    await wrapped(null)

    expect(logCalls.warn.some((args) => String(args[0]).includes('slow [test:slow]'))).toBe(true)
    expect(recordHistogramMock).toHaveBeenCalledWith(
      'ipc.slow_ms',
      700,
      expect.objectContaining({ channel: 'test:slow' }),
    )

    dateSpy.mockRestore()
  })

  it('does not emit slow-IPC warning for long-running allow-listed channels', async () => {
    let t = 2_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => t)

    // `ai:chat` is on SLOW_IPC_EXCLUDE.
    handleIpc('ai:chat', async () => {
      t += 5_000
      return 'ok'
    })
    const wrapped = handleRegistrations.get('ai:chat')!
    await wrapped(null)

    expect(logCalls.warn.some((args) => String(args[0]).includes('slow'))).toBe(false)
    expect(recordHistogramMock).not.toHaveBeenCalledWith('ipc.slow_ms', expect.anything(), expect.anything())

    dateSpy.mockRestore()
  })

  it('does not emit slow-IPC warning for log:uiFreeze (self-exclusion)', async () => {
    // Regression guard: log:uiFreeze is registered through handleIpc, so if
    // a freeze report itself takes >500ms it would trigger a slow-IPC warning
    // for the freeze reporter — pure noise. The channel is allow-listed in
    // SLOW_IPC_EXCLUDE for exactly that reason.
    let t = 3_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => t)

    handleIpc('log:uiFreeze', async () => {
      t += 900
    })
    const wrapped = handleRegistrations.get('log:uiFreeze')!
    await wrapped(null)

    expect(logCalls.warn.some((args) => String(args[0]).includes('slow'))).toBe(false)

    dateSpy.mockRestore()
  })

  it('does not warn for fast handlers under the threshold', async () => {
    let t = 4_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => t)

    handleIpc('test:fast', async () => {
      t += 10
    })
    await handleRegistrations.get('test:fast')!(null)

    expect(logCalls.warn).toHaveLength(0)
    expect(recordHistogramMock).not.toHaveBeenCalled()

    dateSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// registerUiFreezeHandler — inflight snapshot semantics
// ---------------------------------------------------------------------------

describe('registerUiFreezeHandler', () => {
  it('short-circuits on startup-ping payload without recording a histogram', async () => {
    registerUiFreezeHandler()
    const freezeHandler = handleRegistrations.get('log:uiFreeze')!

    await freezeHandler(null, { startup: true, at: '2026-01-01T00:00:00.000Z' })

    expect(logCalls.info.some((args) => String(args[0]).includes('renderer freeze detector active'))).toBe(true)
    // No freeze warning, no histogram — startup ping is informational only.
    expect(logCalls.warn).toHaveLength(0)
    expect(recordHistogramMock).not.toHaveBeenCalled()
  })

  it('filters log:uiFreeze itself out of the inflight snapshot (round-1 regression guard)', async () => {
    // handleIpc inserts the current channel into inflightIpc before invoking
    // the handler. Without the filter, every freeze report would list itself
    // as inflight and inflate `inflight_count` by 1. This test constructs
    // exactly that scenario: one concurrent background handler is running,
    // and we invoke log:uiFreeze through the real handleIpc wrapper so the
    // freeze channel appears in inflightIpc at report time.

    registerUiFreezeHandler()

    // Register a background handler that we can hold open.
    let resolveBg!: () => void
    const bgDone = new Promise<void>((r) => { resolveBg = r })
    handleIpc('net:syncFolderHeaders', async () => {
      await bgDone
    })

    // Start the background IPC — do NOT await it yet. The wrapper will insert
    // 'net:syncFolderHeaders' into inflightIpc and then suspend at `await bgDone`.
    const bgPromise = handleRegistrations.get('net:syncFolderHeaders')!(null)

    // Invoke the freeze reporter through its wrapped handler. This is the
    // handleIpc-wrapped version (registerUiFreezeHandler uses handleIpc), so
    // inflightIpc will contain BOTH channels at report time.
    const wrappedFreeze = handleRegistrations.get('log:uiFreeze')!
    await wrappedFreeze(null, { lagMs: 300, deltaMs: 400, at: '2026-01-01T00:00:00.000Z' })

    // Histogram MUST report inflight_count=1 and oldest_inflight=net:syncFolderHeaders,
    // not 2 or log:uiFreeze. This is the exact regression guard.
    expect(recordHistogramMock).toHaveBeenCalledWith(
      'ui.freeze.renderer_ms',
      300,
      expect.objectContaining({
        inflight_count: 1,
        oldest_inflight: 'net:syncFolderHeaders',
      }),
    )

    // Log line should mention the background channel but NOT log:uiFreeze.
    const warnLine = String(logCalls.warn[0]?.[0] ?? '')
    expect(warnLine).toContain('net:syncFolderHeaders')
    expect(warnLine).not.toContain('log:uiFreeze(')

    resolveBg()
    await bgPromise
  })

  it('records inflight_count=0 / oldest_inflight=none when no other IPC is in flight', async () => {
    registerUiFreezeHandler()
    const wrappedFreeze = handleRegistrations.get('log:uiFreeze')!

    await wrappedFreeze(null, { lagMs: 250, deltaMs: 350, at: '2026-01-01T00:00:00.000Z' })

    expect(recordHistogramMock).toHaveBeenCalledWith(
      'ui.freeze.renderer_ms',
      250,
      expect.objectContaining({
        inflight_count: 0,
        oldest_inflight: 'none',
      }),
    )
  })

  it('attributes the freeze to the OLDEST-inflight channel, not the newest', async () => {
    registerUiFreezeHandler()

    let resolveOld!: () => void
    let resolveNew!: () => void
    const oldDone = new Promise<void>((r) => { resolveOld = r })
    const newDone = new Promise<void>((r) => { resolveNew = r })

    // Use fake time so the "old" handler's start is provably earlier than "new".
    let t = 5_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => t)

    handleIpc('net:folderPage', async () => { await oldDone })
    handleIpc('net:inboxSummaries', async () => { await newDone })

    // Start the older one first (time = 5_000_000).
    const oldPromise = handleRegistrations.get('net:folderPage')!(null)
    // Advance time so the newer one starts strictly later.
    t += 100
    const newPromise = handleRegistrations.get('net:inboxSummaries')!(null)

    t += 50
    // Now fire freeze report. inflightIpc = { net:folderPage(start=5_000_000), net:inboxSummaries(start=5_000_100), log:uiFreeze(start=5_000_150) }.
    // After self-filter: oldest is net:folderPage.
    const wrappedFreeze = handleRegistrations.get('log:uiFreeze')!
    await wrappedFreeze(null, { lagMs: 400, deltaMs: 500, at: 'x' })

    expect(recordHistogramMock).toHaveBeenCalledWith(
      'ui.freeze.renderer_ms',
      400,
      expect.objectContaining({
        inflight_count: 2,
        oldest_inflight: 'net:folderPage',
      }),
    )

    dateSpy.mockRestore()
    resolveOld()
    resolveNew()
    await Promise.all([oldPromise, newPromise])
  })
})

// ---------------------------------------------------------------------------
// registerMetricsRecordHandler — schema validation
// ---------------------------------------------------------------------------

describe('registerMetricsRecordHandler', () => {
  it('dispatches a valid event to recordEvent with whitelisted tags', () => {
    registerMetricsRecordHandler()
    const onHandler = onRegistrations.get('metrics:record')!

    onHandler(null, {
      name: 'app.session_started',
      kind: 'event',
      tags: {
        version: '1.2.3',
        platform: 'linux',
        theme: 'dark',
        lang: 'en',
        accounts_count: 2,
        install_id_hash: 'abcd',
        // Unknown tag must be stripped:
        malicious_extra: 'drop-me',
      },
    })

    expect(recordEventMock).toHaveBeenCalledTimes(1)
    const [name, tags] = recordEventMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe('app.session_started')
    expect(tags).toEqual({
      version: '1.2.3',
      platform: 'linux',
      theme: 'dark',
      lang: 'en',
      accounts_count: 2,
      install_id_hash: 'abcd',
    })
    expect(tags.malicious_extra).toBeUndefined()

    // Feature-reach marker fires for every valid payload.
    expect(markFeatureReachFromEventMock).toHaveBeenCalledWith('app.session_started')
  })

  it('rejects unknown metric names without recording anything', () => {
    registerMetricsRecordHandler()
    const onHandler = onRegistrations.get('metrics:record')!

    onHandler(null, { name: 'totally.fake.event', kind: 'event', tags: {} })

    expect(recordEventMock).not.toHaveBeenCalled()
    expect(recordHistogramMock).not.toHaveBeenCalled()
    expect(recordGaugeMock).not.toHaveBeenCalled()
    expect(logCalls.warn.some((args) => String(args[0]).includes('rejecting unknown metric'))).toBe(true)
  })

  it('rejects payloads whose kind does not match the schema', () => {
    registerMetricsRecordHandler()
    const onHandler = onRegistrations.get('metrics:record')!

    // app.session_started is kind=event; sending kind=histogram must be rejected.
    onHandler(null, { name: 'app.session_started', kind: 'histogram', value: 100, tags: {} })

    expect(recordEventMock).not.toHaveBeenCalled()
    expect(recordHistogramMock).not.toHaveBeenCalled()
    expect(logCalls.warn.some((args) => String(args[0]).includes('metric kind mismatch'))).toBe(true)
  })

  it('silently drops malformed payloads without throwing', () => {
    registerMetricsRecordHandler()
    const onHandler = onRegistrations.get('metrics:record')!

    expect(() => onHandler(null, null)).not.toThrow()
    expect(() => onHandler(null, 'not-an-object')).not.toThrow()
    expect(() => onHandler(null, { name: 42, kind: 'event' })).not.toThrow()
    expect(() => onHandler(null, { kind: 'event' })).not.toThrow() // missing name

    expect(recordEventMock).not.toHaveBeenCalled()
  })

  it('coerces non-number histogram value to 0', () => {
    // Pick a histogram event that exists in the schema — ipc.slow_ms has kind
    // 'histogram' and a `channel` tag.
    registerMetricsRecordHandler()
    const onHandler = onRegistrations.get('metrics:record')!

    onHandler(null, {
      name: 'ipc.slow_ms',
      kind: 'histogram',
      value: 'not-a-number',
      tags: { channel: 'test:channel' },
    })

    // Handler should have been invoked with value coerced to 0, not skipped.
    // (This matches the `typeof p.value === 'number' ? p.value : 0` branch.)
    const calls = recordHistogramMock.mock.calls.filter(([name]) => name === 'ipc.slow_ms')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toBe(0)
  })

  // §2.23 PR1 — mainOnly bridge gate for send_queue.append_failed.
  // This event is emitted only from the main-process catch block in
  // sendMailWithAccountConfig; a compromised renderer must not be able to
  // fabricate or suppress it via the metrics:record IPC bridge.
  it('rejects send_queue.append_failed (mainOnly=true) from renderer without recording anything', () => {
    registerMetricsRecordHandler()
    const onHandler = onRegistrations.get('metrics:record')!

    onHandler(null, {
      name: 'send_queue.append_failed',
      kind: 'event',
      tags: { reason: 'quota', provider_id: 'gmail' },
    })

    expect(recordEventMock).not.toHaveBeenCalled()
    expect(recordHistogramMock).not.toHaveBeenCalled()
    expect(logCalls.warn.some((args) =>
      String(args[0]).includes('rejecting main-only metric'),
    )).toBe(true)
  })

  // §2.156 — ui.freeze.renderer_ms (mainOnly=true). Named for the renderer but
  // emitted by main: the renderer only sends numbers over `log:uiFreeze`, and
  // registerUiFreezeHandler derives `oldest_inflight` from `inflightIpc`, which
  // the renderer cannot write to. The bridge is therefore never a legitimate
  // path for this name.
  it('rejects ui.freeze.renderer_ms (mainOnly=true) from renderer without recording anything', () => {
    registerMetricsRecordHandler()
    const onHandler = onRegistrations.get('metrics:record')!

    onHandler(null, {
      name: 'ui.freeze.renderer_ms',
      kind: 'histogram',
      value: 700,
      tags: { duration_bucket: 'bucket_700', inflight_count: 0, oldest_inflight: 'Fwd: bank statement — bob@example.test' },
    })

    expect(recordHistogramMock).not.toHaveBeenCalled()
    expect(recordEventMock).not.toHaveBeenCalled()
    expect(logCalls.warn.some((args) =>
      String(args[0]).includes('rejecting main-only metric'),
    )).toBe(true)
    expect(JSON.stringify(logCalls)).not.toContain('bob@example.test')
  })

  // The legitimate path — main turning a renderer lag report into the metric —
  // must keep working; a flag that silenced it would trade one defect for
  // another.
  it('still records ui.freeze.renderer_ms when main handles a log:uiFreeze report', () => {
    registerUiFreezeHandler()
    const freezeHandler = handleRegistrations.get('log:uiFreeze')!
    freezeHandler(null, { lagMs: 350, deltaMs: 1350, at: 'test' })

    const call = recordHistogramMock.mock.calls.find((c) => c[0] === 'ui.freeze.renderer_ms')
    expect(call).toBeDefined()
    expect(call![1]).toBe(350)
  })

  // §2.156 — ui.freeze.main_ms (mainOnly=true). The watchdog in main is its
  // only emitter, and two of its tags (`top_sql`, `oldest_inflight`) are
  // free-form strings that the per-tag enum check cannot narrow. Without the
  // flag, a compromised renderer could post arbitrary text — a subject line, an
  // address, a search query — into Sentry under a name the disclosure page
  // describes as "verb + table".
  it('rejects ui.freeze.main_ms (mainOnly=true) from renderer without recording anything', () => {
    registerMetricsRecordHandler()
    const onHandler = onRegistrations.get('metrics:record')!

    onHandler(null, {
      name: 'ui.freeze.main_ms',
      kind: 'histogram',
      value: 900,
      tags: { duration_bucket: 'bucket_900', inflight_count: 0, top_sql: 'Re: salary review — alice@example.test' },
    })

    expect(recordHistogramMock).not.toHaveBeenCalled()
    expect(recordEventMock).not.toHaveBeenCalled()
    expect(logCalls.warn.some((args) =>
      String(args[0]).includes('rejecting main-only metric'),
    )).toBe(true)
    // The rejected value must not survive anywhere in what we logged either.
    expect(JSON.stringify(logCalls)).not.toContain('alice@example.test')
  })

  // The other half of the same rule: the main-process watchdog still records
  // it. A `mainOnly` flag that also silenced the legitimate emitter would trade
  // one defect for another.
  it('still records ui.freeze.main_ms when the main-process watchdog emits it', async () => {
    vi.useFakeTimers()
    startMainLoopFreezeWatchdog({
      drainSlowSql: () => [{ digest: 'select messages', fingerprint: 'adc55a42', durationMs: 300, at: Date.now() }],
    })
    eventLoopDelay.max = 400 * 1e6
    await vi.advanceTimersByTimeAsync(1000)

    const call = recordHistogramMock.mock.calls.find((c) => c[0] === 'ui.freeze.main_ms')
    expect(call).toBeDefined()
    expect(call![2]).toMatchObject({ top_sql: 'select messages' })
  })

  // §2.122 — ai.api_key_store_op (mainOnly=true). Emitted only from
  // electron/services/ai.ts on a read/write/delete of a stored AI key; a
  // compromised renderer must not be able to fabricate a clean storage
  // history (or mask a real one) through the metrics:record bridge.
  it('rejects ai.api_key_store_op (mainOnly=true) from renderer without recording anything', () => {
    registerMetricsRecordHandler()
    const onHandler = onRegistrations.get('metrics:record')!

    onHandler(null, {
      name: 'ai.api_key_store_op',
      kind: 'event',
      tags: { op: 'delete', provider: 'anthropic-api', outcome: 'ok' },
    })

    expect(recordEventMock).not.toHaveBeenCalled()
    expect(recordHistogramMock).not.toHaveBeenCalled()
    expect(logCalls.warn.some((args) =>
      String(args[0]).includes('rejecting main-only metric'),
    )).toBe(true)
  })

  // imap.header_response_unaddressable (mainOnly=true). Its only legitimate
  // emitter is packages/net, bridged through setNetEventReporter in main.ts,
  // so the flag silences nothing real. Both tags are enum domains, which means
  // a compromised renderer could post a perfectly well-formed lie and invent a
  // FETCH regression at one named provider that never happened.
  it('rejects imap.header_response_unaddressable (mainOnly=true) from renderer', () => {
    registerMetricsRecordHandler()
    const onHandler = onRegistrations.get('metrics:record')!

    onHandler(null, {
      name: 'imap.header_response_unaddressable',
      kind: 'event',
      tags: { folder_role: 'inbox', provider: 'gmail' },
    })

    expect(recordEventMock).not.toHaveBeenCalled()
    expect(logCalls.warn.some((args) =>
      String(args[0]).includes('rejecting main-only metric'),
    )).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// startMainLoopFreezeWatchdog — §2.156 attribution
// ---------------------------------------------------------------------------

describe('startMainLoopFreezeWatchdog', () => {
  /** Report a `maxMs` stall to the watchdog on its next poll. */
  async function poll(maxMs: number) {
    eventLoopDelay.max = maxMs * 1e6
    await vi.advanceTimersByTimeAsync(1000)
  }

  const freezeMetric = () =>
    recordHistogramMock.mock.calls.find((c) => c[0] === 'ui.freeze.main_ms')

  it('blames the slowest SQL statement of the window, not the oldest inflight IPC', async () => {
    vi.useFakeTimers()
    // The field case: an IPC handler that is merely waiting on the network is
    // the oldest inflight one, while the event loop was actually held by a
    // synchronous SQLite call.
    handleIpc('net:setSeen', async () => new Promise(() => {}))
    void handleRegistrations.get('net:setSeen')!(null)

    startMainLoopFreezeWatchdog({
      drainSlowSql: () => [
        { digest: 'select messages', fingerprint: 'adc55a42', durationMs: 420, at: Date.now() },
        { digest: 'pragma wal_checkpoint', fingerprint: '11aa22bb', durationMs: 90, at: Date.now() },
      ],
    })
    await poll(500)

    const call = freezeMetric()!
    expect(call[2]).toMatchObject({ top_sql: 'select messages', sql_ms: 420 })
    // The inflight snapshot is still reported — as context. It names a
    // network-bound handler that occupied no event-loop time at all, which is
    // precisely why it must not be the thing the metric blames.
    expect(typeof (call[2] as { oldest_inflight?: unknown }).oldest_inflight).toBe('string')
    expect((call[2] as { oldest_inflight?: unknown }).oldest_inflight).not.toBe('none')
    // Kills the reintroduction of `top_inflight`, which read as "the culprit"
    // while naming a handler that costs the event loop nothing.
    expect(Object.keys(call[2] as object)).not.toContain('top_inflight')

    const warned = String(logCalls.warn[logCalls.warn.length - 1]![0])
    // The log names the statement by digest + fingerprint; the text of it never
    // reaches this process boundary at all.
    expect(warned).toContain('420ms select messages sql=adc55a42')
  })

  it('says so honestly when nothing was attributable', async () => {
    vi.useFakeTimers()
    startMainLoopFreezeWatchdog({ drainSlowSql: () => [] })
    await poll(300)
    expect(freezeMetric()![2]).toMatchObject({ top_sql: 'none', sql_ms: 0 })
  })

  it('drains every poll so a stale sample cannot be blamed for a later freeze', async () => {
    vi.useFakeTimers()
    let drains = 0
    const samples = [{ digest: 'select messages', fingerprint: 'deadbeef', durationMs: 300, at: Date.now() }]
    startMainLoopFreezeWatchdog({
      drainSlowSql: () => {
        drains += 1
        return samples.splice(0, samples.length)
      },
    })

    await poll(10)   // quiet window: below the freeze threshold, still drained
    await poll(900)  // freeze in a window whose statements were all fast

    expect(drains).toBe(2)
    expect(freezeMetric()![2]).toMatchObject({ top_sql: 'none', sql_ms: 0 })
  })

  it('never attributes SQL that ran before it started, and reports it separately', async () => {
    vi.useFakeTimers()
    // packages/db instruments itself when the database opens — i.e. before this
    // watchdog exists — so its buffer already holds the schema migrations.
    const migration = () => [{
      digest: 'create idx_messages_folder',
      fingerprint: 'c0ffee11',
      durationMs: 3_400,
      at: Date.now() - 5_000,
    }]
    startMainLoopFreezeWatchdog({ drainSlowSql: migration })
    await poll(700)

    // Kills: draining the whole buffer on the first poll and handing a startup
    // migration to whatever froze afterwards.
    expect(freezeMetric()![2]).toMatchObject({ top_sql: 'none', sql_ms: 0 })
    // Not dropped either — reported on its own line, attributed to nothing.
    const startupLine = logCalls.info.map((a) => String(a[0])).find((l) => l.includes('before the watchdog started'))
    expect(startupLine).toContain('3400ms create idx_messages_folder sql=c0ffee11')
    expect(startupLine).not.toContain('blocked')
  })

  it('keeps samples that completed inside the measured window', async () => {
    vi.useFakeTimers()
    startMainLoopFreezeWatchdog({
      drainSlowSql: () => [{ digest: 'select messages', fingerprint: 'abcd1234', durationMs: 260, at: Date.now() }],
    })
    await poll(300)
    expect(freezeMetric()![2]).toMatchObject({ top_sql: 'select messages', sql_ms: 260 })
  })

  it('stays silent below the threshold and survives a throwing probe', async () => {
    vi.useFakeTimers()
    startMainLoopFreezeWatchdog({
      drainSlowSql: () => { throw new Error('db closed') },
    })
    await poll(150)
    expect(freezeMetric()).toBeUndefined()

    await poll(400)
    expect(freezeMetric()![2]).toMatchObject({ top_sql: 'none' })
  })
})
