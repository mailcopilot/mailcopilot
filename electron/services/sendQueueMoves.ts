/**
 * The two send-queue moves the renderer can ask for: "send now" and
 * "reschedule" (`mail:queueSendNow`, `mail:queueReschedule`).
 *
 * Both move a row in time, and both refuse a row that is being sent.
 * `rescheduleSendQueue` in packages/db accepts a row in `sending` on purpose:
 * the queue's own retry path reschedules the row it has just claimed after a
 * transient failure. The renderer must not be able to do the same mid-send. The
 * claim does not notify the renderer, so the Outbox can still show such a row
 * as `queued`, with live buttons, for the whole time the send is in flight;
 * flipping it back to `queued` then lets the next pass claim it again and send
 * the message twice. The refusal therefore lives here, not in the SQL the retry
 * path shares.
 *
 * Read, check and write run synchronously one after another — nothing is
 * awaited in between, so the claim cannot slip into the gap. Dependencies are
 * injected so the whole thing is exercised by execution (sendQueueMoves.test.ts)
 * without `main.ts`, which cannot be imported from a test.
 */

export const QUEUE_ROW_SENDING_REFUSAL = 'This message is being sent right now'

export interface SendQueueMoveDeps {
  /** The stored row, or undefined when there is none. */
  getById(id: string): { accountId: number; status: string } | undefined
  /** Puts the row back to `queued` due now. False when the write changed nothing. */
  sendNow(id: string): boolean
  /** Puts the row back to `queued` due at `sendAtIso`. False when the write changed nothing. */
  reschedule(id: string, sendAtIso: string): boolean
  notifyChanged(accountId: number): void
  /** Starts a queue pass (fire and forget; a running pass ignores the call). */
  startProcessing(): void
  now(): number
}

function takeIdleRow(deps: SendQueueMoveDeps, queueId: string): { accountId: number } {
  const item = deps.getById(queueId)
  if (!item) throw new Error(`Queue entry ${queueId} not found`)
  if (item.status === 'sending') throw new Error(QUEUE_ROW_SENDING_REFUSAL)
  return item
}

export function requestQueueSendNow(deps: SendQueueMoveDeps, queueId: string): { ok: true } {
  const item = takeIdleRow(deps, queueId)
  if (!deps.sendNow(queueId)) throw new Error('Cannot send now for current status')
  deps.notifyChanged(item.accountId)
  deps.startProcessing()
  return { ok: true }
}

export function requestQueueReschedule(
  deps: SendQueueMoveDeps,
  queueId: string,
  sendAtIso: string,
): { ok: true; sendAt: string } {
  const item = takeIdleRow(deps, queueId)
  if (!deps.reschedule(queueId, sendAtIso)) throw new Error('Cannot reschedule for current status')
  deps.notifyChanged(item.accountId)
  if (new Date(sendAtIso).getTime() <= deps.now()) deps.startProcessing()
  return { ok: true, sendAt: sendAtIso }
}
