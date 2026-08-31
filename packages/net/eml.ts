import { simpleParser, MailParser, type ParsedMail } from 'mailparser'
import type { AddressObject, StructuredHeader } from 'mailparser'
import type { AttachmentMeta, MailAddress, MessageDetails, MessageParseCap } from './types'
import {
  EmlParseQueueOverflowError,
  EmlWorkerUnavailableError,
  extractIcsInWorker,
  parseEmlDetailsInWorker,
  planEmlParseDispatch,
  recordEmlParseDispatch,
} from './emlWorkerClient'
import { reportNetEvent } from './telemetry'
import {
  EML_BODY_FULL_CAP_BYTES,
  EML_BODY_SOFT_CAP_BYTES,
  EML_HEADER_SCAN_BYTES,
  MAX_EML_PARSE_BYTES,
} from './limits'
// Same zero-dependency bucketing helper `emlWorkerClient` uses, for the same
// reason: message size must mean one thing across every metric that carries it.
import { bucketBodySize } from '../../electron/metricsBuckets'

export const EML_ATTACHMENT_PART_PREFIX = 'eml:'

// ---------------------------------------------------------------------------
// §2.145 — two-tier parse caps.
//
// The offload of §2.124 moved the parse off the main loop; it did not bound
// what a parse may COST. `resourceLimits` on the worker bounds the V8 old
// space and nothing else — a message and its decoded parts are `Buffer`s and
// strings living outside that heap, in an address space the worker SHARES with
// the main process (see the TRUST BOUNDARY note in emlWorkerClient.ts). So an
// input large enough to exhaust memory takes the whole application down before
// any of the §2.124 machinery gets a say.
//
// Two caps, at two different boundaries, answering two different questions:
//
//   HARD, on the RAW RFC822 INPUT, applied BEFORE the bytes reach parse
//   dispatch. This is the OOM guard. Nothing is parsed: the message opens as a
//   placeholder built from its header block alone, and there is deliberately NO
//   bypass — an "open anyway" button would hand the user a way to crash the app
//   on request, which is not a choice worth offering.
//
//   SOFT, on the DECODED BODY, applied inside the parse. This is not a safety
//   boundary but a responsiveness one: everything downstream of the parse
//   (structured clone across the worker boundary, the IPC payload, the SQLite
//   details cache, DOMPurify, the iframe) is linear in body size, and a body
//   large enough to make those visible is not a body anyone reads in one go.
//   The message opens normally, with a banner, and the user can ask for more.
// ---------------------------------------------------------------------------

/**
 * §2.145 wave 2.1 — the ceilings moved to `./limits`, a leaf module with no
 * imports, because they now bind at layers that must not depend on each other:
 * the IMAP fetch (`message.ts`) and the on-disk store (`mailStore.ts`) enforce
 * the same numbers as this parser, and neither can afford to import mailparser
 * to learn them. Re-exported here so every existing importer of `./eml` keeps
 * working unchanged.
 *
 * Read `./limits` for the derivation of each number and for the full list of
 * doorways that now apply the hard cap.
 */
export {
  MAX_EML_PARSE_BYTES,
  EML_BODY_SOFT_CAP_BYTES,
  EML_BODY_FULL_CAP_BYTES,
} from './limits'

/**
 * The hard-cap predicate, in one place.
 *
 * Every doorway that accepts attacker-controlled bytes consults it — the three
 * parse entry points here, the IMAP raw download, and the on-disk read — and
 * they must not be able to drift apart: a cap enforced at some of the doorways
 * is not a cap. Exported so a spec can pin the boundary itself (a message of
 * exactly `MAX_EML_PARSE_BYTES` is ALLOWED; the cap is a maximum, not a
 * threshold) without allocating a hundred megabytes to find out.
 *
 * There is deliberately no way to raise it: it takes bytes, not options, and no
 * caller passes anything else. See `messageDetailsOptionsSchema` in
 * electron/main.ts for the other half of that statement.
 */
export function exceedsHardParseCap(bytes: number): boolean {
  return bytes > MAX_EML_PARSE_BYTES
}

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

/**
 * §2.145 — cut one decoded body representation to `limit` bytes.
 *
 * Measured and cut in BYTES, not in `String.length`: the latter counts UTF-16
 * code units, so a cap expressed against it would let a body of multi-byte
 * characters through at up to three times the size it is supposed to bound —
 * the same mistake `extractIcsFromRawEmlInline` already had to fix for the ics
 * guard, and worth repeating here rather than rediscovering.
 *
 * Two details that are not decoration:
 *  - the cut lands on a UTF-8 character boundary (walk back over continuation
 *    bytes), so the tail is never a replacement character;
 *  - for HTML, a cut that lands INSIDE a tag drops that partial tag. Browsers
 *    and DOMPurify both survive `<div class="` — DOMPurify by discarding it —
 *    but the discard is silent and shape-dependent, and we would rather the
 *    truncation be a property of this function than of whatever the sanitizer
 *    happens to do with a fragment.
 *
 * Returns the input unchanged (and `truncated: false`) whenever it fits, so the
 * ordinary message pays one `Buffer.byteLength` and nothing else.
 */
export function capDecodedBody(
  value: string,
  limit: number,
  kind: 'html' | 'text',
): { value: string; truncated: boolean } {
  if (!value) return { value, truncated: false }
  if (Buffer.byteLength(value, 'utf8') <= limit) return { value, truncated: false }

  const buf = Buffer.from(value, 'utf8')
  let end = Math.min(limit, buf.length)
  // 0b10xxxxxx is a UTF-8 continuation byte — never a character start.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
  let cut = buf.subarray(0, end).toString('utf8')

  if (kind === 'html') {
    const lastOpen = cut.lastIndexOf('<')
    if (lastOpen > cut.lastIndexOf('>')) cut = cut.slice(0, lastOpen)
  }

  return { value: cut, truncated: true }
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
 *
 * §2.145 — `maxBodyBytes` is the SOFT cap. Both production callers (the worker
 * entry and `parseEmlBuffer`'s inline path) pass it EXPLICITLY, from the same
 * resolved value, so the two paths cannot disagree about the limit depending on
 * which one a message happened to take. The default exists for direct callers
 * and specs only. Nobody passes `Infinity`: the raised tier
 * (`EML_BODY_FULL_CAP_BYTES`) is still finite by design.
 *
 * The cap is applied AFTER mailparser has decoded the part — `MailParser`
 * buffers each text node internally and emits it whole, so there is no seam at
 * which we could stop it earlier without forking the parser. What the cap
 * therefore buys is everything DOWNSTREAM of this function (the structured
 * clone back from the worker, the IPC payload, the SQLite details row,
 * DOMPurify, the iframe), each of which is linear in body size and none of
 * which is bounded otherwise. The peak allocation inside the parse is bounded
 * by the hard cap instead — see `MAX_EML_PARSE_BYTES`.
 */
export async function parseEmlBufferInline(
  uid: number,
  raw: Buffer,
  maxBodyBytes: number = EML_BODY_SOFT_CAP_BYTES,
): Promise<MessageDetails> {
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

  // §2.145 — html and text are ALTERNATIVE representations of the same body,
  // so each is measured against the whole cap rather than against a share of
  // it: a message is not penalised for offering both, and neither branch of the
  // renderer (iframe or <pre>) can be handed more than the cap.
  const html = capDecodedBody(parsed.html || '', maxBodyBytes, 'html')
  const text = capDecodedBody(parsed.text || '', maxBodyBytes, 'text')
  const parseCap: MessageParseCap | undefined = html.truncated || text.truncated
    ? {
        kind: 'soft',
        rawBytes: raw.length,
        limitBytes: maxBodyBytes,
        // The raised tier is not itself raisable: a result produced at
        // EML_BODY_FULL_CAP_BYTES offers nothing further, and the banner has to
        // be able to say so rather than showing a button that changes nothing.
        canShowFull: maxBodyBytes < EML_BODY_FULL_CAP_BYTES,
      }
    : undefined

  return {
    uid,
    envelope,
    internalDate: parsed.date?.toISOString(),
    html: html.value || undefined,
    text: text.value || undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    draftId,
    parseCap,
  }
}

/**
 * §2.145 — the hard-cap placeholder: everything we are willing to learn about a
 * message we have decided not to parse.
 *
 * Reads a BOUNDED PREFIX only (`EML_HEADER_SCAN_BYTES`), cut at the end of the
 * header block. That bound is the whole point — streaming a 200 MB message
 * through `MailParser` to recover four header fields would cost the very thing
 * the cap exists to refuse (~1 event-loop turn per 77 bytes, §2.124), and would
 * do it on the main thread, for a message we are not going to show anyway.
 *
 * Bodies are never decoded here, and `attachments` is deliberately absent
 * rather than empty: we did not look, and claiming "no attachments" about a
 * message we never opened would be a lie the UI would repeat to the user.
 *
 * Never throws. A message this size is already an anomaly; a placeholder with
 * an empty envelope still opens, and the size and the banner are what the user
 * actually needs.
 *
 * §2.145 wave 2.1 — `rawBytes` exists because `raw` is no longer always the
 * whole message. The on-disk over-cap path reads only the header window off a
 * file it refuses to load (see `readEmlBounded` in mailStore.ts), so the buffer
 * in hand is 32 KiB while the MESSAGE is 200 MB, and the placeholder must state
 * the latter. Defaults to `raw.length` for callers that do hold everything.
 */
export async function parseEmlHeaderFacts(
  uid: number,
  raw: Buffer,
  rawBytes: number = raw.length,
): Promise<MessageDetails> {
  const parseCap: MessageParseCap = {
    kind: 'hard',
    rawBytes,
    limitBytes: MAX_EML_PARSE_BYTES,
  }
  try {
    const parsed = await parseLightweight(headerBlockOf(raw))
    return {
      uid,
      envelope: {
        date: parsed.date?.toISOString(),
        subject: parsed.subject || undefined,
        messageId: parsed.messageId || undefined,
        from: mapParsedAddrs(parsed.from),
        to: mapParsedAddrs(parsed.to as AddressObject | AddressObject[] | undefined),
        cc: mapParsedAddrs(parsed.cc as AddressObject | AddressObject[] | undefined),
      },
      internalDate: parsed.date?.toISOString(),
      parseCap,
    }
  } catch {
    return { uid, envelope: {}, parseCap }
  }
}

/**
 * The header block of a raw message, cut at the first empty line and bounded by
 * `EML_HEADER_SCAN_BYTES`.
 *
 * Both line endings are looked for: RFC 5322 mandates CRLF, and mail that has
 * been through a Unix mailstore routinely arrives with bare LF. Whichever
 * terminator comes FIRST wins — a CRLF-terminated block whose body happens to
 * contain `\n\n` must not be cut at the body.
 *
 * When neither appears inside the window (a header block longer than the bound,
 * i.e. already malformed) the window is returned with a terminator appended, so
 * the parser sees a complete, if truncated, header block instead of an
 * unterminated stream it would hold open.
 */
function headerBlockOf(raw: Buffer): Buffer {
  const window = raw.subarray(0, Math.min(raw.length, EML_HEADER_SCAN_BYTES))
  const crlf = window.indexOf('\r\n\r\n')
  const lf = window.indexOf('\n\n')
  const candidates = [
    crlf >= 0 ? crlf + 4 : -1,
    lf >= 0 ? lf + 2 : -1,
  ].filter(end => end > 0)
  if (candidates.length > 0) return window.subarray(0, Math.min(...candidates))
  return Buffer.concat([window, Buffer.from('\r\n\r\n', 'ascii')])
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

/**
 * §2.145 — count one cap trip. Fire-and-forget by the same contract as
 * `recordEmlParseDispatch`: the whole body is guarded, because this sits on the
 * message-open path and a broken telemetry sink must never cost a user a
 * message.
 *
 * Reported from the MAIN thread on purpose, by inspecting the finished result,
 * rather than from wherever the cap was applied. The soft cap is applied inside
 * `parseEmlBufferInline`, which runs in the worker for anything above the
 * offload threshold — and the worker installs no telemetry sink (packages/net's
 * seam is wired by main.ts alone), so a trip reported there would simply be
 * dropped, and the metric would silently only ever see small messages.
 *
 * Aggregates only: a size band and, for the soft cap, which tier tripped.
 * Nothing derived from the message itself.
 */
/**
 * §2.145 wave 2.1 — report a hard-cap trip from an ACQUISITION boundary.
 *
 * Same counter as a trip at parser entry, deliberately: `eml.parse_cap_hard`
 * measures the POLICY (a message was too large to open, and the user got a
 * header-only placeholder), not the code site that happened to notice. Splitting
 * it per site would fragment the only signal we have about whether 100 MiB is
 * the right number, and the question "does anyone actually receive mail this
 * size" is identical whichever doorway refused it.
 *
 * `rawBytes` from a streaming refusal is a LOWER BOUND — the count when we
 * stopped consuming, not the message's true size. That is immaterial to the
 * metric: the value is bucketed, and anything reaching this ceiling lands in
 * `1MB+` either way.
 */
export function recordHardParseCapTrip(rawBytes: number): void {
  recordParseCapTrip({ kind: 'hard', rawBytes, limitBytes: MAX_EML_PARSE_BYTES })
}

function recordParseCapTrip(cap: MessageParseCap): void {
  try {
    if (cap.kind === 'hard') {
      reportNetEvent('eml.parse_cap_hard', { size_bucket: bucketBodySize(cap.rawBytes) })
      return
    }
    reportNetEvent('eml.parse_cap_soft', {
      size_bucket: bucketBodySize(cap.rawBytes),
      tier: cap.canShowFull ? 'default' : 'full',
    })
  } catch { /* telemetry must never break a parse */ }
}

/** The decoded-body limit for one open. `full` is set only by an explicit user
 *  action ("Show full message"), never by a retry, a background path or a
 *  cache miss — see the `net:messageDetails` handler in electron/main.ts. */
function resolveBodyLimit(full: boolean | undefined): number {
  return full ? EML_BODY_FULL_CAP_BYTES : EML_BODY_SOFT_CAP_BYTES
}

export async function parseEmlBuffer(
  uid: number,
  raw: Buffer,
  opts?: { signal?: AbortSignal; full?: boolean },
): Promise<MessageDetails> {
  // §2.145 — the HARD cap, and note where it stands: before `planEmlParseDispatch`,
  // so these bytes are never dispatched anywhere. That makes it a THIRD outcome
  // alongside the two §2.124 documents above, and it must not be confused with
  // either. It is not the inline fallback (nothing is parsed) and it is not the
  // queue refusal (nothing is refused — the open SUCCEEDS, with a placeholder,
  // and does so deterministically for the same message every time, rather than
  // depending on what else was in flight). No dispatch is counted, for the same
  // reason a refusal counts none: no parse took place on any thread.
  if (exceedsHardParseCap(raw.length)) {
    const details = await parseEmlHeaderFacts(uid, raw)
    if (details.parseCap) recordParseCapTrip(details.parseCap)
    return details
  }
  const maxBodyBytes = resolveBodyLimit(opts?.full)
  const plan = planEmlParseDispatch(raw)
  if (plan.path === 'worker') {
    try {
      const details = await parseEmlDetailsInWorker(uid, raw, maxBodyBytes, opts?.signal)
      recordEmlParseDispatch('worker', raw.length)
      if (details.parseCap) recordParseCapTrip(details.parseCap)
      return details
    } catch (err) {
      if (err instanceof EmlWorkerUnavailableError) {
        // The parse still happens — inline, on the main loop, at the cost this
        // whole mechanism exists to avoid. Counted as such.
        recordEmlParseDispatch('inline_unavailable', raw.length)
        return inlineWithCapTrip(uid, raw, maxBodyBytes)
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
  return inlineWithCapTrip(uid, raw, maxBodyBytes)
}

/** Inline parse plus the cap-trip report, so the metric does not depend on
 *  which of the three inline entry points a message took. */
async function inlineWithCapTrip(uid: number, raw: Buffer, maxBodyBytes: number): Promise<MessageDetails> {
  const details = await parseEmlBufferInline(uid, raw, maxBodyBytes)
  if (details.parseCap) recordParseCapTrip(details.parseCap)
  return details
}

export async function extractIcsFromRawEml(
  raw: Buffer,
  opts?: { signal?: AbortSignal },
): Promise<string | undefined> {
  // §2.145 — the hard cap binds here too, and this is not belt-and-braces: the
  // EML cache path in electron/main.ts hands the SAME buffer to this function
  // right after `parseEmlBuffer` (the calendar part has to be recovered from
  // the raw bytes because the body parse skips attachment content). Without
  // this guard the cap would refuse the parse and then immediately pay for a
  // FULL `simpleParser` over the same oversized input — which buffers every
  // attachment, i.e. costs strictly more than the parse we just declined.
  // A calendar card is best-effort everywhere on this path, so there is nothing
  // to report and nothing to fall back to.
  if (exceedsHardParseCap(raw.length)) return undefined
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
  // §2.145 — defence in depth. No `eml:N` part should exist for a message the
  // hard cap refused (the placeholder lists no attachments, so the renderer has
  // no chip to click), but this is the one entry point that buffers EVERY
  // attachment of a message into memory at once — the most expensive thing that
  // can be done with these bytes. It must not be reachable with a part
  // identifier that outlived its message, an AI tool call, or a cached details
  // row written before the cap existed.
  if (exceedsHardParseCap(raw.length)) return null
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
