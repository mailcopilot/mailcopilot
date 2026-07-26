import type { MailSummary } from '@mailcopilot/types'

export type ThreadRow = {
  key: string
  lead: MailSummary
  items: MailSummary[]
  count: number
}

function summaryKey(m: MailSummary): string {
  return `${m.accountId}:${m.folder}:${m.uid}`
}

function normalizeThreadToken(raw: string | undefined): string {
  return (raw || '').trim().replace(/^<+/, '').replace(/>+$/, '').toLowerCase()
}

function splitThreadReferences(raw: string | undefined): string[] {
  const s = (raw || '').trim()
  if (!s) return []
  return s
    .split(/\s+/g)
    .map(normalizeThreadToken)
    .filter(Boolean)
}

export function buildThreadRows(items: MailSummary[]): ThreadRow[] {
  if (items.length <= 1) {
    return items.map(m => ({ key: summaryKey(m), lead: m, items: [m], count: 1 }))
  }

  const parent = new Map<string, string>()
  const find = (x: string): string => {
    const p = parent.get(x)
    if (!p || p === x) return x
    const r = find(p)
    parent.set(x, r)
    return r
  }
  const unite = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  const ensure = (x: string) => {
    if (!parent.has(x)) parent.set(x, x)
  }

  const idsByMail = new Map<string, string[]>()

  for (const m of items) {
    const ids = [
      normalizeThreadToken(m.messageId),
      normalizeThreadToken(m.inReplyTo),
      ...splitThreadReferences(m.references),
    ].filter(Boolean)

    if (ids.length > 0) {
      // Scope threads per-account so that identical Message-IDs across different accounts are not merged.
      const accountScoped = ids.map(id => `${m.accountId}:${id}`)
      idsByMail.set(summaryKey(m), accountScoped)
      for (const id of accountScoped) ensure(id)
      for (let i = 1; i < accountScoped.length; i++) unite(accountScoped[0]!, accountScoped[i]!)
    }
  }

  const groups = new Map<string, MailSummary[]>()
  for (const m of items) {
    const mk = summaryKey(m)
    const ids = idsByMail.get(mk)
    const key = ids && ids.length > 0 ? `thread:${find(ids[0]!)}` : `single:${mk}`
    const g = groups.get(key)
    if (g) g.push(m)
    else groups.set(key, [m])
  }

  // Preserve "by latest message" order as in the original list.
  return Array.from(groups.entries()).map(([key, groupItems]) => ({
    key,
    lead: groupItems[0]!,
    items: groupItems,
    count: groupItems.length,
  }))
}
