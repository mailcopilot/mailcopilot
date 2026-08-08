import { simpleParser, MailParser, type ParsedMail } from 'mailparser'
import type { AddressObject, StructuredHeader } from 'mailparser'
import type { AttachmentMeta, MailAddress, MessageDetails } from './types'
import {
  EmlParseQueueOverflowError,
  EmlWorkerUnavailableError,
  extractIcsInWorker,
  parseEmlDetailsInWorker,
  planEmlParseDispatch,
  recordEmlParseDispatch,
} from './emlWorkerClient'

export const EML_ATTACHMENT_PART_PREFIX = 'eml:'

// ---------------------------------------------------------------------------
// Lightweight EML parser: extracts headers + body but skips attachment content.
// This is much faster than simpleParser for emails with many/large attachments.
// ---------------------------------------------------------------------------

type LightParsed = {
  headers: Map<string, StructuredHeader>
  date?: Date
  subject?: string
  messageId?: string
  inReplyTo?: string
  references?: unknown
  from?: AddressObject | AddressObject[]
  replyTo?: AddressObject | AddressObject[]
  to?: AddressObject | AddressObject[]
  cc?: AddressObject | AddressObject[]
  bcc?: AddressObject | AddressObject[]
  html?: string
  text?: string
  attachments: Array<{
    filename?: string
    contentType?: string
    size?: number
    contentDisposition?: string
    cid?: string
  }>
}

/** Parse EML using streaming MailParser — skips attachment content (only metadata). */
async function parseLightweight(raw: Buffer): Promise<LightParsed> {
  return new Promise((resolve, reject) => {
    const parser = new MailParser()
    const result: LightParsed = { headers: new Map(), attachments: [] }

    parser.on('headers', (headers: Map<string, StructuredHeader>) => {
      result.headers = headers
    })

    parser.on('data', (data: { type: string; [key: string]: unknown }) => {
      if (data.type === 'text') {
        if (data.html) result.html = data.html as string
        if (data.text) result.text = data.text as string
      } else if (data.type === 'attachment') {
        // Collect metadata only — drain the content stream without buffering
        result.attachments.push({
          filename: (data.filename as string) || undefined,
          contentType: (data.contentType as string) || undefined,
          size: typeof data.size === 'number' ? data.size : undefined,
          contentDisposition: (data.contentDisposition as string) || undefined,
          cid: (data.cid as string) || undefined,
        })
        // Drain the readable stream to prevent backpressure
        if (data.content && typeof (data.content as NodeJS.ReadableStream).resume === 'function') {
          // eslint-disable-next-line no-extra-semi
          ;(data.content as NodeJS.ReadableStream).resume()
        }
        if (typeof data.release === 'function') {
          // eslint-disable-next-line no-extra-semi
          ;(data as unknown as { release: () => void }).release()
        }
      }
    })

    parser.on('error', reject)
    parser.on('end', () => {
      // Extract envelope fields from headers
      const h = result.headers
      const getAddr = (key: string) => h.get(key) as AddressObject | AddressObject[] | undefined

      result.from = getAddr('from')
      result.to = getAddr('to')
      result.cc = getAddr('cc')
      result.bcc = getAddr('bcc')
      result.replyTo = getAddr('reply-to')
      result.subject = (h.get('subject') as unknown as string) || undefined
      result.messageId = (h.get('message-id') as unknown as string) || undefined
      result.inReplyTo = (h.get('in-reply-to') as unknown as string) || undefined
      result.references = h.get('references')

      const dateRaw = h.get('date')
      if (dateRaw instanceof Date) result.date = dateRaw
      else if (typeof dateRaw === 'string') {
        const d = new Date(dateRaw)
        if (!Number.isNaN(d.getTime())) result.date = d
      }

      resolve(result)
    })

    parser.end(raw)
  })
}

// Short-lived cache for full simpleParser results (needed when extracting attachment content).
let cachedFullKey: string | null = null
let cachedFullParsed: ParsedMail | null = null

function emlCacheKey(raw: Buffer): string {
  return `${raw.length}:${raw.subarray(0, 64).toString('base64')}`
}

/** Full parse via simpleParser — only used when we need actual attachment content. */
async function parseFullCached(raw: Buffer): Promise<ParsedMail> {
  const key = emlCacheKey(raw)
  if (cachedFullKey === key && cachedFullParsed) return cachedFullParsed
  const parsed = await simpleParser(raw)
  cachedFullKey = key
  cachedFullParsed = parsed
  return parsed
}

/** Clear the parser cache (e.g. for tests). */
export function resetEmlParserCache() {
  cachedFullKey = null
  cachedFullParsed = null
}

/** Converts AddressObject (mailparser) to a MailAddress array */
function mapParsedAddrs(group: AddressObject | AddressObject[] | undefined): MailAddress[] | undefined {
  if (!group) return undefined
  const groups = Array.isArray(group) ? group : [group]
  const addrs = groups.flatMap(g => g.value.map(a => ({ name: a.name, address: a.address })))
  return addrs.length > 0 ? addrs : undefined
}

/**
 * Parses an EML buffer (RFC822) and extracts MessageDetails, on the calling
 * thread. Uses the lightweight streaming parser — skips attachment content.
 *
 * §2.124 — "lightweight" is about attachment CONTENT, not about cost: the MIME
 * splitter underneath still yields to the event loop once per line, so this
 * function costs ~1 event-loop turn per 77 bytes of input. That is free on a
 * worker's own loop and ruinous on the Electron main loop. Call
 * `parseEmlBuffer` unless you are already off the main thread — it routes
 * large inputs to the worker and calls this for the rest.
 */
export async function parseEmlBufferInline(uid: number, raw: Buffer): Promise<MessageDetails> {
  const parsed = await parseLightweight(raw)
  const refsRaw = parsed.references
  const references = Array.isArray(refsRaw)
    ? refsRaw.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean).join(' ')
    : (typeof refsRaw === 'string' ? refsRaw.trim() : undefined)

  const envelope: MessageDetails['envelope'] = {
    date: parsed.date?.toISOString(),
    subject: parsed.subject || undefined,
    messageId: parsed.messageId || undefined,
    inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : undefined,
    references: references || undefined,
    from: mapParsedAddrs(parsed.from),
    replyTo: mapParsedAddrs(parsed.replyTo),
    to: mapParsedAddrs(parsed.to as AddressObject | AddressObject[] | undefined),
    cc: mapParsedAddrs(parsed.cc as AddressObject | AddressObject[] | undefined),
    bcc: mapParsedAddrs(parsed.bcc as AddressObject | AddressObject[] | undefined),
  }

  const attachments: AttachmentMeta[] = parsed.attachments.map((att, i) => ({
    part: `${EML_ATTACHMENT_PART_PREFIX}${i + 1}`,
    filename: att.filename || undefined,
    contentType: att.contentType || undefined,
    size: att.size || undefined,
    disposition: att.contentDisposition || undefined,
    cid: att.cid || undefined,
  }))

  const draftIdRaw = parsed.headers?.get('x-mailcopilot-draft-id')
  const draftId = typeof draftIdRaw === 'string' ? draftIdRaw : undefined

  return {
    uid,
    envelope,
    internalDate: parsed.date?.toISOString(),
    html: parsed.html || undefined,
    text: parsed.text || undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    draftId,
  }
}

/**
 * §2.22 Wave A — extract a raw `text/calendar` part from a full RFC822 buffer,
 * on the calling thread. Used by the local-EML cache path: `electron/main.ts`
 * already holds the raw bytes and parses them via `parseEmlBuffer`, which
 * intentionally skips attachment content, so the ics has to be recovered with
 * a second, full pass. Layering note: this stays in `packages/net` because it
 * is pure MIME walking; ical.js parsing is one layer up in `inviteBridge.ts`.
 *
 * §2.22 fix iter4 — codex-security-review MEDIUM: cap the returned ics at
 * `MAX_ICS_BYTES` to mirror the IMAP path. Without this guard, a maliciously
 * oversized ics inside an offline-cached EML would force unbounded
 * `simpleParser` + `toString('utf8')` + downstream `ICAL.parse` work, giving
 * an attacker a cheap CPU/memory amplifier.
 *
 * §2.124 — this is the SECOND full parse of the same bytes on every EML cache
 * hit, and it costs as many event-loop turns as the first one (measured:
 * 32 026 turns for a 2.47 MB message, the same as the lightweight pass). Use
 * `extractIcsFromRawEml`, which offloads large inputs, rather than calling
 * this directly from the main thread.
 */
export async function extractIcsFromRawEmlInline(raw: Buffer): Promise<string | undefined> {
  try {
    const parsed = await simpleParser(raw)
    const atts = parsed.attachments ?? []
    for (const att of atts) {
      const contentType = (att.contentType || '').toLowerCase()
      const filename = att.filename || ''
      const isIcs =
        contentType === 'text/calendar' ||
        contentType === 'application/ics' ||
        (contentType === 'application/octet-stream' && /\.ics$/i.test(filename))
      if (!isIcs) continue
      const content = att.content
      if (Buffer.isBuffer(content)) {
        if (content.length > MAX_ICS_BYTES) return undefined
        return content.toString('utf8')
      }
      if (typeof content === 'string') {
        // Byte-length guard via Buffer.byteLength (string `.length` counts
        // UTF-16 code units, not bytes; an ics with multibyte UTF-8 chars
        // could otherwise slip the cap on the byte side).
        if (Buffer.byteLength(content, 'utf8') > MAX_ICS_BYTES) return undefined
        return content
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

const MAX_ICS_BYTES = 1 * 1024 * 1024

/**
 * §2.124 — main-thread entry points. Both parses of the message-open path run
 * in a worker once the raw message is large enough to make the splitter's
 * per-line event-loop yields visible; smaller messages keep the inline path so
 * the ordinary open does not depend on worker health.
 *
 * Failure policy, deliberately asymmetric, and the asymmetry turns on ONE
 * question: had the worker announced itself before it died?
 *  - it had NOT (missing build artifact, spawn failure, a thread that never
 *    came up, a replacement that failed to load) — no bytes had been dispatched
 *    to it, so the message cannot be the cause. Fall back to the inline parse
 *    and keep working;
 *  - it HAD, and then crashed or timed out with these bytes in flight —
 *    propagate. Retrying them inline would aim a parse that just killed a
 *    thread at the main process, which is exactly the failure this task exists
 *    to remove.
 *
 * Readiness is the discriminator precisely because it is causally independent
 * of the message (the announcement precedes any dispatch — see
 * `readyGeneration` in emlWorkerClient.ts). An earlier version asked "has this
 * worker answered a job", which crafted MIME could defeat: killing a
 * never-answered worker was read as "workers do not run here", and the fallback
 * then parsed those same bytes on the main thread.
 *
 * A third outcome exists and is neither of the above: a parse can be REFUSED
 * outright (`EmlParseQueueOverflowError`) when too much work is already pinned.
 * A refusal is not a fallback — nothing is parsed anywhere — and it is not
 * counted as a dispatch.
 *
 * Every dispatch reports which of those paths it took (`eml.parse_dispatch`).
 * That is not decoration: the fallback keeps the app fully working and merely
 * an order of magnitude slower, so without a counter a dead worker produces no
 * error, no crash, and no watchdog line anywhere — see the metric's entry in
 * electron/metricsSchema.ts for why the UiFreeze detector cannot see it.
 *
 * CANCELLATION IS PRESENT BUT NOT CONNECTED. `opts.signal` is plumbed all the
 * way to the worker client and covered by specs, and NO PRODUCTION CALLER
 * PASSES ONE: `electron/main.ts` invokes both entry points with the buffer
 * alone. Abandoning a slow open needs an IPC cancel channel through
 * `preload.ts` (filed as a followup, owned by the electron boundary), so until
 * that lands the only cancellation that occurs in the field is the client's own
 * job timeout. Read the `worker_aborted` counter accordingly — zero means the
 * wiring is missing, not that users never walk away.
 */

/** An abandoned open (the user closed the message) is not a parse failure and
 *  must not be counted as one. Matches the AbortError the client raises.
 *
 *  Reachable from tests and from a future cancel channel; not from any caller
 *  that exists today (see the note above). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

export async function parseEmlBuffer(
  uid: number,
  raw: Buffer,
  opts?: { signal?: AbortSignal },
): Promise<MessageDetails> {
  const plan = planEmlParseDispatch(raw)
  if (plan.path === 'worker') {
    try {
      const details = await parseEmlDetailsInWorker(uid, raw, opts?.signal)
      recordEmlParseDispatch('worker', raw.length)
      return details
    } catch (err) {
      if (err instanceof EmlWorkerUnavailableError) {
        // The parse still happens — inline, on the main loop, at the cost this
        // whole mechanism exists to avoid. Counted as such.
        recordEmlParseDispatch('inline_unavailable', raw.length)
        return parseEmlBufferInline(uid, raw)
      }
      if (err instanceof EmlParseQueueOverflowError) {
        // Refused before anything was dispatched, so no parse took place on any
        // thread and there is nothing to count as a dispatch. Emphatically NOT
        // an inline fallback: the refusal exists to stop spending main-process
        // resources on a burst, and inline is the most expensive way to spend
        // them. One message open fails; the queue drains; the next is admitted.
        throw err
      }
      recordEmlParseDispatch(isAbortError(err) ? 'worker_aborted' : 'worker_failed', raw.length)
      throw err
    }
  }
  recordEmlParseDispatch(plan.path, raw.length)
  return parseEmlBufferInline(uid, raw)
}

export async function extractIcsFromRawEml(
  raw: Buffer,
  opts?: { signal?: AbortSignal },
): Promise<string | undefined> {
  const plan = planEmlParseDispatch(raw)
  if (plan.path === 'worker') {
    try {
      const ics = await extractIcsInWorker(raw, opts?.signal)
      recordEmlParseDispatch('worker', raw.length)
      return ics
    } catch (err) {
      if (err instanceof EmlWorkerUnavailableError) {
        recordEmlParseDispatch('inline_unavailable', raw.length)
        return extractIcsFromRawEmlInline(raw)
      }
      if (err instanceof EmlParseQueueOverflowError) {
        // The calendar scan is best-effort everywhere, so a refusal costs an
        // RSVP card and nothing else — and it must not be retried inline, which
        // would let a burst buy exactly the main-thread work it was refused.
        return undefined
      }
      // The ics is best-effort everywhere else on this path (see the callers
      // in electron/main.ts): a worker crash or timeout must not turn a
      // readable message into an unopenable one, it just means no RSVP card.
      if (isAbortError(err)) {
        recordEmlParseDispatch('worker_aborted', raw.length)
        throw err
      }
      recordEmlParseDispatch('worker_failed', raw.length)
      return undefined
    }
  }
  recordEmlParseDispatch(plan.path, raw.length)
  return extractIcsFromRawEmlInline(raw)
}

export type ExtractedEmlAttachment = {
  filename?: string
  contentType?: string
  content: Buffer
}

/**
 * Extracts a specific attachment from EML by part identifier of the form "eml:N".
 * Uses full simpleParser because we need the actual attachment content.
 */
export async function extractEmlAttachment(raw: Buffer, part: string): Promise<ExtractedEmlAttachment | null> {
  if (!part.startsWith(EML_ATTACHMENT_PART_PREFIX)) return null
  const idxRaw = part.slice(EML_ATTACHMENT_PART_PREFIX.length).trim()
  const idx = Number.parseInt(idxRaw, 10)
  if (!Number.isFinite(idx) || idx <= 0) return null

  const parsed = await parseFullCached(raw)
  const att = parsed.attachments?.[idx - 1]
  if (!att) return null

  const content =
    Buffer.isBuffer(att.content)
      ? att.content
      : Buffer.from(typeof att.content === 'string' ? att.content : String(att.content))

  return {
    filename: att.filename || undefined,
    contentType: att.contentType || undefined,
    content,
  }
}
