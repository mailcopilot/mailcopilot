import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @sentry/node before importing the module.
vi.mock('@sentry/node', () => {
  const client = { getOptions: () => ({ enabled: true }) }
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(),
    setUser: vi.fn(),
    getClient: vi.fn(() => client),
    // §2.82: a consent transition drops the breadcrumb buffer (see
    // setSentryUserEnabled). Shared spy so both scopes are assertable.
    getCurrentScope: vi.fn(() => ({ clearBreadcrumbs: vi.fn() })),
    getIsolationScope: vi.fn(() => ({ clearBreadcrumbs: vi.fn() })),
    startInactiveSpan: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), fmt: vi.fn() },
    wrapMcpServerWithSentry: vi.fn((s: unknown) => s),
  }
})

// §2.34 — mock the metrics sink so importing sentry.ts (which now imports
// recordEvent from ./metrics) does not pull the real metrics chain
// (electron-log etc.) into this unit test, and so reportKeychainUnavailable's
// metric emission is directly assertable.
const { recordEventMock } = vi.hoisted(() => ({ recordEventMock: vi.fn() }))
vi.mock('./metrics', () => ({ recordEvent: recordEventMock }))

describe('sentry main process', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('setSentryUserEnabled(false) → beforeSend returns null', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry, setSentryUserEnabled } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    const beforeSend = initCall.beforeSend!

    const event = { exception: { values: [{ value: 'some error' }] } }

    // By default — sends
    expect(beforeSend(event as never, {} as never)).toBeTruthy()

    // Disable — filters out
    setSentryUserEnabled(false)
    expect(beforeSend(event as never, {} as never)).toBeNull()

    // Re-enable — sends again
    setSentryUserEnabled(true)
    expect(beforeSend(event as never, {} as never)).toBeTruthy()
  })

  it('beforeSend filters out IMAP transient errors', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    const beforeSend = initCall.beforeSend!

    expect(beforeSend({ exception: { values: [{ value: 'Socket timeout' }] } } as never, {} as never)).toBeNull()
    // imapflow's real error text (MAILCOPILOT-5). The previous filter
    // matched the literal string 'NoConnection', which never occurs in
    // actual error messages — only in the function name.
    expect(beforeSend({ exception: { values: [{ value: 'Connection not available' }] } } as never, {} as never)).toBeNull()
  })

  it('beforeSend filters wrapped renderer IPC transient errors (MAILCOPILOT-8/A)', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    const beforeSend = initCall.beforeSend!

    const wrapped = [
      "Error: Error invoking remote method 'update:download': Error: net::ERR_CONNECTION_RESET",
      "Error: Error invoking remote method 'update:download': Error: net::ERR_HTTP2_PROTOCOL_ERROR",
      'Error: net::ERR_HTTP2_PROTOCOL_ERROR',
      'read ECONNRESET',
    ]
    for (const msg of wrapped) {
      expect(beforeSend({ exception: { values: [{ value: msg }] } } as never, {} as never)).toBeNull()
    }
  })

  it('beforeSend filters Linux installer failures (MAILCOPILOT-9)', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    const beforeSend = initCall.beforeSend!

    const msg = 'Command /usr/bin/pkexec --disable-internal-agent exited with code 127'
    expect(beforeSend({ exception: { values: [{ value: msg }] } } as never, {} as never)).toBeNull()
  })

  it('beforeSend filters out transient network errors', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    const beforeSend = initCall.beforeSend!

    const networkErrors = [
      'Error: net::ERR_PROXY_CONNECTION_FAILED',
      'Error: net::ERR_NETWORK_CHANGED',
      'Error: net::ERR_CONNECTION_CLOSED',
      'Error: net::ERR_NETWORK_IO_SUSPENDED',
      'Error: net::ERR_INTERNET_DISCONNECTED',
      'Error: net::ERR_NAME_NOT_RESOLVED',
      'Error: net::ERR_TIMED_OUT',
    ]
    for (const msg of networkErrors) {
      expect(beforeSend({ exception: { values: [{ value: msg }] } } as never, {} as never)).toBeNull()
    }

    // Real errors should still pass through
    expect(beforeSend({ exception: { values: [{ value: 'TypeError: cannot read property' }] } } as never, {} as never)).toBeTruthy()
  })

  it('init enables tracesSampleRate', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    expect(initCall.tracesSampleRate).toBe(0.2)
  })

  it('beforeSendTransaction filters when Sentry is disabled', async () => {
    const sentry = await import('@sentry/node')
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

  it('init enables structured logs (enableLogs)', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    expect(initCall.enableLogs).toBe(true)
  })

  it('beforeSendLog filters when Sentry is disabled by user', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry, setSentryUserEnabled } = await import('./sentry')

    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]! as Record<string, unknown>
    const beforeSendLog = initCall.beforeSendLog as (log: unknown) => unknown
    const log = { message: 'test log' }

    // By default — sends
    expect(beforeSendLog(log)).toBeTruthy()

    // Disable — filters out
    setSentryUserEnabled(false)
    expect(beforeSendLog(log)).toBeNull()
  })

  it('setSentryUserEnabled(false) applied BEFORE initSentry forces enabled:false', async () => {
    // Regression guard: session envelopes and pre-settings throws bypass
    // beforeSend, so the only reliable kill switch is the SDK's own
    // enabled flag. main.ts now calls setSentryUserEnabled(...) from the
    // persisted sentryEnabled flag BEFORE initSentry(), and initSentry
    // must forward _sentryUserEnabled into Sentry.init.
    const sentry = await import('@sentry/node')
    const { initSentry, setSentryUserEnabled } = await import('./sentry')

    setSentryUserEnabled(false)
    initSentry()

    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    expect(initCall.enabled).toBe(false)
  })

  it('runtime off→on re-attaches the cached install-id', async () => {
    // Regression guard for Codex finding: setSentryUserEnabled(true) must
    // re-attach the cached install-id hash without the caller having to
    // call setSentryUserId again, otherwise post-opt-in events have
    // user.id=null and count_unique(user) is broken.
    const sentry = await import('@sentry/node')
    const { initSentry, setSentryUserEnabled, setSentryUserId } = await import('./sentry')

    initSentry()
    setSentryUserId('deadbeefcafe1234')
    expect(vi.mocked(sentry.setUser)).toHaveBeenCalledWith({ id: 'deadbeefcafe1234' })
    vi.mocked(sentry.setUser).mockClear()

    setSentryUserEnabled(false)
    expect(vi.mocked(sentry.setUser)).toHaveBeenCalledWith(null)
    vi.mocked(sentry.setUser).mockClear()

    setSentryUserEnabled(true)
    expect(vi.mocked(sentry.setUser)).toHaveBeenCalledWith({ id: 'deadbeefcafe1234' })
  })

  it('captureException swallows errors from a broken Sentry SDK (symmetric with renderer)', async () => {
    // Regression guard: captureException is called from graceful catch
    // blocks in bodyIndexer / offlineReplay / searchWorkerClient /
    // mcpClient. A broken Sentry SDK (transport failure, internal
    // regression) must not cascade a re-throw out of those sinks and
    // turn a handled error into an unhandled one. Mirrors the renderer
    // test in src/sentry.test.ts.
    const sentry = await import('@sentry/node')
    vi.mocked(sentry.captureException).mockImplementationOnce(() => {
      throw new Error('sentry SDK is broken')
    })
    const { captureException } = await import('./sentry')
    expect(() => captureException(new Error('real error'), { source: 'test' })).not.toThrow()
  })

  it('setSentryUserId caches hash even when telemetry is currently off', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry, setSentryUserEnabled, setSentryUserId } = await import('./sentry')

    setSentryUserEnabled(false)
    initSentry()
    vi.mocked(sentry.setUser).mockClear()
    setSentryUserId('cafecafecafecafe')
    // While off, identity must not be pushed to the SDK
    expect(vi.mocked(sentry.setUser)).not.toHaveBeenCalled()

    setSentryUserEnabled(true)
    expect(vi.mocked(sentry.setUser)).toHaveBeenCalledWith({ id: 'cafecafecafecafe' })
  })
})

// --- §2.34 ship-first observability — keychain/secret-store unavailability --

describe('§2.34 — isKeychainUnavailableError', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('matches the reported D-Bus Secret Service incident (string)', async () => {
    const { isKeychainUnavailableError } = await import('./sentry')
    expect(isKeychainUnavailableError(
      'Error calling StartServiceByName for org.freedesktop.secrets: Timeout was reached',
    )).toBe(true)
  })

  it('matches libsecret / gnome-keyring / kwallet / macOS Keychain signatures', async () => {
    const { isKeychainUnavailableError } = await import('./sentry')
    expect(isKeychainUnavailableError(new Error('libsecret: backend unavailable'))).toBe(true)
    expect(isKeychainUnavailableError(new Error('gnome-keyring daemon not running'))).toBe(true)
    expect(isKeychainUnavailableError({ message: 'kwallet refused the connection' })).toBe(true)
    expect(isKeychainUnavailableError(new Error('SecKeychain access denied'))).toBe(true)
  })

  it('walks err.cause for a wrapped keychain error', async () => {
    const { isKeychainUnavailableError } = await import('./sentry')
    const wrapped = new Error('failed to load account config') as Error & { cause?: unknown }
    wrapped.cause = new Error('org.freedesktop.secrets: Timeout was reached')
    expect(isKeychainUnavailableError(wrapped)).toBe(true)
  })

  it('does NOT match an ordinary transient network timeout (no false positive)', async () => {
    const { isKeychainUnavailableError } = await import('./sentry')
    expect(isKeychainUnavailableError('Error: net::ERR_TIMED_OUT')).toBe(false)
    expect(isKeychainUnavailableError('Socket timeout')).toBe(false)
    expect(isKeychainUnavailableError('ETIMEDOUT')).toBe(false)
    // A bare D-Bus activation error for a DIFFERENT service must not be tagged.
    expect(isKeychainUnavailableError('StartServiceByName for org.freedesktop.Notifications')).toBe(false)
    expect(isKeychainUnavailableError(null)).toBe(false)
    expect(isKeychainUnavailableError(undefined)).toBe(false)
  })
})

describe('§2.34 — beforeSend keychain bypass (provenance-based)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('keeps the event VISIBLE on the net-seam provenance marker (extra.source === keychain.read)', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')
    initSentry()
    const beforeSend = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!

    // The packages/net seam routes through
    // captureException(err, { source: 'keychain.read', surface }) → the Sentry
    // event carries extra.source === 'keychain.read'. The message is the
    // SYNTHETIC "secret store unavailable" (no keychain signature), proving the
    // bypass is decided purely by provenance, not by message content.
    const event = {
      extra: { source: 'keychain.read', surface: 'imap_smtp' },
      exception: { values: [{ value: 'secret store unavailable' }] },
    }
    const out = beforeSend(event as never, {} as never) as { tags?: Record<string, unknown>; fingerprint?: string[] } | null
    expect(out).toBeTruthy()
    expect(out!.tags?.category).toBe('keychain_unavailable')
    expect(out!.fingerprint).toEqual(['keychain-unavailable'])
  })

  it('keeps the event VISIBLE on the sentry-helper provenance marker (tags.category) even if the message does not match', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')
    initSentry()
    const beforeSend = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!

    // reportKeychainUnavailable stamps tags.category before the event reaches
    // beforeSend and sends a synthetic message — the tag alone keeps it visible.
    const event = {
      tags: { category: 'keychain_unavailable' },
      extra: { source: 'secretStore', surface: 'ai_keys' },
      exception: { values: [{ value: 'OS secret store unavailable' }] },
    }
    const out = beforeSend(event as never, {} as never) as { tags?: Record<string, unknown>; fingerprint?: string[] } | null
    expect(out).toBeTruthy()
    expect(out!.tags?.category).toBe('keychain_unavailable')
    expect(out!.fingerprint).toEqual(['keychain-unavailable'])
  })

  it('§2.34 security review (MEDIUM): a keychain signature in the message, WITHOUT provenance, no longer triggers the bypass', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')
    initSentry()
    const beforeSend = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!

    // Content-based bypass removed: an unrelated exception whose text merely
    // contains a keychain substring — here it ALSO carries a transient code and
    // an embedded email — must NOT be force-kept. With the old content-based
    // disjunct (isKeychainUnavailableError(msg)) it would have bypassed the
    // transient filter and been sent (PII leak); now it is filtered as ordinary
    // transient noise.
    const poisonedTransient = {
      exception: { values: [{ value: 'libsecret error for account=alice@example.com: ECONNRESET' }] },
    }
    expect(beforeSend(poisonedTransient as never, {} as never)).toBeNull()

    // A non-transient keychain-substring message without provenance is NOT
    // specially stamped as keychain — it falls through the normal path (neither
    // transient nor installer noise here, so returned) but WITHOUT the
    // keychain_unavailable tag/fingerprint that the bypass branch applies. The
    // absence of the stamp proves the content path no longer hits the bypass.
    const unstamped = {
      exception: { values: [{ value: 'org.freedesktop.secrets stray message account=bob@example.com' }] },
    }
    const out = beforeSend(unstamped as never, {} as never) as { tags?: Record<string, unknown> } | null
    expect(out).toBeTruthy()
    expect(out!.tags?.category).toBeUndefined()
  })

  it('still filters ordinary transient network noise (no regression)', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')
    initSentry()
    const beforeSend = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!

    expect(beforeSend({ exception: { values: [{ value: 'Socket timeout' }] } } as never, {} as never)).toBeNull()
    expect(beforeSend({ exception: { values: [{ value: 'Error: net::ERR_TIMED_OUT' }] } } as never, {} as never)).toBeNull()
  })

  it('no-regression §2.34: Node syscall codes and net::ERR_* are still filtered; a provenance-stamped keychain event is NOT filtered', async () => {
    // Verifies that the §2.34 keychain bypass (early-return path) did not
    // accidentally widen the transient filter, AND that a properly stamped
    // keychain event (provenance marker present) still reaches Sentry. Each
    // string is tested individually so a future regression in TRANSIENT_NET_RE
    // is caught at the exact offending pattern.
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')
    initSentry()
    const beforeSend = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!

    // Node.js syscall error codes + net::ERR_* — must still be classified as
    // transient noise.
    const transientMessages = [
      'ECONNRESET',
      'read ECONNRESET',
      'connect ETIMEDOUT',
      'ETIMEDOUT',
      'getaddrinfo ENOTFOUND imap.example.com',
      'ENOTFOUND',
      'net::ERR_CONNECTION_RESET',
      'Error: net::ERR_CONNECTION_RESET',
      'net::ERR_NAME_NOT_RESOLVED',
      'Error: net::ERR_NAME_NOT_RESOLVED',
    ]
    for (const msg of transientMessages) {
      expect(
        beforeSend({ exception: { values: [{ value: msg }] } } as never, {} as never),
      ).toBeNull()
    }

    // A provenance-stamped keychain event survives — the seam marker keeps it
    // visible regardless of message content.
    const keychainOut = beforeSend(
      {
        extra: { source: 'keychain.read', surface: 'imap_smtp' },
        exception: { values: [{ value: 'secret store unavailable' }] },
      } as never,
      {} as never,
    ) as { tags?: Record<string, unknown> } | null
    expect(keychainOut).toBeTruthy()
    expect(keychainOut!.tags?.category).toBe('keychain_unavailable')
  })
})

describe('§2.34 — reportKeychainUnavailable', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('captures a SYNTHETIC exception with the keychain tag + fingerprint and records the metric ONCE (dedup)', async () => {
    const sentry = await import('@sentry/node')
    const { reportKeychainUnavailable } = await import('./sentry')

    const err = new Error('Error calling StartServiceByName for org.freedesktop.secrets: Timeout was reached')

    // Same session, four back-to-back failing ops — must collapse to one report.
    reportKeychainUnavailable(err, 'ai_keys')
    reportKeychainUnavailable(err, 'ai_keys')
    reportKeychainUnavailable(err, 'imap_smtp')
    reportKeychainUnavailable(err, 'oauth_refresh')

    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(1)
    expect(recordEventMock).toHaveBeenCalledTimes(1)

    const [capturedErr, ctx] = vi.mocked(sentry.captureException).mock.calls[0] as [
      Error,
      { tags?: Record<string, unknown>; fingerprint?: string[]; extra?: Record<string, unknown> },
    ]
    // §2.34 security review (HIGH-1): the captured exception is SYNTHETIC — the
    // raw keytar / D-Bus error is NEVER forwarded to Sentry.
    expect(capturedErr).not.toBe(err)
    expect(capturedErr).toBeInstanceOf(Error)
    expect(capturedErr.name).toBe('KeychainUnavailable')
    expect(capturedErr.message).toBe('OS secret store unavailable')
    expect(ctx.tags?.category).toBe('keychain_unavailable')
    expect(ctx.fingerprint).toEqual(['keychain-unavailable'])
  })

  it('§2.34 security review (HIGH-1): the raw backend error (keytar key / D-Bus account) never reaches Sentry', async () => {
    // The raw keytar/libsecret error may embed the keytar service / account /
    // key in its message, stack, or cause. None of that may appear in the
    // captured exception or its context — only the synthetic error + enum tags.
    const sentry = await import('@sentry/node')
    const { reportKeychainUnavailable } = await import('./sentry')

    const rawErr = new Error(
      'keytar getPassword failed: service=mailcopilot account=imap:42 — org.freedesktop.secrets account=alice@example.com Timeout was reached',
    ) as Error & { cause?: unknown }
    rawErr.cause = new Error('inner libsecret detail account=imap:42')
    reportKeychainUnavailable(rawErr, 'imap_smtp')

    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(1)
    const [capturedErr, ctx] = vi.mocked(sentry.captureException).mock.calls[0] as [
      Error & { cause?: unknown },
      { tags?: Record<string, unknown>; fingerprint?: string[]; extra?: Record<string, unknown> },
    ]

    // The captured exception is the synthetic one — not the raw error object.
    expect(capturedErr).not.toBe(rawErr)
    expect(capturedErr.cause).toBeUndefined()

    // Serialize everything Sentry would have (message + stack + the whole
    // context object) and assert the raw backend substrings are absent.
    const serialized = JSON.stringify({
      message: capturedErr.message,
      stack: capturedErr.stack,
      name: capturedErr.name,
      ctx,
    })
    expect(serialized).not.toContain('imap:42')
    expect(serialized).not.toContain('alice@example.com')
    expect(serialized).not.toContain('org.freedesktop.secrets')
    expect(serialized).not.toContain('getPassword')
  })

  it('emits ONLY PII-free enum tags — no password, address, or key name', async () => {
    const { reportKeychainUnavailable } = await import('./sentry')

    reportKeychainUnavailable(new Error('org.freedesktop.secrets: Timeout was reached'), 'imap_smtp')

    expect(recordEventMock).toHaveBeenCalledTimes(1)
    const [name, tags] = recordEventMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe('secret_store.fallback_active')
    // Only the two declared enum tags — nothing else may ride along.
    expect(Object.keys(tags).sort()).toEqual(['platform', 'surface'])
    expect(tags.surface).toBe('imap_smtp')
    expect(['linux', 'darwin', 'win32']).toContain(tags.platform)
  })

  it('the dedup latch can be reset between sessions (test hook)', async () => {
    const sentry = await import('@sentry/node')
    const { reportKeychainUnavailable, __resetKeychainReportStateForTest } = await import('./sentry')

    reportKeychainUnavailable(new Error('libsecret unavailable'))
    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(1)

    reportKeychainUnavailable(new Error('libsecret unavailable'))
    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(1)

    __resetKeychainReportStateForTest()
    reportKeychainUnavailable(new Error('libsecret unavailable'))
    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(2)
  })

  it('never throws even if the Sentry SDK and metric sink are broken', async () => {
    const sentry = await import('@sentry/node')
    vi.mocked(sentry.captureException).mockImplementationOnce(() => { throw new Error('sentry broken') })
    recordEventMock.mockImplementationOnce(() => { throw new Error('metrics broken') })
    const { reportKeychainUnavailable } = await import('./sentry')
    expect(() => reportKeychainUnavailable(new Error('SecKeychain down'), 'ai_keys')).not.toThrow()
  })

  it('captureException context contains no PII beyond declared enum tags — tags/fingerprint/extra are exact', async () => {
    // Privacy invariant (CLAUDE.md §8): only enum-valued identifiers may leave the
    // process. No password, email address, keytar key name, or raw backend error text
    // may appear in the Sentry event context. This test pins the exact shape of the
    // captureException call so a future extra field is caught by the assertion.
    const sentry = await import('@sentry/node')
    const { reportKeychainUnavailable } = await import('./sentry')

    const err = new Error('org.freedesktop.secrets: Timeout was reached')
    reportKeychainUnavailable(err, 'imap_smtp')

    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(1)
    const [capturedErr, ctx] = vi.mocked(sentry.captureException).mock.calls[0] as [
      Error,
      { tags?: Record<string, unknown>; fingerprint?: string[]; extra?: Record<string, unknown> },
    ]

    // §2.34 security review (HIGH-1): the captured exception is SYNTHETIC with a
    // controlled message — never the raw backend error.
    expect(capturedErr).not.toBe(err)
    expect(capturedErr.name).toBe('KeychainUnavailable')
    expect(capturedErr.message).toBe('OS secret store unavailable')

    // tags: exactly one key — no email, no keytar key name, no surface leaking password
    expect(Object.keys(ctx.tags ?? {}).sort()).toEqual(['category'])
    expect(ctx.tags!.category).toBe('keychain_unavailable')

    // fingerprint: stable grouping key that collapses all sources into one issue
    expect(ctx.fingerprint).toEqual(['keychain-unavailable'])

    // extra: exactly two enum-valued fields (source always 'secretStore', surface from caller)
    expect(Object.keys(ctx.extra ?? {}).sort()).toEqual(['source', 'surface'])
    expect(ctx.extra!.source).toBe('secretStore')
    expect(ctx.extra!.surface).toBe('imap_smtp')
  })
})

/**
 * reportIpcHandlerError — the Sentry sink for the single `handleIpc` error
 * funnel in electron/ipc.ts.
 *
 * Context: electron/ipc.ts had zero captureException call sites, so every
 * main-process IPC handler failure went to electron-log only (no Sentry bridge,
 * CLAUDE.md §8) — 80 error-level lines in a user's local log over 4 days versus
 * zero events in Sentry over 30 days.
 *
 * The invariant under test is that closing that hole does NOT open a PII hole:
 * IPC arguments and error messages are exactly where bodies, addresses, search
 * queries, draft text, prompts, file paths and server hostnames live.
 */
describe('reportIpcHandlerError', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('captures a SYNTHETIC exception keyed on the channel, with tag + fingerprint', async () => {
    const sentry = await import('@sentry/node')
    const { reportIpcHandlerError } = await import('./sentry')

    const err = new TypeError('cannot read property x of undefined')
    reportIpcHandlerError('net:folderPage', err)

    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(1)
    const [capturedErr, ctx] = vi.mocked(sentry.captureException).mock.calls[0] as [
      Error,
      { tags?: Record<string, unknown>; fingerprint?: string[]; extra?: Record<string, unknown> },
    ]

    expect(capturedErr).not.toBe(err)
    expect(capturedErr).toBeInstanceOf(Error)
    expect(capturedErr.name).toBe('IpcHandlerError')
    expect(capturedErr.message).toBe('ipc_net:folderPage')

    expect(ctx.tags).toEqual({ category: 'ipc_handler_error', ipc_channel: 'net:folderPage' })
    // One Sentry issue per (channel, error class), not one per capture site —
    // every event from this function shares the same stack.
    expect(ctx.fingerprint).toEqual(['ipc-handler-error', 'net:folderPage', 'TypeError'])
    expect(Object.keys(ctx.extra ?? {}).sort()).toEqual(['error_name', 'source', 'suppressed_since_last'])
    expect(ctx.extra!.source).toBe('handleIpc')
    expect(ctx.extra!.error_name).toBe('TypeError')
    expect(ctx.extra!.suppressed_since_last).toBe(0)
  })

  it('never forwards the raw error — body, address, query, path and hostname stay local', async () => {
    const sentry = await import('@sentry/node')
    const { reportIpcHandlerError } = await import('./sentry')

    // A realistic composite: zod echoes payload fragments, imapflow echoes the
    // server response, fs echoes the path.
    const raw = new Error(
      'ENOENT: no such file or directory, open ' +
      "'/home/alice/Downloads/Q3 payroll.pdf' — folder=Входящие query=\"invoice from bob@example.com\" " +
      'host=mail.internal.example.com body="secret contents"',
    ) as Error & { cause?: unknown }
    raw.cause = new Error('inner: alice@example.com')
    reportIpcHandlerError('net:saveAttachment', raw)

    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(1)
    const [capturedErr, ctx] = vi.mocked(sentry.captureException).mock.calls[0] as [
      Error & { cause?: unknown },
      Record<string, unknown>,
    ]
    expect(capturedErr).not.toBe(raw)
    expect(capturedErr.cause).toBeUndefined()

    const serialized = JSON.stringify({
      message: capturedErr.message,
      stack: capturedErr.stack,
      name: capturedErr.name,
      ctx,
    })
    for (const secret of [
      '/home/alice',
      'Q3 payroll',
      'Входящие',
      'invoice from',
      'bob@example.com',
      'alice@example.com',
      'mail.internal.example.com',
      'secret contents',
      'ENOENT',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('classifies by prototype chain — a spoofed err.name cannot smuggle PII', async () => {
    const sentry = await import('@sentry/node')
    const { reportIpcHandlerError } = await import('./sentry')

    // `Error.name` is a mutable public property: anything that reads it as a
    // "class" would forward attacker/user-controlled text straight to Sentry.
    const spoofed = new RangeError('boom')
    spoofed.name = 'alice@example.com'
    reportIpcHandlerError('db:search', spoofed)

    const [, ctx] = vi.mocked(sentry.captureException).mock.calls[0] as [
      Error,
      { fingerprint?: string[]; extra?: Record<string, unknown> },
    ]
    expect(ctx.extra!.error_name).toBe('RangeError')
    expect(JSON.stringify(ctx)).not.toContain('alice@example.com')
  })

  it('collapses a non-Error throw to the UnknownError class without reading its fields', async () => {
    const sentry = await import('@sentry/node')
    const { reportIpcHandlerError } = await import('./sentry')

    reportIpcHandlerError('db:search', { name: 'alice@example.com', message: 'secret body' })

    const [, ctx] = vi.mocked(sentry.captureException).mock.calls[0] as [Error, Record<string, unknown>]
    expect((ctx.extra as Record<string, unknown>).error_name).toBe('UnknownError')
    expect(JSON.stringify(ctx)).not.toContain('alice@example.com')
    expect(JSON.stringify(ctx)).not.toContain('secret body')
  })

  it('sanitizes a channel name that is not a plain identifier (defense in depth)', async () => {
    const sentry = await import('@sentry/node')
    const { reportIpcHandlerError } = await import('./sentry')

    // Today every handleIpc call site passes a string literal, but the
    // signature is `channel: string` — a channel ever assembled from user input
    // must not become a Sentry message or tag value.
    reportIpcHandlerError('net:folder:Входящие <alice@example.com>', new Error('boom'))

    const [capturedErr, ctx] = vi.mocked(sentry.captureException).mock.calls[0] as [
      Error,
      { tags?: Record<string, unknown>; fingerprint?: string[] },
    ]
    expect(capturedErr.message).toBe('ipc_unknown_channel')
    expect(ctx.tags!.ipc_channel).toBe('unknown_channel')
    expect(JSON.stringify(ctx)).not.toContain('alice@example.com')
  })

  // --- Noise gate ----------------------------------------------------------
  // Rationale (CLAUDE.md §8): the filter has to run HERE, on the raw error.
  // beforeSend matches the event's exception message, and by then our synthetic
  // `ipc_<channel>` message has replaced the original ECONNRESET / Socket
  // timeout text — so beforeSend alone would let every IMAP disconnect through,
  // once per in-flight channel.

  it('drops transient network failures, including wrapped ones', async () => {
    const sentry = await import('@sentry/node')
    const { reportIpcHandlerError } = await import('./sentry')

    const wrapped = new Error('IMAP sync failed') as Error & { cause?: unknown }
    wrapped.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })

    reportIpcHandlerError('net:syncFolderHeaders', new Error('Socket timeout'))
    reportIpcHandlerError('net:inboxSummaries', new Error('Connection not available'))
    reportIpcHandlerError('net:idleStart', Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' }))
    reportIpcHandlerError('net:folderPage', wrapped)

    expect(vi.mocked(sentry.captureException)).not.toHaveBeenCalled()
  })

  it('keeps non-transient failures on the same channels visible (TLS trust must not be silenced)', async () => {
    const sentry = await import('@sentry/node')
    const { reportIpcHandlerError } = await import('./sentry')

    // The incident that motivated this work: TLS failures broke a user's
    // mailbox and never reached Sentry. They are NOT transient network noise.
    reportIpcHandlerError('net:syncFolderHeaders', new Error('TLS pin mismatch'))
    reportIpcHandlerError('net:testImap', new Error('unable to verify the first certificate'))

    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(2)
  })

  // --- Throttle ------------------------------------------------------------

  it('throttles repeats per (channel, error class) and reports the suppressed count on the next window', async () => {
    const sentry = await import('@sentry/node')
    const { reportIpcHandlerError } = await import('./sentry')

    let t = 1_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => t)

    // A renderer retry loop: same handler failing over and over.
    for (let i = 0; i < 50; i++) reportIpcHandlerError('db:search', new Error('disk I/O error'))
    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(1)

    // Past the window — the next failure reports again and carries the true
    // frequency of what was suppressed, so throttling never hides the volume.
    t += 60_001
    reportIpcHandlerError('db:search', new Error('disk I/O error'))
    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(2)
    const [, ctx] = vi.mocked(sentry.captureException).mock.calls[1] as [Error, { extra?: Record<string, unknown> }]
    expect(ctx.extra!.suppressed_since_last).toBe(49)

    dateSpy.mockRestore()
  })

  it('throttles per key — a different channel or error class is reported immediately', async () => {
    const sentry = await import('@sentry/node')
    const { reportIpcHandlerError } = await import('./sentry')

    const t = 2_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => t)

    reportIpcHandlerError('db:search', new Error('disk I/O error'))
    reportIpcHandlerError('db:search', new Error('disk I/O error')) // throttled
    reportIpcHandlerError('db:search', new TypeError('other class')) // different class
    reportIpcHandlerError('net:move', new Error('disk I/O error')) // different channel

    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(3)
    dateSpy.mockRestore()
  })

  it('the throttle window can be reset between tests/sessions (test hook)', async () => {
    const sentry = await import('@sentry/node')
    const { reportIpcHandlerError, __resetIpcErrorReportStateForTest } = await import('./sentry')

    const t = 3_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => t)

    reportIpcHandlerError('db:search', new Error('boom'))
    reportIpcHandlerError('db:search', new Error('boom'))
    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(1)

    __resetIpcErrorReportStateForTest()
    reportIpcHandlerError('db:search', new Error('boom'))
    expect(vi.mocked(sentry.captureException)).toHaveBeenCalledTimes(2)

    dateSpy.mockRestore()
  })

  it('never throws when the Sentry SDK is broken', async () => {
    const sentry = await import('@sentry/node')
    vi.mocked(sentry.captureException).mockImplementationOnce(() => { throw new Error('sentry broken') })
    const { reportIpcHandlerError } = await import('./sentry')

    expect(() => reportIpcHandlerError('net:sendMail', new Error('boom'))).not.toThrow()
  })
})

// §2.82 AC3 — nothing captured before the answer may be delivered afterwards.
describe('telemetry consent gating', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('AC3: opting in later replays nothing captured while telemetry was off', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry, setSentryUserEnabled, captureException } = await import('./sentry')

    // Production ordering: the preflight verdict is applied before init.
    setSentryUserEnabled(false)
    initSentry()
    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    expect(initCall.enabled).toBe(false)

    // Something fails before the user has answered the consent screen.
    expect(initCall.beforeSend!({ exception: { values: [{ value: 'pre-consent boom' }] } } as never, {} as never))
      .toBeNull()
    expect(initCall.beforeSendTransaction!({ contexts: {} } as never, {} as never)).toBeNull()
    expect((initCall.beforeSendLog as (l: unknown) => unknown)({ level: 'info', message: 'x' })).toBeNull()
    captureException(new Error('pre-consent boom'))
    vi.mocked(sentry.captureException).mockClear()

    // The user grants consent. There is no queue to drain — enabling only
    // flips the client flag and re-attaches the pseudonymous install id. If someone ever
    // adds a "buffer until consent, then flush" mechanism, this fails: that
    // would be transmission of data collected without consent.
    setSentryUserEnabled(true)
    expect(vi.mocked(sentry.captureException)).not.toHaveBeenCalled()
    expect(vi.mocked(sentry.flush)).not.toHaveBeenCalled()
  })
})

// §2.82 AC10 — client-side PII scrubbing before the transport.
describe('sentry PII scrubbing', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    // Pin the home directory so assertions do not depend on the machine
    // running the suite (a CI runner's $HOME could otherwise overlap the
    // fixture paths). Installed BEFORE importing sentry.ts, which resolves
    // os.homedir() once at module load.
    const os = await import('node:os')
    vi.spyOn(os.default, 'homedir').mockReturnValue('/nonexistent-home-fixture')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('AC10: strips the OS account name from Linux, macOS and Windows paths', async () => {
    const { scrubUserPaths } = await import('./sentry')

    expect(scrubUserPaths('/home/ivan/app/dist-electron/main.js')).toBe('/home/<user>/app/dist-electron/main.js')
    expect(scrubUserPaths('/Users/ivan/Library/Application Support/MailCopilot/main.js'))
      .toBe('/Users/<user>/Library/Application Support/MailCopilot/main.js')
    expect(scrubUserPaths('C:\\Users\\ivan\\AppData\\Local\\MailCopilot\\main.js'))
      .toBe('C:\\Users\\<user>\\AppData\\Local\\MailCopilot\\main.js')
  })

  it('AC10: handles non-ASCII account names and non-C drives', async () => {
    const { scrubUserPaths } = await import('./sentry')

    expect(scrubUserPaths('C:\\Users\\Иван\\AppData\\Roaming\\app.js'))
      .toBe('C:\\Users\\<user>\\AppData\\Roaming\\app.js')
    expect(scrubUserPaths('D:/Users/Иван/app.js')).toBe('D:/Users/<user>/app.js')
    expect(scrubUserPaths('/home/иван/app.js')).toBe('/home/<user>/app.js')
  })

  it('is idempotent — scrubbing an already-scrubbed path is a no-op', async () => {
    const { scrubUserPaths } = await import('./sentry')

    const once = scrubUserPaths('/home/ivan/app.js')
    expect(scrubUserPaths(once)).toBe(once)
  })

  it('leaves paths without an account name alone', async () => {
    const { scrubUserPaths } = await import('./sentry')

    expect(scrubUserPaths('/usr/lib/electron/resources/app.asar/main.js'))
      .toBe('/usr/lib/electron/resources/app.asar/main.js')
    expect(scrubUserPaths('node:internal/modules/cjs/loader')).toBe('node:internal/modules/cjs/loader')
    expect(scrubUserPaths('')).toBe('')
  })

  it('replaces a relocated home directory that the shape patterns miss', async () => {
    const os = await import('node:os')
    // Resolved at module load, so the override must be in place before import.
    vi.mocked(os.default.homedir).mockReturnValue('/var/lib/mailcopilot-user')
    const { scrubUserPaths } = await import('./sentry')

    expect(scrubUserPaths('/var/lib/mailcopilot-user/app/main.js')).toBe('<home>/app/main.js')
  })

  it('AC10: beforeSend nulls the IP address and rewrites stack frame paths', async () => {
    const sentry = await import('@sentry/node')
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
                filename: '/home/ivan/app/main.js',
                abs_path: 'C:\\Users\\ivan\\app\\main.js',
                module: '/Users/ivan/app/main',
              },
            ],
          },
        }],
      },
    }

    const out = beforeSend(event as never, {} as never) as typeof event
    expect(out).toBeTruthy()
    expect(out.user.ip_address).toBeNull()
    // The pseudonymous install id survives — it is the whole point of setUser.
    expect(out.user.id).toBe('abc123')
    const frame = out.exception.values[0].stacktrace.frames[0]
    expect(frame.filename).toBe('/home/<user>/app/main.js')
    expect(frame.abs_path).toBe('C:\\Users\\<user>\\app\\main.js')
    expect(frame.module).toBe('/Users/<user>/app/main')
  })

  it('AC10: the keychain bypass branch is scrubbed too', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')

    initSentry()
    const beforeSend = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!

    const event = {
      tags: { category: 'keychain_unavailable' },
      user: { ip_address: '203.0.113.7' },
      exception: {
        values: [{
          value: 'Timeout was reached',
          stacktrace: { frames: [{ filename: '/home/ivan/app/main.js' }] },
        }],
      },
    }

    const out = beforeSend(event as never, {} as never) as unknown as typeof event
    expect(out.user.ip_address).toBeNull()
    expect(out.exception.values[0].stacktrace.frames[0].filename).toBe('/home/<user>/app/main.js')
  })

  it('AC10: beforeSendTransaction nulls the IP address', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')

    initSentry()
    const beforeSendTransaction = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSendTransaction!

    const out = beforeSendTransaction({ user: { ip_address: '203.0.113.7' } } as never, {} as never) as {
      user: { ip_address: string | null }
    }
    expect(out.user.ip_address).toBeNull()
  })

  it('adds a null ip_address even when the event carries no user object', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')

    initSentry()
    const beforeSend = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!

    const out = beforeSend({ exception: { values: [{ value: 'boom' }] } } as never, {} as never) as {
      user: { ip_address: string | null }
    }
    expect(out.user.ip_address).toBeNull()
  })

  it('never throws on a malformed event shape', async () => {
    const { scrubEventPii } = await import('./sentry')

    expect(() => scrubEventPii({ exception: { values: 'not an array' } })).not.toThrow()
    expect(() => scrubEventPii(null)).not.toThrow()
  })

  // §2.82 iter2 finding 3 — the previous implementation only touched frame
  // paths, so the exception TEXT (which carries the path in every real fs
  // error, and is what Sentry renders as the issue title) went out verbatim.
  it('scrubs the exception text, not only stack frames', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')

    initSentry()
    const beforeSend = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSend!

    const out = beforeSend({
      exception: {
        values: [{
          value: "EACCES: permission denied, open '/home/ivan/.config/MailCopilot/settings.json'",
        }],
      },
    } as never, {} as never) as { exception: { values: Array<{ value: string }> } }

    expect(out.exception.values[0]!.value)
      .toBe("EACCES: permission denied, open '/home/<user>/.config/MailCopilot/settings.json'")
  })

  it('scrubs breadcrumbs, extra and contexts', async () => {
    const { scrubEventPii } = await import('./sentry')

    const out = scrubEventPii({
      breadcrumbs: [{ message: 'read /home/ivan/a.js', data: { path: 'C:\\Users\\ivan\\b.js' } }],
      extra: { source: 'bodyIndexer', file: '/home/ivan/c.js' },
      contexts: { app: { app_path: '/Users/ivan/d.js' } },
    })

    expect(JSON.stringify(out)).not.toContain('ivan')
  })

  it('scrubs a name containing spaces', async () => {
    const { scrubUserPaths } = await import('./sentry')

    expect(scrubUserPaths('C:\\Users\\John Doe\\AppData\\Local\\MailCopilot\\main.js'))
      .toBe('C:\\Users\\<user>\\AppData\\Local\\MailCopilot\\main.js')
    expect(scrubUserPaths("open '/Users/John Doe/Library/Logs/main.log'"))
      .toBe("open '/Users/<user>/Library/Logs/main.log'")
  })

  it('applies the main-only home-directory rule on top of the shared shape rules', async () => {
    const os = await import('node:os')
    vi.mocked(os.default.homedir).mockReturnValue('/var/lib/mailcopilot-user')
    const { scrubUserPaths } = await import('./sentry')

    // Both layers in one string: the relocated home (main-only) and a
    // shape-matched path (shared with the renderer).
    expect(scrubUserPaths('/var/lib/mailcopilot-user/a.js and /home/ivan/b.js'))
      .toBe('<home>/a.js and /home/<user>/b.js')
  })
})

// §2.82 iter2 finding 2 — telemetry permission drives COLLECTION, not just
// transmission. setSentryUserEnabled is the single funnel every decision site
// already calls, so it is where the gate and the breadcrumb buffer are reset.
describe('telemetry collection gate wiring', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const gate = await import('./telemetryGate')
    gate.__resetTelemetryGateForTest()
  })

  it('arms the collection gate from setSentryUserEnabled', async () => {
    const { setSentryUserEnabled } = await import('./sentry')
    const { isTelemetryCollectionAllowed } = await import('./telemetryGate')

    expect(isTelemetryCollectionAllowed()).toBe(false)
    setSentryUserEnabled(true)
    expect(isTelemetryCollectionAllowed()).toBe(true)
    setSentryUserEnabled(false)
    expect(isTelemetryCollectionAllowed()).toBe(false)
  })

  it('clears the breadcrumb buffer on a consent transition', async () => {
    const sentry = await import('@sentry/node')
    const clearBreadcrumbs = vi.fn()
    vi.mocked(sentry.getCurrentScope).mockReturnValue({ clearBreadcrumbs } as never)
    vi.mocked(sentry.getIsolationScope).mockReturnValue({ clearBreadcrumbs } as never)

    const { setSentryUserEnabled } = await import('./sentry')
    // The SDK keeps the last ~100 breadcrumbs regardless of `enabled`, so
    // without this the first post-consent event would carry a trail of
    // pre-consent activity.
    setSentryUserEnabled(false)
    clearBreadcrumbs.mockClear()
    setSentryUserEnabled(true)

    expect(clearBreadcrumbs).toHaveBeenCalled()
  })

  it('does not reset anything when the verdict is unchanged', async () => {
    const { setSentryUserEnabled } = await import('./sentry')
    const { setTelemetryCollectionAllowed, telemetryCollectionStartedAtMs } = await import('./telemetryGate')

    setTelemetryCollectionAllowed(true)
    setSentryUserEnabled(true)
    const origin = telemetryCollectionStartedAtMs()
    setSentryUserEnabled(true)

    expect(telemetryCollectionStartedAtMs()).toBe(origin)
  })
})

// §2.82 iter4 (security finding 3) — structured logs are a transmission
// surface of their own: they never reach `beforeSend`, so before this the
// event scrubbing did not apply to them at all. Their attributes carry
// free-form strings (the AI model id is typed by the user in Settings, tool
// names come from MCP servers) and the SDK adds the interpolated values of a
// `fmt` template as `sentry.message.parameter.N`.
describe('beforeSendLog scrubbing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  async function getBeforeSendLog() {
    const sentry = await import('@sentry/node')
    const { initSentry } = await import('./sentry')
    initSentry()
    const initCall = vi.mocked(sentry.init).mock.calls[0][0]!
    return initCall.beforeSendLog!
  }

  it('scrubs the OS account name and addresses out of string attributes', async () => {
    const beforeSendLog = await getBeforeSendLog()

    const out = beforeSendLog({
      level: 'info',
      message: 'AI chat completed',
      attributes: {
        'ai.model': 'local-model at /home/ivan/models/q4.gguf',
        'ai.tools_used': 'send_email,move_email',
        'user.email': 'ivan.petrov@example.com',
        'sentry.message.parameter.0': "open 'C:\\Users\\John Doe\\AppData\\Local\\MailCopilot\\log'",
        'ai.tool_call_count': 3,
      },
    } as never)!

    const attrs = out.attributes as Record<string, unknown>
    expect(attrs['ai.model']).toBe('local-model at /home/<user>/models/q4.gguf')
    expect(attrs['user.email']).toBe('<email>')
    expect(attrs['sentry.message.parameter.0']).toBe("open 'C:\\Users\\<user>\\AppData\\Local\\MailCopilot\\log'")
    // Non-PII values are left alone, including non-strings.
    expect(attrs['ai.tools_used']).toBe('send_email,move_email')
    expect(attrs['ai.tool_call_count']).toBe(3)
  })

  it('scrubs the message itself', async () => {
    const beforeSendLog = await getBeforeSendLog()

    const out = beforeSendLog({
      level: 'warn',
      message: "EACCES: permission denied, open '/home/ivan/.config/mailcopilot/config.json' for ivan@example.com",
    } as never)!

    expect(out.message).toBe("EACCES: permission denied, open '/home/<user>/.config/mailcopilot/config.json' for <email>")
  })

  it('still drops every log when the user has not consented', async () => {
    const sentry = await import('@sentry/node')
    const { initSentry, setSentryUserEnabled } = await import('./sentry')
    initSentry()
    const beforeSendLog = vi.mocked(sentry.init).mock.calls[0][0]!.beforeSendLog!

    setSentryUserEnabled(false)
    expect(beforeSendLog({ level: 'info', message: 'x' } as never)).toBeNull()
  })

  it('never throws on an unexpected log shape', async () => {
    const beforeSendLog = await getBeforeSendLog()
    expect(() => beforeSendLog({ level: 'info', message: 'x', attributes: null } as never)).not.toThrow()
    expect(() => beforeSendLog({} as never)).not.toThrow()
  })
})
