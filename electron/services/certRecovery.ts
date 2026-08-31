/**
 * TLS certificate recovery + interception-notice service (TLS trust rework,
 * Phase A2).
 *
 * Owns the main-process UX policy for certificate trust failures reported by
 * packages/net (Phase A1 seam — `registerCertErrorHandler`). packages/net
 * deliberately fires the handler on EVERY cert-failed operation with no
 * dedup; the storm-guard lives here:
 *
 *   - Single-flight per ENDPOINT (`host:port`, host lowercased): while an
 *     enrichment probe is in flight or the recovery dialog is awaiting the
 *     user, further cert errors for the same endpoint are swallowed.
 *   - Debounce after resolution: after the user trusts the certificate
 *     (`net:trustCert`) or dismisses the dialog (`cert:dismiss`), the
 *     endpoint becomes eligible for a new `cert:recoveryRequired` broadcast
 *     only after CERT_REDELIVERY_DEBOUNCE_MS.
 *
 * The guard key is the endpoint, not the bare host, for two reasons: a host
 * spelled with different case must not produce two dialogs, and IMAP 993 /
 * SMTP 465 on one hostname are DIFFERENT endpoints that must not silence
 * each other. `markTrusted` / `dismiss` accept an optional port: without it
 * (the renderer's `cert:dismiss` payload carries only the host) every pending
 * endpoint of that host is resolved.
 *
 * Second responsibility — the one-time "local TLS interception" notice:
 * after the FIRST successful sync of an account in a session, probe the
 * IMAP endpoint via `verifyCertTrust`. If the chain verifies against the
 * OS system store but NOT against the bundled Mozilla roots
 * (`verdict === 'system-only'` — the signature of an antivirus /
 * corporate-proxy MITM root), broadcast `cert:interceptionNotice` so the
 * renderer can show an informational banner.
 *
 * Deliberate simplification (persistence): the interception check runs at
 * most ONCE per host for the lifetime of the profile — the host is persisted
 * via the injected `persistNoticeShownHosts` seam for both PROVEN verdicts
 * (system-only and not). A later change of verdict (e.g. the user installs an
 * intercepting antivirus after the first check) is only caught after a manual
 * reset of the persisted list. A verdict whose probes did not all identify
 * their certificate (`evidence: 'partial'`) is shown but never persisted —
 * see the subscriber contract on `CertTrustReport.evidence`.
 *
 * Conclusiveness is load-bearing (codex fix wave): a probe that failed on
 * transport, saw a rotated certificate, or found no CA reference set returns
 * `conclusive: false`. Such a report is NEVER persisted, NEVER claims
 * interception, and — crucially — never marks the host/account as "checked":
 * the account is put back into the retry pool (behind
 * CERT_INTERCEPTION_RETRY_COOLDOWN_MS) so a later successful sync re-probes.
 * The same applies when the broadcast reached ZERO renderer windows: an
 * undelivered notice must not be recorded as shown.
 *
 * TRUST OFFER — the authorization gate for creating a TLS trust anchor.
 *
 * Storing a pinned certificate's PEM turns it into an OpenSSL trust anchor
 * (`buildTlsOptions` builds it into the shared `SecureContext` it hands the
 * transport). That is the power to grant trust, so
 * it may not be exercised on the renderer's say-so: the renderer parses email,
 * i.e. compromise is inside the threat model. Re-probing the endpoint at pin
 * time proves "the server currently serves this certificate" — it does NOT
 * prove "the user saw it and agreed", which under active interception is the
 * only thing that matters.
 *
 * The proof is therefore main's OWN state, never a value the renderer supplies:
 * a token round-tripped through the renderer would be readable by a
 * compromised renderer (it receives the broadcast that carries it) and would
 * prove nothing. When — and only when — this service actually DELIVERS a
 * `cert:recoveryRequired` dialog, it records an offer bound to
 * (accountId, endpoint, fingerprint). `peekTrustOffer` authorizes exactly that
 * triple, once, within CERT_TRUST_OFFER_TTL_MS.
 *
 * A blank fingerprint authorizes NOTHING. An earlier revision let it authorize
 * any fingerprint for the endpoint, reasoning that a compromised renderer
 * cannot manufacture a dialog. That reasoning was wrong, because the two
 * conditions are not independent: the fingerprint is blank exactly when the
 * enrichment probe failed, and the network attacker whose interception raised
 * the certificate error is the same party who can make that probe fail — by
 * dropping it. The blank state was therefore attacker-selectable, and the
 * renderer could then pin the attacker's certificate.
 *
 * The blank slot is filled only by main HANDING A FINGERPRINT TO THE DIALOG:
 * when the renderer re-probes through `tls:getServerCert`, main knows what it
 * just returned and records it via `noteProbedFingerprint` — but only for an
 * endpoint that already has an open offer, and only into a still-empty slot
 * (the dialog asks for a fingerprint exactly once — when it has none — so a
 * later probe is not the dialog updating its display, it is someone trying to
 * move the target after the user has seen it).
 *
 * Net invariant: a pin can only ever be created for a certificate main itself
 * displayed to the user, for the account and endpoint main itself flagged.
 *
 * What the offer does NOT prove: that a human agreed. Every field of an offer
 * is known to the renderer — main broadcast them in `cert:recoveryRequired`
 * — so a compromised renderer can satisfy `peekTrustOffer` by replaying its own
 * payload without showing anything to anyone. The human half of the proof is
 * gate 5 in `electron/main.ts` (`confirmCertTrustNatively`): a native
 * `dialog.showMessageBox`, drawn by the OS and naming the fingerprint, which
 * the renderer cannot script or pre-answer. The offer says "main flagged this
 * endpoint and put this certificate on screen"; the native confirmation says
 * "a person looked at it and agreed". A pin needs both.
 *
 * Error containment: nothing in this service may propagate into the sync /
 * retry paths. Every entry point is wrapped; failures are logged via
 * createLogger('CertRecovery') and reported via captureException with
 * PII-safe context (host / issuer CN are operator-configured server
 * identities and are allowed; email addresses and raw error text are not).
 */

import { createLogger } from '../logger'
import { captureException } from '../sentry'
import type { CertErrorPayload } from '../../packages/net/imap'
import { unknownCertTrust, type CertProbeTransport, type CertTrustReport } from '../../packages/net/tls'

const log = createLogger('CertRecovery')

/** Minimum quiet period after a user resolution (trust or dismiss) before the
 *  same endpoint may trigger a new `cert:recoveryRequired` broadcast. */
export const CERT_REDELIVERY_DEBOUNCE_MS = 60_000

/**
 * How long a delivered recovery dialog stays answerable.
 *
 * Generous on purpose — the dialog may sit on screen while the user walks away
 * — but finite: an offer that outlives the session's relevance would let a
 * later compromised renderer redeem a dialog the user has long forgotten. On
 * expiry the click fails and the next certificate error raises a fresh dialog.
 */
export const CERT_TRUST_OFFER_TTL_MS = 30 * 60_000

/** Quiet period before an inconclusive / undelivered interception check is
 *  retried. Without it, an endpoint whose diagnostic probe keeps failing on
 *  transport would open three TLS probe connections after every successful
 *  sync of every account on that host. */
export const CERT_INTERCEPTION_RETRY_COOLDOWN_MS = 15 * 60_000

/** Canonical host form used for guard keys and comparison: trimmed,
 *  lowercased, trailing DNS root dot removed. Case differences between the
 *  account config, the server banner and the renderer echo must not create
 *  two independent guard slots. */
export function normalizeCertHost(host: string): string {
  return (host || '').trim().toLowerCase().replace(/\.+$/, '')
}

/** Storm-guard key: an endpoint is (host, port), never the bare host. */
function endpointKey(host: string, port: number): string {
  return `${normalizeCertHost(host)}:${port}`
}

/** Separator-insensitive fingerprint form for comparison only (never stored):
 *  the value shown in the dialog and the value echoed back may differ in
 *  grouping (`AA:BB` vs `aabb`) without being different certificates. */
function canonicalFingerprint(fp: string): string {
  return (fp || '').replace(/[:\-\s]/g, '').toUpperCase()
}

/** Payload of the `cert:recoveryRequired` broadcast (renderer contract, Phase A3). */
export type CertRecoveryRequiredPayload = {
  accountId: number
  host: string
  port: number
  /** '' when the enrichment probe failed (best-effort). */
  issuerCn: string
  /** '' when the enrichment probe failed. */
  subjectCn: string
  /** Normalized SHA-256 leaf fingerprint; '' when the probe failed. */
  fingerprintSha256: string
  /** True = chain trusted by OS store only (local interception signature). */
  systemOnly: boolean
  /** Raw IMAP/TLS error message — untrusted display-only string. */
  rawMessage: string
}

/** Payload of the `cert:interceptionNotice` broadcast (renderer contract, Phase A3). */
export type CertInterceptionNoticePayload = {
  host: string
  issuerCn: string
}

export type CertRecoveryDeps = {
  /** packages/net/imap seam — per-account cert-error subscription. */
  registerCertErrorHandler: (accountId: number, handler: (p: CertErrorPayload) => void) => void
  unregisterCertErrorHandler: (accountId: number) => void
  /** packages/net/tls diagnostic probe (never used on the data channel).
   *  The transport argument is REQUIRED for correctness on STARTTLS endpoints
   *  (143/587): probing them as implicit TLS yields a transport failure on a
   *  perfectly healthy server. */
  verifyCertTrust: (
    host: string,
    port: number,
    transport?: CertProbeTransport,
  ) => Promise<CertTrustReport>
  /** main.ts broadcast() — sends to all renderer windows and returns how many
   *  actually received the message. Zero means the UX never happened, so the
   *  caller must not record the host as notified. */
  broadcast: (
    channel: 'cert:recoveryRequired' | 'cert:interceptionNotice',
    payload: CertRecoveryRequiredPayload | CertInterceptionNoticePayload,
  ) => number
  /** Typed telemetry adapter (electron/metrics recordEvent). */
  recordEvent: (
    name: 'cert.recovery_dialog_shown' | 'cert.interception_notice_shown',
    tags: { provider: string },
  ) => void
  /** Host → low-cardinality provider enum (electron/metrics providerFromHost). */
  providerFromHost: (host: string) => string
  /** Resolve the IMAP endpoint of an account (null when config unavailable).
   *  `secure === false` means the port speaks STARTTLS — the probe needs it. */
  getAccountImapEndpoint: (
    accountId: number,
  ) => Promise<{ host: string; port: number; secure?: boolean } | null>
  /** Persisted set of hosts for which the interception check already ran. */
  loadNoticeShownHosts: () => string[]
  persistNoticeShownHosts: (hosts: string[]) => void
  /** Clock override for tests. */
  now?: () => number
}

export type CertRecoveryService = {
  /** Subscribe an account to cert-error notifications. Idempotent — safe to
   *  call on every config load (requireAccountConfig). */
  ensureAccountRegistered: (accountId: number) => void
  /** Remove the subscription (account deletion). Idempotent. */
  unregisterAccount: (accountId: number) => void
  /** Report a successful header sync — triggers the one-time interception
   *  check for the account's IMAP host. Fire-and-forget, never throws. */
  noteSyncSuccess: (accountId: number) => void
  /**
   * Record the fingerprint main just handed to an open dialog (the renderer
   * re-probed via `tls:getServerCert` because the broadcast carried none).
   *
   * Fill-once, and only for an endpoint that already has an open offer: this
   * is what turns "the dialog is showing something" into a value main can hold
   * the later confirmation against. A probe for any other endpoint, a blank
   * result, or a slot that is already filled changes nothing.
   */
  noteProbedFingerprint: (host: string, port: number, fingerprintSha256: string) => void
  /**
   * Validate a pending trust offer WITHOUT consuming it (net:trustCert
   * pre-check). See the "TRUST OFFER" section of the module JSDoc: this is the
   * authorization gate for creating a TLS trust anchor.
   *
   * Peek-then-consume, not consume-up-front, so a failed pin write leaves the
   * offer intact and the user can retry the same dialog.
   */
  peekTrustOffer: (
    accountId: number,
    host: string,
    port: number,
    fingerprintSha256: string,
  ) => TrustOfferCheck
  /** Burn the offer after the pin was actually stored: clears the dialog slot
   *  and starts the re-delivery debounce. One-time by construction. */
  consumeTrustOffer: (accountId: number, host: string, port: number) => void
  /**
   * User dismissed the recovery dialog (cert:dismiss). Returns `false` when
   * nothing was pending for that endpoint — the caller must reject, otherwise
   * a renderer can pre-arm the debounce for an endpoint whose warning has not
   * happened yet and silence it.
   *
   * A dismiss inside the debounce window of an already-resolved endpoint
   * returns `true` (the renderer RETRIES after a failed IPC round-trip and
   * that retry must stay idempotent).
   */
  dismiss: (host: string, port?: number) => boolean
}

/** Result of `peekTrustOffer`. Only `ok` authorizes a pin. */
export type TrustOfferCheck =
  /** main showed this exact certificate, for this account and endpoint, and is
   *  awaiting an answer. */
  | 'ok'
  /**
   * Nothing redeemable here: no dialog was shown for this endpoint, it was
   * already answered, it expired, it belongs to a different account, or main
   * never managed to show a fingerprint at all (nothing was confirmed, so
   * there is nothing to authorize).
   */
  | 'no-offer'
  /** A dialog is pending, but for a DIFFERENT certificate than the one being pinned. */
  | 'fingerprint-mismatch'

/** Extract a PII-safe error identifier: Node error code when present
 *  ('ECONNREFUSED', 'CERT_HAS_EXPIRED', ...), otherwise 'unknown'. Never the
 *  raw message (server strings can echo user/host free text). */
function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : 'unknown'
}

export function initCertRecovery(deps: CertRecoveryDeps): CertRecoveryService {
  const now = deps.now ?? Date.now

  /**
   * Endpoint (`host:port`) storm-guard state. Present key = broadcast in
   * flight or dialog awaiting the user; absent = eligible (subject to the
   * debounce below).
   *
   * The trust offer lives INSIDE the `awaiting-user` state rather than in a
   * parallel map, so "a dialog is on screen" and "a pin is authorized" cannot
   * drift apart: one write creates both, one delete revokes both.
   */
  type EndpointState =
    | { phase: 'inflight' }
    | {
        phase: 'awaiting-user'
        /** Account the dialog was raised for — an offer is not transferable
         *  between accounts that happen to share a mail host. */
        accountId: number
        /** Certificate main displayed; '' until a probe fills it in. */
        fingerprint: string
        offeredAt: number
      }
  const hostPhase = new Map<string, EndpointState>()
  /** Endpoint → timestamp of the last user resolution (trust or dismiss). */
  const hostResolvedAt = new Map<string, number>()
  /** Accounts already subscribed to the packages/net cert-error registry. */
  const registeredAccounts = new Set<number>()
  /** Accounts whose first successful sync has already been observed. */
  const syncSuccessSeen = new Set<number>()
  /** Hosts whose interception check ran (or is running) and has not yet been
   *  handed over to the persisted list. */
  const noticeCheckedHosts = new Set<string>()
  /** Host → earliest timestamp at which an inconclusive / undelivered
   *  interception check may be retried. */
  const interceptionRetryAt = new Map<string, number>()

  /** Lazy GC for `hostResolvedAt`: a timestamp older than the debounce window
   *  can no longer suppress anything. Without eviction the map grows for the
   *  whole session (one entry per endpoint that ever failed). */
  function pruneResolved(): void {
    const t = now()
    for (const [key, at] of hostResolvedAt) {
      if (t - at >= CERT_REDELIVERY_DEBOUNCE_MS) hostResolvedAt.delete(key)
    }
  }

  /** Lazy GC for the interception retry cooldowns (same rationale). */
  function pruneInterceptionCooldowns(): void {
    const t = now()
    for (const [host, until] of interceptionRetryAt) {
      if (t >= until) interceptionRetryAt.delete(host)
    }
  }

  /** Mark one endpoint as resolved by the user. Idempotent: a repeated
   *  resolution inside the debounce window (the renderer retries
   *  `cert:dismiss` after a failed IPC round-trip) neither throws nor extends
   *  the quiet period. */
  function resolveEndpoint(key: string): void {
    hostPhase.delete(key)
    const prev = hostResolvedAt.get(key)
    if (prev !== undefined && now() - prev < CERT_REDELIVERY_DEBOUNCE_MS) return
    hostResolvedAt.set(key, now())
  }

  /** Endpoint keys of a host, across both the pending and the resolved maps.
   *  Compares the host PART of the key, not a string prefix: the port is the
   *  trailing `:<digits>`, and a bare-IPv6 host would make prefix matching
   *  ambiguous. */
  function keysForHost(host: string): string[] {
    const wanted = normalizeCertHost(host)
    const sameHost = (key: string) => key.slice(0, key.lastIndexOf(':')) === wanted
    const keys = new Set<string>()
    for (const key of hostPhase.keys()) if (sameHost(key)) keys.add(key)
    for (const key of hostResolvedAt.keys()) if (sameHost(key)) keys.add(key)
    return [...keys]
  }

  /** True when this endpoint is showing a dialog right now. */
  function isAwaitingUser(key: string): boolean {
    return hostPhase.get(key)?.phase === 'awaiting-user'
  }

  /** True when the user answered this endpoint recently — the window in which
   *  a retried `cert:dismiss` must still be accepted as a no-op. */
  function isRecentlyResolved(key: string): boolean {
    const at = hostResolvedAt.get(key)
    return at !== undefined && now() - at < CERT_REDELIVERY_DEBOUNCE_MS
  }

  /**
   * Resolve a dismiss that may or may not carry a port. Returns false when
   * nothing was pending: without that check a renderer could POST a dismiss
   * for an endpoint whose warning has not happened yet and pre-arm the
   * debounce, suppressing the dialog the user is supposed to see.
   */
  function resolveDismiss(host: string, port?: number): boolean {
    pruneResolved()
    const keys = typeof port === 'number' && Number.isFinite(port)
      ? [endpointKey(host, port)]
      : keysForHost(host)
    const pending = keys.filter(isAwaitingUser)
    if (pending.length > 0) {
      for (const key of pending) resolveEndpoint(key)
      return true
    }
    // Idempotent retry of an already-accepted dismiss.
    return keys.some(isRecentlyResolved)
  }

  async function enrichAndBroadcast(accountId: number, p: CertErrorPayload): Promise<void> {
    const key = endpointKey(p.host, p.port)
    const host = normalizeCertHost(p.host)
    // Best-effort enrichment: if the diagnostic probe cannot connect (server
    // down, network flap between the failed op and now), fall back to an
    // explicitly inconclusive report with empty identity fields.
    let report: CertTrustReport
    try {
      // Transport MUST be forwarded: a STARTTLS endpoint (143/587) probed as
      // implicit TLS reports a transport failure on a healthy server.
      report = await deps.verifyCertTrust(p.host, p.port, {
        secure: p.secure,
        protocol: p.protocol,
      })
    } catch (probeErr) {
      report = unknownCertTrust()
      log.warn('cert trust probe failed, broadcasting bare payload', {
        host,
        port: p.port,
        code: errCode(probeErr),
      })
    }
    if (!report.conclusive) {
      log.warn('cert trust probe inconclusive, dialog claims no interception', {
        host,
        port: p.port,
        reason: report.inconclusiveReason ?? 'unknown',
      })
    }
    try {
      const payload: CertRecoveryRequiredPayload = {
        accountId,
        host: p.host,
        port: p.port,
        issuerCn: report.issuerCn,
        subjectCn: report.subjectCn,
        fingerprintSha256: report.fingerprintSha256,
        // Interception may be claimed ONLY on a conclusive verdict: a probe
        // that failed on transport says nothing about the trust chain.
        systemOnly: report.conclusive && report.systemOnly,
        rawMessage: p.rawMessage,
      }
      const recipients = deps.broadcast('cert:recoveryRequired', payload)
      if (recipients <= 0) {
        // Nobody received the dialog — the slot must stay open, otherwise the
        // endpoint is stuck in 'awaiting-user' for a dialog that never showed
        // and the user is never told why sync is failing.
        hostPhase.delete(key)
        log.warn('cert recovery broadcast reached no window, will retry', { host, port: p.port })
        return
      }
      // Dialog-shown telemetry lives here (not in the renderer) so Phase A3
      // cannot forget to emit it. Fire-and-forget.
      try {
        deps.recordEvent('cert.recovery_dialog_shown', { provider: deps.providerFromHost(p.host) })
      } catch { /* telemetry must never affect the recovery flow */ }
      // The dialog reached a window: from here the user may authorize a pin
      // for THIS account, THIS endpoint and THIS certificate, and nothing else
      // (see the "TRUST OFFER" section of the module JSDoc). A blank
      // fingerprint authorizes nothing until a probe served by main fills it.
      hostPhase.set(key, {
        phase: 'awaiting-user',
        accountId,
        fingerprint: canonicalFingerprint(report.fingerprintSha256),
        offeredAt: now(),
      })
    } catch (err) {
      // Broadcast failed — release the single-flight slot so a later cert
      // error can retry surfacing the dialog.
      hostPhase.delete(key)
      log.error('failed to broadcast cert recovery event', { host, code: errCode(err) })
      captureException(err, { source: 'cert_recovery', step: 'broadcast', host })
    }
  }

  function onCertError(accountId: number, p: CertErrorPayload): void {
    try {
      const key = endpointKey(p.host, p.port)
      // Single-flight: probe in progress or dialog already on screen.
      if (hostPhase.has(key)) return
      pruneResolved()
      // Debounce: recently resolved by the user — do not re-nag immediately
      // (the triggered resync may hit the same failure within seconds).
      const resolvedAt = hostResolvedAt.get(key)
      if (resolvedAt !== undefined && now() - resolvedAt < CERT_REDELIVERY_DEBOUNCE_MS) return
      hostPhase.set(key, { phase: 'inflight' })
      void enrichAndBroadcast(accountId, p)
    } catch (err) {
      log.error('cert error handling failed', { accountId, code: errCode(err) })
      captureException(err, { source: 'cert_recovery', step: 'on_cert_error', accountId })
    }
  }

  /** Put an account/host back into the interception retry pool: the check
   *  produced no trustworthy, delivered verdict, so nothing may be recorded.
   *  A later successful sync re-runs it once the cooldown elapses. */
  function scheduleInterceptionRetry(accountId: number, host: string): void {
    noticeCheckedHosts.delete(host)
    syncSuccessSeen.delete(accountId)
    interceptionRetryAt.set(host, now() + CERT_INTERCEPTION_RETRY_COOLDOWN_MS)
  }

  async function runInterceptionCheck(accountId: number): Promise<void> {
    const ep = await deps.getAccountImapEndpoint(accountId)
    if (!ep) return
    const host = normalizeCertHost(ep.host)
    pruneInterceptionCooldowns()
    const retryAt = interceptionRetryAt.get(host)
    if (retryAt !== undefined && now() < retryAt) {
      // Still cooling down; keep the account eligible for a later attempt.
      syncSuccessSeen.delete(accountId)
      return
    }
    // Session-level host dedup: two accounts on the same IMAP host must not
    // race two concurrent probes / double notices before persistence lands.
    if (noticeCheckedHosts.has(host)) return
    noticeCheckedHosts.add(host)
    const alreadyShown = deps.loadNoticeShownHosts().map(normalizeCertHost)
    if (alreadyShown.includes(host)) return
    let report: CertTrustReport
    try {
      report = await deps.verifyCertTrust(ep.host, ep.port, {
        secure: ep.secure,
        protocol: 'imap',
      })
    } catch (probeErr) {
      // Probe failure is not a verdict — do NOT persist, retry later.
      scheduleInterceptionRetry(accountId, host)
      log.warn('interception probe failed, will retry later', {
        host,
        port: ep.port,
        code: errCode(probeErr),
      })
      return
    }
    if (!report.conclusive) {
      // Same rule as a thrown probe: an inconclusive report is not a verdict
      // and must never be persisted as one.
      scheduleInterceptionRetry(accountId, host)
      log.warn('interception probe inconclusive, will retry later', {
        host,
        port: ep.port,
        reason: report.inconclusiveReason ?? 'unknown',
      })
      return
    }
    // packages/net subscriber contract (CertTrustReport.evidence): the two
    // decisions below must NOT share a predicate. SHOWING the warning ignores
    // evidence strength — a false alarm is cheaper than a missed interception.
    if (report.verdict === 'system-only') {
      const payload: CertInterceptionNoticePayload = { host: ep.host, issuerCn: report.issuerCn }
      const recipients = deps.broadcast('cert:interceptionNotice', payload)
      if (recipients <= 0) {
        // The banner never reached a window — recording the host as notified
        // would silently drop the one notice this profile ever gets.
        scheduleInterceptionRetry(accountId, host)
        log.warn('interception notice reached no window, will retry later', { host })
        return
      }
      try {
        deps.recordEvent('cert.interception_notice_shown', { provider: deps.providerFromHost(ep.host) })
      } catch { /* telemetry must never affect the notice flow */ }
    }
    // PERSISTING the "already checked" state is the other half of that
    // contract and is strictly narrower: a 'partial' verdict must never become
    // permanent, or an attacker who wins the probe race ONCE silences this
    // host's warning for the lifetime of the profile. Partial results simply
    // retry later.
    if (report.evidence !== 'proven') {
      scheduleInterceptionRetry(accountId, host)
      log.info('interception verdict is partial, not persisting; will re-check later', {
        host,
        verdict: report.verdict,
      })
      return
    }
    // Persist for BOTH proven verdicts — one probe per host per profile
    // lifetime (see the "Deliberate simplification" note in the module JSDoc).
    try {
      deps.persistNoticeShownHosts([...deps.loadNoticeShownHosts(), host])
      // The persisted list is now the guard; drop the in-memory duplicate so
      // the session-scoped set stays bounded by unpersisted hosts only.
      noticeCheckedHosts.delete(host)
    } catch (persistErr) {
      // Keep the host in noticeCheckedHosts: persistence failed, so the
      // in-memory set is the only thing preventing a duplicate notice.
      log.warn('failed to persist interception-notice host', {
        host,
        code: errCode(persistErr),
      })
    }
  }

  return {
    ensureAccountRegistered(accountId: number): void {
      try {
        if (registeredAccounts.has(accountId)) return
        registeredAccounts.add(accountId)
        deps.registerCertErrorHandler(accountId, (p) => onCertError(accountId, p))
      } catch (err) {
        registeredAccounts.delete(accountId)
        log.error('failed to register cert error handler', { accountId, code: errCode(err) })
        captureException(err, { source: 'cert_recovery', step: 'register', accountId })
      }
    },

    unregisterAccount(accountId: number): void {
      try {
        registeredAccounts.delete(accountId)
        syncSuccessSeen.delete(accountId)
        deps.unregisterCertErrorHandler(accountId)
      } catch (err) {
        log.error('failed to unregister cert error handler', { accountId, code: errCode(err) })
        captureException(err, { source: 'cert_recovery', step: 'unregister', accountId })
      }
    },

    noteSyncSuccess(accountId: number): void {
      try {
        if (syncSuccessSeen.has(accountId)) return
        syncSuccessSeen.add(accountId)
        runInterceptionCheck(accountId).catch((err) => {
          log.error('interception check failed', { accountId, code: errCode(err) })
          captureException(err, { source: 'cert_recovery', step: 'interception_check', accountId })
        })
      } catch (err) {
        log.error('noteSyncSuccess failed', { accountId, code: errCode(err) })
        captureException(err, { source: 'cert_recovery', step: 'note_sync_success', accountId })
      }
    },

    noteProbedFingerprint(host: string, port: number, fingerprintSha256: string): void {
      const key = endpointKey(host, port)
      const state = hostPhase.get(key)
      // No open dialog for this endpoint → a probe authorizes nothing. This is
      // what keeps `tls:getServerCert` (callable for ANY address) from being a
      // way to mint authorization.
      if (!state || state.phase !== 'awaiting-user') return
      if (now() - state.offeredAt >= CERT_TRUST_OFFER_TTL_MS) return
      const fingerprint = canonicalFingerprint(fingerprintSha256)
      // Nothing to show → nothing to confirm.
      if (!fingerprint) return
      // Fill-once. The dialog requests a fingerprint only while it has none,
      // so a probe arriving after the slot is filled is not the dialog
      // refreshing its display — it is an attempt to move the target after the
      // user has already seen a value.
      if (state.fingerprint) return
      hostPhase.set(key, { ...state, fingerprint })
    },

    peekTrustOffer(
      accountId: number,
      host: string,
      port: number,
      fingerprintSha256: string,
    ): TrustOfferCheck {
      const key = endpointKey(host, port)
      const state = hostPhase.get(key)
      // 'inflight' is deliberately NOT an offer: the probe is still running,
      // no dialog has been shown, so nobody can have accepted anything.
      if (!state || state.phase !== 'awaiting-user') return 'no-offer'
      if (now() - state.offeredAt >= CERT_TRUST_OFFER_TTL_MS) {
        // Stale dialog: revoke it. The next certificate error raises a fresh
        // one with a freshly probed identity.
        hostPhase.delete(key)
        return 'no-offer'
      }
      // The dialog belongs to one account. Two mailboxes on the same provider
      // legitimately share a host, and a confirmation for one is not consent
      // for the other.
      if (state.accountId !== accountId) return 'no-offer'
      // main never managed to display a certificate for this dialog (the
      // enrichment probe failed and no probe was served through main). There
      // is no user-confirmed value to pin.
      if (!state.fingerprint) return 'no-offer'
      if (state.fingerprint !== canonicalFingerprint(fingerprintSha256)) return 'fingerprint-mismatch'
      return 'ok'
    },

    consumeTrustOffer(accountId: number, host: string, port: number): void {
      const key = endpointKey(host, port)
      const state = hostPhase.get(key)
      // Defensive: only ever burn the offer that was actually redeemed.
      if (state?.phase === 'awaiting-user' && state.accountId !== accountId) return
      // resolveEndpoint drops the awaiting-user state, which IS the offer —
      // one dialog authorizes exactly one pin.
      resolveEndpoint(key)
    },

    dismiss(host: string, port?: number): boolean {
      return resolveDismiss(host, port)
    },
  }
}
