import { useCallback, useMemo, useRef } from 'react'
import { runMailOpen, settleMailOpen, type MailOpenSink, type MailOpenTicket } from '../../packages/core/mailOpenOwnership'

export interface MailOpenOwnership {
  /** Start a new open request; every earlier request becomes superseded. */
  beginOpen: () => MailOpenTicket
  /** The user navigated: in-flight requests may no longer show their result. */
  invalidateNavigation: () => void
  /** Run `request` to a terminal state on behalf of `ticket` (see `runMailOpen`). */
  run: <D>(ticket: MailOpenTicket, request: () => Promise<D>, sink: MailOpenSink<D>) => Promise<void>
}

/**
 * Owns the two counters behind `settleMailOpen` (§2.308). Kept out of
 * `App.tsx`, which only calls it. A list refresh deliberately has no entry
 * point here: it must not interfere with the open message.
 */
export function useMailOpenOwnership(): MailOpenOwnership {
  const nav = useRef(0)
  const open = useRef(0)
  const beginOpen = useCallback((): MailOpenTicket => ({ nav: nav.current, open: ++open.current }), [])
  const invalidateNavigation = useCallback(() => { nav.current += 1 }, [])
  const run = useCallback(
    <D>(ticket: MailOpenTicket, request: () => Promise<D>, sink: MailOpenSink<D>) =>
      runMailOpen(request, () => settleMailOpen(ticket, { nav: nav.current, open: open.current }), sink),
    [],
  )
  // Stable identity: callers list the result in effect/callback dependencies.
  return useMemo(() => ({ beginOpen, invalidateNavigation, run }), [beginOpen, invalidateNavigation, run])
}
