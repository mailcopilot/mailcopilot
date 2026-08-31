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
 *     to answer — must not restrict functionality). Every failure path renders
 *     the app, and the screen asks again next start because no record was
 *     written.
 *
 * §2.236 — A TIMEOUT IS NOT AN ANSWER.
 *
 * Until §2.236 both invariants were served by one 3s timer that, on firing,
 * moved the hook to `resolved` — turning "main has not answered yet" into "main
 * answered: nothing to ask". A `needed: true` arriving at 3.1s was dropped and
 * the question silently skipped. That was the single branch of §2.82 failing in
 * the permissive direction; every other one collapses uncertainty into "do not
 * send / ask again". The shape now is the standard one: consent state is
 * resolved from local config, and failing to resolve it means "not answered
 * yet". So a timeout ends the ATTEMPT, never the question (any reply, from any
 * attempt, settles the phase — nothing else can), and after a bounded number of
 * attempts we land in a state of its own, `unresolved`, NOT `resolved`: the app
 * renders, no record is written, telemetry stays off because the absence of a
 * record is a refusal, and the question comes back next launch.
 *
 * DIAGNOSTICS, renderer side only. Every step leaves a local line (see
 * `logConsent`): the reply and its round-trip latency, each timeout, each retry,
 * the give-up. These are kept because they describe THIS side's own retry state
 * machine, which is real behaviour rather than instrumentation.
 *
 * Main no longer logs its half. It used to (`seq` / `sinceHandlersReadyMs` /
 * `durationMs`), so that the two sides bracketed the round trip and placed a
 * fault on one of them; that instrumentation was retired in §2.236 once the
 * field report it was built for turned out not to be a defect at all. Do not
 * assume a matching line exists on the main side when reading a log.
 *
 * Why `console` and not `captureException`: this is the consent path itself, so
 * anything reported here could only come from a user who has NOT consented —
 * and main clamps the renderer's permission to `false` while the question is
 * open, making a Sentry call a guaranteed no-op, i.e. a diagnostic that cannot
 * reach us. `console` is process-local, is what the renderer already uses for
 * this (`uiFreezeDetector`, `Compose`), and reads out of DevTools on the machine
 * that reproduces the defect. It is a Sentry BREADCRUMB source, and breadcrumbs
 * accumulate regardless of the enabled flag — bounded here by two facts: every
 * field is a boolean, a small integer, a duration or a closed enum (never an
 * error message, which is free text from outside), and `setSentryUserEnabled`
 * clears both scopes' breadcrumbs on the consent transition, so nothing recorded
 * while the question was open can ride out with a later event.
 */

/** How long one `telemetry:consentState` attempt may take before we ask again.
 *  The handler is registered at main-module load, long before the first window,
 *  so a healthy main answers in single-digit ms: 3s is "main is not answering". */
export const CONSENT_STATE_TIMEOUT_MS = 3000

/** How many times we ask before giving up and rendering the app `unresolved`.
 *
 *  Below: one timeout must not decide anything, so a single retry is the minimum
 *  for the guarantee to mean something. Above: the product is how long a user
 *  stares at a themed background before the app appears — 5 x 3s = 15s worst
 *  case, and only against a main that never answers at all (a missing bridge or
 *  a rejection is retried without waiting).
 *
 *  The upper bound used to be pinned to something on the main side too: a 20s
 *  "nobody ever asked" watchdog, sized so the renderer had already given up
 *  before it fired. That watchdog was retired with the rest of the §2.236
 *  diagnostics, so this number is now answerable on its own terms — how long a
 *  blank window is tolerable — and there is no ordering left to preserve. */
export const CONSENT_STATE_MAX_ATTEMPTS = 5

/**
 * - `checking` — the state query is in flight; render nothing yet.
 *
 *   Deliberately not "render the app and swap it out later": mounting `<App/>`
 *   starts the account wizard when no account exists (§2.82 AC4) and kicks off
 *   folder sync. The consent screen has to come first, so the main window shows
 *   its themed background for the duration of one IPC round-trip instead.
 * - `required` — show the consent screen; `<App/>` must stay unmounted.
 * - `resolved` — a decision is ON RECORD: main answered "nothing to ask", or the
 *   user answered and main CONFIRMED the write (`{ ok: true }`). Render the app.
 * - `unresolved` — no record exists and we know it: nobody answered within the
 *   bound (§2.236), or the user answered and main did not confirm the write
 *   (`{ ok: false }`, an unrecognized reply, no bridge, a rejection). Render the
 *   app so the product is usable, but the state is NOT a decision: telemetry
 *   stays off and the question is asked again next launch. Kept distinct from
 *   `resolved` on purpose — collapsing the two is precisely the defect this
 *   state exists to make impossible to reintroduce, and a refused write is the
 *   same defect one channel over: main is the authority on what was recorded,
 *   so the phase may not claim more than main confirmed.
 */
export type TelemetryConsentPhase = 'checking' | 'required' | 'resolved' | 'unresolved'

export interface UseTelemetryConsentReturn {
  phase: TelemetryConsentPhase
  /** True while `telemetry:setConsent` is in flight — both buttons disable. */
  submitting: boolean
  /** Record the user's answer. `false` is produced by the "don't allow" button
   *  AND by Escape — the two are the same code path, so they cannot diverge. */
  decide: (granted: boolean) => void
  /** How many `telemetry:consentState` attempts have been started (§2.236
   *  AC1(c)). Surfaced so the retry is observable from outside the hook —
   *  `src/Root.tsx` mirrors it onto `<html>`, which makes "we had to ask twice"
   *  readable in DevTools on the machine that reproduces the defect and
   *  assertable end-to-end. Never a decision input. */
  attempts: number
}

export interface UseTelemetryConsentOptions {
  /** False for child windows (Settings / Compose / Account / MailWindow): the
   *  gate belongs to the main window only, and asking from four windows at once
   *  would produce four screens. Disabled means `resolved` with no IPC at all. */
  enabled?: boolean
}

/**
 * The part of the `telemetry:consentState` reply this hook CONSUMES — which is
 * also, exactly, the part it validates. Main's own `TelemetryConsentState`
 * (electron/services/telemetryConsentService.ts; the renderer cannot import from
 * electron/*) additionally carries the disclosure `version`, but nothing here
 * reads it: the screen's copy is versioned in the locale files, and the record's
 * version is stamped by main when it writes. Declaring a field we neither read
 * nor check would be a promise the parser does not keep.
 *
 * Narrowed rather than the reverse (also validating `version`) on purpose: a
 * field this hook never reads would then be able to turn a well-formed
 * `needed: true` into "could not determine", and after the retry budget into a
 * launch where the question is silently not asked — the exact failure §2.236
 * exists to prevent, re-created by a field that changes nothing here. What is
 * ACCEPTED is identical either way: `needed` must still be a real boolean, and
 * every other shape is still `malformed`. Nothing is widened.
 */
interface ConsentStateReply {
  needed: boolean
}

/** Why an attempt produced no answer. Closed set — the only thing about a
 *  failure that is ever logged. The error itself is free text written outside
 *  this process (main embeds fs paths, IMAP servers embed anything), so it never
 *  reaches a log line; it is carried on the result solely for the Settings-side
 *  `captureException`, which runs after the gate and is allowed to send. */
type ConsentUnavailableReason = 'no_bridge' | 'rejected' | 'malformed' | 'timeout'

export type ConsentStateRead =
  | { kind: 'answer'; needed: boolean }
  | { kind: 'unavailable'; reason: ConsentUnavailableReason; error?: unknown }

/**
 * Classify a `telemetry:consentState` payload.
 *
 * The distinction this function exists to draw (§2.236): "main said there is
 * nothing to ask" is an ANSWER, while a payload that is not the agreed shape is
 * "we could not determine it" — the same category error as the timeout, one
 * layer down. Until §2.236 an unrecognized shape read as `false` and the caller
 * treated that as an answer, which is how a protocol violation became a
 * permission to skip the question.
 *
 * `needed` must be a real boolean; `version` is main's business and is not read
 * here. Note the direction: no branch can produce `needed: false` as an answer
 * out of something that was not a well-formed `false`, so nothing here can turn
 * telemetry on or hide the question on a guess.
 */
export function parseConsentReply(payload: unknown): ConsentStateRead {
  if (!payload || typeof payload !== 'object') return { kind: 'unavailable', reason: 'malformed' }
  const needed = (payload as Partial<ConsentStateReply>).needed
  if (typeof needed !== 'boolean') return { kind: 'unavailable', reason: 'malformed' }
  return { kind: 'answer', needed }
}

/** The `ok: false` reasons main can answer `telemetry:setConsent` with
 *  (SetConsentResult in electron/services/telemetryConsentService.ts). Kept as a
 *  closed allow-list, not passed through: the value lands in a local log line,
 *  and a log line may only ever carry a closed enum. A reason outside this set
 *  is reported as `unknown` rather than echoed. */
const SET_CONSENT_REFUSALS = ['invalid_payload', 'save_failed', 'not_pending', 'forbidden_sender'] as const

/** Why the answer was not recorded. Main's own refusal reasons plus the three
 *  ways the round-trip itself can fail, in the same vocabulary as
 *  `ConsentUnavailableReason`. */
type SetConsentFailure =
  | (typeof SET_CONSENT_REFUSALS)[number]
  | 'no_bridge'
  | 'rejected'
  | 'malformed'
  | 'unknown'

/** Outcome of `telemetry:setConsent`, as the renderer is allowed to read it. */
export type SetConsentAck =
  | { kind: 'recorded' }
  | { kind: 'not_recorded'; reason: SetConsentFailure }

/**
 * Classify a `telemetry:setConsent` reply.
 *
 * Main does NOT reject when it refuses to write: a failed save, a sender that is
 * not the main window and the `not_pending` race all come back as a RESOLVED
 * `{ ok: false, reason }`. So a resolved promise is not evidence that anything
 * was recorded, and only a genuine `{ ok: true }` may be read as one — the
 * persisted record and main's gate are the authority on consent (§2.82), and the
 * renderer's phase must never claim more than main confirmed.
 *
 * Same direction as `parseConsentReply`: an unrecognized shape is "we do not
 * know that it was written", never "it was".
 */
export function parseSetConsentReply(payload: unknown): SetConsentAck {
  if (!payload || typeof payload !== 'object') return { kind: 'not_recorded', reason: 'malformed' }
  const ok = (payload as { ok?: unknown }).ok
  if (ok === true) return { kind: 'recorded' }
  // `ok` neither true nor false: not the agreed shape, so not an acknowledgement.
  if (ok !== false) return { kind: 'not_recorded', reason: 'malformed' }
  const reason = (payload as { reason?: unknown }).reason
  const known = SET_CONSENT_REFUSALS.find(candidate => candidate === reason)
  return { kind: 'not_recorded', reason: known ?? 'unknown' }
}

/** One `telemetry:consentState` round-trip. Never throws: a missing bridge and a
 *  rejecting handler are both "could not determine", like a malformed reply. */
async function readConsentState(): Promise<ConsentStateRead> {
  const invoke = window.api?.invoke
  if (typeof invoke !== 'function') return { kind: 'unavailable', reason: 'no_bridge' }
  try {
    return parseConsentReply(await window.api.invoke('telemetry:consentState'))
  } catch (err) {
    return { kind: 'unavailable', reason: 'rejected', error: err }
  }
}

/** One `telemetry:consentState` round-trip, flattened to "must we ask?".
 *
 *  Used by the Settings → About readout only. There, unlike the first-run gate,
 *  an unavailable state genuinely reads as "no hint to show" and a decision is
 *  already on record, so `captureException` can actually reach us. */
async function readConsentNeeded(source: string): Promise<boolean> {
  const result = await readConsentState()
  if (result.kind === 'answer') return result.needed
  if (result.reason === 'rejected') captureException(result.error, { source })
  return false
}

/** Fields a consent log line may carry: no free text, ever (see the module
 *  header on why these lines are local console output). */
type ConsentLogFields = Record<string, string | number | boolean>

/**
 * §2.236 AC1(b,c) — one local line per step of the handshake.
 *
 * `warn` for everything abnormal: in a packaged build that is the level the user
 * can actually see without turning anything on, and the abnormal branches are
 * the ones the field defect lives in.
 */
function logConsent(level: 'info' | 'warn', message: string, fields: ConsentLogFields): void {
  try {
    const line = `[TelemetryConsent] ${message}`
    if (level === 'warn') console.warn(line, fields)
    else console.info(line, fields)
  } catch { /* diagnostics must never throw */ }
}

/**
 * §2.236 AC1(d) — a crash of the React tree while the consent screen is up.
 *
 * Hypothesis 2 of the field investigation is that the dialog throws during
 * render and the error is eaten: `SentryErrorBoundary` in `src/Root.tsx` does
 * catch it, but its report goes through `beforeSend`, which returns `null` while
 * telemetry is off — and telemetry is necessarily off while the question is
 * open. The one crash we most need to see is the one guaranteed to be dropped;
 * this adds the local line that is not dropped.
 *
 * INSTRUMENTATION ONLY: nothing about what renders changes, and a crashing
 * dialog is not "repaired". The `captureException` call is kept even though the
 * gate drops it today — it is the only path that reports if a consent verdict
 * ever permits it, and it goes through `src/sentry.ts`, never the SDK directly,
 * so the gate and the PII filters apply. Lives here rather than in a component
 * so the policy sits with the rest of the consent reasoning.
 */
export function reportConsentTreeError(phase: TelemetryConsentPhase, error: unknown): void {
  logConsent('warn', 'the React tree crashed', { phase })
  if (phase !== 'required') return
  captureException(error, { source: 'useTelemetryConsent.dialogRender', phase })
}

/**
 * Gate hook for the main window. See the module comment for the failure policy.
 */
export function useTelemetryConsent(options?: UseTelemetryConsentOptions): UseTelemetryConsentReturn {
  const enabled = options?.enabled !== false
  const [phase, setPhase] = useState<TelemetryConsentPhase>('checking')
  const [attempts, setAttempts] = useState(0)
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

    let cancelled = false
    // An answer has been applied. Only a reply sets this — never a timer.
    let settled = false
    // We stopped waiting and rendered the app. See `applyAnswer`.
    let gaveUp = false
    const startedAt = Date.now()

    /**
     * Apply a reply. Any attempt's reply counts, including one from an attempt
     * we already stopped waiting on — that is the whole point of §2.236: a slow
     * `needed: true` must still ask, not be discarded because a stopwatch ran
     * out first.
     */
    const applyAnswer = (needed: boolean, attempt: number, elapsedMs: number) => {
      if (cancelled || settled) return
      if (gaveUp) {
        // Deliberately NOT applied. `<App/>` is already mounted at this point
        // (its load effect has run, the account wizard may be up), and pulling
        // it out from under a user who has started reading mail to show a modal
        // is worse than the alternative — which is not silence: no record was
        // written, so the question comes back on the next launch.
        logConsent('warn', 'consentState answered after the renderer gave up — asking again next launch', {
          attempt, elapsedMs, needed,
        })
        return
      }
      settled = true
      // The reply we received, and the round-trip latency. Main no longer logs
      // its own half (§2.236 retired), so this line stands alone rather than
      // bracketing anything.
      logConsent('info', 'consentState answered', { attempt, elapsedMs, needed })
      setPhase(needed ? 'required' : 'resolved')
    }

    /**
     * One attempt. Resolves as soon as EITHER the reply lands or the attempt
     * times out; a reply that arrives after that still runs `applyAnswer`,
     * because the promise is not abandoned, only stopped being waited on.
     */
    const ask = (attempt: number): Promise<'answered' | 'failed' | 'timeout'> => {
      const attemptStartedAt = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const read = readConsentState().then(result => {
        const elapsedMs = Date.now() - attemptStartedAt
        if (result.kind === 'answer') {
          applyAnswer(result.needed, attempt, elapsedMs)
          return 'answered' as const
        }
        // Closed reason enum only — never the error's text (module header).
        logConsent('warn', 'consentState attempt produced no answer', {
          attempt, of: CONSENT_STATE_MAX_ATTEMPTS, reason: result.reason, elapsedMs,
        })
        return 'failed' as const
      })
      const expiry = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), CONSENT_STATE_TIMEOUT_MS)
      })
      return Promise.race([read, expiry]).finally(() => clearTimeout(timer))
    }

    void (async () => {
      for (let attempt = 1; attempt <= CONSENT_STATE_MAX_ATTEMPTS; attempt++) {
        setAttempts(attempt)
        const outcome = await ask(attempt)
        if (cancelled || settled) return
        if (outcome === 'timeout') {
          // AC1(c) — the timeout is logged where it happens, and it is visibly
          // the end of an ATTEMPT, not of the question.
          logConsent('warn', 'consentState attempt timed out', {
            attempt, of: CONSENT_STATE_MAX_ATTEMPTS, timeoutMs: CONSENT_STATE_TIMEOUT_MS,
            // The attempt is over; the question is not. `retrying` says which
            // one this line is, so the log reads as a sequence rather than as
            // five identical failures.
            retrying: attempt < CONSENT_STATE_MAX_ATTEMPTS,
          })
        }
      }
      if (cancelled || settled) return
      gaveUp = true
      // Terminal, and NOT a decision. The app renders; no record exists, so
      // telemetry stays off (absence of a record is a refusal, §2.82) and the
      // question is asked again next launch.
      logConsent('warn', 'consent state unresolved — rendering the app without a decision', {
        attempts: CONSENT_STATE_MAX_ATTEMPTS, totalMs: Date.now() - startedAt,
      })
      setPhase('unresolved')
    })()

    return () => { cancelled = true }
  }, [enabled])

  const decide = useCallback((granted: boolean) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setSubmitting(true)
    void (async () => {
      const startedAt = Date.now()
      /**
       * Where the click lands us. `resolved` means "an answer is on record", so
       * only a confirmed write may produce it; everything else ends in
       * `unresolved`, which already means exactly what is true in that case —
       * nothing was recorded, telemetry stays off, and the question comes back
       * next launch. The app renders either way: a broken IPC must not hold the
       * mail client hostage behind a modal (GDPR art. 7(4)), so the failure
       * changes what we CLAIM, never whether the user gets through.
       */
      let outcome: TelemetryConsentPhase = 'unresolved'
      /** One shape for every "not recorded" ending — closed reason enum only. */
      const notRecorded = (reason: SetConsentFailure) => {
        logConsent('warn', 'setConsent failed — the answer was not recorded', {
          granted, reason, elapsedMs: Date.now() - startedAt,
        })
      }
      try {
        // Read the bridge first instead of `window.api?.invoke(...)`: with no
        // bridge that optional chain awaits `undefined`, which resolves — i.e.
        // a call that never happened would take the acknowledged path.
        const invoke = window.api?.invoke
        if (typeof invoke !== 'function') {
          notRecorded('no_bridge')
        } else {
          // `granted` is the entire payload: main stamps the disclosure version
          // and the timestamp itself, and rejects anything else (strict schema).
          const ack = parseSetConsentReply(await window.api.invoke('telemetry:setConsent', { granted }))
          if (ack.kind === 'recorded') {
            outcome = 'resolved'
            // AC1(b) — the other half of the handshake, with the same latency
            // bracket. `granted` is the user's own click, not third-party text.
            logConsent('info', 'setConsent acknowledged', { granted, elapsedMs: Date.now() - startedAt })
          } else {
            // Main refused to write (or answered a shape we do not recognize).
            // No `captureException` here: there is no error to report, and main
            // already reports its own save failure from the side that has the
            // detail — a second, empty report from the renderer would be dropped
            // anyway, since telemetry is necessarily off while the question is
            // open (module header).
            notRecorded(ack.reason)
          }
        }
      } catch (err) {
        notRecorded('rejected')
        captureException(err, { source: 'useTelemetryConsent.setConsent' })
      } finally {
        inFlightRef.current = false
        setSubmitting(false)
        setPhase(outcome)
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

  return { phase, submitting, decide, attempts }
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
