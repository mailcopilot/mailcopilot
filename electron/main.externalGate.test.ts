/**
 * §2.25 (re-diagnosis) — mirror test for the `openExternalGated` funnel in
 * `electron/main.ts`.
 *
 * `openExternalGated` is the single, process-wide choke point in front of every
 * `shell.openExternal` call. It is a private async function inside the 9000-LoC
 * `main.ts` hotspot and cannot be imported directly. This file mirrors it with
 * injectable deps — the same technique used in `main.periodicSync.test.ts`,
 * `main.drafts.test.ts`, and `main.auditLogClear.test.ts`.
 *
 * The mirror pins four behaviours that the pure `ExternalOpenGate` token-bucket
 * tests (externalOpenGate.test.ts) cannot cover in isolation:
 *
 *   1. IS_E2E guard — in test mode no real browser is spawned; the gate is still
 *      exercised but openExternal is never called.
 *   2. Protocol-validation gate — blocked URLs (file:, javascript:, etc.) are
 *      rejected before reaching the token bucket; the bucket is not consumed.
 *   3. Metric emission on every denial — `recordEvent('links.external_open_suppressed')`
 *      is called with the call-site `source` tag; metric failures are swallowed.
 *   4. Sentry capture on anomaly — `captureException` is called exactly once per
 *      storm (when `decision.anomaly` is true), never on every denial.
 *   5. Bounded logging — `log.warn` fires only at the START of a dry spell
 *      (suppressedCount === 1) and at anomaly, NOT on every suppressed call.
 *   6. Fire-and-forget — `openExternal` is NOT awaited; the IPC handler reply
 *      (`{ok:true}`) is unblocked even if xdg-open hangs for seconds.
 *   7. Synchronous throws from `openExternal` are swallowed; the caller never
 *      sees them, and the dispatch decision is reported as `false`.
 *   8. Async rejections from `openExternal` are caught by an attached `.catch`
 *      (sanitized log, no URL) so they never escape to `unhandledRejection`.
 *   9. Trust-class routing — 'oauth'/'update_dialog' use the trusted bucket,
 *      everything else the untrusted bucket, so a content storm cannot starve
 *      OAuth/update opens.
 *  10. Dispatch decision — the function returns a boolean (true only when the
 *      URL was actually handed to `openExternal`), so callers like the
 *      unsubscribe fallback do not report a suppressed open as success.
 *
 * Any drift between this mirror and the production `openExternalGated` function
 * in electron/main.ts is a regression risk — keep the mirror in sync.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  ExternalOpenGate,
  EXTERNAL_OPEN_ANOMALY_THRESHOLD,
  EXTERNAL_OPEN_BUCKET_CAPACITY,
  EXTERNAL_OPEN_REFILL_INTERVAL_MS,
  isTrustedOpenSource,
} from './externalOpenGate'
import { isAllowedExternalUrl } from './mailLinkRouter'

// ─── Mirror: openExternalGated with injectable deps ───────────────────────────
// Keep in sync with electron/main.ts §2.25 openExternalGated section.

interface FunnelDeps {
  isE2E: boolean
  /** Mirrors `isAllowedExternalUrl(url)` from mailLinkRouter. */
  isAllowedProtocol: (url: string) => boolean
  /** Mirrors the process-wide `externalOpenGateTrusted` instance. */
  trustedGate: ExternalOpenGate
  /** Mirrors the process-wide `externalOpenGateUntrusted` instance. */
  untrustedGate: ExternalOpenGate
  /** Mirrors `recordEvent('links.external_open_suppressed', { source })`. */
  recordEvent: (event: string, attrs: { source: string }) => void
  /** Mirrors `captureException(err, extra)` from electron/sentry.ts. */
  capture: (err: Error, extra: Record<string, unknown>) => void
  /** Mirrors `logExternalOpen.warn(msg)`. */
  log: (msg: string) => void
  /** Mirrors `shell.openExternal(url)` — fire-and-forget in production. */
  openExternal: (url: string) => Promise<void>
}

async function mirrorOpenExternalGated(
  url: string,
  source: string,
  deps: FunnelDeps,
): Promise<boolean> {
  if (deps.isE2E) return true
  if (!deps.isAllowedProtocol(url)) {
    deps.log(`blocked external open: disallowed protocol from source=${source}`)
    return false
  }
  // Trust-class routing: oauth/update_dialog → trusted bucket, else untrusted.
  const gate = isTrustedOpenSource(source) ? deps.trustedGate : deps.untrustedGate
  const decision = gate.tryAcquire()
  if (!decision.allowed) {
    try {
      deps.recordEvent('links.external_open_suppressed', { source })
    } catch {
      /* telemetry must not block or surface errors to the caller */
    }
    // Log only at the start of a dry spell and at storm anomaly — NOT on every
    // suppressed call. A runaway can produce thousands; logging each would defeat
    // the log's diagnostic purpose and flood disk.
    if (decision.suppressedCount === 1 || decision.anomaly) {
      deps.log(
        `external open suppressed by gate source=${source} suppressedCount=${decision.suppressedCount ?? 0}${decision.anomaly ? ' (storm anomaly)' : ''}`,
      )
    }
    if (decision.anomaly) {
      deps.capture(new Error('external open storm suppressed by gate'), {
        source: 'externalOpenGate',
        openSource: source,
        suppressedCount: decision.suppressedCount,
        capacity: EXTERNAL_OPEN_BUCKET_CAPACITY,
        refillIntervalMs: EXTERNAL_OPEN_REFILL_INTERVAL_MS,
      })
    }
    return false
  }
  try {
    // Fire-and-forget by design: a hung xdg-open/gio/snap chain must never
    // hold the IPC handler reply hostage. The caller MUST NOT await this. The
    // attached `.catch` keeps an async rejection from escaping to the global
    // unhandledRejection handler; sanitized — code/source only, never the URL.
    void deps.openExternal(url).catch((err) => {
      deps.log(`shell.openExternal rejected for source=${source}: ${(err as { code?: string })?.code ?? 'unknown'}`)
    })
  } catch (err) {
    deps.log(`shell.openExternal threw for source=${source}: ${(err as { code?: string })?.code ?? 'unknown'}`)
    return false
  }
  return true
}

// ─── Shared test helper ───────────────────────────────────────────────────────

type GateDepsOverrides = Partial<Omit<FunnelDeps, 'trustedGate' | 'untrustedGate'>> & {
  /** Shortcut: wire BOTH buckets to one instance (most tests use one source). */
  gate?: ExternalOpenGate
  trustedGate?: ExternalOpenGate
  untrustedGate?: ExternalOpenGate
}

function makeGateDeps(overrides: GateDepsOverrides = {}): FunnelDeps {
  const { gate, trustedGate, untrustedGate, ...rest } = overrides
  const shared = gate ?? new ExternalOpenGate(() => 0)
  return {
    isE2E: false,
    isAllowedProtocol: isAllowedExternalUrl,
    trustedGate: trustedGate ?? shared,
    untrustedGate: untrustedGate ?? shared,
    recordEvent: vi.fn(),
    capture: vi.fn(),
    log: vi.fn(),
    openExternal: vi.fn().mockResolvedValue(undefined),
    ...rest,
  }
}

// Helper: drain the gate bucket down to empty.
function drainGate(gate: ExternalOpenGate): void {
  for (let i = 0; i < EXTERNAL_OPEN_BUCKET_CAPACITY; i++) gate.tryAcquire()
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('§2.25 openExternalGated mirror — IS_E2E guard', () => {
  it('is a no-op in e2e mode: openExternal is never called', async () => {
    const deps = makeGateDeps({ isE2E: true })
    await mirrorOpenExternalGated('https://example.com', 'test', deps)
    expect((deps.openExternal as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('records no metric and captures nothing in e2e mode', async () => {
    const deps = makeGateDeps({ isE2E: true })
    await mirrorOpenExternalGated('https://example.com', 'test', deps)
    expect((deps.recordEvent as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect((deps.capture as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })
})

describe('§2.25 openExternalGated mirror — protocol validation', () => {
  it('blocks file: protocol and never calls openExternal', async () => {
    const deps = makeGateDeps()
    await mirrorOpenExternalGated('file:///etc/passwd', 'test', deps)
    expect((deps.openExternal as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('blocks javascript: protocol', async () => {
    const deps = makeGateDeps()
    await mirrorOpenExternalGated('javascript:alert(1)', 'ui_ipc', deps)
    expect((deps.openExternal as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('blocked protocol logs a warning but does NOT record a metric (bucket is not consumed)', async () => {
    const deps = makeGateDeps()
    await mirrorOpenExternalGated('file:///etc/passwd', 'test', deps)
    expect((deps.log as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    expect((deps.recordEvent as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('passes https:// to openExternal', async () => {
    const deps = makeGateDeps()
    await mirrorOpenExternalGated('https://docs.mailcopilot.io/download', 'update_dialog', deps)
    expect((deps.openExternal as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'https://docs.mailcopilot.io/download',
    )
  })

  it('passes http:// to openExternal', async () => {
    const deps = makeGateDeps()
    await mirrorOpenExternalGated('http://example.com', 'window_open', deps)
    expect((deps.openExternal as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('http://example.com')
  })

  it('passes mailto: to openExternal', async () => {
    const deps = makeGateDeps()
    await mirrorOpenExternalGated('mailto:user@example.com', 'ui_ipc', deps)
    expect((deps.openExternal as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('mailto:user@example.com')
  })
})

describe('§2.25 openExternalGated mirror — gate allowed path', () => {
  it('dispatches to openExternal with the exact URL when gate grants a token', async () => {
    const deps = makeGateDeps()
    await mirrorOpenExternalGated('https://example.com/page', 'oauth', deps)
    expect((deps.openExternal as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    expect((deps.openExternal as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('https://example.com/page')
  })

  it('records no metric and captures nothing on an allowed dispatch', async () => {
    const deps = makeGateDeps()
    await mirrorOpenExternalGated('https://example.com', 'test', deps)
    expect((deps.recordEvent as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect((deps.capture as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('fire-and-forget: function resolves without waiting for openExternal to settle', async () => {
    const openExternalCalls: string[] = []

    // openExternal returns a Promise that never resolves — simulates a hung
    // xdg-open/gio/snap chain. If mirrorOpenExternalGated awaited this, the
    // test would time out (Vitest default: 5s). The fact it resolves instantly
    // is the proof that openExternal is truly fire-and-forget.
    const deps = makeGateDeps({
      openExternal: (url) => {
        openExternalCalls.push(url)
        return new Promise<void>(() => { /* never resolves — models hung xdg-open */ })
      },
    })

    await mirrorOpenExternalGated('https://example.com/pending', 'ui_ipc', deps)

    // openExternal was invoked (the call was fired)...
    expect(openExternalCalls).toEqual(['https://example.com/pending'])
    // ...but we reached this line immediately — not awaited.
  })

  it('swallows a synchronous throw from openExternal and reports dispatch failed', async () => {
    const deps = makeGateDeps({
      openExternal: () => { throw Object.assign(new Error('sync throw from openExternal'), { code: 'EBADHANDLER' }) },
    })
    // The throw is swallowed (function resolves) and the dispatch decision is
    // false — the open never reached the OS.
    await expect(
      mirrorOpenExternalGated('https://example.com', 'window_open', deps),
    ).resolves.toBe(false)
  })

  it('sync-throw log is sanitized: it carries the error code, never the URL or message', async () => {
    const deps = makeGateDeps({
      openExternal: () => { throw Object.assign(new Error('handler blew up for https://secret.example/abc'), { code: 'EBADHANDLER' }) },
    })
    await mirrorOpenExternalGated('https://secret.example/abc', 'window_open', deps)
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls.flat()
    expect(logged.some((m) => typeof m === 'string' && m.includes('EBADHANDLER'))).toBe(true)
    expect(logged.some((m) => typeof m === 'string' && m.includes('secret.example'))).toBe(false)
    expect(logged.some((m) => typeof m === 'string' && m.includes('blew up'))).toBe(false)
  })

  it('swallows an ASYNC rejection: no unhandledRejection escapes and the log is sanitized', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const deps = makeGateDeps({
        openExternal: () =>
          Promise.reject(Object.assign(new Error('xdg-open failed for https://secret.example/token'), { code: 'EXDG' })),
      })
      // Dispatch decision is independent of OS outcome — the call was handed off.
      const dispatched = await mirrorOpenExternalGated('https://secret.example/token', 'ui_ipc', deps)
      expect(dispatched).toBe(true)

      // Flush the rejection microtask/macrotask so the .catch (or, if it leaked,
      // the unhandledRejection handler) has run.
      await new Promise((resolve) => setTimeout(resolve, 0))

      // The attached .catch consumed the rejection — nothing escaped.
      expect(unhandled).toHaveLength(0)

      // The .catch log is sanitized: code only, never the URL or err.message.
      const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls.flat()
      expect(logged.some((m) => typeof m === 'string' && m.includes('EXDG'))).toBe(true)
      expect(logged.some((m) => typeof m === 'string' && m.includes('secret.example'))).toBe(false)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('§2.25 openExternalGated mirror — gate denied path', () => {
  it('does not call openExternal when the token bucket is empty', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    const deps = makeGateDeps({ gate })
    await mirrorOpenExternalGated('https://example.com', 'ui_ipc', deps)
    expect((deps.openExternal as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('records the suppression metric with the source tag on denial', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    const deps = makeGateDeps({ gate })
    await mirrorOpenExternalGated('https://example.com', 'unsubscribe', deps)
    expect((deps.recordEvent as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    expect((deps.recordEvent as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('links.external_open_suppressed', { source: 'unsubscribe' })
  })

  it('logs on the first denial of the dry spell (suppressedCount === 1)', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    const deps = makeGateDeps({ gate })
    await mirrorOpenExternalGated('https://example.com', 'test', deps)
    // suppressedCount is 1 on the first denial after draining the bucket.
    expect((deps.log as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
  })

  it('does NOT log on subsequent denials (suppressedCount > 1, no anomaly)', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    // First denial fills suppressedCount=1 (log fires).
    const firstDeps = makeGateDeps({ gate })
    await mirrorOpenExternalGated('https://example.com', 'test', firstDeps)

    // Second denial: suppressedCount=2 — no anomaly, no log.
    const secondDeps = makeGateDeps({ gate })
    await mirrorOpenExternalGated('https://example.com', 'test', secondDeps)
    expect((secondDeps.log as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('does not capture Sentry on sub-threshold denials', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    const deps = makeGateDeps({ gate })
    // Run one fewer than ANOMALY_THRESHOLD denials (never reaching it) — no Sentry.
    for (let i = 0; i < EXTERNAL_OPEN_ANOMALY_THRESHOLD - 1; i++) {
      await mirrorOpenExternalGated('https://example.com', 'test', deps)
    }
    expect((deps.capture as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('captures Sentry on the denial that first REACHES ANOMALY_THRESHOLD', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    const deps = makeGateDeps({ gate })
    // Exactly ANOMALY_THRESHOLD denials trips the anomaly on denial #10.
    for (let i = 0; i < EXTERNAL_OPEN_ANOMALY_THRESHOLD; i++) {
      await mirrorOpenExternalGated('https://example.com', 'test', deps)
    }
    expect((deps.capture as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
  })

  it('captures Sentry exactly once per storm — not on every subsequent denial', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    const deps = makeGateDeps({ gate })
    // 500 denials — anomaly fires at denial #10, never again during the same dry spell.
    for (let i = 0; i < 500; i++) {
      await mirrorOpenExternalGated('https://example.com', 'test', deps)
    }
    expect((deps.capture as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
  })

  it('the anomaly Sentry capture context carries refillIntervalMs (mirror of production)', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    const deps = makeGateDeps({ gate })
    for (let i = 0; i < EXTERNAL_OPEN_ANOMALY_THRESHOLD; i++) {
      await mirrorOpenExternalGated('https://example.com', 'test', deps)
    }
    const captureMock = deps.capture as ReturnType<typeof vi.fn>
    expect(captureMock).toHaveBeenCalledOnce()
    expect(captureMock.mock.calls[0][1]).toMatchObject({
      source: 'externalOpenGate',
      openSource: 'test',
      capacity: EXTERNAL_OPEN_BUCKET_CAPACITY,
      refillIntervalMs: EXTERNAL_OPEN_REFILL_INTERVAL_MS,
    })
  })

  it('logs again at anomaly even after the initial dry-spell log', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    const deps = makeGateDeps({ gate })
    // First denial logs (suppressedCount=1). Anomaly fires at denial #10 (logs again).
    for (let i = 0; i < EXTERNAL_OPEN_ANOMALY_THRESHOLD; i++) {
      await mirrorOpenExternalGated('https://example.com', 'test', deps)
    }
    // Called exactly twice: once at suppressedCount=1 and once at anomaly.
    expect((deps.log as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
  })

  it('metric recording failure does not propagate — recordEvent throws but function resolves', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    const deps = makeGateDeps({
      gate,
      recordEvent: () => { throw new Error('metric sink unavailable') },
    })
    // A denied dispatch resolves to false even when telemetry throws.
    await expect(
      mirrorOpenExternalGated('https://example.com', 'test', deps),
    ).resolves.toBe(false)
  })
})

describe('§2.25 openExternalGated mirror — trust-class routing (OAuth starvation guard)', () => {
  it('routes oauth/update_dialog to the trusted bucket, leaving the untrusted storm isolated', async () => {
    const untrustedGate = new ExternalOpenGate(() => 0)
    const trustedGate = new ExternalOpenGate(() => 0)
    const deps = makeGateDeps({ untrustedGate, trustedGate })

    // Email-content-driven storm drains the UNTRUSTED bucket.
    for (let i = 0; i < 50; i++) {
      await mirrorOpenExternalGated('https://flood.example/loop', 'unsubscribe', deps)
    }
    // The untrusted bucket is spent — a further untrusted open is suppressed.
    const untrustedNow = await mirrorOpenExternalGated('https://flood.example/loop', 'ui_ipc', deps)
    expect(untrustedNow).toBe(false)

    // ...but a trusted OAuth open still succeeds: separate bucket, untouched.
    const oauthOpen = await mirrorOpenExternalGated('https://accounts.google.com/o/oauth2/auth', 'oauth', deps)
    expect(oauthOpen).toBe(true)
  })

  it('an update_dialog open is also routed to the trusted bucket', async () => {
    const untrustedGate = new ExternalOpenGate(() => 0)
    const trustedGate = new ExternalOpenGate(() => 0)
    const deps = makeGateDeps({ untrustedGate, trustedGate })

    for (let i = 0; i < 50; i++) {
      await mirrorOpenExternalGated('https://flood.example/loop', 'window_open', deps)
    }
    const updateOpen = await mirrorOpenExternalGated('https://docs.mailcopilot.io/download', 'update_dialog', deps)
    expect(updateOpen).toBe(true)
  })
})

describe('§2.25 unsubscribe browser-fallback result mapping', () => {
  // The unsubscribe callback is a closure registered via setUnsubscribeCallback
  // inside the 9000-LoC main.ts and is not importable; this pins the dispatch→
  // result mapping it performs, mirroring the production logic statement-shape.
  it('a suppressed dispatch is reported as not-affected (ok:false)', async () => {
    const gate = new ExternalOpenGate(() => 0)
    drainGate(gate)
    const deps = makeGateDeps({ gate })

    const dispatched = await mirrorOpenExternalGated('https://list.example/unsub', 'unsubscribe', deps)
    expect(dispatched).toBe(false)

    // Production: results.push({ method: 'browser', ok: dispatched, ... }).
    const results = [{ method: 'browser' as const, ok: dispatched }]
    const manualCount = results.filter((r) => r.method === 'browser' && r.ok).length
    expect(manualCount).toBe(0)
  })

  it('an allowed dispatch is reported as affected (ok:true)', async () => {
    const deps = makeGateDeps()

    const dispatched = await mirrorOpenExternalGated('https://list.example/unsub', 'unsubscribe', deps)
    expect(dispatched).toBe(true)

    const results = [{ method: 'browser' as const, ok: dispatched }]
    const manualCount = results.filter((r) => r.method === 'browser' && r.ok).length
    expect(manualCount).toBe(1)
  })
})
