import { describe, it, expect } from 'vitest'
import type { MailSummary } from '@mailcopilot/types'
import type { ThreadRow } from './threading'
import {
  resolveThreadItems,
  expandBulkToThreads,
  groupByAccountFolder,
  soleGroup,
  planMoveToFolder,
  planRoleMove,
  planMarkSeenGroups,
  dragSelectionRefs,
  serializeMailRefs,
  parseMailRefs,
  resolveKnownRefs,
  isWireUid,
  type FolderGroup,
  type MailRef,
} from './threadActions'

function makeMail(accountId: number, folder: string, uid: number, unread = false): MailSummary {
  return {
    accountId, folder, uid,
    message_id: `<${uid}@test>`,
    from: 'a@b', to: 'c@d', subject: `Subj ${uid}`,
    date: '2025-01-01T00:00:00Z', unread, flagged: false,
    in_reply_to: undefined, references: undefined, snippet: '',
  } as MailSummary
}

/**
 * The property every call site of this module has to preserve: a UID is only
 * addressable inside the mailbox it was read from, so no group may ever carry a
 * message whose own folder differs from the folder the group will be sent with.
 */
function expectNoForeignFolder<M extends MailRef>(groups: readonly FolderGroup<M>[]): void {
  for (const g of groups) {
    for (const m of g.msgs) {
      expect({ accountId: m.accountId, folder: m.folder }).toEqual({ accountId: g.accountId, folder: g.folder })
    }
    expect(g.uids).toEqual(g.msgs.map(m => m.uid))
  }
}

function makeRow(lead: MailSummary, items: MailSummary[]): ThreadRow {
  return {
    key: `${lead.accountId}:${lead.folder}:${lead.uid}`,
    lead,
    items,
    count: items.length,
    unreadCount: items.filter(m => m.unread).length,
  }
}

describe('resolveThreadItems', () => {
  const m1 = makeMail(1, 'INBOX', 10)
  const m2 = makeMail(1, 'INBOX', 20)
  const m3 = makeMail(1, 'INBOX', 30)
  const threadRows: ThreadRow[] = [
    makeRow(m1, [m1, m2]),
    makeRow(m3, [m3]),
  ]

  it('returns [m] when groupConversations=false', () => {
    expect(resolveThreadItems(m1, threadRows, false)).toEqual([m1])
  })

  it('returns all thread items when groupConversations=true', () => {
    expect(resolveThreadItems(m1, threadRows, true)).toEqual([m1, m2])
    expect(resolveThreadItems(m2, threadRows, true)).toEqual([m1, m2])
  })

  it('returns a single message for a single-message thread', () => {
    expect(resolveThreadItems(m3, threadRows, true)).toEqual([m3])
  })

  it('returns [m] if the message is not found in any thread', () => {
    const orphan = makeMail(1, 'INBOX', 99)
    expect(resolveThreadItems(orphan, threadRows, true)).toEqual([orphan])
  })
})

describe('expandBulkToThreads', () => {
  const m1 = makeMail(1, 'INBOX', 10)
  const m2 = makeMail(1, 'INBOX', 20)
  const m3 = makeMail(1, 'INBOX', 30)
  const m4 = makeMail(1, 'INBOX', 40)
  const allMails = [m1, m2, m3, m4]
  const threadRows: ThreadRow[] = [
    makeRow(m1, [m1, m2]),
    makeRow(m3, [m3, m4]),
  ]

  it('without groupConversations filters by selectedKeys directly', () => {
    const selected = new Set(['1:INBOX:10', '1:INBOX:30'])
    const result = expandBulkToThreads(selected, allMails, threadRows, false)
    expect(result).toEqual([m1, m3])
  })

  it('with groupConversations expands lead -> all items', () => {
    const selected = new Set(['1:INBOX:10']) // selected the lead of the first thread
    const result = expandBulkToThreads(selected, allMails, threadRows, true)
    expect(result).toEqual([m1, m2])
  })

  it('with groupConversations expands non-lead item -> all items', () => {
    const selected = new Set(['1:INBOX:20']) // selected a non-lead item of the first thread
    const result = expandBulkToThreads(selected, allMails, threadRows, true)
    expect(result).toEqual([m1, m2])
  })

  it('expands multiple selected threads', () => {
    const selected = new Set(['1:INBOX:10', '1:INBOX:30'])
    const result = expandBulkToThreads(selected, allMails, threadRows, true)
    expect(result).toEqual([m1, m2, m3, m4])
  })

  it('does not duplicate messages', () => {
    // Even if the same key appears twice
    const selected = new Set(['1:INBOX:10'])
    const result = expandBulkToThreads(selected, allMails, threadRows, true)
    const uids = result.map(m => m.uid)
    expect(uids).toEqual([10, 20])
    expect(new Set(uids).size).toBe(uids.length)
  })

  it('returns an empty array if nothing is selected', () => {
    const selected = new Set<string>()
    expect(expandBulkToThreads(selected, allMails, threadRows, true)).toEqual([])
    expect(expandBulkToThreads(selected, allMails, threadRows, false)).toEqual([])
  })
})

/**
 * §2.238 — a conversation is our local derivative and freely spans folders
 * (all-folders search, a reply in Sent, an archived branch). Every destructive
 * operation on a SET of messages therefore derives the source folder per
 * message and never from the thread head or from the folder the list shows.
 *
 * `crossFolderThread` is the shape used throughout: one conversation, two
 * mailboxes, and the head sitting in the one that must NOT stand for the rest.
 */
describe('§2.238 per-message folder derivation', () => {
  const head = makeMail(1, 'INBOX', 10, true)
  const reply = makeMail(1, 'Archive', 10, true) // same UID, other mailbox — the exact hazard
  const later = makeMail(1, 'Archive', 77)
  const crossFolderThread = [head, reply, later]

  describe('groupByAccountFolder', () => {
    it('splits a cross-folder thread and keeps every UID with its own folder', () => {
      const groups = groupByAccountFolder(crossFolderThread)
      expect(groups.map(g => [g.folder, g.uids])).toEqual([
        ['INBOX', [10]],
        ['Archive', [10, 77]],
      ])
      expectNoForeignFolder(groups)
    })

    it('separates accounts even when folder names coincide', () => {
      const groups = groupByAccountFolder([makeMail(1, 'INBOX', 5), makeMail(2, 'INBOX', 5)])
      expect(groups.map(g => g.accountId)).toEqual([1, 2])
      expectNoForeignFolder(groups)
    })

    it('collapses exact duplicates but not same-UID-different-folder pairs', () => {
      const groups = groupByAccountFolder([head, head, reply])
      expect(groups.map(g => g.uids)).toEqual([[10], [10]])
    })

    it('preserves first-seen order inside a group', () => {
      const groups = groupByAccountFolder([later, reply])
      expect(groups[0].uids).toEqual([77, 10])
    })

    it('returns nothing for an empty set', () => {
      expect(groupByAccountFolder([])).toEqual([])
    })
  })

  describe('soleGroup — AC7, undo is withheld rather than faked', () => {
    it('returns the only group when the set has one source folder', () => {
      const groups = groupByAccountFolder([head])
      expect(soleGroup(groups)).toBe(groups[0])
    })

    it('returns null for a set spanning two source folders', () => {
      expect(soleGroup(groupByAccountFolder(crossFolderThread))).toBeNull()
    })

    it('returns null for an empty plan', () => {
      expect(soleGroup([])).toBeNull()
    })
  })

  describe('planMoveToFolder — drag-and-drop / "Move to…" (AC2)', () => {
    it('moves each group out of its OWN folder, not out of the open one', () => {
      const plan = planMoveToFolder(crossFolderThread, { accountId: 1, folder: 'Work' })
      expect(plan.groups.map(g => [g.folder, g.uids])).toEqual([
        ['INBOX', [10]],
        ['Archive', [10, 77]],
      ])
      expectNoForeignFolder(plan.groups)
    })

    it('drops the group already sitting in the destination', () => {
      const plan = planMoveToFolder(crossFolderThread, { accountId: 1, folder: 'Archive' })
      expect(plan.groups.map(g => g.folder)).toEqual(['INBOX'])
      expect(plan.alreadyThere).toBe(2)
      expectNoForeignFolder(plan.groups)
    })

    it('drops messages of another account — a folder path only means something inside its own account', () => {
      const plan = planMoveToFolder([head, makeMail(2, 'INBOX', 10)], { accountId: 1, folder: 'Work' })
      expect(plan.groups.map(g => g.accountId)).toEqual([1])
      expect(plan.foreignAccount).toBe(1)
    })

    it('plans nothing for an empty set', () => {
      expect(planMoveToFolder([], { accountId: 1, folder: 'Work' }).groups).toEqual([])
    })
  })

  describe('planRoleMove — archive / junk / trash (AC1, AC4, AC5)', () => {
    const trashOf = (accountId: number) => (accountId === 1 ? 'Trash' : 'Deleted')

    it('archives a cross-folder thread out of both of its folders', () => {
      const plan = planRoleMove(crossFolderThread, () => 'Archived')
      expect(plan.groups.map(g => [g.folder, g.targetFolder, g.uids])).toEqual([
        ['INBOX', 'Archived', [10]],
        ['Archive', 'Archived', [10, 77]],
      ])
      expectNoForeignFolder(plan.groups)
      expect(plan.missingRole).toBe(false)
    })

    it('resolves the target per ACCOUNT while the source stays per group', () => {
      const plan = planRoleMove([head, makeMail(2, 'Inbox', 3)], trashOf)
      expect(plan.groups.map(g => [g.accountId, g.folder, g.targetFolder])).toEqual([
        [1, 'INBOX', 'Trash'],
        [2, 'Inbox', 'Deleted'],
      ])
      expectNoForeignFolder(plan.groups)
    })

    it('leaves out the part of the thread that already sits in the target folder', () => {
      const plan = planRoleMove(crossFolderThread, () => 'Archive')
      expect(plan.groups.map(g => g.folder)).toEqual(['INBOX'])
      expect(plan.missingRole).toBe(false)
    })

    it('flags an account with no folder for the role instead of guessing one', () => {
      const plan = planRoleMove([head, makeMail(2, 'Inbox', 3)], id => (id === 1 ? 'Trash' : undefined))
      expect(plan.groups.map(g => g.accountId)).toEqual([1])
      expect(plan.missingRole).toBe(true)
    })

    it('reports missingRole with no groups when no account has the role', () => {
      const plan = planRoleMove(crossFolderThread, () => undefined)
      expect(plan).toEqual({ groups: [], missingRole: true })
    })
  })

  describe('planMarkSeenGroups — thread "mark read" (AC3)', () => {
    it('writes \\Seen per folder, never with the head folder for all UIDs', () => {
      const groups = planMarkSeenGroups(crossFolderThread)
      expect(groups.map(g => [g.folder, g.uids])).toEqual([
        ['INBOX', [10]],
        ['Archive', [10]],
      ])
      expectNoForeignFolder(groups)
    })

    it('leaves already-read messages out so the counters move by what the server changed', () => {
      const groups = planMarkSeenGroups([makeMail(1, 'INBOX', 1), makeMail(1, 'INBOX', 2, true)])
      expect(groups.map(g => g.uids)).toEqual([[2]])
    })

    it('returns no groups when the whole thread is already read', () => {
      expect(planMarkSeenGroups([later])).toEqual([])
    })
  })
})

describe('§2.238 drag payload', () => {
  const a1 = makeMail(1, 'INBOX', 10)
  const a2 = makeMail(1, 'Archive', 10) // same UID, other mailbox
  const b1 = makeMail(1, 'Sent', 40)
  const c1 = makeMail(1, 'INBOX', 50)
  const rows: ThreadRow[] = [
    makeRow(a1, [a1, a2]),
    makeRow(b1, [b1]),
    makeRow(c1, [c1]),
  ]

  it('carries every MESSAGE of every selected row, each with its own folder (AC6)', () => {
    // The first row is selected through its MID-THREAD message — membership is
    // asked through row.items, never selectedKeys.has(leadKey) (CLAUDE.md §5).
    const selected = new Set(['1:Archive:10', '1:Sent:40'])
    expect(dragSelectionRefs(rows, a1, selected)).toEqual([
      { accountId: 1, folder: 'INBOX', uid: 10 },
      { accountId: 1, folder: 'Archive', uid: 10 },
      { accountId: 1, folder: 'Sent', uid: 40 },
    ])
  })

  it('carries only the dragged message when its row is not selected', () => {
    const selected = new Set(['1:Sent:40'])
    expect(dragSelectionRefs(rows, c1, selected)).toEqual([{ accountId: 1, folder: 'INBOX', uid: 50 }])
  })

  it('falls back to the dragged message when no current row holds it', () => {
    const orphan = makeMail(1, 'Junk', 99)
    expect(dragSelectionRefs(rows, orphan, new Set(['1:Junk:99']))).toEqual([
      { accountId: 1, folder: 'Junk', uid: 99 },
    ])
  })

  /**
   * A message moved while offline carries a temporary NEGATIVE uid until replay
   * gives it a real one (`moveMessagesLocally` in packages/db). It has no
   * server-side address, so `net:move` in main refuses it — it was never
   * movable. The producer therefore leaves it out, instead of minting a ref the
   * parser would have to refuse; because one bad entry voids the WHOLE payload,
   * the alternative would be "drag five messages, nothing happens".
   */
  describe('offline-move placeholders are left out at the producer', () => {
    const real1 = makeMail(1, 'Archive', 10)
    const real2 = makeMail(1, 'Archive', 11)
    const real3 = makeMail(1, 'Archive', 12)
    const placeholder = makeMail(1, 'Archive', -1)
    const mixedRows: ThreadRow[] = [
      makeRow(real1, [real1]),
      makeRow(real2, [real2]),
      makeRow(real3, [real3]),
      makeRow(placeholder, [placeholder]),
    ]
    const allKeys = new Set(['1:Archive:10', '1:Archive:11', '1:Archive:12', '1:Archive:-1'])

    it('sends the addressable messages and leaves the placeholder where it is', () => {
      // Three ordinary messages + one placeholder: the three move.
      const refs = dragSelectionRefs(mixedRows, real1, allKeys)
      expect(refs).toEqual([
        { accountId: 1, folder: 'Archive', uid: 10 },
        { accountId: 1, folder: 'Archive', uid: 11 },
        { accountId: 1, folder: 'Archive', uid: 12 },
      ])
      // And the payload it builds survives the parser untouched — the validator
      // never fires on a legitimate gesture.
      expect(parseMailRefs(serializeMailRefs(refs))).toEqual(refs)
    })

    it('holds the whole payload together even when the drag STARTS on the placeholder', () => {
      const refs = dragSelectionRefs(mixedRows, placeholder, allKeys)
      expect(refs.map(r => r.uid)).toEqual([10, 11, 12])
      expect(parseMailRefs(serializeMailRefs(refs))).toEqual(refs)
    })

    it('sends nothing at all when the selection holds only placeholders', () => {
      const other = makeMail(1, 'Archive', -2)
      const rowsOfPlaceholders: ThreadRow[] = [makeRow(placeholder, [placeholder]), makeRow(other, [other])]
      const keys = new Set(['1:Archive:-1', '1:Archive:-2'])
      expect(dragSelectionRefs(rowsOfPlaceholders, placeholder, keys)).toEqual([])
    })

    it('sends nothing when a single unselected placeholder row is dragged', () => {
      expect(dragSelectionRefs(mixedRows, placeholder, new Set<string>())).toEqual([])
    })

    it('still carries an ordinary unselected row on the single-message path', () => {
      expect(dragSelectionRefs(mixedRows, real2, new Set<string>())).toEqual([
        { accountId: 1, folder: 'Archive', uid: 11 },
      ])
    })

    it('leaves out a uid past the uint32 ceiling on the same rule', () => {
      const absurd = makeMail(1, 'Archive', 4294967296)
      const rows2: ThreadRow[] = [makeRow(real1, [real1]), makeRow(absurd, [absurd])]
      const refs = dragSelectionRefs(rows2, real1, new Set(['1:Archive:10', '1:Archive:4294967296']))
      expect(refs.map(r => r.uid)).toEqual([10])
    })
  })

  it('round-trips through the transfer payload', () => {
    const refs = dragSelectionRefs(rows, a1, new Set(['1:INBOX:10']))
    expect(parseMailRefs(serializeMailRefs(refs))).toEqual(refs)
  })

  it('parses fail-closed — an unusable payload moves nothing', () => {
    expect(parseMailRefs('')).toEqual([])
    expect(parseMailRefs(null)).toEqual([])
    expect(parseMailRefs('not json')).toEqual([])
    expect(parseMailRefs('{"accountId":1}')).toEqual([])
    // Bare UIDs — the pre-§2.238 payload shape.
    expect(parseMailRefs('[10,20]')).toEqual([])
    // A single malformed entry voids the whole drop rather than moving a subset.
    expect(parseMailRefs('[{"accountId":1,"folder":"INBOX","uid":10},{"accountId":1,"uid":11}]')).toEqual([])
    expect(parseMailRefs('[{"accountId":1,"folder":"","uid":10}]')).toEqual([])
    expect(parseMailRefs('[{"accountId":1,"folder":"INBOX","uid":"10"}]')).toEqual([])
  })
})

/**
 * The payload arrives on the OS drag clipboard, so its size, its numbers and its
 * mailbox names are all attacker-shaped input. These bounds are ALIGNMENT with
 * what the layers below already enforce (`net:move` refuses non-positive UIDs,
 * the IMAP client refuses anything outside the RFC 3501 range) — refusing them
 * one layer earlier costs nothing legitimate.
 */
describe('isWireUid — ONE definition shared by producer and parser', () => {
  it('accepts the RFC 3501 range and nothing else', () => {
    expect([1, 2, 4294967295].every(isWireUid)).toBe(true)
    expect([0, -1, -4294967295, 1.5, 4294967296, Number.NaN, 1e100].some(isWireUid)).toBe(false)
  })

  it('agrees with the parser on every boundary — the validator cannot fire on producer output', () => {
    const cases = [1, 2, 4294967295, 0, -1, 1.5, 4294967296, 1e100]
    for (const uid of cases) {
      const accepted = parseMailRefs(JSON.stringify([{ accountId: 1, folder: 'INBOX', uid }])).length === 1
      expect({ uid, accepted }).toEqual({ uid, accepted: isWireUid(uid) })
    }
  })

  it('is deliberately NARROWER than the storage predicate — negatives are storable, never sendable', () => {
    // `isStorableUid` in packages/db accepts these: an offline move mints them.
    expect(isWireUid(-1)).toBe(false)
  })
})

describe('parseMailRefs bounds', () => {
  const MAX_REFS = 10_000
  const MAX_PAYLOAD_CHARS = 1_000_000
  const MAX_FOLDER_CHARS = 512
  const MAX_UID = 4294967295

  const ref = (over: Partial<MailRef> = {}): MailRef => ({ accountId: 1, folder: 'INBOX', uid: 10, ...over })
  const payloadOf = (...refs: MailRef[]) => JSON.stringify(refs)

  describe('ref count', () => {
    it('accepts a bulk selection AT the cap', () => {
      const refs = Array.from({ length: MAX_REFS }, (_, i) => ref({ uid: i + 1 }))
      expect(parseMailRefs(payloadOf(...refs))).toHaveLength(MAX_REFS)
    })

    it('refuses the whole payload one ref over the cap', () => {
      const refs = Array.from({ length: MAX_REFS + 1 }, (_, i) => ref({ uid: i + 1 }))
      expect(parseMailRefs(payloadOf(...refs))).toEqual([])
    })
  })

  describe('serialized length', () => {
    // JSON ignores leading whitespace, so padding lets a payload sit at an exact
    // length while staying a valid, fully legitimate one-ref drop.
    const atLength = (n: number) => {
      const body = payloadOf(ref())
      const raw = `${' '.repeat(n - body.length)}${body}`
      expect(raw.length).toBe(n)
      return raw
    }

    it('accepts a payload AT the character cap', () => {
      expect(parseMailRefs(atLength(MAX_PAYLOAD_CHARS))).toEqual([ref()])
    })

    it('refuses a payload one character over the cap', () => {
      // Valid JSON, valid refs — refused purely on size, before JSON.parse.
      expect(parseMailRefs(atLength(MAX_PAYLOAD_CHARS + 1))).toEqual([])
    })
  })

  describe('uid range — the WIRE predicate (RFC 3501 §2.3.1.1: 1..4294967295)', () => {
    it('accepts both ends of the range', () => {
      expect(parseMailRefs(payloadOf(ref({ uid: 1 })))).toEqual([ref({ uid: 1 })])
      expect(parseMailRefs(payloadOf(ref({ uid: MAX_UID })))).toEqual([ref({ uid: MAX_UID })])
    })

    it('refuses zero, negative, fractional and non-safe uids', () => {
      expect(parseMailRefs(payloadOf(ref({ uid: 0 })))).toEqual([])
      // Negative UIDs are legal in STORAGE (`isStorableUid` — offline moves mint
      // temporary ones) and illegal on the WIRE. The two predicates differ on
      // purpose; this case pins the wire side.
      expect(parseMailRefs(payloadOf(ref({ uid: -1 })))).toEqual([])
      expect(parseMailRefs(payloadOf(ref({ uid: 1.5 })))).toEqual([])
      expect(parseMailRefs('[{"accountId":1,"folder":"INBOX","uid":1e100}]')).toEqual([])
    })

    it('refuses a uid one past the uint32 ceiling', () => {
      expect(parseMailRefs(payloadOf(ref({ uid: MAX_UID + 1 })))).toEqual([])
    })
  })

  describe('accountId', () => {
    it('accepts the lowest real account id', () => {
      expect(parseMailRefs(payloadOf(ref({ accountId: 1 })))).toEqual([ref({ accountId: 1 })])
    })

    it('refuses zero, negative and non-safe account ids', () => {
      expect(parseMailRefs(payloadOf(ref({ accountId: 0 })))).toEqual([])
      expect(parseMailRefs(payloadOf(ref({ accountId: -1 })))).toEqual([])
      expect(parseMailRefs('[{"accountId":1e100,"folder":"INBOX","uid":10}]')).toEqual([])
    })
  })

  describe('folder', () => {
    it('accepts a real hierarchical mailbox — `/` and `.` are DELIMITERS, not attacks', () => {
      const slash = ref({ folder: 'INBOX/Work/2026' })
      const dot = ref({ folder: 'INBOX.Work.2026' })
      expect(parseMailRefs(payloadOf(slash, dot))).toEqual([slash, dot])
    })

    it('accepts a name AT the length cap and refuses one over it', () => {
      expect(parseMailRefs(payloadOf(ref({ folder: 'a'.repeat(MAX_FOLDER_CHARS) })))).toHaveLength(1)
      expect(parseMailRefs(payloadOf(ref({ folder: 'a'.repeat(MAX_FOLDER_CHARS + 1) })))).toEqual([])
    })

    it('refuses control characters — CR/LF would be an IMAP command-injection primitive', () => {
      for (const ch of ['\u0000', '\r', '\n', '\u001F', '\u007F']) {
        expect(parseMailRefs(payloadOf(ref({ folder: `INBOX${ch}evil` })))).toEqual([])
      }
    })

    it('still refuses an empty name', () => {
      expect(parseMailRefs(payloadOf(ref({ folder: '' })))).toEqual([])
    })
  })
})

/**
 * FIX 1 — the payload is a SELECTOR over the loaded set, not an address.
 *
 * The pre-§2.238 handler could only ever address the OPEN folder; carrying full
 * refs widened that to any mailbox of the selected account, since every field of
 * a self-describing ref would be believed. Resolving against the messages the
 * renderer actually holds restores the original narrowness without giving up
 * cross-folder drags.
 */
describe('§2.238 resolveKnownRefs — a drop addresses only what the renderer holds', () => {
  const inbox = makeMail(1, 'INBOX', 10)
  const archived = makeMail(1, 'Archive', 10) // same UID, other mailbox
  const sent = makeMail(1, 'Sent', 40)
  const rows: ThreadRow[] = [
    makeRow(inbox, [inbox, archived]),
    makeRow(sent, [sent]),
  ]

  it('resolves every ref a legitimate drag carries — the gesture is lossless', () => {
    // Exactly the path a real drag takes: refs built from the rows, serialized
    // onto the drag clipboard, parsed back, resolved. Nothing may drop out,
    // including the cross-folder half of the conversation.
    const refs = dragSelectionRefs(rows, inbox, new Set(['1:Archive:10', '1:Sent:40']))
    const resolved = resolveKnownRefs(parseMailRefs(serializeMailRefs(refs)), rows)
    expect(resolved).toEqual([inbox, archived, sent])
  })

  it('resolves the single-message drag of an UNSELECTED row too', () => {
    // The other reachable shape of a real gesture: `draggable` is on the row and
    // the message handed to `dragSelectionRefs` is always `row.lead`, which
    // `buildThreadRows` always puts inside that row's `items` — so this path is
    // lossless as well.
    const refs = dragSelectionRefs(rows, sent, new Set(['1:INBOX:10']))
    expect(resolveKnownRefs(parseMailRefs(serializeMailRefs(refs)), rows)).toEqual([sent])
  })

  it('carries a mixed selection end to end: the addressable ones arrive, the placeholder does not', () => {
    // The full chain for the case that motivated the producer-side filter —
    // dragSelectionRefs -> serialize -> parse -> resolve. Four ordinary
    // messages plus one offline-move placeholder must land as four moves, not
    // as a whole-payload refusal that moves nothing.
    const held = [makeMail(1, 'Archive', 10), makeMail(1, 'Archive', 11), makeMail(1, 'Archive', 12), makeMail(1, 'Archive', 13)]
    const placeholder = makeMail(1, 'Archive', -1)
    const mixedRows: ThreadRow[] = [...held, placeholder].map(m => makeRow(m, [m]))
    const keys = new Set([...held, placeholder].map(m => `1:Archive:${m.uid}`))

    const refs = dragSelectionRefs(mixedRows, held[0]!, keys)
    const resolved = resolveKnownRefs(parseMailRefs(serializeMailRefs(refs)), mixedRows)
    expect(resolved).toEqual(held)
    expect(resolved).not.toContain(placeholder)
  })

  it('returns the message THIS renderer knows, not the object from the payload', () => {
    const [resolved] = resolveKnownRefs([{ accountId: 1, folder: 'INBOX', uid: 10 }], rows)
    expect(resolved).toBe(inbox)
  })

  it('discards a well-formed ref naming a folder the renderer never loaded', () => {
    // The crafted-payload case: valid shape, real account, plausible mailbox —
    // and nothing behind it in the loaded set.
    expect(resolveKnownRefs([{ accountId: 1, folder: 'Junk', uid: 10 }], rows)).toEqual([])
  })

  it('discards a well-formed ref naming an unknown UID in a loaded folder', () => {
    expect(resolveKnownRefs([{ accountId: 1, folder: 'INBOX', uid: 999 }], rows)).toEqual([])
  })

  it('discards a ref naming another account', () => {
    expect(resolveKnownRefs([{ accountId: 2, folder: 'INBOX', uid: 10 }], rows)).toEqual([])
  })

  it('keeps the known part of a mixed payload and drops the rest', () => {
    const resolved = resolveKnownRefs([
      { accountId: 1, folder: 'Junk', uid: 10 },
      { accountId: 1, folder: 'Sent', uid: 40 },
    ], rows)
    expect(resolved).toEqual([sent])
  })

  it('resolves nothing when the list holds nothing — no fallback to any folder', () => {
    expect(resolveKnownRefs([{ accountId: 1, folder: 'INBOX', uid: 10 }], [])).toEqual([])
    expect(resolveKnownRefs([], rows)).toEqual([])
  })

  it('collapses duplicate refs to one message', () => {
    const dup = { accountId: 1, folder: 'INBOX', uid: 10 }
    expect(resolveKnownRefs([dup, { ...dup }], rows)).toEqual([inbox])
  })

  it('is not fooled by prototype-shaped folder names', () => {
    expect(resolveKnownRefs([{ accountId: 1, folder: '__proto__', uid: 10 }], rows)).toEqual([])
    expect(resolveKnownRefs([{ accountId: 1, folder: 'constructor', uid: 10 }], rows)).toEqual([])
  })
})
