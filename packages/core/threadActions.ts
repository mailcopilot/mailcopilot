import type { MailSummary } from '@mailcopilot/types'
import type { ThreadRow } from './threading'

type MailKey = string

function mailKey(m: { accountId: number; folder: string; uid: number }): MailKey {
  return `${m.accountId}:${m.folder}:${m.uid}`
}

/**
 * If groupConversations is enabled, finds all messages in the thread containing m.
 * Otherwise returns [m].
 */
export function resolveThreadItems(m: MailSummary, threadRows: ThreadRow[], groupConversations: boolean): MailSummary[] {
  if (!groupConversations) return [m]
  const mk = mailKey(m)
  for (const row of threadRows) {
    if (row.items.some(item => mailKey(item) === mk)) return row.items
  }
  return [m]
}

/**
 * Expands selected keys to full threads when groupConversations is enabled.
 * If any message in a thread is selected, all items of the thread are included in the result.
 */
export function expandBulkToThreads(
  selectedKeys: Set<MailKey>,
  mails: MailSummary[],
  threadRows: ThreadRow[],
  groupConversations: boolean,
): MailSummary[] {
  if (!groupConversations) {
    return mails.filter(m => selectedKeys.has(mailKey(m)))
  }
  const result: MailSummary[] = []
  const seen = new Set<MailKey>()
  for (const row of threadRows) {
    const hasSelected = row.items.some(item => selectedKeys.has(mailKey(item)))
    if (!hasSelected) continue
    for (const item of row.items) {
      const ik = mailKey(item)
      if (!seen.has(ik)) {
        seen.add(ik)
        result.push(item)
      }
    }
  }
  return result
}
