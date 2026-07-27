import { simpleParser, MailParser, type ParsedMail } from 'mailparser'
import type { AddressObject, StructuredHeader } from 'mailparser'
import type { AttachmentMeta, MailAddress, MessageDetails } from './types'

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
 * Parses an EML buffer (RFC822) and extracts MessageDetails.
 * Uses lightweight streaming parser — skips attachment content for speed.
 */
export async function parseEmlBuffer(uid: number, raw: Buffer): Promise<MessageDetails> {
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
