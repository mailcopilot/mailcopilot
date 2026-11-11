import type { MailSummary } from '../../packages/net/types'

export type MessageRefLike = { accountId: number; folder: string; uid: number }
type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

interface DetailsLike {
  envelope?: {
    from?: Array<{ address?: string; name?: string }>
    subject?: string
    date?: string
    messageId?: string
    inReplyTo?: string
    references?: string
  }
  flags?: string[]
  attachments?: unknown[]
}

/**
 * The list row for a message named by (account, folder, uid): the local cache first, then the server.
 * `null` when neither knows it, which is the case for a link into a mailbox that was deleted: an account
 * number is issued once and never reused, so such a link can only ever find nothing, never another
 * mailbox's message.
 */
export async function resolveMessageRefSummary(ref: MessageRefLike, invoke: Invoke): Promise<MailSummary | null> {
  const { accountId, folder, uid } = ref
  const cached = await invoke('cache:messageByUid', accountId, folder, uid) as MailSummary | null
  if (cached) return cached
  try {
    const details = await invoke('net:messageDetails', accountId, folder, uid) as DetailsLike
    const from0 = details.envelope?.from?.[0]
    const fromAddr = (from0?.address || '').trim()
    const fromName = (from0?.name || '').trim()
    const flags = details.flags || []
    return {
      accountId,
      folder,
      uid,
      from: fromName || fromAddr || `UID ${uid}`,
      fromAddr: fromAddr || undefined,
      fromName: fromName || undefined,
      subject: details.envelope?.subject || `(uid:${uid})`,
      date: details.envelope?.date || new Date().toISOString(),
      unread: !flags.includes('\\Seen'),
      flagged: flags.includes('\\Flagged'),
      hasAttachments: Boolean(details.attachments && details.attachments.length > 0),
      messageId: details.envelope?.messageId,
      inReplyTo: details.envelope?.inReplyTo,
      references: details.envelope?.references,
    }
  } catch {
    return null
  }
}
