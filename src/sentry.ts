// Sentry initialization for the renderer process (React).

import * as Sentry from '@sentry/react'
import { isTransientNetworkError, scrubUserPathsShape, scrubEventPiiWith } from '@mailcopilot/core'
import {
  IPC_FAILURE_EXCEPTION_NAME,
  ipcFailureLabel,
  isIpcFailureNoise,
  readIpcFailureTag,
  type IpcFailureTag,
} from './utils/errorPresentation'

// Flag controlling error reporting. Default is true (enabled).
// Updated from main.tsx BEFORE initSentry() and later from App.tsx after
// settings load via setSentryUserEnabled().
let _sentryUserEnabled = true

// Cached install-id hash so setSentryUserEnabled(true) can re-attach the
// identity on a runtime off→on toggle without the caller having to remember
// to call setSentryUserId again. Cache is populated on every setSentryUserId
// call regardless of the current enabled state, so the cache survives the
// initial "startup with telemetry off" case.
let _cachedInstallIdHash: string | null = null

/**
 * Attach the stable PSEUDONYMOUS install identity for the renderer's Sentry
 * client. Identical contract to electron/sentry.ts:setSentryUserId — the id is
 * the 16-hex install-id hash passed from main via additionalArguments. Not
 * "anonymous": it is stable and rides on everything, so an install's stream is
 * joinable (electron/installId.ts spells this out, and the consent screen
 * discloses it). Without this call, renderer-originated events share
 * count_unique(user) = 0 with the rest of the dataset and Release Health
 * adoption stays permanently 0.
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
 * Toggle semantics:
 *   off → ON: mutates the live client's enabled flag so subsequent errors
 *   and transactions flow again, and re-attaches the cached install-id so
 *   `user.id` isn't null for post-opt-in events. Caveat: the pageload
 *   transaction created by browserTracingIntegration during init is NOT
 *   retroactively recreated — the user needs a fresh app start for that.
 *   This is an accepted trade-off (a full SDK re-init mid-session would
 *   risk losing breadcrumbs and is not officially supported by Sentry).
 *
 *   ON → off: calls Sentry.setUser(null) so subsequent events don't carry
 *   the hash, and flips the client's enabled flag off so session envelopes
 *   stop flowing too (beforeSend alone cannot suppress those).
 *
 * Note: directly mutating client.getOptions().enabled is not a publicly
 * documented runtime toggle in @sentry/react — any SDK upgrade should
 * re-verify that the transport still honors the flag per-event.
 *
 * §2.82 — the value handed in is the EFFECTIVE permission published by main
 * (`clampTelemetryForRenderer`), not the raw `sentryEnabled` field: with no
 * consent record the renderer is told `false` even though the settings schema
 * defaults that field to `true`.
 */
export function setSentryUserEnabled(enabled: boolean) {
  const wasEnabled = _sentryUserEnabled
  _sentryUserEnabled = enabled
  if (wasEnabled && !enabled) clearSentryUser()
  if (!wasEnabled && enabled && _cachedInstallIdHash) {
    try { Sentry.setUser({ id: _cachedInstallIdHash }) } catch { /* ignore */ }
  }
  if (wasEnabled !== enabled) {
    // Breadcrumbs accumulate regardless of the `enabled` flag (clicks, console
    // output, fetch/XHR, navigation — the renderer is where most of them come
    // from). Without this the first event after an opt-in would carry a trail
    // of pre-consent activity; on a withdrawal it would leave one behind for a
    // later re-opt-in to ship.
    try { Sentry.getCurrentScope().clearBreadcrumbs() } catch { /* ignore */ }
    try { Sentry.getIsolationScope().clearBreadcrumbs() } catch { /* ignore */ }
  }
  try {
    const client = Sentry.getClient()
    if (client) client.getOptions().enabled = enabled && import.meta.env.PROD && Boolean(__SENTRY_DSN__)
  } catch { /* telemetry must never throw */ }
}

// --- PII scrubbing (§2.82 AC (g)) ------------------------------------------
//
// Two things ride along with an event by default that are personal data under
// GDPR art. 4(1):
//
//   1. The IP address. `sendDefaultPii: false` tells the SDK not to attach one,
//      but the server can still infer it from the envelope's connection unless
//      the event explicitly carries `ip_address: null` — Sentry's documented
//      "do not infer" signal. We set it on every event and transaction.
//   2. The OS account name, embedded in exception text and in path-bearing
//      fields. In production the renderer's frames are bundle URLs, but
//      source-mapped frames, dev builds, file:// paths and any path forwarded
//      from main through an IPC rejection message carry the real home
//      directory.
//
// Both rules — the shape regexes and the list of event fields that may carry a
// path — live in packages/core/piiScrub.ts and are shared verbatim with
// electron/sentry.ts. They used to be an independent copy here, which drifted
// invisibly: each side only tested itself. The main process layers one extra
// rule on top (literal `os.homedir()` substitution) that the sandboxed
// renderer has no way to compute, which is why the shared entry point takes
// the string rewriter as a parameter.

/**
 * Remove the OS account name from a path-bearing string.
 *
 * Pure and idempotent — running it twice yields the same string. Exported for
 * unit tests; production callers go through `scrubEventPii`.
 */
export function scrubUserPaths(value: string): string {
  return scrubUserPathsShape(value)
}

/**
 * Strip the IP address and the OS account name from an outgoing event.
 *
 * Mutates in place and returns the same object (Sentry's beforeSend contract
 * expects the event back). Wrapped end-to-end: an unanticipated shape must
 * never turn telemetry into a crash (CLAUDE.md §8).
 */
export function scrubEventPii<T>(event: T): T {
  return scrubEventPiiWith(event, scrubUserPathsShape)
}

// --- Tagged IPC rejections (§2.127 second door) -----------------------------
//
// `scrubEventPii` is a DENY list by construction: it recognises the shapes we
// thought of (paths, addresses). A rejection whose text an IMAP/SMTP server
// wrote is free text — no shape rule can cover it, and CLAUDE.md §8 requires an
// ALLOW list for third-party input. So a rejection that carries the
// main-process verdict (`[mcerr:*]`, see src/utils/errorPresentation.ts) is not
// scrubbed but REPLACED: what leaves the process is assembled from the verdict
// enum and a shape-validated channel name, and the raw tail is dropped.
//
// Nothing is lost by dropping it. Main reports the same failure with an
// authoritative synthetic event of its own (`reportSanitizedNetError` and the
// funnel in electron/ipc.ts), where the error object is still intact; the raw
// text stays in the local log via `describeErrorForLog`.

/** Fields of an outgoing event that can carry the raw tail. */
interface ShapeableEvent {
  exception?: { values?: Array<Record<string, unknown>> }
  threads?: unknown
  message?: unknown
  logentry?: unknown
  culprit?: unknown
  breadcrumbs?: unknown
  extra?: unknown
  contexts?: Record<string, unknown>
  tags?: Record<string, unknown>
}

// SDK-populated contexts describing the machine and the trace, never the error.
// Anything else on `contexts` was written by application code and is dropped.
const SAFE_CONTEXT_KEYS = ['trace', 'browser', 'os', 'device', 'runtime', 'app', 'culture'] as const

// `source` is the only tag renderer code sets (a literal from the call site);
// the two `ipc_*` tags are written below from the closed set. The shape guard
// exists so a future call site cannot smuggle text through the tag map either.
const SAFE_TAG_KEYS = ['source', 'ipc_failure', 'ipc_channel'] as const
const SAFE_TAG_VALUE_RE = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * Reduce an event to the closed set: a synthetic exception plus SDK metadata.
 *
 * `label` non-null replaces the exception entirely (value AND stack), which is
 * the tagged-rejection path. `label` null keeps the exception that is already
 * synthetic — the one `captureException` built below, whose value is ours and
 * whose stack is renderer frames — and only applies the surrounding hygiene.
 *
 * Never throws: telemetry must not become a crash (CLAUDE.md §8).
 */
function applyIpcFailureShape<T>(event: T, label: string | null, failure: IpcFailureTag | null): T {
  try {
    const e = event as ShapeableEvent
    if (label !== null) {
      e.exception = {
        values: [{
          type: IPC_FAILURE_EXCEPTION_NAME,
          value: label,
          mechanism: { type: 'ipc', handled: true },
        }],
      }
    }
    // Every remaining carrier of the raw tail. `breadcrumbs` go too: console
    // output is a breadcrumb source in the renderer, so a rejection printed
    // anywhere on the way here would otherwise ride along with this event.
    e.threads = undefined
    e.message = undefined
    e.logentry = undefined
    e.culprit = undefined
    e.breadcrumbs = []
    e.extra = undefined
    if (e.contexts && typeof e.contexts === 'object') {
      const contexts = e.contexts
      const kept: Record<string, unknown> = {}
      for (const key of SAFE_CONTEXT_KEYS) {
        if (contexts[key] !== undefined) kept[key] = contexts[key]
      }
      e.contexts = kept
    }
    const tags = e.tags && typeof e.tags === 'object' ? e.tags : {}
    const keptTags: Record<string, unknown> = {}
    for (const key of SAFE_TAG_KEYS) {
      const value = tags[key]
      if (typeof value === 'string' && SAFE_TAG_VALUE_RE.test(value)) keptTags[key] = value
    }
    if (failure) {
      keptTags.ipc_failure = failure.key
      if (failure.channel) keptTags.ipc_channel = failure.channel
    }
    e.tags = keptTags
  } catch { /* telemetry must never throw */ }
  return event
}

/**
 * First tagged rejection carried by an event, looking at every exception value
 * (the linkedErrors integration can chain causes) and at `event.message`.
 */
function findIpcFailure(event: unknown): IpcFailureTag | null {
  try {
    const e = event as ShapeableEvent
    for (const value of e.exception?.values ?? []) {
      const failure = readIpcFailureTag(value?.value)
      if (failure) return failure
    }
    return readIpcFailureTag(e.message)
  } catch {
    return null
  }
}

/** True when the event is one we already built from the closed set. */
function isSyntheticIpcFailure(event: unknown): boolean {
  try {
    const e = event as ShapeableEvent
    return (e.exception?.values ?? []).some(v => v?.type === IPC_FAILURE_EXCEPTION_NAME)
  } catch {
    return false
  }
}

/**
 * Must be called before ReactDOM.createRoot() in main.tsx.
 *
 * Invariant: initSentry MUST NOT throw. A broken Sentry in the renderer
 * must still let the UI render — telemetry is best-effort and never a
 * startup dependency.
 *
 * When the user has telemetry off (set via setSentryUserEnabled(false)
 * BEFORE this call, from main.tsx reading window.api.sentryEnabled), we
 * still call Sentry.init but with `enabled: false`. Session envelopes
 * (browser session tracking, pageload transaction) bypass beforeSend, so
 * flipping the `enabled` flag is the only reliable way to suppress them
 * from the very first event. Re-enabling at runtime is handled by
 * setSentryUserEnabled, which toggles the Sentry client on/off without
 * a full re-init.
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
    environment: import.meta.env.PROD ? 'production' : 'development',
    enabled: import.meta.env.PROD && Boolean(__SENTRY_DSN__) && _sentryUserEnabled,
    sampleRate: 1.0,
    tracesSampleRate: 0.2,
    sendDefaultPii: false,
    // Default integrations (breadcrumbs, globalHandlers, httpContext, deduplication, etc.)
    // are restored automatically. browserTracingIntegration adds performance tracing.
    integrations: [
      Sentry.browserTracingIntegration(),
    ],
    beforeSend(event) {
      // User disabled error reporting in settings.
      if (!_sentryUserEnabled) return null
      const msg = event.exception?.values?.[0]?.value || ''
      // ResizeObserver loop — noisy and harmless browser error.
      if (msg.includes('ResizeObserver loop')) return null
      // §2.127 — a rejection tagged by the main-process funnel is handled from
      // the VERDICT, before any text-based rule gets a say. `offline`/`timeout`
      // are network state and never sent (this is also the only thing that ever
      // matched the AggregateError case — see IPC_FAILURE_NOISE_KEYS); anything
      // else is replaced by a synthetic event, because the tail after the tag is
      // written by a third-party server.
      const failure = findIpcFailure(event)
      if (failure) {
        if (isIpcFailureNoise(failure)) return null
        return scrubEventPii(applyIpcFailureShape(event, ipcFailureLabel(failure), failure))
      }
      // Already synthetic (built by `captureException` below): the value is
      // ours, but the surrounding hygiene still applies so both paths ship the
      // same closed set.
      if (isSyntheticIpcFailure(event)) return scrubEventPii(applyIpcFailureShape(event, null, null))
      // Transient network errors (net::ERR_*, Node codes, imapflow phrases)
      // often arrive in the renderer as wrapped IPC rejections like:
      //   "Error invoking remote method 'update:download': Error: net::ERR_CONNECTION_RESET"
      // They are not actionable from code — retry happens on the next poll.
      // NOTE: we intentionally do NOT blanket-filter update:* channels here.
      // A previous version silenced any rejection from update:download /
      // update:install, which also hid real install_failed / permission /
      // corrupt-artifact errors. Only the transient classifier decides.
      if (isTransientNetworkError(msg)) return null
      // §2.82 AC (g): last stop before the transport — drop the IP and the OS
      // account name embedded in stack frame paths.
      return scrubEventPii(event)
    },
    beforeSendTransaction(event) {
      // If the user disabled Sentry, don't send traces either.
      if (!_sentryUserEnabled) return null
      // Transactions carry a `user` too — same IP rule applies.
      return scrubEventPii(event)
    },
  })
}

export const SentryErrorBoundary = Sentry.ErrorBoundary

/**
 * Capture an exception in Sentry from renderer code.
 *
 * Mirrors the signature of electron/sentry.ts:captureException so call sites
 * across both processes look identical. The `source` field is always recorded
 * as a Sentry tag for easy filtering; all other keys land in `extra`.
 *
 * Invariants (§8 hard limits):
 *  - Never throws — a broken Sentry SDK must not crash the renderer.
 *  - No-op when the user has disabled telemetry (_sentryUserEnabled === false).
 *  - No-op for transient network errors (IMAP/SMTP socket noise wrapped in IPC
 *    rejections) — same classifier used by beforeSend to avoid double-reporting.
 *  - Never include PII (email subjects, addresses, bodies) in context fields.
 *  - Never transmits the text of a tagged IPC rejection. A caller handing us a
 *    raw `catch (err)` from `window.api.invoke(...)` is the normal case (see
 *    `Account.tlsCertFetch`, `useCertRecovery.*`), and that text is written by
 *    the server on the other end of the socket. The verdict main stamped on it
 *    decides: network state is dropped, everything else is reported as a
 *    synthetic exception built from the closed set. The raw value never reaches
 *    the SDK at all on this path, so no integration (linkedErrors, dedupe) can
 *    copy it somewhere `beforeSend` does not look.
 */
export function captureException(
  error: unknown,
  context: { source: string; [key: string]: unknown },
): void {
  try {
    if (!_sentryUserEnabled) return
    const failure = readIpcFailureTag(error)
    if (failure) {
      if (isIpcFailureNoise(failure)) return
      const label = ipcFailureLabel(failure)
      const synthetic = new Error(label)
      synthetic.name = IPC_FAILURE_EXCEPTION_NAME
      Sentry.withScope((scope) => {
        scope.setTag('source', context.source)
        scope.setTag('ipc_failure', failure.key)
        if (failure.channel) scope.setTag('ipc_channel', failure.channel)
        // Caller-supplied extras are deliberately dropped: they are collected
        // per call site and this path is an allow list, not a filtered one.
        Sentry.captureException(synthetic)
      })
      return
    }
    const msg = error instanceof Error ? error.message : String(error ?? '')
    if (isTransientNetworkError(msg)) return
    const { source, ...extra } = context
    Sentry.withScope((scope) => {
      scope.setTag('source', source)
      if (Object.keys(extra).length > 0) scope.setExtras(extra)
      Sentry.captureException(error)
    })
  } catch {
    // Telemetry must never throw — swallow any SDK failure silently.
  }
}

/** Send user feedback via Sentry SDK. */
export function sendFeedback(params: {
  message: string
  email?: string
  name?: string
  associatedEventId?: string
}) {
  // If Sentry is disabled by user — silently skip.
  if (!_sentryUserEnabled) return
  Sentry.withScope((scope) => {
    scope.setTag('app_version', __APP_VERSION__)
    Sentry.captureFeedback({
      message: params.message,
      email: params.email,
      name: params.name,
      associatedEventId: params.associatedEventId,
    })
  })
}

/** Returns true if Sentry is enabled and available for sending. */
export function isSentryActive(): boolean {
  return import.meta.env.PROD && Boolean(__SENTRY_DSN__) && _sentryUserEnabled
}

/**
 * Handle returned by {@link startManualSpan}. The facade wraps every
 * operation in try/catch so the caller can forward telemetry-adjacent state
 * mutations without defensive boilerplate.
 */
export type ManualSpanHandle = {
  setAttribute(key: string, value: number | string | boolean): void
  end(): void
}

/**
 * Renderer-side span helper for long-running observation windows (e.g.
 * cold-start telemetry). Uses `Sentry.startSpanManual` so the caller owns
 * `.end()` timing — unlike `Sentry.startSpan`, which ends the span the
 * moment the sync callback returns (documented in @sentry/core trace.js).
 *
 * Invariants (§8 telemetry hard limits):
 *  - Never throws — a broken Sentry SDK must not crash the renderer.
 *  - Returns `null` when telemetry is disabled by the user or the SDK
 *    refuses to start a span (caller must guard / short-circuit).
 *  - Returned handle's own methods are also try/catch-wrapped, so after
 *    obtaining a non-null handle the caller can call `setAttribute` and
 *    `end` unconditionally without wrapping each call.
 *
 * Note: this is the only sanctioned renderer entry point for span creation
 * (CLAUDE.md §8 routing invariant). Direct `Sentry.startSpan` / `startSpanManual`
 * in components and hooks bypasses the `_sentryUserEnabled` gate and the
 * error-swallowing contract.
 */
export function startManualSpan(options: {
  name: string
  op?: string
  attributes?: Record<string, number | string | boolean>
}): ManualSpanHandle | null {
  if (!_sentryUserEnabled) return null
  try {
    // startSpanManual returns whatever the callback returns. We capture the
    // span reference synchronously and return a facade that owns the lifetime.
    const handle = Sentry.startSpanManual(
      {
        name: options.name,
        op: options.op,
        attributes: options.attributes,
        // Detach from any active trace so the renderer span keeps the global
        // tracesSampleRate policy instead of inheriting an ambient parent
        // sampling decision. Mirrors the main-process `openMetricSpan`
        // pattern in electron/metrics.ts (parentSpan: null sampling guard).
        parentSpan: null,
      },
      (span): ManualSpanHandle => ({
        setAttribute(key, value) {
          try {
            const s = span as { setAttribute?: (k: string, v: number | string | boolean) => void }
            if (s && typeof s.setAttribute === 'function') {
              s.setAttribute(key, value)
            }
          } catch {
            /* telemetry must never throw */
          }
        },
        end() {
          try {
            const s = span as { end?: () => void }
            if (s && typeof s.end === 'function') {
              s.end()
            }
          } catch {
            /* telemetry must never throw */
          }
        },
      }),
    )
    return handle ?? null
  } catch {
    // Sentry SDK absent, disabled, or broken — silently degrade.
    return null
  }
}
