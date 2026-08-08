/**
 * §2.23 PR1 — Sent-copy APPEND failure reporting.
 *
 * When SMTP delivery succeeds but the IMAP APPEND of the message copy into
 * the Sent folder fails, the catch block in `sendMailWithAccountConfig`
 * (electron/main.ts) calls `reportSentCopyAppendFailure()` to:
 *
 *   1. emit the typed `send_queue.append_failed` metric — PII-safe enum
 *      buckets only (reason classification + closed providerId union),
 *      never raw server text; and
 *   2. broadcast `mail:sentCopyFailed` to all windows so the renderer can
 *      surface a "delivered, but no Sent copy" toast (§2.23 AC c — the
 *      renderer subscription ships separately).
 *
 * Extracted into a service (CLAUDE.md §5 hotspot policy) so the
 * classification logic and the PII boundary are unit-testable without
 * booting the full electron/main.ts module graph.
 *
 * Both side effects are strictly fire-and-forget: SMTP already succeeded,
 * so nothing here may throw back into (or delay) the send path.
 */

import crypto from 'node:crypto'
import { recordEvent } from '../metrics'

export type SentCopyAppendReason =
  | 'auth'
  | 'network'
  | 'quota'
  | 'too_big'
  | 'server_refused'
  | 'unknown'

/** Mirrors `AccountConfig['providerId']` in @mailcopilot/types + fallback. */
export type SentCopyProvider = 'gmail' | 'outlook' | 'generic-imap' | 'unknown'

/**
 * Node/socket-level error codes that mean "the connection failed", not
 * "the server refused the APPEND". `NoConnectionAvailable` / `NoConnection`
 * are ImapFlow pool-level codes.
 */
const NETWORK_ERROR_CODE_RE =
  /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETDOWN|NoConnection(Available)?)$/i

/**
 * Classify an APPEND-to-Sent failure into a low-cardinality enum for the
 * `send_queue.append_failed.reason` tag (see DOMAINS.sent_copy_append_reason
 * in electron/metricsSchema.ts).
 *
 * Privacy: the input is an arbitrary error whose message / responseText can
 * carry server-supplied diagnostics (folder names, quota details, account
 * hints). The return value is ALWAYS one of six stable literals — never the
 * raw text. Callers must forward only the return value to telemetry.
 *
 * Classification order (most-specific signal first):
 *   1. RFC 5530 response codes ImapFlow surfaces as `serverResponseCode`.
 *   2. Socket-level error `code` (network bucket).
 *   3. Message heuristics (same spirit as smtpFailureKind in main.ts).
 *   4. Bare NO/BAD `responseStatus` → the server refused, reason unparsed.
 */
export function classifySentCopyAppendFailure(e: unknown): SentCopyAppendReason {
  const err = e as {
    code?: unknown
    responseStatus?: unknown
    serverResponseCode?: unknown
    message?: unknown
  } | null | undefined
  const code = typeof err?.code === 'string' ? err.code : ''
  const serverCode =
    typeof err?.serverResponseCode === 'string' ? err.serverResponseCode.toUpperCase() : ''
  const responseStatus =
    typeof err?.responseStatus === 'string' ? err.responseStatus.toUpperCase() : ''
  const msg = (
    typeof err?.message === 'string' ? err.message : e instanceof Error ? e.message : ''
  ).toLowerCase()

  // 1. RFC 5530 / provider response codes.
  if (
    serverCode === 'AUTHENTICATIONFAILED' ||
    serverCode === 'AUTHORIZATIONFAILED' ||
    serverCode === 'EXPIRED' ||
    serverCode === 'PRIVACYREQUIRED'
  ) return 'auth'
  if (serverCode === 'OVERQUOTA') return 'quota'
  if (serverCode === 'TOOBIG' || serverCode === 'LIMIT') return 'too_big'

  // 2. Socket-level codes.
  if (NETWORK_ERROR_CODE_RE.test(code)) return 'network'

  // 3. Message heuristics — assertImapAuth and OAuth refresh failures throw
  //    plain Errors without IMAP response metadata.
  if (/auth|credentials|password|login|xoauth/.test(msg)) return 'auth'
  if (/quota|storage limit|mailbox.*full/.test(msg)) return 'quota'
  if (/too large|message size|toobig/.test(msg)) return 'too_big'
  if (/timeout|timed out|network|enotfound|econn|offline|dns|socket|connection/.test(msg)) return 'network'

  // 4. Server said NO/BAD but none of the above matched.
  if (responseStatus === 'NO' || responseStatus === 'BAD') return 'server_refused'

  return 'unknown'
}

/**
 * Narrow an arbitrary providerId string to the closed metric domain.
 * `AccountConfig.providerId` is already 'gmail' | 'outlook' | 'generic-imap',
 * but legacy records may carry anything — never let an unexpected string
 * reach the tag (the IPC-bridge domain check would drop it; main-side
 * recordEvent would log a schema warning).
 */
export function normalizeSentCopyProviderId(providerId: string | null | undefined): SentCopyProvider {
  return providerId === 'gmail' || providerId === 'outlook' || providerId === 'generic-imap'
    ? providerId
    : 'unknown'
}

// --- Diagnostic payload -----------------------------------------------------
//
// §2.82 iter2 (finding 1) — the APPEND-failure diagnostics used to be built
// inline in electron/main.ts and handed to `captureException` verbatim. That
// object carried the Sent folder NAME, the outgoing Message-ID (which embeds
// the sender's domain and frequently the local part), and up to 500 characters
// of raw IMAP server response. The consent screen tells the user, without
// qualification, that folder names and addresses are never sent — so a single
// account with a persistently failing APPEND turned that promise into a
// standing leak, with no user action required to trigger it.
//
// The rule this builder enforces: every field is either an integer, a boolean,
// a length, a salted pseudonymous hash, or a value drawn from a closed set.
// Nothing third-party-controlled is forwarded as text.

const MESSAGE_ID_HASH_SALT = 'mailcopilot.v1.sent_copy_msgid'

// --- Closed vocabularies for the four structured error fields ---------------
//
// §2.82 iter3 (finding 1) — these fields used to be gated by a SHAPE test,
// `/^[A-Za-z0-9_-]{1,40}$/`. A shape is not an allowlist: `ALICE`, `SENT` and
// `IVANOV` all match it, so any short server-chosen string — a mailbox name a
// server echoes into a response code, an account label, a person's name —
// travelled out as a "protocol code". Excluding space, `@` and `.` is
// blocklist reasoning wearing an allowlist's name, and it is precisely the
// leak this builder exists to prevent, entering through a different door.
//
// So each field now carries a SET, drawn from RFC 3501 §7.1 / RFC 5530 / the
// common IMAP extensions, from the Node socket error codes, and from the codes
// ImapFlow itself assigns (`node_modules/imapflow/lib/*` — `NoConnection`,
// `CONNECT_TIMEOUT`, `APPENDLIMIT`, …). Membership, not resemblance.
//
// An unrecognised value is DROPPED, never truncated or hashed. `reason` (the
// six-literal classification above) carries the diagnosis either way, and the
// full text is still written to the local log on the user's own machine, so
// the cost is one lost dashboard facet on an unusual server — weighed against
// a leak we otherwise cannot bound. When a genuinely useful code turns out to
// be missing, adding the literal is a one-line reviewable change; that
// asymmetry is the point of failing this direction.

/** Tagged-response status (RFC 3501 §7.1). ImapFlow uppercases these. */
const RESPONSE_STATUSES: ReadonlySet<string> = new Set([
  'OK', 'NO', 'BAD', 'BYE', 'PREAUTH',
])

/**
 * Resp-text-codes we are willing to name. RFC 3501 §7.1 + RFC 5530 response
 * codes + extension codes we can actually receive (APPENDUID/COPYUID RFC 4315,
 * TOOBIG/APPENDLIMIT RFC 4469, CLOSED/HIGHESTMODSEQ/MODIFIED/NOMODSEQ
 * RFC 7162, USEATTR RFC 6154, MAILBOXID RFC 8474).
 */
const SERVER_RESPONSE_CODES: ReadonlySet<string> = new Set([
  // RFC 3501 §7.1
  'ALERT', 'BADCHARSET', 'CAPABILITY', 'PARSE', 'PERMANENTFLAGS',
  'READ-ONLY', 'READ-WRITE', 'TRYCREATE', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN',
  // RFC 5530
  'UNAVAILABLE', 'AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED',
  'PRIVACYREQUIRED', 'CONTACTADMIN', 'NOPERM', 'INUSE', 'EXPUNGEISSUED',
  'CORRUPTION', 'SERVERBUG', 'CLIENTBUG', 'CANNOT', 'LIMIT', 'OVERQUOTA',
  'ALREADYEXISTS', 'NONEXISTENT',
  // Extensions reachable on the APPEND path.
  'APPENDUID', 'COPYUID', 'UIDNOTSTICKY', 'TOOBIG', 'APPENDLIMIT',
  'CLOSED', 'HIGHESTMODSEQ', 'MODIFIED', 'NOMODSEQ', 'NOTSAVED',
  'COMPRESSIONACTIVE', 'HASCHILDREN', 'USEATTR', 'MAILBOXID', 'REFERRAL',
  'BADCOMPARATOR', 'UNKNOWN-CTE', 'METADATA', 'NOTIFICATIONOVERFLOW',
])

/**
 * Error `code` values: Node/OpenSSL socket-level codes plus the codes ImapFlow
 * and our own connection pool assign. Deliberately excludes `ParserErrorNN`
 * (an open-ended family) — those classify as `unknown` and stay in the log.
 */
const ERROR_CODES: ReadonlySet<string> = new Set([
  // Node socket / DNS.
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'EADDRNOTAVAIL', 'EADDRINUSE', 'ECANCELED', 'EAGAIN', 'EACCES', 'EPROTO',
  'EMFILE', 'ENOMEM', 'ERR_STREAM_PREMATURE_CLOSE',
  // TLS / OpenSSL.
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  // ImapFlow (lib/imap-flow.js, lib/commands/*).
  'NOCONNECTION', 'ECONNECTIONCLOSED', 'ETIMEOUT', 'ETHROTTLE',
  'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'LOCKTIMEOUT',
  'INVALIDRESPONSE', 'LINETOOLARGE', 'LITERALTOOLARGE', 'NOTFOUND',
  'MISSINGSERVEREXTENSION', 'MAX_IMAP_NESTING_REACHED', 'STARTTLS_INJECTION',
  'STATELOGOUT',
  // Our per-account pool (packages/net) — see NETWORK_ERROR_CODE_RE above.
  'NOCONNECTIONAVAILABLE',
])

/** IMAP command names (RFC 3501 + the extensions we issue). */
const COMMANDS: ReadonlySet<string> = new Set([
  'APPEND', 'SELECT', 'EXAMINE', 'CREATE', 'DELETE', 'RENAME', 'SUBSCRIBE',
  'UNSUBSCRIBE', 'LIST', 'LSUB', 'STATUS', 'FETCH', 'STORE', 'COPY', 'MOVE',
  'SEARCH', 'SORT', 'THREAD', 'UID', 'EXPUNGE', 'CLOSE', 'UNSELECT', 'CHECK',
  'NOOP', 'IDLE', 'DONE', 'LOGIN', 'AUTHENTICATE', 'LOGOUT', 'CAPABILITY',
  'NAMESPACE', 'STARTTLS', 'ENABLE', 'ID', 'COMPRESS', 'GETQUOTA',
  'GETQUOTAROOT', 'SETQUOTA',
])

/**
 * Keep a value only if it is a MEMBER of the field's closed vocabulary.
 * Case and surrounding whitespace are normalised first (servers are
 * inconsistent about both); nothing else about the string is negotiable.
 */
function allowedToken(v: unknown, vocabulary: ReadonlySet<string>): string | undefined {
  if (typeof v !== 'string') return undefined
  const token = v.trim().toUpperCase()
  return vocabulary.has(token) ? token : undefined
}

function textLength(v: unknown): number | undefined {
  return typeof v === 'string' ? v.length : undefined
}

/**
 * Domain-separated short hash of the outgoing Message-ID — a PSEUDONYMOUS
 * label, not an anonymisation.
 *
 * Kept (rather than dropped outright) because repeated APPEND failures need to
 * be distinguishable from one message retried N times, and that is the only
 * question this identifier answers.
 *
 * §2.82 iter3 (finding 3) — it is deliberately NOT described as irreversible
 * any more, because it is not. The salt is a constant in this file's source,
 * and a Message-ID is low-entropy and highly structured (a counter, a UUID or a
 * timestamp, plus the sending domain), so anyone holding a candidate value can
 * confirm it by recomputing the digest — the ordinary dictionary attack on a
 * hashed low-entropy input. What the hash buys is that the raw header, which
 * spells the sender's domain out in plain text, is not in the payload, and that
 * the label cannot be joined against anything outside this one metric. Under
 * GDPR recital 26 that is pseudonymisation, and the consent screen is worded
 * accordingly.
 */
function hashMessageId(messageId: unknown): string | undefined {
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined
  try {
    return crypto.createHash('sha256')
      .update(MESSAGE_ID_HASH_SALT).update('|').update(messageId)
      .digest('hex').slice(0, 12)
  } catch {
    return undefined
  }
}

/** PII-free diagnostics for a failed APPEND-to-Sent. Every value is safe to send. */
export interface SentCopyAppendDiag {
  accountId: number
  providerId: SentCopyProvider
  /**
   * The ROLE of the target folder, never its name. `'sent'` when role detection
   * resolved a folder, `null` when it did not (which is itself the diagnosis).
   * Roles are the granularity the consent screen discloses ("only the general
   * kind of folder, such as Inbox or Trash").
   */
  sentFolderRole: 'sent' | null
  /** Length of the folder name — enough to tell an empty/odd value apart. */
  sentFolderLen?: number
  /** Byte size of the message we tried to APPEND (drives the too_big bucket). */
  rawSize: number | null
  /**
   * Salted, truncated SHA-256 of the Message-ID — a pseudonymous label, not an
   * anonymisation. See `hashMessageId` for what it does and does not protect.
   */
  messageIdHash?: string
  /** Closed enum from `classifySentCopyAppendFailure`. */
  reason: SentCopyAppendReason
  /**
   * The four structured protocol fields. Each is present ONLY when the value
   * is a member of that field's closed vocabulary (`ERROR_CODES`,
   * `RESPONSE_STATUSES`, `SERVER_RESPONSE_CODES`, `COMMANDS`); anything else
   * — including a short, innocuous-LOOKING string such as a mailbox name — is
   * dropped rather than forwarded.
   */
  errorCode?: string
  errorResponseStatus?: string
  errorServerResponseCode?: string
  errorCommand?: string
  /**
   * Length of the server's response text / error message instead of the text.
   *
   * Not "the text passed through a scrubber": a scrubber can only remove shapes
   * it recognises, and an IMAP NO is free-form — it can name the mailbox, quote
   * the subject, or spell out a policy that identifies the account. An
   * allowlist of structured fields is the only formulation that keeps the
   * screen's promise for inputs we have never seen. The full text is still
   * written to the local log on the user's own machine.
   */
  errorTextLen?: number
}

/**
 * Build the PII-free diagnostics for a failed APPEND-to-Sent.
 *
 * Used for BOTH sinks — the local `log.warn` and the Sentry capture — so there
 * is exactly one definition of what this failure is allowed to say, and a
 * future field cannot be added to one sink without the other.
 */
export function buildSentCopyAppendDiag(
  e: unknown,
  ctx: SentCopyFailureContext & { rawSize?: number | null; messageId?: string | null },
): SentCopyAppendDiag {
  const err = e as {
    code?: unknown
    response?: unknown
    responseStatus?: unknown
    responseText?: unknown
    serverResponseCode?: unknown
    command?: unknown
    message?: unknown
  } | null | undefined
  const message = typeof err?.message === 'string'
    ? err.message
    : e instanceof Error ? e.message : undefined
  // Longest of the free-form fields — one number that says "the server did say
  // something" without saying what.
  const textLen = Math.max(
    textLength(message) ?? 0,
    textLength(err?.response) ?? 0,
    textLength(err?.responseText) ?? 0,
  )
  const folder = typeof ctx.sentFolder === 'string' ? ctx.sentFolder : null
  return {
    accountId: ctx.accountId,
    providerId: normalizeSentCopyProviderId(ctx.providerId),
    sentFolderRole: folder ? 'sent' : null,
    ...(folder ? { sentFolderLen: folder.length } : {}),
    rawSize: typeof ctx.rawSize === 'number' ? ctx.rawSize : null,
    ...(hashMessageId(ctx.messageId) ? { messageIdHash: hashMessageId(ctx.messageId) } : {}),
    reason: classifySentCopyAppendFailure(e),
    ...(allowedToken(err?.code, ERROR_CODES) ? { errorCode: allowedToken(err?.code, ERROR_CODES) } : {}),
    ...(allowedToken(err?.responseStatus, RESPONSE_STATUSES) ? { errorResponseStatus: allowedToken(err?.responseStatus, RESPONSE_STATUSES) } : {}),
    ...(allowedToken(err?.serverResponseCode, SERVER_RESPONSE_CODES) ? { errorServerResponseCode: allowedToken(err?.serverResponseCode, SERVER_RESPONSE_CODES) } : {}),
    ...(allowedToken(err?.command, COMMANDS) ? { errorCommand: allowedToken(err?.command, COMMANDS) } : {}),
    ...(textLen > 0 ? { errorTextLen: textLen } : {}),
  }
}

export type SentCopyFailureContext = {
  /** Small-integer DB account id — never the email address. */
  accountId: number
  providerId?: string | null
  /** Resolved Sent folder path, if role detection got that far. */
  sentFolder?: string | null
}

/**
 * Emit the `send_queue.append_failed` metric and the `mail:sentCopyFailed`
 * broadcast. Fire-and-forget by contract — swallows every failure.
 *
 * PII boundary:
 *   - metric tags: enum buckets only (reason + normalized providerId);
 *   - broadcast payload: ONLY `{ accountId, folder }` — the integer account
 *     id and the Sent folder path the APPEND targeted. No messageId, no
 *     recipient addresses, no subject, no body, no raw server error text.
 */
export function reportSentCopyAppendFailure(
  e: unknown,
  ctx: SentCopyFailureContext,
  broadcastFn: (channel: string, payload: unknown) => void,
): void {
  // recordEvent is internally guarded, but keep belt-and-braces so a future
  // metrics.ts refactor can never leak an exception into the send path.
  try {
    recordEvent('send_queue.append_failed', {
      reason: classifySentCopyAppendFailure(e),
      provider_id: normalizeSentCopyProviderId(ctx.providerId),
    })
  } catch { /* telemetry must never break the send path */ }
  try {
    broadcastFn('mail:sentCopyFailed', {
      accountId: ctx.accountId,
      folder: ctx.sentFolder ?? null,
    })
  } catch { /* renderer notification is best-effort */ }
}
