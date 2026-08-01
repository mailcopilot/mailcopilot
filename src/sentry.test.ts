import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @sentry/react before importing the module.
vi.mock('@sentry/react', () => {
  const client = { getOptions: () => ({ enabled: true }) }
  return {
    init: vi.fn(),
    ErrorBoundary: vi.fn(),
    browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
    captureFeedback: vi.fn(),
    captureException: vi.fn(),
    setUser: vi.fn(),
    getClient: vi.fn(() => client),
    // §2.82: a consent transition drops the breadcrumb buffer.
    getCurrentScope: vi.fn(() => ({ clearBreadcrumbs: vi.fn() })),
    getIsolationScope: vi.fn(() => ({ clearBreadcrumbs: vi.fn() })),
    withScope: vi.fn((cb: (scope: { setTag: ReturnType<typeof vi.fn>; setExtras: ReturnType<typeof vi.fn> }) => void) => {
      cb({ setTag: vi.fn(), setExtras: vi.fn() })
    }),
    // Minimal startSpanManual: hands a fake span + finish fn to the callback
    // (matches @sentry/core signature (span, finish) => T) and returns whatever
    // the callback returns. Our facade only uses the span.
    startSpanManual: vi.fn((_opts: unknown, cb: (span: { setAttribute: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }, finish: () => void) => unknown) => {
      const span = { setAttribute: vi.fn(), end: vi.fn() }
      return cb(span, () => {})
    }),
  }
})

describe('sentry renderer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('setSentryUserEnabled(false) → beforeSend returns null', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry, setSentryUserEnabled } = await import('./sentry')

    initSentry()

    // Extract beforeSend from the Sentry.init call
    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    const beforeSend = initCall.beforeSend!

    // By default — sends
    const event = { exception: { values: [{ value: 'some error' }] } }
    expect(beforeSend(event as never, {} as never)).toBeTruthy()

    // Disable — filters out
    setSentryUserEnabled(false)
    expect(beforeSend(event as never, {} as never)).toBeNull()

    // Re-enable — sends
    setSentryUserEnabled(true)
    expect(beforeSend(event as never, {} as never)).toBeTruthy()
  })

  it('beforeSend filters ResizeObserver loop', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    const beforeSend = initCall.beforeSend!

    const event = { exception: { values: [{ value: 'ResizeObserver loop completed' }] } }
    expect(beforeSend(event as never, {} as never)).toBeNull()
  })

  it('beforeSend filters transient network errors via shared classifier (MAILCOPILOT-8/A)', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    const beforeSend = initCall.beforeSend!

    const transient = [
      // Wrapped IPC rejection with inner net::ERR_* — most common production case.
      "Error: Error invoking remote method 'update:download': Error: net::ERR_CONNECTION_RESET",
      "Error: Error invoking remote method 'update:download': Error: net::ERR_HTTP2_PROTOCOL_ERROR",
      // Bare Node syscall error surfaced in renderer via unhandledrejection.
      'read ECONNRESET',
      // imapflow phrase.
      'Socket timeout',
      // Chromium net:: code from webContents.
      'Error: net::ERR_INTERNET_DISCONNECTED',
    ]
    for (const msg of transient) {
      expect(beforeSend({ exception: { values: [{ value: msg }] } } as never, {} as never)).toBeNull()
    }

    // Real application errors must still pass through.
    expect(
      beforeSend(
        { exception: { values: [{ value: 'TypeError: Cannot read property "foo" of undefined' }] } } as never,
        {} as never,
      ),
    ).toBeTruthy()
  })

  it('beforeSend does NOT blanket-filter update:* IPC rejections — only transient inner errors are dropped', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    const beforeSend = initCall.beforeSend!

    // Regression guard: a previous version silenced ANY rejection from
    // update:download / update:install channels. That hid real install
    // failures (corrupt artifact, permission denied, unknown reason).
    // Such errors MUST reach Sentry.
    const realInstallFailures = [
      "Error: Error invoking remote method 'update:install': Error: some unexpected install failure",
      "Error: Error invoking remote method 'update:install': Error: EACCES: permission denied",
      "Error: Error invoking remote method 'update:download': Error: install_failed",
    ]
    for (const msg of realInstallFailures) {
      expect(
        beforeSend({ exception: { values: [{ value: msg }] } } as never, {} as never),
      ).toBeTruthy()
    }

    // Transient wrapped update:* rejections are still filtered, because
    // the inner error matches the transient classifier — not because of
    // the channel name.
    expect(
      beforeSend(
        {
          exception: {
            values: [
              {
                value:
                  "Error: Error invoking remote method 'update:download': Error: net::ERR_CONNECTION_RESET",
              },
            ],
          },
        } as never,
        {} as never,
      ),
    ).toBeNull()

    // Unrelated IPC rejections on other channels must still pass through.
    expect(
      beforeSend(
        {
          exception: {
            values: [{ value: "Error: Error invoking remote method 'accounts:list': Error: db locked" }],
          },
        } as never,
        {} as never,
      ),
    ).toBeTruthy()
  })

  it('init enables browserTracingIntegration and tracesSampleRate', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    expect(initCall.tracesSampleRate).toBe(0.2)
    expect(Array.isArray(initCall.integrations)).toBe(true)
    expect((initCall.integrations as Array<{ name: string }>).some(i => i.name === 'BrowserTracing')).toBe(true)
  })

  it('beforeSendTransaction filters when Sentry is disabled', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry, setSentryUserEnabled } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    const beforeSendTransaction = initCall.beforeSendTransaction!
    const txEvent = { transaction: 'test' }

    // By default — sends
    expect(beforeSendTransaction(txEvent as never, {} as never)).toBeTruthy()

    // Disable — filters out
    setSentryUserEnabled(false)
    expect(beforeSendTransaction(txEvent as never, {} as never)).toBeNull()
  })

  it('sendFeedback calls Sentry.withScope + captureFeedback', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry, sendFeedback } = await import('./sentry')

    initSentry()

    sendFeedback({ message: 'test bug', email: 'a@b.c' })
    expect(sentry.withScope).toHaveBeenCalledOnce()
    expect(sentry.captureFeedback).toHaveBeenCalledWith({
      message: 'test bug',
      email: 'a@b.c',
      name: undefined,
      associatedEventId: undefined,
    })
  })

  it('sendFeedback silently skips when Sentry is disabled', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry, setSentryUserEnabled, sendFeedback } = await import('./sentry')

    initSentry()
    setSentryUserEnabled(false)

    sendFeedback({ message: 'test' })
    expect(sentry.captureFeedback).not.toHaveBeenCalled()
  })

  it('isSentryActive returns false in dev environment', async () => {
    const { isSentryActive } = await import('./sentry')
    // import.meta.env.PROD === false in tests
    expect(isSentryActive()).toBe(false)
  })

  it('runtime off→on re-attaches the cached install-id (no user.id=null window)', async () => {
    // Regression guard: previous version required the caller to re-invoke
    // setSentryUserId after flipping the toggle back on. Now the cache is
    // populated on the first setSentryUserId call and setSentryUserEnabled
    // re-attaches it on off→on. Without this, post-opt-in events had
    // user.id=null and count_unique(user) was broken.
    const sentry = await import('@sentry/react')
    const { initSentry, setSentryUserEnabled, setSentryUserId } = await import('./sentry')

    initSentry()
    setSentryUserId('deadbeefcafe1234')
    expect(vi.mocked(sentry.setUser)).toHaveBeenCalledWith({ id: 'deadbeefcafe1234' })
    vi.mocked(sentry.setUser).mockClear()

    setSentryUserEnabled(false)
    // off path clears identity
    expect(vi.mocked(sentry.setUser)).toHaveBeenCalledWith(null)
    vi.mocked(sentry.setUser).mockClear()

    setSentryUserEnabled(true)
    // on path re-attaches from the cache — no separate setSentryUserId call required
    expect(vi.mocked(sentry.setUser)).toHaveBeenCalledWith({ id: 'deadbeefcafe1234' })
  })

  it('captureException is exported', async () => {
    const mod = await import('./sentry')
    expect(typeof mod.captureException).toBe('function')
  })

  it('captureException is no-op when Sentry is disabled', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry, setSentryUserEnabled, captureException } = await import('./sentry')

    initSentry()
    setSentryUserEnabled(false)

    captureException(new Error('should not be sent'), { source: 'test' })

    expect(sentry.captureException).not.toHaveBeenCalled()
    expect(sentry.withScope).not.toHaveBeenCalled()
  })

  it('captureException is no-op for transient network errors', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry, captureException } = await import('./sentry')

    initSentry()

    captureException(
      new Error("Error invoking remote method 'sync:run': Error: read ECONNRESET"),
      { source: 'useAccountSync' },
    )

    expect(sentry.captureException).not.toHaveBeenCalled()
    expect(sentry.withScope).not.toHaveBeenCalled()
  })

  it('captureException normal path: calls Sentry.captureException with source tag and extras', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry, captureException } = await import('./sentry')

    initSentry()

    const err = new Error('DB locked')
    captureException(err, { source: 'useMailListView', accountId: 42 })

    expect(sentry.withScope).toHaveBeenCalledOnce()
    expect(sentry.captureException).toHaveBeenCalledOnce()
    expect(sentry.captureException).toHaveBeenCalledWith(err)
  })

  it('captureException does NOT throw when the Sentry SDK itself throws', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry, captureException } = await import('./sentry')

    initSentry()
    vi.mocked(sentry.withScope).mockImplementationOnce(() => { throw new Error('SDK broken') })

    expect(() => captureException(new Error('original'), { source: 'test' })).not.toThrow()
  })

  it('setSentryUserId caches the hash even when telemetry is currently off', async () => {
    // If main.tsx skipped setSentryUserId at boot because sentryEnabled=false,
    // a later off→on toggle should still re-attach the identity. The cache is
    // populated regardless of the current enabled state.
    const sentry = await import('@sentry/react')
    const { initSentry, setSentryUserEnabled, setSentryUserId } = await import('./sentry')

    setSentryUserEnabled(false)
    initSentry()
    // Clear the setUser(null) produced by the on→off transition above.
    vi.mocked(sentry.setUser).mockClear()
    setSentryUserId('cafecafecafecafe')
    // While off, we must NOT push identity to the SDK
    expect(vi.mocked(sentry.setUser)).not.toHaveBeenCalled()

    setSentryUserEnabled(true)
    expect(vi.mocked(sentry.setUser)).toHaveBeenCalledWith({ id: 'cafecafecafecafe' })
  })

  it('setSentryUserEnabled(false) applied BEFORE initSentry forces enabled:false', async () => {
    // Regression guard for the startup window: session/pageload envelopes
    // bypass beforeSend, so the only reliable kill switch is the SDK's
    // own `enabled` flag. main.tsx now calls setSentryUserEnabled(...) on
    // the persisted flag BEFORE initSentry(), and initSentry must read
    // that state and pass `enabled: false` to Sentry.init.
    const sentry = await import('@sentry/react')
    const { initSentry, setSentryUserEnabled } = await import('./sentry')

    setSentryUserEnabled(false)
    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    expect(initCall.enabled).toBe(false)

    // beforeSend still covers the runtime-toggle path.
    const beforeSend = initCall.beforeSend!
    const beforeSendTransaction = initCall.beforeSendTransaction!
    const event = { exception: { values: [{ value: 'startup error' }] } }
    expect(beforeSend(event as never, {} as never)).toBeNull()
    expect(beforeSendTransaction({ transaction: 'pageload' } as never, {} as never)).toBeNull()
  })

  // --- startManualSpan: renderer-side manual-lifecycle span helper ---

  it('startManualSpan returns a handle with setAttribute/end when telemetry is enabled', async () => {
    const sentry = await import('@sentry/react')
    const { startManualSpan } = await import('./sentry')

    const handle = startManualSpan({
      name: 'renderer.cold_start_ipc',
      op: 'renderer.boot',
      attributes: { window_ms: 12000 },
    })

    expect(handle).not.toBeNull()
    expect(sentry.startSpanManual).toHaveBeenCalledOnce()
    // Exercise the facade — must not throw, must forward to the underlying span.
    expect(() => handle!.setAttribute('calls_deduped', 3)).not.toThrow()
    expect(() => handle!.end()).not.toThrow()
  })

  it('startManualSpan returns null when telemetry is disabled', async () => {
    const sentry = await import('@sentry/react')
    const { setSentryUserEnabled, startManualSpan } = await import('./sentry')

    setSentryUserEnabled(false)
    const handle = startManualSpan({ name: 'renderer.cold_start_ipc' })

    expect(handle).toBeNull()
    // Must not even hit the SDK when disabled — the gate is at the facade edge.
    expect(sentry.startSpanManual).not.toHaveBeenCalled()
  })

  it('startManualSpan does not throw when the Sentry SDK itself throws', async () => {
    const sentry = await import('@sentry/react')
    const { startManualSpan } = await import('./sentry')

    vi.mocked(sentry.startSpanManual).mockImplementationOnce(() => {
      throw new Error('SDK broken')
    })

    let handle: ReturnType<typeof startManualSpan> | undefined
    expect(() => { handle = startManualSpan({ name: 'x' }) }).not.toThrow()
    // Failed start must degrade to null so callers can short-circuit.
    expect(handle).toBeNull()
  })

  it('startManualSpan handle swallows errors from the underlying span methods', async () => {
    const sentry = await import('@sentry/react')
    const { startManualSpan } = await import('./sentry')

    // Return a span whose methods throw — the facade must swallow without
    // surfacing to callers (telemetry never throws).
    vi.mocked(sentry.startSpanManual).mockImplementationOnce(
      ((_opts: unknown, cb: (s: { setAttribute: () => void; end: () => void }, finish: () => void) => unknown) => {
        const span = {
          setAttribute: () => { throw new Error('span broken') },
          end: () => { throw new Error('span broken') },
        }
        return cb(span, () => {})
      }) as never,
    )

    const handle = startManualSpan({ name: 'x' })
    expect(handle).not.toBeNull()
    expect(() => handle!.setAttribute('k', 1)).not.toThrow()
    expect(() => handle!.end()).not.toThrow()
  })
})

// §2.82 AC (g) / AC10 — the renderer must not ship the OS account name or let
// the server infer an IP address. Mirrors electron/sentry.test.ts.
describe('sentry renderer — PII scrubbing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('replaces the OS account name in all three platform path shapes', async () => {
    const { scrubUserPaths } = await import('./sentry')

    expect(scrubUserPaths('/home/ivan/apps/mailcopilot/dist/assets/index.js'))
      .toBe('/home/<user>/apps/mailcopilot/dist/assets/index.js')
    expect(scrubUserPaths('/Users/ivan/Applications/MailCopilot.app/index.js'))
      .toBe('/Users/<user>/Applications/MailCopilot.app/index.js')
    expect(scrubUserPaths('C:\\Users\\Иван\\AppData\\Local\\MailCopilot\\index.js'))
      .toBe('C:\\Users\\<user>\\AppData\\Local\\MailCopilot\\index.js')
    // Forward-slash Windows form and a non-C: drive.
    expect(scrubUserPaths('D:/Users/ivan/app/index.js')).toBe('D:/Users/<user>/app/index.js')
  })

  it('is idempotent — a scrubbed path does not get scrubbed again', async () => {
    const { scrubUserPaths } = await import('./sentry')
    const once = scrubUserPaths('/home/ivan/app/index.js')
    expect(scrubUserPaths(once)).toBe(once)
  })

  it('leaves paths without a user segment alone', async () => {
    const { scrubUserPaths } = await import('./sentry')
    expect(scrubUserPaths('/opt/mailcopilot/resources/app.asar/index.js'))
      .toBe('/opt/mailcopilot/resources/app.asar/index.js')
    expect(scrubUserPaths('')).toBe('')
  })

  it('beforeSend nulls the IP and scrubs every stack frame path field', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry } = await import('./sentry')
    initSentry()
    const beforeSend = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!

    const event = {
      user: { id: 'abc123', ip_address: '203.0.113.7' },
      exception: {
        values: [{
          value: 'boom',
          stacktrace: {
            frames: [
              {
                filename: '/home/ivan/app/src/App.tsx',
                abs_path: 'C:\\Users\\Иван\\app\\src\\App.tsx',
                module: '/Users/ivan/app/src/App',
              },
              { filename: 'app:///assets/index.js' },
            ],
          },
        }],
      },
    }

    const out = beforeSend(event as never, {} as never) as typeof event | null
    expect(out).toBeTruthy()
    expect(out!.user.ip_address).toBeNull()
    // The install id survives — stripping the IP must not strip the identity
    // the whole dataset is keyed by. It is pseudonymous, NOT anonymous, and
    // therefore still personal data (GDPR recital 26): stable per install and
    // attached to everything, so one install's stream is joinable. That is
    // exactly why the consent screen discloses it.
    expect(out!.user.id).toBe('abc123')
    const frames = out!.exception.values[0].stacktrace!.frames!
    expect(frames[0].filename).toBe('/home/<user>/app/src/App.tsx')
    expect(frames[0].abs_path).toBe('C:\\Users\\<user>\\app\\src\\App.tsx')
    expect(frames[0].module).toBe('/Users/<user>/app/src/App')
    expect(frames[1].filename).toBe('app:///assets/index.js')
  })

  it('beforeSend nulls the IP even when the event carries no user object', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry } = await import('./sentry')
    initSentry()
    const beforeSend = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!

    const out = beforeSend({ exception: { values: [{ value: 'boom' }] } } as never, {} as never) as
      { user?: { ip_address?: string | null } } | null
    expect(out?.user?.ip_address).toBeNull()
  })

  it('beforeSendTransaction nulls the IP too', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry } = await import('./sentry')
    initSentry()
    const beforeSendTransaction = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSendTransaction!

    const out = beforeSendTransaction({ user: { ip_address: '203.0.113.7' } } as never, {} as never) as
      { user?: { ip_address?: string | null } } | null
    expect(out?.user?.ip_address).toBeNull()
  })

  it('scrubEventPii never throws on a hostile shape (telemetry must not crash the UI)', async () => {
    const { scrubEventPii } = await import('./sentry')
    const frozen = Object.freeze({ user: { ip_address: '1.2.3.4' } })
    expect(() => scrubEventPii(frozen)).not.toThrow()
    expect(() => scrubEventPii(null)).not.toThrow()
    expect(() => scrubEventPii({ exception: { values: 'not-an-array' } })).not.toThrow()
  })
})

// §2.82 iter2 findings 2 and 3 — the renderer half. The scrubbing rules now
// live in packages/core/piiScrub.ts and are shared with electron/sentry.ts, so
// these cases pin the renderer's use of them (the rules themselves are covered
// in packages/core/piiScrub.test.ts).
describe('sentry renderer — consent transitions and exception text', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('scrubs the exception TEXT, not only stack frames', async () => {
    const { scrubEventPii } = await import('./sentry')

    const out = scrubEventPii({
      exception: {
        values: [{ value: "EACCES: permission denied, open '/home/ivan/.config/x'" }],
      },
    }) as { exception: { values: Array<{ value: string }> } }

    expect(out.exception.values[0]!.value)
      .toBe("EACCES: permission denied, open '/home/<user>/.config/x'")
  })

  it('scrubs a name containing spaces', async () => {
    const { scrubUserPaths } = await import('./sentry')
    expect(scrubUserPaths('C:\\Users\\John Doe\\AppData\\Local\\app.js'))
      .toBe('C:\\Users\\<user>\\AppData\\Local\\app.js')
  })

  it('scrubs breadcrumbs, extra and contexts', async () => {
    const { scrubEventPii } = await import('./sentry')
    const out = scrubEventPii({
      breadcrumbs: [{ message: 'navigated to file:///home/ivan/index.html' }],
      extra: { file: '/home/ivan/a.js' },
      contexts: { app: { app_path: '/home/ivan/b.js' } },
    })
    expect(JSON.stringify(out)).not.toContain('ivan')
  })

  it('clears the breadcrumb buffer on a consent transition', async () => {
    const sentry = await import('@sentry/react')
    const clearBreadcrumbs = vi.fn()
    vi.mocked(sentry.getCurrentScope).mockReturnValue({ clearBreadcrumbs } as never)
    vi.mocked(sentry.getIsolationScope).mockReturnValue({ clearBreadcrumbs } as never)

    const { setSentryUserEnabled } = await import('./sentry')
    // Renderer breadcrumbs (clicks, console, fetch) accumulate regardless of
    // the enabled flag; a post-consent event must not carry a pre-consent trail.
    setSentryUserEnabled(false)
    clearBreadcrumbs.mockClear()
    setSentryUserEnabled(true)
    expect(clearBreadcrumbs).toHaveBeenCalled()

    // No transition, no reset.
    clearBreadcrumbs.mockClear()
    setSentryUserEnabled(true)
    expect(clearBreadcrumbs).not.toHaveBeenCalled()
  })
})
