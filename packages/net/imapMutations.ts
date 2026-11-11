/**
 * The mutating IMAP commands (STORE, MOVE, COPY, EXPUNGE), with their results
 * CHECKED.
 *
 * Why this exists: ImapFlow does not throw when one of these commands fails. It
 * catches the failure inside the command and returns `false` — for a server
 * `NO`/`BAD` and for a connection that died with the answer outstanding alike —
 * and its fallback for servers without MOVE (RFC 6851) is COPY, STORE
 * `\Deleted`, EXPUNGE with the COPY result never looked at. Left to the
 * library, a refused COPY (`NO [OVERQUOTA]`) is followed by the flag and the
 * expunge, and a dropped STORE is reported as success. So every command here
 * announces itself (`noteImapMutation`, see ./imapAttempt) and then reads its
 * result:
 *
 *  - `false` with the connection still usable: the server answered and said no.
 *    Nothing was applied by THAT command; a plain failure.
 *  - `false` with the connection gone: the answer never arrived. Whether the
 *    server applied the change is unknown; the retry boundary reads the
 *    connection-level code, sees the announced mutation, and reports an
 *    undetermined outcome instead of re-sending.
 *  - a LATER step failing after an earlier one changed server state (the COPY
 *    of a move that then cannot be flagged or expunged): the state is partial
 *    and is reported as undetermined whichever way the step failed.
 *
 * Error text never carries a folder name or any server text.
 */
import type { ImapFlow } from 'imapflow'
import { markImapOutcomeUndetermined } from '@mailcopilot/core/transportFailure'
import { noteImapMutation } from './imapAttempt'

/** The server answered a mutating command with NO / BAD. */
export const IMAP_COMMAND_REJECTED_CODE = 'ERR_IMAP_COMMAND_REJECTED'
/** An earlier step of a multi-step mutation changed server state and a later one failed. */
export const IMAP_OUTCOME_UNKNOWN_CODE = 'ERR_IMAP_OUTCOME_UNKNOWN'

function hasCapability(c: ImapFlow, name: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (c as any).capabilities?.has?.(name) ?? false
}

/** The connection can still run a command in the selected mailbox. A server
 *  `* BYE` leaves `usable` true while the state is already LOGOUT, and the
 *  library then returns `undefined` for MOVE/COPY/EXPUNGE instead of `false`:
 *  that is a connection going away, not an answer. */
function canRunCommands(c: ImapFlow): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib = c as any
  const selected = !lib.states || lib.state === lib.states.SELECTED
  return c.usable && selected
}

/** The error for a mutating command whose result was not a success. */
function commandFailure(c: ImapFlow, command: string): Error {
  if (canRunCommands(c)) {
    return Object.assign(new Error(`IMAP ${command} was rejected by the server`), { code: IMAP_COMMAND_REJECTED_CODE })
  }
  // No answer will come. `NoConnection` is ImapFlow's own code for exactly this.
  return Object.assign(new Error(`IMAP connection was lost during ${command}`), { code: 'NoConnection' })
}

function partialFailure(command: string, cause: unknown): Error {
  const err = Object.assign(new Error(`IMAP ${command} was only partly applied or its result is unknown`), {
    code: IMAP_OUTCOME_UNKNOWN_CODE,
    cause,
  })
  markImapOutcomeUndetermined(err)
  return err
}

/** UID STORE of one flag on `uids` in the selected mailbox; throws unless it succeeded. */
export async function storeFlag(c: ImapFlow, uids: number[], flag: string, add: boolean): Promise<void> {
  if (uids.length === 0) return
  noteImapMutation()
  const ok = add
    ? await c.messageFlagsAdd(uids, [flag], { uid: true })
    : await c.messageFlagsRemove(uids, [flag], { uid: true })
  if (ok === false) throw commandFailure(c, 'STORE')
}

/**
 * Flag `uids` `\Deleted` and expunge them, without touching anyone else's
 * `\Deleted` messages: UID EXPUNGE with UIDPLUS (RFC 4315); without it a plain
 * EXPUNGE would remove EVERY flagged message (RFC 9051 §6.4.3), so the folder is
 * searched first and, if other messages are flagged, ours are only flagged and
 * the expunge is left to whoever flagged theirs (K-9's conservative reading).
 * The flag and the expunge are separate steps with separate results: an
 * expunge that fails after the flag took leaves the message flagged but
 * present, reported as a partial outcome.
 */
export async function deleteUids(c: ImapFlow, uids: number[]): Promise<void> {
  if (uids.length === 0) return
  if (!hasCapability(c, 'UIDPLUS')) {
    const uidSet = new Set(uids)
    // ImapFlow returns false, not an exception, when the SEARCH fails. A failed
    // search is NOT "nobody else flagged anything": reading it that way would
    // send a plain EXPUNGE that removes other people's \Deleted mail. It is a
    // failed READ (nothing mutated yet), so a lost connection is retried.
    const flagged = await c.search({ deleted: true }, { uid: true })
    if (!Array.isArray(flagged)) throw commandFailure(c, 'SEARCH')
    const foreign = flagged.filter((u) => !uidSet.has(u))
    if (foreign.length > 0) {
      await storeFlag(c, uids, '\\Deleted', true)
      return
    }
  }
  await storeFlag(c, uids, '\\Deleted', true)
  try {
    const expunged = await c.messageDelete(uids, { uid: true })
    if (expunged !== true) throw commandFailure(c, 'EXPUNGE')
  } catch (cause) {
    throw partialFailure('delete', cause)
  }
}

/**
 * Move `uids` from the selected mailbox to `destination`. Returns the
 * source-to-destination UID map when the server reports one (COPYUID).
 * With MOVE (RFC 6851) one command does it; without, COPY first, and nothing
 * is flagged or expunged unless the COPY succeeded. A refused COPY is a clean
 * refusal even for several messages: RFC 3501 §6.4.7 requires the server to
 * restore the destination to its state before an unsuccessful COPY.
 */
export async function moveUids(c: ImapFlow, uids: number[], destination: string): Promise<Map<number, number> | undefined> {
  if (hasCapability(c, 'MOVE')) {
    noteImapMutation()
    const moved = await c.messageMove(uids, destination, { uid: true })
    if (!moved || typeof moved !== 'object') {
      const failure = commandFailure(c, 'MOVE')
      // RFC 6851 §3.3: "Because a MOVE applies to a set of messages, it might
      // fail partway through the set", and the same section says this holds
      // "even if the server returns a tagged NO response". So a NO to a MOVE of
      // SEVERAL messages says nothing about which of them were moved: an unknown
      // outcome for the set, not a clean refusal. For ONE message the section
      // promises that it is never lost ("MUST leave each message ... in at least
      // one of the source or target mailboxes") and that it "SHOULD either be
      // moved or unaffected" and "SHOULD NOT" be left in both, so a NO is read
      // as unaffected; a server that breaks that SHOULD leaves a duplicate that
      // the next sync shows.
      if (uids.length > 1 && failure instanceof Error && (failure as { code?: string }).code === IMAP_COMMAND_REJECTED_CODE) {
        markImapOutcomeUndetermined(failure)
      }
      throw failure
    }
    return uidMapOf(moved)
  }
  noteImapMutation()
  const copied = await c.messageCopy(uids, destination, { uid: true })
  if (!copied || typeof copied !== 'object') throw commandFailure(c, 'COPY')
  try {
    await deleteUids(c, uids)
  } catch (cause) {
    throw partialFailure('move', cause)
  }
  return uidMapOf(copied)
}

function uidMapOf(result: unknown): Map<number, number> | undefined {
  if (result && typeof result === 'object' && 'uidMap' in result) {
    return (result as { uidMap?: Map<number, number> }).uidMap
  }
  return undefined
}
