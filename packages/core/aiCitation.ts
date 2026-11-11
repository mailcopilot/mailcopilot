/**
 * Citation tickets of the chat (§3.3 B3). When a mail tool hands a message row to the model, main issues a random
 * ticket for it and puts the ready link `mailref://c/<ticket>` next to the row; the model only repeats it. A link is
 * a source only if its ticket is in the registry of THIS session, so a link the model composed itself, or copied
 * wrong, has nothing to resolve to. The format lives here so main (issuing) and renderer (judging) cannot drift. Which
 * links an answer contains is NOT decided here: the renderer reads them from the markdown parse that draws the answer
 * (`src/utils/answerCitations.ts`).
 */
/** 5 bits per character: 8 characters are 40 random bits, and the alphabet has no digits 0, 1, 8, 9. */
export const CITATION_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
export const CITATION_TOKEN_LENGTH = 8
export const CITATION_HREF_PREFIX = 'mailref://c/'
/** Most tickets one answer can resolve to sources. */
export const CITATION_MAX_PER_ANSWER = 100

const TOKEN_RE = /^[a-z2-7]{8}$/

export function isCitationToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value)
}

export function citationHref(token: string): string {
  return `${CITATION_HREF_PREFIX}${token}`
}

/** The ticket of an exact `mailref://c/<ticket>` link, else `null`. */
export function parseCitationHref(href: string | undefined | null): string | null {
  if (typeof href !== 'string' || !href.startsWith(CITATION_HREF_PREFIX)) return null
  const token = href.slice(CITATION_HREF_PREFIX.length)
  return isCitationToken(token) ? token : null
}
