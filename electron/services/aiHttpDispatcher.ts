/**
 * Trust store for AI provider HTTPS egress.
 *
 * WHY THIS EXISTS. Mail (IMAP/SMTP) verifies servers against
 * `getCombinedCaCertificates()` — Node's default roots plus the OS system
 * roots. AI requests used to go through Electron's global `fetch`, which only
 * knows Node's bundled roots, so a provider whose chain ends at a root the
 * administrator installed in the OS store (a corporate or national CA) failed
 * with an opaque `fetch failed` while mail to a server behind the same root
 * worked. This module gives AI egress the SAME trust set as mail.
 *
 * SCOPE IS PER DISPATCHER, NOT PROCESS-WIDE. `--use-system-ca` /
 * `tls.setDefaultCACertificates()` would have widened trust for every TLS
 * client in the process, including `safeRemoteFetch` (URLs taken from email
 * content) and the OAuth flows. The CA list lives only on the undici
 * dispatchers built here, which only `aiFetch` in `ai.ts` uses.
 *
 * NO WEAKENING. A `secureContext` built from `ca` REPLACES the default trust
 * store rather than appending to it — which is why it is the combined list
 * (default ⊂ combined: no previously-trusted root is lost). Only the trust
 * store lives in the context: `rejectUnauthorized` (default `true`),
 * `servername` and `checkServerIdentity` stay per-connection options that
 * undici's connector sets on every `tls.connect`, so hostname verification is
 * unchanged. When the combined list is unavailable, the dispatcher is built
 * WITHOUT a context, i.e. with Node's default trust — the previous behaviour —
 * and requests are not refused.
 *
 * ONE CONTEXT, NOT A `ca` ARRAY PER SOCKET. Handing `ca: string[]` to undici's
 * connector makes Node build a fresh OpenSSL trust store for every new TLS
 * socket (~14 ms for ~240 certificates, synchronously on the main thread — the
 * §2.156 cost `packages/net/tls.ts` removed for mail). The context is built
 * once and shared by the direct agent and both proxy legs (`requestTls`,
 * `proxyTls`). It is not a second CA snapshot cache: it is derived from one
 * `getCombinedCaCertificates()` read and has exactly the dispatchers' lifetime.
 *
 * LOGGING OWNERSHIP. A `null` combined list is logged once per process by
 * `packages/net/tls.ts` itself (null means `tls.getCACertificates` is
 * unavailable or threw; both paths log there), so this module does not log it
 * again. It logs
 * only the degradations that layer cannot see: an EMPTY list and a failed
 * context build.
 *
 * LIFETIME. The direct agent and the context are memoized for the process
 * lifetime; the proxy agent is memoized per proxy URL and replaced (the old one
 * closed gracefully) when that URL changes. `tls.getCACertificates()` is itself frozen
 * per process (CLAUDE.md §5 "TLS trust"), so a root installed mid-session takes
 * effect after a restart — same as mail — and there is nothing a rebuild could
 * pick up.
 */
import tls from 'node:tls'
import { Agent, ProxyAgent, type Dispatcher } from 'undici'
import { getCombinedCaCertificates } from '../../packages/net/tls'
import { createLogger } from '../logger'

const log = createLogger('AiHttpDispatcher')

let directAgent: Agent | null = null
let proxyAgent: ProxyAgent | null = null
let proxyAgentUrl: string | null = null
/** `undefined` = not computed yet; `null` = use Node's default trust. */
let trustContext: tls.SecureContext | null | undefined
let degradationLogged = false

function logDegradationOnce(message: string): void {
  if (degradationLogged) return
  degradationLogged = true
  // No URL, host, proxy address or certificate content — only the fact.
  log.warn(message)
}

/** The shared trust context, or `null` for "use Node's default trust". */
function trustedSecureContext(): tls.SecureContext | null {
  if (trustContext !== undefined) return trustContext
  const ca = getCombinedCaCertificates()
  if (!ca) {
    // Already logged once per process by packages/net/tls.ts.
    trustContext = null
  } else if (ca.length === 0) {
    logDegradationOnce('Combined CA store is empty — AI requests use Node default trust')
    trustContext = null
  } else {
    try {
      trustContext = tls.createSecureContext({ ca })
    } catch (e) {
      logDegradationOnce(
        `Failed to build AI trust context (${e instanceof Error ? e.name : 'unknown'}) — AI requests use Node default trust`,
      )
      trustContext = null
    }
  }
  return trustContext
}

export interface AiDispatcherHandle {
  dispatcher: Dispatcher
  /** True when THIS call constructed a new proxy agent (the caller logs it). */
  proxyAgentCreated: boolean
}

/**
 * The dispatcher for one AI request. Synchronous on purpose: a malformed proxy
 * URL makes `new ProxyAgent()` throw here, before anything is dispatched, and
 * `aiChatSimpleOutcome` classifies that as provably unbilled.
 */
export function getAiDispatcher(proxyUrl?: string): AiDispatcherHandle {
  if (!proxyUrl) {
    if (!directAgent) {
      const secureContext = trustedSecureContext()
      directAgent = new Agent(secureContext ? { connect: { secureContext } } : {})
    }
    return { dispatcher: directAgent, proxyAgentCreated: false }
  }
  if (proxyAgent && proxyAgentUrl === proxyUrl) {
    return { dispatcher: proxyAgent, proxyAgentCreated: false }
  }
  const secureContext = trustedSecureContext()
  const next = new ProxyAgent(
    secureContext
      ? { uri: proxyUrl, requestTls: { secureContext }, proxyTls: { secureContext } }
      : { uri: proxyUrl },
  )
  proxyAgent?.close().catch(() => {})
  proxyAgent = next
  proxyAgentUrl = proxyUrl
  return { dispatcher: next, proxyAgentCreated: true }
}

/** Drop both cached dispatchers (tests; also used by `resetProxyAgent`). */
export function resetAiDispatchers(): void {
  directAgent?.close().catch(() => {})
  proxyAgent?.close().catch(() => {})
  directAgent = null
  proxyAgent = null
  proxyAgentUrl = null
  trustContext = undefined
  degradationLogged = false
}

/**
 * Turn whatever a provider SDK hands its custom `fetch` into the `(url, init)`
 * pair `aiFetch` takes.
 *
 * String and `URL` inputs: the URL is taken as-is (a `URL` by `href`) and
 * `init` is passed through UNCHANGED (`{}` when absent) — no keepalive
 * stripping, no `duplex` handling. This is the pre-existing pass-through; the
 * Vercel SDKs pass a string today.
 *
 * `Request` input: unpacked into its full request state (method, headers,
 * body, signal, redirect, cache, credentials, integrity, mode, referrer,
 * referrerPolicy) — calling `String()` on it would yield `"[object Request]"`.
 * The normalization below applies ONLY on this path:
 * - `keepalive` is not forwarded, neither from the Request nor from `init`: it
 *   is page-unload semantics, meaningless for main-process egress, and the
 *   unpacked body is a stream, which fetch refuses together with
 *   `keepalive: true`.
 * - Overlay rule: an `init` member overrides the Request's field only when its
 *   value is not `undefined`. An explicitly present `{ signal: undefined }`
 *   must not erase the Request's abort signal — that would let a cancelled,
 *   billable request keep running. `null` is a value and does win
 *   (`body: null` drops the body).
 * - `duplex` follows the EFFECTIVE body: set to `'half'` when that body is a
 *   stream (the only kind that requires it), removed when there is no body
 *   (`undefined` or `null`); for a non-stream body it is left as `init`
 *   supplied it (absent unless `init` set it).
 */
export function resolveFetchInput(
  input: string | URL | Request,
  init?: RequestInit,
): { url: string; init: RequestInit } {
  if (typeof input === 'string') return { url: input, init: init ?? {} }
  if (input instanceof URL) return { url: input.href, init: init ?? {} }
  const merged: RequestInit & { duplex?: 'half' } = {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: input.signal,
    redirect: input.redirect,
    cache: input.cache,
    credentials: input.credentials,
    integrity: input.integrity,
    mode: input.mode,
    referrer: input.referrer,
    referrerPolicy: input.referrerPolicy,
  }
  if (init) {
    const target = merged as Record<string, unknown>
    for (const [key, value] of Object.entries(init)) {
      if (value !== undefined) target[key] = value
    }
  }
  delete merged.keepalive
  if (merged.body === undefined || merged.body === null) {
    delete merged.duplex
  } else if (merged.body instanceof ReadableStream) {
    // A streamed body requires half-duplex; a string/buffer body does not.
    merged.duplex = 'half'
  }
  return { url: input.url, init: merged }
}
