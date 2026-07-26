// Sentry initialization for the main process (Node.js).
// Must be imported FIRST in main.ts, before any other modules.

import * as Sentry from '@sentry/node'
import { isTransientNetworkError, isLinuxInstallerError } from '@mailcopilot/core'
import { recordEvent } from './metrics'

// §2.33 (M3) — `isKeychainUnavailableError` + the underlying regex were
// relocated to @mailcopilot/core (packages/core/keychainErrors.ts) so the
// §2.33 secretStore can classify a keytar failure without importing
// electron/sentry.ts (which would pull @sentry/node into its graph). We
// re-export the predicate here for back-compat: existing importers
// (sentry.test.ts, future callers that already hold a raw error and want to
// label it) keep `import { isKeychainUnavailableError } from './sentry'`
// working unchanged. The full regex-design rationale (why it is broad and
// cross-platform, why the bare D-Bus method name is not matched alone) lives in
// keychainErrors.ts.
export { isKeychainUnavailableError } from '@mailcopilot/core'

const IS_E2E = process.env.MAILCOPILOT_E2E === '1'

/**
 * §2.34 — Which secret-read surface a keychain failure came from. Mirrors the
 * `secret_store_surface` enum domain in metricsSchema.ts; kept as a local
 * literal union so callers (electron/services/ai.ts, future §2.33
 * secretStore.ts) get a compile-time-checked argument without sentry.ts taking
 * a runtime dependency on the schema module. A drift between the two is caught
 * by typecheck at the call sites.
 */
export type SecretStoreSurface = 'imap_smtp' | 'oauth_refresh' | 'ai_keys' | 'unknown'

// §2.34 — Dedup latch for reportKeychainUnavailable(). The secret-store backend
// is process-wide: once it is down, every subsequent read fails the same way
// (the incident showed 4+ net:* ops failing back-to-back). We capture ONE
// Sentry exception + ONE usage metric per session from this helper rather than
// one per IPC operation. Reset only by the test hook below.
let _keychainReported = false

function currentPlatformTag(): 'linux' | 'darwin' | 'win32' {
  return process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
}

/**
 * §2.34 — Single, reusable entry point for "the OS secret store is
 * unavailable". Callers that read secrets directly (electron/services/ai.ts
 * for AI keys today; the §2.33 secretStore for everything tomorrow) call this
 * from their keytar failure catch. It is fire-and-forget:
 *
 *   - dedups to one report per session (see `_keychainReported`),
 *   - captures the exception with a stable `keychain_unavailable` tag +
 *     fingerprint so all sources collapse into a single Sentry issue and the
 *     event bypasses the transient-noise filter in beforeSend,
 *   - records the `secret_store.fallback_active` usage metric.
 *
 * Privacy (CLAUDE.md §8 + §2.34 security review): the raw `err` is NEVER sent
 * to Sentry. keytar / libsecret / SecKeychain backends can embed the keytar
 * service, account, or key name (`imap:42`, `smtp:42`, an OAuth account) into
 * `err.message` / `err.stack` / `err.cause`, so forwarding the raw object would
 * leak account identifiers. We capture a SYNTHETIC exception with a fixed,
 * attacker-uncontrolled message; only the enum `surface` / `platform` ride
 * along. The raw `err` is still surfaced for local diagnosis on the user's own
 * machine via the caller's handleIpc / log path — that surface is untouched.
 * Telemetry must never throw out of the read-password path, so every sink is
 * wrapped (CLAUDE.md §8).
 *
 * packages/net/config.ts cannot import this helper (it is layer-pure and must
 * not pull @sentry/node into its graph); it routes the same signal through the
 * packages/net telemetry seam (reportNetError + reportNetEvent) using its own
 * synthetic error, which lands on the same beforeSend stamp (via the
 * `extra.source === 'keychain.read'` provenance marker) and the same metric.
 * §2.33 will collapse that path onto this helper.
 */
export function reportKeychainUnavailable(_err: unknown, surface: SecretStoreSurface = 'unknown'): void {
  if (_keychainReported) return
  _keychainReported = true
  // §2.34 security review (HIGH-1): do NOT forward the raw `err` — a backend
  // message may embed the keytar service / account / key. Send a synthetic
  // error with a controlled message instead; the enum `surface` is the only
  // caller-provided value, and it cannot carry PII.
  const sanitized = new Error('OS secret store unavailable')
  sanitized.name = 'KeychainUnavailable'
  try {
    Sentry.captureException(sanitized, {
      tags: { category: 'keychain_unavailable' },
      fingerprint: ['keychain-unavailable'],
      extra: { source: 'secretStore', surface },
    })
  } catch { /* telemetry must never throw */ }
  try {
    recordEvent('secret_store.fallback_active', { surface, platform: currentPlatformTag() })
  } catch { /* telemetry must never throw */ }
}

/** Test-only: reset the per-session keychain dedup latch. */
export function __resetKeychainReportStateForTest(): void {
  _keychainReported = false
}

// Error reporting toggle. Default is true (enabled).
// Updated from main.ts BEFORE initSentry() via setSentryUserEnabled(), so the
// very first events (including session envelopes that bypass beforeSend)
// honor the persisted sentryEnabled flag.
let _sentryUserEnabled = true

// Cached install-id hash so setSentryUserEnabled(true) can re-attach the
// identity on a runtime off→on toggle without the caller having to call
// setSentryUserId again. Populated on every setSentryUserId invocation
// regardless of the current enabled state.
let _cachedInstallIdHash: string | null = null

/**
 * Attach a stable anonymous identity to every event and span. The id is a
 * 16-hex-char SHA-256 hash of a per-install UUID (see electron/installId.ts)
 * — never an email, never a device fingerprint. Without setUser, Sentry's
 * count_unique(user) and Release Health adoption % are permanently 0,
 * because sendDefaultPii:false strips every implicit user hint.
 *
 * Privacy invariants:
 *   - Called only when _sentryUserEnabled is true (the Settings toggle).
 *   - Reset to null on disable, so toggling the setting propagates in-session.
 *   - The hash does not rotate on app version bump (retention must survive
 *     releases), and is never shared with any sink besides Sentry.
 */
export function setSentryUserId(installIdHash: string): void {
  if (!installIdHash) return
  _cachedInstallIdHash = installIdHash
  if (!_sentryUserEnabled) return
  try {
    Sentry.setUser({ id: installIdHash })
  } catch { /* telemetry must never throw */ }
}

function clearSentryUser(): void {
  try { Sentry.setUser(null) } catch { /* ignore */ }
}

/**
 * Set the sentryEnabled value from user settings.
 *
 * Call flow:
 *   - main.ts applies the persisted flag BEFORE initSentry so the SDK is
 *     initialized with the correct `enabled` state from the first event.
 *   - A later Settings toggle calls this function again; on off→on we
 *     mutate the live client's `enabled` flag (undocumented but
 *     honored per-event by @sentry/node's transport) and re-attach the
 *     cached install-id so user.id isn't null for post-opt-in events.
 *   - Session tracking started at init time does not retroactively
 *     recover from a runtime opt-in — a full SDK re-init mid-session is
 *     not supported. An app restart is the canonical path.
 */
export function setSentryUserEnabled(enabled: boolean) {
  const wasEnabled = _sentryUserEnabled
  _sentryUserEnabled = enabled
  if (wasEnabled && !enabled) clearSentryUser()
  if (!wasEnabled && enabled && _cachedInstallIdHash) {
    try { Sentry.setUser({ id: _cachedInstallIdHash }) } catch { /* ignore */ }
  }
  try {
    const client = Sentry.getClient()
    if (client) client.getOptions().enabled = enabled && Boolean(__SENTRY_DSN__) && !IS_E2E
  } catch { /* telemetry must never throw */ }
}

/**
 * Call before any logic in main.ts.
 *
 * Invariant: initSentry MUST NOT throw. If the SDK fails to initialize
 * (network misconfig, bad DSN, peer dependency missing — anything), the
 * app must still start. We wrap the call so a broken Sentry can never
 * block the user from using MailCopilot.
 */
export function initSentry() {
  try {
    doInit()
  } catch (err) {
    console.error('[sentry] init failed, continuing without telemetry:', err)
  }
}

function doInit() {
  Sentry.init({
    dsn: __SENTRY_DSN__,
    release: `mailcopilot@${__APP_VERSION__}`,
    environment: IS_E2E ? 'e2e' : (process.env.NODE_ENV === 'development' ? 'development' : 'production'),
    // Enable only when DSN is present, not in e2e, and the user has not
    // disabled telemetry in settings. _sentryUserEnabled must be applied
    // via setSentryUserEnabled() BEFORE initSentry() — see main.ts.
    enabled: Boolean(__SENTRY_DSN__) && !IS_E2E && _sentryUserEnabled,
    sampleRate: 1.0,
    tracesSampleRate: 0.2,
    sendDefaultPii: false,
    // Structured logging for AI telemetry (provider, model, tool usage, cost).
    enableLogs: true,
    beforeSendLog(log) {
      if (!_sentryUserEnabled) return null
      return log
    },
    // Session tracking is enabled automatically in @sentry/node v10.
    integrations(defaults) {
      // Remove OnUncaughtException — in Electron the app should not crash
      // on unhandled errors (we have our own handler in main.ts).
      return defaults.filter(i => i.name !== 'OnUncaughtException')
    },
    beforeSend(event) {
      // User has disabled error reporting in settings.
      if (!_sentryUserEnabled) return null
      const msg = event.exception?.values?.[0]?.value || ''
      // §2.34 — OS secret-store / keychain unavailability must stay visible
      // even though its text ("...Timeout was reached") superficially resembles
      // a transient network timeout. The bypass decision is PROVENANCE-based,
      // not content-based (§2.34 security review MEDIUM): we trust ONLY markers
      // that our own code stamps and that an attacker cannot forge —
      //   - `tags.category === 'keychain_unavailable'` from reportKeychainUnavailable
      //     (electron/sentry.ts + the AI key path), and
      //   - `extra.source === 'keychain.read'` from the packages/net telemetry
      //     seam (reportNetError('keychain.read', ...) via main.ts captureException).
      // We deliberately do NOT match on a keychain signature in the message:
      // an unrelated exception whose text merely contained `org.freedesktop.secrets`
      // / `libsecret` (possibly with PII) would otherwise smuggle itself past the
      // transient/installer noise filters. Stamp a stable tag + fingerprint so
      // every source path collapses into ONE Sentry issue regardless of how many
      // ops failed.
      if (event.tags?.category === 'keychain_unavailable' || event.extra?.source === 'keychain.read') {
        event.tags = { ...event.tags, category: 'keychain_unavailable' }
        event.fingerprint = ['keychain-unavailable']
        return event
      }
      // Filter out noisy transient errors that provide no actionable info.
      // Covers autoUpdater net::ERR_* codes, Node syscall codes, imapflow,
      // and wrapped IPC messages from the renderer. Single source of truth:
      // packages/core/transientErrors.ts.
      if (isTransientNetworkError(msg)) return null
      // Linux .deb installer failures (pkexec/dpkg/apt-get) — surfaced to
      // the user via dialog, not actionable from code.
      if (isLinuxInstallerError(msg)) return null
      return event
    },
    beforeSendTransaction(event) {
      // If user has disabled Sentry, don't send traces either.
      if (!_sentryUserEnabled) return null
      return event
    },
  })
}

/** Wrapper for manual error capture.
 *
 * Invariant: captureException MUST NOT throw. A broken Sentry SDK (network
 * failure, bad transport state, regression in @sentry/node) must not cascade
 * out of a graceful error path — several sinks (bodyIndexer, offlineReplay,
 * searchWorkerClient, mcpClient) call this from their own catch blocks,
 * and a re-throw there would turn a handled error into an unhandled one.
 * Symmetric with the renderer helper in src/sentry.ts.
 */
export function captureException(error: unknown, context?: Record<string, unknown>) {
  try {
    Sentry.captureException(error, context ? { extra: context } : undefined)
  } catch { /* telemetry must never throw */ }
}

/** Wait for buffered events to be sent before shutdown */
export async function flushSentry(timeoutMs = 2000) {
  await Sentry.flush(timeoutMs)
}

// --- Telemetry utilities for AI service ---

/** Create a span with manual lifecycle (call span.end() yourself). Use for async generators. */
export const startInactiveSpan = Sentry.startInactiveSpan

/** Structured logger — always sent (not subject to tracesSampleRate). */
export const sentryLogger = Sentry.logger

/** Wrap an MCP server to auto-instrument all tool handlers with spans. */
export const wrapMcpServerWithSentry = Sentry.wrapMcpServerWithSentry
