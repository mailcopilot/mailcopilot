/**
 * Per-attempt record of whether a MUTATING IMAP command has been sent.
 *
 * The retry boundaries (`withImapRetry` and its pool and dedicated variants)
 * run the operation callback once per attempt. Retrying is safe while the
 * attempt only connected and read (LIST, SELECT, SEARCH, FETCH): nothing on the
 * server has changed. It is not safe once a MOVE, STORE or EXPUNGE has been
 * issued: if the connection dies with the answer outstanding, the server may or
 * may not have applied it (RFC 6851 gives MOVE no atomicity across a dropped
 * connection and no way to ask afterwards), so re-sending is a guess, and the
 * honest report is "outcome unknown". Same principle as the SMTP rule for an
 * undetermined delivery.
 *
 * The callbacks stay plain `() => Promise<T>`: a mutator announces itself with
 * `noteImapMutation()` immediately before the command, and the boundary reads
 * the flag in its catch. The record rides an AsyncLocalStorage scope, so
 * announcing outside a boundary is a no-op.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface ImapAttempt {
  /** A mutating command has been (or is about to be) sent in this attempt. */
  mutationIssued: boolean
  /** The operation's overall deadline expired while this attempt was still
   *  running. The caller has already been told the operation failed, so from
   *  here on the attempt must send NOTHING that changes the server and must not
   *  open (or publish) a connection: it is being abandoned, not finished. */
  aborted: boolean
}

export function newImapAttempt(): ImapAttempt {
  return { mutationIssued: false, aborted: false }
}

/** Terminal error of an operation that ran out of its overall time. */
export const IMAP_OPERATION_DEADLINE_CODE = 'ERR_IMAP_OPERATION_DEADLINE'
export function operationDeadlineError(): Error {
  return Object.assign(new Error('IMAP operation exceeded its time limit'), { code: IMAP_OPERATION_DEADLINE_CODE })
}

const attemptScope = new AsyncLocalStorage<ImapAttempt>()

/** Run one attempt of an operation inside its own record. */
export function runImapAttempt<T>(attempt: ImapAttempt, fn: () => Promise<T>): Promise<T> {
  return attemptScope.run(attempt, fn)
}

/**
 * Call immediately BEFORE sending a mutating command (MOVE, STORE, EXPUNGE).
 * Before, not after: a connection that dies while the command is in flight
 * never reaches the line after it.
 */
export function noteImapMutation(): void {
  const attempt = attemptScope.getStore()
  if (!attempt) return
  // An abandoned attempt (deadline expired) never sends a mutation: the caller
  // was already told the operation failed, and a MOVE that lands afterwards,
  // outside the connection lock, would act behind everyone's back.
  if (attempt.aborted) throw operationDeadlineError()
  attempt.mutationIssued = true
}

/** Throws when the current attempt was abandoned. Called at every await inside
 *  `connectImap` that precedes starting or publishing a connection, so a late
 *  connect cannot be started (or published) by a dead attempt. */
export function assertAttemptLive(): void {
  if (attemptScope.getStore()?.aborted) throw operationDeadlineError()
}
