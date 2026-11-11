import nodemailer from 'nodemailer'
// MailComposer — internal nodemailer module for building RFC822 messages.
// Path `nodemailer/lib/mail-composer` — stable API, used by many projects.
import MailComposer from 'nodemailer/lib/mail-composer'
import dns from 'node:dns'
import net from 'node:net'
import type { ComposeAttachment, SmtpConfig } from './types'
import { buildTlsOptions } from './tls'
import { markStarttlsRefusal, smtpStarttlsPolicy } from './starttlsPolicy'
import {
  isDeliveryUndetermined,
  isPreGreetingFailure,
  isSmtpSessionError,
  isStarttlsRefusal,
  isTlsUpgradeTimeout,
} from '@mailcopilot/core/transportFailure'
import { encodeErrorPresentation } from '@mailcopilot/core/errorPresentation'
import { walkErrorTree } from '@mailcopilot/core/transientErrors'
import { withNetSpan } from './telemetry'
import { bucketBodySize, providerFromHost } from '../../electron/metricsBuckets'

export type SendMailOptions = {
  from: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  text?: string
  html?: string
  attachments?: ComposeAttachment[]
  headers?: Record<string, string>
  /**
   * RFC 5322 §3.6.4 threading headers of a reply, resolved by main from the
   * parent message (`buildReplyThreadHeaders`). nodemailer and MailComposer
   * read both fields natively, so the SMTP send, the Graph MIME and the
   * Sent-folder copy all carry them.
   */
  inReplyTo?: string
  references?: string
  /**
   * §2.22 fix iter2A — `multipart/alternative` legs that nodemailer / MailComposer
   * surface alongside the plain `text` and `html` body. Used for `text/calendar;
   * method=REPLY` in the RSVP flow: Outlook desktop and Apple Calendar require
   * the ics inside `multipart/alternative` for automatic RSVP recognition.
   *
   * Honoured by both the SMTP `sendMail` path (nodemailer transport reads the
   * field directly) and the IMAP-APPEND-to-Sent path (`buildRawMessage`, which
   * runs MailComposer locally to build the RFC822 bytes). Without this passthrough
   * the saved Sent-folder copy of an RSVP loses the calendar alternative and
   * appears as plain text only — see codex-bg-review iter2 finding "non-Outlook
   * APPEND loses alternatives".
   *
   * Not exposed via the renderer-facing `net:sendMail` IPC shape (zod schema
   * enforces this); only internal main-process call sites widen the type to
   * include alternatives.
   */
  alternatives?: Array<{
    contentType: string
    content: string | Buffer
  }>
}

// ─── DNS retry: on timeout try system-resolved IPv4 addresses directly ─────
const PROBE_TIMEOUT_MS = 5_000

/** Check if the error is a TCP connection timeout */
function isTimeoutError(e: unknown): boolean {
  // A greeting timeout reads "Greeting never received" (code ETIMEDOUT), which the
  // text match below misses, so the code is checked too.
  if ((e as { code?: unknown })?.code === 'ETIMEDOUT') return true
  const msg = e instanceof Error ? e.message : String(e)
  return /timeout|ETIMEDOUT/i.test(msg)
}

/** Resolve all IPv4 addresses via the system resolver only. */
export async function resolveIpv4All(host: string): Promise<string[]> {
  try {
    return await dns.promises.resolve4(host)
  } catch {
    return []
  }
}

/** Quick TCP connection check to a host */
export function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    let resolved = false
    const s = net.connect({ host, port, family: 4 })
    const done = (ok: boolean) => { if (resolved) return; resolved = true; s.removeAllListeners(); s.destroy(); resolve(ok) }
    s.setTimeout(PROBE_TIMEOUT_MS)
    s.on('connect', () => done(true))
    s.on('timeout', () => done(false))
    s.on('error', () => done(false))
    s.on('close', () => done(false))
  })
}

/** Find the first reachable IPv4 address of a host via DNS resolve + TCP probe */
export async function findReachableIp(host: string, port: number): Promise<string | null> {
  const ips = await resolveIpv4All(host)
  for (const ip of ips) {
    if (await tcpProbe(ip, port)) return ip
  }
  return null
}

// ─── Transport and sending ────────────────────────────────────────────────────

function mapAttachments(atts?: ComposeAttachment[]) {
  if (!atts || atts.length === 0) return undefined
  return atts.map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.contentBase64, 'base64'),
    contentType: a.contentType,
  }))
}

type Timeouts = { connection: number; greeting: number; socket: number }

function createSmtpTransport(
  cfg: SmtpConfig,
  timeouts: Timeouts,
  servername?: string,
) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...smtpStarttlsPolicy(cfg),
    auth: cfg.accessToken
      ? { type: 'OAuth2' as const, user: cfg.user, accessToken: cfg.accessToken }
      : { user: cfg.user, pass: cfg.pass || '' },
    tls: buildTlsOptions(servername ? { ...cfg, servername } : cfg),
    connectionTimeout: timeouts.connection,
    greetingTimeout: timeouts.greeting,
    socketTimeout: timeouts.socket,
  })
}

const TEST_TIMEOUTS: Timeouts = { connection: 15_000, greeting: 15_000, socket: 15_000 }
// socket: how long a silent connection is tolerated, including the wait for the
// 250 after DATA. 100 s is what Thunderbird uses; RFC 5321 §4.5.3.2.6 suggests
// 10 min, which would hold the single send-queue pass (all mailboxes) that long.
const SEND_TIMEOUTS: Timeouts = { connection: 30_000, greeting: 15_000, socket: 100_000 }

/** Test seam (explicit export, not an argument): lets a real-library test shorten
 *  the send timers instead of waiting a minute for a stalled server. The object
 *  is read on every send, so assigning to its fields takes effect. */
export const __testOnly = { sendTimeouts: SEND_TIMEOUTS, testTimeouts: TEST_TIMEOUTS }

type SmtpTestResult = { ok: boolean; error?: string }

function smtpTestFailure(e: unknown): SmtpTestResult {
  const tag = isStarttlsRefusal(e)
    ? `${encodeErrorPresentation('starttls_required')} `
    : isPreGreetingFailure(e) ? `${encodeErrorPresentation('pre_greeting')} ` : ''
  const shown = markStarttlsRefusal(e)
  return { ok: false, error: tag + (shown instanceof Error ? shown.message : String(shown)) }
}

export async function testSmtpConnection(cfg: SmtpConfig): Promise<SmtpTestResult> {
  try {
    await createSmtpTransport(cfg, TEST_TIMEOUTS).verify()
    return { ok: true }
  } catch (e: unknown) {
    if (!isTimeoutError(e)) return smtpTestFailure(e)
    // Retry on timeout: resolve system A-records and probe each IPv4 directly.
    const ip = await findReachableIp(cfg.host, cfg.port)
    if (!ip) return smtpTestFailure(e)
    try {
      await createSmtpTransport({ ...cfg, host: ip }, TEST_TIMEOUTS, cfg.host).verify()
      return { ok: true }
    } catch (retryErr: unknown) {
      return smtpTestFailure(retryErr)
    }
  }
}

export async function sendMail(cfg: SmtpConfig, options: SendMailOptions) {
  const mailOpts = { ...options, attachments: mapAttachments(options.attachments) }
  // Telemetry attributes — strictly structural. NEVER include subject,
  // recipient, body text, or attachment filenames: only counts and buckets.
  const bodyBytes =
    Buffer.byteLength(options.text || '', 'utf8')
    + Buffer.byteLength(options.html || '', 'utf8')
    + (options.attachments?.reduce((n, a) => {
        // contentBase64.length * 0.75 is the raw byte size (ignoring padding)
        return n + Math.floor((a.contentBase64?.length || 0) * 0.75)
      }, 0) ?? 0)
  const spanAttrs = {
    provider: providerFromHost(cfg.host),
    has_attachments: Boolean(options.attachments && options.attachments.length > 0),
    size_bucket: bucketBodySize(bodyBytes),
  }

  return withNetSpan('smtp.send', spanAttrs, async () => {
    try {
      const info = await createSmtpTransport(cfg, SEND_TIMEOUTS).sendMail(mailOpts)
      return { messageId: info.messageId }
    } catch (err) {
      // Only a failure BEFORE the greeting may be retried on another address:
      // nodemailer also reports a mid-session socket timeout as a timeout, and
      // by then the message may already have been accepted — resending it
      // here would risk a duplicate.
      if (!isTimeoutError(err) || !isPreGreetingFailure(err)) throw markStarttlsRefusal(err)
      // Retry on timeout: resolve system A-records and probe each IPv4 directly.
      const ip = await findReachableIp(cfg.host, cfg.port)
      if (!ip) throw err
      try {
        const info = await createSmtpTransport({ ...cfg, host: ip }, SEND_TIMEOUTS, cfg.host).sendMail(mailOpts)
        return { messageId: info.messageId }
      } catch (retryErr) {
        throw markStarttlsRefusal(retryErr)
      }
    }
  })
}

/** Classify SMTP error as transient (4xx, network) or permanent (5xx).
 *  Nodemailer exposes `responseCode` on SMTP errors. Graph send errors
 *  (from `GraphSendError` in graphSend.ts) carry HTTP `status` instead —
 *  we detect and translate them here to avoid a cross-module import. */
export function classifySmtpError(err: unknown): { code: number | null; isTransient: boolean } {
  // GraphSendError path — POST /me/sendMail HTTP status. Microsoft Graph
  // uses 429 with Retry-After for throttling, and 5xx for service issues;
  // both are explicitly retryable per Graph throttling guidance. 400/401/
  // 403/404 are permanent (bad request, missing auth, forbidden, gone).
  if (err instanceof Error && err.name === 'GraphSendError') {
    const status = (err as unknown as { status?: number }).status ?? null
    if (typeof status === 'number') {
      const isTransient = status === 408 || status === 429 || (status >= 500 && status < 600)
      return { code: status, isTransient }
    }
    return { code: null, isTransient: false }
  }

  const raw = (err as { responseCode?: unknown })?.responseCode
  const code = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw)
    : null
  if (code != null) {
    return { code, isTransient: code >= 400 && code < 500 }
  }
  // Failed before the server greeted us: nothing was transmitted, so a retry is
  // safe. Decided by stage, so it does not depend on which address was tried
  // last or on how the OS names the errno (ENETUNREACH, EHOSTUNREACH, ...).
  if (isPreGreetingFailure(err)) return { code: null, isTransient: true }
  // The TLS handshake after an accepted STARTTLS timed out: the upgrade precedes
  // AUTH, MAIL and DATA, so nothing of the message was sent either. Only this
  // timer; a socket timeout (SOCKET_TIMEOUT) stays final below.
  if (isTlsUpgradeTimeout(err)) return { code: null, isTransient: true }
  // Anything else that happened INSIDE the SMTP session and carries no server
  // reply code is not retried automatically. After the server was reached the
  // message may have been accepted (a socket timeout or reset while waiting for
  // the 250 after DATA, a silent close), and a failure in EHLO or AUTH cannot be
  // told from one after DATA by the error alone. A second automatic attempt
  // would deliver the message twice; the user can resend by hand.
  // Looked for in the whole cause chain: a wrapper that hides the stage on the
  // outside must not turn a post-DATA failure back into a retry.
  let fromSession = false
  walkErrorTree(err, (node) => { if (isSmtpSessionError(node)) fromSession = true })
  if (fromSession) return { code: null, isTransient: false }
  // Not raised by the session at all (an OAuth token refresh, a missing
  // configuration): the server was never contacted, so a network-looking
  // failure is safe to retry. Text match, because there is no structure to read.
  const msg = err instanceof Error ? err.message : String(err)
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|ECONNREFUSED|socket/i.test(msg)) {
    return { code: null, isTransient: true }
  }
  // Unknown error without SMTP code or recognizable network error — treat as permanent.
  // Retrying unknown errors wastes queue cycles and delays failure notification to the user.
  return { code: null, isTransient: false }
}

/**
 * The text stored and shown for a send that has finally failed. A refused
 * STARTTLS upgrade carries the `starttls_required` tag, a failure before the
 * server took the message (normally before its greeting) the `pre_greeting` tag
 * and a session that broke after the server was reached, with no reply code to
 * judge by, the `delivery_unknown` tag, so the UI shows a translated
 * sentence instead of the raw error of whichever address was tried last;
 * everything else keeps its own text (a server's refusal reason is what the
 * user needs). The raw text stays after the tag for the log.
 */
export function finalSendFailureText(err: unknown): string {
  if (isStarttlsRefusal(err)) return `${encodeErrorPresentation('starttls_required')} ${String(err)}`
  if (isPreGreetingFailure(err)) return `${encodeErrorPresentation('pre_greeting')} ${String(err)}`
  if (isDeliveryUndetermined(err)) return `${encodeErrorPresentation('delivery_unknown')} ${String(err)}`
  return String(err)
}

/** Exponential backoff delays for SMTP transient errors (4xx / network) */
export const SMTP_RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000] as const

/** Build a raw RFC822 message (for IMAP APPEND to Sent folder, etc.). */
export async function buildRawMessage(options: SendMailOptions & { messageId?: string }): Promise<Buffer> {
  // §2.22 fix iter2A — preserve `alternatives` so RSVP REPLY copies APPEND'ed
  // to the Sent folder include the `text/calendar; method=REPLY` alternative
  // alongside the plain text body. nodemailer's MailComposer accepts the
  // field natively (`alternatives` is documented in nodemailer's "Using
  // embedded images" + "multipart/alternative" examples). Pass through
  // unchanged — content is already a string/Buffer per the SendMailOptions
  // contract, no remapping required.
  const composer = new MailComposer({
    ...options,
    attachments: mapAttachments(options.attachments),
    alternatives: options.alternatives,
  })
  return composer.compile().build()
}
