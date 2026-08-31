import { useEffect, useRef } from 'react'

/**
 * Identifiers of a message referenced by a main-process new-mail notification.
 * Deliberately carries no subject/sender: the OS toast rendered those in the
 * main process, and the renderer re-reads the message from the local cache.
 */
export type MailOpenRef = {
  accountId: number
  folder: string
  uid: number
}

/**
 * Validate a `mail:openRef` payload coming over the preload bridge.
 *
 * The payload crosses a process boundary, so it is parsed rather than trusted:
 * a malformed ref must be dropped silently instead of driving navigation with
 * `NaN` ids (which would select a non-existent account and blank the list).
 */
export function parseMailOpenRef(payload: unknown): MailOpenRef | null {
  if (!payload || typeof payload !== 'object') return null
  const { accountId, folder, uid } = payload as Record<string, unknown>
  if (typeof accountId !== 'number' || !Number.isInteger(accountId) || accountId <= 0) return null
  if (typeof folder !== 'string' || folder.length === 0) return null
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid <= 0) return null
  return { accountId, folder, uid }
}

/**
 * Subscribe to new-mail notification clicks forwarded by the main process.
 *
 * The handler is held in a ref so that callers may pass an inline closure
 * without resubscribing on every render — the subscription itself lives for the
 * lifetime of the component.
 */
export function useMailOpenRef(onOpen: (ref: MailOpenRef) => void | Promise<void>): void {
  const handlerRef = useRef(onOpen)
  handlerRef.current = onOpen

  useEffect(() => {
    const bridge = window.api
    if (!bridge) return

    const listener = (payload: unknown) => {
      const ref = parseMailOpenRef(payload)
      if (!ref) return
      // A deep link must never surface as an unhandled rejection: the message
      // may have been deleted between the notification and the click.
      void Promise.resolve(handlerRef.current(ref)).catch(() => { /* ignore */ })
    }

    bridge.on('mail:openRef', listener)
    return () => { bridge.off('mail:openRef', listener) }
  }, [])
}
