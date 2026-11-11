/**
 * Threading headers of an outgoing reply (RFC 5322 §3.6.4).
 *
 * A reply carries `In-Reply-To` = the parent's `Message-ID` and `References` =
 * the parent's `References` (or, when it has none, its `In-Reply-To` if that
 * holds exactly one id) followed by the parent's `Message-ID`. Without them
 * the recipient's client cannot thread the reply under the original.
 */

export type ReplyParentHeaders = {
  messageId?: string | null
  inReplyTo?: string | null
  references?: string | null
}

export type ReplyThreadHeaders = {
  inReplyTo: string
  references: string
}

// Defensive cap on the parent's own chain: the cached `References` column is
// whatever the sender wrote. The first id (thread root) and the most recent
// ones are the ones receiving clients use, so the middle is what gets dropped.
const MAX_REFERENCE_IDS = 50

// Linear: the character class excludes `<`, `>` and whitespace, so a token can
// never overlap the next one.
const MSG_ID_RE = /<[^<>\s]{1,998}>/g

function extractIds(value: string | null | undefined): string[] {
  if (!value) return []
  // Bound the scan: an id list longer than this is not a real References chain.
  return value.slice(0, 200_000).match(MSG_ID_RE) ?? []
}

/** `<id>` for a stored Message-ID, whether the cache kept the brackets or not. */
function normalizeMessageId(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  const [first] = extractIds(trimmed)
  if (first) return first
  return /^[^<>\s]{1,998}$/.test(trimmed) ? `<${trimmed}>` : null
}

/**
 * Headers for a reply to `parent`, or `null` when the parent has no usable
 * `Message-ID` (nothing to point at, so the headers are omitted rather than
 * invented). Forwards do not call this: Thunderbird sends none either.
 */
export function buildReplyThreadHeaders(parent: ReplyParentHeaders): ReplyThreadHeaders | null {
  const parentId = normalizeMessageId(parent.messageId)
  if (!parentId) return null
  let chain = extractIds(parent.references)
  if (chain.length === 0) {
    const replyIds = extractIds(parent.inReplyTo)
    if (replyIds.length === 1) chain = replyIds
  }
  chain = chain.filter((id) => id !== parentId)
  chain.push(parentId)
  if (chain.length > MAX_REFERENCE_IDS) {
    chain = [chain[0], ...chain.slice(chain.length - (MAX_REFERENCE_IDS - 1))]
  }
  return { inReplyTo: parentId, references: chain.join(' ') }
}
