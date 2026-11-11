import { useEffect, useState } from 'react'
import { captureException } from '../sentry'

/**
 * §2.297 — what this build allows for Google sign-in, as told by main.
 *
 * Display only. The refusals (no new mailbox through Google, same address on
 * reconnect) are enforced in main's `oauth:google:connect`; this hook only
 * decides which buttons and texts the Add Account window shows. Mirror of the
 * `oauth:google:availability` reply in electron/main.ts — the renderer cannot
 * import from electron/*, so the shape is re-declared here.
 *
 * Fail-closed on every unknown: until the reply arrives, or when it is
 * missing, malformed or rejected, Google sign-in is treated as unavailable,
 * which sends the user down the app-password path that always works.
 */
export type GoogleSignInAvailability = {
  /** The build carries a Google client at all. */
  configured: boolean
  /** A mailbox without Google sign-in may be connected through it. */
  newMailboxes: boolean
}

const UNAVAILABLE: GoogleSignInAvailability = { configured: false, newMailboxes: false }

/** Exported for the unit tests: the hook must never throw on a shape it did
 *  not expect, and anything but a literal `true` reads as "no". */
export function parseGoogleSignInAvailability(raw: unknown): GoogleSignInAvailability {
  const value = raw as Partial<Record<keyof GoogleSignInAvailability, unknown>> | null | undefined
  const configured = value?.configured === true
  return { configured, newMailboxes: configured && value?.newMailboxes === true }
}

export function useGoogleSignInAvailability(): GoogleSignInAvailability {
  const [availability, setAvailability] = useState<GoogleSignInAvailability>(UNAVAILABLE)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const raw = await window.api.invoke('oauth:google:availability')
        if (!cancelled) setAvailability(parseGoogleSignInAvailability(raw))
      } catch (err) {
        captureException(err, { source: 'useGoogleSignInAvailability' })
      }
    })()
    return () => { cancelled = true }
  }, [])

  return availability
}
