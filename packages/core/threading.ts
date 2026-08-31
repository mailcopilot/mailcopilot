import type { MailSummary } from '@mailcopilot/types'

/**
 * The unit of unread is the MESSAGE: `\Seen` is owned per-message by the IMAP
 * server, and every counter in the app counts messages. A conversation is our
 * local derivative, so its unread signal is DERIVED from its messages here, at
 * grouping time, and never stored separately. Consumers read `unreadCount`
 * instead of re-scanning `items` (the list is virtualised — per-row scans would
 * run on every visible row on every render).
 */
export type ThreadRow = {
  key: string
  lead: MailSummary
  items: MailSummary[]
  count: number
  /** Number of messages inside the conversation with `unread === true`. */
  unreadCount: number
}

function summaryKey(m: MailSummary): string {
  return `${m.accountId}:${m.folder}:${m.uid}`
}

function countUnread(items: MailSummary[]): number {
  let n = 0
  for (const m of items) if (m.unread) n++
  return n
}

/**
 * Row for a message that stands alone — used both by the single-item fast path
 * here and by the renderer when conversation grouping is switched off, so that
 * the ungrouped list produces exactly the same shape (one message per row).
 */
export function singleMessageRow(m: MailSummary): ThreadRow {
  return { key: summaryKey(m), lead: m, items: [m], count: 1, unreadCount: m.unread ? 1 : 0 }
}

/**
 * Which message opening the row should show: the OLDEST unread message of the
 * conversation (Thunderbird model), or the lead when everything is already read.
 *
 * Rationale: the row is bold because *some* message inside is unread, so the
 * click has to land on that message — otherwise the user clicks a bold row,
 * sees an already-read lead, and the folder counter never moves. Oldest first
 * keeps reading order natural when several messages are unread.
 *
 * Every item of a row comes from the list the current view rendered, so any of
 * them is addressable by the current view by construction — including in the
 * unified view, which mixes rows from several accounts (a single row never
 * crosses accounts: thread identity is account-scoped, see `buildThreadRows`).
 *
 * Unparseable dates are treated as newest (never silently win as "oldest"); on
 * a full tie the first unread in list order wins, which keeps the pick stable.
 */
export function pickThreadOpenTarget(row: ThreadRow): MailSummary {
  if (row.unreadCount <= 0) return row.lead
  let best: MailSummary | null = null
  let bestTs = Number.POSITIVE_INFINITY
  for (const m of row.items) {
    if (!m.unread) continue
    const parsed = Date.parse(m.date)
    const ts = Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
    if (best === null || ts < bestTs) {
      best = m
      bestTs = ts
    }
  }
  return best ?? row.lead
}

/**
 * The key the LIST uses for `ref`: the key of the lead of the row that contains
 * it, or `ref`'s own key when no row does.
 *
 * **Invariant: selection is a property of the ROW, not of one message key.** The
 * list renders one entry per row, and any message of a row may legitimately end
 * up in `selectedKeys` — opening a message selects it, and opening a mid-thread
 * message is routine (a bold row opens its oldest unread message, a card in the
 * thread view opens itself). Membership is therefore always asked through
 * `row.items` (`rowIsSelected`), never by looking a lead key up in the set.
 *
 * Mapping onto the lead happens at the moment of a USER ACTION on the list, and
 * only there, because that is the only moment when the rows are guaranteed to
 * exist: Ctrl-click toggles the whole row (`toggleRowSelection`), the Shift
 * anchor is resolved through `leadKeyOfRowContaining` when the range is drawn,
 * and the auto-advance lookup after a removal indexes into the lead-only list
 * (`viewMailsRef`), where a mid-thread key would simply miss. A message opened
 * before its row exists (notification, assistant link, snooze wake-up) needs no
 * deferred repair: its key sits in the set until the user acts, and by then the
 * row is there.
 *
 * The own-key fallback covers "no row holds it" (another view, already gone) and
 * is harmless: nothing downstream requires the key to be a lead.
 */
export function rowLeadKeyFor(
  rows: ThreadRow[],
  ref: { accountId: number; folder: string; uid: number },
): string {
  const k = `${ref.accountId}:${ref.folder}:${ref.uid}`
  return leadKeyOfRowContaining(rows, k) ?? k
}

/**
 * Lead key of the row holding `key`, or `null` when no row holds it. Exported
 * for the Shift anchor, which is a bare key (no `MailSummary` around it) and has
 * to distinguish "maps onto this lead" from "no row at all".
 */
export function leadKeyOfRowContaining(rows: ThreadRow[], key: string): string | null {
  for (const row of rows) {
    for (const item of row.items) {
      if (summaryKey(item) === key) return summaryKey(row.lead)
    }
  }
  return null
}

/**
 * The row holding `ref`, or a stand-in single-message row when none does. Call
 * sites act on rows (toggle, drag, context menu); a message with no row behaves
 * exactly like a row of its own, which is also what the ungrouped list builds.
 */
export function rowContaining(rows: ThreadRow[], ref: MailSummary): ThreadRow {
  const k = summaryKey(ref)
  for (const row of rows) {
    for (const item of row.items) {
      if (summaryKey(item) === k) return row
    }
  }
  return singleMessageRow(ref)
}

/**
 * Is the row selected? The single membership test in the app: the selection may
 * hold any message of the row, so asking `selectedKeys.has(leadKey)` would call
 * a visibly highlighted row unselected.
 */
export function rowIsSelected(row: ThreadRow, selectedKeys: ReadonlySet<string>): boolean {
  for (const item of row.items) {
    if (selectedKeys.has(summaryKey(item))) return true
  }
  return false
}

/**
 * How many ROWS are selected — the number the bulk toolbar, the context menu and
 * the AI context speak about. **Derived from the CURRENT rows at the moment of
 * use, never from `selectedKeys.size`.**
 *
 * The set is keyed by messages while the rows are rebuilt behind it (grouping
 * toggled live — `src/App.tsx` subscribes to the setting — filter changed, thread
 * headers arrived), so two separately selected messages can merge into ONE row.
 * `.size` would then report two where one row is lit, and all three consumers
 * would act on a count the user cannot see. Nothing reconciles the set
 * afterwards — that is the deliberate design, see `rowLeadKeyFor`.
 */
export function countSelectedRows(rows: ThreadRow[], selectedKeys: ReadonlySet<string>): number {
  let n = 0
  for (const row of rows) {
    if (rowIsSelected(row, selectedKeys)) n++
  }
  return n
}

/**
 * First selected row in list order, or `null` when none is. Keyboard actions that
 * need "the row the user means" while no message is open (`Enter`/`o`, `x`, `v`)
 * resolve it here: scanning the LEAD list for a key of the set — what they used
 * to do — misses a row selected through a mid-thread message and silently falls
 * back to the first row, acting on a message the user never picked.
 */
export function firstSelectedRow(rows: ThreadRow[], selectedKeys: ReadonlySet<string>): ThreadRow | null {
  for (const row of rows) {
    if (rowIsSelected(row, selectedKeys)) return row
  }
  return null
}

/** Selection state after a Ctrl/Cmd-click, computed here so no caller re-derives it. */
export type RowSelectionToggle = {
  keys: Set<string>
  /** Shift anchor afterwards: the row lead, or `null` when nothing stays selected. */
  anchorKey: string | null
}

/**
 * Ctrl/Cmd-click toggles the ROW: if any message of it is selected the row's
 * keys all go, otherwise the lead key comes in.
 *
 * Toggling the lead key alone was the defect this replaces — a row selected
 * through a mid-thread key (which is what opening leaves behind) would get its
 * lead ADDED on a click that visibly reads as "deselect", leaving the row lit
 * and the bulk-action buttons live.
 *
 * This does NOT promise "one key per row" globally: rows are rebuilt behind the
 * set (grouping toggled, filter changed, thread headers arrived) and nothing
 * repairs it afterwards. Counting is therefore `countSelectedRows`, not
 * `selectedKeys.size`.
 *
 * The anchor follows the lead because the Shift range walks the lead list.
 */
export function toggleRowSelection(row: ThreadRow, selectedKeys: ReadonlySet<string>): RowSelectionToggle {
  const next = new Set(selectedKeys)
  let removed = false
  for (const item of row.items) {
    if (next.delete(summaryKey(item))) removed = true
  }
  const leadKey = summaryKey(row.lead)
  if (!removed) next.add(leadKey)
  return { keys: next, anchorKey: next.size === 0 ? null : leadKey }
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
    return items.map(singleMessageRow)
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
    unreadCount: countUnread(groupItems),
  }))
}
