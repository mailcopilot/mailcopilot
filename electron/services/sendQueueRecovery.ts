/**
 * Recovery of send-queue rows left in `sending` by a quit or a crash mid-send.
 *
 * Such a row has no outcome: the server may already have accepted the message
 * before the process went away (`before-quit` does not wait for an in-flight
 * send). Putting it back to `queued` sent it again automatically, which is what
 * the rule "an undetermined send outcome is not retried automatically" forbids.
 * The row goes to `failed` with the `delivery_unknown` key instead; "send now"
 * in the Outbox stays available, and it reuses the row's stored Message-ID.
 *
 * A row counts as abandoned when it was claimed more than two minutes ago, on
 * every pass, including the first one after a start. Every pass runs under the
 * `sendQueueProcessing` mutex, so no attempt of this process is live when the
 * recovery runs. The cutoff is there for another process: the single-instance
 * lock covers one `userData` directory, so a second instance with a different
 * `XDG_CONFIG_HOME` and the same `$HOME` shares this queue. Two minutes spare
 * its fresh claims; they do not bound a send (`SEND_TIMEOUTS.socket` is an
 * inactivity timeout), so in that unsupported setup a long send of the other
 * process can still be marked failed here. That never resends by itself (the
 * other process still writes `sent` when it finishes); a manual "send now" on
 * such a false unknown can deliver a second copy, with the same Message-ID.
 * The cost on an ordinary restart: a row left by the previous run stays in
 * `sending` (send-now is refused) for up to two minutes before the notice.
 *
 * Call it only from inside the queue pass, after the mutex is taken.
 */
import { encodeErrorPresentation } from '@mailcopilot/core/errorPresentation'

export const ABANDONED_SEND_STALE_MS = 2 * 60 * 1000

/** Stored as `last_error`; the renderer shows the translated `delivery_unknown` sentence. */
export const ABANDONED_SEND_FAILURE_TEXT =
  `${encodeErrorPresentation('delivery_unknown')} The send was interrupted (the app quit or stopped); it is not retried automatically`

export interface AbandonedSendRow {
  id: string
  accountId: number
  messageData: unknown
}

export interface SendQueueRecoveryDeps {
  /** Moves `sending` rows (claimed before `olderThanIso`, when given) to `failed` and returns them. */
  failAbandoned(errorText: string, olderThanIso?: string): AbandonedSendRow[]
  /** Tells the user and the Outbox about one failed row (broadcast, notification, metric). */
  reportFailed(row: AbandonedSendRow, failureText: string): void
  /** Called when `reportFailed` threw for a row; must not throw itself. */
  reportError(err: unknown): void
  now(): number
}

/**
 * A failing report for one row is handed to `reportError` and the loop goes on:
 * the rows are already `failed` in SQLite, and a notification that cannot be
 * shown must not stop the other reports or the queue pass that sends ordinary
 * mail.
 */
export function createSendQueueRecovery(deps: SendQueueRecoveryDeps): () => AbandonedSendRow[] {
  return () => {
    const olderThanIso = new Date(deps.now() - ABANDONED_SEND_STALE_MS).toISOString()
    const rows = deps.failAbandoned(ABANDONED_SEND_FAILURE_TEXT, olderThanIso)
    for (const row of rows) {
      try {
        deps.reportFailed(row, ABANDONED_SEND_FAILURE_TEXT)
      } catch (err) {
        deps.reportError(err)
      }
    }
    return rows
  }
}
