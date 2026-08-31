import { describe, expect, it } from 'vitest'
import type { MailSummary } from '@mailcopilot/types'
import {
  buildThreadRows,
  countSelectedRows,
  firstSelectedRow,
  leadKeyOfRowContaining,
  pickThreadOpenTarget,
  rowContaining,
  rowIsSelected,
  rowLeadKeyFor,
  singleMessageRow,
  toggleRowSelection,
} from './threading'

function m(partial: Partial<MailSummary> & Pick<MailSummary, 'accountId' | 'folder' | 'uid' | 'from' | 'subject' | 'date' | 'unread' | 'flagged'>): MailSummary {
  return {
    fromAddr: 'a@test',
    ...partial,
  }
}

describe('packages/core/threading', () => {
  it('groups messages by message-id/in-reply-to/references within an account', () => {
    const rows = buildThreadRows([
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 30,
        from: 'Alice',
        subject: 'Re: Hello',
        date: '2026-02-11T10:00:00Z',
        unread: false,
        flagged: false,
        messageId: '<m3@test>',
        inReplyTo: '<m1@test>',
        references: '<m1@test> <m2@test>',
      }),
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 20,
        from: 'Bob',
        subject: 'Hello',
        date: '2026-02-11T09:00:00Z',
        unread: true,
        flagged: false,
        messageId: '<m1@test>',
      }),
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 10,
        from: 'Service',
        subject: 'Independent',
        date: '2026-02-11T08:00:00Z',
        unread: false,
        flagged: false,
      }),
    ])

    expect(rows.length).toBe(2)
    expect(rows[0]?.count).toBe(2)
    expect(rows[0]?.lead.uid).toBe(30)
    expect(rows[1]?.count).toBe(1)
    expect(rows[1]?.lead.uid).toBe(10)
  })

  it('does not merge identical message-ids across different accounts', () => {
    const rows = buildThreadRows([
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 2,
        from: 'A',
        subject: 'One',
        date: '2026-02-11T10:00:00Z',
        unread: false,
        flagged: false,
        messageId: '<same@test>',
      }),
      m({
        accountId: 2,
        folder: 'INBOX',
        uid: 2,
        from: 'B',
        subject: 'Two',
        date: '2026-02-11T09:00:00Z',
        unread: false,
        flagged: false,
        messageId: '<same@test>',
      }),
    ])

    expect(rows.length).toBe(2)
    expect(rows[0]?.count).toBe(1)
    expect(rows[1]?.count).toBe(1)
  })
})

// The list renders newest-first, so the group lead is the newest message. A
// thread whose newest message is read but which still holds an older unread one
// is exactly the case that used to be counted by the folder badge yet rendered
// as read (live repro: account 5 INBOX, unread uid 145191 under read lead 146153).
function threadWithReadLeadAndOlderUnread(): MailSummary[] {
  return [
    m({
      accountId: 1,
      folder: 'INBOX',
      uid: 30,
      from: 'Alice',
      subject: 'Re: Hello',
      date: '2026-02-11T10:00:00Z',
      unread: false,
      flagged: false,
      messageId: '<m3@test>',
      inReplyTo: '<m1@test>',
    }),
    m({
      accountId: 1,
      folder: 'INBOX',
      uid: 20,
      from: 'Bob',
      subject: 'Hello',
      date: '2026-02-11T09:00:00Z',
      unread: true,
      flagged: false,
      messageId: '<m1@test>',
    }),
  ]
}

describe('packages/core/threading — row unread signal', () => {
  it('counts an unread mid-thread message even when the lead is read', () => {
    const rows = buildThreadRows(threadWithReadLeadAndOlderUnread())

    expect(rows.length).toBe(1)
    expect(rows[0]?.lead.uid).toBe(30)
    expect(rows[0]?.lead.unread).toBe(false)
    expect(rows[0]?.unreadCount).toBe(1)
  })

  it('reports zero when every message in the thread is read', () => {
    const items = threadWithReadLeadAndOlderUnread().map(x => ({ ...x, unread: false }))
    const rows = buildThreadRows(items)

    expect(rows[0]?.count).toBe(2)
    expect(rows[0]?.unreadCount).toBe(0)
  })

  it('counts every unread message in the thread, not just one', () => {
    const items = threadWithReadLeadAndOlderUnread().map(x => ({ ...x, unread: true }))
    const rows = buildThreadRows(items)

    expect(rows[0]?.unreadCount).toBe(2)
  })

  it('derives the signal for single-message rows on both paths', () => {
    const one = m({
      accountId: 1,
      folder: 'INBOX',
      uid: 7,
      from: 'Solo',
      subject: 'Alone',
      date: '2026-02-11T10:00:00Z',
      unread: true,
      flagged: false,
    })

    // Single-item fast path inside buildThreadRows.
    expect(buildThreadRows([one])[0]?.unreadCount).toBe(1)
    // Ungrouped path used by the renderer when conversation grouping is off.
    expect(singleMessageRow(one).unreadCount).toBe(1)
    expect(singleMessageRow({ ...one, unread: false }).unreadCount).toBe(0)
    // Shape stays identical to the grouped single-message row.
    expect(singleMessageRow(one)).toEqual(buildThreadRows([one])[0])
  })
})

describe('packages/core/threading — pickThreadOpenTarget', () => {
  it('opens the unread message hiding under a read lead', () => {
    const row = buildThreadRows(threadWithReadLeadAndOlderUnread())[0]!

    expect(pickThreadOpenTarget(row).uid).toBe(20)
  })

  it('opens the OLDEST unread message when several are unread', () => {
    const items = threadWithReadLeadAndOlderUnread().map(x => ({ ...x, unread: true }))
    const row = buildThreadRows(items)[0]!

    // uid 20 is the 09:00 message, uid 30 the 10:00 one.
    expect(pickThreadOpenTarget(row).uid).toBe(20)
  })

  it('falls back to the lead when the whole thread is read', () => {
    const items = threadWithReadLeadAndOlderUnread().map(x => ({ ...x, unread: false }))
    const row = buildThreadRows(items)[0]!

    expect(pickThreadOpenTarget(row)).toBe(row.lead)
  })

  it('returns the message itself for a single-message row', () => {
    const one = m({
      accountId: 1,
      folder: 'INBOX',
      uid: 7,
      from: 'Solo',
      subject: 'Alone',
      date: '2026-02-11T10:00:00Z',
      unread: true,
      flagged: false,
    })

    expect(pickThreadOpenTarget(singleMessageRow(one))).toBe(one)
    expect(pickThreadOpenTarget(singleMessageRow({ ...one, unread: false })).uid).toBe(7)
  })

  it('never lets an unparseable date win as "oldest"', () => {
    const items = threadWithReadLeadAndOlderUnread().map(x => ({ ...x, unread: true }))
    items[0] = { ...items[0]!, date: 'not-a-date' }
    const row = buildThreadRows(items)[0]!

    // uid 30 has the broken date; the real 09:00 message must still win.
    expect(pickThreadOpenTarget(row).uid).toBe(20)
  })

  it('picks the first unread in list order when dates tie', () => {
    const same = '2026-02-11T09:00:00Z'
    const items = threadWithReadLeadAndOlderUnread().map(x => ({ ...x, unread: true, date: same }))
    const row = buildThreadRows(items)[0]!

    expect(pickThreadOpenTarget(row).uid).toBe(row.items[0]!.uid)
  })

  it('falls back to the lead on a defensively-constructed row with empty items', () => {
    // Rows are always produced by buildThreadRows/singleMessageRow in practice,
    // so unreadCount and items never disagree — but pickThreadOpenTarget takes
    // a ThreadRow by shape, not a private constructor, so a hand-built row
    // (e.g. a stale prop in a test double, or a future caller) must still
    // resolve safely. If `return best ?? row.lead` were changed to
    // `return best ?? row.items[0]`, both assertions below would receive
    // `undefined` instead of `lead` because `items` is empty.
    const lead = m({
      accountId: 1,
      folder: 'INBOX',
      uid: 7,
      from: 'Solo',
      subject: 'Alone',
      date: '2026-02-11T10:00:00Z',
      unread: false,
      flagged: false,
    })
    const emptyRow = { key: '1:INBOX:7', lead, items: [], count: 0, unreadCount: 0 }
    const inconsistentRow = { key: '1:INBOX:7', lead, items: [], count: 0, unreadCount: 3 }

    expect(pickThreadOpenTarget(emptyRow)).toBe(lead)
    expect(pickThreadOpenTarget(inconsistentRow)).toBe(lead)
  })
})

describe('packages/core/threading — cross-folder conversations', () => {
  // Threading is scoped per-account (see "does not merge identical
  // message-ids across different accounts" above) but NOT per-folder: a
  // reply the user sent lands in Sent while the original stays in INBOX, and
  // both carry the same account id, so they merge into one row. This is the
  // only way a row can hold items whose `folder` differs from the lead's, and
  // it is exactly the shape the unified/account view renders — every item
  // still carries its own account+folder+uid, so it stays addressable by
  // `net:messageDetails` regardless of which folder is currently selected.
  function crossFolderThread(): MailSummary[] {
    return [
      m({
        accountId: 1,
        folder: 'Sent',
        uid: 50,
        from: 'me@test',
        subject: 'Re: Cross-folder',
        date: '2026-02-11T11:00:00Z',
        unread: false,
        flagged: false,
        messageId: '<reply@test>',
        inReplyTo: '<orig@test>',
      }),
      m({
        accountId: 1,
        folder: 'INBOX',
        uid: 40,
        from: 'them@test',
        subject: 'Cross-folder',
        date: '2026-02-11T09:00:00Z',
        unread: true,
        flagged: false,
        messageId: '<orig@test>',
      }),
    ]
  }

  it('counts unread across folders within the same account', () => {
    const rows = buildThreadRows(crossFolderThread())

    expect(rows.length).toBe(1)
    expect(rows[0]?.lead.folder).toBe('Sent')
    expect(rows[0]?.unreadCount).toBe(1)
  })

  it('opens the unread message from its own folder, not the lead\'s', () => {
    const row = buildThreadRows(crossFolderThread())[0]!
    const target = pickThreadOpenTarget(row)

    expect(target.uid).toBe(40)
    expect(target.folder).toBe('INBOX')
    expect(target.accountId).toBe(1)
  })
})

describe('packages/core/threading — pickThreadOpenTarget with every date unparseable', () => {
  it('falls back to list order when no unread message has a parseable date', () => {
    // Both unread candidates carry a broken date, so neither can win on
    // timestamp — the tie-break must still pick deterministically (first
    // unread in list order), not whichever happened to iterate last.
    const items = threadWithReadLeadAndOlderUnread().map(x => ({ ...x, unread: true, date: 'not-a-date' }))
    const row = buildThreadRows(items)[0]!

    // items[0] is uid 30 (the lead) in list order.
    expect(pickThreadOpenTarget(row).uid).toBe(row.items[0]!.uid)
    expect(pickThreadOpenTarget(row).uid).toBe(30)
  })
})

describe('packages/core/threading — rowLeadKeyFor', () => {
  it('maps a mid-thread message to the key of its row\'s lead', () => {
    const rows = buildThreadRows(threadWithReadLeadAndOlderUnread())
    const midThread = rows[0]!.items.find(x => x.uid === 20)!

    expect(rowLeadKeyFor(rows, midThread)).toBe('1:INBOX:30')
  })

  it('maps the lead itself to its own key (identity case)', () => {
    const rows = buildThreadRows(threadWithReadLeadAndOlderUnread())

    expect(rowLeadKeyFor(rows, rows[0]!.lead)).toBe('1:INBOX:30')
  })

  it('falls back to the reference\'s own key when no row contains it', () => {
    // This is the shape of opening a message from search results or a
    // notification — it never went through `buildThreadRows` for the
    // currently rendered list, so no row holds it. Silently returning some
    // unrelated lead key here would put a phantom row into the selection.
    const rows = buildThreadRows(threadWithReadLeadAndOlderUnread())
    const stray = { accountId: 9, folder: 'INBOX', uid: 999 }

    expect(rowLeadKeyFor(rows, stray)).toBe('9:INBOX:999')
  })

  it('resolves to its own key on the ungrouped (groupConversations=false) path', () => {
    // Ungrouped rows are one message each (`singleMessageRow`), so every
    // item is its own lead — this pins that `rowLeadKeyFor` does not assume
    // multi-item rows and mis-key a single-message row.
    const one = m({
      accountId: 1, folder: 'INBOX', uid: 7, from: 'Solo', subject: 'Alone',
      date: '2026-02-11T10:00:00Z', unread: true, flagged: false,
    })
    const rows = [singleMessageRow(one)]

    expect(rowLeadKeyFor(rows, one)).toBe('1:INBOX:7')
  })

  it('scopes the lookup by account and folder, not uid alone', () => {
    // Same uid, different account — must not cross-match into the wrong row.
    const rows = buildThreadRows(threadWithReadLeadAndOlderUnread())
    const sameUidOtherAccount = { accountId: 2, folder: 'INBOX', uid: 20 }

    expect(rowLeadKeyFor(rows, sameUidOtherAccount)).toBe('2:INBOX:20')
  })
})

describe('packages/core/threading — rowIsSelected', () => {
  const row = () => buildThreadRows(threadWithReadLeadAndOlderUnread())[0]!

  it('reports the row selected through ANY of its messages', () => {
    // The shape opening leaves behind: the set holds the mid-thread message
    // that was opened, not the lead. Asking `selectedKeys.has(leadKey)` here
    // would call a visibly highlighted row unselected.
    expect(rowIsSelected(row(), new Set(['1:INBOX:20']))).toBe(true)
    expect(rowIsSelected(row(), new Set(['1:INBOX:30']))).toBe(true)
  })

  it('reports a row holding none of the selected keys as unselected', () => {
    expect(rowIsSelected(row(), new Set(['1:INBOX:99']))).toBe(false)
    expect(rowIsSelected(row(), new Set())).toBe(false)
  })
})

describe('packages/core/threading — toggleRowSelection', () => {
  const row = () => buildThreadRows(threadWithReadLeadAndOlderUnread())[0]!

  it('clears the row whichever of its messages carries the selection', () => {
    // The regression this construction replaces: toggling the lead key alone
    // would ADD '1:INBOX:30' next to '1:INBOX:20', leaving the row lit after a
    // click that reads as "deselect". Every key of the row goes.
    expect([...toggleRowSelection(row(), new Set(['1:INBOX:20'])).keys]).toEqual([])
    expect([...toggleRowSelection(row(), new Set(['1:INBOX:30'])).keys]).toEqual([])
    expect([...toggleRowSelection(row(), new Set(['1:INBOX:20', '1:INBOX:30'])).keys]).toEqual([])
    expect(toggleRowSelection(row(), new Set(['1:INBOX:20'])).anchorKey).toBeNull()
  })

  it('adds the LEAD key when no message of the row is selected', () => {
    // The anchor has to be a lead too: the Shift range walks the lead list.
    const out = toggleRowSelection(row(), new Set(['7:INBOX:1']))

    expect([...out.keys].sort()).toEqual(['1:INBOX:30', '7:INBOX:1'])
    expect(out.anchorKey).toBe('1:INBOX:30')
  })

  it('does not mutate the set it was given', () => {
    // The set is React state; mutating it in place would keep the identity and
    // lose the re-render.
    const before = new Set(['1:INBOX:20'])
    toggleRowSelection(row(), before)

    expect([...before]).toEqual(['1:INBOX:20'])
  })

  it('toggles a single message on the ungrouped path', () => {
    // groupConversations=false builds one-message rows, so the row toggle has
    // to degrade exactly to the old per-message toggle.
    const ungrouped = singleMessageRow(m({
      accountId: 1, folder: 'INBOX', uid: 7, from: 'Solo', subject: 'Alone',
      date: '2026-02-11T10:00:00Z', unread: true, flagged: false,
    }))

    const added = toggleRowSelection(ungrouped, new Set())
    expect([...added.keys]).toEqual(['1:INBOX:7'])
    expect(added.anchorKey).toBe('1:INBOX:7')
    expect([...toggleRowSelection(ungrouped, added.keys).keys]).toEqual([])
  })
})

describe('packages/core/threading — leadKeyOfRowContaining (Shift anchor)', () => {
  const rows = () => buildThreadRows(threadWithReadLeadAndOlderUnread())

  it('maps a mid-thread anchor onto the lead the list actually renders', () => {
    // The anchor is whatever was last selected, and opening a bold row leaves a
    // mid-thread message there. This lazy mapping is what keeps the next
    // Shift-click from degrading to a single selection.
    expect(leadKeyOfRowContaining(rows(), '1:INBOX:20')).toBe('1:INBOX:30')
  })

  it('returns null when no row holds the anchor, so the caller can fall back', () => {
    // Distinct from `rowLeadKeyFor`, which echoes the key back: the Shift
    // branch must tell "not in this view" from "maps onto a lead".
    expect(leadKeyOfRowContaining(rows(), '9:Archive:5')).toBeNull()
    expect(leadKeyOfRowContaining([], '1:INBOX:20')).toBeNull()
  })
})

describe('packages/core/threading — countSelectedRows', () => {
  it('counts a row once however many of its messages carry the selection', () => {
    // The regrouping case: two messages selected while grouping was off merge
    // into one row when it is switched on. `selectedKeys.size` would say two.
    const rows = buildThreadRows(threadWithReadLeadAndOlderUnread())

    expect(countSelectedRows(rows, new Set(['1:INBOX:20', '1:INBOX:30']))).toBe(1)
    expect(countSelectedRows(rows, new Set(['1:INBOX:20']))).toBe(1)
  })

  it('ignores keys no current row holds', () => {
    // Rows are rebuilt behind the set and nothing repairs it, so stale keys are
    // normal — they must not inflate the count either.
    const rows = buildThreadRows(threadWithReadLeadAndOlderUnread())

    expect(countSelectedRows(rows, new Set(['9:Archive:5']))).toBe(0)
    expect(countSelectedRows(rows, new Set())).toBe(0)
    expect(countSelectedRows([], new Set(['1:INBOX:20']))).toBe(0)
  })

  it('counts each selected row on the ungrouped path', () => {
    const rows = threadWithReadLeadAndOlderUnread().map(singleMessageRow)

    expect(countSelectedRows(rows, new Set(['1:INBOX:20', '1:INBOX:30']))).toBe(2)
  })
})

describe('packages/core/threading — firstSelectedRow', () => {
  it('finds the row selected through a mid-thread message', () => {
    // What the lead-list scan it replaces could not do: '1:INBOX:20' is not a
    // lead, so the old lookup missed and fell back to the first row.
    const rows = buildThreadRows(threadWithReadLeadAndOlderUnread())

    expect(firstSelectedRow(rows, new Set(['1:INBOX:20']))?.lead.uid).toBe(30)
  })

  it('returns null when nothing of the current rows is selected', () => {
    const rows = buildThreadRows(threadWithReadLeadAndOlderUnread())

    expect(firstSelectedRow(rows, new Set(['9:Archive:5']))).toBeNull()
    expect(firstSelectedRow(rows, new Set())).toBeNull()
  })

  it('returns the first selected row in list order', () => {
    const rows = threadWithReadLeadAndOlderUnread().map(singleMessageRow)

    expect(firstSelectedRow(rows, new Set(['1:INBOX:20', '1:INBOX:30']))?.lead.uid).toBe(30)
  })
})

describe('packages/core/threading — rowContaining', () => {
  it('finds the row holding a mid-thread message', () => {
    const rows = buildThreadRows(threadWithReadLeadAndOlderUnread())

    expect(rowContaining(rows, rows[0]!.items[1]!).lead.uid).toBe(30)
  })

  it('stands in with a single-message row when no row holds the message', () => {
    // Right-click or drag on a message the current view never grouped: it must
    // behave as a row of its own rather than match a foreign row.
    const stray = m({
      accountId: 9, folder: 'Archive', uid: 5, from: 'X', subject: 'Y',
      date: '2026-02-11T10:00:00Z', unread: false, flagged: false,
    })
    const row = rowContaining(buildThreadRows(threadWithReadLeadAndOlderUnread()), stray)

    expect(row.key).toBe('9:Archive:5')
    expect(row.items).toEqual([stray])
  })
})
