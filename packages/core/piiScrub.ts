// §2.82 — PII scrubbing for outgoing Sentry envelopes.
//
// The OS account name is embedded in almost every path a desktop app touches
// (`/home/ivan/...`, `/Users/ivan/...`, `C:\Users\Иван\...`), and packaged
// installs live under the user's home on all three platforms — so this is the
// common case, not an edge case. Under GDPR art. 4(1) that name is personal
// data, and shipping it would make the "we only send aggregates" claim in
// CLAUDE.md §8 untrue.
//
// This module owns the PLATFORM-INDEPENDENT half of the job so the main
// process (electron/sentry.ts) and the renderer (src/sentry.ts) cannot drift:
// the shape-based regexes and the list of event fields that are allowed to
// carry a path. The main process layers one extra rule on top — literal
// `os.homedir()` substitution — which the sandboxed renderer has no way to
// compute; that is why the entry point takes the scrub function as a
// parameter instead of hardcoding it.
//
// It also owns the second shape rule the two processes must agree on: email
// address redaction (§2.82 iter2). The consent screen promises unconditionally
// that addresses are never sent, and third-party failure text is the channel
// that breaks that promise — see EMAIL_RE below.
//
// Deliberately NOT a blind recursive regex sweep over the whole event object:
// that is expensive on large events, rewrites fields whose semantics we do not
// control, and silently changes behaviour whenever the SDK adds a field. We
// walk a KNOWN list of path-bearing fields, and only the free-form containers
// inside that list (`extra`, `contexts`, `breadcrumbs[].data`) get a
// depth- and node-bounded walk.

const USER_PLACEHOLDER = '<user>'

// The user-directory prefix. Windows: any drive letter, `\` or `/`, tolerating
// the doubled backslashes seen in JSON-escaped paths. POSIX: `/home/` (Linux)
// and `/Users/` (macOS).
//
// The name segment is three ordered alternatives, and the ordering is the
// whole design:
//
//   1. `[^\\/:'"<>\r\n]{1,120}?(?=[\\/])` — everything up to the NEXT path
//      separator. Spaces are allowed here, which is the fix for `C:\Users\John
//      Doe\AppData\...`: the old single-token class stopped at the space and
//      left `Doe` in the payload. A path separator is a real terminator, so
//      this cannot run off into surrounding prose. `:` is excluded so a match
//      can never swallow the `C:` of a SECOND path in the same string (which
//      would leave that second path unscrubbed).
//   2. `[^\\/:'"<>\r\n]{1,120}?(?=['"])` — everything up to a closing quote,
//      for the terminal form `open '/home/john doe'` where no separator
//      follows. Quotes are how fs/OS errors delimit paths in practice.
//   3. `[^\\/\s:'"()<>]+` — the conservative single token, for a bare path at
//      the end of a message with nothing after it.
//
// Residual (accepted, documented): a spaced account name in a path that is
// neither followed by a separator nor quoted (`... C:\Users\John Doe` at end of
// line) still degrades to alternative 3 and leaks the second word. In the main
// process the literal-homedir rule covers the real user's own home regardless
// of shape; in the renderer, frames are bundle URLs. Widening alternative 3 to
// span spaces would make every trailing sentence disappear into `<user>`, and
// that trade (unreadable diagnostics for a shape we do not observe) is worse.
//
// All classes exclude `<` and `>`, so an already-scrubbed `<user>` can never
// match again — the function is idempotent by construction.
const NAME_SEGMENT = "(?:[^\\\\/:'\"<>\\r\\n]{1,120}?(?=[\\\\/])|[^\\\\/:'\"<>\\r\\n]{1,120}?(?=['\"])|[^\\\\/\\s:'\"()<>]+)"

const WINDOWS_USER_PATH_RE = new RegExp(`([A-Za-z]:[\\\\/]{1,2}Users[\\\\/]{1,2})${NAME_SEGMENT}`, 'g')
const POSIX_USER_PATH_RE = new RegExp(`((?:/home|/Users)/)${NAME_SEGMENT}`, 'g')

/**
 * Replace the OS account name in a path-bearing string with `<user>`.
 *
 * Shape-based only — it knows nothing about the machine it runs on, so both
 * processes get identical results for identical input. Pure and idempotent.
 */
export function scrubUserPathsShape(value: string): string {
  if (!value) return value
  return value
    .replace(WINDOWS_USER_PATH_RE, (_m, prefix: string) => `${prefix}${USER_PLACEHOLDER}`)
    .replace(POSIX_USER_PATH_RE, (_m, prefix: string) => `${prefix}${USER_PLACEHOLDER}`)
}

const EMAIL_PLACEHOLDER = '<email>'

// §2.82 iter2 — the consent screen states, without qualification, that email
// addresses are never sent. Paths are not the only way one arrives: the TEXT of
// an IMAP/SMTP/OAuth failure routinely names the mailbox it failed for
// ("AUTHENTICATIONFAILED for ivan@example.com", Azure `error_description`
// inlining a UPN, an over-quota NO naming the account). Individual call sites
// are being converted to synthetic, attacker-uncontrolled exceptions one by
// one, but every site not yet converted forwards a third-party string verbatim,
// and each new `captureException(err, …)` re-opens the hole.
//
// So the promise is also enforced at the LAST stop before the transport, where
// it holds regardless of which call site produced the event. This is a net, not
// a substitute for sanitizing at the source: it can only recognise the address
// SHAPE, so a leak in another shape (a folder name, a subject) still has to be
// stopped at the call site.
//
// The local-part PUNCTUATION is the practical set (`._%+'-`), NOT the full
// RFC 5322 `atext`. Including `=`, `&` and friends is technically more correct
// but makes the match run backwards through the surrounding text: `to=a@b.io`
// would redact as `<email>`, swallowing the `to=` label that tells a reader
// which side of an SMTP transaction failed. A local part using those characters
// still loses its `@domain.tld` — the identifying half — so the residual is a
// leading fragment, not an address.
//
// The right side requires a dotted TLD so ordinary prose containing `@`
// (`@types/node`, `root@localhost`) is left alone. `<email>` contains no `@`,
// so the function is idempotent by construction.
//
// ── Two changes, both forced by the IDN address work ──────────────────────
//
// (1) LETTERS, NOT ASCII. The pattern used `A-Za-z0-9` on both sides, so
// `иван@example.com`, `user@почта.рф` and `пользователь@почта.рф` travelled to
// Sentry in full. That was survivable only while such a mailbox could not be
// stored at all (the account schema rejected it); once it could, the promise
// on the consent screen — addresses are never sent — stopped being true for
// exactly the locale this app is written in. Classes are now
// `\p{L}\p{N}\p{M}`: letters, digits, and the combining marks that attach to
// them. Marks are not decoration — in Devanagari (`डाटामेल.भारत`) a mark sits
// INSIDE an ordinary label, and a class without them stops the match mid-label
// and then fails the whole address, i.e. redacts nothing at all.
//
// The TLD keeps its letters-only rule (that is what makes `root@localhost` and
// bare prose safe) with ONE addition: the RFC 5890 ACE form `xn--…`, which is
// letters AND digits by construction. Without it the most common real IDN
// spelling, `info@xn--80a1acny.xn--p1ai`, matched only up to `…xn` and left
// `--p1ai` behind — a partial redaction that looked like a working one.
//
// (2) EVERY QUANTIFIER IS BOUNDED. The previous pattern used `+` and `*` with
// adjacent overlapping classes (`[A-Za-z0-9-]*[A-Za-z0-9]`), which is
// quadratic in the input length. Measured on this machine, the OLD pattern on
// a reachable input (`'a@' + 'b'.repeat(n)` — reachable because the `@` check
// below only rejects strings with no `@` at all): 102 ms at 12.5k chars,
// 435 ms at 25k, 1750 ms at 50k, 6754 ms at 100k — a clean ×4 per doubling.
// This runs inside `beforeSend` in the MAIN process, so that is the IDLE loop,
// the send queue and every IPC handler frozen on a long string somebody else
// wrote. Simply widening the classes to `\p{L}` made it far worse rather than
// better: the ASCII classes failed instantly on Cyrillic, the unicode ones do
// not, and the same 100k input went to 115 SECONDS.
//
// The bounds are the RFC 5321 limits, so they are narrowing nothing real: 64
// for the local part, 63 per label (`1 + 61 + 1`), and a label count cap that
// buys the constant-per-`@` cost the linearity argument needs — a domain with
// 26 dot-separated labels is not an address anyone needs redacted. Measured
// after the change, same machine: 75 ms at 50k, 156 ms at 100k, 326 ms at 200k,
// 634 ms at 400k — linear, and ~370× faster than the old pattern at 100k.
// Pinned by `piiScrub.test.ts`; if a future edit reintroduces an unbounded
// quantifier here, that test is the one that fails.
const ADDR_CHARS = '\\p{L}\\p{N}\\p{M}'
/** One dot-separated label: starts and ends alphanumeric, hyphens inside. */
const ADDR_LABEL = `[${ADDR_CHARS}](?:[${ADDR_CHARS}-]{0,61}[${ADDR_CHARS}])?`
/** Letters-only TLD, plus the RFC 5890 ACE (`xn--`) form of an IDN one. */
const ADDR_TLD = '(?:xn--[\\p{L}\\p{N}]{1,59}|[\\p{L}\\p{M}]{2,63})'
const EMAIL_RE = new RegExp(
  `[${ADDR_CHARS}._%+'-]{1,64}@${ADDR_LABEL}(?:\\.${ADDR_LABEL}){0,24}\\.${ADDR_TLD}`,
  'gu',
)

/**
 * Replace anything shaped like an email address with `<email>`.
 *
 * Pure and idempotent. Exported for unit tests and for call sites that need to
 * sanitize a string before it reaches a log; production event scrubbing applies
 * it automatically inside {@link scrubEventPiiWith}.
 */
export function scrubEmailAddressesShape(value: string): string {
  if (!value || !value.includes('@')) return value
  return value.replace(EMAIL_RE, EMAIL_PLACEHOLDER)
}

/** Minimal structural view of the parts of an event we rewrite. */
interface StackFrame {
  filename?: unknown
  abs_path?: unknown
  module?: unknown
  /** Sentry's own pre-rendered source context line — can quote a path. */
  context_line?: unknown
}

interface Stacktrace { frames?: StackFrame[] }

interface ExceptionValue {
  /** The exception TEXT. `EACCES: permission denied, open '/home/ivan/…'`. */
  value?: unknown
  stacktrace?: Stacktrace
}

interface Breadcrumb {
  message?: unknown
  data?: unknown
}

/**
 * `event.request`. The renderer runs under BrowserTracing and Electron serves
 * the window with `loadFile`, so `request.url` is a `file://` URL into the
 * installation directory — which on a Windows per-user install is always
 * `C:\Users\<name>\AppData\Local\…`. That is the default configuration on the
 * most common platform, not an edge case.
 */
interface RequestLike {
  url?: unknown
  query_string?: unknown
  data?: unknown
  headers?: unknown
  cookies?: unknown
  env?: unknown
}

/**
 * One entry of `event.spans` on a transaction envelope. `description` is the
 * free-form label of a measurement (for a pageload/navigation span that is the
 * route, i.e. the same file path as `request.url`).
 */
interface SpanLike {
  description?: unknown
  data?: unknown
}

/** The fields of a Sentry event/transaction this module rewrites. */
export interface ScrubbableEvent {
  /** Envelope kind. `'feedback'` is carved out — see `scrubEventPiiWith`. */
  type?: unknown
  user?: { ip_address?: string | null } & Record<string, unknown>
  exception?: { values?: ExceptionValue[] }
  threads?: { values?: ExceptionValue[] }
  message?: unknown
  logentry?: { message?: unknown; formatted?: unknown; params?: unknown }
  culprit?: unknown
  /** Transaction NAME. For a pageload transaction this is the URL path. */
  transaction?: unknown
  request?: RequestLike
  spans?: unknown
  breadcrumbs?: unknown
  extra?: unknown
  contexts?: unknown
  tags?: unknown
}

// Bounds for the free-form containers (`extra`, `contexts`, breadcrumb data).
// Sentry events are small by design; these caps exist so a pathological
// payload (a deeply nested object, a huge array) cannot turn a beforeSend hook
// into a latency problem on the transport path.
const MAX_DEPTH = 4
const MAX_NODES = 500

/**
 * Rewrite every string inside a free-form container, bounded in depth and in
 * total visited nodes. Mutates arrays/objects in place.
 */
function scrubContainer(node: unknown, scrub: (s: string) => string, budget: { left: number }, depth: number): unknown {
  if (budget.left <= 0 || depth > MAX_DEPTH) return node
  if (typeof node === 'string') {
    budget.left -= 1
    return scrub(node)
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (budget.left <= 0) break
      budget.left -= 1
      node[i] = scrubContainer(node[i], scrub, budget, depth + 1)
    }
    return node
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      if (budget.left <= 0) break
      budget.left -= 1
      obj[key] = scrubContainer(obj[key], scrub, budget, depth + 1)
    }
    return obj
  }
  return node
}

function scrubStringField<T extends object, K extends keyof T>(target: T, key: K, scrub: (s: string) => string): void {
  const v = target[key]
  if (typeof v === 'string') target[key] = scrub(v) as T[K]
}

function scrubExceptionValues(values: ExceptionValue[] | undefined, scrub: (s: string) => string): void {
  for (const value of values ?? []) {
    if (!value || typeof value !== 'object') continue
    // The exception TEXT is the most common real leak path: fs/OS errors embed
    // the full path (`EACCES: permission denied, open '/home/ivan/…'`) and it
    // is also what Sentry shows as the issue title.
    scrubStringField(value, 'value', scrub)
    for (const frame of value.stacktrace?.frames ?? []) {
      if (!frame || typeof frame !== 'object') continue
      scrubStringField(frame, 'filename', scrub)
      scrubStringField(frame, 'abs_path', scrub)
      scrubStringField(frame, 'module', scrub)
      scrubStringField(frame, 'context_line', scrub)
    }
  }
}

/**
 * Strip the IP address, the OS account name and email addresses from an
 * outgoing event.
 *
 * `scrub` is the per-process PATH rewriter: the renderer passes
 * `scrubUserPathsShape`, the main process passes a wrapper that also replaces
 * the literal `os.homedir()`. Address redaction is added here rather than by
 * the caller so neither process can ship an event without it.
 *
 * Carve-out: `type === 'feedback'`. The Settings → About feedback form sends an
 * address the user typed in ON PURPOSE so we can reply, and the consent screen
 * names it as the single exception to "addresses are never sent". Redacting it
 * would silently break the reply path. Everything else about a feedback
 * envelope is still scrubbed. (Today @sentry/*'s feedback envelope does not
 * route through `beforeSend`, so this branch is defence in depth against that
 * changing — it costs one comparison.)
 *
 * Mutates in place and returns the same object (Sentry's beforeSend contract
 * expects the event back). Wrapped end-to-end: a shape we did not anticipate
 * must never turn telemetry into a crash (CLAUDE.md §8).
 */
/** The fields of a Sentry structured log this module rewrites. */
export interface ScrubbableLog {
  /**
   * `ParameterizedString` — a plain string for ordinary calls, a boxed
   * `String` carrying template metadata when built with `Sentry.logger.fmt`.
   */
  message?: unknown
  attributes?: unknown
}

/**
 * Strip the OS account name and email addresses from an outgoing structured
 * log (`beforeSendLog`).
 *
 * §2.82 iter4 (security finding 3). Structured logs are a SEPARATE transmission
 * surface from events: they do not pass through `beforeSend`, so none of the
 * event scrubbing applied to them. Their attributes carry free-form strings —
 * the AI model id is typed by the user in Settings and can be any text, tool
 * names come from MCP servers — and the SDK itself adds
 * `sentry.message.parameter.N` attributes holding the interpolated values of a
 * `fmt` template plus `user.email` when a scope has one. All of that is walked
 * here with the same scrub function the event path uses, so the two surfaces
 * cannot disagree about what "scrubbed" means.
 *
 * A boxed `String` message is replaced with a plain scrubbed string: the SDK
 * has already copied the template and its values into `attributes` by the time
 * `beforeSendLog` runs (see `@sentry/core` logs/internal), so nothing is lost —
 * and those copies are scrubbed here too.
 *
 * Mutates in place and returns the same object (the `beforeSendLog` contract
 * expects the log back). Wrapped end-to-end: telemetry must never throw.
 */
export function scrubLogPiiWith<T>(logRecord: T, scrub: (s: string) => string): T {
  try {
    const l = logRecord as ScrubbableLog
    const s = (v: string) => scrubEmailAddressesShape(scrub(v))
    if (typeof l.message === 'string') l.message = s(l.message)
    else if (l.message instanceof String) l.message = s(String(l.message))
    l.attributes = scrubContainer(l.attributes, s, { left: MAX_NODES }, 1)
  } catch { /* telemetry must never throw */ }
  return logRecord
}

export function scrubEventPiiWith<T>(event: T, scrub: (s: string) => string): T {
  try {
    const e = event as ScrubbableEvent
    const s: (v: string) => string = e.type === 'feedback'
      ? scrub
      : (v: string) => scrubEmailAddressesShape(scrub(v))
    // Explicit null, not delete: `null` is the documented "do not infer the IP
    // from the request" signal; an absent field falls back to inference.
    e.user = { ...(e.user ?? {}), ip_address: null }
    scrubExceptionValues(e.exception?.values, s)
    // Node's SDK can attach thread stacks with the same frame shape.
    scrubExceptionValues(e.threads?.values, s)
    scrubStringField(e, 'message', s)
    scrubStringField(e, 'culprit', s)
    // Transaction NAME — for a `pageload` / `navigation` transaction the SDK
    // derives it from the location, which under `loadFile` is a filesystem
    // path. It is also the primary grouping key in Sentry's Performance UI, so
    // an unscrubbed one puts the OS account name on a dashboard label.
    scrubStringField(e, 'transaction', s)
    if (e.logentry && typeof e.logentry === 'object') {
      scrubStringField(e.logentry, 'message', s)
      scrubStringField(e.logentry, 'formatted', s)
      const budget = { left: MAX_NODES }
      e.logentry.params = scrubContainer(e.logentry.params, s, budget, 1)
    }
    if (e.request && typeof e.request === 'object') {
      const req = e.request
      const budget = { left: MAX_NODES }
      scrubStringField(req, 'url', s)
      // The remaining request members are free-form (string, array of tuples,
      // or record depending on SDK and integration) — walk them as containers.
      req.query_string = scrubContainer(req.query_string, s, budget, 1)
      req.headers = scrubContainer(req.headers, s, budget, 1)
      req.cookies = scrubContainer(req.cookies, s, budget, 1)
      req.data = scrubContainer(req.data, s, budget, 1)
      req.env = scrubContainer(req.env, s, budget, 1)
    }
    if (Array.isArray(e.spans)) {
      const budget = { left: MAX_NODES }
      for (const span of e.spans as SpanLike[]) {
        if (!span || typeof span !== 'object') continue
        scrubStringField(span, 'description', s)
        span.data = scrubContainer(span.data, s, budget, 1)
      }
    }
    if (Array.isArray(e.breadcrumbs)) {
      const budget = { left: MAX_NODES }
      for (const crumb of e.breadcrumbs as Breadcrumb[]) {
        if (!crumb || typeof crumb !== 'object') continue
        scrubStringField(crumb, 'message', s)
        crumb.data = scrubContainer(crumb.data, s, budget, 1)
      }
    }
    // Free-form containers our own code writes: `extra` (captureException
    // context), `contexts` (SDK + custom), `tags`. All three routinely carry
    // strings we build ourselves, and a caller can put a path in any of them.
    e.extra = scrubContainer(e.extra, s, { left: MAX_NODES }, 1)
    e.contexts = scrubContainer(e.contexts, s, { left: MAX_NODES }, 1)
    e.tags = scrubContainer(e.tags, s, { left: MAX_NODES }, 1)
    // NOT walked, deliberately: `event.measurements` holds `{ value, unit }`
    // pairs whose keys are SDK constants (`fcp`, `lcp`) — no free-form string
    // to rewrite. `event.server_name` (os.hostname()) is a separate question:
    // on macOS/Windows it is often derived from the account name, but no
    // rewrite rule can recognise that, so dropping-vs-keeping is a policy
    // decision tracked as a followup rather than a silent change here.
  } catch { /* telemetry must never throw */ }
  return event
}
