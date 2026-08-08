import { useCallback, useEffect, useRef, useState } from 'react'
import { captureException } from '../sentry'

/**
 * §2.82 — first-run telemetry consent, renderer side.
 *
 * Main owns the decision (electron/telemetryConsent.ts + the
 * `telemetry:consentState` / `telemetry:setConsent` handlers); this hook only
 * asks whether the screen has to be shown and reports the click back. It never
 * derives "telemetry is on" from anything it sees: `needed: false` means "do
 * not ask", not "sending is allowed" — the sending decision is made in main and
 * reaches the renderer as the clamped `sentryEnabled` flag.
 *
 * Two invariants shape the error handling, and they point in opposite
 * directions on purpose:
 *
 *   - FAIL-CLOSED for sending. Nothing here can turn telemetry on. If the state
 *     query fails we simply do not show the screen; main is still refusing to
 *     send, because its own preflight fails closed on the same missing record.
 *   - FAIL-OPEN for the interface. A broken IPC must not hold the mail client
 *     hostage behind a modal (GDPR art. 7(4): refusing — or, here, being unable
 *     to answer — must not restrict functionality). Every failure path ends in
 *     `resolved`, i.e. the app renders, and the screen asks again next start
 *     because no record was written.
 */

/** How long we wait for `telemetry:consentState` before rendering the app anyway.
 *  The handler is registered at main-module load, well before the first window
 *  exists, so in practice this never fires — it exists so a wedged main process
 *  cannot leave the user staring at an empty window. */
export const CONSENT_STATE_TIMEOUT_MS = 3000

/**
 * - `checking` — the state query is in flight; render nothing yet.
 *
 *   Deliberately not "render the app and swap it out later": mounting `<App/>`
 *   starts the account wizard when no account exists (§2.82 AC4) and kicks off
 *   folder sync. The consent screen has to come first, so the main window shows
 *   its themed background for the duration of one IPC round-trip instead.
 * - `required` — show the consent screen; `<App/>` must stay unmounted.
 * - `resolved` — a decision exists (or we could not ask); render the app.
 */
export type TelemetryConsentPhase = 'checking' | 'required' | 'resolved'

export interface UseTelemetryConsentReturn {
  phase: TelemetryConsentPhase
  /** True while `telemetry:setConsent` is in flight — both buttons disable. */
  submitting: boolean
  /** Record the user's answer. `false` is produced by the "don't allow" button
   *  AND by Escape — the two are the same code path, so they cannot diverge. */
  decide: (granted: boolean) => void
}

export interface UseTelemetryConsentOptions {
  /** False for child windows (Settings / Compose / Account / MailWindow): the
   *  gate belongs to the main window only, and asking from four windows at once
   *  would produce four screens. Disabled means `resolved` with no IPC at all. */
  enabled?: boolean
}

/** Shape of the `telemetry:consentState` reply. Mirrors TelemetryConsentState
 *  in electron/services/telemetryConsentService.ts (the renderer cannot import
 *  from electron/*). Only `needed` is consumed; `version` is main's business. */
interface ConsentStateReply {
  needed: boolean
  version: number
}

/**
 * Read `needed` from an IPC reply.
 *
 * Anything unrecognized reads as `false` (do not show the screen). That is the
 * conservative answer for a UI gate: an unexpected shape means we have no
 * evidence the user must be asked, and blocking the app on a guess would be the
 * fail-open direction that actually hurts (main keeps telemetry off regardless).
 */
export function parseConsentNeeded(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  return (payload as Partial<ConsentStateReply>).needed === true
}

/** One `telemetry:consentState` round-trip. Never throws — resolves `false`
 *  when the bridge is missing (unit tests, a preload that failed to load) or
 *  the handler rejects. */
async function readConsentNeeded(source: string): Promise<boolean> {
  try {
    const invoke = window.api?.invoke
    if (typeof invoke !== 'function') return false
    return parseConsentNeeded(await window.api.invoke('telemetry:consentState'))
  } catch (err) {
    captureException(err, { source })
    return false
  }
}

/**
 * Gate hook for the main window. See the module comment for the failure policy.
 */
export function useTelemetryConsent(options?: UseTelemetryConsentOptions): UseTelemetryConsentReturn {
  const enabled = options?.enabled !== false
  const [phase, setPhase] = useState<TelemetryConsentPhase>('checking')
  const [submitting, setSubmitting] = useState(false)
  // Synchronous re-entry latch: `submitting` only becomes observable after a
  // render, so a double click (or Escape while a click is in flight) would
  // otherwise send two `telemetry:setConsent` payloads.
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!enabled) {
      setPhase('resolved')
      return
    }
    let settled = false
    const settle = (needed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setPhase(needed ? 'required' : 'resolved')
    }
    // Declared after `settle` on purpose: `settle` only runs from the timer
    // callback or the resolved promise, both strictly after this assignment.
    const timer = setTimeout(() => settle(false), CONSENT_STATE_TIMEOUT_MS)
    void readConsentNeeded('useTelemetryConsent.consentState').then(settle)
    return () => {
      settled = true
      clearTimeout(timer)
    }
  }, [enabled])

  const decide = useCallback((granted: boolean) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setSubmitting(true)
    void (async () => {
      try {
        // `granted` is the entire payload: main stamps the disclosure version
        // and the timestamp itself, and rejects anything else (strict schema).
        await window.api?.invoke('telemetry:setConsent', { granted })
      } catch (err) {
        // A failed write means no record was persisted, so telemetry stays off
        // and the screen asks again next start. Holding the modal open would
        // trap the user behind an IPC we cannot repair from here, so we let the
        // app through — the answer is simply not remembered.
        captureException(err, { source: 'useTelemetryConsent.setConsent' })
      } finally {
        inFlightRef.current = false
        setSubmitting(false)
        setPhase('resolved')
      }
    })()
  }, [])

  // Escape = refusal, byte-identical to the "don't allow" button (EDPB
  // Guidelines 03/2022: dismissing must never be the "accept" path, and the two
  // exits must not produce different records).
  useEffect(() => {
    if (phase !== 'required') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      decide(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [phase, decide])

  return { phase, submitting, decide }
}

/**
 * Read-only variant for Settings → About.
 *
 * The About switch is clamped in main: while no consent record exists,
 * `sentryEnabled` can never persist as `true` (applyAboutToggle). Without this
 * signal the switch would silently bounce back and look broken, so Settings
 * shows "consent not given yet" instead. Re-reads on `settings:changed` so an
 * answer given in the main window while Settings is open is reflected.
 */
export function useTelemetryConsentNeeded(): boolean {
  const [needed, setNeeded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void readConsentNeeded('useTelemetryConsentNeeded.consentState').then(value => {
        if (!cancelled) setNeeded(value)
      })
    }
    refresh()
    // Mount-once subscription (BACKLOG §2.25): the preload `off()` bridge
    // matches by identity, so the handler must not be re-created per render.
    window.api?.on('settings:changed', refresh)
    return () => {
      cancelled = true
      window.api?.off('settings:changed', refresh)
    }
  }, [])

  return needed
}
