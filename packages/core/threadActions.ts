import type { MailSummary } from '@mailcopilot/types'
import { rowContaining, rowIsSelected, type ThreadRow } from './threading'

type MailKey = string

/**
 * The address of one message. A UID is unique only **inside one mailbox**
 * (RFC 3501 §2.3.1.1), so `uid` alone never addresses a message: it has to
 * travel with the account and the folder it was read from.
 */
export type MailRef = {
  accountId: number
  folder: string
  uid: number
}

function mailKey(m: MailRef): MailKey {
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
 * If any message in a thread is selected, all items of the thread are included
 * in the result — selection belongs to the row, and the key standing for it may
 * be any message of the row (`rowIsSelected`).
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
    if (!rowIsSelected(row, selectedKeys)) continue
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

/**
 * A set of messages that share ONE (accountId, folder) pair — the only unit an
 * IMAP command may address.
 *
 * **Every destructive operation on a set of messages is planned per group, and
 * the source folder of a group comes from its own messages — never from the
 * head of the conversation, never from the folder the list happens to be
 * showing.** A conversation is our local derivative and freely spans folders
 * (all-folders search, a reply sitting in Sent, an archived branch), while the
 * server resolves the UIDs we send against the mailbox we selected. Sending a
 * UID read in one folder with the name of another does not fail — it addresses
 * whatever message happens to carry that UID there, and moves, deletes or marks
 * a stranger.
 */
export type FolderGroup<M extends MailRef = MailRef> = {
  accountId: number
  folder: string
  msgs: M[]
  uids: number[]
}

/**
 * Groups messages by (accountId, folder), preserving first-seen order both
 * between groups and inside them. Exact duplicates (same account, folder and
 * uid) are collapsed — call sites used to do this with `new Set(uids)` after
 * the folder had already been flattened away.
 */
export function groupByAccountFolder<M extends MailRef>(msgs: readonly M[]): FolderGroup<M>[] {
  const groups: FolderGroup<M>[] = []
  const byKey = new Map<string, FolderGroup<M>>()
  const seen = new Set<MailKey>()
  for (const m of msgs) {
    const mk = mailKey(m)
    if (seen.has(mk)) continue
    seen.add(mk)
    const gk = `${m.accountId}:${m.folder}`
    let g = byKey.get(gk)
    if (!g) {
      g = { accountId: m.accountId, folder: m.folder, msgs: [], uids: [] }
      byKey.set(gk, g)
      groups.push(g)
    }
    g.msgs.push(m)
    g.uids.push(m.uid)
  }
  return groups
}

/**
 * The one group a plan may hand to an undoable move, or `null` when the plan
 * has zero or several of them.
 *
 * The undo bar replays a single (account, folder) pair — it is what the user
 * sees ("moved out of this folder") and what `useUndoSystem` re-sends. A set
 * spanning several source folders therefore must NOT be offered undo: replaying
 * it would send every UID back into one folder, most of them foreign there.
 * Withholding the affordance is honest; a silent one-folder undo is not.
 */
export function soleGroup<G>(groups: readonly G[]): G | null {
  return groups.length === 1 ? groups[0] : null
}

export type MoveToFolderPlan<M extends MailRef> = {
  /** Groups to move, each with its own source folder. */
  groups: FolderGroup<M>[]
  /** Messages already sitting in the destination — a no-op, not an error. */
  alreadyThere: number
  /** Messages of another account than the destination folder's — not movable. */
  foreignAccount: number
}

/**
 * Plans an explicit move (drag-and-drop onto a folder, "Move to…"): every group
 * keeps its own source folder, groups already in the destination drop out, and
 * messages of another account drop out because a folder path is only meaningful
 * inside the account that owns it.
 */
export function planMoveToFolder<M extends MailRef>(
  msgs: readonly M[],
  destination: { accountId: number; folder: string },
): MoveToFolderPlan<M> {
  const groups: FolderGroup<M>[] = []
  let alreadyThere = 0
  let foreignAccount = 0
  for (const g of groupByAccountFolder(msgs)) {
    if (g.accountId !== destination.accountId) { foreignAccount += g.uids.length; continue }
    if (g.folder === destination.folder) { alreadyThere += g.uids.length; continue }
    groups.push(g)
  }
  return { groups, alreadyThere, foreignAccount }
}

export type RoleMoveGroup<M extends MailRef> = FolderGroup<M> & { targetFolder: string }

export type RoleMovePlan<M extends MailRef> = {
  groups: RoleMoveGroup<M>[]
  /** At least one group belongs to an account with no folder for that role. */
  missingRole: boolean
}

/**
 * Plans a role move (archive / junk / trash). The target is resolved per
 * ACCOUNT (roles are per-account) and the source per GROUP, so a conversation
 * whose messages sit in two folders is archived out of both of them.
 * A group already inside its target folder drops out silently.
 */
export function planRoleMove<M extends MailRef>(
  msgs: readonly M[],
  targetFolderFor: (accountId: number) => string | undefined,
): RoleMovePlan<M> {
  const groups: RoleMoveGroup<M>[] = []
  let missingRole = false
  for (const g of groupByAccountFolder(msgs)) {
    const targetFolder = targetFolderFor(g.accountId)
    if (!targetFolder) { missingRole = true; continue }
    if (targetFolder === g.folder) continue
    groups.push({ ...g, targetFolder })
  }
  return { groups, missingRole }
}

/**
 * Groups the UNREAD messages of a set by their own folder. Marking a
 * conversation read is a per-message `\Seen` write (CLAUDE.md §5: the unit of
 * unread is the message), and already-read messages are left out so the folder
 * counters move by exactly the number of flags the server actually changed.
 */
export function planMarkSeenGroups<M extends MailRef & { unread?: boolean }>(
  msgs: readonly M[],
): FolderGroup<M>[] {
  return groupByAccountFolder(msgs.filter(m => m.unread))
}

/**
 * The largest UID RFC 3501 §2.3.1.1 can express — a 32-bit unsigned number
 * starting at 1.
 *
 * Mirrored from `MAX_RFC3501_UID` in `packages/net/imap.ts` (the wire predicate
 * `readServerUid`), which does not export it; `packages/core` must stay free of
 * the IMAP client, so the constant is duplicated rather than imported. Keep the
 * two in step.
 */
const MAX_RFC3501_UID = 4294967295

/**
 * May this number be sent to a server AS a UID?
 *
 * **One definition, used by the producer and by the parser.** The gesture must
 * not mint a ref the validator would then have to refuse: a validator firing on
 * legitimate input means the two sides disagree about what is addressable, and
 * the payload semantics (one bad entry voids the whole drop) would turn that
 * disagreement into "the user drags five messages and nothing happens".
 *
 * **Do not "harmonise" this with `isStorableUid` in `packages/db`.** That one
 * deliberately accepts NEGATIVE integers, because an offline move mints
 * temporary negative UIDs for rows that never came from a server. It is a
 * STORAGE predicate — "can this row live in the table". This one is a WIRE
 * predicate — "may this number be sent to a server" — and a local placeholder
 * must never travel that way. The two are correctly different, and this is
 * exactly the boundary between them: a placeholder is a real, visible message
 * that simply has no server-side address until offline replay gives it one.
 */
export function isWireUid(uid: number): boolean {
  return Number.isSafeInteger(uid) && uid >= 1 && uid <= MAX_RFC3501_UID
}

/**
 * The messages a drag gesture carries. Dragging a SELECTED row drags every
 * message of every selected row; dragging an unselected one carries just it.
 *
 * Membership is asked through `rowIsSelected` / `row.items` and never through
 * `selectedKeys.has(leadKey)` (CLAUDE.md §5) — the key standing for a row may be
 * any message of it. Refs, not bare UIDs: the selected rows may come from
 * several folders, and a UID without its folder addresses a stranger at the
 * drop site.
 *
 * **A message with no server-side address is left out here, at the PRODUCER.**
 * A message moved while offline carries a temporary negative UID until replay
 * gives it a real one (`moveMessagesLocally`), and `net:move` in main refuses
 * it — so it was never movable. Filtering it into the payload anyway would make
 * the parser refuse the whole drop, and a selection of four ordinary messages
 * plus one placeholder would move nothing. Dropping it here instead moves the
 * four and leaves the placeholder where it is, which is the honest outcome. A
 * selection holding only placeholders yields `[]` and the drop is a no-op.
 */
export function dragSelectionRefs(
  rows: ThreadRow[],
  dragged: MailSummary,
  selectedKeys: ReadonlySet<string>,
): MailRef[] {
  const toRef = (m: MailRef): MailRef => ({ accountId: m.accountId, folder: m.folder, uid: m.uid })
  const carry = (m: MailRef): MailRef[] => (isWireUid(m.uid) ? [toRef(m)] : [])
  const row = rowContaining(rows, dragged)
  if (!rowIsSelected(row, selectedKeys)) return carry(dragged)

  const refs: MailRef[] = []
  const seen = new Set<MailKey>()
  for (const r of rows) {
    if (!rowIsSelected(r, selectedKeys)) continue
    for (const item of r.items) {
      const ik = mailKey(item)
      if (seen.has(ik)) continue
      seen.add(ik)
      if (!isWireUid(item.uid)) continue
      refs.push(toRef(item))
    }
  }
  // The dragged row may be a stand-in built by `rowContaining` for a message no
  // current row holds; then the loop above finds nothing and the gesture still
  // has to carry what the user grabbed. It also finds nothing when every
  // selected message is a placeholder — and then `carry` is empty too, because
  // the dragged message is one of them.
  return refs.length > 0 ? refs : carry(dragged)
}

export function serializeMailRefs(refs: readonly MailRef[]): string {
  return JSON.stringify(refs.map(r => ({ accountId: r.accountId, folder: r.folder, uid: r.uid })))
}

/**
 * Ceilings on a drag payload. The payload arrives from the OS drag-and-drop
 * clipboard, so its size and contents are outside our control and have to be
 * bounded before `JSON.parse` is handed the string.
 *
 * `MAX_MAIL_REFS` = 10 000: the list pages in at `PAGE_SIZE` 50, so reaching the
 * cap means scrolling 200 pages and selecting all of them — comfortably past any
 * real bulk selection while keeping the drop a bounded amount of work.
 *
 * `MAX_PAYLOAD_CHARS` = 1 000 000: one entry with an ordinary mailbox name
 * serializes to roughly 45 characters, so a legitimate payload at the ref cap is
 * about 450 KB; a megabyte clears that with room for long hierarchical paths.
 *
 * `MAX_FOLDER_CHARS` = 512: IMAP sets no explicit limit on a mailbox name, but
 * servers cap the components (Dovecot: 255 bytes) and the whole name has to fit
 * a command line. 512 accepts a deeply nested real mailbox and refuses a name
 * built to bloat the payload.
 */
const MAX_MAIL_REFS = 10_000
const MAX_PAYLOAD_CHARS = 1_000_000
const MAX_FOLDER_CHARS = 512

/**
 * Control characters have no place in a mailbox name and CR/LF in particular
 * would be a command-injection primitive against the line-oriented IMAP
 * protocol. The delimiters real hierarchies use — `/` and `.` — are LEGITIMATE
 * and must keep passing.
 */
// eslint-disable-next-line no-control-regex
const FOLDER_CONTROL_CHARS = /[\u0000-\u001F\u007F]/

/**
 * Parses a drag payload. Fail-closed: anything unparseable, of the wrong shape,
 * out of bounds, or holding a single malformed entry yields `[]` — the drop then
 * does nothing. A move is not reversible from the renderer, so a partially
 * understood payload is not worth acting on.
 *
 * The bounds are ALIGNMENT with what the rest of the stack already enforces, not
 * a new restriction: `net:move` in main refuses non-positive UIDs and the IMAP
 * client refuses anything outside the RFC range, so nothing legitimate is lost
 * by refusing them one layer earlier — before a crafted payload gets to spend
 * our parse time or name a mailbox no server could hold.
 *
 * The uid rule is `isWireUid`, the SAME predicate the producer filters by, so a
 * legitimate gesture can never build a payload this refuses.
 */
export function parseMailRefs(raw: string | null | undefined): MailRef[] {
  if (!raw) return []
  if (raw.length > MAX_PAYLOAD_CHARS) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  if (parsed.length > MAX_MAIL_REFS) return []
  const refs: MailRef[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') return []
    const { accountId, folder, uid } = entry as Record<string, unknown>
    if (!Number.isSafeInteger(accountId) || (accountId as number) < 1) return []
    if (typeof uid !== 'number' || !isWireUid(uid)) return []
    if (typeof folder !== 'string' || folder === '' || folder.length > MAX_FOLDER_CHARS) return []
    if (FOLDER_CONTROL_CHARS.test(folder)) return []
    refs.push({ accountId: accountId as number, folder, uid: uid as number })
  }
  return refs
}

/**
 * Turns a parsed drag payload into the messages the renderer actually holds.
 *
 * **A drag payload is a SELECTOR over the loaded set, not an address.** It
 * crossed a process boundary as an opaque string on the OS drag clipboard, so
 * the authority on which messages exist and which mailbox each lives in is the
 * synced cache behind these rows — never the blob. Every ref is therefore looked
 * up among the messages currently loaded, and the message found there (with ITS
 * account, folder and uid) is what a destructive call may address; a ref naming
 * anything else is discarded.
 *
 * This is what keeps a drop as narrow as what the user can see. Without it a
 * crafted payload could name any mailbox of the selected account, because the
 * refs it carries are self-describing and every field of them would be believed.
 *
 * Lossless for real gestures: `dragSelectionRefs` builds its refs out of
 * `row.items` of these same rows, so every message a genuine drag carries is
 * present here. A ref that resolves to nothing means the message went away
 * between dragstart and drop (a background sync moved or expunged it) — dropping
 * it silently is the correct, fail-closed outcome.
 *
 * Returns `[]` when nothing resolves. The call site must then do NOTHING; there
 * is no fallback to the folder the list happens to be showing (that fallback is
 * the original §2.238 bug).
 */
export function resolveKnownRefs(refs: readonly MailRef[], rows: readonly ThreadRow[]): MailSummary[] {
  if (refs.length === 0) return []
  const known = new Map<MailKey, MailSummary>()
  for (const row of rows) {
    for (const item of row.items) {
      const k = mailKey(item)
      if (!known.has(k)) known.set(k, item)
    }
  }
  const resolved: MailSummary[] = []
  const seen = new Set<MailKey>()
  for (const ref of refs) {
    const k = mailKey(ref)
    if (seen.has(k)) continue
    const msg = known.get(k)
    if (!msg) continue
    seen.add(k)
    resolved.push(msg)
  }
  return resolved
}
