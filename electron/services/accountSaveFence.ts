/**
 * `saveAccount` serialised per account id, with a refusal check that runs on the
 * record the write is about to overwrite.
 *
 * Saves of ONE account id run one after another, and the optional `gate` runs
 * inside that queue, on the stored record as it is at THAT save's turn. A check
 * made before queueing reads a record the saves ahead in the queue may still
 * replace (an edit racing an OAuth re-authorisation).
 */
import { getAccountMeta } from '../../packages/net/config'

/** The record a save is about to overwrite, as the gate reads it. */
type StoredAccount = ReturnType<typeof getAccountMeta>

/**
 * A refusal that has to be decided against the record the write will overwrite.
 * It runs inside the id's queue turn, BEFORE the write; throwing refuses the save
 * (nothing is written, later saves of the id still run).
 */
export type AccountSaveGate = (stored: StoredAccount) => void

const tails = new Map<number, Promise<unknown>>()

async function saveGatedNow<I extends { id?: number }, R>(
  save: (input: I) => Promise<R>,
  input: I,
  gate?: AccountSaveGate,
): Promise<R> {
  const id = input.id
  if (gate) {
    // A gate cannot judge a record it cannot read: that refuses.
    gate(typeof id === 'number' ? getAccountMeta(id) : undefined)
  }
  return save(input)
}

/** `save` is passed in, so each caller keeps the `saveAccount` binding it already had (and its tests keep their seam). */
export function saveAccountFenced<I extends { id?: number }, R>(
  save: (input: I) => Promise<R>,
  input: I,
  gate?: AccountSaveGate,
): Promise<R> {
  const id = input.id
  // A new account has no queue to wait in.
  if (typeof id !== 'number') return saveGatedNow(save, input, gate)
  const queued = tails.get(id)
  // Nothing in flight for this id: start now, so the gate runs in the caller's own turn.
  const run = queued ? queued.then(() => saveGatedNow(save, input, gate)) : saveGatedNow(save, input, gate)
  const tail = run.then(() => undefined, () => undefined)
  tails.set(id, tail)
  void tail.then(() => { if (tails.get(id) === tail) tails.delete(id) })
  return run
}
