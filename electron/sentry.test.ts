import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @sentry/node before importing the module.
vi.mock('@sentry/node', () => {
  const client = { getOptions: () => ({ enabled: true }) }
  return {
    init: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn(),
    setUser: vi.fn(),
    getClient: vi.fn(() => client),
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
