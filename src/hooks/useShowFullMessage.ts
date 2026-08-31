/**
 * §2.145 — "show full message": re-read the open message at the raised body
 * limit, on explicit user action only.
 *
 * A hook rather than a few lines inside the viewer, for the reason CLAUDE.md §5
 * gives about hotspots: both viewers need this (the main window and the
 * standalone mail window), and neither of them is a file that should grow
 * another IPC call plus its own in-flight flag.
 *
 * Three properties worth stating, because each is a bug if it is dropped:
 *
 *  - The request goes out on the EXISTING `net:messageDetails` channel with an
 *    option, not on a channel of its own. The preload whitelist is a security
 *    boundary; widening it for a variant of a read we already make would be
 *    paying in attack surface for nothing.
 *  - The result is applied only if the user is still looking at the SAME
 *    message. The re-parse is slow by definition (it is the big message), so
 *    switching away mid-flight is the normal case, not the edge one, and
 *    landing a 8 MiB body into the viewer of a message the user has left is
 *    both wrong and expensive.
 *  - A failure is silent by design: the clipped body is still on screen and
 *    still readable, so the honest outcome of "we could not get you more" is
 *    the banner staying exactly as it was. An error toast here would report a
 *    failure the user can do nothing about, on top of content that is fine.
 *    "Failure" includes responses that RESOLVE — see `isUsableExpansion`;
 *    keeping that promise takes more than a try/catch.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageDetails } from '../../packages/net/types'

/** The message currently on screen, or null when there is none. */
export type ShowFullMessageTarget = {
  accountId: number
  folder: string
  uid: number
} | null

/**
 * Is this response something to put on screen in place of what is already
 * there?
 *
 * A resolved promise is not a successful expansion. The raised-tier read goes
 * through the whole `net:messageDetails` pipeline, and that pipeline has
 * degraded answers that resolve rather than throw: with the network down and
 * the cached `.eml` evicted, `{ full: true }` comes back as an
 * `offlineFallback` envelope with no body at all. Installing it would replace a
 * perfectly readable clipped body with a "not available offline" placeholder —
 * the user clicks "show more" and gets LESS, which is the opposite of what the
 * header promises about failures.
 *
 * So: an offline fallback is a failed expansion, and so is a bodyless result
 * that carries no cap of its own. A result WITH a `parseCap` is usable even
 * when it is bodyless, because that is the pipeline telling us something true
 * about the message (it is past the hard cap) rather than something true about
 * the network.
 */
export function isUsableExpansion(details: MessageDetails | null | undefined): details is MessageDetails {
  if (!details) return false
  if (details.offlineFallback === true) return false
  return Boolean(details.html || details.text || details.parseCap)
}

export interface UseShowFullMessageResult {
  /** True while a re-parse is in flight. Drives the button's disabled state. */
  loadingFull: boolean
  /** Ask for the rest of the open message. No-op when there is no message or a
   *  request is already in flight. */
  requestFullMessage: () => void
}

export function useShowFullMessage(
  target: ShowFullMessageTarget,
  onDetails: (details: MessageDetails) => void,
): UseShowFullMessageResult {
  const [loadingFull, setLoadingFull] = useState(false)
  // Identity of the message the in-flight request belongs to. Compared on
  // arrival rather than cancelled on switch: an IPC invoke cannot be recalled,
  // so the only honest guard is to check what came back against what is open.
  const inFlightFor = useRef<string | null>(null)
  const onDetailsRef = useRef(onDetails)
  onDetailsRef.current = onDetails
  // The target is typically rebuilt as an object literal on every render, so it
  // is read through a ref and the identity that drives memoisation is the KEY.
  // Otherwise `requestFullMessage` would be a new function every render, and
  // every consumer memoised on it would re-render with it.
  const targetRef = useRef(target)
  targetRef.current = target

  const key = target ? `${target.accountId}:${target.folder}:${target.uid}` : null
  /**
   * The message on screen RIGHT NOW, updated during render.
   *
   * This, and not `inFlightFor`, is what the arrival check compares against.
   * `inFlightFor` is cleared by an effect, and an effect runs AFTER the commit
   * that changed the message: a response settling in that window found the old
   * key still in `inFlightFor`, matched its own captured key, and installed
   * message A's body under message B's header. A ref assigned during render is
   * current the instant the new target is committed, which closes the window
   * rather than narrowing it.
   */
  const currentKeyRef = useRef(key)
  currentKeyRef.current = key

  // Switching messages ends the wait for the previous one — the banner of the
  // NEW message must not come up already disabled. This governs the BUTTON,
  // not the correctness of what gets installed (see `currentKeyRef`).
  useEffect(() => {
    inFlightFor.current = null
    setLoadingFull(false)
  }, [key])

  const requestFullMessage = useCallback(() => {
    const target = targetRef.current
    if (!target || !key) return
    if (inFlightFor.current !== null) return
    inFlightFor.current = key
    setLoadingFull(true)
    void (async () => {
      try {
        const details = await window.api.invoke(
          'net:messageDetails',
          target.accountId,
          target.folder,
          target.uid,
          { full: true },
        ) as MessageDetails
        // Same message? Asked of the ref that tracks the commit, not of the
        // in-flight bookkeeping.
        if (currentKeyRef.current !== key) return
        // Usable answer? A fulfilled promise is not a successful expansion —
        // see `isUsableExpansion`.
        if (isUsableExpansion(details)) onDetailsRef.current(details)
      } catch {
        // Deliberately silent — see the header note.
      } finally {
        if (inFlightFor.current === key) {
          inFlightFor.current = null
          setLoadingFull(false)
        }
      }
    })()
  }, [key])

  return { loadingFull, requestFullMessage }
}

export default useShowFullMessage
