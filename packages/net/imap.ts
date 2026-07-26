import { ImapFlow } from 'imapflow'
import type { ExistsEvent } from 'imapflow'
import type { ImapConfig, MailSummary, Mailbox, FolderRoles } from './types'
import { normalizeFingerprintSha256, buildTlsOptions, isTlsTrustError } from './tls'
import {
  upsertMessages,
  setUnread,
  deleteMessages,
  setFlagged as setFlaggedDb,
  upsertContactsIncoming,
  removeStaleMessages,
  getAccountMessageCount,
  getFolderUids,
  getFolderFlags,
  removeStaleMessagesByUids,
  getMessageByUid,
  setPinned,
} from '../db'
import { buildRawMessage } from './smtp'
import { withNetSpan, startNetSpan, reportNetError, reportNetEvent } from './telemetry'
import {
  isInCooldown,
  recordRefreshFailure,
  recordRefreshSuccess,
} from './authRefreshCooldown'
import {
  bucketIdleDuration,
  bucketFetchedHeaders,
  bucketDuration,
  folderRoleFromPath,
  providerFromHost,
} from '../../electron/metricsBuckets'

/**
 * §2.17 Phase 0 — requester tag for `imap.pool_queue_wait_ms`.
 *
 * Identifies which subsystem is waiting on the per-account pool semaphore so
 * dashboards can answer "is the interactive open path being blocked by the
 * background indexer?". Phase 0 only records timing — Phase 1 will use this
 * tag to give the interactive tier priority. Kept as a narrow union so the
 * value space mirrors DOMAINS.imap_pool_requester in metricsSchema.ts.
 */
export type ImapPoolRequester = 'interactive' | 'background' | 'indexer' | 'sync' | 'other'

/** §2.17 Phase 0 — opts for withImapRetryPerAccount. Forward-compat shape:
 *  Phase 1 will plumb `priority` through to a real priority semaphore. */
export type WithImapRetryPerAccountOpts = {
  priority?: ImapPoolRequester
}

/** §2.17 Phase 0 — emit imap.pool_queue_wait_ms only above the long-tail
 *  threshold so dashboards aren't drowned by sub-millisecond fast paths. */
const POOL_QUEUE_WAIT_REPORT_THRESHOLD_MS = 500

const noop = () => {}
/** Silent logger suppresses all ImapFlow debug/info output to keep logs clean. */
const silentLogger = { debug: noop, info: noop, warn: noop, error: noop, trace: noop, fatal: noop }

type ServerFlagMap = Map<number, { seen: boolean; flagged: boolean }>
type LocalFlagMap = Map<number, { unread: boolean; flagged: boolean }>

/**
 * Diff server flag state against local DB state and return only the UIDs
 * whose seen/flagged values actually changed. UIDs unknown locally are
 * skipped — they're handled by the new-messages path.
 */
function diffFlags(serverFlags: ServerFlagMap, localFlags: LocalFlagMap) {
  const markRead: number[] = []
  const markUnread: number[] = []
  const markFlagged: number[] = []
  const markUnflagged: number[] = []
  for (const [uid, sf] of serverFlags) {
    const lf = localFlags.get(uid)
    if (!lf) continue
    const localSeen = !lf.unread
    if (sf.seen !== localSeen) {
      if (sf.seen) markRead.push(uid)
      else markUnread.push(uid)
    }
    if (sf.flagged !== lf.flagged) {
      if (sf.flagged) markFlagged.push(uid)
      else markUnflagged.push(uid)
    }
  }
  return { markRead, markUnread, markFlagged, markUnflagged }
}

let client: ImapFlow | null = null
let currentUserKey: string | null = null
let connecting: Promise<ImapFlow> | null = null

/** NOOP heartbeat interval — 2 min (keeps connection alive through NAT/proxies) */
const NOOP_HEARTBEAT_MS = 2 * 60_000
let noopTimer: ReturnType<typeof setInterval> | null = null

function startNoopHeartbeat(): void {
  stopNoopHeartbeat()
  noopTimer = setInterval(async () => {
    if (!client || !client.usable) return
    try {
      await client.noop()
    } catch {
      // Connection dead — force disconnect so next operation reconnects
      if (client) { try { await client.logout() } catch { /* ignore */ } }
      client = null
      currentUserKey = null
      connecting = null
      stopNoopHeartbeat()
    }
  }, NOOP_HEARTBEAT_MS)
  // Unref so it doesn't keep the process alive
  if (noopTimer && typeof noopTimer === 'object' && 'unref' in noopTimer) {
    noopTimer.unref()
  }
}

function stopNoopHeartbeat(): void {
  if (noopTimer) { clearInterval(noopTimer); noopTimer = null }
}

// Separate IMAP connection for IDLE/push updates.
// Kept separate from the main singleton client: opening other folders on the main client
// would interfere with monitoring the selected folder via IDLE.
let idleClient: ImapFlow | null = null
let idleUserKey: string | null = null
let idleMailbox: string | null = null
let idleStop = false
let idleLoop: Promise<void> | null = null
let idleExistsHandler: ((data: ExistsEvent) => void) | null = null

// All commands on the main IMAP client must be executed sequentially:
// `mailboxOpen()` changes the global connection state (SELECT mailbox).
// Without serialization, parallel operations can "switch" mailboxes on each other.
let imapOpChain: Promise<void> = Promise.resolve()
function withImapOpLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = imapOpChain.then(() => fn())
  imapOpChain = run.then(() => {}, () => {})
  return run
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** TCP keepalive interval — Thunderbird default (100s idle, then probes) */
const TCP_KEEPALIVE_MS = 100_000

/** Enable TCP keepalive on the raw socket (detects dead connections after suspend/hibernate) */
function applySocketOptions(c: ImapFlow): void {
  // ImapFlow emits undocumented 'socket' event with the raw net.Socket
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-extra-semi
  ;(c as any).on('socket', (socket: import('node:net').Socket) => {
    socket.setKeepAlive(true, TCP_KEEPALIVE_MS)
  })
}

/** IDLE refresh interval — re-issue IDLE every 24 min (K-9 Mail pattern, RFC 2177 recommends max 29 min) */
export const IDLE_REFRESH_MS = 24 * 60 * 1000

/** Classify IMAP errors for differentiated backoff (K-9 Mail pattern).
 *
 *  Auth patterns cover both password-based failures and OAuth2/XOAUTH2 token
 *  rejections from Microsoft 365 ("AUTHENTICATE failed", "NO LOGIN",
 *  "token expired", "XOAUTH2") and Google ("WEBALERT", "Web login required").
 *
 *  'cert' is deliberately checked FIRST and kept out of 'network': cert
 *  errors used to fall into the network bucket, which meant a silent
 *  infinite 5-minute retry loop when an antivirus / corporate proxy
 *  intercepted the mail ports (Windows + Kaspersky incident). Retrying a
 *  trust failure cannot succeed until the trust anchors change, so it gets
 *  its own long backoff plus a main-process notification channel
 *  (registerCertErrorHandler). Checking cert before auth also prevents a
 *  useless OAuth token refresh on a TLS-layer failure.
 *
 *  Cert detection itself lives in `isTlsTrustError` (./tls) — the single
 *  canonical matcher, shared with the trust probe. It matches OpenSSL/Node
 *  error CODES plus a closed set of full OpenSSL phrases; a bare mention of
 *  the word "certificate" in an auth/policy response deliberately does NOT
 *  classify as 'cert' (it used to, which suppressed token refresh and
 *  surfaced a misleading TLS-interception dialog).
 */
export function classifyImapError(err: unknown): 'network' | 'auth' | 'cert' | 'permanent' {
  const msg = err instanceof Error ? err.message : String(err)
  if (isTlsTrustError(err)) {
    return 'cert'
  }
  if (/AUTHENTICATIONFAILED|LOGIN|CREDENTIALS|NO LOGIN|Invalid credentials|AUTHENTICATE|XOAUTH2|token expired|WEBALERT|Web login required/i.test(msg)) {
    return 'auth'
  }
  if (/NO \[NONEXISTENT\]|mailbox not found|does not exist/i.test(msg)) {
    return 'permanent'
  }
  return 'network'
}

// ---------------------------------------------------------------------------
// Auth error handler registry (dependency injection for OAuth token refresh)
// ---------------------------------------------------------------------------
// packages/net must not import electron/ — auth refresh is injected via
// callback. electron/main.ts registers a handler per accountId; withImapRetry
// and friends look it up on auth failure and invoke it to obtain a fresh
// access token before reconnecting.
//
// Keyed by accountId (integer DB primary key), NOT by userKey(cfg). Two DB
// rows can share identical (user, host, port, TLS, pins) — e.g. the same
// Outlook mailbox added twice with two distinct refresh tokens — and they
// MUST have independent handlers. userKey collision would make the second
// registration silently overwrite the first, causing an auth failure on
// either account to invoke the wrong refresh handler.

/** Callback that refreshes the OAuth token and returns a fresh access token. */
export type OnAuthError = () => Promise<string>

const authErrorHandlers = new Map<number, OnAuthError>()

/** Register an auth-error handler for the given account.
 *  When withImapRetry / withImapRetryPerAccount / withDedicatedImapRetry hit
 *  an auth error, they look up the handler by accountId and invoke it to
 *  obtain a fresh access token before retrying the operation once. */
export function registerAuthErrorHandler(accountId: number, handler: OnAuthError): void {
  authErrorHandlers.set(accountId, handler)
}

/** Remove a previously registered auth-error handler. Idempotent. */
export function unregisterAuthErrorHandler(accountId: number): void {
  authErrorHandlers.delete(accountId)
}

// ---------------------------------------------------------------------------
// Cert error handler registry (main-process subscription to TLS trust failures)
// ---------------------------------------------------------------------------
// Mirrors the auth-error registry above: packages/net must not import
// electron/, so the main process registers a per-accountId callback and the
// retry wrappers invoke it (fire-and-forget) when an error classifies as
// 'cert'. This is the signal channel for the "local TLS interception" UX
// (antivirus / corporate proxy MITM on mail ports) — see verifyCertTrust in
// ./tls for the trust-diagnosis half.

/** Payload delivered to a registered cert-error handler.
 *
 *  `secure` / `protocol` describe the TRANSPORT of the failed endpoint and
 *  must be forwarded to `verifyCertTrust` — a diagnostic probe that opens an
 *  implicit-TLS connection to a plaintext STARTTLS port (143/587) sends a raw
 *  ClientHello into a text protocol and gets no certificate at all. They are
 *  optional only so subscribers written before this field existed keep
 *  compiling; `notifyCertError` always populates both. Omission means
 *  "assume implicit TLS", which is what the probe used to do unconditionally. */
export type CertErrorPayload = {
  host: string
  port: number
  rawMessage: string
  /** `true` = implicit TLS (993), `false` = STARTTLS upgrade (143). */
  secure?: boolean
  /** Application protocol of the endpoint; always `'imap'` from this registry. */
  protocol?: 'imap'
}

/** Callback invoked when an IMAP operation fails with a certificate error. */
export type OnCertError = (payload: CertErrorPayload) => void

const certErrorHandlers = new Map<number, OnCertError>()

/** Register a cert-error handler for the given account.
 *
 *  Invoked (fire-and-forget, never blocking the retry path) by
 *  withImapRetry / withImapRetryPerAccount / withDedicatedImapRetry when an
 *  error classifies as 'cert'. Exceptions thrown by the handler are
 *  swallowed — a broken subscriber must not change retry semantics.
 *
 *  Deliberately NO deduplication or storm-guarding here: every cert-failed
 *  operation fires the handler. Dedup/rate-limiting is the main-process
 *  subscriber's job (Phase A2 in electron/main.ts), which owns the UX
 *  decision of when to surface the interception banner.
 *
 *  Keyed by accountId (DB primary key), same rationale as the auth-error
 *  registry above. */
export function registerCertErrorHandler(accountId: number, handler: OnCertError): void {
  certErrorHandlers.set(accountId, handler)
}

/** Remove a previously registered cert-error handler. Idempotent. */
export function unregisterCertErrorHandler(accountId: number): void {
  certErrorHandlers.delete(accountId)
}

/** Fire-and-forget cert-error notification: typed telemetry event first
 *  (emitted regardless of subscriber presence), then the registered
 *  handler, if any. Never throws. */
function notifyCertError(accountId: number, cfg: ImapConfig, err: unknown): void {
  // Event name must be registered in electron/metricsSchema.ts by Phase A2.
  reportNetEvent('imap.cert_error', { provider: providerFromHost(cfg.host) })
  const handler = certErrorHandlers.get(accountId)
  if (!handler) return
  try {
    handler({
      host: cfg.host,
      port: cfg.port,
      rawMessage: err instanceof Error ? err.message : String(err),
      secure: cfg.secure !== false,
      protocol: 'imap',
    })
  } catch { /* subscriber failures must not affect the retry path */ }
}

/**
 * Per-accountId single-flight map for the cooldown-gated refresh path.
 *
 * Why this is required (H1 regression fix): the old implementation read
 * `isInCooldown()` and then awaited `handler()` without any per-account
 * lock. Two concurrent IMAP ops on the same accountId could both observe
 * `isInCooldown() === false`, both enter the try-block, and both call
 * `recordRefreshFailure()` on joint failure — bumping
 * `consecutiveFailures` from 0 to 2 after a single real failed refresh
 * and immediately promoting the account into the 5-minute cooldown
 * window. Under normal concurrent sync patterns (periodic sync + IDLE +
 * body indexer all failing auth at once) this caused premature lockouts.
 *
 * Fix: serialize the check-and-invoke sequence per accountId via a
 * `Map<number, Promise<string | null>>` single-flight. The second caller
 * awaits the first's result and returns its outcome directly — "one
 * refresh attempt per accountId per trigger burst". Provider-level
 * single-flight (OUTLOOK_TOKEN_REFRESH_INFLIGHT / GOOGLE equivalent)
 * still prevents actual /token stampedes across accounts that share a
 * client_id; this gate prevents cooldown-counter over-count within a
 * single accountId.
 *
 * Per-accountId isolation is preserved: accountA's pending refresh does
 * NOT block accountB's — the map is keyed by accountId.
 */
const authRefreshInflight = new Map<number, Promise<string | null>>()

/**
 * Per-accountId counter of *consecutive* in-loop auth refreshes inside the
 * IDLE cycle. Incremented after a refresh + reconnect succeeds; reset the
 * moment the next IDLE cycle parks cleanly (i.e. the fresh token actually
 * delivered push).
 *
 * Storm-protection rationale (M-1 fix): §2.2-D `authRefreshCooldown` guards
 * the provider `/token` endpoint — it trips on `recordRefreshFailure`, i.e.
 * when the provider itself refuses to mint a token. It does NOT protect the
 * scenario where the provider happily returns a fresh access token on every
 * call but the IMAP server rejects the resulting AUTHENTICATE (conditional-
 * access policy, per-mailbox MFA, clock skew, admin-revoked-at-IMAP-side,
 * etc.). In that case `recordRefreshSuccess` clears cooldown state each
 * iteration, the `continue` path skips `BACKOFF_MS.auth`, and the loop
 * hammers `/token` with zero inter-iteration delay. End result: DoS
 * amplifier against a shared `client_id` (429 rate limits for unrelated
 * accounts) plus battery/network drain for the user.
 *
 * Threshold: once we've done {AUTH_REFRESH_MAX_CONSECUTIVE} successful
 * refreshes in a row WITHOUT a single healthy IDLE cycle in between, we
 * treat the next auth error as refresh-failed — skip the handler, emit a
 * typed 'imap.auth_refresh_exhausted' event, and fall through to the
 * ordinary `BACKOFF_MS.auth` sleep path. The cooldown state is left alone:
 * legitimate recoveries still take effect once IMAP accepts a token.
 */
const authRefreshConsecutiveCount = new Map<number, number>()
/** Max consecutive in-loop refreshes before the storm-brake engages. */
const AUTH_REFRESH_MAX_CONSECUTIVE = 3
/**
 * Max connectIdle/mailboxOpen reconnect attempts after a successful token
 * refresh before we declare the reconnect terminal. Each attempt is separated
 * by a class-appropriate BACKOFF_MS sleep. Bounded so a persistent network
 * partition can't pin the IDLE loop inside the inner retry forever — after
 * exhaustion we fall through to a clean outer exit and null `idleLoop` so the
 * next startIdle() call can re-enter (the original H1 regression: a rejected
 * IIFE left idleLoop non-null forever, permanently killing push).
 */
export const AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS = 5

/**
 * Invoke the registered auth-error handler with a per-account cooldown gate.
 *
 * Returns the fresh access token string on success, or `null` on any outcome
 * that should cause the caller to surface the original auth error WITHOUT
 * retrying (no handler registered, in cooldown, or handler rejected).
 *
 * Why a gate: when a refresh token is revoked server-side, Azure/Google
 * return `invalid_grant` on every `/token` call. Without a cooldown, each
 * subsequent IMAP op in a sync cycle fires a fresh refresh request, which
 * tends to trip provider-side `/token` rate limits (HTTP 429) on the shared
 * client_id — affecting legitimate accounts. The gate keeps refresh
 * attempts at roughly one per exponential window (60s → 5m → 30m) per
 * revoked account until a refresh actually succeeds or the user takes
 * action (re-auth clears the entry via the handler success path).
 *
 * Concurrency: the full check-and-invoke sequence (cooldown check →
 * handler invocation → recordRefreshSuccess/Failure) is serialized per
 * accountId via `authRefreshInflight`. Concurrent callers on the same
 * accountId share a single handler invocation and observe identical
 * outcomes; callers on different accountIds run in parallel.
 *
 * Provider identity is used only for the suppression metric tag and is
 * provider-agnostic for the gate itself — outlook and google share the
 * same cooldown semantics.
 */
async function invokeAuthHandlerWithCooldown(
  accountId: number,
  originalAuthError: unknown,
): Promise<string | null> {
  // Single-flight: if another caller is already inside the gate for this
  // accountId, chain onto its result. The second caller returns exactly
  // what the first returns (fresh token, or null on cooldown/failure).
  const pending = authRefreshInflight.get(accountId)
  if (pending) return pending

  const op = (async (): Promise<string | null> => {
    const handler = authErrorHandlers.get(accountId)
    if (!handler) return null

    // Suppression path: within the active cooldown window, skip the
    // handler entirely. Emit a typed, low-cardinality metric so
    // dashboards can tell "we deliberately suppressed a refresh" apart
    // from "we tried and failed".
    if (isInCooldown(accountId)) {
      reportNetEvent('imap.auth_refresh_suppressed', { reason: 'cooldown' })
      return null
    }

    try {
      const freshToken = await handler()
      // Healthy refresh clears cooldown state entirely — next failure
      // starts from zero, which is the correct behaviour when a user
      // reconnects after a revocation.
      recordRefreshSuccess(accountId)
      return freshToken
    } catch (err) {
      // Increment consecutiveFailures so the window grows on sustained
      // revocation; the handler itself is responsible for reporting the
      // specific failure reason (network / refresh_token_expired /
      // unknown).
      recordRefreshFailure(accountId)
      // Surface the ORIGINAL auth error to the caller so downstream UX
      // reasoning (renderer checks for 'invalid_grant', etc.) continues
      // to work — the refresh error itself is not propagated.
      void err
      void originalAuthError
      return null
    }
  })()

  authRefreshInflight.set(accountId, op)
  try {
    return await op
  } finally {
    // Clear only if still pointing to this op — guards against a
    // pathological re-entrant register during the awaiting window.
    if (authRefreshInflight.get(accountId) === op) {
      authRefreshInflight.delete(accountId)
    }
  }
}

/** Test-only: clear the M-1 consecutive-refresh counter. IDLE tests that
 *  reuse an accountId across cases (e.g. the storm-brake suite) would
 *  otherwise inherit a non-zero counter from the previous test and trip the
 *  brake on the first iteration. Not for production callers. */
export function __resetAuthRefreshConsecutiveForTest(): void {
  authRefreshConsecutiveCount.clear()
}

/** Test-only alias for invokeAuthHandlerWithCooldown.
 *
 *  Exists because the single-flight guarantee is observable only by
 *  firing two truly-concurrent calls into the gate. The exported retry
 *  wrappers (`withImapRetry`, `withImapRetryPerAccount`) have their own
 *  op-locks that would mask the concurrency — a direct handle is the
 *  cleanest way to exercise the lock itself without fighting the
 *  wrappers. Not for production callers. */
export const __testInvokeAuthHandlerWithCooldown = invokeAuthHandlerWithCooldown

/** Backoff durations by error class (K-9: IO=5min, auth=60min).
 *
 *  'cert': 6 hours — retries are pointless until the trust anchors change
 *  (user action, AV/proxy reconfiguration, or leaving the intercepting
 *  network), so the backoff is near-permanent but finite: a long-lived IDLE
 *  loop eventually re-probes instead of staying dead forever. Must stay
 *  finite AND below 2^31-1 ms — `sleep(Infinity)` would be clamped by
 *  setTimeout to ~1 ms and turn the backoff into a tight loop ('permanent'
 *  is safe only because every consumer breaks before sleeping on it). */
const BACKOFF_MS: Record<ReturnType<typeof classifyImapError>, number> = {
  network: 5 * 60_000,
  auth: 60 * 60_000,
  cert: 6 * 60 * 60_000,
  permanent: Infinity,
}

/** Check for \\Seen flag (case-insensitive, with/without backslash — both ImapFlow variants) */
function isSeen(flags?: Set<string>): boolean {
  if (!flags) return false
  for (const f of flags) {
    const low = f.toLowerCase()
    if (low === 'seen' || low === '\\seen') return true
  }
  return false
}

/** Check for \\Flagged flag (case-insensitive, with/without backslash — both ImapFlow variants) */
function isFlagged(flags?: Set<string>): boolean {
  if (!flags) return false
  for (const f of flags) {
    const low = f.toLowerCase()
    if (low === 'flagged' || low === '\\flagged') return true
  }
  return false
}

/** Recursive BODYSTRUCTURE traversal — looks for parts with disposition=attachment */
function detectAttachments(bs: unknown): boolean {
  if (!bs || typeof bs !== 'object') return false
  const node = bs as {
    type?: unknown
    subtype?: unknown
    disposition?: unknown
    dispositionParameters?: { filename?: unknown }
    parameters?: { name?: unknown }
    childNodes?: unknown[]
  }

  const disp = typeof node.disposition === 'string' ? node.disposition.toLowerCase() : ''
  const filename =
    (typeof node.dispositionParameters?.filename === 'string' ? node.dispositionParameters.filename : '')
    || (typeof node.parameters?.name === 'string' ? node.parameters.name : '')

  // §2.22 — calendar invite parts (Outlook/Gmail/Apple Calendar) are typically sent without
  // Content-Disposition, but should still surface as attachments so the paperclip icon shows.
  // Layer-pure: only BODYSTRUCTURE inspection — ical.js parsing lives in inviteBridge.
  // Supports both imapflow's combined `type: "text/calendar"` shape and the legacy
  // separate `{ type, subtype }` shape some test fixtures use.
  const rawType = typeof node.type === 'string' ? node.type.toLowerCase() : ''
  const rawSubtype = typeof node.subtype === 'string' ? node.subtype.toLowerCase() : ''
  const combined = rawSubtype ? `${rawType}/${rawSubtype}` : rawType
  if (combined === 'text/calendar' || combined === 'application/ics') return true
  if (combined === 'application/octet-stream' && /\.ics$/i.test(filename.trim())) return true

  // Inline parts can be "embedded" (cid images) and should not count as attachments for paperclip.
  // However, inline with filename (rare) is usually a real attachment.
  if (disp === 'attachment') return true
  if (disp === 'inline' && filename.trim()) return true
  if (Array.isArray(node.childNodes)) {
    return node.childNodes.some(child => detectAttachments(child))
  }
  return false
}

/** @internal — test-only escape hatch; not part of the public API. */
export const __testDetectAttachments = detectAttachments

/** Collect all attachment filenames from BODYSTRUCTURE (for search indexing). */
export function collectAttachmentFilenames(bs: unknown): string[] {
  const names: string[] = []
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    const n = node as {
      disposition?: unknown
      dispositionParameters?: { filename?: unknown }
      parameters?: { name?: unknown }
      childNodes?: unknown[]
    }
    const disp = typeof n.disposition === 'string' ? n.disposition.toLowerCase() : ''
    const filename =
      (typeof n.dispositionParameters?.filename === 'string' ? n.dispositionParameters.filename : '')
      || (typeof n.parameters?.name === 'string' ? n.parameters.name : '')
    if (filename.trim() && (disp === 'attachment' || (disp === 'inline' && filename.trim()))) {
      names.push(filename.trim())
    }
    if (Array.isArray(n.childNodes)) {
      for (const child of n.childNodes) walk(child)
    }
  }
  walk(bs)
  return names
}

function normalizeReferences(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    const vals = raw
      .map(v => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
    return vals.length > 0 ? vals.join(' ') : undefined
  }
  if (typeof raw === 'string') {
    const v = raw.trim()
    return v || undefined
  }
  return undefined
}

/** Extracts the References header from IMAP BODY.PEEK[HEADER.FIELDS (REFERENCES)]. */
export function extractReferencesHeader(buf: Buffer | undefined): string | undefined {
  if (!buf) return undefined
  const raw = buf.toString('utf8')
  const lines = raw.split(/\r?\n/)
  let result = ''
  let collecting = false
  for (const line of lines) {
    if (/^references:/i.test(line)) {
      collecting = true
      result = line.replace(/^references:\s*/i, '')
    } else if (collecting && /^[ \t]/.test(line)) {
      result += ' ' + line.trim()
    } else if (collecting) {
      break
    }
  }
  return result.trim() || undefined
}

/** Wrapper with retry on IMAP connection loss (NoConnection / not usable).
 *  2 retries with 1s delay between attempts (handles transient Wi-Fi drops).
 *
 *  Auth-error handling: if the error is classified as 'auth' and an
 *  `onAuthError` handler is registered for this account (via
 *  `registerAuthErrorHandler`), the handler is invoked to obtain a fresh
 *  access token. The config is patched, the connection is reset, and the
 *  operation is retried exactly once. If the retry also produces an auth
 *  error, it is thrown without further attempts (prevents infinite loops
 *  when the refresh token itself is expired/revoked). */
export async function withImapRetry<T>(accountId: number, cfg: ImapConfig, fn: () => Promise<T>, retries = 2): Promise<T> {
  return withImapOpLock(async () => {
    let remaining = retries
    let authRetryUsed = false
    for (;;) {
      try {
        return await fn()
      } catch (e: unknown) {
        const errClass = classifyImapError(e)

        // Cert error path: retrying cannot succeed until the trust anchors
        // change. Notify the main-process subscriber (fire-and-forget) and
        // rethrow immediately — no connection-loss retry, no token refresh.
        if (errClass === 'cert') {
          notifyCertError(accountId, cfg, e)
          throw e
        }

        // Auth error path: attempt token refresh exactly once via registered handler.
        // The cooldown gate inside invokeAuthHandlerWithCooldown prevents
        // request storms against Azure/Google `/token` when the refresh
        // token itself is revoked.
        if (errClass === 'auth' && !authRetryUsed) {
          authRetryUsed = true
          const freshToken = await invokeAuthHandlerWithCooldown(accountId, e)
          if (freshToken !== null) {
            // Patch config with refreshed token for reconnection.
            cfg.accessToken = freshToken
            // Reset singleton so connectImap picks up the new token.
            stopNoopHeartbeat()
            if (client) { try { await client.logout() } catch { /* ignore */ } }
            client = null
            currentUserKey = null
            connecting = null
            await connectImap(cfg)
            continue
          }
          // No handler, cooldown active, or refresh rejected — fall through
          // to throw the original auth error.
          throw e
        }

        const msg = e instanceof Error ? e.message : String(e)
        // 'Unexpected close' is thrown by ImapFlow on abrupt socket closure
        // (§2.20-E regression). It is intentionally added as a separate
        // alternative — broadening to /close/i would also match benign
        // messages like "connection closed gracefully".
        const isConnectionLost = /NoConnection|not usable|Unexpected close|closed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|ECONNABORTED/i.test(msg)
        if (!isConnectionLost || remaining <= 0) throw e
        remaining -= 1

        // Reset singleton — the next connectImap() will create a new connection.
        stopNoopHeartbeat()
        if (client) { try { await client.logout() } catch { /* ignore */ } }
        client = null
        currentUserKey = null
        connecting = null
        await sleep(1000)
        await connectImap(cfg)
      }
    }
  })
}

function userKey(cfg: ImapConfig) {
  const pins = (cfg.tlsPinsSha256 || []).map(normalizeFingerprintSha256).sort().join('|') || 'no-pin'
  return `${cfg.user}@${cfg.host}:${cfg.port}:${cfg.secure ? 'tls' : 'starttls'}:${pins}`
}

function formatImapError(e: unknown): string {
  const err = e instanceof Error ? e : new Error(String(e))
  const anyErr = err as unknown as { responseStatus?: unknown; responseText?: unknown; code?: unknown }
  const parts: string[] = [err.message]
  if (typeof anyErr.responseStatus === 'string') parts.push(anyErr.responseStatus)
  if (typeof anyErr.responseText === 'string') parts.push(anyErr.responseText)
  if (typeof anyErr.code === 'string') parts.push(anyErr.code)
  return parts.filter(Boolean).join(': ')
}

export async function connectImap(cfg: ImapConfig) {
  const ukey = userKey(cfg)
  if (client && currentUserKey === ukey && client.usable) return client
  // If a parallel connect() is already in progress for this account — just wait for it.
  if (connecting && currentUserKey === ukey) return connecting
  // If connect() is in progress for a different account, wait for completion to avoid breaking the shared singleton client.
  if (connecting) {
    try { await connecting } catch { /* ignore: will try to reconnect below */ }
    if (client && currentUserKey === ukey && client.usable) return client
    if (connecting && currentUserKey === ukey) return connecting
  }

  if (client) { try { await client.logout() } catch { /* connection already closed */ } client = null }
  const c = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.accessToken
      ? { user: cfg.user, accessToken: cfg.accessToken }
      : { user: cfg.user, pass: cfg.pass || '' },
    tls: buildTlsOptions(cfg),
    logger: silentLogger,
    socketTimeout: 30_000,
  })
  applySocketOptions(c)
  // Suppress uncaught 'error' event (e.g. Socket timeout) — reconnection happens on next request.
  c.on('error', (err: Error) => { console.warn('[IMAP] Connection error:', err.message) })
  currentUserKey = ukey

  const p = (async () => {
    try {
      await c.connect()
      // Assign client only after successful connect, so intermediate calls don't get an unconnected instance.
      client = c
      startNoopHeartbeat()
      return c
    } catch (e) {
      if (currentUserKey === ukey) {
        client = null
        currentUserKey = null
      }
      throw e
    }
  })()

  connecting = p
  try {
    return await p
  } finally {
    if (connecting === p) connecting = null
  }
}

/** Force-close the singleton IMAP connection (e.g. after a timeout to clear stale state). */
export function forceDisconnectImap() {
  stopNoopHeartbeat()
  if (client) {
    try { client.close() } catch { /* ignore */ }
    client = null
    currentUserKey = null
  }
}

async function connectIdle(cfg: ImapConfig) {
  const ukey = userKey(cfg)
  if (idleClient && idleUserKey === ukey && idleClient.usable) return idleClient

  // Close the previous idle connection (if any).
  if (idleClient) {
    try {
      if (idleExistsHandler) idleClient.removeListener('exists', idleExistsHandler)
    } catch { /* ignore */ }
    try { await idleClient.logout() } catch { /* ignore */ }
    idleClient = null
    idleUserKey = null
    idleMailbox = null
    idleExistsHandler = null
    idleLoop = null
  }

  const c = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.accessToken
      ? { user: cfg.user, accessToken: cfg.accessToken }
      : { user: cfg.user, pass: cfg.pass || '' },
    tls: buildTlsOptions(cfg),
    logger: silentLogger,
    // IDLE is managed manually in a loop, so we disable auto-idle to avoid unexpected states.
    disableAutoIdle: true,
  })
  applySocketOptions(c)
  // Suppress uncaught 'error' event (Socket timeout, etc.) — IDLE loop will reconnect on its own.
  c.on('error', (err: Error) => { console.warn('[IMAP IDLE] Connection error:', err.message) })
  idleUserKey = ukey
  await c.connect()
  idleClient = c
  return c
}

export async function startIdle(
  accountId: number,
  cfg: ImapConfig,
  mailbox: string,
  onExists: (data: ExistsEvent) => void,
): Promise<void> {
  // Local reference to the active IDLE client. Re-bound after a successful
  // in-loop auth refresh + reconnect so the while-condition keeps tracking
  // the live connection instead of pinning to a stale handle.
  //
  // The initial connect/select prologue is cert-classified too: a TLS trust
  // failure here used to propagate to the caller unclassified, so IDLE never
  // started and the main process was never told WHY (no interception banner,
  // no recovery UX — the account just looked silently offline).
  let c: ImapFlow
  try {
    c = await connectIdle(cfg)
    idleStop = false

    if (idleMailbox !== mailbox) {
      await c.mailboxOpen(mailbox)
      idleMailbox = mailbox
    }
  } catch (e) {
    if (classifyImapError(e) === 'cert') notifyCertError(accountId, cfg, e)
    throw e
  }

  if (idleExistsHandler) {
    try { c.removeListener('exists', idleExistsHandler) } catch { /* ignore */ }
  }
  idleExistsHandler = (data: ExistsEvent) => {
    if (idleStop) return
    onExists(data)
  }
  c.on('exists', idleExistsHandler)

  if (!idleLoop) {
    // Captured-in-closure sentinel for the finally-block identity check
    // below. Without this, a concurrent startIdle() that starts a newer
    // loop during our teardown could have its idleLoop reference clobbered
    // to null by our exiting loop's finally. The identity compare ensures
    // we only null the global when it still points at *our* Promise.
    let ownLoopPromise: Promise<void> | null = null
    ownLoopPromise = (async () => {
      // Keep IDLE running continuously with 24-min refresh cycle (K-9 Mail pattern).
      // RFC 2177: servers may drop IDLE after 29 min; we re-issue at 24 min to stay safe.
      // Differentiated backoff by error type (K-9: IO=5min, auth=60min).
      //
      // CRITICAL: any path that exits this while-loop MUST allow the outer
      // `idleLoop` global to reset to null so a subsequent startIdle() call
      // can re-enter. stopIdle() already nulls it before awaiting the loop;
      // for non-stopIdle exits (terminal reconnect failure, permanent class
      // during a normal cycle, while-condition drop after client goes stale)
      // the `finally` at the bottom of the IIFE carries the burden. Without
      // this, a resolved-Promise idleLoop pins future startIdle() into the
      // `if (!idleLoop)` false branch and IDLE stays dead until app restart.
      try {
      while (!idleStop && idleClient === c && c.usable) {
        // Telemetry: one span per IDLE cycle (enter → exit). Exit reasons are
        // classified into a small enum so dashboards can tell a graceful refresh
        // from a network/auth failure without leaking any mailbox content.
        const __idleCycleStart = Date.now()
        const __idleSpan = startNetSpan('imap.idle', {
          folder_role: folderRoleFromPath(mailbox),
          provider: providerFromHost(cfg.host),
        })
        let __exitReason: 'refresh' | 'stopped' | 'network' | 'auth' | 'cert' | 'auth_refreshed' | 'auth_refresh_exhausted' | 'auth_refresh_reconnect_failed_terminal' | 'permanent' = 'refresh'
        try {
          // K-9 Mail pattern (RealImapFolderIdler.kt:118): timer fires DONE to break IDLE,
          // waits for IDLE to finish, then re-issues. We achieve this by racing idle() against
          // a sleep timer, then sending NOOP to trigger ImapFlow's preCheck() → DONE sequence.
          // ImapFlow queues DONE when any command is issued during IDLE (imap-flow.js:preCheck).
          let timedOut = false
          await Promise.race([
            c.idle(),
            sleep(IDLE_REFRESH_MS).then(() => { timedOut = true }),
          ])
          // If sleep won the race, IDLE is still active — send NOOP to trigger DONE.
          // This makes ImapFlow send DONE, wait for server OK, then execute NOOP.
          if (timedOut && !idleStop && c.usable) {
            try { await c.noop() } catch { /* ignore — connection may have dropped */ }
          }
          // Healthy IDLE cycle parked without throwing → the fresh token
          // actually delivered push. Clear the consecutive-refresh counter so
          // a later auth expiry starts from zero rather than inheriting an
          // old streak (M-1 storm-brake reset point).
          authRefreshConsecutiveCount.delete(accountId)
          __exitReason = idleStop ? 'stopped' : 'refresh'
        } catch (err) {
          if (idleStop) {
            __exitReason = 'stopped'
            __idleSpan.setAttributes?.({
              exit_reason: __exitReason,
              duration_bucket: bucketIdleDuration(Date.now() - __idleCycleStart),
            })
            __idleSpan.end()
            break
          }
          const errClass = classifyImapError(err)
          // Auth error path: invoke the registered refresh handler BEFORE any
          // backoff sleep. On success we patch cfg.accessToken, tear down the
          // dead IDLE client, reconnect with the fresh token, re-open the
          // mailbox, and continue the loop without the 60-min auth backoff —
          // the user keeps push delivery across an OAuth token expiry.
          //
          // The cooldown/single-flight semantics live inside
          // invokeAuthHandlerWithCooldown: no handler, in-cooldown, or a
          // failed refresh all return null and we fall through to the
          // existing BACKOFF_MS.auth sleep path (storm protection intact).
          if (errClass === 'auth') {
            // M-1 storm-brake: if the IDLE loop has chained
            // AUTH_REFRESH_MAX_CONSECUTIVE refreshes without ever parking a
            // healthy IDLE cycle in between, the provider is minting fresh
            // tokens but IMAP keeps rejecting them (conditional-access, per-
            // mailbox MFA, admin-revoked-at-IMAP-side, clock skew, etc.).
            // §2.2-D cooldown does not engage because refresh itself is
            // succeeding — so skip the handler here, emit a typed exhausted
            // event, and fall through to the ordinary BACKOFF_MS.auth sleep
            // path. Prevents a tight loop hammering /token and IMAP auth.
            const consecutive = authRefreshConsecutiveCount.get(accountId) ?? 0
            if (consecutive >= AUTH_REFRESH_MAX_CONSECUTIVE) {
              __exitReason = 'auth_refresh_exhausted'
              __idleSpan.setAttributes?.({
                exit_reason: __exitReason,
                duration_bucket: bucketIdleDuration(Date.now() - __idleCycleStart),
              })
              __idleSpan.end()
              console.warn(
                `[IMAP IDLE] auth refresh exhausted after ${consecutive} consecutive refreshes — falling back to auth backoff`,
              )
              reportNetError('imap.idle', err, {
                provider: providerFromHost(cfg.host),
                folder_role: folderRoleFromPath(mailbox),
                exit_reason: 'auth_refresh_exhausted',
                consecutive,
              })
              reportNetEvent('imap.auth_refresh_exhausted', {
                provider: providerFromHost(cfg.host),
                consecutive,
              })
              await sleep(BACKOFF_MS.auth)
              continue
            }
            const freshToken = await invokeAuthHandlerWithCooldown(accountId, err)
            if (freshToken !== null) {
              // stopIdle() race: if a stop was requested while the refresh
              // handler was in flight, bail out here. stopIdle's own teardown
              // has already captured+logged out the old client; creating a
              // new one now would leak (orphan socket not referenced by any
              // global, nothing will close it). End the span and break the
              // while loop so the IIFE resolves cleanly.
              if (idleStop) {
                __exitReason = 'stopped'
                __idleSpan.setAttributes?.({
                  exit_reason: __exitReason,
                  duration_bucket: bucketIdleDuration(Date.now() - __idleCycleStart),
                })
                __idleSpan.end()
                break
              }
              cfg.accessToken = freshToken
              // Reuse the connectIdle teardown idiom: drop the exists
              // listener from the dead client before logout, then null the
              // idle globals so connectIdle can build a fresh connection.
              try {
                if (idleExistsHandler) c.removeListener('exists', idleExistsHandler)
              } catch { /* ignore */ }
              try { await c.logout() } catch { /* ignore — already dead */ }
              idleClient = null
              idleUserKey = null
              idleMailbox = null
              idleExistsHandler = null
              // Rebuild the IDLE connection + mailbox + exists listener.
              //
              // Inner bounded retry loop. The earlier single-attempt design
              // had a subtle but fatal regression (Codex round-2 H1): if
              // connectIdle rejected, the catch ran sleep+continue, but the
              // outer while-condition `idleClient === c && c.usable` was
              // false (idleClient had been nulled during teardown, `c` still
              // pointed at the logged-out old client — reassignment to the
              // new client never happened because connectIdle rejected
              // before it). The while-loop exited cleanly, the IIFE resolved
              // as a Promise<void>, but `idleLoop` was still the non-null
              // resolved Promise — future startIdle() saw `if (!idleLoop)`
              // false and skipped re-entry. IDLE dead until app restart.
              //
              // Fix: retry connectIdle+mailboxOpen+listener as its own
              // bounded loop here. On success we fall through with `c`
              // properly reassigned so the outer while guard tracks the
              // live client. On terminal failure (permanent class OR
              // attempts exhausted) we break cleanly AND null idleLoop in
              // the IIFE's finally so the next startIdle() re-enters.
              let reconnectSucceeded = false
              let lastReconnectErr: unknown = null
              for (
                let reconnectAttempt = 1;
                reconnectAttempt <= AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS;
                reconnectAttempt++
              ) {
                if (idleStop) break
                try {
                  c = await connectIdle(cfg)
                  if (idleStop) {
                    // stopIdle race: between logout of old client and
                    // listener attach on new one. Logout the fresh client
                    // so we don't leak; outer break handles the rest.
                    try { await c.logout() } catch { /* ignore */ }
                    break
                  }
                  await c.mailboxOpen(mailbox)
                  idleMailbox = mailbox
                  idleExistsHandler = (data: ExistsEvent) => {
                    if (idleStop) return
                    onExists(data)
                  }
                  c.on('exists', idleExistsHandler)
                  idleClient = c
                  reconnectSucceeded = true
                  break
                } catch (reconnectErr) {
                  lastReconnectErr = reconnectErr
                  const reconnectClass = classifyImapError(reconnectErr)
                  console.warn(
                    `[IMAP IDLE] reconnect after auth refresh failed (attempt ${reconnectAttempt}/${AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS}, ${reconnectClass}):`,
                    reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr),
                  )
                  reportNetError('imap.idle', reconnectErr, {
                    provider: providerFromHost(cfg.host),
                    folder_role: folderRoleFromPath(mailbox),
                    exit_reason: 'auth_refresh_reconnect_failed',
                    attempt: reconnectAttempt,
                  })
                  // Permanent and cert errors never improve with retry (auth
                  // stays rejected, TLS trust stays broken). Bail out now —
                  // sleeping the 6h cert backoff INSIDE this bounded reconnect
                  // loop would pin the IDLE IIFE for days. Cert failures also
                  // notify the main process before bailing: this exit used to
                  // be silent, so an interception that appeared during an
                  // OAuth-refresh reconnect killed IDLE with no UX signal.
                  if (reconnectClass === 'cert') {
                    notifyCertError(accountId, cfg, reconnectErr)
                    break
                  }
                  if (reconnectClass === 'permanent') break
                  // Attempts exhausted — also terminal.
                  if (reconnectAttempt >= AUTH_REFRESH_MAX_RECONNECT_ATTEMPTS) break
                  // Transient (network/auth): sleep the class-appropriate
                  // backoff and retry. We don't sleep after the final
                  // attempt — the terminal branch above already fired.
                  await sleep(BACKOFF_MS[reconnectClass])
                }
              }
              if (reconnectSucceeded) {
                // M-1 storm-brake: bump the per-accountId consecutive-refresh
                // counter. Reset happens only when the NEXT idle() call parks
                // cleanly (see above, just after Promise.race resolves). If
                // the fresh token is also rejected immediately, this counter
                // grows until AUTH_REFRESH_MAX_CONSECUTIVE trips the brake.
                authRefreshConsecutiveCount.set(
                  accountId,
                  (authRefreshConsecutiveCount.get(accountId) ?? 0) + 1,
                )
                __exitReason = 'auth_refreshed'
                __idleSpan.setAttributes?.({
                  exit_reason: __exitReason,
                  duration_bucket: bucketIdleDuration(Date.now() - __idleCycleStart),
                })
                __idleSpan.end()
                reportNetEvent('imap.idle_auth_refreshed', {
                  provider: providerFromHost(cfg.host),
                })
                // Skip BACKOFF_MS.auth sleep — IDLE resumes immediately.
                continue
              }
              // Reconnect did NOT succeed. Two paths landed here:
              //   1. idleStop was observed mid-retry → exit as 'stopped'.
              //   2. permanent class OR attempts exhausted → exit as
              //      'auth_refresh_reconnect_failed_terminal'.
              if (idleStop) {
                __exitReason = 'stopped'
                __idleSpan.setAttributes?.({
                  exit_reason: __exitReason,
                  duration_bucket: bucketIdleDuration(Date.now() - __idleCycleStart),
                })
                __idleSpan.end()
                break
              }
              // Terminal reconnect failure. Emit a distinct exit_reason so
              // dashboards can tell a single-attempt transient drop apart
              // from an exhausted retry burst. Break the outer while; the
              // IIFE's finally block will null idleLoop so the next
              // startIdle() invocation is free to re-enter.
              __exitReason = 'auth_refresh_reconnect_failed_terminal'
              __idleSpan.setAttributes?.({
                exit_reason: __exitReason,
                duration_bucket: bucketIdleDuration(Date.now() - __idleCycleStart),
              })
              __idleSpan.end()
              console.warn(
                `[IMAP IDLE] reconnect after auth refresh terminal — IDLE loop exiting cleanly, next startIdle() will re-enter`,
              )
              if (lastReconnectErr) {
                reportNetError('imap.idle', lastReconnectErr, {
                  provider: providerFromHost(cfg.host),
                  folder_role: folderRoleFromPath(mailbox),
                  exit_reason: 'auth_refresh_reconnect_failed_terminal',
                })
              }
              break
            }
          }
          __exitReason = errClass
          __idleSpan.setAttributes?.({
            exit_reason: __exitReason,
            duration_bucket: bucketIdleDuration(Date.now() - __idleCycleStart),
          })
          __idleSpan.end()
          // Local diagnostics + Sentry capture for expected IDLE failure modes.
          // packages/net has no createLogger, so console is the local sink here.
          console.warn(`[IMAP IDLE] cycle failed (${errClass}):`, err instanceof Error ? err.message : String(err))
          reportNetError('imap.idle', err, {
            provider: providerFromHost(cfg.host),
            folder_role: folderRoleFromPath(mailbox),
            exit_reason: errClass,
          })
          if (errClass === 'permanent') break
          // Cert failures: notify the main process ONCE and exit the loop
          // cleanly. Sleeping BACKOFF_MS.cert (6h) inside the loop was doubly
          // wrong — the trust failure was never reported (no interception
          // banner, no recovery UX), and stopIdle() had to wait for a
          // six-hour sleep to wake up before teardown could proceed. The
          // IIFE's finally nulls idleLoop, so a later startIdle() (after the
          // user fixes trust) re-enters normally.
          if (errClass === 'cert') {
            notifyCertError(accountId, cfg, err)
            break
          }
          await sleep(BACKOFF_MS[errClass])
          continue
        }
        __idleSpan.setAttributes?.({
          exit_reason: __exitReason,
          duration_bucket: bucketIdleDuration(Date.now() - __idleCycleStart),
        })
        __idleSpan.end()
      }
      } finally {
        // Clear the global so a subsequent startIdle() call can re-enter
        // the `if (!idleLoop)` guard and build a fresh IIFE. See the long
        // comment at the top of this try-block for why this is load-
        // bearing. stopIdle() may have already nulled it (it does so
        // before awaiting the loop) — idempotent either way. The reset
        // is placed inside the IIFE so it fires regardless of exit path:
        // clean break, terminal reconnect failure, permanent error, or
        // an unexpected throw from anything inside the while-loop.
        //
        // Identity check: only null idleLoop if it still points at the
        // Promise we installed. Protects against a racy path where
        // stopIdle() nulled it and a newer startIdle() installed a fresh
        // IIFE before our teardown finished — we must not clobber that
        // newer loop.
        if (idleLoop === ownLoopPromise) {
          idleLoop = null
        }
      }
    })()
    idleLoop = ownLoopPromise
  }
}

export async function stopIdle(): Promise<void> {
  idleStop = true
  const c = idleClient
  const loop = idleLoop

  idleClient = null
  idleUserKey = null
  idleMailbox = null
  idleLoop = null

  if (c) {
    try {
      if (idleExistsHandler) c.removeListener('exists', idleExistsHandler)
    } catch { /* ignore */ }
    idleExistsHandler = null
    try { await c.logout() } catch { /* ignore */ }
  } else {
    idleExistsHandler = null
  }

  // Wait for the background loop to finish before exiting.
  try { await loop } catch { /* ignore */ }
}

/** Returns true if there is an active IDLE connection. */
export function isIdleActive(): boolean {
  return idleClient !== null && !idleStop && idleClient.usable
}

export async function testImapConnection(cfg: ImapConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const c = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.accessToken
        ? { user: cfg.user, accessToken: cfg.accessToken }
        : { user: cfg.user, pass: cfg.pass || '' },
      tls: buildTlsOptions(cfg),
      logger: silentLogger,
    })
    await c.connect()
    await c.logout()
    return { ok: true }
  } catch (e: unknown) {
    const message = formatImapError(e)
    return { ok: false, error: message }
  }
}

export async function listMailboxes(accountId: number, cfg: ImapConfig): Promise<Mailbox[]> {
  return withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    // Some servers may not support LIST-STATUS, so we try it first,
    // and on error fall back to a plain LIST without unread counts.
    const listed = await (async () => {
      try {
        return await c.list({ statusQuery: { unseen: true } })
      } catch {
        return await c.list()
      }
    })()
    return listed
      // Exclude container folders with the \Noselect flag (e.g. [Gmail]) —
      // they don't contain messages and cannot be opened (SELECT).
      .filter(box => !(box.flags as Set<string>)?.has('\\Noselect'))
      .map((box) => ({
        path: box.path as string,
        name: box.name as string,
        specialUse: (box.specialUse as string) || null,
        unread: (box.status as { unseen?: number } | undefined)?.unseen ?? undefined,
      }))
  })
}

/** Load latest messages from a folder (delegates to fetchFolderSummariesPage). */
export async function fetchInboxSummaries(cfg: ImapConfig, folder = 'INBOX', limit = 50, accountId = 1, skipBodyStructure = false): Promise<MailSummary[]> {
  return fetchFolderSummariesPage(cfg, folder, limit, undefined, accountId, skipBodyStructure)
}

/** Returns the number of messages, highestModseq and uidValidity in a folder without fetching any data. */
export async function getMailboxStatus(accountId: number, cfg: ImapConfig, folder: string): Promise<{ exists: number; highestModseq: string | null; uidValidity: number | null }> {
  return withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    const mailbox = await c.mailboxOpen(folder)
    const exists = typeof mailbox.exists === 'number' ? mailbox.exists : 0
    const modseq = mailbox.highestModseq ? String(mailbox.highestModseq) : null
    const uidValidity = typeof mailbox.uidValidity === 'number' ? mailbox.uidValidity : null
    return { exists, highestModseq: modseq, uidValidity }
  })
}

/** Returns the number of messages in a folder (mailbox.exists) without fetching any data. */
export async function getMailboxMessageCount(accountId: number, cfg: ImapConfig, folder: string): Promise<number> {
  const status = await getMailboxStatus(accountId, cfg, folder)
  return status.exists
}

/** Create a dedicated IMAP connection — not from any pool, no lock chain.
 *  Used by sync functions to avoid deadlocking with body indexer, IDLE, or message open. */
async function createDedicatedConnection(cfg: ImapConfig): Promise<ImapFlow> {
  const c = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure !== false,
    auth: cfg.accessToken
      ? { user: cfg.user, accessToken: cfg.accessToken }
      : { user: cfg.user, pass: cfg.pass! },
    tls: buildTlsOptions(cfg),
    socketTimeout: 30_000,
    logger: false,
    disableAutoIdle: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  applySocketOptions(c)
  c.on('error', () => {})
  await c.connect()
  return c
}

/** Execute a short-lived IMAP operation on its own connection with retry on transient disconnects.
 *  Supports auth-error recovery via the registered onAuthError handler (same as withImapRetry). */
async function withDedicatedImapRetry<T>(
  accountId: number,
  cfg: ImapConfig,
  fn: (c: ImapFlow) => Promise<T>,
  retries = 2,
): Promise<T> {
  let remaining = retries
  let authRetryUsed = false
  for (;;) {
    let c: ImapFlow | null = null
    try {
      c = await createDedicatedConnection(cfg)
      return await fn(c)
    } catch (e: unknown) {
      const errClass = classifyImapError(e)

      // Cert error path: notify the main-process subscriber and rethrow —
      // retrying a trust failure is pointless (see withImapRetry).
      if (errClass === 'cert') {
        notifyCertError(accountId, cfg, e)
        throw e
      }

      // Auth error path: attempt token refresh exactly once, gated by
      // per-account cooldown to avoid hammering Azure/Google `/token`.
      if (errClass === 'auth' && !authRetryUsed) {
        authRetryUsed = true
        const freshToken = await invokeAuthHandlerWithCooldown(accountId, e)
        if (freshToken !== null) {
          cfg.accessToken = freshToken
          continue
        }
        throw e
      }

      const msg = e instanceof Error ? e.message : String(e)
      // §2.20-E: keep classifier in sync with withImapRetry (imap.ts:~534).
      const isConnectionLost = /NoConnection|not usable|Unexpected close|closed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|ECONNABORTED/i.test(msg)
      if (!isConnectionLost || remaining <= 0) throw e
      remaining -= 1
      await sleep(1000)
    } finally {
      if (c) try { await c.logout() } catch { /* ignore */ }
    }
  }
}

/**
 * Fetch ALL headers from a folder using batched UID FETCH commands.
 * Following K-9 Mail / Thunderbird pattern: fetch in windows of FETCH_WINDOW_SIZE UIDs
 * instead of a single `UID FETCH 1:*` which can stall on servers like Yandex.
 *
 * @param onBatch called after every `batchSize` messages are collected (for progress + DB upsert).
 * @param sinceUid if provided, only fetch UID > sinceUid (incremental sync for new messages).
 */
export async function fetchAllFolderHeaders(
  cfg: ImapConfig,
  folder: string,
  accountId: number,
  onBatch: (messages: MailSummary[], totalFetched: number) => void,
  options?: {
    sinceUid?: number
    /** Partial-crawl signal. Presence disables the CONDSTORE CHANGEDSINCE
     *  optimisation so the FLAGS scan returns the full server UID set — a
     *  covered_recent resume must see every UID to detect gap UIDs both
     *  above and below the prior watermark (see §newUids filter). The
     *  numeric value itself is no longer used to narrow the header-fetch
     *  set: gap UIDs above the watermark are legitimate targets after a
     *  partial cache wipe, and `localUidSet.has(uid)` already filters
     *  anything already cached. */
    beforeUid?: number
    batchSize?: number
    /** CONDSTORE: if provided and server supports it, only fetch messages changed since this modseq. */
    knownModseq?: string
    /** UIDVALIDITY from last sync — if changed, forces full resync. */
    knownUidValidity?: number
  },
): Promise<{ fetched: number; highestModseq: string | null; uidValidity: number | null; exists: number; skipped?: boolean }> {
  // Telemetry: wrap the entire sync in a performance span so dashboards
  // can track FETCH/CONDSTORE batch latency per (folder_role, provider)
  // without any content leaking into span attributes. The span survives
  // both the CONDSTORE fast-path (skipped:true) and the full FETCH path.
  const __syncInitialAttrs = {
    folder_role: folderRoleFromPath(folder),
    provider: providerFromHost(cfg.host),
    changed_since_present: Boolean(options?.knownModseq),
  }
  return withNetSpan('imap.sync', __syncInitialAttrs, async () => {
  // Route through withDedicatedImapRetry so that OAuth token refresh
  // (via the registered onAuthError handler) works on the initial connect.
  // withDedicatedImapRetry handles connection creation, auth-retry, cleanup.
  //
  // §2.24 PR1: per-account periodic sync opens exactly one dedicated sync
  // connection per account (withDedicatedImapRetry creates one connection
  // per call). Accounts run concurrently, but each account's folders stay
  // strictly sequential, so there is no per-account connection storm.
  return withDedicatedImapRetry(accountId, cfg, async (c) => {
    const mailbox = await c.mailboxOpen(folder)
    const total = typeof mailbox.exists === 'number' ? mailbox.exists : 0
    const highestModseq = mailbox.highestModseq ? String(mailbox.highestModseq) : null
    const uidValidity = typeof mailbox.uidValidity === 'number' ? mailbox.uidValidity : null

    // UIDVALIDITY check — if changed, server reassigned UIDs, local cache is invalid.
    // Drop ALL cursors (Thunderbird pattern: drop all state and rebuild from scratch).
    if (options?.knownUidValidity && uidValidity && uidValidity !== options.knownUidValidity) {
      try { removeStaleMessages(accountId, folder, [], { reason: 'uidvalidity_bump' }) } catch { /* non-critical */ }
      options = { ...options, sinceUid: undefined, beforeUid: undefined, knownModseq: undefined }
    }

    // Strict empty-folder guard (2026-04-21 P0 data-loss regression).
    // Previously: `const total = typeof mailbox.exists === 'number' ? mailbox.exists : 0`
    // followed by `if (total <= 0) removeStaleMessages([], ...)` meant that any
    // IMAP response where `mailbox.exists` was missing/undefined silently wiped
    // the entire folder cache. ImapFlow has been observed returning undefined
    // on some providers under transient socket conditions (Yandex IPv6 ETIMEDOUT
    // in the triggering user trace). We now DEMAND a numeric zero from the
    // server — anything else is logged and skipped, preserving local data.
    if (typeof mailbox.exists === 'number' && mailbox.exists === 0) {
      try {
        removeStaleMessages(accountId, folder, [], { reason: 'server_empty' })
      } catch { /* non-critical */ }
      return { fetched: 0, highestModseq, uidValidity, exists: 0 }
    }
    if (typeof mailbox.exists !== 'number') {
      // mailbox.exists === undefined → ambiguous server response. Refuse to
      // mass-delete; surface through telemetry so we can see how often this
      // happens in the wild. Returning 'skipped' keeps the caller from
      // updating folder_crawl_state with bogus zeros.
      console.warn(
        `[IMAP sync] mailbox.exists is not a number (${typeof mailbox.exists}) — ` +
        `refusing to purge folder cache. stale_wipe_guard tripped on ` +
        `${folderRoleFromPath(folder)} acc=${accountId}`
      )
      reportNetError('imap.sync', new Error('mailbox.exists_not_numeric'), {
        folder_role: folderRoleFromPath(folder),
        provider: providerFromHost(cfg.host),
      })
      reportNetEvent('imap.stale_wipe_guard_tripped', {
        folder_role: folderRoleFromPath(folder),
        provider: providerFromHost(cfg.host),
      })
      return { fetched: 0, highestModseq, uidValidity, exists: 0, skipped: true }
    }
    if (total <= 0) {
      // Defensive catch-all (negative totals from a buggy server). Same
      // reasoning as undefined — don't mass-delete on ambiguous input.
      console.warn(
        `[IMAP sync] mailbox.exists is negative (${total}) — ` +
        `refusing to purge folder cache. stale_wipe_guard tripped`
      )
      return { fetched: 0, highestModseq, uidValidity, exists: total, skipped: true }
    }

    // CONDSTORE: if modseq hasn't changed since last sync — nothing to do (zero traffic).
    // Exceptions that force a full re-fetch despite same modseq:
    // 1. Local cache is empty but server has messages — cache was corrupted/purged.
    // 2. Server EXISTS < local count — expunge happened (modseq doesn't always bump on expunge).
    let knownModseq = options?.knownModseq
    if (knownModseq && highestModseq && knownModseq === highestModseq) {
      const localCount = getAccountMessageCount(accountId, folder)
      if (localCount === 0 && total > 0) {
        // Cache empty but server has messages — fall through to full sync (don't skip).
        // Drop all cursors so we rebuild from scratch (Thunderbird pattern).
        knownModseq = undefined
        options = { ...options, sinceUid: undefined, beforeUid: undefined }
      } else {
        if (total !== localCount) {
          // Mismatch: either expunge or expunge+add happened despite same modseq — reconcile UIDs
          try {
            const fullServerUids = new Set<number>()
            for await (const msg of c!.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
              fullServerUids.add(msg.uid as number)
            }
            const localUids = getFolderUids(accountId, folder)
            const staleUids = localUids.filter(uid => !fullServerUids.has(uid))
            if (staleUids.length > 0) {
              removeStaleMessagesByUids(accountId, folder, staleUids)
            }
          } catch { /* non-critical */ }
        }
        return { fetched: 0, highestModseq, uidValidity, exists: total, skipped: true }
      }
    }

    const batchSize = options?.batchSize ?? 500
    const sinceUid = options?.sinceUid
    const beforeUid = options?.beforeUid

    // CONDSTORE with CHANGEDSINCE (Thunderbird: nsImapProtocol.cpp:4261-4267):
    // UID FETCH 1:* (FLAGS) (CHANGEDSINCE modseq) — server returns only changed messages.
    // Safe with sinceUid (FLAGS range is always 1:*, sinceUid only limits header fetch).
    // NOT safe with beforeUid (partial crawl needs ALL UIDs to find uncached messages below watermark).
    const changedSince = (!beforeUid && knownModseq && highestModseq && knownModseq !== highestModseq)
      ? BigInt(knownModseq)
      : undefined

    const fullFetchFields = { envelope: true, flags: true, internalDate: true, uid: true, bodyStructure: true, headers: ['References'] }

    // --- Thunderbird pattern: UID FETCH 1:* (UID FLAGS) streaming ---
    // (nsImapProtocol.cpp:4258, nsImapMailFolder.cpp:2592)
    // ALWAYS fetch FLAGS for the FULL folder (1:*) — this ensures we see:
    //   - New messages above watermark
    //   - Flag changes on old messages below watermark (CONDSTORE CHANGEDSINCE)
    //   - Expunged messages (UID reconciliation)
    // sinceUid still limits which NEW messages get a full header fetch (Step 3).
    // beforeUid no longer narrows the header-fetch set — see §newUids filter
    // for why gap UIDs above the prior watermark must still be recovered.
    const FETCH_WINDOW_SIZE = 100

    const serverUidFlags = new Map<number, { seen: boolean; flagged: boolean }>()
    const fetchRange = '1:*'  // Always full range for FLAGS (Thunderbird pattern)
    const flagsFetchOptions: { uid: true; changedSince?: bigint } = { uid: true }
    if (changedSince) flagsFetchOptions.changedSince = changedSince

    // Wrap streaming FETCH in a promise with stall detection.
    // c.close() inside setTimeout doesn't reliably break for-await in ImapFlow,
    // so we use Promise.race: the inner promise resolves when streaming is done,
    // the outer timer rejects if no progress for 60s (per-message).
    // The key: we reset the timer on EACH received message, not just once.
    let flagsFetched = 0
    await new Promise<void>((resolve, reject) => {
      let watchdog: ReturnType<typeof setTimeout> | null = null
      let done = false
      const resetWatchdog = () => {
        if (watchdog) clearTimeout(watchdog)
        if (done) return
        watchdog = setTimeout(() => {
          if (done) return
          done = true
          try { c!.close() } catch { /* ignore */ }
          reject(new Error(`UID FETCH FLAGS stalled after ${flagsFetched}/${total} messages (${folder})`))
        }, 60_000)
      }
      resetWatchdog()
      ;(async () => {
        try {
          for await (const msg of c!.fetch(fetchRange, { uid: true, flags: true }, flagsFetchOptions)) {
            if (done) break
            resetWatchdog()
            flagsFetched++
            const uid = msg.uid as number
            const flags = msg.flags as Set<string> | undefined
            serverUidFlags.set(uid, { seen: isSeen(flags), flagged: isFlagged(flags) })
          }
          done = true
          if (watchdog) clearTimeout(watchdog)
          resolve()
        } catch (err) {
          done = true
          if (watchdog) clearTimeout(watchdog)
          reject(err)
        }
      })()
    })

    const allUids = [...serverUidFlags.keys()].sort((a, b) => a - b)

    // Determine which UIDs need full header fetch.
    //
    // FLAGS fetch is always 1:*, and when `changedSince` is NOT set (the
    // partial-crawl / resume-from-scratch path) `allUids` is therefore the
    // complete server UID set and `localUidSet.has(uid)` authoritatively
    // decides which UIDs are missing locally. Fetch every missing UID
    // regardless of where it sits relative to the partial-crawl watermark —
    // gaps above the watermark (e.g. after a partial cache wipe: 2026-04-21
    // WAL-loss regression) must be recovered the same way as UIDs below it.
    // Previously the `uid >= beforeUid` guard excluded these gap UIDs,
    // leaving folders permanently stuck at N-1 / N with status=covered_recent.
    //
    // When `changedSince` IS set (CONDSTORE modseq-delta fast path on a
    // covered_full incremental sync), `allUids` only contains modseq-changed
    // UIDs and the below filter is a strict subset of "changed + uncached",
    // which is the intended incremental semantics. The expunge-detection
    // branch further down guards against treating a partial FLAGS response
    // as a complete server UID set.
    //
    // `sinceUid` is still respected: it marks the lower bound of an
    // incremental (covered_full) sync where everything below is known-good.
    // `beforeUid` retains its other role — disabling the CHANGEDSINCE
    // optimisation above, so the FLAGS fetch returns every UID rather than
    // only modseq-changed ones (necessary to detect gap UIDs).
    const localFlags = getFolderFlags(accountId, folder)
    const localUidSet = new Set(localFlags.keys())
    const newUids = allUids.filter(uid => {
      if (localUidSet.has(uid)) return false  // already cached
      if (sinceUid && uid <= sinceUid) return false  // below incremental watermark
      return true
    })

    // Diff server flags against local cache and only update what actually changed.
    // Without this, every periodic sync rewrites unread+flagged for every cached
    // message in the folder — an Archive folder with 38k rows produces ~76k sync
    // UPDATEs in the main process and blocks the event loop for 10+ seconds.
    const diff = diffFlags(serverUidFlags, localFlags)
    if (diff.markRead.length > 0) setUnread(accountId, folder, diff.markRead, false)
    if (diff.markUnread.length > 0) setUnread(accountId, folder, diff.markUnread, true)
    if (diff.markFlagged.length > 0) setFlaggedDb(accountId, folder, diff.markFlagged, true)
    if (diff.markUnflagged.length > 0) setFlaggedDb(accountId, folder, diff.markUnflagged, false)

    // Expunge detection (Thunderbird pattern: nsImapProtocol.cpp:4274-4290)
    // FLAGS fetch is always 1:* so serverUidFlags contains the complete server UID set
    // (unless changedSince is used, where only changed messages are returned).
    if (!changedSince) {
      // Full UID set available — direct reconciliation
      const serverUidSet = new Set(allUids)
      const localUids = [...localUidSet]
      const staleUids = localUids.filter(uid => !serverUidSet.has(uid))
      if (staleUids.length > 0) {
        try { removeStaleMessagesByUids(accountId, folder, staleUids) } catch { /* non-critical */ }
      }
    } else if (changedSince) {
      // CONDSTORE path (Thunderbird: nsImapProtocol.cpp:4274, nsImapMailFolder.cpp:2592):
      // Check if new UIDs count matches EXISTS delta. If not — expunge happened alongside
      // new messages, and EXISTS alone won't catch it (e.g., 1 deleted + 1 added = same EXISTS).
      // In that case, do a full UID FETCH 1:* FLAGS to find which UIDs were removed.
      const localCount = getAccountMessageCount(accountId, folder)
      const newUidCount = allUids.filter(uid => !localUidSet.has(uid)).length
      const expectedTotal = localCount + newUidCount
      // If total !== expected, something was expunged (Thunderbird's stronger sanity check)
      if (total !== expectedTotal) {
        try {
          const fullServerUids = new Set<number>()
          for await (const msg of c!.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
            fullServerUids.add(msg.uid as number)
          }
          const localUids = [...localUidSet]
          const staleUids = localUids.filter(uid => !fullServerUids.has(uid))
          if (staleUids.length > 0) {
            removeStaleMessagesByUids(accountId, folder, staleUids)
          }
        } catch { /* non-critical — expunge detection is best-effort */ }
      }
    }

    // Fetch full headers only for NEW messages (Thunderbird: FolderMsgDumpLoop with AllocateImapUidString)
    let fetched = 0
    for (let i = 0; i < newUids.length; i += FETCH_WINDOW_SIZE) {
      const window = newUids.slice(i, i + FETCH_WINDOW_SIZE)
      const range = window.join(',')

      let batch: MailSummary[] = []
      for await (const msg of c.fetch(range, fullFetchFields, { uid: true })) {
        const uid = msg.uid as number
        const from0 = msg.envelope?.from?.[0] as { address?: string; name?: string } | undefined
        const fromAddr = (from0?.address || from0?.name || '').trim()
        const fromName = (from0?.name || '').trim() || undefined
        const from = (fromName || fromAddr || '').trim()
        const messageId = (msg.envelope?.messageId || '').trim() || undefined
        const inReplyTo = (msg.envelope?.inReplyTo || '').trim() || undefined
        const references = normalizeReferences(extractReferencesHeader(msg.headers as Buffer | undefined))
        const toList = (msg.envelope?.to as Array<{ address?: string; name?: string }> | undefined) || []
        const toAddr = toList.map(a => (a.address || '').trim()).filter(Boolean).join(', ') || undefined
        const dateIso = (msg.internalDate ? new Date(msg.internalDate) : new Date()).toISOString()
        const flags = msg.flags as Set<string> | undefined
        const attFilenames = collectAttachmentFilenames(msg.bodyStructure)

        batch.push({
          accountId, folder, uid, from, fromAddr, fromName, toAddr,
          subject: msg.envelope?.subject || '',
          date: dateIso,
          unread: !isSeen(flags),
          flagged: isFlagged(flags),
          hasAttachments: detectAttachments(msg.bodyStructure),
          attachmentFilenames: attFilenames === undefined ? undefined : (attFilenames.join(' ') || ''),
          messageId, inReplyTo, references,
        })

        if (batch.length >= batchSize) {
          fetched += batch.length
          onBatch(batch, fetched)
          batch = []
        }
      }
      if (batch.length > 0) {
        fetched += batch.length
        onBatch(batch, fetched)
      }
    }

    return { fetched, highestModseq, uidValidity, exists: total }
  })
  }, (result) => {
    // Attach post-hoc attributes. fetched_headers_bucket is the count of
    // full-header rows that actually moved through the batch — on the
    // CONDSTORE skip path it is 0 (no header FETCH). Telemetry-only;
    // failures here are isolated by withNetSpan.
    if (result.ok) {
      return {
        fetched_headers_bucket: bucketFetchedHeaders(result.value.fetched),
        skipped: Boolean(result.value.skipped),
      }
    }
    return { fetched_headers_bucket: bucketFetchedHeaders(0), errored: true }
  })
}

/**
 * Thunderbird-style lightweight sync: UID FETCH 1:* (FLAGS) for non-CONDSTORE servers.
 * Instead of re-fetching full headers every time, only fetches UIDs and FLAGS (~40 bytes/msg).
 * Returns list of new UIDs (not in local cache) that need full header fetch.
 * Also detects deletions and flag changes, updating local DB directly.
 */
export async function syncFolderFlagsOnly(
  cfg: ImapConfig,
  folder: string,
  accountId: number,
  knownUidValidity?: number,
): Promise<{ newUids: number[]; deletedCount: number; flagsUpdated: number; uidValidity: number | null; uidValidityChanged?: boolean; stalewipeGuardTripped?: boolean }> {
  return withDedicatedImapRetry(accountId, cfg, async (c) => {
    const mailbox = await c.mailboxOpen(folder)
    const uidValidity = typeof mailbox.uidValidity === 'number' ? mailbox.uidValidity : null

    // UIDVALIDITY guard: if changed, server reassigned UIDs — purge local cache.
    // Signal caller via uidValidityChanged so it falls through to full header resync.
    if (knownUidValidity && uidValidity && uidValidity !== knownUidValidity) {
      const localUids = getFolderUids(accountId, folder)
      if (localUids.length > 0) removeStaleMessagesByUids(accountId, folder, localUids)
      return { newUids: [], deletedCount: localUids.length, flagsUpdated: 0, uidValidity, uidValidityChanged: true }
    }

    // Strict empty-folder guard (2026-04-21 P0 data-loss regression, wave 2).
    // Same rationale as fetchAllFolderHeaders:1203 — only purge on a CONFIRMED
    // numeric zero from the server. Previously `typeof … ? exists : 0` coerced
    // undefined to 0 and reaching `total <= 0` wiped the whole local UID set
    // via removeStaleMessagesByUids, which is exactly the triggering regression
    // on the non-CONDSTORE FLAGS-only sync path (Yandex IPv6 ETIMEDOUT repro).
    if (typeof mailbox.exists === 'number' && mailbox.exists === 0) {
      const localUids = getFolderUids(accountId, folder)
      if (localUids.length > 0) removeStaleMessagesByUids(accountId, folder, localUids)
      return { newUids: [], deletedCount: localUids.length, flagsUpdated: 0, uidValidity }
    }
    if (typeof mailbox.exists !== 'number') {
      console.warn(
        `[IMAP syncFolderFlagsOnly] mailbox.exists is not a number (${typeof mailbox.exists}) — ` +
        `refusing to purge folder cache. stale_wipe_guard tripped on ` +
        `${folderRoleFromPath(folder)} acc=${accountId}`
      )
      reportNetError('imap.sync', new Error('mailbox.exists_not_numeric'), {
        folder_role: folderRoleFromPath(folder),
        provider: providerFromHost(cfg.host),
      })
      reportNetEvent('imap.stale_wipe_guard_tripped', {
        folder_role: folderRoleFromPath(folder),
        provider: providerFromHost(cfg.host),
      })
      // stalewipeGuardTripped signals caller that this run is ambiguous —
      // NOT a trusted "no new messages" result. Codex §2.15 wave-4 Medium.
      return { newUids: [], deletedCount: 0, flagsUpdated: 0, uidValidity, stalewipeGuardTripped: true }
    }
    const total = mailbox.exists
    if (total < 0) {
      console.warn(
        `[IMAP syncFolderFlagsOnly] mailbox.exists is negative (${total}) — ` +
        `refusing to purge folder cache on ${folderRoleFromPath(folder)} acc=${accountId}`
      )
      reportNetEvent('imap.stale_wipe_guard_tripped', {
        folder_role: folderRoleFromPath(folder),
        provider: providerFromHost(cfg.host),
      })
      return { newUids: [], deletedCount: 0, flagsUpdated: 0, uidValidity, stalewipeGuardTripped: true }
    }

    // Thunderbird pattern: UID FETCH 1:* (FLAGS) — streams UIDs+FLAGS (~40 bytes/msg).
    // Unlike UID SEARCH ALL which hangs on large folders (38K on invint.net),
    // UID FETCH FLAGS streams results and per-read socket timeout works correctly.
    // Stall watchdog: if no progress for 60s, close connection and throw.
    const serverFlags = new Map<number, { seen: boolean; flagged: boolean }>()
    await new Promise<void>((resolve, reject) => {
      let watchdog: ReturnType<typeof setTimeout> | null = null
      let done = false
      const resetWatchdog = () => {
        if (watchdog) clearTimeout(watchdog)
        if (done) return
        watchdog = setTimeout(() => {
          if (done) return
          done = true
          try { c.close() } catch { /* ignore */ }
          reject(new Error(`syncFolderFlagsOnly stalled after ${serverFlags.size}/${total} messages (${folder})`))
        }, 60_000)
      }
      resetWatchdog()
      ;(async () => {
        try {
          for await (const msg of c.fetch('1:*', { uid: true, flags: true }, { uid: true })) {
            if (done) break
            resetWatchdog()
            const uid = msg.uid as number
            const flags = msg.flags as Set<string> | undefined
            serverFlags.set(uid, { seen: isSeen(flags), flagged: isFlagged(flags) })
          }
          done = true
          if (watchdog) clearTimeout(watchdog)
          resolve()
        } catch (err) {
          done = true
          if (watchdog) clearTimeout(watchdog)
          reject(err)
        }
      })()
    })
    const allUids = [...serverFlags.keys()]
    const serverUidSet = new Set(allUids)

    // Detect deletions: local UIDs not on server
    const localUids = getFolderUids(accountId, folder)
    const deletedUids = localUids.filter(uid => !serverUidSet.has(uid))
    if (deletedUids.length > 0) {
      removeStaleMessagesByUids(accountId, folder, deletedUids)
    }

    // Detect new messages: server UIDs not in local cache
    const localUidSet = new Set(localUids)
    const newUids = allUids.filter(uid => !localUidSet.has(uid))

    // Diff against local cache — only write rows whose flags actually changed.
    // See fetchAllFolderHeaders for context on why this matters for big folders.
    const localFlags = getFolderFlags(accountId, folder)
    const diff = diffFlags(serverFlags, localFlags)
    let flagsUpdated = 0
    if (diff.markRead.length > 0) { setUnread(accountId, folder, diff.markRead, false); flagsUpdated += diff.markRead.length }
    if (diff.markUnread.length > 0) { setUnread(accountId, folder, diff.markUnread, true); flagsUpdated += diff.markUnread.length }
    if (diff.markFlagged.length > 0) { setFlaggedDb(accountId, folder, diff.markFlagged, true); flagsUpdated += diff.markFlagged.length }
    if (diff.markUnflagged.length > 0) { setFlaggedDb(accountId, folder, diff.markUnflagged, false); flagsUpdated += diff.markUnflagged.length }

    return { newUids, deletedCount: deletedUids.length, flagsUpdated, uidValidity }
  })
}

/**
 * Fetch a batch of headers from a folder using cursor-based (keyset) pagination by UID.
 *
 * beforeUid:
 * - undefined -> return the latest `limit` messages (tail by sequence, fast, no SEARCH all)
 * - number -> return messages with UID < beforeUid (backward pagination)
 */
export async function fetchFolderSummariesPage(
  cfg: ImapConfig,
  folder = 'INBOX',
  limit = 50,
  beforeUid?: number,
  accountId = 1,
  skipBodyStructure = false,
): Promise<MailSummary[]> {
  return withDedicatedImapRetry(accountId, cfg, async (c) => {
    try {
    const mailbox = await c.mailboxOpen(folder)
    // Strict empty-folder guard (same rationale as fetchAllFolderHeaders above).
    // Only purge on a confirmed numeric zero — undefined must NOT trigger a
    // folder-wide DELETE. This path is called from paginated reads so the
    // consequence of an errant wipe is identical: user opens folder, sees
    // nothing, next sync spends hours re-fetching 75k headers.
    if (typeof mailbox.exists === 'number' && mailbox.exists === 0) {
      try { removeStaleMessages(accountId, folder, [], { reason: 'server_empty' }) } catch { /* non-critical */ }
      return []
    }
    if (typeof mailbox.exists !== 'number') {
      console.warn(
        `[IMAP fetchFolderSummariesPage] mailbox.exists is not a number ` +
        `(${typeof mailbox.exists}) — refusing to purge folder cache on ` +
        `${folderRoleFromPath(folder)} acc=${accountId}`
      )
      reportNetError('imap.sync', new Error('mailbox.exists_not_numeric'), {
        folder_role: folderRoleFromPath(folder),
        provider: providerFromHost(cfg.host),
      })
      reportNetEvent('imap.stale_wipe_guard_tripped', {
        folder_role: folderRoleFromPath(folder),
        provider: providerFromHost(cfg.host),
      })
      return []
    }
    const total = mailbox.exists
    if (total <= 0) {
      return []
    }

    const result: MailSummary[] = []

    if (typeof beforeUid !== 'number') {
      // Fastest fetch for new messages: last N by sequence numbers.
      const endSeq = total
      const startSeq = Math.max(1, endSeq - limit + 1)
      const seqRange = `${startSeq}:${endSeq}`
      const fetchFields = skipBodyStructure
        ? { envelope: true, flags: true, internalDate: true, uid: true, headers: ['References'] }
        : { envelope: true, flags: true, internalDate: true, uid: true, bodyStructure: true, headers: ['References'] }
      for await (const msg of c.fetch(seqRange, fetchFields)) {
        const from0 = msg.envelope?.from?.[0] as { address?: string; name?: string } | undefined
        const fromAddr = (from0?.address || from0?.name || '').trim()
        const fromName = (from0?.name || '').trim() || undefined
        const from = (fromName || fromAddr || '').trim()
        const messageId = (msg.envelope?.messageId || '').trim() || undefined
        const inReplyTo = (msg.envelope?.inReplyTo || '').trim() || undefined
        const references = normalizeReferences(extractReferencesHeader(msg.headers as Buffer | undefined))
        const toList = (msg.envelope?.to as Array<{ address?: string; name?: string }> | undefined) || []
        const toAddr = toList.map(a => (a.address || '').trim()).filter(Boolean).join(', ') || undefined
        const dateIso = (msg.internalDate ? new Date(msg.internalDate) : new Date()).toISOString()
        const flags = msg.flags as Set<string> | undefined
        const attFilenames = skipBodyStructure ? undefined : collectAttachmentFilenames(msg.bodyStructure)
        result.push({
          accountId,
          folder,
          uid: msg.uid as number,
          from,
          fromAddr,
          fromName,
          toAddr,
          subject: msg.envelope?.subject || '',
          date: dateIso,
          unread: !isSeen(flags),
          flagged: isFlagged(flags),
          hasAttachments: skipBodyStructure ? undefined : detectAttachments(msg.bodyStructure),
          // undefined = bodyStructure not fetched (NULL in DB, preserves old value via COALESCE)
          // '' = analyzed, no attachments; 'file1.pdf file2.doc' = has attachments
          attachmentFilenames: attFilenames === undefined ? undefined : (attFilenames.join(' ') || ''),
          messageId,
          inReplyTo,
          references,
        })
      }
      result.sort((a, b) => b.uid - a.uid)
    } else {
      // Backward pagination: select messages with UID < beforeUid.
      // IMAP UIDs can have "gaps" (expunge), so we take a window wider than limit and expand it
      // until we collect the needed amount.
      let hi = Math.floor(beforeUid) - 1
      if (hi <= 0) return []

      const MAX_WINDOW = 5000
      let windowSize = Math.max(limit * 5, 200)

      const seen = new Set<number>()
      while (result.length < limit && hi > 0) {
        const lo = Math.max(1, hi - windowSize + 1)
        const range = `${lo}:${hi}`
        const fetchFieldsPaged = skipBodyStructure
          ? { envelope: true, flags: true, internalDate: true, uid: true, headers: ['References'] }
          : { envelope: true, flags: true, internalDate: true, uid: true, bodyStructure: true, headers: ['References'] }
        for await (const msg of c.fetch(range, fetchFieldsPaged, { uid: true })) {
          const uid = msg.uid as number
          if (uid >= beforeUid) continue
          if (seen.has(uid)) continue
          seen.add(uid)

          const from0 = msg.envelope?.from?.[0] as { address?: string; name?: string } | undefined
          const fromAddr = (from0?.address || from0?.name || '').trim()
          const fromName = (from0?.name || '').trim() || undefined
          const from = (fromName || fromAddr || '').trim()
          const messageId = (msg.envelope?.messageId || '').trim() || undefined
          const inReplyTo = (msg.envelope?.inReplyTo || '').trim() || undefined
          const references = normalizeReferences(extractReferencesHeader(msg.headers as Buffer | undefined))
          const toList = (msg.envelope?.to as Array<{ address?: string; name?: string }> | undefined) || []
          const toAddr = toList.map(a => (a.address || '').trim()).filter(Boolean).join(', ') || undefined
          const dateIso = (msg.internalDate ? new Date(msg.internalDate) : new Date()).toISOString()
          const flags = msg.flags as Set<string> | undefined
          const attFilenames = skipBodyStructure ? undefined : collectAttachmentFilenames(msg.bodyStructure)
          result.push({
            accountId,
            folder,
            uid,
            from,
            fromAddr,
            fromName,
            toAddr,
            subject: msg.envelope?.subject || '',
            date: dateIso,
            unread: !isSeen(flags),
            flagged: isFlagged(flags),
            hasAttachments: skipBodyStructure ? undefined : detectAttachments(msg.bodyStructure),
            attachmentFilenames: attFilenames === undefined ? undefined : (attFilenames.join(' ') || ''),
            messageId,
            inReplyTo,
            references,
          })
        }

        if (lo === 1) break
        hi = lo - 1
        windowSize = Math.min(windowSize * 2, MAX_WINDOW)
      }

      result.sort((a, b) => b.uid - a.uid)
      if (result.length > limit) result.splice(limit)
    }

    upsertMessages(accountId, folder, result.map(r => ({
      uid: r.uid,
      subject: r.subject,
      fromAddr: (r.fromAddr || r.from || '').trim(),
      fromName: r.fromName,
      toAddr: r.toAddr,
      date: r.date,
      unread: r.unread,
      flagged: r.flagged,
      hasAttachments: r.hasAttachments,
      attachmentFilenames: r.attachmentFilenames,
      messageId: r.messageId,
      inReplyTo: r.inReplyTo,
      references: r.references,
    })))
    // For the first page (without beforeUid) remove stale messages from cache —
    // but only when the first page covers the ENTIRE folder (total <= limit).
    // For large folders this first page is just the newest slice, and purging
    // everything else would destroy previously synced data.
    if (typeof beforeUid !== 'number' && result.length > 0 && total <= limit) {
      try {
        // `result.length > 0` narrows the UID array to non-empty. Pass
        // reason='reconcile' — caller has the full authoritative UID set
        // (first page = entire folder given total <= limit).
        removeStaleMessages(accountId, folder, result.map(r => r.uid), { reason: 'reconcile' })
      } catch { /* non-critical */ }
    }
    upsertContactsIncoming(
      result
        .map(r => ({ email: (r.fromAddr || '').trim(), name: r.fromName }))
        .filter(r => Boolean(r.email))
    )
    return result
    } catch (e: unknown) {
      throw new Error(`IMAP (${cfg.host}): ${formatImapError(e)}`)
    }
  })
}

/**
 * Server-side IMAP SEARCH for remote fallback when local corpus is incomplete.
 * Returns UIDs matching the query in the given folder.
 * Supports a subset of search criteria: text, from, to, subject, before, after.
 */
export async function imapSearchFolder(
  accountId: number,
  cfg: ImapConfig,
  folder: string,
  criteria: {
    text?: string
    from?: string
    to?: string
    subject?: string
    before?: Date
    after?: Date
  },
  limit = 200,
): Promise<number[]> {
  // Build IMAP search query object for ImapFlow
  const query: Record<string, unknown> = {}
  if (criteria.text) query.body = criteria.text
  if (criteria.from) query.from = criteria.from
  if (criteria.to) query.to = criteria.to
  if (criteria.subject) query.subject = criteria.subject
  if (criteria.before) query.before = criteria.before
  if (criteria.after) query.since = criteria.after

  // If no criteria, return empty (don't fetch everything)
  if (Object.keys(query).length === 0) return []

  return withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxOpen(folder)

    const uids = await c.search(query, { uid: true })
    if (!Array.isArray(uids) || uids.length === 0) return []

    // Return newest first, limited
    const sorted = uids.sort((a: number, b: number) => b - a)
    return sorted.slice(0, limit)
  })
}

/**
 * Fetch header summaries for specific UIDs (used to hydrate remote search results).
 * Returns MailSummary[] for the given UIDs.
 */
export async function fetchSummariesByUids(
  cfg: ImapConfig,
  folder: string,
  uids: number[],
  accountId = 1,
): Promise<MailSummary[]> {
  if (uids.length === 0) return []
  return withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxOpen(folder)

    const result: MailSummary[] = []
    // Batch UIDs to avoid exceeding IMAP command-line length limits (~8KB).
    const BATCH = 50
    for (let i = 0; i < uids.length; i += BATCH) {
    const uidSet = uids.slice(i, i + BATCH).join(',')

    for await (const msg of c.fetch(uidSet, {
      envelope: true,
      flags: true,
      internalDate: true,
      uid: true,
      bodyStructure: true,
      headers: ['References'],
    }, { uid: true })) {
      const from0 = msg.envelope?.from?.[0] as { address?: string; name?: string } | undefined
      const fromAddr = (from0?.address || from0?.name || '').trim()
      const fromName = (from0?.name || '').trim() || undefined
      const from = (fromName || fromAddr || '').trim()
      const messageId = (msg.envelope?.messageId || '').trim() || undefined
      const inReplyTo = (msg.envelope?.inReplyTo || '').trim() || undefined
      const references = normalizeReferences(extractReferencesHeader(msg.headers as Buffer | undefined))
      const toList = (msg.envelope?.to as Array<{ address?: string; name?: string }> | undefined) || []
      const toAddr = toList.map(a => (a.address || '').trim()).filter(Boolean).join(', ') || undefined
      const dateIso = (msg.internalDate ? new Date(msg.internalDate) : new Date()).toISOString()
      const flags = msg.flags as Set<string> | undefined
      const attFilenames = collectAttachmentFilenames(msg.bodyStructure)
      result.push({
        accountId,
        folder,
        uid: msg.uid as number,
        from,
        fromAddr,
        fromName,
        toAddr,
        subject: msg.envelope?.subject || '',
        date: dateIso,
        unread: !isSeen(flags),
        flagged: isFlagged(flags),
        hasAttachments: detectAttachments(msg.bodyStructure),
        attachmentFilenames: attFilenames.join(' ') || '',
        messageId,
        inReplyTo,
        references,
      })
    }
    } // end UID batch loop

    // Upsert into local cache so future searches find them locally
    upsertMessages(accountId, folder, result.map(r => ({
      uid: r.uid,
      subject: r.subject,
      fromAddr: (r.fromAddr || r.from || '').trim(),
      fromName: r.fromName,
      toAddr: r.toAddr,
      date: r.date,
      unread: r.unread,
      flagged: r.flagged,
      hasAttachments: r.hasAttachments,
      attachmentFilenames: r.attachmentFilenames,
      messageId: r.messageId,
      inReplyTo: r.inReplyTo,
      references: r.references,
    })))

    return result
  })
}

export async function setSeen(cfg: ImapConfig, mailbox: string, uids: number[], seen: boolean, accountId = 1) {
  await withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxOpen(mailbox)
    if (seen) await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true })
    else await c.messageFlagsRemove(uids, ['\\Seen'], { uid: true })
  })
  // Update cache
  setUnread(accountId, mailbox, uids, !seen)
}

export async function setFlagged(cfg: ImapConfig, mailbox: string, uids: number[], flagged: boolean, accountId = 1) {
  await withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxOpen(mailbox)
    if (flagged) await c.messageFlagsAdd(uids, ['\\Flagged'], { uid: true })
    else await c.messageFlagsRemove(uids, ['\\Flagged'], { uid: true })
  })
  setFlaggedDb(accountId, mailbox, uids, flagged)
}

type MessageRowLike = NonNullable<ReturnType<typeof getMessageByUid>>

/** Insert a moved message into destination folder cache (full clone of source). */
function insertMoveDestination(accountId: number, toMailbox: string, destUid: number, row: MessageRowLike): void {
  upsertMessages(accountId, toMailbox, [{
    uid: destUid,
    subject: row.subject ?? '',
    fromAddr: row.fromAddr ?? '',
    fromName: row.fromName ?? undefined,
    toAddr: row.toAddr ?? undefined,
    date: row.date,
    unread: !!row.unread,
    flagged: !!row.flagged,
    hasAttachments: row.hasAttachments != null ? !!row.hasAttachments : undefined,
    bodyText: row.bodyText ?? undefined,
    attachmentFilenames: row.attachmentFilenames ?? undefined,
    messageId: row.messageId ?? undefined,
    inReplyTo: row.inReplyTo ?? undefined,
    references: row.references ?? undefined,
  }])
  if (row.pinned) {
    setPinned(accountId, toMailbox, destUid, true)
  }
}

export async function moveMessages(cfg: ImapConfig, fromMailbox: string, toMailbox: string, uids: number[], accountId = 1) {
  let uidMap: Map<number, number> | undefined
  await withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxOpen(fromMailbox)
    const result = await c.messageMove(uids, toMailbox, { uid: true })
    // ImapFlow returns false on server NO/BAD — don't touch local cache on failure
    if (result === false) throw new Error(`IMAP MOVE failed for ${uids.length} messages from ${fromMailbox} to ${toMailbox}`)
    // Capture uidMap (COPYUID) for destination cache update (K-9: RealImapFolder.kt:342)
    if (result && typeof result === 'object' && 'uidMap' in result) {
      uidMap = (result as { uidMap?: Map<number, number> }).uidMap
    }
  })
  // Update local cache: copy messages to destination with new UIDs, then delete from source.
  // When uidMap is available (UIDPLUS/COPYUID), use server-provided mapping.
  // When not available, create placeholder entries with temporary negative UIDs
  // so messages don't disappear from UI. Next sync will replace them with real UIDs.
  const sourceRows = uids.map(uid => getMessageByUid(accountId, fromMailbox, uid)).filter(Boolean) as NonNullable<ReturnType<typeof getMessageByUid>>[]
  if (uidMap && uidMap.size > 0) {
    for (const [srcUid, destUid] of uidMap) {
      const row = sourceRows.find(r => r.uid === srcUid)
      if (row) {
        insertMoveDestination(accountId, toMailbox, destUid, row)
      }
    }
  } else if (sourceRows.length > 0) {
    // No COPYUID: create temporary placeholders with negative UIDs.
    // These will be reconciled on next folder sync (replaced by real UIDs).
    let tempUid = -(Date.now() % 1_000_000_000)
    for (const row of sourceRows) {
      insertMoveDestination(accountId, toMailbox, tempUid--, row)
    }
  }
  deleteMessages(accountId, fromMailbox, uids)
}

/**
 * UIDPLUS-aware delete: safe UID EXPUNGE when available, guarded broad EXPUNGE otherwise.
 * Without UIDPLUS, checks for pre-existing \Deleted messages to avoid collateral expunge.
 * If other \Deleted messages exist, only flags ours (no EXPUNGE) — they'll be cleaned on next sync.
 * This matches K-9 Mail's conservative approach (RealImapFolder.kt:1165). */
async function safeMessageDelete(c: ImapFlow, uids: number[]): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasUidPlus = (c as any).capabilities?.has?.('UIDPLUS') ?? false
  if (hasUidPlus) {
    return await c.messageDelete(uids, { uid: true })
  }
  // Without UIDPLUS: check for pre-existing \Deleted before issuing broad EXPUNGE.
  const uidSet = new Set(uids)
  const deletedUids = await c.search({ deleted: true }, { uid: true })
  const foreignDeleted = (Array.isArray(deletedUids) ? deletedUids : []).filter(u => !uidSet.has(u))
  if (foreignDeleted.length > 0) {
    // Other messages have \Deleted — only flag ours, skip EXPUNGE to avoid collateral damage.
    await c.messageFlagsAdd(uids, ['\\Deleted'], { uid: true })
    return true
  }
  // No foreign \Deleted — safe to EXPUNGE (only our UIDs will be affected).
  return await c.messageDelete(uids, { uid: true })
}

export async function deleteMessagesRemote(cfg: ImapConfig, mailbox: string, uids: number[], accountId = 1) {
  await withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxOpen(mailbox)
    const result = await safeMessageDelete(c, uids)
    if (result === false) throw new Error(`IMAP DELETE failed for ${uids.length} messages in ${mailbox}`)
  })
  deleteMessages(accountId, mailbox, uids)
}

// Mapping table: specialUse -> role
// \All is used by Gmail for "[Gmail]/All Mail" — acts as the archive target (RFC 6154).
const SPECIAL_USE_MAP: Record<string, keyof FolderRoles> = {
  '\\Archive': 'archive',
  '\\All': 'archive',
  '\\Trash': 'trash',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Junk': 'junk',
}

// Fallback folder names for each role (case-insensitive)
const ROLE_NAME_FALLBACKS: Record<keyof FolderRoles, string[]> = {
  archive: ['archive', 'archives', 'архив', 'all mail', 'вся почта'],
  trash: ['trash', 'deleted', 'deleted items', 'deleted messages', 'корзина'],
  sent: ['sent', 'sent items', 'sent messages', 'отправленные'],
  drafts: ['drafts', 'draft', 'черновики'],
  junk: ['junk', 'spam', 'bulk mail', 'спам'],
}

/** Auto-detect folder roles: first by specialUse (RFC 6154), then by name */
export function detectFolderRoles(mailboxes: Mailbox[]): FolderRoles {
  const roles: FolderRoles = {}

  // 1. Search by specialUse
  for (const box of mailboxes) {
    if (!box.specialUse) continue
    const role = SPECIAL_USE_MAP[box.specialUse]
    if (role && !roles[role]) roles[role] = box.path
  }

  // 2. Fallback by name for roles not yet found
  for (const [role, names] of Object.entries(ROLE_NAME_FALLBACKS) as [keyof FolderRoles, string[]][]) {
    if (roles[role]) continue
    const match = mailboxes.find(b => names.includes(b.name.toLowerCase()))
    if (match) roles[role] = match.path
  }

  return roles
}

/** Append a raw message to the specified folder (IMAP APPEND) */
export async function appendToMailbox(accountId: number, cfg: ImapConfig, folder: string, raw: Buffer | string, flags?: string[]): Promise<void> {
  await withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.append(folder, raw, flags ?? ['\\Seen'])
  })
}

/** Create a folder on the IMAP server */
export async function createMailbox(accountId: number, cfg: ImapConfig, folderPath: string): Promise<void> {
  await withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxCreate(folderPath)
  })
}

export async function renameMailbox(accountId: number, cfg: ImapConfig, fromPath: string, toPath: string): Promise<void> {
  await withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxRename(fromPath, toPath)
  })
}

export async function deleteMailbox(accountId: number, cfg: ImapConfig, folderPath: string): Promise<void> {
  await withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxDelete(folderPath)
  })
}

const MAILCOPILOT_DRAFT_HEADER = 'X-MailCopilot-Draft-Id'

/** §2.16 — local sink for draft-sync diagnostics.
 *  packages/net cannot import electron/logger (renderer/main both consume this
 *  package), so we mirror the createLogger('DraftSync') intent via console +
 *  reportNetEvent. PII guard: never log subject/body content — only lengths
 *  and our own draftId (which is a UUID, not user data). */
function logDraft(level: 'info' | 'warn', event: string, ctx: Record<string, unknown>): void {
  const sink = level === 'warn' ? console.warn : console.info
  sink(`[DraftSync] ${event}`, ctx)
}

/** §2.16 — extract Message-ID header value from a raw RFC822 buffer.
 *  MailComposer always emits one when buildRawMessage runs. We scan only the
 *  header block (everything before the first CRLFCRLF / LFLF) so the parse
 *  stops well before any large body, and so we never read attachment bytes. */
export function extractMessageIdFromRaw(raw: Buffer | string): string | undefined {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  // Header block ends at the first blank line (RFC 5322 §2.1). Be tolerant of
  // both CRLFCRLF and bare LFLF — different generators differ.
  const headerEnd = (() => {
    const a = text.indexOf('\r\n\r\n')
    const b = text.indexOf('\n\n')
    if (a >= 0 && b >= 0) return Math.min(a, b)
    return a >= 0 ? a : b
  })()
  const headers = headerEnd >= 0 ? text.slice(0, headerEnd) : text
  // Match "Message-ID:" / "Message-Id:" with case-insensitive header name and
  // accept folded continuation lines. Capture between the angle brackets.
  const match = headers.match(/^message-id\s*:\s*<([^>]+)>/im)
  return match ? match[1] : undefined
}

/** §2.16 — per-account serialization for net:saveDraft.
 *
 *  mail.ru (and other servers with eventually-consistent SEARCH on custom
 *  X-headers) can return [] for a freshly-APPENDed message during the brief
 *  window between APPEND and the server's index update. If two saveDraft
 *  calls land in parallel for the same account, the second's SEARCH may
 *  miss both the first's APPEND and its own — neither call deletes the
 *  prior copy, and drafts pile up. Serializing per-account keeps the
 *  APPEND/SEARCH/DELETE triple atomic from the client's view.
 *
 *  Different accountIds proceed in parallel. Errors propagate to the caller
 *  but do not poison the lock — the chain is replaced even on rejection so
 *  one bad call cannot deadlock the account forever. */
const saveDraftLockChains = new Map<number, Promise<unknown>>()

export function withSaveDraftLock<T>(accountId: number, fn: () => Promise<T>): Promise<T> {
  const prev = saveDraftLockChains.get(accountId) ?? Promise.resolve()
  // Chain on settled (resolved or rejected) so a single failure doesn't poison
  // subsequent calls. We deliberately don't surface the previous error here.
  const next = prev.then(() => fn(), () => fn())
  // Store a settled-shape promise so the next caller chains the same way and
  // the map never accumulates rejected handles.
  saveDraftLockChains.set(accountId, next.then(() => undefined, () => undefined))
  return next
}

/** §2.16 test-only reset for the per-account saveDraft lock chain. */
export function __resetSaveDraftLockForTest(): void {
  saveDraftLockChains.clear()
}

export async function saveDraft(
  accountId: number,
  cfg: ImapConfig,
  draftsMailbox: string,
  draftId: string,
  data: { to?: string; cc?: string; bcc?: string; subject?: string; text?: string; html?: string },
): Promise<{ uid?: number }> {
  // §2.16 iter2 — Message-Id is derived deterministically from draftId so that
  // every save of the SAME draft emits the SAME Message-ID header. This makes
  // the Message-Id fallback (search by header `message-id`) an effective dedup
  // mechanism: if the X-MailCopilot-Draft-Id SEARCH misses (mail.ru-class
  // servers that don't index custom X-headers), the Message-Id SEARCH still
  // finds prior copies of THIS draft (and never anything else, because the
  // domain `mailcopilot.local` is reserved for our internal IDs).
  //
  // Without this, MailComposer would mint a fresh random Message-ID per call;
  // the SEARCH would find only the just-appended message and stop before the
  // SUBJECT+SINCE fallback ever runs — making the Message-Id step a no-op for
  // dedup purposes. Pinning the Message-Id closes that gap.
  const stableMessageId = `draft-${draftId}@mailcopilot.local`
  const raw = await buildRawMessage({
    from: cfg.user,
    to: data.to || '',
    cc: data.cc || undefined,
    bcc: data.bcc || undefined,
    subject: data.subject || '',
    text: data.text || undefined,
    html: data.html || undefined,
    messageId: stableMessageId,
    headers: {
      [MAILCOPILOT_DRAFT_HEADER]: draftId,
    },
  })
  // Cache PII-safe metadata for logs. subjectLen is recorded; subject CONTENT
  // is never logged. body (text/html) is never logged either.
  const subjectLen = (data.subject || '').length
  const messageId = extractMessageIdFromRaw(raw) ?? stableMessageId
  const draftSentAt = new Date()

  return withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxOpen(draftsMailbox)

    // RFC 3501: \\Draft — system flag; convenient for filtering/display.
    const appended = await c.append(draftsMailbox, raw, ['\\Draft'], draftSentAt)
    const appendedUid =
      (appended && typeof appended === 'object' && typeof appended.uid === 'number')
        ? appended.uid
        : undefined

    // Primary dedup path — SEARCH by our X-MailCopilot-Draft-Id header.
    // Most servers (Gmail, Outlook, Yahoo, Fastmail, dovecot) honour this.
    let found = await c.search({ header: { [MAILCOPILOT_DRAFT_HEADER]: draftId } }, { uid: true })
    let foundUids = Array.isArray(found) ? found : []
    let dedupSource: 'x-header' | 'message-id' | 'subject-since' | 'none' = 'x-header'

    // Fallback 1 — Message-Id header. Some servers (notably mail.ru) index
    // standard headers reliably while ignoring custom X-headers in SEARCH.
    if (foundUids.length === 0 && messageId) {
      try {
        found = await c.search({ header: { 'message-id': messageId } }, { uid: true })
        foundUids = Array.isArray(found) ? found : []
        if (foundUids.length > 0) dedupSource = 'message-id'
      } catch {
        // Some servers reject `header: {message-id: …}` — leave foundUids empty
        // and fall through to the next fallback.
      }
    }

    // Fallback 2 — SUBJECT + SINCE (≤1h). Last-resort heuristic. The 1h window
    // is intentional: wider windows risk deleting a legitimate identical draft
    // the user composed earlier. We only fire this when the subject is
    // non-empty, otherwise the criterion is too loose.
    //
    // §2.16 iter2 SAFETY — IMAP SINCE is date-granular on servers without
    // WITHIN, so the candidate set may include drafts unrelated to ours that
    // happen to share the subject (legitimate user replies, manual drafts, or
    // drafts from other clients). Before deleting anything we MUST verify each
    // candidate UID actually carries our X-MailCopilot-Draft-Id header
    // matching `draftId`. Drafts with no X-header at all (other clients) or
    // with a different draftId are kept. Without this check the SUBJECT
    // fallback could destroy user data — see codex iter1 High #2.
    if (foundUids.length === 0 && (data.subject || '').trim().length > 0) {
      try {
        const since = new Date(draftSentAt.getTime() - 60 * 60 * 1000)
        found = await c.search(
          { subject: data.subject || '', since },
          { uid: true },
        )
        const subjectCandidates = Array.isArray(found) ? found : []
        if (subjectCandidates.length > 0) {
          // FETCH our X-header for each candidate — tiny payload (just one
          // header field per message). Filter to UIDs whose header value
          // exactly matches `draftId`. The just-appended UID is implicitly
          // included because it carries the same header.
          const verified: number[] = []
          const fetchFields = { uid: true, headers: [MAILCOPILOT_DRAFT_HEADER.toLowerCase()] }
          // imapflow accepts a numeric range string for fetch by UID set.
          const uidRange = subjectCandidates.join(',')
          for await (const msg of c.fetch(uidRange, fetchFields, { uid: true })) {
            if (!msg || typeof msg.uid !== 'number') continue
            const headerText = msg.headers
              ? (typeof msg.headers === 'string' ? msg.headers : (msg.headers as Buffer).toString('utf8'))
              : ''
            const match = headerText.match(/^x-mailcopilot-draft-id\s*:\s*(\S+)/im)
            const candidateDraftId = match ? match[1].trim() : ''
            if (candidateDraftId === draftId) verified.push(msg.uid)
          }
          if (verified.length > 0) {
            foundUids = verified
            dedupSource = 'subject-since'
          } else {
            // SUBJECT search returned candidates but NONE of them are our
            // drafts. Do not delete anything. Log so we can spot how often
            // this guard saves us in dashboards.
            logDraft('warn', 'saveDraft.subject_fallback_no_match', {
              draftId, accountId, subjectLen,
              candidateCount: subjectCandidates.length,
            })
          }
        }
      } catch {
        // ignore — last-ditch fallback may not be supported
      }
    }

    if (foundUids.length === 0) {
      // All three search strategies returned []. Do NOT delete anything blind:
      // we have no evidence of prior copies and forced delete-all would lose
      // the user's data. The orphan sweep on next IDLE start cleans up any
      // leak.
      logDraft('warn', 'saveDraft.dedup_impossible', {
        draftId, accountId, subjectLen, appendedUid, hasMessageId: Boolean(messageId),
      })
      return { uid: appendedUid }
    }

    const keepUid = (typeof appendedUid === 'number')
      ? appendedUid
      : Math.max(...foundUids)
    const toDelete = foundUids.filter(u => u !== keepUid)

    // Belt-and-suspenders telemetry signal for "X-header SEARCH was empty
    // but fallbacks rescued us". We log info on every save (cheap), warn on
    // empty-x-header so we can spot misbehaving servers in dashboards.
    if (dedupSource !== 'x-header') {
      logDraft('warn', 'saveDraft.search_empty', {
        draftId, accountId, subjectLen, dedupSource,
      })
    }
    logDraft('info', 'saveDraft', {
      draftId, accountId, subjectLen,
      appendedUid, keepUid,
      foundCount: foundUids.length,
      toDeleteCount: toDelete.length,
      dedupSource,
    })

    if (toDelete.length > 0) {
      await safeMessageDelete(c, toDelete)
    }

    return { uid: keepUid }
  })
}

export async function deleteDraft(accountId: number, cfg: ImapConfig, draftsMailbox: string, draftId: string): Promise<void> {
  // §2.16 iter5 — mirror saveDraft's fallback chain so finalization works on
  // mail.ru-class servers that do not index the custom X-MailCopilot-Draft-Id
  // header reliably. Without these fallbacks deleteDraft can return without
  // touching anything, while electron/main marks the draft "finalized" — any
  // future save for the same draftId becomes a no-op (LRU short-circuits) and
  // the orphan stays on the server forever (sweepOrphanDrafts only handles
  // duplicates within the SAME draftId, not single leftover drafts).
  //
  // Message-Id is derived from draftId using the same format as saveDraft
  // (iter2: `draft-${draftId}@mailcopilot.local`). The domain is reserved for
  // our internal IDs, so this SEARCH cannot match unrelated user mail.
  const stableMessageId = `draft-${draftId}@mailcopilot.local`

  await withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxOpen(draftsMailbox)

    // Primary: SEARCH by our X-MailCopilot-Draft-Id header. Most servers
    // (Gmail, Outlook, Yahoo, Fastmail, dovecot) honour this.
    let found = await c.search({ header: { [MAILCOPILOT_DRAFT_HEADER]: draftId } }, { uid: true })
    let uids = Array.isArray(found) ? found : []
    let dedupSource: 'x-header' | 'message-id' | 'since-verified' | 'none' = 'x-header'

    // Fallback 1 — Message-Id header. Stable across saves (iter2), so this
    // matches the saveDraft pattern exactly.
    if (uids.length === 0) {
      try {
        found = await c.search({ header: { 'message-id': stableMessageId } }, { uid: true })
        uids = Array.isArray(found) ? found : []
        if (uids.length > 0) dedupSource = 'message-id'
      } catch {
        // Some servers reject `header: {message-id: …}` — leave uids empty
        // and fall through to the next fallback.
      }
    }

    // Fallback 2 — recent SINCE window (≤1h) with mandatory X-header
    // verification per UID. Mirrors saveDraft's SUBJECT+SINCE safety check,
    // but deleteDraft has no subject parameter so we use SINCE alone to bound
    // the candidate set, then verify each UID's X-header before deletion.
    // The 1h window matches saveDraft and limits the candidate volume on busy
    // Drafts folders. UIDs WITHOUT our X-header (other clients, manual drafts)
    // and UIDs with a DIFFERENT draftId are kept — only exact draftId matches
    // are deleted. Without this verification we could destroy unrelated user
    // drafts.
    if (uids.length === 0) {
      try {
        const since = new Date(Date.now() - 60 * 60 * 1000)
        found = await c.search({ since }, { uid: true })
        const sinceCandidates = Array.isArray(found) ? found : []
        if (sinceCandidates.length > 0) {
          const verified: number[] = []
          const fetchFields = { uid: true, headers: [MAILCOPILOT_DRAFT_HEADER.toLowerCase()] }
          const uidRange = sinceCandidates.join(',')
          for await (const msg of c.fetch(uidRange, fetchFields, { uid: true })) {
            if (!msg || typeof msg.uid !== 'number') continue
            const headerText = msg.headers
              ? (typeof msg.headers === 'string' ? msg.headers : (msg.headers as Buffer).toString('utf8'))
              : ''
            const match = headerText.match(/^x-mailcopilot-draft-id\s*:\s*(\S+)/im)
            const candidateDraftId = match ? match[1].trim() : ''
            if (candidateDraftId === draftId) verified.push(msg.uid)
          }
          if (verified.length > 0) {
            uids = verified
            dedupSource = 'since-verified'
          } else {
            // SINCE returned candidates but NONE carry our draftId. Do not
            // delete anything. Log so we can spot how often this guard saves
            // unrelated user data.
            logDraft('warn', 'deleteDraft.since_fallback_no_match', {
              draftId, accountId, candidateCount: sinceCandidates.length,
            })
          }
        }
      } catch {
        // ignore — last-ditch fallback may not be supported
      }
    }

    if (uids.length === 0) {
      // All three search strategies returned []. The draft cannot be located,
      // so we cannot DELETE anything. The future-save no-op (caller marks the
      // draftId as finalized) means the orphan won't grow further; the user
      // can clear it manually or via a future targeted sweep. Do NOT issue
      // a blind sweep — that would risk destroying unrelated drafts.
      logDraft('warn', 'deleteDraft.dedup_impossible', {
        draftId, accountId,
      })
      return
    }

    if (dedupSource !== 'x-header') {
      logDraft('warn', 'deleteDraft.search_empty', {
        draftId, accountId, dedupSource,
      })
    }

    await safeMessageDelete(c, uids)
  })
}

/** §2.16 — one-off cleanup of duplicate drafts left behind by previous saves
 *  that hit the dedup_impossible branch (or by SEARCH races on mail.ru-class
 *  servers). Walks every UID in the Drafts mailbox, groups by our
 *  X-MailCopilot-Draft-Id header, and inside each group keeps max(uid) and
 *  deletes the rest. Drafts WITHOUT our X-header (other clients, manual
 *  drafts) are never touched.
 *
 *  Designed to run fire-and-forget per account after IDLE start. Safe to
 *  call repeatedly; idempotent. Never throws — internal failures are
 *  swallowed and reported via reportNetEvent so the caller's IDLE bring-up
 *  is never blocked. */
export async function sweepOrphanDrafts(
  accountId: number,
  cfg: ImapConfig,
  draftsMailbox: string,
): Promise<{ groups: number; deleted: number }> {
  let groups = 0
  let deleted = 0
  try {
    await withImapRetry(accountId, cfg, async () => {
      const c = await connectImap(cfg)
      const status = await c.mailboxOpen(draftsMailbox)
      const exists = (status && typeof status === 'object' && typeof (status as { exists?: number }).exists === 'number')
        ? (status as { exists: number }).exists
        : 0
      if (exists <= 0) return

      // Group UIDs by their X-MailCopilot-Draft-Id value. Messages without
      // our header are skipped — they belong to other clients.
      const byDraftId = new Map<string, number[]>()
      // Header section is a tiny payload per message; matches the same
      // pattern used by fetchFolderSummariesPage (line ~1699). Headers list
      // is case-insensitive on the wire — we lowercase for parity with
      // ImapFlow's internal canonicalisation.
      const fetchFields = { uid: true, headers: [MAILCOPILOT_DRAFT_HEADER.toLowerCase()] }
      for await (const msg of c.fetch('1:*', fetchFields)) {
        if (!msg || typeof msg.uid !== 'number') continue
        const headerText = msg.headers
          ? (typeof msg.headers === 'string' ? msg.headers : (msg.headers as Buffer).toString('utf8'))
          : ''
        // Header value extraction: tolerant of folded continuations.
        const match = headerText.match(/^x-mailcopilot-draft-id\s*:\s*(\S+)/im)
        const draftId = match ? match[1].trim() : ''
        if (!draftId) continue
        const arr = byDraftId.get(draftId)
        if (arr) arr.push(msg.uid)
        else byDraftId.set(draftId, [msg.uid])
      }

      const toDelete: number[] = []
      for (const [, uids] of byDraftId) {
        if (uids.length <= 1) continue
        groups += 1
        const keep = Math.max(...uids)
        for (const u of uids) if (u !== keep) toDelete.push(u)
      }
      if (toDelete.length > 0) {
        await safeMessageDelete(c, toDelete)
        deleted = toDelete.length
      }
    })

    if (deleted > 0) {
      logDraft('info', 'sweepOrphanDrafts', { accountId, groups, deleted })
    }
  } catch (err) {
    // Non-fatal: sweep is best-effort. Log and move on so IDLE bring-up
    // continues unimpeded.
    logDraft('warn', 'sweepOrphanDrafts.failed', {
      accountId, error: err instanceof Error ? err.message : String(err),
    })
    try {
      reportNetError('drafts.sweep_orphans', err instanceof Error ? err : new Error(String(err)), {
        provider: providerFromHost(cfg.host),
      })
    } catch { /* error reporter must not throw */ }
  }
  return { groups, deleted }
}

// =============================================
// Per-account IMAP pool for parallel operations
// (offline sync of multiple accounts simultaneously).
// Separate from the main singleton client — does not interfere with UI operations.
// =============================================

const perAccountClients = new Map<string, ImapFlow>()
const perAccountConnecting = new Map<string, Promise<ImapFlow>>()
const perAccountOpChains = new Map<string, Promise<void>>()

/** Maximum concurrent per-account connections (Thunderbird: 5, our limit: 3) */
export const MAX_CONNECTIONS_PER_ACCOUNT = 3
const perAccountConnectionCount = new Map<string, number>()
type PoolWaiter = { resolve: () => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }
const perAccountWaiters = new Map<string, PoolWaiter[]>()

function acquirePerAccountSlot(ukey: string): Promise<void> {
  const count = perAccountConnectionCount.get(ukey) ?? 0
  if (count < MAX_CONNECTIONS_PER_ACCOUNT) {
    perAccountConnectionCount.set(ukey, count + 1)
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const waiters = perAccountWaiters.get(ukey) ?? []
    const waiter: PoolWaiter = {
      resolve: () => {
        clearTimeout(waiter.timeout)
        perAccountConnectionCount.set(ukey, (perAccountConnectionCount.get(ukey) ?? 0) + 1)
        resolve()
      },
      reject: (err: Error) => {
        clearTimeout(waiter.timeout)
        reject(err)
      },
      timeout: setTimeout(() => {
        const idx = waiters.indexOf(waiter)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new Error(`Connection pool limit reached for account (max ${MAX_CONNECTIONS_PER_ACCOUNT}), timed out after 30s`))
      }, 30_000),
    }
    waiters.push(waiter)
    perAccountWaiters.set(ukey, waiters)
  })
}

/** Release a per-account connection slot. Call after disconnecting. */
export function releasePerAccountSlot(ukey: string): void {
  const count = perAccountConnectionCount.get(ukey) ?? 0
  if (count > 0) perAccountConnectionCount.set(ukey, count - 1)
  const waiters = perAccountWaiters.get(ukey)
  if (waiters && waiters.length > 0) {
    const next = waiters.shift()!
    next.resolve()
  }
}

/** Serialize IMAP operations for a specific account */
function withPerAccountOpLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const chain = perAccountOpChains.get(key) ?? Promise.resolve()
  const run = chain.then(() => fn())
  perAccountOpChains.set(key, run.then(() => {}, () => {}))
  return run
}

/** IMAP connection for a specific account (per-account pool, bounded to MAX_CONNECTIONS_PER_ACCOUNT) */
export async function connectImapPerAccount(cfg: ImapConfig): Promise<ImapFlow> {
  const ukey = userKey(cfg)
  const existing = perAccountClients.get(ukey)
  if (existing && existing.usable) return existing

  // If a parallel connect is already in progress — wait for it
  const pending = perAccountConnecting.get(ukey)
  if (pending) return pending

  // Acquire connection slot (waits if pool is full, timeout 30s)
  await acquirePerAccountSlot(ukey)

  // Close old connection (if not usable)
  if (existing) { try { await existing.logout() } catch { /* ignore */ } }
  perAccountClients.delete(ukey)

  const c = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.accessToken
      ? { user: cfg.user, accessToken: cfg.accessToken }
      : { user: cfg.user, pass: cfg.pass || '' },
    tls: buildTlsOptions(cfg),
    logger: silentLogger,
    socketTimeout: 30_000,
  })
  applySocketOptions(c)
  c.on('error', () => { /* suppress uncaught error */ })

  const p = (async () => {
    try {
      await c.connect()
      perAccountClients.set(ukey, c)
      return c
    } catch (e) {
      perAccountClients.delete(ukey)
      releasePerAccountSlot(ukey)
      throw e
    }
  })()

  perAccountConnecting.set(ukey, p)
  try {
    return await p
  } finally {
    if (perAccountConnecting.get(ukey) === p) perAccountConnecting.delete(ukey)
  }
}

/** Wrapper with retry on connection loss (per-account pool).
 *  2 retries with 1s delay between attempts (handles transient Wi-Fi drops).
 *
 *  Auth-error handling mirrors withImapRetry: if the error is classified as
 *  'auth' and an onAuthError handler is registered, invoke it to obtain a
 *  fresh access token, patch cfg, reset the per-account connection, and
 *  retry once. Double auth failure throws without further attempts. */
export async function withImapRetryPerAccount<T>(
  accountId: number,
  cfg: ImapConfig,
  fn: () => Promise<T>,
  retries = 2,
  opts?: WithImapRetryPerAccountOpts,
): Promise<T> {
  const ukey = userKey(cfg)
  // §2.17 Phase 0 — start the wait clock at the moment we enter the
  // semaphore-or-pool acquire path. We re-zero on retries because the
  // first fn() invocation is what we care about for diagnosing
  // "interactive open is queued behind background indexer". Auth-retry
  // and connection-loss retries fall under a separate bucket (the
  // existing `imap.auth_refresh_*` events) and would muddle the signal.
  const waitStart = Date.now()
  let waitReported = false
  return withPerAccountOpLock(ukey, async () => {
    let remaining = retries
    let authRetryUsed = false
    for (;;) {
      try {
        if (!waitReported) {
          waitReported = true
          // Fire-and-forget telemetry — must never delay or break the
          // open path. The seam (reportNetEvent) is itself wrapped in
          // try/catch.
          try {
            const waitMs = Date.now() - waitStart
            if (waitMs >= POOL_QUEUE_WAIT_REPORT_THRESHOLD_MS) {
              reportNetEvent('imap.pool_queue_wait_ms', {
                requester: opts?.priority ?? 'other',
                wait_ms_bucket: bucketDuration(waitMs),
              })
            }
          } catch { /* telemetry must not throw */ }
        }
        return await fn()
      } catch (e: unknown) {
        const errClass = classifyImapError(e)

        // Cert error path: notify the main-process subscriber and rethrow —
        // retrying a trust failure is pointless (see withImapRetry).
        if (errClass === 'cert') {
          notifyCertError(accountId, cfg, e)
          throw e
        }

        // Auth error path: attempt token refresh exactly once, gated by
        // per-account cooldown to avoid hammering Azure/Google `/token`.
        if (errClass === 'auth' && !authRetryUsed) {
          authRetryUsed = true
          const freshToken = await invokeAuthHandlerWithCooldown(accountId, e)
          if (freshToken !== null) {
            cfg.accessToken = freshToken
            const old = perAccountClients.get(ukey)
            if (old) { try { await old.logout() } catch { /* ignore */ } }
            perAccountClients.delete(ukey)
            perAccountConnecting.delete(ukey)
            releasePerAccountSlot(ukey)
            await connectImapPerAccount(cfg)
            continue
          }
          throw e
        }

        const msg = e instanceof Error ? e.message : String(e)
        // §2.20-E: keep classifier in sync with withImapRetry (imap.ts:~534).
        const isConnectionLost = /NoConnection|not usable|Unexpected close|closed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|ECONNABORTED/i.test(msg)
        if (!isConnectionLost || remaining <= 0) throw e
        remaining -= 1

        const old = perAccountClients.get(ukey)
        if (old) { try { await old.logout() } catch { /* ignore */ } }
        perAccountClients.delete(ukey)
        perAccountConnecting.delete(ukey)
        releasePerAccountSlot(ukey)
        await sleep(1000)
        await connectImapPerAccount(cfg)
      }
    }
  })
}

/** Close per-account connection for a specific account */
export async function disconnectPerAccount(cfg: ImapConfig): Promise<void> {
  const ukey = userKey(cfg)
  const c = perAccountClients.get(ukey)
  perAccountClients.delete(ukey)
  perAccountConnecting.delete(ukey)
  perAccountOpChains.delete(ukey)
  if (c) { try { await c.logout() } catch { /* ignore */ } }
  releasePerAccountSlot(ukey)
}

/** Close all per-account connections */
export async function disconnectAllPerAccount(): Promise<void> {
  const entries = Array.from(perAccountClients.entries())
  perAccountClients.clear()
  perAccountConnecting.clear()
  perAccountOpChains.clear()
  perAccountConnectionCount.clear()
  // Reject all waiters — connections are going away
  const poolShutdownErr = new Error('Connection pool shut down')
  for (const [, waiters] of perAccountWaiters) {
    for (const w of waiters) w.reject(poolShutdownErr)
  }
  perAccountWaiters.clear()
  await Promise.allSettled(
    entries.map(async ([, c]) => { try { await c.logout() } catch { /* ignore */ } })
  )
}
