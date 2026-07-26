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
