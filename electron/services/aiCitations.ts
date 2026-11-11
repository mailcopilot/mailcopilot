/**
 * Citation tickets of the chat (§3.3 B3), main side.
 *
 * Issuing. A mail tool calls `citationFor` on a row it has just read from our database, before the row is
 * serialised and wrapped; the model gets the ready link `mailref://c/<ticket>` in the row and only repeats it.
 * No text of what went to the model is ever scanned back, and no tool result is reinterpreted afterwards: the
 * ticket IS the fact that main handed this row to the model in this session.
 *
 * Judging. A link is a source only if its ticket is registered for the session the link is shown in
 * (`resolveCitations`). Opening (`openCitation`) finds the message by the same rule as every chat source
 * (`findMessageForSource`: the place with the same Message-ID, else that Message-ID in the account) and hands the
 * renderer the CURRENT place; the renderer then opens it exactly as a click in the list does.
 *
 * Practice this follows: the application, not the model, issues the identifier of a source and the answer only
 * points at it (Anthropic search results `source`, OpenAI `file_citation` ids issued by the platform).
 */
import { z } from 'zod'
import { CITATION_MAX_PER_ANSWER, citationHref, isCitationToken } from '../../packages/core'
import { findMessageForSource, getAiCitation, listAiCitations, mintAiCitation } from '../../packages/db'
import { createLogger } from '../logger'

const log = createLogger('AiCitations')

/** The fields of a message row a ticket is issued for (a `MessageRow` fits). */
export interface CitedRow {
  accountId: number
  folder: string
  uid: number
  messageId?: string | null
}

/**
 * The link to give the model next to a row, or `undefined` when there is none to give: no session (the export
 * server, a request without a session), no usable Message-ID, or a database refusal. Never throws.
 */
export function citationFor(sessionId: string | undefined, row: CitedRow): string | undefined {
  if (!sessionId) return undefined
  try {
    const token = mintAiCitation(sessionId, { accountId: row.accountId, folder: row.folder, uid: row.uid, messageId: row.messageId })
    return token ? citationHref(token) : undefined
  } catch (e) {
    log.warn(`citation not issued: ${e instanceof Error ? e.name : 'error'}`)
    return undefined
  }
}

/**
 * `row` with its `cite` link as the FIRST field (so a cut at the size cap loses the rest of the row, not the link).
 * A `cite` already in `row` is dropped: the only link a row carries is the one main issues here.
 */
export function withCitation<T extends object>(sessionId: string | undefined, source: CitedRow, row: T): T | ({ cite: string } & T) {
  const cite = citationFor(sessionId, source)
  if (!cite) return row
  const rest: Record<string, unknown> = { ...(row as object) }
  delete rest.cite
  return { cite, ...(rest as T) }
}

const sessionIdSchema = z.string().min(1).max(200)

export const resolveCitationsSchema = z.object({
  sessionId: sessionIdSchema,
  tokens: z.array(z.string().max(32)).max(CITATION_MAX_PER_ANSWER),
})
export const openCitationSchema = z.object({ sessionId: sessionIdSchema, token: z.string().max(32) })

export type CitationStatus =
  | { token: string; status: 'found'; subject: string; from: string; date: string }
  /** The ticket is ours, but the message is not in the mailbox any more. */
  | { token: string; status: 'missing' }
  /** Not a ticket of this session: the link is not a source. */
  | { token: string; status: 'unknown' }

/** What each ticket of an answer is, for the renderer: a source (found or missing) or not a source at all. */
export function resolveCitations(raw: unknown): CitationStatus[] {
  const parsed = resolveCitationsSchema.safeParse(raw)
  if (!parsed.success) return []
  const { sessionId } = parsed.data
  const tokens = [...new Set(parsed.data.tokens)]
  let registered: Map<string, ReturnType<typeof getAiCitation>>
  try {
    registered = new Map(listAiCitations(sessionId, tokens.filter(isCitationToken)).map(r => [r.token, r]))
  } catch (e) {
    // A failed read says nothing about the tickets: answer about none, so the renderer keeps them pending and asks again
    // (an "unknown" here would be a false statement that the app never issued the link).
    log.warn(`citations not read: ${e instanceof Error ? e.name : 'error'}`)
    return []
  }
  return tokens.map((token): CitationStatus => {
    const entry = registered.get(token)
    if (!entry) return { token, status: 'unknown' }
    let found: ReturnType<typeof findMessageForSource>
    try { found = findMessageForSource(entry.accountId, entry.folder, entry.uid, entry.messageId) } catch { found = undefined }
    return found
      ? { token, status: 'found', subject: found.subject, from: found.from, date: found.date }
      : { token, status: 'missing' }
  })
}

export type OpenCitationResult = { found: true; accountId: number; folder: string; uid: number } | { found: false }

/** The current place of the message a ticket names; the renderer opens it like a click in the list. */
export function openCitation(raw: unknown): OpenCitationResult {
  const parsed = openCitationSchema.safeParse(raw)
  if (!parsed.success || !isCitationToken(parsed.data.token)) return { found: false }
  try {
    const entry = getAiCitation(parsed.data.sessionId, parsed.data.token)
    if (!entry) return { found: false }
    const place = findMessageForSource(entry.accountId, entry.folder, entry.uid, entry.messageId)
    return place ? { found: true, accountId: entry.accountId, folder: place.folder, uid: place.uid } : { found: false }
  } catch {
    return { found: false }
  }
}
