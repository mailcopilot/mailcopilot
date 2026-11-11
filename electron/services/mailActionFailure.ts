/**
 * Result text for a batch mail action (archive / delete / mark read) that
 * stopped part-way.
 *
 * The apply callback works through its groups one after another (one group per
 * account and folder), so a failure in group N leaves groups 1..N-1 applied and
 * N undecided. Rethrowing from the callback threw away that progress: the model
 * was told only that the action failed and would offer to redo the whole batch.
 * The result names how many messages were completed first, says that later
 * groups were not attempted, and — via `describeErrorReason` — carries the
 * "outcome unknown" note when the failure struck after a MOVE/STORE/EXPUNGE had
 * been sent. It makes no claim about the failed group beyond that: a failure
 * after the server applied the change (local cache cleanup, say) would make
 * "nothing was changed" false.
 *
 * Only counts, the action name, an account number and the reason. The reason
 * is `describeErrorReason`'s, built from a closed vocabulary (code, syscall,
 * class name): the message of the error is never used.
 */
import { describeErrorReason } from '../unwrapAggregate'

export function describeMailActionFailure(args: {
  action: string
  accountId: number | null
  err: unknown
  /** Messages completed before the failing group. */
  affected: number
  /** Groups after the failing one that were not attempted. */
  notAttempted: number
}): string {
  const { action, accountId, err, affected, notAttempted } = args
  const where = accountId === null ? '' : ` for account #${accountId}`
  const parts = [
    `Action "${action}" stopped${where}: ${describeErrorReason(err)}.`,
    `Completed before the failure: ${affected} message${affected === 1 ? '' : 's'}.`,
  ]
  if (notAttempted > 0) {
    parts.push(`${notAttempted} further folder group${notAttempted === 1 ? ' was' : 's were'} not attempted.`)
  }
  return parts.join(' ')
}
