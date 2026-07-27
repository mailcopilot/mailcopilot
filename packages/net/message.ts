import { simpleParser } from 'mailparser'
import { connectImap, withImapRetry, connectImapPerAccount, withImapRetryPerAccount } from './imap'
import type { DownloadObject, ImapFlow } from 'imapflow'
import type { ImapConfig, MessageDetails, MailAddress, AttachmentMeta } from './types'
import type { MessageEnvelopeObject, MessageStructureObject } from 'imapflow'

/**
 * §2.22 Wave A — identify a MIME leaf carrying an iCalendar invite. Outlook,
 * Apple Calendar, Google Calendar and Thunderbird publish under
 * `text/calendar`; some providers (notably older Outlook) attach as
 * `application/ics` or as `application/octet-stream` with an `.ics` filename.
 * Layer-pure: this only inspects BODYSTRUCTURE, never parses the ics — the
 * actual ical.js parsing happens in `electron/services/inviteBridge.ts` so
 * `packages/net` stays free of the dependency.
 */
function isCalendarPart(node: MessageStructureObject): boolean {
  const type = (node.type || '').toLowerCase()
  if (type === 'text/calendar' || type === 'application/ics') return true
  if (type === 'application/octet-stream') {
    const filename = filenameFromStructure(node)
    if (filename && /\.ics$/i.test(filename)) return true
  }
  return false
}

function parseHeaders(buf: Buffer | undefined): Record<string, string> {
  if (!buf) return {}
  const raw = buf.toString('utf8')
  const lines = raw.split(/\r?\n/)

  const res: Record<string, string> = {}
  let curKey: string | null = null
  let curVal = ''

  const flush = () => {
    if (!curKey) return
    res[curKey.toLowerCase()] = curVal.trim()
    curKey = null
    curVal = ''
  }

  for (const line of lines) {
    if (!line) continue
    if (/^[ \t]/.test(line) && curKey) {
      curVal += ' ' + line.trim()
      continue
    }
    flush()
    const idx = line.indexOf(':')
    if (idx < 0) continue
    curKey = line.slice(0, idx).trim()
    curVal = line.slice(idx + 1).trim()
  }
  flush()

  return res
}

function parseListUnsubscribe(headerValue: string | undefined): string[] {
  if (!headerValue) return []
  const src = headerValue.trim()
  if (!src) return []

  const out: string[] = []
  const angleMatches = src.match(/<[^>]+>/g)
  if (angleMatches && angleMatches.length > 0) {
    for (const raw of angleMatches) {
      const v = raw.slice(1, -1).trim()
      if (v) out.push(v)
    }
    return [...new Set(out)]
  }

  for (const token of src.split(',')) {
    const v = token.trim()
    if (v) out.push(v)
  }
  return [...new Set(out)]
}

function mapAddr(list?: { name?: string; address?: string }[] | null): MailAddress[] | undefined {
  if (!list || list.length === 0) return undefined
  return list.map(a => ({ name: a.name, address: a.address }))
}

function mapEnvelope(env?: MessageEnvelopeObject): MessageDetails['envelope'] | undefined {
  if (!env) return undefined
  const refsRaw = (env as { references?: unknown }).references
  const references = Array.isArray(refsRaw)
    ? refsRaw.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean).join(' ')
    : (typeof refsRaw === 'string' ? refsRaw.trim() : undefined)
  return {
    date: env.date ? new Date(env.date).toISOString() : undefined,
    subject: env.subject,
    messageId: env.messageId,
    inReplyTo: env.inReplyTo,
    references: references || undefined,
    from: mapAddr(env.from),
    replyTo: mapAddr(env.replyTo),
    to: mapAddr(env.to),
    cc: mapAddr(env.cc),
    bcc: mapAddr(env.bcc),
  }
}

function filenameFromStructure(node: MessageStructureObject): string | undefined {
  return node.dispositionParameters?.filename || node.parameters?.name
}

function collectLeaves(node: MessageStructureObject | undefined, out: MessageStructureObject[]) {
  if (!node) return
  if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
    for (const ch of node.childNodes) collectLeaves(ch, out)
    return
  }
  out.push(node)
}

function listAttachments(structure: MessageStructureObject | undefined): AttachmentMeta[] {
  const leaves: MessageStructureObject[] = []
  collectLeaves(structure, leaves)

  const res: AttachmentMeta[] = []
  for (const n of leaves) {
    const filename = filenameFromStructure(n)
    const disp = (n.disposition || '').toLowerCase()
    const hasCid = Boolean(n.id)
    const isTextBody = n.type === 'text/plain' || n.type === 'text/html'
    // Inline parts without filename but with Content-ID (cid:) are also considered attachments (inline images).
    const isAttachment = disp === 'attachment' || (disp === 'inline' && !isTextBody && (Boolean(filename) || hasCid))
    if (!isAttachment) continue
    const part = n.part || '1'
    res.push({
      part,
      filename: filename || undefined,
      contentType: n.type || undefined,
      size: typeof n.size === 'number' ? n.size : undefined,
      disposition: n.disposition || undefined,
      cid: n.id || undefined,
    })
  }
  return res
}

async function readStreamToString(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > maxBytes) break
      chunks.push(buf)
    }
  } finally {
    // Ensure the stream is closed (for-await should call return(), but let's be safe).
    if ('destroy' in stream && typeof (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy === 'function') {
      (stream as NodeJS.ReadableStream & { destroy: () => void }).destroy()
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Fetch only the text body parts (text/plain and text/html) via BODYSTRUCTURE,
 * without downloading attachments.  Used by the background body indexer.
 */
/** Shared body-fetch logic — given an open ImapFlow connection, fetch text/html body for a UID. */
async function fetchBodyFromConnection(c: ImapFlow, mailbox: string, uid: number): Promise<{ html?: string; text?: string }> {
  await c.mailboxOpen(mailbox)
  const meta = await c.fetchOne(uid, { bodyStructure: true, uid: true }, { uid: true })
  if (!meta) return {}

  const leaves: MessageStructureObject[] = []
  collectLeaves(meta.bodyStructure as MessageStructureObject | undefined, leaves)

  const isBodyText = (n: MessageStructureObject) => {
    if (n.type !== 'text/plain' && n.type !== 'text/html') return false
    if (n.disposition === 'attachment') return false
    const filename = filenameFromStructure(n)
    if (n.disposition === 'inline' && filename) return false
    return true
  }

  const htmlNode = leaves.find(n => n.type === 'text/html' && isBodyText(n))
  const textNode = leaves.find(n => n.type === 'text/plain' && isBodyText(n))
  const htmlPart = htmlNode?.part || (meta.bodyStructure?.type === 'text/html' ? '1' : undefined)
  const textPart = textNode?.part || (meta.bodyStructure?.type === 'text/plain' ? '1' : undefined)

  if (!htmlPart && !textPart) {
    const FALLBACK_MAX = 1 * 1024 * 1024
    const { content } = await c.download(uid, undefined, { uid: true, maxBytes: FALLBACK_MAX })
    if (!content) return {}
    const parsed = await simpleParser(content)
    return { html: parsed.html || undefined, text: parsed.text || undefined }
  }

  const MAX_BODY_BYTES = 2 * 1024 * 1024
  let html: string | undefined
  let text: string | undefined

  if (htmlPart) {
    const { content } = await c.download(uid, htmlPart, { uid: true, maxBytes: MAX_BODY_BYTES })
    html = content ? await readStreamToString(content, MAX_BODY_BYTES) : undefined
  }
  if (textPart && textPart !== htmlPart) {
    const { content } = await c.download(uid, textPart, { uid: true, maxBytes: MAX_BODY_BYTES })
    text = content ? await readStreamToString(content, MAX_BODY_BYTES) : undefined
  }

  return { html, text }
}

export async function fetchMessageBody(accountId: number, cfg: ImapConfig, mailbox: string, uid: number): Promise<{ html?: string; text?: string }> {
  return withImapRetryPerAccount(accountId, cfg, async () => {
    const c = await connectImapPerAccount(cfg)
    return fetchBodyFromConnection(c, mailbox, uid)
  })
}

/** Uses main singleton connection — for interactive message open (not blocked by per-account sync). */
export async function fetchMessageBodyViaMain(accountId: number, cfg: ImapConfig, mailbox: string, uid: number): Promise<{ html?: string; text?: string }> {
  return withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    return fetchBodyFromConnection(c, mailbox, uid)
  })
}

/**
 * §2.17 Phase 0 — optional AbortSignal lets the caller (net:messageDetails
 * with the 10s budget) bail out at logical boundaries when the budget
 * expires. imapflow's fetch/download API does not expose a native
 * AbortSignal hook, so the underlying socket I/O may continue after abort
 * (the in-flight retry callback owns the connection and cannot be torn
 * down without disrupting the per-account pool). The signal makes the
 * timeout effective at the JS layer: each await is checked before and
 * after, so the caller's Promise.race winner gets to short-circuit any
 * remaining body downloads instead of waiting for them to finish. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error('IMAP fetch aborted')
    ;(err as Error & { name: string }).name = 'AbortError'
    throw err
  }
}

export async function fetchMessageDetails(accountId: number, cfg: ImapConfig, mailbox: string, uid: number, signal?: AbortSignal): Promise<MessageDetails> {
  return withImapRetry(accountId, cfg, async () => {
  throwIfAborted(signal)
  const c = await connectImap(cfg)
  throwIfAborted(signal)
  await c.mailboxOpen(mailbox)
  throwIfAborted(signal)

  const meta = await c.fetchOne(
    uid,
    {
      envelope: true,
      flags: true,
      internalDate: true,
      bodyStructure: true,
      headers: ['X-MailCopilot-Draft-Id', 'List-Unsubscribe', 'List-Unsubscribe-Post'],
      uid: true,
    },
    { uid: true }
  )
  throwIfAborted(signal)
  if (!meta) return { uid }

  // 1) Headers and attachment list from BODYSTRUCTURE/ENVELOPE (fast, without downloading attachments)
  const envelope = mapEnvelope(meta.envelope as MessageEnvelopeObject | undefined)
  const flags = meta.flags ? Array.from(meta.flags) : undefined
  const internalDate =
    meta.internalDate instanceof Date ? meta.internalDate.toISOString() : typeof meta.internalDate === 'string' ? meta.internalDate : undefined
  const attachments = listAttachments(meta.bodyStructure as MessageStructureObject | undefined)
  const parsedHeaders = parseHeaders(meta.headers as Buffer | undefined)
  const draftId = parsedHeaders['x-mailcopilot-draft-id']
  const listUnsubscribe = parseListUnsubscribe(parsedHeaders['list-unsubscribe'])
  const listUnsubscribePost = parsedHeaders['list-unsubscribe-post']

  // 2) Message body: download only the text part (part: html/plain), without the full RFC822.
  const leaves: MessageStructureObject[] = []
  collectLeaves(meta.bodyStructure as MessageStructureObject | undefined, leaves)

  const isBodyText = (n: MessageStructureObject) => {
    if (n.type !== 'text/plain' && n.type !== 'text/html') return false
    if (n.disposition === 'attachment') return false
    const filename = filenameFromStructure(n)
    if (n.disposition === 'inline' && filename) return false
    return true
  }

  const htmlNode = leaves.find(n => n.type === 'text/html' && isBodyText(n))
  const textNode = leaves.find(n => n.type === 'text/plain' && isBodyText(n))

  // For single-part text messages, BODYSTRUCTURE at the root has no part — use '1', download() will handle it.
  const htmlPart = htmlNode?.part || (meta.bodyStructure?.type === 'text/html' ? '1' : undefined)
  const textPart = textNode?.part || (meta.bodyStructure?.type === 'text/plain' ? '1' : undefined)

  const MAX_BODY_BYTES = 5 * 1024 * 1024
  let html: string | undefined
  let text: string | undefined

  if (htmlPart) {
    throwIfAborted(signal)
    const { content } = await c.download(uid, htmlPart, { uid: true, maxBytes: MAX_BODY_BYTES })
    html = content ? await readStreamToString(content, MAX_BODY_BYTES) : undefined
  }

  if (textPart && textPart !== htmlPart) {
    throwIfAborted(signal)
    const { content } = await c.download(uid, textPart, { uid: true, maxBytes: MAX_BODY_BYTES })
    text = content ? await readStreamToString(content, MAX_BODY_BYTES) : undefined
  }

  // §2.22 Wave A — additionally pull the `text/calendar` part if present, so
  // the renderer can show an inline RSVP card. We only download the part body
  // (capped at 1 MiB — invites are tiny by design); the parsing into a
  // CalendarInvite happens in main via `electron/services/inviteBridge.ts`.
  // Failing to download the ics must never break the rest of the message: a
  // truncated/missing invite simply leaves `calendarInviteRaw` undefined and
  // the renderer falls back to showing the underlying attachment row.
  let calendarInviteRaw: string | undefined
  const MAX_ICS_BYTES = 1 * 1024 * 1024
  const calendarNode = leaves.find(isCalendarPart)
  if (calendarNode?.part) {
    try {
      throwIfAborted(signal)
      const { content } = await c.download(uid, calendarNode.part, { uid: true, maxBytes: MAX_ICS_BYTES })
      if (content) {
        calendarInviteRaw = await readStreamToString(content, MAX_ICS_BYTES)
      }
    } catch {
      // Best-effort — unreachable in normal IMAP flow but tolerated for
      // weird providers that fail when fetching specific MIME parts.
      calendarInviteRaw = undefined
    }
  }

  // If we didn't find text/html|plain part (rare messages), use fallback: full parsing (may download attachments).
  if (!html && !text) {
    throwIfAborted(signal)
    const { content } = await c.download(uid, undefined, { uid: true, maxBytes: MAX_BODY_BYTES })
    if (content) {
      const parsed = await simpleParser(content)
      html = parsed.html || undefined
      text = parsed.text || undefined
    }
  }

  return {
    uid,
    envelope,
    flags,
    internalDate,
    listUnsubscribe,
    listUnsubscribePost,
    html,
    text,
    attachments,
    draftId,
    calendarInviteRaw,
  }
  })
}

export async function downloadMessagePart(accountId: number, cfg: ImapConfig, mailbox: string, uid: number, part: string): Promise<DownloadObject> {
  return withImapRetry(accountId, cfg, async () => {
    const c = await connectImap(cfg)
    await c.mailboxOpen(mailbox)
    return c.download(uid, part, { uid: true })
  })
}

/** Downloads the full original message (RFC822) as a Buffer.
 *
 *  §2.17 Phase 0 — optional AbortSignal mirrors fetchMessageDetails: the
 *  per-folder offline cache-miss path wraps this call in the same 10s
 *  Promise.race budget, and the signal short-circuits the chunk loop at
 *  logical boundaries when the timer fires. The underlying ImapFlow
 *  download stream does not natively support abort, so an in-flight
 *  socket read may complete; this is best-effort cancellation. */
export async function downloadRawMessage(accountId: number, cfg: ImapConfig, mailbox: string, uid: number, signal?: AbortSignal): Promise<Buffer | null> {
  return withImapRetry(accountId, cfg, async () => {
    throwIfAborted(signal)
    const c = await connectImap(cfg)
    throwIfAborted(signal)
    await c.mailboxOpen(mailbox)
    throwIfAborted(signal)
    const { content } = await c.download(uid, undefined, { uid: true })
    if (!content) return null
    const chunks: Buffer[] = []
    for await (const chunk of content as AsyncIterable<Buffer>) {
      throwIfAborted(signal)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  })
}

/**
 * §2.22 Wave A — extract a raw `text/calendar` part from a full RFC822 buffer.
 * Used by the local-EML cache path: `electron/main.ts` already loads the raw
 * message bytes from disk (`readEml`) and parses them via `parseEmlBuffer`,
 * which intentionally skips attachment content for speed. This helper does
 * a one-shot full parse so we can recover the ics payload without re-fetching
 * from IMAP. Layering note: this stays in `packages/net` because it is pure
 * MIME walking; ical.js parsing is one layer up in `inviteBridge.ts`.
 *
 * §2.22 fix iter4 — codex-security-review MEDIUM: cap returned ics at
 * `MAX_ICS_BYTES` to mirror the IMAP path (`fetchMessageDetails` line 324).
 * Without this guard, a maliciously oversized ics inside an offline-cached
 * EML would force unbounded `simpleParser` + `toString('utf8')` + downstream
 * `ICAL.parse` work, giving an attacker a cheap CPU/memory amplifier.
 */
const MAX_ICS_BYTES = 1 * 1024 * 1024

export async function extractIcsFromRawEml(raw: Buffer): Promise<string | undefined> {
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

/** Downloads the full original message via per-account IMAP pool (for parallel sync) */
export async function downloadRawMessagePerAccount(accountId: number, cfg: ImapConfig, mailbox: string, uid: number): Promise<Buffer | null> {
  return withImapRetryPerAccount(accountId, cfg, async () => {
    const c = await connectImapPerAccount(cfg)
    await c.mailboxOpen(mailbox)
    const { content } = await c.download(uid, undefined, { uid: true })
    if (!content) return null
    const chunks: Buffer[] = []
    for await (const chunk of content as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  })
}
