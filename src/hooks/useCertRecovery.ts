import { useCallback, useEffect, useReducer, useRef } from 'react'
import { captureException } from '../sentry'

/**
 * TLS trust rework Phase A3 — renderer hook for the cert-recovery UX.
 *
 * Subscribes to the two main→renderer broadcasts established in Phase A2
 * (`cert:recoveryRequired`, `cert:interceptionNotice`, whitelisted in
 * electron/preload.ts) and drives:
 *   - a single blocking recovery dialog (one host at a time; further hosts
 *     queue FIFO), and
 *   - a list of non-blocking interception notices (dismissible banners).
 *
 * All strings that originate from the server or the raw TLS error
 * (`issuerCn`, `subjectCn`, `rawMessage`, `fingerprintSha256`, `host`) are
 * UNTRUSTED. This hook only stores them as plain data; the presentational
 * component renders them exclusively through text nodes — never HTML.
 *
 * The renderer emits NO metrics: dialog_shown / trust_clicked / notice_shown
 * are recorded in main (see electron/services/certRecovery.ts). This keeps the
 * renderer contract to invoke + subscribe only.
 *
 * BACKLOG §2.25 subscription discipline: the preload `off()` bridge cannot
 * remove a contextBridge-proxied listener by identity if it was re-created on
 * a re-render, so the subscription effect is mount-once (deps []) and the
 * handlers reach current state through refs / dispatch.
 *
 * Concurrency invariants (codex review 2026-07-24):
 *   1. Dialog + queue live in ONE reducer state. Two `cert:recoveryRequired`
 *      events delivered inside the same React batch are therefore applied
 *      sequentially (the second reducer call sees the result of the first)
 *      instead of both observing `dialog === null` and the later one clobbering
 *      the earlier. A lost request is unrecoverable: main keeps that host in
 *      `awaiting-user` and never re-notifies within the session.
 *   2. `dismiss()` does NOT advance the queue optimistically. Main only leaves
 *      `awaiting-user` once `cert:dismiss` is acknowledged, so the request stays
 *      on screen (with an inline error) when the invoke rejects — the user can
 *      retry instead of silently losing the prompt for the whole session.
 *   3. A synchronous `inFlightRef` latch guards trust/dismiss re-entry, because
 *      the `trusting` / `dismissing` state flags only become observable after
 *      the next render.
 *   4. `net:trustCert` is fail-closed in main and rejects with machine-readable
 *      codes. `cert_trust_fingerprint_mismatch` means the fingerprint this hook
 *      holds is STALE (cert rotation / a different load-balancer node between
 *      the broadcast and the click). Retrying with the same value can never
 *      succeed, so the cached fingerprint is dropped and the endpoint is
 *      re-probed — otherwise the user is stuck in a permanent retry loop for
 *      the rest of the session.
 *   5. WHAT-YOU-SEE-IS-WHAT-YOU-PIN. A probe result is only ever put ON SCREEN;
 *      it is never pinned within the same user action. `trust()` sends exactly
 *      the fingerprint the dialog is currently displaying, so every pinned
 *      certificate was visible to the user at the moment they clicked. Without
 *      this rule the fail-closed mismatch rejection degrades into a one-click
 *      bypass: swap the certificate at the right moment, let the first click
 *      fail, and the "retry" blind-pins whatever the server now serves. Both
 *      probe paths (payload arrived without a fingerprint, and post-mismatch
 *      re-read) therefore end by rendering the new fingerprint / issuer /
 *      subject and returning — the user confirms the updated values with a
 *      separate, deliberate click.
 */

/** Payload of the `cert:recoveryRequired` broadcast. Mirror of
 *  CertRecoveryRequiredPayload in electron/services/certRecovery.ts — the
 *  renderer cannot import from electron/*, so the shape is re-declared here.
 *  Keep in sync with the canonical type in main. */
export type CertRecoveryRequest = {
  accountId: number
  host: string
  port: number
  /** Issuer common name, or '' when the enrichment probe failed. UNTRUSTED. */
  issuerCn: string
  /** Subject common name, or '' when the enrichment probe failed. UNTRUSTED. */
  subjectCn: string
  /** Normalized SHA-256 leaf fingerprint; '' when the probe failed. UNTRUSTED. */
  fingerprintSha256: string
  /** True = chain trusted by the OS store only (local AV / proxy interception). */
  systemOnly: boolean
  /** Raw IMAP/TLS error message — UNTRUSTED, display as text only. */
  rawMessage: string
}

/** Payload of the `cert:interceptionNotice` broadcast. UNTRUSTED fields. */
export type CertInterceptionNotice = {
  host: string
  issuerCn: string
}

/** Inline error surfaced inside the recovery dialog. Every value has a matching
 *  `app.certRecovery.error.<key>` string in all six locales. */
export type CertRecoveryErrorKey =
  /** Generic `net:trustCert` failure (unrecognized reason). */
  | 'trustFailed'
  /** The server no longer serves the certificate the dialog showed. */
  | 'trustFingerprintMismatch'
  /** The pin store refused / failed to persist the certificate. */
  | 'trustPinWriteFailed'
  /** The trust offer expired (this prompt outlived main's offer window) or was
   *  already used. Nothing can be confirmed here any more. */
  | 'trustNotOffered'
  | 'reprobeFailed'
  | 'dismissFailed'
  /** main no longer holds this endpoint in `awaiting-user`, so there is nothing
   *  left to dismiss — the prompt is stale. */
  | 'dismissNotPending'

/** Why the certificate details on screen differ from the broadcast payload.
 *  Drives the "check these values before confirming" block in the dialog; each
 *  value has an `app.certRecovery.review.<key>` string in all six locales. */
export type CertRecoveryReviewKey =
  /** The payload carried no fingerprint; these values were just read from the
   *  server and have not been confirmed by the user yet. */
  | 'fetched'
  /** main rejected the pin because the server now serves a DIFFERENT
   *  certificate; these values are the re-read current one. */
  | 'updated'

/** UI state layered on top of the current recovery request.
 *
 *  `fingerprint` / `issuerCn` / `subjectCn` are the values ON SCREEN and the
 *  only ones `trust()` may pin (invariant 5 above). They start from the
 *  broadcast payload and are replaced wholesale by a probe result. */
export type CertRecoveryDialogState = {
  request: CertRecoveryRequest
  /** SHA-256 fingerprint on screen — exactly what `net:trustCert` will pin.
   *  '' means "nothing to pin yet": the next confirm reads the certificate and
   *  only displays it. UNTRUSTED. */
  fingerprint: string
  /** Issuer common name on screen ('' → rendered as "unknown"). UNTRUSTED. */
  issuerCn: string
  /** Subject common name on screen ('' → row hidden). UNTRUSTED. */
  subjectCn: string
  /** Set when the on-screen certificate came from a probe rather than from the
   *  broadcast, i.e. the user still has to review and confirm it. */
  review: CertRecoveryReviewKey | null
  /** In-flight state of the trust() action (net:trustCert invoke). */
  trusting: boolean
  /** In-flight state of the fingerprint re-probe (tls:getServerCert invoke). */
  reprobing: boolean
  /** In-flight state of the dismiss() action (cert:dismiss invoke). */
  dismissing: boolean
  /** True once a re-probe was attempted and failed — Trust stays disabled. */
  reprobeFailed: boolean
  /** True once main told us this prompt no longer exists on its side (trust
   *  offer expired/consumed, or the endpoint is not awaiting an answer). The
   *  dialog is then a leftover: confirming is refused for good, so Trust is
   *  disabled and Cancel just closes it locally instead of invoking again. */
  stale: boolean
  /** Localized error to show inside the dialog (never a global error). */
  errorKey: CertRecoveryErrorKey | null
}

export interface UseCertRecoveryReturn {
  /** The recovery dialog to render, or null when the queue is empty. */
  dialog: CertRecoveryDialogState | null
  /** Active, not-yet-dismissed interception notices (host-deduplicated). */
  notices: CertInterceptionNotice[]
  /** Confirm the certificate CURRENTLY ON SCREEN via net:trustCert. When there
   *  is nothing on screen to pin (no fingerprint yet, or main rejected the last
   *  one as stale) this reads the certificate from the server, displays it, and
   *  stops — confirming the refreshed values needs a second, deliberate call.
   *  Closes the dialog on a successful pin; surfaces failures inline. */
  trust: () => Promise<void>
  /** Dismiss the recovery dialog: advances the queue only after `cert:dismiss`
   *  is acknowledged by main; a rejected invoke keeps the request on screen. */
  dismiss: () => Promise<void>
  /** Dismiss a single interception notice by host. */
  dismissNotice: (host: string) => void
}

// ---------------------------------------------------------------------------
// Untrusted-text hardening
// ---------------------------------------------------------------------------

/** C0/C1 control characters. Stripped after whitespace has been collapsed, so
 *  newlines/tabs degrade to a single space rather than gluing words together. */
// eslint-disable-next-line no-control-regex -- matching control characters is the entire purpose here
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g

/**
 * Invisible formatting characters: everything Unicode marks as
 * `Default_Ignorable_Code_Point` (bidi embeddings/overrides/isolates, LRM/RLM,
 * zero-width space/joiners, word joiner, the deprecated U+206A\u2013U+206F
 * formatting controls, variation selectors, Hangul fillers, tag characters,
 * BOM, soft hyphen\u2026) plus the remaining format category `Cf` (Arabic prepended
 * concatenation marks, which are outside Default_Ignorable).
 *
 * The user makes a security decision from what this dialog renders, so a
 * server-controlled string must not be able to reorder or hide any of it. The
 * set is taken from Unicode properties rather than a hand-written range list
 * precisely because a hand-written list goes stale \u2014 the previous version
 * covered the bidi controls but let U+206A\u2013U+206F and friends through
 * (codex-security-review 2026-07-25, LOW).
 *
 * Deliberately property-based and not "strip everything unusual": letters,
 * combining diacritics, CJK, ordinary spaces and punctuation are untouched, so
 * an issuer such as "\u041B\u0430\u0431\u043E\u0440\u0430\u0442\u043E\u0440\u0438\u044F \u041A\u0430\u0441\u043F\u0435\u0440\u0441\u043A\u043E\u0433\u043E" stays readable.
 */
const INVISIBLE_RE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu

/**
 * Normalize an UNTRUSTED server-supplied string for display: drop invisible
 * formatting characters, collapse whitespace runs, strip control characters,
 * trim, and bound the length (code-point aware, so a truncation never leaves a
 * lone surrogate).
 *
 * Pass order matters. Invisible formatting goes FIRST because some of those
 * characters (U+FEFF, U+180E…) also match `\s`: collapsing first would turn
 * them into a real space instead of removing them, letting a server inject
 * fake word breaks into an issuer CN. Control characters go after the collapse,
 * so a newline/tab degrades to a single space rather than gluing words
 * together, while a NUL simply disappears.
 *
 * Display-only. Never apply this to a value that is sent back over IPC — the
 * host and the fingerprint must reach `cert:dismiss` / `net:trustCert` byte
 * identical to what main broadcast, otherwise the pin or the awaiting-user slot
 * will not match.
 */
export function sanitizeUntrustedText(value: string, maxLength: number): string {
  const cleaned = value
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/g, ' ')
    .replace(CONTROL_RE, '')
    .trim()
  const chars = Array.from(cleaned)
  return chars.length > maxLength ? chars.slice(0, maxLength).join('') + '…' : cleaned
}

// ---------------------------------------------------------------------------
// cert IPC failure codes
// ---------------------------------------------------------------------------

/**
 * Machine-readable rejection codes thrown by the fail-closed `net:trustCert` /
 * `cert:dismiss` handlers in main, mapped to the inline error shown in the
 * dialog.
 *
 * Matched as a SUBSTRING, never by equality: Electron re-wraps a rejected
 * `invoke` into `Error invoking remote method '<channel>': Error: <code>`, so
 * the code arrives embedded in a longer message. Any unlisted reason keeps the
 * generic per-action fallback.
 */
const CERT_ERROR_CODES: ReadonlyArray<readonly [string, CertRecoveryErrorKey]> = [
  ['cert_trust_fingerprint_mismatch', 'trustFingerprintMismatch'],
  ['cert_trust_pin_write_failed', 'trustPinWriteFailed'],
  ['cert_trust_not_offered', 'trustNotOffered'],
  ['cert_dismiss_not_pending', 'dismissNotPending'],
]

/** Best-effort message extraction from an unknown rejection value. */
function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

/** Map a cert-IPC rejection to its inline error key, falling back to the
 *  action's generic message when the reason carries no known code. */
function certErrorKey(err: unknown, fallback: CertRecoveryErrorKey): CertRecoveryErrorKey {
  const message = errorMessage(err)
  for (const [code, key] of CERT_ERROR_CODES) {
    if (message.includes(code)) return key
  }
  return fallback
}

/** Map a `net:trustCert` rejection to its inline error key. */
export function trustErrorKey(err: unknown): CertRecoveryErrorKey {
  return certErrorKey(err, 'trustFailed')
}

/** Map a `cert:dismiss` rejection to its inline error key. */
export function dismissErrorKey(err: unknown): CertRecoveryErrorKey {
  return certErrorKey(err, 'dismissFailed')
}

/** Max displayed length of a host name (DNS limit). */
export const HOST_MAX = 255
/** Max displayed length of an issuer/subject common name. */
export const CN_MAX = 128

/** Runtime guard for an incoming cert:recoveryRequired payload. */
function parseRecovery(payload: unknown): CertRecoveryRequest | null {
  if (!payload || typeof payload !== 'object') return null
  const d = payload as Record<string, unknown>
  if (typeof d.accountId !== 'number') return null
  if (typeof d.host !== 'string' || d.host.length === 0) return null
  if (typeof d.port !== 'number') return null
  return {
    accountId: d.accountId,
    host: d.host,
    port: d.port,
    issuerCn: typeof d.issuerCn === 'string' ? d.issuerCn : '',
    subjectCn: typeof d.subjectCn === 'string' ? d.subjectCn : '',
    fingerprintSha256: typeof d.fingerprintSha256 === 'string' ? d.fingerprintSha256 : '',
    systemOnly: d.systemOnly === true,
    rawMessage: typeof d.rawMessage === 'string' ? d.rawMessage : '',
  }
}

/** Runtime guard for an incoming cert:interceptionNotice payload. Notices are
 *  display-only (their host is never sent back over IPC — `dismissNotice` is
 *  local state), so the untrusted fields are bounded right at ingest. */
function parseNotice(payload: unknown): CertInterceptionNotice | null {
  if (!payload || typeof payload !== 'object') return null
  const d = payload as Record<string, unknown>
  if (typeof d.host !== 'string' || d.host.length === 0) return null
  const host = sanitizeUntrustedText(d.host, HOST_MAX)
  if (!host) return null
  return {
    host,
    issuerCn: typeof d.issuerCn === 'string' ? sanitizeUntrustedText(d.issuerCn, CN_MAX) : '',
  }
}

/** Build the initial dialog state for a freshly-dequeued request. The on-screen
 *  certificate starts as the one main described in the broadcast. */
function initialDialog(request: CertRecoveryRequest): CertRecoveryDialogState {
  return {
    request,
    fingerprint: request.fingerprintSha256,
    issuerCn: request.issuerCn,
    subjectCn: request.subjectCn,
    review: null,
    trusting: false,
    reprobing: false,
    dismissing: false,
    reprobeFailed: false,
    stale: false,
    errorKey: null,
  }
}

/** Certificate identity read back from `tls:getServerCert`. UNTRUSTED. */
type ProbedCert = { fingerprint: string; issuerCn: string; subjectCn: string }

/**
 * Read the certificate an endpoint currently serves.
 *
 * Returns null when the probe answered without a usable fingerprint (there is
 * then nothing the user could review or pin). Rejections propagate to the
 * caller. The handler in main projects the CNs as `issuer` / `subject`.
 */
async function probeServerCert(host: string, port: number): Promise<ProbedCert | null> {
  const cert = await window.api.invoke<unknown>('tls:getServerCert', { host, port })
  if (!cert || typeof cert !== 'object') return null
  const d = cert as Record<string, unknown>
  const fingerprint = typeof d.fingerprintSha256 === 'string' ? d.fingerprintSha256 : ''
  if (!fingerprint) return null
  return {
    fingerprint,
    issuerCn: typeof d.issuer === 'string' ? d.issuer : '',
    subjectCn: typeof d.subject === 'string' ? d.subject : '',
  }
}

// ---------------------------------------------------------------------------
// Reducer — dialog + FIFO queue as one atomic unit
// ---------------------------------------------------------------------------

type RecoveryState = {
  /** The request currently on screen, or null when nothing is pending. */
  dialog: CertRecoveryDialogState | null
  /** Requests waiting behind the on-screen one, oldest first. */
  queue: CertRecoveryRequest[]
}

type RecoveryAction =
  | { type: 'enqueue'; request: CertRecoveryRequest }
  /** Resolve the on-screen request and promote the next queued one. Guarded by
   *  host so a stale async completion cannot drop somebody else's dialog. */
  | { type: 'advance'; host: string }
  | { type: 'patch'; host: string; patch: Partial<CertRecoveryDialogState> }

const EMPTY_STATE: RecoveryState = { dialog: null, queue: [] }

function recoveryReducer(state: RecoveryState, action: RecoveryAction): RecoveryState {
  switch (action.type) {
    case 'enqueue': {
      const { request } = action
      // Drop duplicates for a host already on screen or already queued.
      if (state.dialog?.request.host === request.host) return state
      if (state.queue.some(q => q.host === request.host)) return state
      // No dialog on screen → show immediately; otherwise queue behind it.
      // Because this runs inside the reducer, a second event in the SAME React
      // batch sees the dialog the first one just installed and queues instead
      // of overwriting it.
      if (!state.dialog) return { dialog: initialDialog(request), queue: state.queue }
      return { dialog: state.dialog, queue: [...state.queue, request] }
    }
    case 'advance': {
      if (state.dialog?.request.host !== action.host) return state
      const [next, ...rest] = state.queue
      return { dialog: next ? initialDialog(next) : null, queue: rest }
    }
    case 'patch': {
      if (!state.dialog || state.dialog.request.host !== action.host) return state
      return { dialog: { ...state.dialog, ...action.patch }, queue: state.queue }
    }
    /* v8 ignore next 2 -- exhaustive switch guard */
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Notices — separate reducer, same atomicity rationale as the dialog queue
// ---------------------------------------------------------------------------

type NoticeAction =
  | { type: 'add'; notice: CertInterceptionNotice }
  | { type: 'remove'; host: string }

const EMPTY_NOTICES: CertInterceptionNotice[] = []

function noticesReducer(state: CertInterceptionNotice[], action: NoticeAction): CertInterceptionNotice[] {
  switch (action.type) {
    case 'add':
      return state.some(n => n.host === action.notice.host) ? state : [...state, action.notice]
    case 'remove':
      return state.filter(n => n.host !== action.host)
    /* v8 ignore next 2 -- exhaustive switch guard */
    default:
      return state
  }
}

export function useCertRecovery(): UseCertRecoveryReturn {
  const [state, dispatch] = useReducer(recoveryReducer, EMPTY_STATE)
  const [notices, dispatchNotices] = useReducer(noticesReducer, EMPTY_NOTICES)

  // Ref lets the async trust/dismiss callbacks read the live dialog without
  // being re-created on every state change.
  const stateRef = useRef<RecoveryState>(state)
  stateRef.current = state

  // Synchronous re-entry latch: `trusting` / `dismissing` only become visible
  // after a render, so two clicks in the same tick would both pass the flag
  // check. This ref is written before any await.
  const inFlightRef = useRef(false)

  // Subscribe once. Handlers only call the stable dispatchers, so no re-sub.
  useEffect(() => {
    const onRecovery = (payload: unknown) => {
      const request = parseRecovery(payload)
      if (!request) return
      dispatch({ type: 'enqueue', request })
    }
    const onNotice = (payload: unknown) => {
      const notice = parseNotice(payload)
      if (!notice) return
      dispatchNotices({ type: 'add', notice })
    }
    window.api?.on('cert:recoveryRequired', onRecovery)
    window.api?.on('cert:interceptionNotice', onNotice)
    return () => {
      window.api?.off('cert:recoveryRequired', onRecovery)
      window.api?.off('cert:interceptionNotice', onNotice)
    }
  }, [])

  /**
   * Read the certificate the endpoint currently serves and PUT IT ON SCREEN.
   *
   * Never pins: the caller returns right after, so the user reviews the new
   * fingerprint/issuer/subject and confirms them with a separate click
   * (invariant 5 — what-you-see-is-what-you-pin). `failureErrorKey` is the
   * inline message shown when the probe cannot produce a certificate; Trust
   * then stays disabled because there is nothing displayed to confirm.
   */
  const showProbedCert = useCallback(async (
    host: string,
    port: number,
    review: CertRecoveryReviewKey,
    failureErrorKey: CertRecoveryErrorKey,
  ): Promise<void> => {
    dispatch({ type: 'patch', host, patch: { reprobing: true } })
    try {
      const probed = await probeServerCert(host, port)
      if (!probed) {
        dispatch({ type: 'patch', host, patch: { reprobing: false, reprobeFailed: true, errorKey: failureErrorKey } })
        return
      }
      dispatch({
        type: 'patch',
        host,
        patch: {
          reprobing: false,
          reprobeFailed: false,
          fingerprint: probed.fingerprint,
          issuerCn: probed.issuerCn,
          subjectCn: probed.subjectCn,
          review,
          errorKey: null,
        },
      })
    } catch (err) {
      captureException(err, { source: 'useCertRecovery.reprobe' })
      dispatch({ type: 'patch', host, patch: { reprobing: false, reprobeFailed: true, errorKey: failureErrorKey } })
    }
  }, [])

  const trust = useCallback(async () => {
    const current = stateRef.current.dialog
    if (!current || inFlightRef.current) return
    if (current.trusting || current.reprobing || current.dismissing) return
    // main already told us this prompt is gone on its side: every further
    // confirm is refused for the same reason. The button is disabled for this
    // state; the guard keeps a programmatic call from re-invoking pointlessly.
    if (current.stale) return
    const { request } = current
    const host = request.host
    inFlightRef.current = true
    try {
      // Nothing on screen to pin (the broadcast arrived without a fingerprint
      // because main's enrichment probe failed). Read the certificate and show
      // it — pinning a value the user has never seen would defeat the whole
      // point of this confirmation dialog.
      if (!current.fingerprint) {
        await showProbedCert(host, request.port, 'fetched', 'reprobeFailed')
        return
      }

      // main re-probes the endpoint to capture the certificate body before it
      // pins (up to ~12s), so this invoke can stay in flight noticeably longer
      // than a plain DB write. `trusting` keeps both dialog buttons disabled
      // for the whole window.
      dispatch({ type: 'patch', host, patch: { trusting: true, errorKey: null } })
      try {
        // Exactly the fingerprint rendered in the dialog — never a probe result
        // obtained inside this same call.
        await window.api.invoke('net:trustCert', {
          accountId: request.accountId,
          host,
          port: request.port,
          fingerprintSha256: current.fingerprint,
        })
        dispatch({ type: 'advance', host })
      } catch (err) {
        captureException(err, { source: 'useCertRecovery.trust' })
        const errorKey = trustErrorKey(err)
        // Surface inside the dialog, not as a global error — the user can retry.
        if (errorKey !== 'trustFingerprintMismatch') {
          // …except when main says the offer is gone (expired or already used):
          // retrying is guaranteed to fail, so mark the prompt stale and let the
          // dialog disable confirmation instead of inviting another dead click.
          dispatch({
            type: 'patch',
            host,
            patch: { trusting: false, errorKey, stale: errorKey === 'trustNotOffered' },
          })
          return
        }
        // The server no longer serves what the dialog showed. Drop the whole
        // stale identity (a fingerprint-less dialog still displaying the old
        // issuer would misrepresent what is being confirmed), then re-read the
        // endpoint and display the result. The refreshed certificate is NOT
        // pinned here: it becomes the new on-screen value that the user has to
        // look at and confirm explicitly, so a mid-flow certificate swap cannot
        // turn this protective rejection into a one-click blind approval.
        dispatch({
          type: 'patch',
          host,
          patch: {
            trusting: false,
            errorKey: null,
            fingerprint: '',
            issuerCn: '',
            subjectCn: '',
            review: null,
            reprobeFailed: false,
          },
        })
        await showProbedCert(host, request.port, 'updated', 'trustFingerprintMismatch')
      }
    } finally {
      inFlightRef.current = false
    }
  }, [showProbedCert])

  const dismiss = useCallback(async () => {
    const current = stateRef.current.dialog
    if (!current || inFlightRef.current) return
    if (current.trusting || current.reprobing || current.dismissing) return
    const host = current.request.host
    // A prompt main no longer knows about has nothing to acknowledge: invoking
    // again would just reproduce the same rejection and trap the user behind a
    // dialog that cannot be closed. Retire it locally instead.
    if (current.stale) {
      dispatch({ type: 'advance', host })
      return
    }
    inFlightRef.current = true
    dispatch({ type: 'patch', host, patch: { dismissing: true, errorKey: null } })
    try {
      // Advance ONLY after main acknowledged: on rejection the host stays in
      // `awaiting-user` on the main side, so closing the dialog here would burn
      // the only notification the user gets for this host this session.
      await window.api.invoke('cert:dismiss', { host })
      dispatch({ type: 'advance', host })
    } catch (err) {
      captureException(err, { source: 'useCertRecovery.dismiss' })
      const errorKey = dismissErrorKey(err)
      // `dismissNotPending` is the exception to the rule above: main is NOT
      // holding the endpoint, so there is no prompt left to preserve. Keep the
      // dialog for one beat to explain why, and mark it stale so the next click
      // closes it without another doomed round-trip.
      dispatch({
        type: 'patch',
        host,
        patch: { dismissing: false, errorKey, stale: errorKey === 'dismissNotPending' },
      })
    } finally {
      inFlightRef.current = false
    }
  }, [])

  const dismissNotice = useCallback((host: string) => {
    dispatchNotices({ type: 'remove', host })
  }, [])

  return { dialog: state.dialog, notices, trust, dismiss, dismissNotice }
}
