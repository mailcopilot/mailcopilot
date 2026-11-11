import { X509Certificate } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import { withoutDistrustedRoots } from './distrustedRoots'

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
   * WITHOUT weakening `rejectUnauthorized`. For the private-CA half of that
   * sentence the anchor is not sufficient on its own — a leaf can only end a
   * chain under partial chain building, which is why a non-empty list here is
   * also what turns that flag on (`secureContextFor`).
   *
   * Optional by design: the field is populated once the pin store persists
   * the certificate body (`upsertTlsPin` / `listTlsPinnedCertsPemForEndpoint`
   * in packages/db, which owns that storage). While it is absent, a pinned
   * self-signed server fails closed with a normal certificate error instead of
   * being silently accepted.
   *
   * SECURITY-LOAD-BEARING BEYOND CHAIN BUILDING: presence of a leaf here is
   * also what tells `buildTlsOptions` that the leaf's identity was confirmed
   * by the user through the main-initiated recovery dialog, which is the only
   * writer of certificate bodies — and, once ANY body is known for an
   * endpoint, the set of bodies known for it is the ONLY thing that endpoint
   * accepts. A leaf pinned by fingerprint alone (the renderer-writable
   * `tls:addPin` channel) is hostname-checked on an endpoint with no confirmed
   * body, and refused outright on one that has any. Do not populate this field
   * from anything a renderer supplies.
   */
  tlsPinnedCertsPem?: string[]
  /**
   * Hostname for TLS SNI when the connection is dialled by IP (DNS fallback
   * path in ./smtp, IP-addressed accounts).
   *
   * It is also the identity the certificate is verified against wherever a
   * hostname check applies: the unpinned path (Node's own
   * `checkServerIdentity` prefers `servername` over `host`) and a pinned
   * endpoint whose pins are all fingerprint-only. An ANCHORED leaf skips the
   * name check, and on an endpoint that has any anchor a fingerprint-only leaf
   * never reaches it — see `buildTlsOptions`.
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
    'TLS pin not confirmed',
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
 * How long OUR snapshot of the CA lists is reused before it is recomputed.
 *
 * This bounds the cost, not the staleness. It once claimed the latter — "an
 * admin REMOVING a root mid-session must not stay in effect until the app
 * restarts" — and that promise was false in both directions. Measured on the
 * shipping runtime (Node 22.22, and identically under Electron 43.4.1):
 * `tls.getCACertificates(kind)` returns the SAME frozen array object on every
 * call, for every kind, for the lifetime of the PROCESS. `lib/tls.js` memoizes
 * it (`systemCACertificates ||= ObjectFreeze(getSystemCACertificates())`) over
 * a C++ function-local static, so even a `worker_threads` read sees the same
 * snapshot, and there is no reset API — `tls.setDefaultCACertificates()`
 * replaces only the 'default' list, which we never call. Re-reading after the
 * TTL therefore re-reads a frozen snapshot and cannot notice any change to the
 * OS store.
 *
 * Consequence, stated plainly rather than papered over: a root the
 * administrator installs or removes mid-session — including a revoked
 * interception root — keeps its previous effect on IMAP/SMTP until the
 * application is RESTARTED. That is the accepted price, not an oversight; no
 * refresh mechanism is built here (there is no supported one to build on).
 *
 * What the TTL still buys is real and is why it stays: it keeps the dedupe of
 * ~500 PEM bodies off the per-connection hot path, and its revision counter is
 * what lets the derived SecureContext cache be invalidated in step with the
 * snapshot it was built from (see `caRevision`). Both of those are properties
 * of OUR caches, and they are what the tests pin — Node's memoization is an
 * implementation detail of Node, not a contract we assert against.
 */
export const CA_CACHE_TTL_MS = 10 * 60_000

type CaKind = 'combined' | 'bundled'
type CaCacheEntry = { value: string[] | null; at: number; revision: number }

/** `value === null` means `tls.getCACertificates` is unavailable/failed and
 *  callers must fall back to Node's own default verification. */
const caCache = new Map<CaKind, CaCacheEntry>()
let caFallbackWarned = false

/**
 * Dispenser of unique snapshot revisions: every (re)computed cache entry takes
 * the next number and carries it, so anything derived from a snapshot can be
 * keyed on that number instead of on the snapshot's contents.
 *
 * It is a counter, NOT a shared invalidator. Recomputing one kind advances the
 * counter, but a live entry of the other kind keeps its OWN revision and keeps
 * matching the contexts derived from it — derived values are compared against
 * the revision of the entry they came from, never against the counter's current
 * value. What the counter guarantees is that a recomputed entry never reuses
 * the number of the snapshot it replaces, so recomputing a snapshot makes
 * everything derived from its previous contents unreachable — the `ca` arrays
 * and the OpenSSL contexts built from them change over at the same moment,
 * with no window in which one is fresh and the other is not.
 *
 * That is a consistency guarantee between OUR caches, NOT a freshness
 * guarantee about the OS store: as `CA_CACHE_TTL_MS` explains, the underlying
 * `tls.getCACertificates` snapshot is frozen for the process lifetime, so a
 * recompute normally yields identical contents.
 */
let caRevision = 0

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

/** TTL-cached CA snapshot, entry form: the LIVE cached object, including the
 *  revision the derived SecureContext cache is keyed on. Module-internal only —
 *  the array it carries is never handed out (see `cachedCa` for the copy that
 *  is), because a consumer mutating the shared array would corrupt the trust
 *  store for every later connection in the process. */
function cachedCaEntry(kind: CaKind, compute: (getCa: GetCACertificatesFn) => string[]): CaCacheEntry {
  const hit = caCache.get(kind)
  if (hit && Date.now() - hit.at < CA_CACHE_TTL_MS) return hit
  let entry: CaCacheEntry
  try {
    entry = { value: dedupePem(compute(getCaFn())), at: Date.now(), revision: ++caRevision }
  } catch (e) {
    if (!caFallbackWarned) {
      caFallbackWarned = true
      // packages/net has no createLogger (layer-pure); console is the local sink.
      console.warn(
        '[TLS] CA store unavailable — using the runtime default CA store; the distrusted-root filter is not applied:',
        e instanceof Error ? e.message : String(e),
      )
    }
    entry = { value: null, at: Date.now(), revision: ++caRevision }
  }
  caCache.set(kind, entry)
  return entry
}

/** TTL-cached CA snapshot, array form. Always a DEFENSIVE COPY — see
 *  `cachedCaEntry`. */
function cachedCa(kind: CaKind, compute: (getCa: GetCACertificatesFn) => string[]): string[] | null {
  const entry = cachedCaEntry(kind, compute)
  return entry.value ? entry.value.slice() : null
}

/**
 * Return the combined CA list (Node default roots + OS system roots),
 * uniform across Windows/macOS/Linux — no per-OS branching.
 *
 * Graceful fallback: on Node builds without `tls.getCACertificates` (or if
 * it throws) returns `null`, which makes `buildTlsOptions` omit the trust
 * store entirely — i.e. Node's default verification. The degradation is
 * logged once per process.
 *
 * Kept as the array form for the interception probe and for callers that need
 * the certificates themselves. `buildTlsOptions` does NOT go through here: it
 * reads the cache entry directly so it can key the shared SecureContext on the
 * snapshot revision.
 */
export function getCombinedCaCertificates(): string[] | null {
  return cachedCa('combined', computeCombinedCa)
}

/** Default + system roots minus the explicit distrust set. The ONE definition
 *  of the combined list: `buildTlsOptions` and `getCombinedCaCertificates`
 *  both use it, so no consumer of THIS list reads an unfiltered copy. The one
 *  gap is the `null` fallback in `cachedCaEntry` (`tls.getCACertificates`
 *  missing or throwing): consumers then omit `ca` and get Node's built-in store as it is,
 *  denylist not applied. Accepted, not patched: the only other source, a
 *  filtered `tls.rootCertificates`, holds the bundled roots alone and would
 *  silently drop `NODE_EXTRA_CA_CERTS` (a corporate root), which is the
 *  narrower-than-default trust the additive rule above forbids — and the
 *  situation needs a runtime where `getCACertificates` is missing or throws,
 *  which Electron 43 is not. */
function computeCombinedCa(getCa: GetCACertificatesFn): string[] {
  return withoutDistrustedRoots([...getCa('default'), ...getCa('system')])
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
  return cachedCa('bundled', (getCa) => withoutDistrustedRoots(getCa('bundled')))
}

// ---------------------------------------------------------------------------
// SecureContext cache (§2.156)
// ---------------------------------------------------------------------------
// Handing `ca: string[]` to `tls.connect` makes Node build a FRESH OpenSSL
// trust store for every socket: it parses and indexes each PEM in the array
// before the handshake starts, synchronously, on the main thread. With the
// combined default+system list that is ~240 certificates, measured at ~14 ms
// per connection on the reference machine.
//
// That cost is per CONNECTION, and the background sync path opens one dedicated
// IMAP connection per folder — 44 per pass on the reference profile, six
// accounts running concurrently. The resulting ~630 ms of main-thread work per
// pass is what the event-loop watchdog reported as `Main blocked ~200-800ms`
// every five minutes (§2.156). Nothing about the work was necessary: every one
// of those connections was building the SAME trust store from the SAME bytes.
//
// A SecureContext is immutable once built and is designed to be shared across
// sockets (that is precisely what `https.Agent` does), so we build one per
// distinct trust set and reuse it. `rejectUnauthorized`, `servername` and
// `checkServerIdentity` stay per-connection options and are NOT part of the
// context — sharing the context therefore cannot leak pin or identity policy
// from one endpoint to another.
//
// Keyed on the revision OF THE SNAPSHOT ENTRY the context was built from,
// rather than on the certificate bytes, so a snapshot recompute hands out a
// fresh revision number and every context built from the previous contents
// becomes unreachable. Anchors are part of the key because a pinned endpoint's
// trust set is the snapshot PLUS its own anchors, and the partial-chain flag is
// part of the key because it changes HOW that same set is used (see
// `secureContextFor`).
type SecureContextEntry = { revision: number; context: tls.SecureContext }
const secureContextCache = new Map<string, SecureContextEntry>()

/** Identity of the pinned anchor set inside the cache key. The inputs are
 *  public certificate PEM bodies (0-2 in practice, one per confirmed pin), not
 *  credentials, so the key carries them as they are: no digest, nothing that
 *  could be mistaken for hashing secret material. The map is cleared of every
 *  entry from an older snapshot revision on each miss, so the longer key costs a
 *  few kilobytes at most. */
function anchorsKey(anchors: string[]): string {
  return anchors.length === 0 ? '-' : anchors.join('\0')
}

/**
 * Cache key for a built SecureContext.
 *
 * SECURITY-LOAD-BEARING: the key must name EVERY input that changes the object
 * being cached, `partialChain` included. It is not enough that today's caller
 * only ever asks for `partialChain: true` together with a non-empty anchor set
 * (which already gives a distinct `anchorsKey`) — that is a coincidence of the
 * current call sites, not a property of this cache. If the flag were left out
 * of the key and some later change asked for it on a set of anchors that some
 * other endpoint also uses without it, the two endpoints would share one
 * context and an ordinary connection would silently inherit the relaxed chain
 * building. Keying on the flag makes that class of mistake impossible instead
 * of merely unreachable.
 */
function secureContextCacheKey(revision: number, anchors: string[], partialChain: boolean): string {
  return `${revision}|${partialChain ? 'partial' : 'full'}|${anchorsKey(anchors)}`
}

/**
 * Shared SecureContext for a trust set, or `undefined` when the caller must
 * fall back to Node's implicit default context (no `ca` at all).
 *
 * `partialChain` maps to OpenSSL's `X509_V_FLAG_PARTIAL_CHAIN` through Node's
 * `allowPartialTrustChain` option: "treat intermediate (non-self-signed)
 * certificates in the trust CA certificate list as trusted". Without it a trust
 * anchor must be SELF-SIGNED, which is why supplying a pinned LEAF as an anchor
 * only ever helped a genuinely self-signed server. Measured against a server
 * that presents leaf + intermediate + private self-signed root (the shape of
 * the incident that motivated this — a mail host that moved to a private CA):
 *
 *   ca = store + pinned leaf, flag OFF → SELF_SIGNED_CERT_IN_CHAIN, and
 *                                        `checkServerIdentity` never runs
 *   ca = store + pinned leaf, flag ON  → authorized, `checkServerIdentity` runs
 *   ca = store (no anchor),   flag ON  → SELF_SIGNED_CERT_IN_CHAIN
 *
 * The third line is the important one: the flag does not widen trust by itself,
 * it only lets a certificate that is ALREADY in the trust list terminate the
 * chain. Combined with the second line it also explains why the user-facing bug
 * was unfixable before: our own invariant is that Node calls
 * `checkServerIdentity` only after chain verification succeeded, so the pin was
 * never even compared — "Trust this certificate" wrote a correct pin and the
 * next connection failed identically, forever.
 *
 * ONLY the pinned path passes `true`, and only when this endpoint actually has
 * a parsed anchor to terminate on (`buildTlsOptions`). What the flag widens is
 * real and list-wide: every non-self-signed certificate in the trust list
 * becomes a standalone end of trust (measured: a bare Sub CA in `ca` verifies
 * the chain above it on its own), and user OS stores do carry bare
 * intermediates — `Russian_Trusted_Sub_CA*` in `/usr/local/share/ca-
 * certificates/` on the affected machine, two such entries in the
 * 272-certificate store measured here.
 *
 * That widening is NOT contained here, and deliberately so. This flag is a
 * property of the CONTEXT — the whole trust list — while the decision it could
 * corrupt is taken per PRESENTED certificate, so every containment expressed
 * through the composition of the list leaked somewhere else: first through bare
 * intermediates promoted out of the OS store, then (once those were filtered)
 * through an anchor that is itself a CA, whose own issued descendants the
 * filter cannot touch because anchors are appended after it. Containment
 * therefore lives in the one place where the presented certificate is visible:
 * `checkServerIdentity` in `buildTlsOptions` accepts, on a partial-chain
 * context, ONLY a leaf that IS one of the anchors. Whatever else the relaxed
 * chain building lets OpenSSL verify is refused there before it can matter.
 *
 * A previous revision reduced the snapshot to its provably self-signed subset
 * before appending the anchors. It is gone: it was a second mechanism under the
 * same guarantee (CLAUDE.md §7 — do not stack defences), it cost ~108 ms of
 * signature verification per snapshot/anchor-set, and it took away the ordinary
 * chain-LINK role of a store intermediate, so a server that omits an
 * intermediate and relies on the user's store lost it.
 */
function secureContextFor(
  revision: number,
  store: string[] | null,
  anchors: string[],
  partialChain: boolean,
): tls.SecureContext | undefined {
  // Nothing to build a store from and nothing of our own to put in it — the
  // caller falls back to Node's implicit default context.
  if (!store && anchors.length === 0) return undefined
  const key = secureContextCacheKey(revision, anchors, partialChain)
  const hit = secureContextCache.get(key)
  if (hit && hit.revision === revision) return hit.context
  // Entries carrying an older revision belong to snapshot contents that no
  // lookup can ask for again; drop them rather than let the map grow for the
  // lifetime of the process.
  for (const [k, v] of secureContextCache) if (v.revision !== revision) secureContextCache.delete(k)
  const base = store ?? []
  // Deduplicate only when anchors are actually being merged in — the snapshot
  // is already deduplicated.
  const ca = anchors.length ? dedupePem([...base, ...anchors]) : base
  // Spread rather than `allowPartialTrustChain: partialChain` so the unpinned
  // path hands OpenSSL exactly the object it always did.
  const context = tls.createSecureContext({ ca, ...(partialChain && { allowPartialTrustChain: true }) })
  secureContextCache.set(key, { revision, context })
  return context
}

/** @internal — test-only cache reset; not part of the public API. */
export function __resetCombinedCaCacheForTest(): void {
  caCache.clear()
  secureContextCache.clear()
  caFallbackWarned = false
}

/** @internal — test-only seam for pure helpers that have no observable call
 *  site of their own. Not part of the public API. */
export const __testOnly = { secureContextCacheKey, trustErrorCodes: TLS_TRUST_ERROR_CODES }

export type TlsOptions = {
  rejectUnauthorized: boolean
  servername?: string
  /** Prebuilt shared trust store. Replaces `ca` — see the SecureContext cache
   *  note above for why the array form was removed from the hot path. */
  secureContext?: tls.SecureContext
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
 *  When anchors are present the pinned context is additionally built with
 *  partial chain building (`allowPartialTrustChain`), because an anchor that is
 *  a LEAF cannot terminate a chain otherwise. Without it the anchor helped only
 *  a truly self-signed server (leaf == root), and a server whose leaf is issued
 *  by a PRIVATE CA — the other half of the case pinning exists for — could
 *  never be fixed by the recovery dialog at all: the chain kept failing at the
 *  private root, so this callback never ran and the pin was never compared.
 *  The flag is scoped to the pinned context for a reason, and what keeps it a
 *  narrowing is the per-certificate hold below — on a partial-chain context
 *  only an anchor is accepted; see `secureContextFor`.
 *
 *  Identity on the pinned path is decided per PRESENTED certificate — see the
 *  `checkServerIdentity` comment below for the full reasoning:
 *    - the leaf is one of the pinned ANCHORS (its PEM is stored) → identity is
 *      established by the pinned material itself, the hostname is not checked;
 *    - the leaf is pinned by FINGERPRINT ONLY on an endpoint that has NO
 *      anchor → the hostname check stays, in full, exactly as on the unpinned
 *      path;
 *    - the leaf is pinned by FINGERPRINT ONLY on an endpoint that HAS an
 *      anchor → refused (`TLS pin not confirmed`). Such an endpoint runs a
 *      partial-chain context, and there the hostname check is no longer enough
 *      to keep a renderer-written pin from redirecting identity; the refusal
 *      classifies as a trust error, so the recovery dialog can confirm this
 *      certificate too — on the RECEIVING (IMAP) endpoint. That scope is a
 *      named limit, not an oversight: the cert-error seam exists only in
 *      `packages/net/imap.ts` (`CertErrorPayload.protocol` is `'imap'`,
 *      `certRecovery` hard-codes it, `packages/net/smtp.ts` has no cert
 *      handling), so on a send endpoint the only remedy is external
 *      (`NODE_EXTRA_CA_CERTS` or a root in the OS store).
 *
 *  Consequence to keep in mind: while `tlsPinnedCertsPem` is empty, a server
 *  whose chain does not verify against the public roots — self-signed or
 *  private-CA alike — fails closed (certificate error surfaced through the
 *  normal cert-error UX) instead of being silently accepted. That is a
 *  deliberate trade — silent acceptance was a MITM hole.
 *
 *  The trust set is handed over as a SHARED, PREBUILT `secureContext` rather
 *  than as a `ca` array (§2.156 — see the SecureContext cache above). This is a
 *  performance change only, and deliberately touches nothing that decides
 *  trust: the context carries the anchors, while `rejectUnauthorized`, the
 *  pinned `checkServerIdentity` closure and `servername` remain per-connection
 *  options built fresh from THIS cfg on every call. Endpoints with different
 *  anchors get different contexts (anchors are part of the cache key), and a
 *  CA-snapshot recompute orphans every context built from the previous
 *  contents, so the trust list and the OpenSSL context never disagree about
 *  what is trusted.
 *
 *  That last sentence is a consistency property of OUR caches and NOT a
 *  freshness promise about the OS store. See `CA_CACHE_TTL_MS`: the snapshot
 *  underneath is frozen for the lifetime of the process, so a root the
 *  administrator installs or removes mid-session keeps its previous effect
 *  until the application is restarted. */
export function buildTlsOptions(cfg: TlsConfig): TlsOptions | undefined {
  const pins = (cfg.tlsPinsSha256 || []).map(normalizeFingerprintSha256).filter(Boolean)
  const sni = cfg.servername
  const snapshot = cachedCaEntry('combined', computeCombinedCa)
  const combined = snapshot.value

  if (pins.length === 0) {
    if (!combined && !sni) return undefined
    // `false`: never relax chain building for an endpoint with no pin to
    // contain it — see `secureContextFor`.
    const secureContext = secureContextFor(snapshot.revision, combined, [], false)
    return {
      rejectUnauthorized: true,
      ...(secureContext && { secureContext }),
      ...(sni && { servername: sni }),
    }
  }

  const storedBodies = (cfg.tlsPinnedCertsPem || []).filter((pem) => Boolean(pem && pem.trim()))

  /**
   * The anchors handed to OpenSSL, and their fingerprints — one loop, so the
   * two can never disagree about which stored bodies are usable.
   *
   * ONLY PARSED BODIES TRAVEL ON. A corrupt row is dropped from the trust list
   * itself rather than passed to `tls.createSecureContext` in the expectation
   * that OpenSSL will ignore it. Measured on Node 22.22.1: it does ignore it
   * (a garbage entry in `ca` neither throws nor disturbs the valid entries
   * beside it, with and without `allowPartialTrustChain`). That is undocumented
   * behaviour of someone else's parser, and the cost of it changing is not a
   * degraded endpoint but a dead one: `createSecureContext` throwing here makes
   * `buildTlsOptions` throw before any socket, so every connection for the
   * account fails with an error that does NOT classify as a trust error — the
   * user gets network-class backoff and never the recovery dialog that could
   * replace the bad row. Filtering costs nothing and removes the dependency.
   *
   * `anchorFingerprints` is the set of pins that came with a certificate BODY,
   * i.e. the pins that are also trust anchors in `ca`.
   *
   * This set — not "were any anchors supplied at all" — is the discriminator
   * for the identity mode below, AND the switch for partial chain building.
   * An endpoint can hold both kinds of pin at once (an anchored one from the
   * recovery dialog plus a fingerprint-only one added from Settings), and a
   * per-endpoint "has anchors" flag would extend the anchored certificate's
   * privilege to the fingerprint-only one.
   *
   * An unparsable body contributes NOTHING (rather than throwing): the pin
   * store validates PEM bodies on write, so this is a corrupt-row path, and
   * degrading it to "hostname-checked" keeps a bad row from silently widening
   * identity. Note the empty-string guard on `fingerprint256` — a certificate
   * that cannot name itself must not match a pin that failed to parse either,
   * and it is no more usable as an anchor than an unparsable one.
   */
  const anchors: string[] = []
  const anchorFingerprints = new Set<string>()
  for (const pem of storedBodies) {
    try {
      const fp = normalizeFingerprintSha256(new X509Certificate(pem).fingerprint256 || '')
      if (!fp) continue
      anchors.push(pem)
      anchorFingerprints.add(fp)
    } catch {
      // Corrupt stored anchor — it reaches neither `ca`, nor the cache key,
      // nor the partial-chain decision, so it grants no identity anywhere.
    }
  }

  /**
   * Partial chain building, and ONLY with a PARSED anchor present.
   *
   * Derived from `anchorFingerprints`, not from the raw `storedBodies` count,
   * so the set that decides "is the presented leaf an anchor?" is literally
   * the set that turned the flag on. Two consequences, both wanted: a corrupt
   * stored body (non-empty, but not a certificate) no longer relaxes chain
   * building for an endpoint that gained no usable anchor from it, and the hold
   * below can never face a partial-chain context whose anchor set it cannot
   * name.
   *
   * With no anchors there is nothing of ours for a chain to terminate on, so
   * the flag would grant every intermediate in the general trust store the
   * standing of a root while buying this endpoint nothing at all. With anchors
   * it is what makes a pinned leaf usable as an anchor for a server whose leaf
   * was issued by a private CA — see `secureContextFor` for the measurement,
   * and for why the widening it performs is contained per PRESENTED
   * certificate rather than by composing the trust list.
   *
   * When the combined store is unavailable, `secureContextFor` builds from the
   * anchors alone — Node's `ca` replaces the default set wholesale, so
   * "defaults PLUS anchors" is not expressible. Narrowing trust to the pinned
   * certificates is acceptable on a pinned connection, where the fingerprint
   * check pins the leaf anyway.
   */
  const partialChain = anchorFingerprints.size > 0
  const secureContext = secureContextFor(snapshot.revision, combined, anchors, partialChain)

  return {
    rejectUnauthorized: true,
    ...(secureContext && { secureContext }),
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
     *
     * THE HOLD. On a PARTIAL-CHAIN context (this endpoint has at least one
     * parsed anchor) a fingerprint-only leaf is refused outright — it never
     * reaches the hostname check, because on such a context the hostname check
     * is no longer enough to keep the pin a narrowing of trust.
     *
     * Why the hold is here and not in the trust list. `allowPartialTrustChain`
     * is a property of the CONTEXT: it says "anything in this list may end a
     * chain", and the list is shared by every certificate the endpoint might
     * present. Two rounds of review showed the same invariant — "a
     * fingerprint-only pin gains nothing from the flag" — breaking in a new
     * place each time it was expressed through the list's composition: first
     * bare intermediates promoted out of the OS store, then an ANCHOR that is
     * itself a CA (`basicConstraints: CA:TRUE`), which terminates chains for
     * every certificate it ever issued. The second case was reproduced with
     * real handshakes: a descendant of the anchor, pinned by the
     * renderer-writable `tls:addPin` and carrying a matching name, verified and
     * was accepted although the human had confirmed a different certificate.
     * Filtering the store could not have caught it — anchors are appended after
     * any filter, by construction.
     *
     * So the guarantee is stated per presented certificate, where it is
     * decidable: on an endpoint that holds a human-confirmed certificate BODY,
     * only confirmed bodies are accepted. The price is named rather than
     * hidden: a fingerprint-only pin stops working on such an endpoint. Its
     * remedy is the one the product already offers — the refusal classifies as
     * a trust error (`isTlsTrustError`), so the normal recovery dialog opens
     * and confirming that certificate makes it an anchor too. That remedy
     * reaches only the RECEIVING (IMAP) endpoint: the cert-error seam lives in
     * `packages/net/imap.ts` alone, so on a send endpoint the refusal has no
     * in-app remedy and the external trust path applies instead.
     *
     * An endpoint with NO parsed anchor is untouched by all of this: full chain
     * verification plus the full hostname check, exactly as before.
     */
    checkServerIdentity: (hostname, cert) => {
      const fp = normalizeFingerprintSha256(cert.fingerprint256 || '')
      if (!fp) return new Error('TLS pin error: server certificate fingerprint is empty')
      if (!pins.includes(fp)) return new Error(`TLS pin mismatch: ${fp}`)
      // Anchored leaf → the pinned material established identity.
      if (anchorFingerprints.has(fp)) return undefined
      // Fingerprint-only leaf on a partial-chain context → refused. Distinct
      // message from `TLS pin mismatch`: the pin IS known here, what is missing
      // is the human-confirmed body, and the two must be tellable apart in a log.
      if (partialChain) {
        return new Error(
          `TLS pin not confirmed: ${fp} — this endpoint accepts only certificates confirmed in the recovery dialog`,
        )
      }
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
