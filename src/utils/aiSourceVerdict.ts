import { parseCitationHref, parseMailrefHref, type MailrefTarget } from '@mailcopilot/core'

/** What main says a citation ticket is (see `resolveCitations` in electron/services/aiCitations.ts). */
export type CitationStatus =
  | { token: string; status: 'found'; subject: string; from: string; date: string }
  | { token: string; status: 'missing' }
  | { token: string; status: 'unknown' }

/**
 * How the panel presents a `mailref://` link in an assistant answer (§3.3 B3).
 *
 *  - `pending`     the answer is still streaming, or main has not answered about the ticket yet.
 *  - `citation`    the ticket is registered for this session: a source. `found` = the message is in the mailbox.
 *  - `legacy`      the answer was saved before citation tickets: its place link works as it always did.
 *  - `unconfirmed` not a source: an unregistered ticket, or a place link in an answer that has tickets.
 *  - `invalid`     not a well-formed mailref.
 *
 * `citation` and `legacy` are clickable; nothing else is. A source means "main handed this message to the model in
 * this conversation"; it says nothing about whether the answer restates the message correctly.
 */
export type MailrefVerdict =
  | { kind: 'pending' | 'unconfirmed' | 'invalid' }
  | { kind: 'citation'; token: string; found: boolean }
  | { kind: 'legacy'; target: MailrefTarget }

export interface MailrefJudgement {
  /** What main said about the tickets of this answer so far, by ticket. */
  citations: ReadonlyMap<string, CitationStatus>
  /** The answer is still being generated. */
  streaming: boolean
  /** The answer was saved before citation tickets existed (its place links keep working). */
  legacyLinks: boolean
}

export function judgeMailref(href: string | undefined, j: MailrefJudgement): MailrefVerdict {
  const token = parseCitationHref(href)
  if (token) {
    if (j.streaming) return { kind: 'pending' }
    // A ticket in an answer from before tickets existed cannot be one of ours.
    if (j.legacyLinks) return { kind: 'unconfirmed' }
    const status = j.citations.get(token)
    if (!status) return { kind: 'pending' }
    return status.status === 'unknown' ? { kind: 'unconfirmed' } : { kind: 'citation', token, found: status.status === 'found' }
  }
  const target = parseMailrefHref(href)
  if (!target) return { kind: 'invalid' }
  if (j.streaming) return { kind: 'pending' }
  // The model composed a place link itself: in an answer written with tickets that is never a source.
  return j.legacyLinks ? { kind: 'legacy', target } : { kind: 'unconfirmed' }
}
