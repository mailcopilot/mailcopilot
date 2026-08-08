/**
 * User-facing error presentation — closed vocabulary.
 *
 * Problem this solves (BACKLOG §2.127): the renderer used to render
 * `String(e)` of whatever crossed the IPC boundary, which on a dropped
 * connection reads "Sync error: Error: Error invoking remote method
 * 'net:inboxSummaries': AggregateError". `AggregateError` carries an EMPTY
 * `message` by construction — the substance lives in `.errors[]` — so the
 * user was shown a type name instead of "no connection to the server".
 *
 * Two hard constraints shape this module:
 *
 * 1. **The structure is destroyed at the IPC boundary.** Measured on
 *    Electron 40 with a real main+preload+renderer round trip: a handler that
 *    rejects with an AggregateError surfaces in the renderer as a brand-new
 *    plain `Error` whose only own properties are `message` and `stack`.
 *    `.errors[]`, `.code`, `.cause` and any custom own property added in main
 *    are all gone; only the text of `String(err)` survives, embedded in
 *    "Error invoking remote method '<channel>': <text>". Therefore
 *    classification MUST happen in the main process, where the real error
 *    object still exists, and the verdict has to travel inside the message —
 *    the single surviving carrier.
 *
 * 2. **Untrusted server text must not reach the UI.** What the user sees is
 *    selected from ERROR_PRESENTATION_KEYS — a closed enum — never from the
 *    error string. The raw text stays in the main-process log
 *    (`describeErrorForLog`) for diagnostics, and only there.
 *
 * There is no second error parser here: the AggregateError/cause unwrapping is
 * `walkErrorTree` from ./transientErrors, and the "is this network noise"
 * verdict is `isTransientNetworkError` from the same module. TRANSIENT_NET_RE
 * keeps its single home (CLAUDE.md §8); this file only *partitions* what that
 * module already recognises into buckets a human can read.
 */

import { isTransientNetworkError, walkErrorTree } from './transientErrors'

/**
 * The closed vocabulary. Everything the user can be told about a failed IPC
 * call is one of these; anything unrecognised collapses into 'unknown', which
 * is a neutral generic message — never an empty string.
 */
export const ERROR_PRESENTATION_KEYS = ['offline', 'timeout', 'auth', 'unknown'] as const

export type ErrorPresentationKey = (typeof ERROR_PRESENTATION_KEYS)[number]

const KEY_SET: ReadonlySet<string> = new Set<string>(ERROR_PRESENTATION_KEYS)

export function isErrorPresentationKey(value: unknown): value is ErrorPresentationKey {
  return typeof value === 'string' && KEY_SET.has(value)
}

/**
 * i18n keys the renderer must use for each vocabulary entry. Declared here so
 * the enum and its translations cannot drift apart silently.
 */
export const ERROR_PRESENTATION_I18N_KEYS: Readonly<Record<ErrorPresentationKey, string>> = {
  offline: 'app.errors.presented.offline',
  timeout: 'app.errors.presented.timeout',
  auth: 'app.errors.presented.auth',
  unknown: 'app.errors.presented.unknown',
}

// --- Classification --------------------------------------------------------

// Timeout is a SUB-PARTITION of what transientErrors.ts already recognises as
// network noise: these tokens also appear in NODE_NET_CODES/CHROMIUM_NET_CODES
// there, but that module answers "should telemetry ignore this?", while here we
// answer "which of four sentences do we show?". Anything transient that is not
// a timeout becomes 'offline', so this list is the only network vocabulary this
// file needs — the rest is delegated to isTransientNetworkError().
// `\btimeout` without a trailing boundary so `TimeoutError` (undici, node:test
// helpers) classifies too.
const TIMEOUT_RE = /ETIMEDOUT|ESOCKETTIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|\btimed out\b|\btimeout/i

// Credential rejections. IMAP/SMTP report these both structurally
// (imapflow `authenticationFailed` / `serverResponseCode`, nodemailer
// `code: 'EAUTH'`, SMTP `responseCode: 535`) and textually; the structural
// signals are checked first and the text list is deliberately short — it is a
// classification aid, never something the user is shown.
const AUTH_CODE_RE = /^(EAUTH|AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|INVALIDCREDENTIALS|EAUTHFAILED|535|534)$/i
const AUTH_TEXT_RE =
  /authenticationfailed|authorizationfailed|invalid credentials|authentication failed|invalid login or password|username and password not accepted|application-specific password required|invalid user(name)? or password|password is incorrect|login denied|\[AUTHENTICATIONFAILED\]/i

const MAX_LOG_LEN = 2048

interface NodeFields {
  text: string
  codes: string[]
  authFlag: boolean
}

function readNodeFields(node: unknown): NodeFields {
  if (typeof node === 'string') return { text: node, codes: [], authFlag: false }
  const out: NodeFields = { text: '', codes: [], authFlag: false }
  if (node === null || typeof node !== 'object') return out
  const o = node as Record<string, unknown>
  try {
    const msg = o.message
    const name = o.name
    out.text = typeof msg === 'string' && msg ? msg : typeof name === 'string' ? name : ''
    for (const field of ['code', 'serverResponseCode', 'responseCode'] as const) {
      const v = o[field]
      if (typeof v === 'string' && v) out.codes.push(v)
      else if (typeof v === 'number' && Number.isFinite(v)) out.codes.push(String(v))
    }
    out.authFlag = o.authenticationFailed === true
  } catch {
    // Exotic errors with throwing getters must not break the funnel.
  }
  return out
}

/**
 * Map a LIVE error object (main process, before the IPC boundary eats it) to
 * a vocabulary entry.
 *
 * Precedence: auth > timeout > offline > unknown. Auth wins because it is the
 * only verdict that tells the user to do something specific; timeout wins over
 * offline because "the server did not answer in time" is the more precise of
 * the two transient readings.
 */
export function classifyErrorPresentation(input: unknown): ErrorPresentationKey {
  let auth = false
  let timeout = false
  try {
    walkErrorTree(input, (node) => {
      const { text, codes, authFlag } = readNodeFields(node)
      if (authFlag) auth = true
      if (text) {
        if (AUTH_TEXT_RE.test(text)) auth = true
        if (TIMEOUT_RE.test(text)) timeout = true
      }
      for (const code of codes) {
        if (AUTH_CODE_RE.test(code)) auth = true
        if (TIMEOUT_RE.test(code)) timeout = true
      }
    })
  } catch {
    return 'unknown'
  }
  if (auth) return 'auth'
  if (timeout) return 'timeout'
  try {
    if (isTransientNetworkError(input)) return 'offline'
  } catch {
    return 'unknown'
  }
  return 'unknown'
}

// --- Encoding across the IPC boundary --------------------------------------

const PRESENTATION_TOKEN = 'mcerr'

// Recognised ONLY in the position the funnel can actually put it in — not
// anywhere in the string.
//
// `presentedIpcMessage` prepends the tag to the raw text, and Electron then
// wraps that message in its own envelope, so by the time the renderer sees it
// the tag sits at exactly one of these offsets:
//
//   [mcerr:auth] <text>                                          (no envelope:
//                                                    main-side use, unit tests)
//   Error invoking remote method '<channel>': Error: [mcerr:auth] <text>
//   Error: Error invoking remote method '<channel>': Error: [mcerr:auth] …
//                                       (when the value was stringified first)
//
// Anything further into the string was written by someone else. Searching the
// whole text — what this used to do — meant an error that never passed through
// the funnel but happened to CONTAIN "[mcerr:auth]" (server prose, a quoted
// log line, a filename) would be accepted as tagged. That is not reachable
// through `handleIpc` today, where our tag necessarily comes first, but the
// guarantee should come from the format rather than from the funnel being the
// only writer — the next error path added is not obliged to know that.
//
// Group 1 is the prefix we allow in front of the tag (kept so `strip` can put
// it back), group 2 is the key. The optional `<Name>Error: ` / `<Name>Exception: `
// segments are what `String(err)` prepends; the lengths are bounded so a
// hostile string cannot make this scan quadratically.
//
// A tag with an unknown key collapses to 'unknown' instead of falling back to
// text classification.
const NAME_PREFIX = String.raw`(?:[\w$]{0,60}(?:Error|Exception): )?`
const ENVELOPE_PREFIX = String.raw`(?:Error invoking remote method '[^']{0,200}': )?`
const PRESENTATION_RE = new RegExp(
  String.raw`^(\s*${NAME_PREFIX}${ENVELOPE_PREFIX}${NAME_PREFIX})\[mcerr:([a-z_]{1,32})\]`,
)

/** The machine-readable tag for `key`, e.g. `[mcerr:timeout]`. */
export function encodeErrorPresentation(key: ErrorPresentationKey): string {
  return `[${PRESENTATION_TOKEN}:${key}]`
}

function safeString(input: unknown): string {
  try {
    if (typeof input === 'string') return input
    return String(input)
  } catch {
    return ''
  }
}

function readText(input: unknown): string {
  if (typeof input === 'string') return input
  if (input !== null && typeof input === 'object') {
    try {
      const msg = (input as { message?: unknown }).message
      if (typeof msg === 'string' && msg) return msg
    } catch {
      /* fall through */
    }
  }
  return safeString(input)
}

/**
 * Build the message the main process re-throws across IPC:
 * `[mcerr:<key>] <original text>`.
 *
 * The tag is computed from the error OBJECT FIRST — codes
 * (`code` / `serverResponseCode` / `responseCode`), the `authenticationFailed`
 * flag, the AggregateError/cause tree — and only falls back to the two short
 * text patterns above (`AUTH_TEXT_RE`, `TIMEOUT_RE`) for servers that report
 * the same fact in prose alone. What the format change removed is the arms race
 * in the RENDERER: whatever the main process concluded, by whichever of the two
 * routes, travels as a tag, so the UI never re-derives a verdict from text.
 * The original text is kept after the tag
 * so DevTools still shows what happened; the UI reads the tag, not the text.
 * Keeping that text is also load-bearing for two existing renderer consumers —
 * see the note on `toPresentedIpcError` in electron/ipc.ts before trimming it.
 *
 * Never throws: a broken error object degrades to a bare tag.
 */
export function presentedIpcMessage(input: unknown): string {
  const key = classifyErrorPresentation(input)
  const tag = encodeErrorPresentation(key)
  let raw = ''
  try {
    // `String(undefined)` is the literal "undefined" — noise, not a cause.
    raw = input == null ? '' : typeof input === 'string' ? input : safeString(input)
  } catch {
    raw = ''
  }
  // Deliberately NOT truncated: the text already crossed the boundary
  // unbounded before this change, and the two substring consumers named above
  // would start missing their tokens in long messages if we clipped it here.
  return raw ? `${tag} ${raw}` : tag
}

/**
 * Renderer side: recover the vocabulary entry from whatever `invoke()`
 * rejected with. Reads the tag the main-process funnel embedded — only where
 * the funnel can have put it, see PRESENTATION_RE — and when there is no tag
 * there (errors raised before the funnel, e.g. the preload channel whitelist,
 * or plain renderer-side failures) falls back to classifying the value
 * directly, using the same single classifier.
 *
 * Always returns a key; `null`/`undefined`/unrecognised input yields 'unknown'.
 */
export function decodeErrorPresentation(input: unknown): ErrorPresentationKey {
  const text = readText(input)
  if (text) {
    const m = PRESENTATION_RE.exec(text)
    if (m) return isErrorPresentationKey(m[2]) ? m[2] : 'unknown'
  }
  return classifyErrorPresentation(input)
}

/**
 * Remove the machine tag from a string that is about to be shown verbatim
 * somewhere we have not yet migrated to the vocabulary (connection-test
 * results and similar diagnostics screens). Cosmetic only.
 *
 * Same position rule as `decodeErrorPresentation`: only a tag the funnel could
 * have written is removed, and the prefix it sat behind (the Electron envelope)
 * is put back. A `[mcerr:…]`-looking fragment inside third-party text is left
 * alone — it is part of that text, not our annotation.
 */
export function stripErrorPresentation(text: string): string {
  if (typeof text !== 'string') return ''
  return text.replace(PRESENTATION_RE, '$1').replace(/\s{2,}/g, ' ').trim()
}

// --- Diagnostics -----------------------------------------------------------

/**
 * Flatten an error tree into one log line.
 *
 * This is the reason the raw text is still recoverable at all: the funnel used
 * to log `err.message`, which is the EMPTY STRING for an AggregateError, so the
 * four production incidents left a log line with no cause in it. Here every
 * node of the tree contributes `<message> (<code>)`, deduplicated.
 *
 * Local log only — never Sentry (the Sentry path stays PII-free by sending a
 * synthetic event, see electron/sentry.ts). Never throws.
 */
export function describeErrorForLog(input: unknown): string {
  const parts: string[] = []
  const seen = new Set<string>()
  try {
    walkErrorTree(input, (node) => {
      const { text, codes } = readNodeFields(node)
      const code = codes.length > 0 ? codes[0] : ''
      const part = text && code ? `${text} (${code})` : text || (code ? `(${code})` : '')
      if (!part || seen.has(part)) return
      seen.add(part)
      parts.push(part)
    })
  } catch {
    /* fall through to the scalar fallback */
  }
  let out = parts.join(' | ')
  if (!out) out = safeString(input)
  if (!out) out = 'unknown error'
  if (out.length > MAX_LOG_LEN) out = `${out.slice(0, MAX_LOG_LEN)}…`
  return out
}
