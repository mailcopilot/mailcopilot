/**
 * Who owns an in-flight "open this message" request (§2.308).
 *
 * Two independent counters decide what happens when the details of an opened
 * message arrive:
 *
 *  - `nav` moves only when the user (or a programmatic equivalent such as an
 *    assistant link) navigates: another folder, account, view or search state.
 *    Those paths already drop the open message and its loading flag, so a
 *    response that was requested before one of them must not repopulate the
 *    pane.
 *  - `open` moves on every new open request. A response from an older request
 *    must never touch the pane or its loading flag: the newer request owns both.
 *
 * A refresh of the folder that is already on screen (periodic sync, manual
 * sync, auto-sync after an account/folder switch) invalidates the LIST, not the
 * open message, so it moves neither counter. Tying open ownership to the list
 * counter was the defect: a refresh landing while the details were in flight
 * made the response look stale and, because the loading flag was cleared under
 * the same condition, left the pane on "Loading" forever.
 */

export interface MailOpenTicket {
  /** `nav` counter value when the request was issued. */
  readonly nav: number
  /** Request number; the highest issued number is the live request. */
  readonly open: number
}

export interface MailOpenCounters {
  readonly nav: number
  readonly open: number
}

export type MailOpenSettlement =
  /** Still the live request in the same navigation context: show it. */
  | { readonly kind: 'applied'; readonly applyDetails: true; readonly clearLoading: true }
  /** The user navigated away; nothing to show, but this was the live request, so it releases the loading flag. */
  | { readonly kind: 'navigated'; readonly applyDetails: false; readonly clearLoading: true }
  /** A newer request owns the pane and its loading flag: touch neither. */
  | { readonly kind: 'superseded'; readonly applyDetails: false; readonly clearLoading: false }

/** Decide what a settled open request (success or failure) may do to the pane. */
export function settleMailOpen(ticket: MailOpenTicket, current: MailOpenCounters): MailOpenSettlement {
  if (ticket.open !== current.open) {
    return { kind: 'superseded', applyDetails: false, clearLoading: false }
  }
  if (ticket.nav !== current.nav) {
    return { kind: 'navigated', applyDetails: false, clearLoading: true }
  }
  return { kind: 'applied', applyDetails: true, clearLoading: true }
}

/** What the caller does with each outcome of an open request. */
export interface MailOpenSink<D> {
  /** The response may be shown: still the live request in the same navigation context. */
  onApplied: (details: D) => void
  /** The live request failed: surface the error. */
  onFailed: (error: unknown) => void
  /** The response or failure is not for the pane any more (navigated away, or a newer open). */
  onDiscarded: (settlement: MailOpenSettlement) => void
  /** Release the "loading" flag. Called only by the request that owns it, on every outcome. */
  releaseLoading: () => void
}

/**
 * Run one open request to a terminal state. Whatever happens (success,
 * failure, a sink that throws), a request that still owns the loading flag
 * releases it: the pane can not be left on "Loading" while nothing is in
 * flight. `settle` is read AFTER the await, never before — ownership is
 * judged against the world as it is when the response lands.
 */
export async function runMailOpen<D>(
  request: () => Promise<D>,
  settle: () => MailOpenSettlement,
  sink: MailOpenSink<D>,
): Promise<void> {
  let settlement: MailOpenSettlement | null = null
  try {
    const details = await request()
    settlement = settle()
    if (settlement.applyDetails) sink.onApplied(details)
    else sink.onDiscarded(settlement)
  } catch (e) {
    // A discard sink that throws is not a request failure: do not dispatch it a second time.
    if (settlement && !settlement.applyDetails) throw e
    settlement = settle()
    if (settlement.applyDetails) sink.onFailed(e)
    else sink.onDiscarded(settlement)
  } finally {
    if ((settlement ?? settle()).clearLoading) sink.releaseLoading()
  }
}
