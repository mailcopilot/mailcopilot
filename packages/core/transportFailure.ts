/**
 * Structural readers for two SMTP/IMAP connection failures the user can act on
 * (a refused STARTTLS upgrade, a failure before the server greeted us). The
 * verdicts travel as `starttls_required` / `pre_greeting` in the
 * error-presentation vocabulary (./errorPresentation).
 *
 * Why structural: nodemailer and ImapFlow overwrite `err.code` with their own
 * stage codes (`ESOCKET`, `ETLS`, `ETIMEDOUT`), so the OS errno name survives
 * only in the message text (and as the numeric `errno`), and the text of an
 * unreachable-network failure depends on WHICH address nodemailer happened to
 * try last. Matching `ENETUNREACH` in prose made the outcome depend on address
 * order; the stage (`command`, `syscall`) does not.
 *
 */

import { walkErrorTree } from './transientErrors'

/** `err.code` we stamp on a refused-upgrade error so later layers need no parsing. */
export const STARTTLS_REQUIRED_CODE = 'ERR_STARTTLS_REQUIRED'

function field(err: unknown, name: string): unknown {
  if (err === null || typeof err !== 'object') return undefined
  try {
    return (err as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

/**
 * The server would not (or could not) upgrade a plain connection to TLS, and
 * we required it. Recognises:
 *  - nodemailer: the server answered STARTTLS with a non-2xx reply
 *    (`ETLS`, stage `STARTTLS`, with a `response`), or rejected EHLO and the
 *    HELO fallback cannot offer the required STARTTLS;
 *  - ImapFlow: `doSTARTTLS: true` and no STARTTLS capability / refused upgrade
 *    (`tlsFailed`). The injection guard has its own code and is NOT this.
 * A TLS handshake failure after an accepted STARTTLS is a certificate problem,
 * not a refusal, and has no `response`.
 */
export function isStarttlsRefusal(err: unknown): boolean {
  if (field(err, 'code') === STARTTLS_REQUIRED_CODE) return true
  const message = String(field(err, 'message') ?? '')
  if (field(err, 'tlsFailed') === true && message === 'Server does not support STARTTLS') return true
  if (field(err, 'code') === 'ETLS' && field(err, 'command') === 'STARTTLS') {
    return typeof field(err, 'response') === 'string'
  }
  return field(err, 'command') === 'EHLO' && /does not support required STARTTLS/.test(message)
}

// nodemailer's own messages for the two timers that fire before the server
// has greeted (connection and greeting). Its mid-session socket timeout is the
// different, bare 'Timeout' and is deliberately not listed.
const PRE_GREETING_TIMEOUT_MESSAGES: ReadonlySet<string> = new Set([
  'Connection timeout',
  'Greeting never received',
])

// The failures of a multi-address connect arrive as ONE error. nodemailer hands
// Node several addresses (autoSelectFamily); when every attempt fails Node raises
// an AggregateError, and nodemailer stamps it `ESOCKET` / `CONN` with the
// first attempt's errno in `originalCode` and NO `syscall` of its own: the
// `syscall: 'connect'` lives on the members of `errors`.
function isAllConnectAttemptsFailed(err: unknown): boolean {
  const members = field(err, 'errors')
  return Array.isArray(members) && members.length > 0 && members.every((m) => field(m, 'syscall') === 'connect')
}

/**
 * The SMTP connection failed before the server greeted us, so nothing of the
 * message was transmitted: a DNS failure, a socket error from `connect(2)`
 * (`ENETUNREACH`, `EHOSTUNREACH`, `ECONNREFUSED`, ... — reported by nodemailer
 * as `ESOCKET` with `syscall: 'connect'`), a multi-address connect in which
 * EVERY attempt was a `connect(2)` failure (an aggregate with one member that
 * is anything else — a TLS or protocol error — is not this) or one of the two
 * pre-greeting timers. The same verdict whichever address was tried last.
 */
export function isPreGreetingFailure(err: unknown): boolean {
  if (field(err, 'command') !== 'CONN') return false
  const code = field(err, 'code')
  if (code === 'EDNS') return true
  if (code === 'ESOCKET') return field(err, 'syscall') === 'connect' || isAllConnectAttemptsFailed(err)
  if (code === 'ETIMEDOUT') return PRE_GREETING_TIMEOUT_MESSAGES.has(String(field(err, 'message') ?? ''))
  return false
}

// ImapFlow's two timers that fire before the server has greeted us:
// `GREETING_TIMEOUT` (16 s; the connection is up, TLS included, but no `* OK`
// arrives) and `CONNECT_TIMEOUT` (90 s; the TCP connect or the TLS handshake
// never completed). Both are stamped on `err.code`. The mid-session `ETIMEOUT`
// and the STARTTLS `UPGRADE_TIMEOUT` are NOT here: the server had greeted us.
const IMAP_PRE_GREETING_TIMER_CODES: ReadonlySet<string> = new Set(['GREETING_TIMEOUT', 'CONNECT_TIMEOUT'])

/**
 * The IMAP counterpart of `isPreGreetingFailure` for the two wait timers that
 * expire before the server's greeting. Same reading, same user sentence
 * (`pre_greeting`: a blocked port, a VPN, a server that accepts and stays
 * silent). It reads the code only, never the prose, and adds no timer: the
 * timers are the library's own.
 */
export function isImapPreGreetingTimeout(err: unknown): boolean {
  let found = false
  walkErrorTree(err, (node) => {
    const code = field(node, 'code')
    if (typeof code === 'string' && IMAP_PRE_GREETING_TIMER_CODES.has(code)) found = true
  })
  return found
}

/**
 * The TLS handshake after an accepted STARTTLS timed out (`ETIMEDOUT` on the
 * `CONN` stage, `timeoutType: 'UPGRADE_TIMEOUT'`, 'TLS handshake timed out').
 * The server has greeted us, but the upgrade precedes AUTH, MAIL and DATA, so
 * nothing of the message was transmitted and a retry is safe. Not a
 * pre-greeting failure (the greeting happened), hence its own predicate: the
 * address-fallback paths that rely on `isPreGreetingFailure` do not take it.
 */
export function isTlsUpgradeTimeout(err: unknown): boolean {
  if (field(err, 'command') !== 'CONN' || field(err, 'code') !== 'ETIMEDOUT') return false
  return field(err, 'timeoutType') === 'UPGRADE_TIMEOUT' || field(err, 'message') === 'TLS handshake timed out'
}

/**
 * The error was raised by the SMTP session itself (nodemailer stamps every
 * session failure with a `command` stage), as opposed to something that went
 * wrong around it — an OAuth token refresh, a missing configuration — before
 * the server was ever contacted. Every failure nodemailer's SMTP connection
 * raises goes through its `_formatError`, which always stamps a string
 * `command`; the check is pinned against the installed library by
 * packages/net/transportSecurity.real.test.ts.
 */
export function isSmtpSessionError(err: unknown): boolean {
  return typeof field(err, 'command') === 'string'
}

/**
 * The session broke AFTER the server was reached and WITHOUT a reply code to
 * judge by, so nobody can say whether the message was accepted: a socket
 * timeout (`Timeout`, `timeoutType: 'SOCKET_TIMEOUT'`), a socket I/O error
 * (`ECONNRESET`, `EPIPE`, ... — `ESOCKET` carrying `syscall: 'read'|'write'`,
 * not `connect`) or a silent close (`ECONNECTION` on the `CONN` stage). A
 * failure in EHLO or AUTH looks exactly like one after DATA, so the reading is
 * deliberately conservative: such a send must never be retried
 * automatically, and the user is told the message may have been delivered.
 *
 * A server reply code (4xx/5xx), a failure before the greeting
 * (`isPreGreetingFailure`), a refused STARTTLS and local failures (credentials,
 * envelope, and a certificate or pin rejection — which nodemailer reports as
 * `ESOCKET` on `CONN` with the TLS code in `originalCode` and NO `syscall`;
 * nothing was sent then, and the user must not be told otherwise) are all
 * outside this set.
 * packages/net/transportSecurity.real.test.ts pins every member against the
 * installed nodemailer.
 */
export function isDeliveryUndetermined(err: unknown): boolean {
  if (field(err, 'command') !== 'CONN') return false
  const reply = field(err, 'responseCode')
  if (reply !== undefined && reply !== null && reply !== false) return false
  const code = field(err, 'code')
  if (code === 'ECONNECTION') return true
  if (code === 'ESOCKET') {
    // Only a socket I/O error names its syscall. A TLS verification failure
    // (untrusted certificate, pin mismatch) is stamped ESOCKET too but has none.
    const syscall = field(err, 'syscall')
    return typeof syscall === 'string' && syscall !== 'connect'
  }
  if (code === 'ETIMEDOUT') {
    return field(err, 'timeoutType') === 'SOCKET_TIMEOUT' || field(err, 'message') === 'Timeout'
  }
  return false
}

// ---------------------------------------------------------------------------
// IMAP: which failures may be retried at the retry boundary
// ---------------------------------------------------------------------------

// Codes that say the CONNECTION is gone or never came up, with no verdict from
// the server on any command: Node's `connect(2)` / DNS / socket codes, and
// ImapFlow's own stage codes for a dead or closed-on-connect session. Matching
// them as codes (not as prose) is what lets an `AggregateError` with an EMPTY
// message — what Node raises when every address of a multi-address connect
// failed — be recognised: its diagnosis lives on `errors[]`, not in `message`.
const IMAP_CONNECTION_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'NoConnection',
  // ImapFlow: a command on a socket that is already gone (`exec`) or a fetch
  // whose socket died between responses. The old text match caught it as "closed".
  'EConnectionClosed',
  'ClosedAfterConnectTLS',
  'ClosedAfterConnectText',
])

// ImapFlow's wait timers (`CONNECT_TIMEOUT` 90 s, `GREETING_TIMEOUT` 16 s,
// `UPGRADE_TIMEOUT` 10 s, mid-session `ETIMEOUT` after the 30 s socket-idle
// budget) are deliberately NOT in the set above. Each of them has already spent
// its whole per-attempt budget when it fires, so a retry would multiply the
// wait the user sits through (a path that accepts the TCP connection and then
// stays silent would cost three full timers) for a path that has just shown
// itself to be hanging, not failing fast.

// Only for a node that carries NO code at all: plain `Error`s built by callers
// and by older library paths whose text is all there is. Same phrases the
// boundary has always matched, and the reason this is a fallback rather than
// the rule: a code-bearing node is judged by its code, never by its prose.
const LEGACY_CONNECTION_LOST_RE = /NoConnection|not usable|Unexpected close|closed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|ECONNABORTED/i

/**
 * The IMAP session failed at the connection level, so retrying on a fresh
 * connection is the right reading (the caller still has to rule out an
 * already-issued mutation — see `isImapOutcomeUndetermined`). Structural: it
 * walks the whole error tree (`errors[]`, `cause`) and looks at codes, so an
 * empty-message `AggregateError` and the errnos the old text match never
 * listed (`ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH`) are covered.
 *
 * Authentication and certificate failures are NOT this: an `authenticationFailed`
 * node anywhere in the tree vetoes the verdict (the caller classifies cert and
 * auth separately and before asking).
 */
export function isImapConnectionFailure(err: unknown): boolean {
  const scan = scanImapErrorTree(err)
  if (scan.vetoed) return false
  return scan.failureCode || (!scan.anyCode && scan.legacyText)
}

/**
 * Some node of the tree carries a connection-level code. The text of the error
 * is then NOT consulted for anything else: a message that merely mentions a
 * folder called `LOGIN` must not read as an authentication failure when the
 * structure already says what happened.
 */
export function hasImapConnectionFailureCode(err: unknown): boolean {
  return scanImapErrorTree(err).failureCode
}

function scanImapErrorTree(err: unknown): { failureCode: boolean; anyCode: boolean; vetoed: boolean; legacyText: boolean } {
  const scan = { failureCode: false, anyCode: false, vetoed: false, legacyText: false }
  walkErrorTree(err, (node) => {
    if (typeof node === 'string') {
      if (LEGACY_CONNECTION_LOST_RE.test(node)) scan.legacyText = true
      return
    }
    if (field(node, 'authenticationFailed') === true) scan.vetoed = true
    const code = field(node, 'code')
    if (typeof code === 'string' && code !== '') {
      scan.anyCode = true
      if (IMAP_CONNECTION_FAILURE_CODES.has(code)) scan.failureCode = true
      return
    }
    const message = field(node, 'message')
    if (typeof message === 'string' && LEGACY_CONNECTION_LOST_RE.test(message)) scan.legacyText = true
  })
  return scan
}

// Identity, not a property written onto the error: the boundary rethrows the
// ORIGINAL error (the outcome subscriber classifies it), so the verdict rides
// beside it. A WeakSet entry cannot leak the error and survives re-wrapping
// that keeps the object in a `cause` chain.
const outcomeUndetermined = new WeakSet<object>()

/**
 * Record that this failure struck AFTER a mutating command (MOVE, STORE,
 * EXPUNGE) had been sent: the connection died with the server's answer
 * outstanding, so nobody can say whether the change was applied. Same
 * reading as the SMTP rule in `isDeliveryUndetermined`, and the same
 * consequence: the retry boundary does not re-send within one operation. A
 * caller with its own retry loop (the offline replay, the mail-rules runner)
 * decides for itself; both retry on a LATER pass, which is what Thunderbird and
 * K-9 do. A repeated UID MOVE or STORE of the same flags is harmless; a move
 * on a server without MOVE (COPY, then delete) is not: see offlineReplay.ts.
 */
export function markImapOutcomeUndetermined(err: unknown): void {
  if (err !== null && typeof err === 'object') outcomeUndetermined.add(err)
}

/** True when `markImapOutcomeUndetermined` was called for the error or any node under it. */
export function isImapOutcomeUndetermined(err: unknown): boolean {
  let hit = false
  walkErrorTree(err, (node) => {
    if (node !== null && typeof node === 'object' && outcomeUndetermined.has(node)) hit = true
  })
  return hit
}
