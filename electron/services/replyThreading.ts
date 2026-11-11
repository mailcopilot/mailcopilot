import { buildReplyThreadHeaders, type ReplyParentHeaders } from '../../packages/core/replyThreading'

/** Pointer to the message being replied to, as the compose window knows it. */
export type ReplyRef = { accountId: number; folder: string; uid: number }

export type ParentLookup = (accountId: number, folder: string, uid: number) => ReplyParentHeaders | undefined

/**
 * Resolve the threading headers of a reply from the LOCAL cache. The renderer
 * only points at the parent (`replyRef`); the ids come from main's own copy of
 * the parent's headers, so a renderer cannot put arbitrary values into
 * `In-Reply-To` / `References`.
 *
 * The parent is looked up in the account the POINTER names, whichever mailbox
 * or identity ends up sending the reply: choosing another sender in the compose
 * window changes who answers, not what is being answered (Thunderbird threads
 * a reply sent from another identity the same way).
 *
 * Returns `{}` (no headers) for a send without a parent, a parent that left the
 * cache or a parent without a Message-ID: a reply that cannot point at its
 * parent is sent unthreaded rather than blocked.
 */
export function resolveReplyThreading(
  replyRef: ReplyRef | undefined,
  lookup: ParentLookup,
): { inReplyTo?: string; references?: string } {
  if (!replyRef) return {}
  const parent = lookup(replyRef.accountId, replyRef.folder, replyRef.uid)
  const headers = parent ? buildReplyThreadHeaders(parent) : null
  return headers ?? {}
}

/** The reply header of a saved draft, as the local cache holds it. */
export type DraftHeaders = { inReplyTo?: string | null }

/**
 * Reopening a saved reply draft: the draft message carries `In-Reply-To` (main
 * wrote it when the draft was saved), and the pointer to the parent is found
 * again from that id in the SAME account's cache. Only a pointer comes out, so
 * the headers of the eventual send are derived from the parent exactly as for a
 * first-time reply (`resolveReplyThreading`), never copied from the draft text.
 *
 * No pointer when the draft answers nothing, is not in the cache, or its parent
 * is no longer there: the reply then goes out unthreaded, as it would for any
 * parent that left the cache.
 */
export function resolveDraftReplyRef(
  draftRef: ReplyRef | undefined,
  readDraft: (accountId: number, folder: string, uid: number) => DraftHeaders | undefined,
  findParent: (accountId: number, messageId: string) => { folder: string; uid: number } | undefined,
): ReplyRef | undefined {
  if (!draftRef) return undefined
  const stored = readDraft(draftRef.accountId, draftRef.folder, draftRef.uid)?.inReplyTo
  const parentId = typeof stored === 'string' ? stored.match(/<[^<>\s]{1,998}>/)?.[0] : undefined
  if (!parentId) return undefined
  const parent = findParent(draftRef.accountId, parentId)
  return parent ? { accountId: draftRef.accountId, folder: parent.folder, uid: parent.uid } : undefined
}
