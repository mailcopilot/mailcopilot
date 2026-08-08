import { X509Certificate } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'

type TlsConfig = {
  tlsPinsSha256?: string[]
  /**
   * PEM-encoded copies of the pinned certificates, when available.
   *
   * Load-bearing for self-signed / private-CA servers: a SHA-256 fingerprint
   * alone cannot make OpenSSL trust a chain, and Node only invokes
   * `checkServerIdentity` when chain verification already succeeded (see the
   * long comment above `buildTlsOptions`). Supplying the pinned certificate
   * itself as an explicit trust anchor is what lets such a server verify
   * WITHOUT weakening `rejectUnauthorized`.
   *
   * Optional by design: the field is populated once the pin store persists
   * the certificate body (see `contract_out` — owned by packages/db). While
   * it is absent, a pinned self-signed server fails closed with a normal
   * certificate error instead of being silently accepted.
   *
   * SECURITY-LOAD-BEARING BEYOND CHAIN BUILDING: presence of a leaf here is
   * also what tells `buildTlsOptions` that the leaf's identity was confirmed
   * by the user through the main-initiated recovery dialog, which is the only
   * writer of certificate bodies. A leaf pinned by fingerprint alone (the
   * renderer-writable `tls:addPin` channel) is still hostname-checked. Do not
   * populate this field from anything a renderer supplies.
   */
  tlsPinnedCertsPem?: string[]
  /**
   * Hostname for TLS SNI when the connection is dialled by IP (DNS fallback
   * path in ./smtp, IP-addressed accounts).
   *
   * It is also the identity the certificate is verified against wherever a
   * hostname check applies: the unpinned path (Node's own
   * `checkServerIdentity` prefers `servername` over `host`) and the
   * fingerprint-only pinned mode. Only an ANCHORED pinned leaf skips the name
   * check — see `buildTlsOptions`.
   */
  servername?: string
}

/** Normalize SHA-256 fingerprint: uppercase, separators are colons */
export function normalizeFingerprintSha256(fp: string): string {
  return (fp || '').trim().toUpperCase().replace(/-/g, ':')
}

// ---------------------------------------------------------------------------
// Canonical TLS-trust error detection
// ---------------------------------------------------------------------------
// Single source of truth for "this failure is a certificate/trust failure",
// shared by the probe classifier below and by `classifyImapError` in ./imap
// (imap imports tls, never the reverse — keep the dependency one-way).
//
// Deliberately NARROW. The previous regex carried a bare `certificate`
// alternative, so any server response merely MENTIONING a certificate —
// e.g. `NO [AUTHENTICATIONFAILED] client certificate required by policy` —
// classified as 'cert'. That suppressed the OAuth token refresh path and
// popped a misleading "TLS interception" dialog on what was an auth/policy
// failure. Matching now relies on OpenSSL/Node error CODES plus a closed set
// of well-known OpenSSL verify strings and our own pin-verifier messages.

/** Node/OpenSSL error codes that always denote a certificate/trust failure. */
const TLS_TRUST_ERROR_CODES = new Set([
  'CERT_CHAIN_TOO_LONG',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REJECTED',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/** Well-known OpenSSL verify strings + our own pin-verifier messages.
 *  Not anchored at `^` on purpose — ImapFlow/nodemailer prefix the original
 *  message ("LOGIN aborted: self-signed certificate") — but every
 *  alternative is a full phrase, never a lone word. */
const TLS_TRUST_MESSAGE_RE = new RegExp(
  [
    'self[- ]signed certificate(?: in certificate chain)?',
    'unable to verify the first certificate',
    'unable to get (?:local )?issuer certificate',
    'certificate has expired',
    'certificate is not yet valid',
    'certificate signature failure',
    'certificate (?:is )?revoked',
    'certificate is not trusted',
    'certificate chain too long',
    "hostname\\/ip does not match certificate's (?:altnames|subject)",
    'TLS pin mismatch',
    'TLS pin error',
  ].join('|'),
  'i',
)

/** `true` when the error is a TLS certificate / trust-chain failure.
 *
 *  Checks `err.code` first (authoritative — OpenSSL verify codes and Node's
 *  `ERR_TLS_CERT_ALTNAME_INVALID`), then falls back to the message, because
 *  ImapFlow sometimes surfaces only one of the two. */
export function isTlsTrustError(err: unknown): boolean {
  const rawCode = (err as { code?: unknown } | null | undefined)?.code
  const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : ''
  if (code && TLS_TRUST_ERROR_CODES.has(code)) return true
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return TLS_TRUST_MESSAGE_RE.test(msg)
}

// ---------------------------------------------------------------------------
// Combined CA trust store: Node default roots + OS system roots
// ---------------------------------------------------------------------------
// Why: the app contains TWO TLS stacks. Chromium (OAuth windows, renderer)
// trusts the OS certificate store; Node (IMAP/SMTP inside the main process)
// by default trusts only the bundled Mozilla roots (plus NODE_EXTRA_CA_CERTS).
// Antivirus products and corporate proxies (Kaspersky, ZScaler, ...) install
// their interception root into the OS store and MITM mail ports — OAuth then
// works while every IMAP/SMTP connection fails certificate verification.
// Thunderbird went through the same incident class and now includes OS roots
// as ADDITIONAL trust anchors. We do the same.
//
// The base set is `getCACertificates('default')`, NOT `'bundled'`: 'default'
// is exactly what Node would have used had we passed no `ca` at all — bundled
// Mozilla roots plus `NODE_EXTRA_CA_CERTS` (plus system roots when the
// process runs with `--use-system-ca`). Starting from 'bundled' silently
// DROPPED NODE_EXTRA_CA_CERTS, so passing `ca` could make trust NARROWER than
// the default — the opposite of the intended additive-only guarantee.
// 'system' is then appended, so the result is a strict superset of default.

/** Narrow structural type for `tls.getCACertificates` (Node >= 22.15). */
type GetCACertificatesFn = (type?: 'default' | 'system' | 'bundled' | 'extra') => string[]

/**
 * CA snapshots expire after this window. Root stores are NOT immutable for
 * the process lifetime: an admin installing or (more importantly) REMOVING a
 * root mid-session must not stay in effect until the app restarts — a revoked
 * interception root would otherwise remain trusted for hours. The TTL keeps
 * the read off the per-connection hot path while bounding staleness.
 */
export const CA_CACHE_TTL_MS = 10 * 60_000

type CaKind = 'combined' | 'bundled'
type CaCacheEntry = { value: string[] | null; at: number }

/** `value === null` means `tls.getCACertificates` is unavailable/failed and
 *  callers must fall back to Node's own default verification. */
const caCache = new Map<CaKind, CaCacheEntry>()
let caFallbackWarned = false

function dedupePem(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const pem of list) {
    const key = (pem || '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(pem)
  }
  return out
}

function getCaFn(): GetCACertificatesFn {
  const fn = (tls as { getCACertificates?: GetCACertificatesFn }).getCACertificates
  if (typeof fn !== 'function') {
    throw new Error('tls.getCACertificates is not available in this Node build')
  }
  return fn
}

/** TTL-cached CA snapshot. Always returns a DEFENSIVE COPY: the array is
 *  handed to callers that merge it into TLS options, and a consumer mutating
 *  a shared cached array would corrupt the trust store for every later
 *  connection in the process. */
function cachedCa(kind: CaKind, compute: (getCa: GetCACertificatesFn) => string[]): string[] | null {
  const hit = caCache.get(kind)
  if (hit && Date.now() - hit.at < CA_CACHE_TTL_MS) {
    return hit.value ? hit.value.slice() : null
  }
  try {
    const value = dedupePem(compute(getCaFn()))
    caCache.set(kind, { value, at: Date.now() })
    return value.slice()
  } catch (e) {
    if (!caFallbackWarned) {
      caFallbackWarned = true
      // packages/net has no createLogger (layer-pure); console is the local sink.
      console.warn(
        '[TLS] system CA store unavailable — falling back to bundled-only verification:',
        e instanceof Error ? e.message : String(e),
      )
    }
    caCache.set(kind, { value: null, at: Date.now() })
    return null
  }
}

/**
 * Return the combined CA list (Node default roots + OS system roots),
 * uniform across Windows/macOS/Linux — no per-OS branching.
 *
 * Graceful fallback: on Node builds without `tls.getCACertificates` (or if
 * it throws) returns `null`, which makes `buildTlsOptions` omit the `ca`
 * option entirely — i.e. Node's default verification. The degradation is
 * logged once per process.
 */
export function getCombinedCaCertificates(): string[] | null {
  return cachedCa('combined', (getCa) => [...getCa('default'), ...getCa('system')])
}

/**
 * Return ONLY the bundled Mozilla roots — the reference set for the
 * interception probe, where "does this chain verify without the OS store?"
 * must be answered exactly. Note that omitting `ca` would NOT answer it:
 * Node's implicit default also contains NODE_EXTRA_CA_CERTS (and system
 * roots under `--use-system-ca`), which is precisely what the probe is
 * trying to exclude.
 */
export function getBundledCaCertificates(): string[] | null {
  return cachedCa('bundled', (getCa) => getCa('bundled'))
}

/** @internal — test-only cache reset; not part of the public API. */
export function __resetCombinedCaCacheForTest(): void {
  caCache.clear()
  caFallbackWarned = false
}

export type TlsOptions = {
  rejectUnauthorized: boolean
  servername?: string
  ca?: string[]
  checkServerIdentity?: (hostname: string, cert: tls.PeerCertificate) => Error | undefined
}

/** Build TLS options: combined CA trust (default + OS roots), pin
 *  verification and optional SNI servername.
 *
 *  BOTH paths keep `rejectUnauthorized: true` (stated explicitly rather than
 *  relying on the default, so no transport library's own default can weaken
 *  it). This is not cosmetic — it is the fix for a pinning fail-open:
 *
 *    Node calls `checkServerIdentity` ONLY on the branch where chain
 *    verification already succeeded (`_tls_wrap.js` `onConnectSecure`: a
 *    non-empty `verifyError` takes the other branch, and with
 *    `rejectUnauthorized: false` the connection just proceeds). The pinned
 *    path used to pass `rejectUnauthorized: false`, so for a self-signed or
 *    private-CA certificate — the exact case pinning exists for — the
 *    fingerprint callback never ran and ANY certificate was accepted.
 *
 *  Pinned path therefore = full chain verification (default + system roots,
 *  plus the pinned certificates themselves as explicit anchors when their PEM
 *  is known) AND fingerprint equality. Pinning narrows trust, it never widens
 *  it.
 *
 *  Identity on the pinned path has TWO modes, decided per PRESENTED
 *  certificate — see the `checkServerIdentity` comment below for the full
 *  reasoning:
 *    - the leaf is one of the pinned ANCHORS (its PEM is stored) → identity is
 *      established by the pinned material itself, the hostname is not checked;
 *    - the leaf is pinned by FINGERPRINT ONLY → the hostname check stays, in
 *      full, exactly as on the unpinned path.
 *
 *  Consequence to keep in mind: while `tlsPinnedCertsPem` is empty, a pinned
 *  SELF-SIGNED server fails closed (certificate error surfaced through the
 *  normal cert-error UX) instead of being silently accepted. That is a
 *  deliberate trade — silent acceptance was a MITM hole. */
export function buildTlsOptions(cfg: TlsConfig): TlsOptions | undefined {
  const pins = (cfg.tlsPinsSha256 || []).map(normalizeFingerprintSha256).filter(Boolean)
  const sni = cfg.servername
  const combined = getCombinedCaCertificates()

  if (pins.length === 0) {
    if (!combined && !sni) return undefined
    return {
      rejectUnauthorized: true,
      ...(combined && { ca: combined }),
      ...(sni && { servername: sni }),
    }
  }

  const anchors = (cfg.tlsPinnedCertsPem || []).filter((pem) => Boolean(pem && pem.trim()))
  // When the combined store is unavailable we cannot express "defaults PLUS
  // anchors" (Node's `ca` replaces the default set wholesale). Passing the
  // anchors alone narrows trust to the pinned certificates — acceptable on a
  // pinned connection, where the fingerprint check pins the leaf anyway.
  const ca = combined ? dedupePem([...combined, ...anchors]) : (anchors.length ? dedupePem(anchors) : null)

  /**
   * Fingerprints of the pins that came with a certificate BODY, i.e. the pins
   * that are also trust anchors in `ca` above.
   *
   * This set — not "were any anchors supplied at all" — is the discriminator
   * for the identity mode below. An endpoint can hold both kinds of pin at
   * once (an anchored one from the recovery dialog plus a fingerprint-only one
   * added from Settings), and a per-endpoint "has anchors" flag would extend
   * the anchored certificate's privilege to the fingerprint-only one.
   *
   * An unparsable anchor contributes NOTHING (rather than throwing): the pin
   * store validates PEM bodies on write, so this is a corrupt-row path, and
   * degrading it to "hostname-checked" keeps a bad row from silently widening
   * identity. Note the empty-string guard on `fingerprint256` — a certificate
   * that cannot name itself must not match a pin that failed to parse either.
   */
  const anchorFingerprints = new Set<string>()
  for (const pem of anchors) {
    try {
      const fp = normalizeFingerprintSha256(new X509Certificate(pem).fingerprint256 || '')
      if (fp) anchorFingerprints.add(fp)
    } catch {
      // Corrupt stored anchor — it stays in `ca` (where OpenSSL will ignore
      // it) but grants no identity.
    }
  }

  return {
    rejectUnauthorized: true,
    ...(ca && { ca }),
    ...(sni && { servername: sni }),
    /**
     * Pin check first, then a per-certificate identity mode.
     *
     * WHY THE MODE EXISTS. A pin's authority depends on where its fingerprint
     * came from, and the two sources have very different trust:
     *
     *  - ANCHORED pin (`cert_pem` stored, so the certificate is also in `ca`
     *    above): mintable only through the main-initiated recovery dialog
     *    (`net:trustCert`, gated on a trust offer bound to account+endpoint+
     *    fingerprint; the PEM is fetched by MAIN and cross-checked against the
     *    displayed fingerprint, and packages/db refuses a body that disagrees
     *    with its pin). It is a certificate the user was shown and accepted.
     *  - FINGERPRINT-ONLY pin: also writable through `tls:addPin`, a plain
     *    renderer IPC channel (Settings → "add pin", the account wizard) with
     *    no trust-offer gate. The renderer chooses the string. A compromised
     *    renderer is inside this product's threat model — it parses email.
     *
     * So the hostname check may be dropped ONLY for an anchored leaf:
     *  - `rejectUnauthorized: true` still holds, so this callback is reached
     *    only after OpenSSL verified the whole chain (expiry, signatures,
     *    basic constraints) against default + system roots plus the anchors;
     *  - reaching it also means the peer completed the handshake, i.e. proved
     *    possession of the leaf's PRIVATE KEY — a copy of the certificate is
     *    not enough, certificates are public;
     *  - and the leaf is byte-for-byte the one the user confirmed for THIS
     *    endpoint. That is strictly stronger than "some name in this
     *    certificate matches the host we dialled" — the standard rationale for
     *    pinning, and the same trade Thunderbird's certificate exceptions make.
     * This is what makes the recovery dialog actually work for an account
     * addressed by bare IP (certificate carries no matching IP SAN): the
     * previous order checked the name FIRST and returned before the
     * fingerprint was compared, so "Trust this certificate" was a no-op and
     * every later connection failed with the same
     * ERR_TLS_CERT_ALTNAME_INVALID. (Latent until §2.52: the pinned path ran
     * with `rejectUnauthorized: false`, so Node never invoked this callback.)
     *
     * For a fingerprint-only pin NONE of that holds — the fingerprint proves
     * only that the leaf is the one the RENDERER named. Without the hostname
     * check such a pin would stop narrowing trust and start REDIRECTING it:
     * any CA-valid certificate whose fingerprint the renderer wrote here would
     * be accepted as this mail host, which together with a network position is
     * a complete MITM. So the check stays, in full. A forged fingerprint-only
     * pin can then still do what it always could — make the connection fail —
     * and nothing more (see the `tls:addPin` JSDoc in electron/main.ts, which
     * states exactly this property).
     *
     * Not relaxed in either mode: a leaf that is not pinned at all is refused
     * (server-side rotation fails closed and re-raises the recovery dialog),
     * and a certificate without a usable fingerprint is refused.
     */
    checkServerIdentity: (hostname, cert) => {
      const fp = normalizeFingerprintSha256(cert.fingerprint256 || '')
      if (!fp) return new Error('TLS pin error: server certificate fingerprint is empty')
      if (!pins.includes(fp)) return new Error(`TLS pin mismatch: ${fp}`)
      // Anchored leaf → the pinned material established identity.
      if (anchorFingerprints.has(fp)) return undefined
      // Fingerprint-only leaf → same identity check as the unpinned path.
      return tls.checkServerIdentity(sni || hostname, cert)
    },
  }
}

// ---------------------------------------------------------------------------
// Certificate trust probe — local-interception detection
// ---------------------------------------------------------------------------

/** Probe timeout — same value as fetchServerCertificate in electron/main.ts. */
const CERT_PROBE_TIMEOUT_MS = 12_000

/** Transport shape of the endpoint being probed. Mail endpoints come in two
 *  flavours and they are NOT interchangeable: sending a raw ClientHello into
 *  a plaintext STARTTLS port (143/587) yields no certificate at all, just a
 *  protocol error — the probe would report a transport failure for a
 *  perfectly healthy server. */
export type CertProbeTransport = {
  /** `true` = implicit TLS (993/465). `false` = STARTTLS upgrade. Default `true`. */
  secure?: boolean
  /** Application protocol driving the STARTTLS dialog. Default `'imap'`. */
  protocol?: 'imap' | 'smtp'
  /** SNI / identity hostname when connecting by IP. Defaults to `host`. */
  servername?: string
}

export type CertTrustVerdict =
  /** Chain verifies against the bundled Mozilla roots — ordinary public cert. */
  | 'bundled-trusted'
  /** Verifies only with the OS store added — signature of local interception. */
  | 'system-only'
  /** Verifies against neither set — a plainly bad certificate. */
  | 'untrusted'
  /** No trustworthy verdict could be derived; see `inconclusiveReason`. */
  | 'inconclusive'

export type CertTrustInconclusiveReason =
  /** A probe failed on DNS/TCP/timeout/connection reset, not on the certificate. */
  | 'transport-failed'
  /** Probes saw DIFFERENT certificates (load balancer, rotation, or an attacker). */
  | 'certificate-rotated'
  /** `tls.getCACertificates` unavailable — no reference set to compare against. */
  | 'ca-store-unavailable'
  /**
   * The certificate identity behind the verdict could not be established:
   * either the endpoint presented no usable fingerprint, or the confirmation
   * probe connected without proving which certificate it saw. Distinct from
   * `certificate-rotated` (a change was OBSERVED) — here nothing was
   * disproven, and nothing was proven either. Retry later.
   */
  | 'identity-unconfirmed'

/**
 * How firmly the verdict is tied to the certificate reported in
 * `fingerprintSha256`.
 *
 * The distinction exists because Node hides the peer certificate on OpenSSL
 * chain-verification rejections (see `HandshakeProbe`), and those rejections
 * are the NORMAL half of an interception verdict. Refusing to conclude
 * without them would make `system-only` unreachable in practice — the
 * interception warning would simply never fire. So the verdict is still
 * issued, but the caller is told how much it can be leaned on.
 */
export type CertTrustEvidence =
  /**
   * Every probe behind the verdict named the certificate it saw, and all of
   * them matched `fingerprintSha256`. Nothing about the verdict rests on an
   * assumption.
   */
  | 'proven'
  /**
   * At least one contributing probe — always a REJECTING one — could not
   * name the certificate it saw. The identity was re-read afterwards and had
   * not changed, which narrows the window but does not close it: an endpoint
   * that serves certificate A to the identity probes and B to the rejecting
   * probe still produces this outcome.
   */
  | 'partial'

export type CertTrustReport = {
  /** Normalized SHA-256 fingerprint of the leaf certificate. */
  fingerprintSha256: string
  /** Issuer common name ('' when absent). */
  issuerCn: string
  /** Subject common name ('' when absent). */
  subjectCn: string
  /**
   * `true` when the chain verifies against default + system roots but NOT
   * against the bundled roots — the signature of local TLS interception
   * (antivirus / corporate proxy root installed into the OS store).
   * Always `false` unless `verdict === 'system-only'`.
   */
  systemOnly: boolean
  /** Full verdict; `systemOnly` is the boolean projection of it. */
  verdict: CertTrustVerdict
  /**
   * `false` when the verdict must NOT be cached/persisted as a lasting
   * judgement — a transient network failure or a certificate change between
   * probes. Callers should retry later instead of storing the result.
   */
  conclusive: boolean
  /**
   * Evidence strength of a conclusive verdict. Never `'proven'` when
   * `conclusive === false`.
   *
   * SUBSCRIBER CONTRACT (the two decisions must NOT use the same predicate):
   *  - SHOW the interception warning: `verdict === 'system-only'`, regardless
   *    of evidence. A false alarm is cheaper than a missed interception.
   *  - PERSIST a lasting "this host has been checked" state that suppresses
   *    future warnings: only when `conclusive === true && evidence === 'proven'`.
   *    Persisting a `'partial'` verdict lets an attacker who wins the probe
   *    race ONCE silence the warning for that host permanently.
   */
  evidence: CertTrustEvidence
  /** Present only when `verdict === 'inconclusive'`. */
  inconclusiveReason?: CertTrustInconclusiveReason
}

/** Report placeholder for callers that could not run the probe at all
 *  (endpoint unreachable between the failed operation and the diagnosis).
 *  Explicitly `inconclusive` / `conclusive: false` so such a placeholder can
 *  never be mistaken for — or persisted as — a trust judgement. */
export function unknownCertTrust(identity?: {
  fingerprintSha256?: string
  issuerCn?: string
  subjectCn?: string
}): CertTrustReport {
  return {
    fingerprintSha256: identity?.fingerprintSha256 || '',
    issuerCn: identity?.issuerCn || '',
    subjectCn: identity?.subjectCn || '',
    systemOnly: false,
    verdict: 'inconclusive',
    conclusive: false,
    evidence: 'partial',
    inconclusiveReason: 'transport-failed',
  }
}

type ProbeEndpoint = {
  host: string
  port: number
  sni: string
  secure: boolean
  protocol: 'imap' | 'smtp'
}

/** What `connectProbe` needs from the settlement context — deliberately no
 *  `finish`: only the caller knows what a successful probe resolves to. */
type ProbeCtx = {
  fail: (err: unknown) => void
  track: (socket: { destroy: (err?: Error) => void }) => void
}

/**
 * Single settlement point for every probe: exactly one resolve/reject, the
 * timeout timer always cleared, and every socket opened along the way always
 * destroyed — on success, on error and on timeout alike. Probes previously
 * leaked in both directions (error paths that never closed the socket, and a
 * success path that left the `setTimeout` armed).
 */
function runProbe<T>(
  timeoutMs: number,
  executor: (ctx: {
    finish: (value: T) => void
    fail: (err: unknown) => void
    track: (socket: { destroy: (err?: Error) => void }) => void
  }) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const sockets: Array<{ destroy: (err?: Error) => void }> = []
    /**
     * LIFO teardown — load-bearing, not stylistic. The STARTTLS path tracks
     * TWO sockets: the raw socket and the TLSSocket wrapping it. Destroying
     * the RAW socket first while its live TLS wrapper still points at it
     * SEGFAULTS Node (reproduced on v22.22). Closing the outermost wrapper
     * first tears the underlying socket down with it.
     */
    const closeAll = () => {
      for (let i = sockets.length - 1; i >= 0; i--) {
        try { sockets[i].destroy() } catch { /* already gone */ }
      }
      sockets.length = 0
    }
    const timer = setTimeout(() => {
      fail(new Error('TLS certificate probe timeout'))
    }, timeoutMs)
    // Never keep the process alive just for a diagnostic probe.
    timer.unref?.()
    const cleanup = () => {
      clearTimeout(timer)
      closeAll()
    }
    function finish(value: T): void {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    function fail(err: unknown): void {
      if (settled) return
      settled = true
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const track = (socket: { destroy: (err?: Error) => void }) => {
      if (settled) {
        try { socket.destroy() } catch { /* already gone */ }
        return
      }
      sockets.push(socket)
    }
    try {
      executor({ finish, fail, track })
    } catch (e) {
      fail(e)
    }
  })
}

/** STARTTLS dialog steps: wait until `match` returns 'ok' for a response
 *  line, then send `send` (if any) and move to the next step. */
type StartTlsStep = {
  match: (line: string) => 'ok' | 'wait' | 'fail'
  send?: string
}

function startTlsSteps(protocol: 'imap' | 'smtp'): StartTlsStep[] {
  if (protocol === 'smtp') {
    return [
      // Greeting: 220 (multiline 220- continues).
      { match: (l) => (/^220 /.test(l) ? 'ok' : /^220-/.test(l) ? 'wait' : 'fail'), send: 'EHLO localhost\r\n' },
      // EHLO reply: capability lines 250-..., final 250 .
      { match: (l) => (/^250 /.test(l) ? 'ok' : /^250-/.test(l) ? 'wait' : 'fail'), send: 'STARTTLS\r\n' },
      // STARTTLS accepted.
      { match: (l) => (/^220 /.test(l) ? 'ok' : 'fail') },
    ]
  }
  return [
    // Greeting: * OK / * PREAUTH (a * BYE means the server is refusing us).
    {
      match: (l) => (/^\* (OK|PREAUTH)\b/i.test(l) ? 'ok' : /^\* BYE\b/i.test(l) ? 'fail' : 'wait'),
      send: 'A1 STARTTLS\r\n',
    },
    // Tagged completion for STARTTLS.
    { match: (l) => (/^A1 OK\b/i.test(l) ? 'ok' : /^A1 (NO|BAD)\b/i.test(l) ? 'fail' : 'wait') },
  ]
}

/** Open a probe connection and hand the secured socket to `onSecure`.
 *  Implicit TLS connects directly; STARTTLS runs the plaintext dialog first
 *  and upgrades the same socket in place. */
function connectProbe(
  ep: ProbeEndpoint,
  extra: tls.ConnectionOptions,
  ctx: ProbeCtx,
  onSecure: (socket: tls.TLSSocket) => void,
): void {
  const tlsOpts: tls.ConnectionOptions = { servername: ep.sni, ...extra }

  if (ep.secure) {
    const socket: tls.TLSSocket = tls.connect(
      { host: ep.host, port: ep.port, ...tlsOpts },
      () => onSecure(socket),
    )
    ctx.track(socket)
    socket.once('error', ctx.fail)
    return
  }

  const raw = net.connect({ host: ep.host, port: ep.port })
  ctx.track(raw)
  raw.once('error', ctx.fail)

  const steps = startTlsSteps(ep.protocol)
  let stepIndex = 0
  let buffer = ''

  const upgrade = () => {
    raw.removeListener('data', onData)
    const secured: tls.TLSSocket = tls.connect(
      { socket: raw, ...tlsOpts },
      () => onSecure(secured),
    )
    ctx.track(secured)
    secured.once('error', ctx.fail)
  }

  function onData(chunk: Buffer): void {
    // latin1 keeps byte↔char parity; STARTTLS banners are ASCII anyway.
    buffer += chunk.toString('latin1')
    for (;;) {
      const eol = buffer.indexOf('\r\n')
      if (eol < 0) return
      const line = buffer.slice(0, eol)
      buffer = buffer.slice(eol + 2)
      const step = steps[stepIndex]
      if (!step) return
      const verdict = step.match(line)
      if (verdict === 'wait') continue
      if (verdict === 'fail') {
        ctx.fail(new Error(`STARTTLS probe refused by server: ${line.slice(0, 120)}`))
        return
      }
      stepIndex++
      if (step.send) {
        try { raw.write(step.send) } catch (e) { ctx.fail(e); return }
      }
      if (stepIndex >= steps.length) {
        upgrade()
        return
      }
    }
  }

  raw.on('data', onData)
}

/** Read the leaf certificate identity (fingerprint / issuer / subject).
 *
 *  `rejectUnauthorized: false` is acceptable HERE ONLY because no
 *  application data flows over this connection and no trust verdict is
 *  derived from it — it exists purely to read the presented certificate.
 *  The trust verdict comes from the separate verifying probes below. */
function probeCertificateIdentity(ep: ProbeEndpoint): Promise<tls.DetailedPeerCertificate> {
  return runProbe<tls.DetailedPeerCertificate>(CERT_PROBE_TIMEOUT_MS, (ctx) => {
    connectProbe(ep, { rejectUnauthorized: false }, ctx, (socket) => {
      try {
        ctx.finish(socket.getPeerCertificate(true))
      } catch (e) {
        ctx.fail(e)
      }
    })
  })
}

/** Outcome of a fully verifying handshake probe.
 *
 *  Collapsing these three into a single boolean was a correctness bug: a
 *  transient DNS/TCP failure on the bundled probe followed by a successful
 *  system probe reported `systemOnly: true` (a false interception alarm),
 *  and a transient failure on the system probe reported `false` — a verdict
 *  the caller then persisted as if it were permanent. */
type HandshakeProbe =
  | { outcome: 'trusted'; fingerprint: string }
  /**
   * `fingerprint` is OPTIONAL here because Node only exposes the peer
   * certificate on SOME rejection paths — measured, not assumed (Node
   * v22.22):
   *   - errors raised from `checkServerIdentity` (chain already verified) —
   *     `ERR_TLS_CERT_ALTNAME_INVALID` and friends — DO carry `err.cert`;
   *   - OpenSSL chain-verification codes (`DEPTH_ZERO_SELF_SIGNED_CERT`,
   *     `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, ...)
   *     carry NOTHING: `err.cert` is undefined AND `getPeerCertificate()`
   *     returns `{}` even from a listener on the `secure` event, because
   *     Node's own handler destroys the socket first.
   * Getting a fingerprint out of the second group would require either a
   * `rejectUnauthorized: false` reconnect (forbidden — that is exactly the
   * weakening this rework removed) or re-implementing the authorization
   * branch by hand. Instead the caller compensates with a confirmation
   * identity probe — see `verifyCertTrust`.
   */
  | { outcome: 'cert-rejected'; fingerprint?: string }
  | { outcome: 'transport-failed'; reason: string }

/** Read `err.cert.fingerprint256` when Node attached the peer certificate to
 *  a rejection. Returns '' when unavailable — never guesses. */
function fingerprintFromError(err: unknown): string {
  const cert = (err as { cert?: { fingerprint256?: unknown } } | null | undefined)?.cert
  const fp = cert?.fingerprint256
  return typeof fp === 'string' ? normalizeFingerprintSha256(fp) : ''
}

/** Fully verifying TLS handshake probe. `rejectUnauthorized` stays at its
 *  secure default (true). `ca` is ALWAYS explicit — see
 *  `getBundledCaCertificates` for why omitting it does not mean
 *  "bundled only". Reports the peer fingerprint whenever Node makes it
 *  available — on success from the socket, on rejection from `err.cert` — so
 *  the caller can prove that the verdict and the displayed identity came from
 *  the same certificate. */
async function probeVerifiedHandshake(ep: ProbeEndpoint, ca: string[]): Promise<HandshakeProbe> {
  try {
    return await runProbe<HandshakeProbe>(CERT_PROBE_TIMEOUT_MS, (ctx) => {
      connectProbe(ep, { ca, rejectUnauthorized: true }, ctx, (socket) => {
        const fp = normalizeFingerprintSha256(
          String((socket.getPeerCertificate(false) as tls.PeerCertificate | null)?.fingerprint256 || ''),
        )
        ctx.finish({ outcome: 'trusted', fingerprint: fp })
      })
    })
  } catch (err) {
    // Classification happens HERE, on the single rejection path, so that a
    // handshake error, a STARTTLS refusal and the probe timeout are all
    // funnelled through the same discriminator. Only a genuine certificate
    // rejection may become a trust verdict; everything else is transport.
    if (isTlsTrustError(err)) {
      const fp = fingerprintFromError(err)
      return fp ? { outcome: 'cert-rejected', fingerprint: fp } : { outcome: 'cert-rejected' }
    }
    return { outcome: 'transport-failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

function inconclusive(
  base: Pick<CertTrustReport, 'fingerprintSha256' | 'issuerCn' | 'subjectCn'>,
  reason: CertTrustInconclusiveReason,
): CertTrustReport {
  return {
    ...base,
    systemOnly: false,
    verdict: 'inconclusive',
    conclusive: false,
    evidence: 'partial',
    inconclusiveReason: reason,
  }
}

/**
 * Probe the server certificate and determine whether its trust depends on
 * the OS system store alone.
 *
 * Four connections at most:
 *  1. identity probe — reads fingerprint / issuer CN / subject CN
 *     (rejectUnauthorized:false, no trust verdict derived — see JSDoc above);
 *  2. verifying probe against the BUNDLED Mozilla roots (explicit `ca`);
 *  3. verifying probe against default + system roots — only when probe 2
 *     rejected the certificate;
 *  4. confirmation identity probe — only when a REJECTING probe contributed
 *     to a conclusive verdict without exposing its fingerprint (see below).
 *
 * `verdict === 'system-only'` (probe 2 rejected the cert, probe 3 accepted
 * it) is the signal of local TLS interception: the chain is anchored by a
 * root the user's OS trusts (AV / corporate proxy) but Mozilla does not.
 *
 * Any transport failure, a missing CA reference set, or a fingerprint change
 * BETWEEN probes yields `verdict: 'inconclusive'` with `conclusive: false` —
 * never a trust judgement. Without the fingerprint cross-check a load
 * balancer (or an active attacker) could have the verdict derived from one
 * certificate while the UI displays and pins another.
 *
 * The rejecting probes are the awkward half of that cross-check: Node exposes
 * the peer certificate for `checkServerIdentity`-branch errors but NOT for
 * OpenSSL chain-verification codes (see `HandshakeProbe`), and re-reading it
 * with a relaxed handshake is not an option. So when a rejection that fed the
 * verdict came back fingerprint-less, the certificate identity is re-read
 * (probe 4) and required to be unchanged; otherwise the verdict degrades to
 * `certificate-rotated`.
 *
 * That confirmation NARROWS the race but cannot close it: an endpoint serving
 * certificate A to both identity probes and B to the rejecting probe passes
 * every check and yields a verdict whose negative half concerned a different
 * certificate. Such a verdict is therefore marked `evidence: 'partial'` — it
 * is good enough to WARN on, but must not be persisted as a lasting "host
 * checked" state, or one won race would silence interception warnings for
 * that host forever. `evidence: 'proven'` means every contributing probe
 * named its certificate and all matched. See `CertTrustEvidence` and the
 * subscriber contract on `CertTrustReport.evidence`.
 *
 * The trust-granting direction is unaffected either way: a chain accepted by
 * a verifying probe always proves its own fingerprint.
 *
 * Rejects when the identity probe cannot connect at all (network failure).
 * NEVER used on the working data channel — this is a diagnostic probe for
 * the main-process cert-error UX.
 */
export async function verifyCertTrust(
  host: string,
  port: number,
  transport?: CertProbeTransport,
): Promise<CertTrustReport> {
  const ep: ProbeEndpoint = {
    host,
    port,
    sni: transport?.servername || host,
    secure: transport?.secure !== false,
    protocol: transport?.protocol === 'smtp' ? 'smtp' : 'imap',
  }

  const cert = await probeCertificateIdentity(ep)
  const fingerprintSha256 = normalizeFingerprintSha256(String(cert?.fingerprint256 || ''))
  const identity = {
    fingerprintSha256,
    issuerCn: String(cert?.issuer?.CN || ''),
    subjectCn: String(cert?.subject?.CN || ''),
  }

  const bundled = getBundledCaCertificates()
  if (!bundled) return inconclusive(identity, 'ca-store-unavailable')

  /**
   * Mismatch detector for the ORDINARY probes. Lenient by design: when one
   * side has no fingerprint there is nothing to compare, and failing every
   * such case would turn honest verdicts inconclusive on any runtime that is
   * stingy with certificate data. The leniency is bounded — a verdict can
   * never be issued without a KNOWN identity, because `conclusiveVerdict`
   * below refuses to be conclusive when the identity probe produced no
   * fingerprint at all. So "both sides empty" cannot reach a conclusion.
   *
   * The confirmation probe deliberately does NOT use this predicate: there,
   * absence of proof IS a negative result (see `confirmIdentityUnchanged`).
   */
  const sameCert = (fp: string) => !fingerprintSha256 || !fp || fp === fingerprintSha256

  /** A rejecting probe fed the verdict but could not prove which certificate
   *  it rejected — probe 4 has to vouch for it, and the resulting verdict is
   *  reported as `evidence: 'partial'`. */
  let unprovenRejection = false

  /** Terminal conclusive verdict, gated on having an identity to attribute it
   *  to. A conclusive judgement about a certificate we cannot even name is
   *  worthless to the caller (nothing to display, nothing to pin) and would
   *  paper over exactly the unprovable cases this rework is about.
   *
   *  `evidence` reports whether every contributing probe named its
   *  certificate (`'proven'`) or a fingerprint-less rejection had to be
   *  vouched for by the confirmation probe (`'partial'`). The caller needs
   *  both outcomes: warn on either, persist only on `'proven'`. */
  const conclusiveVerdict = (verdict: CertTrustVerdict, systemOnly: boolean): CertTrustReport =>
    fingerprintSha256
      ? {
          ...identity,
          systemOnly,
          verdict,
          conclusive: true,
          evidence: unprovenRejection ? 'partial' : 'proven',
        }
      : inconclusive(identity, 'identity-unconfirmed')

  /**
   * Re-read the certificate identity and require it to be unchanged. Runs
   * only when a fingerprint-less rejection contributed to the verdict.
   *
   * STRICT, unlike `sameCert`: this probe exists solely to compensate for a
   * rejection that proved nothing, so "could not confirm" must mean "not
   * confirmed". Treating a connected-but-fingerprint-less re-read as "no
   * change" would make the compensating control itself fail open — the exact
   * failure mode it was added to close.
   */
  const confirmIdentityUnchanged = async (): Promise<CertTrustInconclusiveReason | null> => {
    if (!unprovenRejection) return null
    // Nothing to confirm against: the verdict would rest on an empty-vs-empty
    // comparison.
    if (!fingerprintSha256) return 'identity-unconfirmed'
    try {
      const again = await probeCertificateIdentity(ep)
      const fp = normalizeFingerprintSha256(String(again?.fingerprint256 || ''))
      if (!fp) return 'identity-unconfirmed'
      return fp !== fingerprintSha256 ? 'certificate-rotated' : null
    } catch {
      return 'transport-failed'
    }
  }

  const bundledProbe = await probeVerifiedHandshake(ep, bundled)
  if (bundledProbe.outcome === 'transport-failed') return inconclusive(identity, 'transport-failed')
  if (bundledProbe.outcome === 'trusted') {
    if (!sameCert(bundledProbe.fingerprint)) return inconclusive(identity, 'certificate-rotated')
    return conclusiveVerdict('bundled-trusted', false)
  }
  // Rejected. Use the fingerprint when Node gave us one; otherwise remember
  // that this leg of the verdict is unproven.
  if (bundledProbe.fingerprint) {
    if (!sameCert(bundledProbe.fingerprint)) return inconclusive(identity, 'certificate-rotated')
  } else {
    unprovenRejection = true
  }

  const combined = getCombinedCaCertificates()
  if (!combined) return inconclusive(identity, 'ca-store-unavailable')

  const combinedProbe = await probeVerifiedHandshake(ep, combined)
  if (combinedProbe.outcome === 'transport-failed') return inconclusive(identity, 'transport-failed')
  if (combinedProbe.outcome === 'trusted') {
    if (!sameCert(combinedProbe.fingerprint)) return inconclusive(identity, 'certificate-rotated')
    const drift = await confirmIdentityUnchanged()
    if (drift) return inconclusive(identity, drift)
    return conclusiveVerdict('system-only', true)
  }
  if (combinedProbe.fingerprint) {
    if (!sameCert(combinedProbe.fingerprint)) return inconclusive(identity, 'certificate-rotated')
  } else {
    unprovenRejection = true
  }
  const drift = await confirmIdentityUnchanged()
  if (drift) return inconclusive(identity, drift)

  // Rejected by both sets: a plainly untrusted certificate, not interception.
  return conclusiveVerdict('untrusted', false)
}
