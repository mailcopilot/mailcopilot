import nodemailer from 'nodemailer'
// MailComposer — internal nodemailer module for building RFC822 messages.
// Path `nodemailer/lib/mail-composer` — stable API, used by many projects.
import MailComposer from 'nodemailer/lib/mail-composer'
import dns from 'node:dns'
import net from 'node:net'
import type { ComposeAttachment, SmtpConfig } from './types'
import { buildTlsOptions } from './tls'
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
const SEND_TIMEOUTS: Timeouts = { connection: 30_000, greeting: 15_000, socket: 60_000 }

export async function testSmtpConnection(cfg: SmtpConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    await createSmtpTransport(cfg, TEST_TIMEOUTS).verify()
    return { ok: true }
  } catch (e: unknown) {
    if (!isTimeoutError(e)) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    // Retry on timeout: resolve system A-records and probe each IPv4 directly.
    const ip = await findReachableIp(cfg.host, cfg.port)
    if (!ip) return { ok: false, error: e instanceof Error ? e.message : String(e) }
    try {
      await createSmtpTransport({ ...cfg, host: ip }, TEST_TIMEOUTS, cfg.host).verify()
      return { ok: true }
    } catch (retryErr: unknown) {
      return { ok: false, error: retryErr instanceof Error ? retryErr.message : String(retryErr) }
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
      if (!isTimeoutError(err)) throw err
      // Retry on timeout: resolve system A-records and probe each IPv4 directly.
      const ip = await findReachableIp(cfg.host, cfg.port)
      if (!ip) throw err
      const info = await createSmtpTransport({ ...cfg, host: ip }, SEND_TIMEOUTS, cfg.host).sendMail(mailOpts)
      return { messageId: info.messageId }
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
  // No SMTP code — likely network error (transient)
  const msg = err instanceof Error ? err.message : String(err)
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|ECONNREFUSED|socket/i.test(msg)) {
    return { code: null, isTransient: true }
  }
  // Unknown error without SMTP code or recognizable network error — treat as permanent.
  // Retrying unknown errors wastes queue cycles and delays failure notification to the user.
  return { code: null, isTransient: false }
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
