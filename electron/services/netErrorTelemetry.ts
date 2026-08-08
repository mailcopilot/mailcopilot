// §2.82 iter4 (security finding 2) — the PII boundary for network errors.
//
// `packages/net` reports failures through a seam (`reportNetError`), and main
// used to hand the RAW error straight to `captureException`. Every string in
// that error is written by the mail server:
//
//   - ImapFlow builds tagged-failure errors with `responseText` = the server's
//     free text and `executedCommand` = the command it sent, which names the
//     MAILBOX (`A7 SELECT "INBOX/Проекты/Иванов"`);
//   - authentication failures routinely name the mailbox being logged into
//     ("AUTHENTICATIONFAILED for ivan@example.com");
//   - a NO/BAD response may quote a subject, a Message-ID, or anything else
//     the server feels like echoing.
//
// The event-level scrub (`scrubEventPii`) removes the shapes it can recognise
// — user paths and addresses — but a folder name is arbitrary text with no
// shape, and no regex can recognise it. The consent screen promises without
// qualification that folder names are never sent, so the promise has to be
// kept by NOT TRANSMITTING SERVER TEXT AT ALL, rather than by filtering it.
//
// Hence this module: one funnel, through which every `packages/net` error
// passes, that emits a SYNTHETIC exception carrying a closed error class and
// the (code-controlled) source, plus context filtered through an allowlist of
// keys AND values. The raw error never leaves this function — it stays in the
// local electron-log sink, which never leaves the machine.
//
// Scope note: the sibling bridges (`setDbErrorReporter`, direct
// `captureException` call sites elsewhere in main) are the same class of
// problem and are tracked separately; this file deliberately fixes the net
// seam only, which is where server-controlled text enters.

import { isTransientNetworkError } from '@mailcopilot/core'
import { isTlsTrustError } from '../../packages/net/tls'
import { DOMAINS } from '../metricsSchema'
import { createLogger } from '../logger'
import { captureException } from '../sentry'

const log = createLogger('NetTelemetry')

/**
 * Closed set of error classes. Every value below is a LITERAL in this file —
 * no branch derives a class from server text, so nothing here can carry PII
 * regardless of what the server sent.
 */
export type NetErrorClass =
  | 'cert'
  | 'auth'
  | 'permission'
  | 'quota'
  | 'mailbox'
  | 'throttled'
  | 'timeout'
  | 'connection'
  | 'protocol'
  | 'unknown'

/** Instanceof-derived error kind. Never `err.name` — that is assignable. */
export type NetErrorKind = 'TypeError' | 'RangeError' | 'SyntaxError' | 'ReferenceError' | 'Error' | 'UnknownError'

/**
 * `err.code` values ImapFlow / Node set themselves (grep `code = '` in
 * imapflow/lib). Lookup is on the UPPERCASED code against this fixed map, so
 * a code we do not know — including one a server could influence — lands on
 * `unknown` instead of travelling as a string.
 */
const CODE_CLASS: Readonly<Record<string, NetErrorClass>> = {
  ETIMEOUT: 'timeout',
  CONNECT_TIMEOUT: 'timeout',
  GREETING_TIMEOUT: 'timeout',
  UPGRADE_TIMEOUT: 'timeout',
  LOCKTIMEOUT: 'timeout',
  NOCONNECTION: 'connection',
  ECONNECTIONCLOSED: 'connection',
  CLOSEDAFTERCONNECTTLS: 'connection',
  CLOSEDAFTERCONNECTTEXT: 'connection',
  STATELOGOUT: 'connection',
  PROXYERROR: 'connection',
  ETHROTTLE: 'throttled',
  INVALIDRESPONSE: 'protocol',
  STARTTLS_INJECTION: 'protocol',
  NOTFOUND: 'mailbox',
  EAUTH: 'auth',
  AUTHENTICATIONFAILED: 'auth',
}

/**
 * IMAP response codes (RFC 3501 §7.1, RFC 5530). ImapFlow copies the code the
 * server returned into `err.serverResponseCode`, so the VALUE is
 * server-controlled — which is exactly why it is used as a lookup key here and
 * never forwarded. An unrecognised code contributes nothing.
 */
const RESPONSE_CODE_CLASS: Readonly<Record<string, NetErrorClass>> = {
  AUTHENTICATIONFAILED: 'auth',
  AUTHORIZATIONFAILED: 'auth',
  EXPIRED: 'auth',
  PRIVACYREQUIRED: 'auth',
  NOPERM: 'permission',
  CONTACTADMIN: 'permission',
  OVERQUOTA: 'quota',
  NONEXISTENT: 'mailbox',
  ALREADYEXISTS: 'mailbox',
  TRYCREATE: 'mailbox',
  INUSE: 'mailbox',
  UNAVAILABLE: 'protocol',
  SERVERBUG: 'protocol',
  CLIENTBUG: 'protocol',
  CANNOT: 'protocol',
  LIMIT: 'protocol',
  CORRUPTION: 'protocol',
  PARSE: 'protocol',
  BADCHARSET: 'protocol',
  EXPUNGEISSUED: 'protocol',
}

/** `source` is a code literal at every call site; the shape check is defence
 *  in depth against a future caller building one from runtime data. */
const SOURCE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/

/** Free-form-ish context values that are still code-controlled enums
 *  (`exit_reason` grows with new IDLE exit paths). Rejects anything with a
 *  space, a separator, an `@` or a non-ASCII letter — i.e. every shape a
 *  folder name, subject or address actually takes. */
const ENUM_TOKEN_RE = /^[a-z][a-z0-9_]{0,39}$/

/** Bucket labels produced by electron/metricsBuckets.ts (`<1KB`, `1-10KB`). */
const BUCKET_TOKEN_RE = /^[A-Za-z0-9<>+.-]{1,24}$/

type ContextValue = string | number | boolean | undefined
type ContextInput = Record<string, ContextValue> | undefined

/**
 * Allowlist of context keys, each with its own validator. A key that is not
 * listed is dropped, and so is a listed key whose value fails its validator —
 * the count of both is reported as `context_dropped`, so a future caller that
 * starts passing something unexpected is visible in Sentry instead of silently
 * losing its attribute.
 */
const CONTEXT_RULES: Readonly<Record<string, (v: ContextValue) => ContextValue | undefined>> = {
  provider: v => (typeof v === 'string' && (DOMAINS.provider as readonly string[]).includes(v) ? v : undefined),
  folder_role: v => (typeof v === 'string' && (DOMAINS.folder_role as readonly string[]).includes(v) ? v : undefined),
  exit_reason: v => (typeof v === 'string' && ENUM_TOKEN_RE.test(v) ? v : undefined),
  size_bucket: v => (typeof v === 'string' && BUCKET_TOKEN_RE.test(v) ? v : undefined),
  has_attachments: v => (typeof v === 'boolean' ? v : undefined),
  changed_since_present: v => (typeof v === 'boolean' ? v : undefined),
  attempt: v => sanitizeCount(v),
  consecutive: v => sanitizeCount(v),
}

function sanitizeCount(v: ContextValue): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.max(0, Math.min(10_000, Math.trunc(v)))
}

/** Read a string property without trusting it — used for LOOKUPS only. */
function readString(err: unknown, key: string): string {
  const v = (err as Record<string, unknown> | null | undefined)?.[key]
  return typeof v === 'string' ? v : ''
}

/**
 * Map an error onto the closed class set.
 *
 * Deliberately NOT a message regex: `err.message` is server text, and the only
 * reason a message-based classifier would be safe is that it returns literals
 * — which is a property of the return value, not of the input. Working from
 * structured, code-set fields (`err.code`, `authenticationFailed`) and from the
 * canonical `isTlsTrustError` predicate keeps the input side narrow too.
 */
export function classifyNetError(err: unknown): NetErrorClass {
  if (isTlsTrustError(err)) return 'cert'
  if ((err as { authenticationFailed?: unknown } | null | undefined)?.authenticationFailed === true) return 'auth'
  const code = readString(err, 'code').toUpperCase()
  if (code && Object.prototype.hasOwnProperty.call(CODE_CLASS, code)) return CODE_CLASS[code]
  const responseCode = readString(err, 'serverResponseCode').toUpperCase()
  if (responseCode && Object.prototype.hasOwnProperty.call(RESPONSE_CODE_CLASS, responseCode)) {
    return RESPONSE_CODE_CLASS[responseCode]
  }
  const status = readString(err, 'responseStatus').toUpperCase()
  if (status === 'NO' || status === 'BAD') return 'protocol'
  return 'unknown'
}

/** Prototype-chain classification. `err.name` is a writable public property
 *  and an arbitrary throw can set it to anything, including PII. */
function classifyNetErrorKind(err: unknown): NetErrorKind {
  if (err instanceof TypeError) return 'TypeError'
  if (err instanceof RangeError) return 'RangeError'
  if (err instanceof SyntaxError) return 'SyntaxError'
  if (err instanceof ReferenceError) return 'ReferenceError'
  if (err instanceof Error) return 'Error'
  return 'UnknownError'
}

/** Filter a context object down to allowlisted keys with valid values. */
export function sanitizeNetErrorContext(context: ContextInput): {
  safe: Record<string, string | number | boolean>
  dropped: number
} {
  const safe: Record<string, string | number | boolean> = {}
  let dropped = 0
  for (const [key, value] of Object.entries(context ?? {})) {
    if (value === undefined) continue
    const rule = Object.prototype.hasOwnProperty.call(CONTEXT_RULES, key) ? CONTEXT_RULES[key] : undefined
    const accepted = rule?.(value)
    if (accepted === undefined) { dropped += 1; continue }
    safe[key] = accepted
  }
  return { safe, dropped }
}

/** Seams so the unit suite can assert what would be transmitted. */
export interface NetErrorTelemetryDeps {
  capture: (error: Error, context: Record<string, unknown>) => void
  isTransient: (err: unknown) => boolean
}

const defaultDeps: NetErrorTelemetryDeps = {
  capture: (error, context) => captureException(error, context),
  isTransient: isTransientNetworkError,
}

/**
 * The `setNetErrorReporter` implementation. Fire-and-forget and never throws —
 * `packages/net` calls it from IDLE / sync / send paths (CLAUDE.md §8).
 *
 * Order matters:
 *   1. Transient network conditions are dropped HERE, against the RAW error.
 *      `beforeSend`'s transient filter matches the exception TEXT, and by the
 *      time our synthetic message reaches it the original `ECONNRESET` /
 *      `Socket timeout` wording is gone — so without this gate, sanitising the
 *      message would have quietly re-enabled the noise the filter exists to
 *      stop. Applying the predicate to the raw error also lets it walk `cause`
 *      chains, which is how imapflow failures actually arrive.
 *   2. Everything transmitted afterwards is built from literals in this file
 *      plus the allowlisted context.
 */
export function reportSanitizedNetError(
  source: string,
  err: unknown,
  context?: ContextInput,
  overrides?: Partial<NetErrorTelemetryDeps>,
): void {
  const deps = { ...defaultDeps, ...overrides }
  try {
    const safeSource = SOURCE_RE.test(source) ? source : 'unknown'
    const errorClass = classifyNetError(err)
    const transient = deps.isTransient(err)
    // Local-only diagnostics, on the user's own machine. The RAW error goes to
    // `debug` (console in dev, never the packaged file sink) so the persisted
    // warn line carries no server-controlled string (CLAUDE.md §8). Transient
    // conditions — a laptop lid, a VPN flap — stay at debug entirely: they
    // are not incidents, and one warn per reconnect would drown the log.
    try {
      if (!transient) log.warn('net error', { source: safeSource, errorClass })
      log.debug(`net error raw (${safeSource}, ${errorClass}, transient=${transient}):`, err)
    } catch { /* logging must never break telemetry */ }

    if (transient) return

    const { safe, dropped } = sanitizeNetErrorContext(context)
    // Synthetic and attacker-uncontrolled: message, name and every extra below
    // are literals or enum members produced in this file.
    const sanitized = new Error(`net_${safeSource}_${errorClass}`)
    sanitized.name = 'NetError'
    deps.capture(sanitized, {
      // `source` stays a top-level extra: electron/sentry.ts `beforeSend`
      // reads `extra.source` as a provenance marker (the keychain carve-out).
      source: safeSource,
      error_class: errorClass,
      error_kind: classifyNetErrorKind(err),
      context_dropped: dropped,
      ...safe,
    })
  } catch { /* telemetry must never throw into the IMAP/SMTP path */ }
}
