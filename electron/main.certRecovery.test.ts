import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'

/**
 * TLS trust rework (Phase A2) — main.ts IPC wiring for cert recovery.
 *
 * `electron/main.ts` cannot be imported directly in unit tests (module-level
 * side effects: BrowserWindow, IPC registration, DB open, etc. — same
 * constraint documented in main.auditLogClear.test.ts / main.pendingMoves.test.ts).
 * We mirror the wiring points verbatim with injected dependencies:
 *
 *   - `net:trustCert` handler: schema validation → account-exists guard →
 *     ENDPOINT-OWNERSHIP guard → upsertTlsPin (canonical fingerprint) →
 *     TRUST-OFFER gate → certRecovery.consumeTrustOffer → telemetry →
 *     accounts:changed broadcast → one-shot per-account resync.
 *   - `cert:dismiss` handler: schema validation → certRecovery.dismiss.
 *   - `broadcast()` recipient counting.
 *   - `persistCertNoticeShownHosts` atomic write-then-rename.
 *   - `requireAccountConfig` / `accounts:remove` lifecycle calls into
 *     `certRecovery.ensureAccountRegistered` / `unregisterAccount`.
 *
 * The certRecovery SERVICE itself (storm-guard, debounce, enrichment,
 * interception-notice persistence) is fully covered by
 * electron/services/certRecovery.test.ts — this file only pins the wiring
 * around it.
 *
 * Any drift between these mirrors and the production handlers in main.ts is
 * a regression risk. Keep the mirror in sync when modifying the handlers.
 */

// ─── Mirror: certTrustSchema / certDismissSchema (electron/main.ts) ─────────
const accountIdSchema = z.number().int().positive()
const SHA256_FINGERPRINT_RE = /^(?:[0-9a-fA-F]{2}[:-]){31}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{64}$/
// Renderer-driven probe target: bounded host length and full port range.
const tlsServerSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
}).strict()
// Settings-driven pin schema (unchanged shape — the hardening is that the
// handler now refuses to store a certificate body through this channel).
const tlsPinSchema = z.object({
  accountId: accountIdSchema,
  host: z.string().min(1),
  port: z.number().int().positive(),
  fingerprintSha256: z.string().min(1),
}).strict()
const certTrustSchema = z.object({
  accountId: accountIdSchema,
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  fingerprintSha256: z.string().trim().regex(SHA256_FINGERPRINT_RE),
}).strict()
const certDismissSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).optional(),
}).strict()

// ─── Mirror: fingerprint / host canonicalization (electron/main.ts) ─────────
function canonicalFingerprintSha256(raw: string): string {
  const hex = raw.replace(/[:-]/g, '').toUpperCase()
  return (hex.match(/.{2}/g) ?? []).join(':')
}

function normalizeEndpointHost(host: string): string {
  return (host || '').trim().toLowerCase().replace(/\.+$/, '')
}

// ─── Mirror: matchAccountTlsEndpoint (electron/main.ts) ─────────────────────
type EndpointMeta = {
  imap: { host: string; port: number; secure?: boolean }
  smtp: { host: string; port: number; secure?: boolean }
}

function matchAccountTlsEndpoint(
  meta: EndpointMeta,
  host: string,
  port: number,
): 'imap' | 'smtp' | null {
  const wanted = normalizeEndpointHost(host)
  if (normalizeEndpointHost(meta.imap.host) === wanted && meta.imap.port === port) return 'imap'
  if (normalizeEndpointHost(meta.smtp.host) === wanted && meta.smtp.port === port) return 'smtp'
  return null
}

// ─── Mirror: broadcast() recipient counting (electron/main.ts) ──────────────
type FakeWindow = { destroyed: boolean; send: (channel: string, payload: unknown) => void }

function broadcastTo(windows: FakeWindow[], channel: string, payload: unknown): number {
  let delivered = 0
  for (const w of windows) {
    try {
      if (w.destroyed) continue
      w.send(channel, payload)
      delivered++
    } catch { /* window may have been destroyed between check and send */ }
  }
  return delivered
}

// ─── Mirror: cert notice store persistence (electron/main.ts) ──────────────
const CERT_NOTICE_STORE_FILE = 'cert-interception-notice.json'

function loadCertNoticeShownHosts(dir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(dir, CERT_NOTICE_STORE_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : []
  } catch {
    return []
  }
}

function persistCertNoticeShownHosts(
  dir: string,
  hosts: string[],
  writeFile: (p: string, data: string) => void = (p, data) => fs.writeFileSync(p, data, 'utf8'),
): void {
  const finalPath = path.join(dir, CERT_NOTICE_STORE_FILE)
  const tmpPath = path.join(dir, `${CERT_NOTICE_STORE_FILE}.${process.pid}.tmp`)
  try {
    writeFile(tmpPath, JSON.stringify(Array.from(new Set(hosts))))
    fs.renameSync(tmpPath, finalPath)
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
    throw err
  }
}

// ─── Mirror: minimal certRecovery service surface used by main.ts ──────────
interface CertRecoveryServiceMock {
  ensureAccountRegistered: ReturnType<typeof vi.fn>
  unregisterAccount: ReturnType<typeof vi.fn>
  noteSyncSuccess: ReturnType<typeof vi.fn>
  peekTrustOffer: ReturnType<typeof vi.fn>
  consumeTrustOffer: ReturnType<typeof vi.fn>
  noteProbedFingerprint: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
}

function makeCertRecoveryMock(): CertRecoveryServiceMock {
  return {
    ensureAccountRegistered: vi.fn(),
    unregisterAccount: vi.fn(),
    noteSyncSuccess: vi.fn(),
    // Default: main did open a dialog for this account + endpoint + certificate.
    peekTrustOffer: vi.fn(() => 'ok'),
    consumeTrustOffer: vi.fn(),
    noteProbedFingerprint: vi.fn(),
    dismiss: vi.fn(),
  }
}

// ─── Mirror: tls:getServerCert → offer wiring (electron/main.ts) ────────────
// The probe result is fed back into the open dialog's offer, so a later
// confirmation can be held against exactly what main put on screen.
async function getServerCertHandler(
  payload: unknown,
  deps: {
    fetchServerCertificate: (host: string, port: number) => Promise<ServerCert & { certPem?: string }>
    certRecovery: CertRecoveryServiceMock
    acquire: () => void
    release: () => void
  },
): Promise<{ fingerprintSha256: string }> {
  const parsed = tlsServerSchema.parse(payload)
  deps.acquire()
  try {
    const cert = await deps.fetchServerCertificate(parsed.host, parsed.port)
    deps.certRecovery.noteProbedFingerprint(parsed.host, parsed.port, cert.fingerprintSha256)
    return { fingerprintSha256: cert.fingerprintSha256 }
  } finally {
    deps.release()
  }
}

// ---------------------------------------------------------------------------
// Self-signed certificate fixture (CN=localhost, valid until 2126). Embedded
// rather than generated so the suite needs neither openssl nor RSA keygen —
// same fixture shape as packages/net/tls.test.ts.
// ---------------------------------------------------------------------------
const SELF_SIGNED_PEM = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUYng5+qY6Pz46P5ifBIu+lAFktvIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDcyNDE4MTgzN1oYDzIxMjYw
NjMwMTgxODM3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDF3DgKj1p4qNx9UWyatjUgvIGU93QAbuAq4c1a9UqM
Dj4TdkIhTNAn2TuD9J07KZkUPFlU5M0vOljU+Z/Agsk35FnNs6CKvQ9sKNUnFcEt
XwcRkZhzMeKRxSx5qQ8PoOxDiZwS6etyU9/9STOx8yiURpNlJ5SXWzp5Bl/7KcXt
INfjERMr28Uc51/plidqsfS1/4AMtk6ir9DvmZpl2WZPz0z4xwqOLBFzEb790URo
ENcCJ7QXQk5JV88Bl4Z5Rqs91hUln2lpZpwdhpIfDgaOTfo5NOTsxs3kTiG0QKbf
hCk26ow95V5n0ftSLQUl16WyfVTQxsI7LRqyHNAuoZKjAgMBAAGjbzBtMB0GA1Ud
DgQWBBSMTxdZnzw8MvXge35dWww4KdH4nDAfBgNVHSMEGDAWgBSMTxdZnzw8MvXg
e35dWww4KdH4nDAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAryaBVnesyINfE6tpzrAZCyf2z6c9
h8vK1yrDxZ44KaMUzANWouAIEjtJy39da8RvoFZdLL67CAlFmXMedc0cHUijspgh
vuL8qmUsrzYNAeg5gQpsbTsFfMgvJhAYHHimOwDj0KbikjVb+PZrWVAUZn6fHu1S
UP6vvf7JoDZz0a99xeUa3S3nzL0JT6b9+vXoL0AoV7vTfUA02zO5gaH1+r62QYbj
z8X97d/SjBh4NEJfO+hrky9+uj4/H1EKdjSxzScjmT5QMHenlq1Xboek5IRSiTkm
u2Ka43+yHsBbQMfubE4Ku4jiDZeMmJQEWFQEYErb1LrG09pC5nAbYnl/rg==
-----END CERTIFICATE-----
`

// ─── Mirror: pin certificate capture (electron/main.ts) ────────────────────
function normalizeFingerprintSha256(fpRaw: string): string {
  return (fpRaw || '').trim().toUpperCase().replace(/-/g, ':')
}

function peerCertificateToPem(cert: { raw?: Buffer } | null | undefined): string | undefined {
  const raw = cert?.raw
  if (!raw || raw.length === 0) return undefined
  try {
    return new X509Certificate(raw).toString()
  } catch {
    return undefined
  }
}

type PinCertCapture =
  | { status: 'captured'; pem: string }
  | { status: 'unavailable' }
  | { status: 'fingerprint-mismatch' }

type ServerCert = { fingerprintSha256: string; certPem?: string }

async function capturePinCertPem(
  host: string,
  port: number,
  expectedFingerprint: string,
  secure: boolean,
  fetchServerCertificate: (host: string, port: number) => Promise<ServerCert>,
): Promise<PinCertCapture> {
  if (!secure) return { status: 'unavailable' }
  try {
    const cert = await fetchServerCertificate(host, port)
    if (normalizeFingerprintSha256(cert.fingerprintSha256) !== normalizeFingerprintSha256(expectedFingerprint)) {
      return { status: 'fingerprint-mismatch' }
    }
    return cert.certPem ? { status: 'captured', pem: cert.certPem } : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

function pemTag(capture: PinCertCapture): 'captured' | 'unavailable' | 'mismatch' {
  if (capture.status === 'captured') return 'captured'
  if (capture.status === 'fingerprint-mismatch') return 'mismatch'
  return 'unavailable'
}

// ─── Mirror: toPinDto — IPC projection of a pin row (electron/main.ts) ──────
type PinRow = {
  id: number
  accountId: number
  host: string
  port: number
  fingerprintSha256: string
  certPem: string | null
  createdAt: string
}

function toPinDto(row: PinRow): Omit<PinRow, 'certPem'> & { hasCertPem: boolean } {
  const { certPem, ...rest } = row
  return { ...rest, hasCertPem: Boolean(certPem) }
}

// ─── Mirror: requireAccountConfig TLS assembly (electron/main.ts) ───────────
// Mirrors the pin/cert lookup and how both protocol configs are built.
function buildAccountTlsConfig(
  id: number,
  base: { imap: { host: string; port: number }; smtp: { host: string; port: number } },
  deps: {
    listTlsPinsForEndpoint: (id: number, host: string, port: number) => string[]
    listTlsPinnedCertsPemForEndpoint: (id: number, host: string, port: number) => string[]
  },
) {
  const imapPins = deps.listTlsPinsForEndpoint(id, base.imap.host, base.imap.port)
  const smtpPins = deps.listTlsPinsForEndpoint(id, base.smtp.host, base.smtp.port)
  const imapPinCerts = deps.listTlsPinnedCertsPemForEndpoint(id, base.imap.host, base.imap.port)
  const smtpPinCerts = deps.listTlsPinnedCertsPemForEndpoint(id, base.smtp.host, base.smtp.port)
  return {
    imap: { ...base.imap, tlsPinsSha256: imapPins, tlsPinnedCertsPem: imapPinCerts },
    smtp: { ...base.smtp, tlsPinsSha256: smtpPins, tlsPinnedCertsPem: smtpPinCerts },
  }
}

// ─── Mirror: net:trustCert handler (electron/main.ts) ──────────────────────
async function trustCertHandler(
  payload: unknown,
  deps: {
    getAccountMeta: (id: number) => EndpointMeta | undefined
    upsertTlsPin: (accountId: number, host: string, port: number, fp: string, pem: string | null) => void
    fetchServerCertificate: (host: string, port: number) => Promise<ServerCert>
    certRecovery: CertRecoveryServiceMock
    recordEvent: (name: string, tags: Record<string, unknown>) => void
    providerFromHost: (host: string) => string
    broadcast: (channel: string, payload: unknown) => number
    triggerAccountResync: (accountId: number) => void
  },
): Promise<{ ok: true }> {
  const parsed = certTrustSchema.parse(payload)
  const meta = deps.getAccountMeta(parsed.accountId)
  if (!meta) throw new Error(`Account #${parsed.accountId} not found`)
  const host = normalizeEndpointHost(parsed.host)
  const endpointKind = matchAccountTlsEndpoint(meta, host, parsed.port)
  if (!endpointKind) throw new Error('Certificate endpoint does not belong to this account')
  const fingerprint = canonicalFingerprintSha256(parsed.fingerprintSha256)
  // Gate 4 — authorization: main must have an outstanding trust offer for this
  // endpoint + certificate. Peek, do not consume.
  const offer = deps.certRecovery.peekTrustOffer(parsed.accountId, host, parsed.port, fingerprint)
  if (offer !== 'ok') {
    const reason = offer === 'fingerprint-mismatch' ? 'offer_fingerprint_mismatch' : 'no_pending_offer'
    try {
      deps.recordEvent('cert.trust_rejected', { provider: deps.providerFromHost(host), reason })
    } catch { /* telemetry must not block the trust flow */ }
    throw new Error('cert_trust_not_offered')
  }
  const secure = endpointKind === 'smtp' ? meta.smtp.secure : meta.imap.secure
  const capture = await capturePinCertPem(
    host, parsed.port, fingerprint, secure !== false, deps.fetchServerCertificate,
  )
  if (capture.status === 'fingerprint-mismatch') {
    try {
      deps.recordEvent('cert.trust_rejected', {
        provider: deps.providerFromHost(host), reason: 'fingerprint_mismatch',
      })
    } catch { /* telemetry must not block the trust flow */ }
    throw new Error('cert_trust_fingerprint_mismatch')
  }
  try {
    deps.upsertTlsPin(
      parsed.accountId, host, parsed.port, fingerprint,
      capture.status === 'captured' ? capture.pem : null,
    )
  } catch {
    try {
      deps.recordEvent('cert.trust_rejected', {
        provider: deps.providerFromHost(host), reason: 'pin_write_failed',
      })
    } catch { /* telemetry must not block the trust flow */ }
    throw new Error('cert_trust_pin_write_failed')
  }
  deps.certRecovery.consumeTrustOffer(parsed.accountId, host, parsed.port)
  try {
    deps.recordEvent('cert.trust_clicked', {
      provider: deps.providerFromHost(host), pem: pemTag(capture),
    })
  } catch { /* telemetry must not block the trust flow */ }
  deps.broadcast('accounts:changed', { kind: 'saved', id: parsed.accountId })
  deps.triggerAccountResync(parsed.accountId)
  return { ok: true as const }
}

// ─── Mirror: tls:addPin — narrows trust, never grants it (electron/main.ts) ─
async function addPinHandler(
  payload: unknown,
  deps: {
    getAccountMeta: (id: number) => EndpointMeta | undefined
    upsertTlsPin: (accountId: number, host: string, port: number, fp: string, pem: string | null) => PinRow
    fetchServerCertificate: (host: string, port: number) => Promise<ServerCert>
    broadcast: (channel: string, payload: unknown) => number
  },
): Promise<{ ok: true; pin: ReturnType<typeof toPinDto> }> {
  const parsed = tlsPinSchema.parse(payload)
  const meta = deps.getAccountMeta(parsed.accountId)
  if (!meta) throw new Error(`Account #${parsed.accountId} not found`)
  let row: PinRow
  try {
    // null, ALWAYS: this channel may not mint a trust anchor.
    row = deps.upsertTlsPin(parsed.accountId, parsed.host, parsed.port, parsed.fingerprintSha256, null)
  } catch {
    throw new Error('tls_pin_write_failed')
  }
  deps.broadcast('accounts:changed', { kind: 'saved', id: parsed.accountId })
  return { ok: true as const, pin: toPinDto(row) }
}

// ─── Mirror: cert:dismiss handler with the pending-dialog guard ─────────────
function dismissHandlerGuarded(
  payload: unknown,
  deps: { certRecovery: CertRecoveryServiceMock },
): { ok: true } {
  const parsed = certDismissSchema.parse(payload)
  const accepted = deps.certRecovery.dismiss(normalizeEndpointHost(parsed.host), parsed.port)
  if (!accepted) throw new Error('cert_dismiss_not_pending')
  return { ok: true as const }
}

// ─── Mirror: tls:getServerCert probe budget (electron/main.ts) ─────────────
const CERT_PROBE_MAX_CONCURRENT = 2
const CERT_PROBE_MAX_PER_WINDOW = 12
const CERT_PROBE_WINDOW_MS = 60_000

function makeProbeBudget(clock: () => number) {
  let inFlight = 0
  let windowStart = 0
  let windowCount = 0
  return {
    acquire(): void {
      const nowMs = clock()
      if (nowMs - windowStart >= CERT_PROBE_WINDOW_MS) {
        windowStart = nowMs
        windowCount = 0
      }
      if (inFlight >= CERT_PROBE_MAX_CONCURRENT) throw new Error('tls_probe_busy')
      if (windowCount >= CERT_PROBE_MAX_PER_WINDOW) throw new Error('tls_probe_rate_limited')
      inFlight++
      windowCount++
    },
    release(): void { inFlight = Math.max(0, inFlight - 1) },
    get inFlight() { return inFlight },
  }
}

// ─── Mirror: triggerAccountResync + deferred drain (electron/main.ts) ──────
// Mirrors the pair: an in-flight pass (started BEFORE the pin was stored, so
// it holds the pre-trust connection config) does not satisfy the resync — the
// account is flagged and gets exactly one pass once the slot is released.
type ResyncDeps = {
  shuttingDown: boolean
  isE2E: boolean
  workOffline: boolean
  inFlight: Set<number>
  pending: Set<number>
  runOneAccountPeriodicSync: (id: number) => Promise<void>
  schedule: (fn: () => void) => void
  onError: (err: unknown) => void
}

function triggerAccountResyncImpl(accountId: number, deps: ResyncDeps): void {
  try {
    if (deps.shuttingDown || deps.isE2E) return
    if (deps.workOffline) return
    if (deps.inFlight.has(accountId)) {
      deps.pending.add(accountId)
      return
    }
    void deps.runOneAccountPeriodicSync(accountId).catch(deps.onError)
  } catch (err) {
    deps.onError(err)
  }
}

function drainPendingPostTrustResyncImpl(accountId: number, deps: ResyncDeps): void {
  try {
    if (!deps.pending.delete(accountId)) return
    deps.schedule(() => triggerAccountResyncImpl(accountId, deps))
  } catch (err) {
    deps.onError(err)
  }
}

// ─── Mirror: cert:dismiss handler (electron/main.ts) ───────────────────────
function dismissHandler(
  payload: unknown,
  deps: { certRecovery: CertRecoveryServiceMock },
): { ok: true } {
  const parsed = certDismissSchema.parse(payload)
  deps.certRecovery.dismiss(normalizeEndpointHost(parsed.host), parsed.port)
  return { ok: true as const }
}

// ─── Mirror: requireAccountConfig lifecycle call (electron/main.ts) ────────
// requireAccountConfig calls certRecovery.ensureAccountRegistered(id) BEFORE
// resolving base config — the handler must exist before any IMAP operation
// that could hit a cert failure.
function requireAccountConfigEnsuresRegistration(
  id: number,
  deps: { certRecovery: CertRecoveryServiceMock; getAccountMeta: (id: number) => { id: number } | undefined },
): void {
  const meta = deps.getAccountMeta(id)
  if (!meta) throw new Error(`Account #${id} not found`)
  deps.certRecovery.ensureAccountRegistered(id)
}

// ─── Mirror: accounts:remove lifecycle call (electron/main.ts) ─────────────
function accountsRemoveUnregistersCert(
  id: number,
  deps: { certRecovery: CertRecoveryServiceMock },
): void {
  deps.certRecovery.unregisterAccount(id)
}

// ---------------------------------------------------------------------------
// Tests: net:trustCert
// ---------------------------------------------------------------------------

describe('main.ts TLS trust rework — net:trustCert handler', () => {
  const FP_COLONS = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:' +
    'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
  const FP_BARE = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'
  const validPayload = {
    accountId: 42,
    host: 'imap.example.com',
    port: 993,
    fingerprintSha256: FP_COLONS,
  }
  const accountMeta: EndpointMeta = {
    imap: { host: 'imap.example.com', port: 993, secure: true },
    smtp: { host: 'smtp.example.com', port: 465, secure: true },
  }

  let certRecovery: CertRecoveryServiceMock
  let upsertTlsPin: ReturnType<typeof vi.fn>
  let fetchServerCertificate: ReturnType<typeof vi.fn>
  let recordEvent: ReturnType<typeof vi.fn>
  let broadcast: ReturnType<typeof vi.fn>
  let getAccountMeta: ReturnType<typeof vi.fn>
  let triggerAccountResync: ReturnType<typeof vi.fn>

  function run(payload: unknown) {
    return trustCertHandler(payload, {
      getAccountMeta: getAccountMeta as unknown as (id: number) => EndpointMeta | undefined,
      upsertTlsPin: upsertTlsPin as unknown as
        (accountId: number, host: string, port: number, fp: string, pem: string | null) => void,
      fetchServerCertificate: fetchServerCertificate as unknown as
        (host: string, port: number) => Promise<ServerCert>,
      certRecovery, recordEvent,
      providerFromHost: () => 'other',
      broadcast: broadcast as unknown as (channel: string, payload: unknown) => number,
      triggerAccountResync,
    })
  }

  beforeEach(() => {
    certRecovery = makeCertRecoveryMock()
    upsertTlsPin = vi.fn()
    // Default: the endpoint still serves the certificate the dialog showed.
    fetchServerCertificate = vi.fn(async () => ({
      fingerprintSha256: FP_COLONS,
      certPem: SELF_SIGNED_PEM,
    }))
    recordEvent = vi.fn()
    broadcast = vi.fn(() => 1)
    getAccountMeta = vi.fn().mockReturnValue(accountMeta)
    triggerAccountResync = vi.fn()
  })

  it('happy path: persists the pin WITH the certificate PEM, marks trusted, broadcasts and resyncs', async () => {
    const result = await run(validPayload)

    expect(result).toEqual({ ok: true })
    expect(upsertTlsPin).toHaveBeenCalledWith(42, 'imap.example.com', 993, FP_COLONS, SELF_SIGNED_PEM)
    expect(certRecovery.consumeTrustOffer).toHaveBeenCalledWith(42, 'imap.example.com', 993)
    expect(recordEvent).toHaveBeenCalledWith('cert.trust_clicked', { provider: 'other', pem: 'captured' })
    expect(broadcast).toHaveBeenCalledWith('accounts:changed', { kind: 'saved', id: 42 })
  })

  it('captures the certificate from the endpoint being pinned', async () => {
    await run(validPayload)

    expect(fetchServerCertificate).toHaveBeenCalledWith('imap.example.com', 993)
  })

  it('refuses to pin when main never opened a dialog for this endpoint', async () => {
    certRecovery.peekTrustOffer.mockReturnValue('no-offer')

    await expect(run(validPayload)).rejects.toThrow('cert_trust_not_offered')

    // Not even a probe: an unauthorized caller gets no network side effect.
    expect(fetchServerCertificate).not.toHaveBeenCalled()
    expect(upsertTlsPin).not.toHaveBeenCalled()
    expect(certRecovery.consumeTrustOffer).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(triggerAccountResync).not.toHaveBeenCalled()
    expect(recordEvent).toHaveBeenCalledWith('cert.trust_rejected', {
      provider: 'other', reason: 'no_pending_offer',
    })
  })

  it('refuses to pin a certificate the dialog did not show', async () => {
    certRecovery.peekTrustOffer.mockReturnValue('fingerprint-mismatch')

    await expect(run(validPayload)).rejects.toThrow('cert_trust_not_offered')

    expect(upsertTlsPin).not.toHaveBeenCalled()
    expect(recordEvent).toHaveBeenCalledWith('cert.trust_rejected', {
      provider: 'other', reason: 'offer_fingerprint_mismatch',
    })
  })

  it('checks the offer against the account, canonical endpoint and fingerprint', async () => {
    await run({ ...validPayload, host: '  IMAP.Example.COM.  ', fingerprintSha256: FP_BARE })

    expect(certRecovery.peekTrustOffer).toHaveBeenCalledWith(42, 'imap.example.com', 993, FP_COLONS)
  })

  it('burns the offer under the same account that redeemed it', async () => {
    await run(validPayload)

    expect(certRecovery.consumeTrustOffer).toHaveBeenCalledWith(42, 'imap.example.com', 993)
  })

  it('does not burn the offer when the pin write fails (user can retry)', async () => {
    upsertTlsPin.mockImplementation(() => { throw new Error('pin store down') })

    await expect(run(validPayload)).rejects.toThrow('cert_trust_pin_write_failed')

    expect(certRecovery.consumeTrustOffer).not.toHaveBeenCalled()
  })

  it('does not burn the offer when the certificate rotated (user can retry)', async () => {
    fetchServerCertificate.mockResolvedValue({
      fingerprintSha256: FP_COLONS.replace(/^AA/, 'BB'), certPem: SELF_SIGNED_PEM,
    })

    await expect(run(validPayload)).rejects.toThrow('cert_trust_fingerprint_mismatch')

    expect(certRecovery.consumeTrustOffer).not.toHaveBeenCalled()
  })

  it('rejects the pin when the served certificate no longer matches the shown fingerprint', async () => {
    const rotated = FP_COLONS.replace(/^AA/, 'BB')
    fetchServerCertificate.mockResolvedValue({ fingerprintSha256: rotated, certPem: SELF_SIGNED_PEM })

    await expect(run(validPayload)).rejects.toThrow('cert_trust_fingerprint_mismatch')

    // Nothing is stored and nothing downstream runs — the dialog stays open
    // with an inline error instead of silently doing nothing.
    expect(upsertTlsPin).not.toHaveBeenCalled()
    expect(certRecovery.consumeTrustOffer).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(triggerAccountResync).not.toHaveBeenCalled()
    expect(recordEvent).toHaveBeenCalledWith('cert.trust_rejected', {
      provider: 'other', reason: 'fingerprint_mismatch',
    })
  })

  it('surfaces a pin-store rejection instead of reporting success', async () => {
    upsertTlsPin.mockImplementation(() => {
      throw new Error('TLS pin certificate does not match the pinned fingerprint')
    })

    await expect(run(validPayload)).rejects.toThrow('cert_trust_pin_write_failed')

    expect(certRecovery.consumeTrustOffer).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(triggerAccountResync).not.toHaveBeenCalled()
    expect(recordEvent).toHaveBeenCalledWith('cert.trust_rejected', {
      provider: 'other', reason: 'pin_write_failed',
    })
  })

  it('does not leak the pin-store error text to the renderer', async () => {
    upsertTlsPin.mockImplementation(() => { throw new Error('TLS pin certificate is too large') })

    await expect(run(validPayload)).rejects.toThrow(/^cert_trust_pin_write_failed$/)
  })

  it('stores a fingerprint-only pin when the endpoint is unreachable (non-regressive)', async () => {
    fetchServerCertificate.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await run(validPayload)

    expect(result).toEqual({ ok: true })
    expect(upsertTlsPin).toHaveBeenCalledWith(42, 'imap.example.com', 993, FP_COLONS, null)
    expect(recordEvent).toHaveBeenCalledWith('cert.trust_clicked', { provider: 'other', pem: 'unavailable' })
  })

  it('skips the capture probe entirely on a STARTTLS endpoint', async () => {
    getAccountMeta.mockReturnValue({
      imap: { host: 'imap.example.com', port: 143, secure: false },
      smtp: { host: 'smtp.example.com', port: 587, secure: false },
    })

    const result = await run({ ...validPayload, port: 143 })

    expect(result).toEqual({ ok: true })
    expect(fetchServerCertificate).not.toHaveBeenCalled()
    expect(upsertTlsPin).toHaveBeenCalledWith(42, 'imap.example.com', 143, FP_COLONS, null)
  })

  it('stores a fingerprint-only pin when the probe returns no certificate body', async () => {
    fetchServerCertificate.mockResolvedValue({ fingerprintSha256: FP_COLONS })

    await run(validPayload)

    expect(upsertTlsPin).toHaveBeenCalledWith(42, 'imap.example.com', 993, FP_COLONS, null)
  })

  it('compares fingerprints in canonical form (dash-separated probe result still matches)', async () => {
    fetchServerCertificate.mockResolvedValue({
      fingerprintSha256: FP_COLONS.replace(/:/g, '-').toLowerCase(),
      certPem: SELF_SIGNED_PEM,
    })

    await run(validPayload)

    expect(upsertTlsPin).toHaveBeenCalledWith(42, 'imap.example.com', 993, FP_COLONS, SELF_SIGNED_PEM)
  })

  it('triggers the per-account resync exactly once', async () => {
    await run(validPayload)

    expect(triggerAccountResync).toHaveBeenCalledTimes(1)
    expect(triggerAccountResync).toHaveBeenCalledWith(42)
  })

  it('accepts the account SMTP endpoint too', async () => {
    await run({ ...validPayload, host: 'smtp.example.com', port: 465 })

    expect(upsertTlsPin).toHaveBeenCalledWith(42, 'smtp.example.com', 465, FP_COLONS, SELF_SIGNED_PEM)
  })

  it('rejects an endpoint that does not belong to the account (host mismatch)', async () => {
    await expect(run({ ...validPayload, host: 'imap.evil.example' }))
      .rejects.toThrow('Certificate endpoint does not belong to this account')

    expect(upsertTlsPin).not.toHaveBeenCalled()
    expect(certRecovery.consumeTrustOffer).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(triggerAccountResync).not.toHaveBeenCalled()
  })

  it('rejects the right host on the wrong port (stale dialog payload)', async () => {
    await expect(run({ ...validPayload, port: 143 }))
      .rejects.toThrow('Certificate endpoint does not belong to this account')

    expect(upsertTlsPin).not.toHaveBeenCalled()
  })

  it('normalizes host case/trailing dot before the ownership check and the pin write', async () => {
    await run({ ...validPayload, host: '  IMAP.Example.COM.  ' })

    expect(upsertTlsPin).toHaveBeenCalledWith(42, 'imap.example.com', 993, FP_COLONS, SELF_SIGNED_PEM)
    expect(certRecovery.consumeTrustOffer).toHaveBeenCalledWith(42, 'imap.example.com', 993)
  })

  it('canonicalizes a bare 64-hex fingerprint to uppercase colon-grouped form', async () => {
    await run({ ...validPayload, fingerprintSha256: FP_BARE })

    expect(upsertTlsPin).toHaveBeenCalledWith(42, 'imap.example.com', 993, FP_COLONS, SELF_SIGNED_PEM)
  })

  it('canonicalizes a dash-separated fingerprint', async () => {
    await run({ ...validPayload, fingerprintSha256: FP_COLONS.replace(/:/g, '-').toLowerCase() })

    expect(upsertTlsPin).toHaveBeenCalledWith(42, 'imap.example.com', 993, FP_COLONS, SELF_SIGNED_PEM)
  })

  it('throws and does nothing else when the account does not exist', async () => {
    getAccountMeta.mockReturnValue(undefined)

    await expect(run(validPayload)).rejects.toThrow('Account #42 not found')

    expect(upsertTlsPin).not.toHaveBeenCalled()
    expect(certRecovery.consumeTrustOffer).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(triggerAccountResync).not.toHaveBeenCalled()
  })

  it('call order: consumeTrustOffer → broadcast → resync', async () => {
    const order: string[] = []
    certRecovery.consumeTrustOffer.mockImplementation(() => order.push('consumeTrustOffer'))
    broadcast.mockImplementation(() => { order.push('broadcast'); return 1 })
    triggerAccountResync.mockImplementation(() => order.push('resync'))

    await run(validPayload)

    expect(order).toEqual(['consumeTrustOffer', 'broadcast', 'resync'])
  })

  it('a throwing recordEvent does not prevent the resync (telemetry fire-and-forget)', async () => {
    recordEvent.mockImplementation(() => { throw new Error('telemetry outage') })

    const result = await run(validPayload)

    expect(result).toEqual({ ok: true })
    expect(broadcast).toHaveBeenCalledWith('accounts:changed', { kind: 'saved', id: 42 })
    expect(triggerAccountResync).toHaveBeenCalledWith(42)
  })

  it('rejects a payload with an extra unknown field (schema is .strict())', async () => {
    await expect(run({ ...validPayload, extra: 'field' })).rejects.toThrow()

    expect(upsertTlsPin).not.toHaveBeenCalled()
  })

  it('rejects a non-positive port', async () => {
    await expect(run({ ...validPayload, port: 0 })).rejects.toThrow()
  })

  it('rejects a port above 65535', async () => {
    await expect(run({ ...validPayload, port: 70000 })).rejects.toThrow()
    await expect(run({ ...validPayload, port: 65536 })).rejects.toThrow()

    expect(upsertTlsPin).not.toHaveBeenCalled()
  })

  it('accepts port 65535 (boundary)', async () => {
    getAccountMeta.mockReturnValue({
      imap: { host: 'imap.example.com', port: 65535 },
      smtp: { host: 'smtp.example.com', port: 465 },
    })

    await expect(run({ ...validPayload, port: 65535 })).resolves.toEqual({ ok: true })
  })

  it('rejects an empty fingerprint', async () => {
    await expect(run({ ...validPayload, fingerprintSha256: '' })).rejects.toThrow()
  })

  it('rejects malformed SHA-256 fingerprints', async () => {
    const malformed = [
      'AA:BB:CC:DD',                                   // too short (old lax shape)
      FP_BARE.slice(0, 63),                            // 63 hex chars
      `${FP_BARE}aa`,                                  // 66 hex chars
      FP_BARE.replace('a', 'z'),                       // non-hex character
      `${FP_COLONS}:AA`,                               // 33 groups
      FP_COLONS.replace(/:/g, ' '),                    // space separated
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99', // SHA-1 length
    ]
    for (const fingerprintSha256 of malformed) {
      await expect(run({ ...validPayload, fingerprintSha256 })).rejects.toThrow()
    }
    expect(upsertTlsPin).not.toHaveBeenCalled()
  })

  it('rejects a host longer than 253 characters', async () => {
    await expect(run({ ...validPayload, host: `${'a'.repeat(250)}.example.com` })).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Tests: triggerAccountResync (the functional gap the broadcast alone left)
// ---------------------------------------------------------------------------

describe('main.ts TLS trust rework — triggerAccountResync', () => {
  /** Deferred passes queue here instead of running; `runScheduled` plays them.
   *  ONE object is returned (no spread copy) so a test mutating a gate — e.g.
   *  `deps.workOffline = true` — is observed by the already-scheduled call. */
  function makeDeps(overrides?: Partial<ResyncDeps>): ResyncDeps & { runScheduled: () => void } {
    const scheduled: Array<() => void> = []
    return {
      shuttingDown: false,
      isE2E: false,
      workOffline: false,
      inFlight: new Set<number>(),
      pending: new Set<number>(),
      runOneAccountPeriodicSync: vi.fn(async () => {}),
      schedule: (fn: () => void) => { scheduled.push(fn) },
      onError: vi.fn(),
      runScheduled: () => {
        const queued = scheduled.splice(0)
        for (const fn of queued) fn()
      },
      ...overrides,
    }
  }

  it('starts exactly one sync pass for the account', () => {
    const deps = makeDeps()

    triggerAccountResyncImpl(42, deps)

    expect(deps.runOneAccountPeriodicSync).toHaveBeenCalledTimes(1)
    expect(deps.runOneAccountPeriodicSync).toHaveBeenCalledWith(42)
    expect(deps.pending.size).toBe(0)
  })

  it('defers instead of dropping when a pass is already in flight', () => {
    // That pass started BEFORE the pin was stored — it carries the old config
    // without the new trust anchor, so it cannot satisfy this resync.
    const deps = makeDeps({ inFlight: new Set<number>([42]) })

    triggerAccountResyncImpl(42, deps)

    expect(deps.runOneAccountPeriodicSync).not.toHaveBeenCalled()
    expect(deps.pending.has(42)).toBe(true)
  })

  it('runs the deferred pass exactly once when the in-flight pass finishes', () => {
    const deps = makeDeps({ inFlight: new Set<number>([42]) })

    triggerAccountResyncImpl(42, deps)
    // The pass ends: slot released, then the drain runs.
    deps.inFlight.delete(42)
    drainPendingPostTrustResyncImpl(42, deps)
    deps.runScheduled()

    expect(deps.runOneAccountPeriodicSync).toHaveBeenCalledTimes(1)
    expect(deps.runOneAccountPeriodicSync).toHaveBeenCalledWith(42)
    expect(deps.pending.size).toBe(0)
  })

  it('collapses repeated confirmations during one pass into a single deferred pass', () => {
    const deps = makeDeps({ inFlight: new Set<number>([42]) })

    triggerAccountResyncImpl(42, deps)
    triggerAccountResyncImpl(42, deps)
    triggerAccountResyncImpl(42, deps)
    expect(deps.pending.size).toBe(1)

    deps.inFlight.delete(42)
    drainPendingPostTrustResyncImpl(42, deps)
    deps.runScheduled()

    expect(deps.runOneAccountPeriodicSync).toHaveBeenCalledTimes(1)
  })

  it('the deferred pass does not re-arm itself (no resync loop)', () => {
    const deps = makeDeps({ inFlight: new Set<number>([42]) })

    triggerAccountResyncImpl(42, deps)
    deps.inFlight.delete(42)
    drainPendingPostTrustResyncImpl(42, deps)
    deps.runScheduled()
    // A second drain after the deferred pass ends finds nothing pending.
    drainPendingPostTrustResyncImpl(42, deps)
    deps.runScheduled()

    expect(deps.runOneAccountPeriodicSync).toHaveBeenCalledTimes(1)
  })

  it('drain is a no-op for an account that never deferred', () => {
    const deps = makeDeps()

    drainPendingPostTrustResyncImpl(42, deps)
    deps.runScheduled()

    expect(deps.runOneAccountPeriodicSync).not.toHaveBeenCalled()
  })

  it('deferred passes are per account', () => {
    const deps = makeDeps({ inFlight: new Set<number>([42, 7]) })

    triggerAccountResyncImpl(42, deps)
    deps.inFlight.delete(42)
    drainPendingPostTrustResyncImpl(42, deps)
    deps.runScheduled()

    expect(deps.runOneAccountPeriodicSync).toHaveBeenCalledTimes(1)
    expect(deps.runOneAccountPeriodicSync).toHaveBeenCalledWith(42)
    expect(deps.pending.has(7)).toBe(false)
  })

  it('skips while offline, while shutting down and under E2E', () => {
    for (const override of [{ workOffline: true }, { shuttingDown: true }, { isE2E: true }]) {
      const deps = makeDeps(override)
      triggerAccountResyncImpl(42, deps)
      expect(deps.runOneAccountPeriodicSync).not.toHaveBeenCalled()
      // Gated before the deferral too — no pass is queued for later.
      expect(deps.pending.size).toBe(0)
    }
  })

  it('re-evaluates the gates at drain time (user went offline while the pass drained)', () => {
    const deps = makeDeps({ inFlight: new Set<number>([42]) })

    triggerAccountResyncImpl(42, deps)
    deps.workOffline = true
    deps.inFlight.delete(42)
    drainPendingPostTrustResyncImpl(42, deps)
    deps.runScheduled()

    expect(deps.runOneAccountPeriodicSync).not.toHaveBeenCalled()
  })

  it('contains a rejected sync pass instead of surfacing an unhandled rejection', async () => {
    const deps = makeDeps({
      runOneAccountPeriodicSync: vi.fn(async () => { throw new Error('IMAP down') }),
    })

    expect(() => triggerAccountResyncImpl(42, deps)).not.toThrow()
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(deps.onError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('contains a synchronous throw from the sync entry point', () => {
    const deps = makeDeps({
      runOneAccountPeriodicSync: (() => { throw new Error('boom') }) as unknown as
        (id: number) => Promise<void>,
    })

    expect(() => triggerAccountResyncImpl(42, deps)).not.toThrow()
    expect(deps.onError).toHaveBeenCalledWith(expect.any(Error))
  })
})

// ---------------------------------------------------------------------------
// Tests: broadcast() recipient counting
// ---------------------------------------------------------------------------

describe('main.ts broadcast() recipient count', () => {
  it('returns the number of live windows that received the message', () => {
    const send = vi.fn()
    const windows: FakeWindow[] = [
      { destroyed: false, send },
      { destroyed: true, send },
      { destroyed: false, send },
    ]

    expect(broadcastTo(windows, 'cert:recoveryRequired', { a: 1 })).toBe(2)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('returns 0 when there is no live window (one-shot UX must not be marked shown)', () => {
    expect(broadcastTo([], 'cert:interceptionNotice', {})).toBe(0)
    expect(broadcastTo([{ destroyed: true, send: vi.fn() }], 'cert:interceptionNotice', {})).toBe(0)
  })

  it('does not count a window that threw during send (destroyed mid-loop)', () => {
    const windows: FakeWindow[] = [
      { destroyed: false, send: () => { throw new Error('window gone') } },
      { destroyed: false, send: vi.fn() },
    ]

    expect(broadcastTo(windows, 'x', {})).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: atomic persistence of the interception-notice host list
// ---------------------------------------------------------------------------

describe('main.ts cert notice store — atomic write', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cert-notice-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips the host list and leaves no temporary file behind', () => {
    persistCertNoticeShownHosts(dir, ['imap.example.com', 'imap.example.com', 'mail.other.test'])

    expect(loadCertNoticeShownHosts(dir)).toEqual(['imap.example.com', 'mail.other.test'])
    expect(fs.readdirSync(dir)).toEqual([CERT_NOTICE_STORE_FILE])
  })

  it('a crash mid-write leaves the PREVIOUS list intact (no truncated final file)', () => {
    persistCertNoticeShownHosts(dir, ['first.example.com'])

    // Simulate a crash / ENOSPC after a partial write into the temp file.
    expect(() => persistCertNoticeShownHosts(dir, ['second.example.com'], (p, data) => {
      fs.writeFileSync(p, data.slice(0, 5), 'utf8')
      throw new Error('ENOSPC')
    })).toThrow('ENOSPC')

    // The reader still sees the complete previous list, not "nothing shown yet".
    expect(loadCertNoticeShownHosts(dir)).toEqual(['first.example.com'])
    expect(fs.readdirSync(dir)).toEqual([CERT_NOTICE_STORE_FILE])
  })

  it('a truncated final file still degrades to an empty list (loader contract)', () => {
    fs.writeFileSync(path.join(dir, CERT_NOTICE_STORE_FILE), '["imap.exa', 'utf8')

    expect(loadCertNoticeShownHosts(dir)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Tests: tls:addPin may narrow trust, never grant it
// ---------------------------------------------------------------------------

describe('main.ts tls:addPin — separation of powers', () => {
  const meta: EndpointMeta = {
    imap: { host: 'imap.example.com', port: 993, secure: true },
    smtp: { host: 'smtp.example.com', port: 465, secure: true },
  }
  const payload = {
    accountId: 42, host: 'imap.example.com', port: 993, fingerprintSha256: 'AA:BB:CC:DD',
  }

  function makeDeps() {
    const upsertTlsPin = vi.fn((accountId: number, host: string, port: number, fp: string): PinRow => ({
      id: 1, accountId, host, port, fingerprintSha256: fp, certPem: null,
      createdAt: '2026-07-25T00:00:00Z',
    }))
    return {
      getAccountMeta: vi.fn(() => meta),
      upsertTlsPin,
      fetchServerCertificate: vi.fn(async () => ({
        fingerprintSha256: 'AA:BB:CC:DD', certPem: SELF_SIGNED_PEM,
      })),
      broadcast: vi.fn(() => 1),
    }
  }

  it('NEVER stores a certificate body, even when the endpoint serves a matching one', async () => {
    const deps = makeDeps()

    await addPinHandler(payload, deps)

    expect(deps.upsertTlsPin).toHaveBeenCalledWith(42, 'imap.example.com', 993, 'AA:BB:CC:DD', null)
  })

  it('does not probe the endpoint at all (no renderer-driven capture path)', async () => {
    const deps = makeDeps()

    await addPinHandler(payload, deps)

    expect(deps.fetchServerCertificate).not.toHaveBeenCalled()
  })

  it('still records the pin and asks the renderer to refresh', async () => {
    const deps = makeDeps()

    const result = await addPinHandler(payload, deps)

    expect(result.ok).toBe(true)
    expect(result.pin.hasCertPem).toBe(false)
    expect(deps.broadcast).toHaveBeenCalledWith('accounts:changed', { kind: 'saved', id: 42 })
  })

  it('rejects an unknown account', async () => {
    const deps = makeDeps()
    deps.getAccountMeta.mockReturnValue(undefined as unknown as EndpointMeta)

    await expect(addPinHandler(payload, deps)).rejects.toThrow('Account #42 not found')
    expect(deps.upsertTlsPin).not.toHaveBeenCalled()
  })

  it('surfaces a pin-store rejection without leaking its message', async () => {
    const deps = makeDeps()
    deps.upsertTlsPin.mockImplementation(() => { throw new Error('TLS pin host is required') })

    await expect(addPinHandler(payload, deps)).rejects.toThrow(/^tls_pin_write_failed$/)
  })
})

// ---------------------------------------------------------------------------
// Tests: tls:getServerCert feeds the open dialog's offer
// ---------------------------------------------------------------------------

describe('main.ts tls:getServerCert — probe result reaches the trust offer', () => {
  function makeDeps() {
    return {
      fetchServerCertificate: vi.fn(async () => ({ fingerprintSha256: 'DD:EE:FF' })),
      certRecovery: makeCertRecoveryMock(),
      acquire: vi.fn(),
      release: vi.fn(),
    }
  }

  it('records the fingerprint it just handed out', async () => {
    const deps = makeDeps()

    const res = await getServerCertHandler({ host: 'imap.example.com', port: 993 }, deps)

    expect(res.fingerprintSha256).toBe('DD:EE:FF')
    expect(deps.certRecovery.noteProbedFingerprint)
      .toHaveBeenCalledWith('imap.example.com', 993, 'DD:EE:FF')
  })

  it('records nothing when the probe fails', async () => {
    const deps = makeDeps()
    deps.fetchServerCertificate.mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(getServerCertHandler({ host: 'imap.example.com', port: 993 }, deps)).rejects.toThrow()

    expect(deps.certRecovery.noteProbedFingerprint).not.toHaveBeenCalled()
    expect(deps.release).toHaveBeenCalledTimes(1)
  })

  it('passes the exact endpoint through — a probe cannot fill another dialog', async () => {
    const deps = makeDeps()

    await getServerCertHandler({ host: 'other.example.com', port: 465 }, deps)

    expect(deps.certRecovery.noteProbedFingerprint)
      .toHaveBeenCalledWith('other.example.com', 465, 'DD:EE:FF')
  })
})

// ---------------------------------------------------------------------------
// Tests: tls:getServerCert probe budget (scanning / socket exhaustion)
// ---------------------------------------------------------------------------

describe('main.ts tls:getServerCert — bounded probe surface', () => {
  it('rejects an out-of-range port', () => {
    expect(() => tlsServerSchema.parse({ host: 'imap.example.com', port: 70000 })).toThrow()
    expect(() => tlsServerSchema.parse({ host: 'imap.example.com', port: 65536 })).toThrow()
    expect(() => tlsServerSchema.parse({ host: 'imap.example.com', port: 0 })).toThrow()
    expect(() => tlsServerSchema.parse({ host: 'imap.example.com', port: -1 })).toThrow()
  })

  it('rejects an over-long host and an empty host', () => {
    expect(() => tlsServerSchema.parse({ host: 'a'.repeat(254), port: 993 })).toThrow()
    expect(() => tlsServerSchema.parse({ host: '   ', port: 993 })).toThrow()
  })

  it('accepts the boundary values', () => {
    expect(tlsServerSchema.parse({ host: 'a'.repeat(253), port: 65535 }).port).toBe(65535)
    expect(tlsServerSchema.parse({ host: 'imap.example.com', port: 1 }).port).toBe(1)
  })

  it('caps concurrent probes (parallel socket / slot exhaustion)', () => {
    const budget = makeProbeBudget(() => 1_000_000)

    budget.acquire()
    budget.acquire()
    expect(() => budget.acquire()).toThrow('tls_probe_busy')

    budget.release()
    expect(() => budget.acquire()).not.toThrow()
  })

  it('caps the probe rate over the window (slow sequential scanning)', () => {
    let clock = 1_000_000
    const budget = makeProbeBudget(() => clock)

    for (let i = 0; i < CERT_PROBE_MAX_PER_WINDOW; i++) {
      budget.acquire()
      budget.release()
    }
    expect(() => budget.acquire()).toThrow('tls_probe_rate_limited')

    // The window rolls over and legitimate use resumes.
    clock += CERT_PROBE_WINDOW_MS
    expect(() => budget.acquire()).not.toThrow()
  })

  it('releases the slot even when the probe throws', () => {
    const budget = makeProbeBudget(() => 1_000_000)

    budget.acquire()
    try {
      throw new Error('ECONNREFUSED')
    } catch { /* handler finally */ } finally {
      budget.release()
    }

    expect(budget.inFlight).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: peer certificate → PEM (the body that becomes the trust anchor)
// ---------------------------------------------------------------------------

describe('main.ts peerCertificateToPem', () => {
  const der = new X509Certificate(SELF_SIGNED_PEM).raw

  it('derives a PEM from the same DER bytes the fingerprint was computed over', () => {
    const pem = peerCertificateToPem({ raw: der })

    expect(pem).toBeDefined()
    // Round-trips to the identical certificate — this identity is what makes
    // the pin store's PEM↔fingerprint cross-check pass by construction.
    const reparsed = new X509Certificate(pem!)
    expect(reparsed.fingerprint256).toBe(new X509Certificate(SELF_SIGNED_PEM).fingerprint256)
    expect(pem).toContain('-----BEGIN CERTIFICATE-----')
    expect(pem).toContain('-----END CERTIFICATE-----')
  })

  it('returns undefined for a certificate without raw bytes', () => {
    expect(peerCertificateToPem(null)).toBeUndefined()
    expect(peerCertificateToPem(undefined)).toBeUndefined()
    expect(peerCertificateToPem({})).toBeUndefined()
    expect(peerCertificateToPem({ raw: Buffer.alloc(0) })).toBeUndefined()
  })

  it('returns undefined for unparseable DER instead of throwing', () => {
    expect(peerCertificateToPem({ raw: Buffer.from('not a certificate') })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: the certificate body never crosses to the renderer
// ---------------------------------------------------------------------------

describe('main.ts pin IPC projection', () => {
  const row = (certPem: string | null): PinRow => ({
    id: 1,
    accountId: 42,
    host: 'imap.example.com',
    port: 993,
    fingerprintSha256: 'AA:BB',
    certPem,
    createdAt: '2026-07-24T00:00:00Z',
  })

  it('strips certPem and exposes a boolean instead', () => {
    const dto = toPinDto(row(SELF_SIGNED_PEM))

    expect(dto).not.toHaveProperty('certPem')
    expect(JSON.stringify(dto)).not.toContain('BEGIN CERTIFICATE')
    expect(dto.hasCertPem).toBe(true)
    expect(dto.fingerprintSha256).toBe('AA:BB')
  })

  it('reports hasCertPem=false for a fingerprint-only pin', () => {
    expect(toPinDto(row(null)).hasCertPem).toBe(false)
  })

  it('tls:listPins projects every row (no certificate body in the payload)', () => {
    const dtos = [row(SELF_SIGNED_PEM), row(null)].map(toPinDto)

    expect(JSON.stringify(dtos)).not.toContain('BEGIN CERTIFICATE')
    expect(dtos.map((d) => d.hasCertPem)).toEqual([true, false])
  })
})

// ---------------------------------------------------------------------------
// Tests: pinned certificates reach the connection config (the whole point)
// ---------------------------------------------------------------------------

describe('main.ts requireAccountConfig — pinned certificate bodies', () => {
  const base = {
    imap: { host: 'imap.example.com', port: 993 },
    smtp: { host: 'smtp.example.com', port: 465 },
  }

  it('puts tlsPinnedCertsPem on BOTH protocol configs, per endpoint', () => {
    const listTlsPinnedCertsPemForEndpoint = vi.fn((_id: number, host: string) => (
      host === 'imap.example.com' ? [SELF_SIGNED_PEM] : ['smtp-pem']
    ))
    const cfg = buildAccountTlsConfig(42, base, {
      listTlsPinsForEndpoint: vi.fn(() => ['AA:BB']),
      listTlsPinnedCertsPemForEndpoint,
    })

    expect(cfg.imap.tlsPinnedCertsPem).toEqual([SELF_SIGNED_PEM])
    expect(cfg.smtp.tlsPinnedCertsPem).toEqual(['smtp-pem'])
    // Looked up per endpoint — the SMTP config must not inherit IMAP anchors.
    expect(listTlsPinnedCertsPemForEndpoint).toHaveBeenCalledWith(42, 'imap.example.com', 993)
    expect(listTlsPinnedCertsPemForEndpoint).toHaveBeenCalledWith(42, 'smtp.example.com', 465)
  })

  it('keeps the fingerprint pins alongside the certificate bodies', () => {
    const cfg = buildAccountTlsConfig(42, base, {
      listTlsPinsForEndpoint: vi.fn(() => ['AA:BB']),
      listTlsPinnedCertsPemForEndpoint: vi.fn(() => [SELF_SIGNED_PEM]),
    })

    expect(cfg.imap.tlsPinsSha256).toEqual(['AA:BB'])
    expect(cfg.smtp.tlsPinsSha256).toEqual(['AA:BB'])
  })

  it('empty anchor list for pins created before capture landed (fail-closed preserved)', () => {
    const cfg = buildAccountTlsConfig(42, base, {
      listTlsPinsForEndpoint: vi.fn(() => ['AA:BB']),
      listTlsPinnedCertsPemForEndpoint: vi.fn(() => []),
    })

    expect(cfg.imap.tlsPinnedCertsPem).toEqual([])
    expect(cfg.smtp.tlsPinnedCertsPem).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Tests: cert:dismiss
// ---------------------------------------------------------------------------

describe('main.ts TLS trust rework — cert:dismiss pending-dialog guard', () => {
  it('rejects a dismiss for an endpoint with no dialog pending (no pre-muting)', () => {
    const certRecovery = makeCertRecoveryMock()
    certRecovery.dismiss.mockReturnValue(false)

    // Otherwise a renderer could silence a warning the user never saw.
    expect(() => dismissHandlerGuarded({ host: 'imap.example.com' }, { certRecovery }))
      .toThrow('cert_dismiss_not_pending')
  })

  it('accepts a dismiss for an endpoint that is actually awaiting the user', () => {
    const certRecovery = makeCertRecoveryMock()
    certRecovery.dismiss.mockReturnValue(true)

    expect(dismissHandlerGuarded({ host: 'imap.example.com', port: 993 }, { certRecovery }))
      .toEqual({ ok: true })
    expect(certRecovery.dismiss).toHaveBeenCalledWith('imap.example.com', 993)
  })

  it('still accepts the renderer retry of an already-answered dialog', () => {
    // The service reports `true` inside the debounce window, so the retry the
    // renderer performs after a lost round-trip does not surface an error.
    const certRecovery = makeCertRecoveryMock()
    certRecovery.dismiss.mockReturnValue(true)

    expect(dismissHandlerGuarded({ host: 'imap.example.com' }, { certRecovery })).toEqual({ ok: true })
    expect(dismissHandlerGuarded({ host: 'imap.example.com' }, { certRecovery })).toEqual({ ok: true })
  })
})

describe('main.ts TLS trust rework — cert:dismiss handler', () => {
  it('parses the host and delegates to certRecovery.dismiss', () => {
    const certRecovery = makeCertRecoveryMock()

    const result = dismissHandler({ host: 'imap.example.com' }, { certRecovery })

    expect(result).toEqual({ ok: true })
    expect(certRecovery.dismiss).toHaveBeenCalledWith('imap.example.com', undefined)
    expect(certRecovery.dismiss).toHaveBeenCalledTimes(1)
  })

  it('forwards an optional port when the renderer supplies one', () => {
    const certRecovery = makeCertRecoveryMock()

    dismissHandler({ host: 'imap.example.com', port: 993 }, { certRecovery })

    expect(certRecovery.dismiss).toHaveBeenCalledWith('imap.example.com', 993)
  })

  it('rejects an out-of-range port', () => {
    const certRecovery = makeCertRecoveryMock()

    expect(() => dismissHandler({ host: 'imap.example.com', port: 70000 }, { certRecovery })).toThrow()
    expect(certRecovery.dismiss).not.toHaveBeenCalled()
  })

  it('is idempotent: a renderer retry of the same dismiss stays valid', () => {
    const certRecovery = makeCertRecoveryMock()

    expect(dismissHandler({ host: 'imap.example.com' }, { certRecovery })).toEqual({ ok: true })
    expect(dismissHandler({ host: 'imap.example.com' }, { certRecovery })).toEqual({ ok: true })
    expect(certRecovery.dismiss).toHaveBeenCalledTimes(2)
    expect(certRecovery.dismiss).toHaveBeenNthCalledWith(2, 'imap.example.com', undefined)
  })

  it('trims and lowercases the host (matches the service guard key)', () => {
    const certRecovery = makeCertRecoveryMock()

    dismissHandler({ host: '  IMAP.Example.com.  ' }, { certRecovery })

    expect(certRecovery.dismiss).toHaveBeenCalledWith('imap.example.com', undefined)
  })

  it('rejects an empty host', () => {
    const certRecovery = makeCertRecoveryMock()

    expect(() => dismissHandler({ host: '' }, { certRecovery })).toThrow()
    expect(certRecovery.dismiss).not.toHaveBeenCalled()
  })

  it('rejects a host longer than 253 characters (max DNS name length)', () => {
    const certRecovery = makeCertRecoveryMock()
    const longHost = 'a'.repeat(254)

    expect(() => dismissHandler({ host: longHost }, { certRecovery })).toThrow()
    expect(certRecovery.dismiss).not.toHaveBeenCalled()
  })

  it('accepts a host of exactly 253 characters (boundary)', () => {
    const certRecovery = makeCertRecoveryMock()
    const maxHost = 'a'.repeat(253)

    const result = dismissHandler({ host: maxHost }, { certRecovery })

    expect(result).toEqual({ ok: true })
    expect(certRecovery.dismiss).toHaveBeenCalledWith(maxHost, undefined)
  })

  it('rejects a payload with an extra unknown field (schema is .strict())', () => {
    const certRecovery = makeCertRecoveryMock()

    expect(() => dismissHandler({ host: 'imap.example.com', extra: 1 }, { certRecovery })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Tests: lifecycle wiring (requireAccountConfig, accounts:remove)
// ---------------------------------------------------------------------------

describe('main.ts TLS trust rework — account lifecycle wiring', () => {
  it('requireAccountConfig registers the account with certRecovery before returning', () => {
    const certRecovery = makeCertRecoveryMock()
    const getAccountMeta = vi.fn().mockReturnValue({ id: 7 })

    requireAccountConfigEnsuresRegistration(7, { certRecovery, getAccountMeta })

    expect(certRecovery.ensureAccountRegistered).toHaveBeenCalledWith(7)
    expect(certRecovery.ensureAccountRegistered).toHaveBeenCalledTimes(1)
  })

  it('requireAccountConfig does NOT register when the account does not exist', () => {
    const certRecovery = makeCertRecoveryMock()
    const getAccountMeta = vi.fn().mockReturnValue(undefined)

    expect(() => requireAccountConfigEnsuresRegistration(7, { certRecovery, getAccountMeta }))
      .toThrow('Account #7 not found')
    expect(certRecovery.ensureAccountRegistered).not.toHaveBeenCalled()
  })

  it('accounts:remove unregisters the account from certRecovery', () => {
    const certRecovery = makeCertRecoveryMock()

    accountsRemoveUnregistersCert(7, { certRecovery })

    expect(certRecovery.unregisterAccount).toHaveBeenCalledWith(7)
    expect(certRecovery.unregisterAccount).toHaveBeenCalledTimes(1)
  })
})
