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

/**
 * §2.127 second door — the raw text of an IPC rejection must not leave the
 * renderer as the exception itself.
 *
 * The finding these tests pin down: `captureException(err, …)` on a raw
 * `catch (err)` from `window.api.invoke(...)` sent a string an IMAP/SMTP server
 * controls, and neither the transient filter nor the PII scrubber can stop
 * prose. Recognition is by the main-process tag, so what is transmitted is
 * assembled from a closed set instead.
 */
describe('sentry renderer — tagged IPC rejections', () => {
  /** Unique text standing in for whatever a hostile server put in its reply. */
  const SERVER_MARKER = 'ZZ_SERVER_CONTROLLED_PROSE_ZZ'

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  async function getBeforeSend() {
    const sentry = await import('@sentry/react')
    const { initSentry } = await import('./sentry')
    initSentry()
    return vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!
  }

  /** An event shaped like the SDK builds one, poisoned in every carrier. */
  function poisonedEvent(tag: string) {
    return {
      exception: {
        values: [{
          type: 'Error',
          value: `Error invoking remote method 'tls:getServerCert': Error: ${tag} ${SERVER_MARKER}`,
          stacktrace: { frames: [{ filename: `app:///bundle.js?${SERVER_MARKER}`, function: 'invoke' }] },
        }],
      },
      message: `wrapped ${SERVER_MARKER}`,
      logentry: { message: SERVER_MARKER },
      culprit: SERVER_MARKER,
      breadcrumbs: [{ message: `console: ${SERVER_MARKER}`, data: { detail: SERVER_MARKER } }],
      extra: { source: 'Account.tlsCertFetch', raw: SERVER_MARKER },
      contexts: { trace: { trace_id: 'abc' }, response: { body: SERVER_MARKER } },
      tags: { source: 'Account.tlsCertFetch', leaked: SERVER_MARKER },
    }
  }

  it.each([['offline'], ['timeout']])(
    'drops a [mcerr:%s] rejection entirely — that is network state, not a defect',
    async (key) => {
      const beforeSend = await getBeforeSend()
      expect(beforeSend(poisonedEvent(`[mcerr:${key}]`) as never, {} as never)).toBeNull()
    },
  )

  it('drops the AggregateError sync noise the text classifier never matched', async () => {
    // The long-standing gap: `beforeSend` sees a STRING, while unwrapping an
    // AggregateError needs the OBJECT (its own `message` is empty and
    // `.errors[]` does not cross IPC). The tag carries main's object-level
    // verdict, so this event is finally recognised as network noise.
    const beforeSend = await getBeforeSend()
    const raw = "Error invoking remote method 'net:inboxSummaries': AggregateError"
    // Untagged, exactly as it used to arrive — still reported.
    expect(beforeSend({ exception: { values: [{ value: raw }] } } as never, {} as never)).toBeTruthy()
    // Tagged by the funnel — dropped.
    expect(
      beforeSend(
        { exception: { values: [{ value: `Error invoking remote method 'net:inboxSummaries': Error: [mcerr:offline] AggregateError` }] } } as never,
        {} as never,
      ),
    ).toBeNull()
  })

  it.each([['auth'], ['unknown']])(
    'replaces a [mcerr:%s] rejection with a synthetic event carrying no third-party text',
    async (key) => {
      const beforeSend = await getBeforeSend()
      const out = beforeSend(poisonedEvent(`[mcerr:${key}]`) as never, {} as never) as unknown as {
        exception: { values: Array<{ type: string; value: string; stacktrace?: unknown }> }
        tags: Record<string, unknown>
      }
      expect(out).toBeTruthy()
      // Walk the WHOLE event, not just `value`: the tail must not survive in a
      // stack frame, a breadcrumb, an extra, a context or a tag either.
      expect(JSON.stringify(out)).not.toContain(SERVER_MARKER)
      expect(out.exception.values).toHaveLength(1)
      expect(out.exception.values[0]!.type).toBe('IpcFailure')
      expect(out.exception.values[0]!.value).toBe(`ipc_tls:getServerCert_${key}`)
      expect(out.exception.values[0]!.stacktrace).toBeUndefined()
      // The verdict and the channel survive as tags — that is the whole payload.
      expect(out.tags.ipc_failure).toBe(key)
      expect(out.tags.ipc_channel).toBe('tls:getServerCert')
      expect(out.tags.source).toBe('Account.tlsCertFetch')
    },
  )

  it('leaves an untagged renderer error exactly as it was', async () => {
    // Guard against over-capture: our own bugs keep their message, stack,
    // breadcrumbs and extras. Only rejections main vouched for are rewritten.
    const beforeSend = await getBeforeSend()
    const event = {
      exception: {
        values: [{
          type: 'TypeError',
          value: 'Cannot read properties of undefined (reading "id")',
          stacktrace: { frames: [{ filename: 'app:///bundle.js', function: 'render' }] },
        }],
      },
      breadcrumbs: [{ message: 'clicked reply' }],
      extra: { source: 'MailList', accountId: 7 },
      tags: { source: 'MailList' },
    }
    const out = beforeSend(event as never, {} as never) as unknown as typeof event
    expect(out).toBeTruthy()
    expect(out.exception.values[0]!.type).toBe('TypeError')
    expect(out.exception.values[0]!.value).toContain('Cannot read properties')
    expect(out.exception.values[0]!.stacktrace).toBeTruthy()
    expect(out.breadcrumbs).toHaveLength(1)
    expect(out.extra).toEqual({ source: 'MailList', accountId: 7 })
  })

  it('finds the tag on a chained exception value, not only the first', async () => {
    // The linkedErrors integration appends causes as extra values.
    const beforeSend = await getBeforeSend()
    const out = beforeSend(
      {
        exception: {
          values: [
            { type: 'Error', value: `outer wrapper ${SERVER_MARKER}` },
            { type: 'Error', value: `[mcerr:auth] ${SERVER_MARKER}` },
          ],
        },
      } as never,
      {} as never,
    )
    expect(JSON.stringify(out)).not.toContain(SERVER_MARKER)
  })

  it('captureException drops a tagged network-state rejection without touching the SDK', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry, captureException } = await import('./sentry')
    initSentry()

    captureException(
      new Error(`Error invoking remote method 'tls:getServerCert': Error: [mcerr:offline] ${SERVER_MARKER}`),
      { source: 'Account.tlsCertFetch' },
    )

    expect(sentry.captureException).not.toHaveBeenCalled()
    expect(sentry.withScope).not.toHaveBeenCalled()
  })

  it('captureException never hands the raw tagged rejection to the SDK', async () => {
    const sentry = await import('@sentry/react')
    const { initSentry, captureException } = await import('./sentry')
    initSentry()

    const tags: Record<string, unknown> = {}
    const setExtras = vi.fn()
    vi.mocked(sentry.withScope).mockImplementation(((cb: (scope: unknown) => void) => {
      cb({ setTag: (k: string, v: unknown) => { tags[k] = v }, setExtras })
    }) as never)

    const raw = new Error(
      `Error invoking remote method 'tls:getServerCert': Error: [mcerr:auth] ${SERVER_MARKER}`,
    )
    captureException(raw, { source: 'Account.tlsCertFetch', hostHint: SERVER_MARKER })

    expect(sentry.captureException).toHaveBeenCalledOnce()
    const sent = vi.mocked(sentry.captureException).mock.calls[0][0] as Error
    expect(sent).not.toBe(raw)
    expect(sent.name).toBe('IpcFailure')
    expect(sent.message).toBe('ipc_tls:getServerCert_auth')
    // Caller extras are dropped: this path is an allow list, not a filter.
    expect(setExtras).not.toHaveBeenCalled()
    expect(tags).toEqual({
      source: 'Account.tlsCertFetch',
      ipc_failure: 'auth',
      ipc_channel: 'tls:getServerCert',
    })
  })

  it('keeps the raw rejection intact for the local consumers that parse it', async () => {
    // `useCertRecovery` matches machine-readable codes as a SUBSTRING of the
    // rejection message, and Settings shows connection-test text through
    // `stripErrorPresentation`. The telemetry path must observe, never mutate.
    const { initSentry, captureException } = await import('./sentry')
    const { trustErrorKey } = await import('./hooks/useCertRecovery')
    initSentry()

    const message =
      "Error invoking remote method 'net:trustCert': Error: [mcerr:unknown] cert_trust_fingerprint_mismatch"
    const err = new Error(message)
    captureException(err, { source: 'useCertRecovery.trust' })

    expect(err.message).toBe(message)
    expect(trustErrorKey(err)).toBe('trustFingerprintMismatch')
  })

  it('applies the same hygiene to the synthetic event it built itself', async () => {
    // The two paths must ship the same closed set: the event created by
    // captureException goes through beforeSend too, where breadcrumbs and
    // extras accumulated elsewhere in the session are dropped.
    const beforeSend = await getBeforeSend()
    const out = beforeSend(
      {
        exception: { values: [{ type: 'IpcFailure', value: 'ipc_net:trustCert_auth' }] },
        breadcrumbs: [{ message: `console: ${SERVER_MARKER}` }],
        extra: { raw: SERVER_MARKER },
        tags: { source: 'useCertRecovery.trust', ipc_failure: 'auth', leaked: SERVER_MARKER },
      } as never,
      {} as never,
    ) as unknown as { exception: { values: Array<{ value: string }> }; tags: Record<string, unknown> }
    expect(JSON.stringify(out)).not.toContain(SERVER_MARKER)
    expect(out.exception.values[0]!.value).toBe('ipc_net:trustCert_auth')
    expect(out.tags).toEqual({ source: 'useCertRecovery.trust', ipc_failure: 'auth' })
  })
})
