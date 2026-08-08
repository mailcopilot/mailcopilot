/**
 * §2.33 PR1 — keyring-independent secret store with a machine-bound encrypted
 * disk fallback.
 *
 * Problem this solves: on a managed Linux box with no system keychain (no
 * Secret Service / libsecret daemon reachable), `keytar.getPassword` does not
 * fail fast — it blocks on a D-Bus activation timeout (~25s) and then rejects
 * with "...org.freedesktop.secrets: Timeout was reached". Every per-account
 * read that needs a stored password stalls and ultimately fails, so the client
 * cannot connect.
 *
 * Strategy:
 *   1. keytar stays the PRIMARY backend (real OS keychain wherever one exists).
 *   2. A fast-fail probe (short timeout, NOT the 25s D-Bus hang) decides up
 *      front whether keytar is reachable this session. The result is cached
 *      module-scope so we probe once.
 *   3. When keytar is unreachable — meaning the probe times out OR rejects with
 *      a keychain-unavailable error (classified by `isKeychainUnavailableError`)
 *      — we transparently switch to a machine-bound AES-256-GCM disk fallback so
 *      get/set/delete still succeed WITHOUT prompting the user for a password,
 *      and we report the condition once per session via the §2.34
 *      `reportKeychainUnavailable` helper (Sentry issue +
 *      `secret_store.fallback_active` usage metric). A probe (or live op)
 *      failure that is NOT a keychain-unavailable error is treated as a real
 *      fault: we do NOT silently degrade to disk — the operation throws so the
 *      failure is visible instead of masked.
 *
 * Encryption (fallback path):
 *   - Key = scrypt(machineId, perInstallSalt) with pinned cost parameters. The
 *     machine id is REQUIRED and sourced per-platform:
 *       Linux:   /etc/machine-id (or /var/lib/dbus/machine-id)
 *       macOS:   IOPlatformUUID via `ioreg -rd1 -c IOPlatformExpertDevice`
 *       Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid via `reg query`
 *     Binding the key to BOTH the host machine id AND a per-install on-disk salt
 *     means copying userData (salt + secrets) to another machine yields
 *     ciphertext that cannot be decrypted there — confidentiality survives disk
 *     exfiltration on ALL three platforms, not only Linux.
 *   - FAIL-CLOSED when no binding material exists: if no machine id can be
 *     obtained from any source, the KDF REFUSES to derive a key. `set` (any
 *     write that PERSISTS A SECRET) throws "secret store fallback unavailable:
 *     no machine-binding material" rather than persisting a near-portable,
 *     weakly-bound secret; `get` of a missing entry still returns null. `delete`
 *     is deliberately outside this rule: it only REMOVES an entry, needs no key
 *     to do so, and refusing it would leave a user with no machine id unable to
 *     drop a credential they can no longer decrypt anyway. We never downgrade to
 *     salt-only binding (which would be decryptable on any machine holding a
 *     copy of the co-located salt — i.e. de-facto plaintext-on-disk).
 *   - Per-write random 12-byte IV; iv‖authTag‖ciphertext persisted together,
 *     base64-encoded. AES-256-GCM gives confidentiality + tamper detection
 *     (a flipped byte or wrong auth tag makes decrypt throw).
 *   - A corrupt / unreadable fallback file is preserved (renamed to
 *     `<file>.corrupt-<ts>`) BEFORE any rewrite, so a single bad parse can never
 *     silently destroy the other stored secrets.
 *   - Both the secrets file AND the salt file are written 0600 (owner-only).
 *
 * PR1 ISOLATION INVARIANT: this module is NOT imported by any call-site
 * (packages/net/config.ts, electron/services/ai.ts,
 * electron/services/outlookOAuthService.ts stay untouched). Wiring happens in
 * PR2. This file ships the core + its unit tests only.
 *
 * Security / privacy invariants (CLAUDE.md §8 + the §2.33 brief):
 *   - The derived key, the scrypt output, the per-install salt, AND the raw
 *     machine id are NEVER logged and NEVER sent to Sentry. Only the enum
 *     `surface` / `platform` reach telemetry (enforced by the §2.34 helper).
 *   - The raw keytar / backend error stays local-only; it is never forwarded to
 *     Sentry (the helper sends a SYNTHETIC exception).
 *   - No PII (passwords, account ids, key names) in logs. The on-disk fallback
 *     indexes entries by a SHA-256 hash of the key, so even the 0600 file does
 *     not contain raw key names like `imap:42`.
 *   - Telemetry + fallback activation are fire-and-forget and wrapped so they
 *     can never throw out of get/set/delete.
 *   - Node crypto stdlib only — no new dependencies (machine-id discovery uses
 *     node:child_process to shell the platform's own id tool).
 */

import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import keytar from 'keytar'
import { isKeychainUnavailableError } from '@mailcopilot/core'
import { createLogger } from '../logger'
import { reportKeychainUnavailable, type SecretStoreSurface } from '../sentry'

const log = createLogger('SecretStore')

/** Default keytar service namespace (mirrors packages/net/config.ts `service`). */
const DEFAULT_SERVICE = 'mailcopilot'

/** Filenames inside userData for the encrypted fallback + its per-install salt. */
const FALLBACK_FILE = 'secret-fallback.json'
const SALT_FILE = 'secret-fallback.salt'

/** Probe key — never holds a real secret; only used to test reachability. */
const PROBE_ACCOUNT = '__mailcopilot_keytar_probe__'

/**
 * §2.132 — under `MAILCOPILOT_E2E=1` the OS keychain is OFF LIMITS and every
 * operation is served by the encrypted disk fallback instead.
 *
 * A keychain entry is addressed by (service, account) — `mailcopilot` /
 * `openai_api_key`, `imap:3`, `oauth-refresh:outlook:6` — and that address
 * space belongs to the LOGGED-IN USER, not to `MAILCOPILOT_DATA_DIR`. The e2e
 * suite drives the real IPC stack, so a spec that saves or deletes a secret was
 * writing into the developer's own keychain: on 2026-08-05 a gate run deleted a
 * live `openai_api_key` at 10:36 and left a test string under the same name,
 * which the next app launch read back as `found` and the provider then
 * rejected. Account ids in a throwaway e2e database start at 1, so `imap:<id>` /
 * `smtp:<id>` collide with real accounts by construction too.
 *
 * The disk fallback IS per-data-dir, so forcing it makes the suite
 * self-contained. It also removes the CI/dev divergence that hid the bug: a
 * headless runner has no session bus, so the probe already chose the fallback
 * and the specs exercised it; on a developer box `xvfb-run` does NOT disable
 * D-Bus, so the very same specs reached the live keyring.
 *
 * **`!app.isPackaged` is load-bearing, not decoration.** `MAILCOPILOT_E2E` is an
 * environment variable, so anything running as the user can set it (wrapper
 * script, dropper, shell profile). Without the packaging check, that env var
 * alone would move a shipped build's secrets out of the OS keychain and into
 * the disk fallback — materially weaker against a same-user process, whose key
 * is derived from a non-secret machine id plus a salt stored beside the
 * ciphertext, all readable by that same user. `app.isPackaged` is a property of
 * the build and survives env tampering, so the pair closes the escape. Same
 * reasoning and same pair of conditions as `assertE2EHandlerAllowed`
 * (electron/main.ts) and the consent bypass in
 * electron/services/telemetryConsentService.ts. Dev runs and Playwright runs
 * keep `isPackaged === false`, so the legitimate flow is unaffected.
 *
 * Failure direction: cannot prove we are unpackaged → assume we are packaged →
 * keychain stays in use, i.e. fall back to normal product behaviour.
 *
 * Read per call rather than latched at import: the value must not depend on
 * module-import order, and a test can drive both sides with `vi.stubEnv`.
 */
function isE2E(): boolean {
  if (process.env.MAILCOPILOT_E2E !== '1') return false
  try {
    if (app.isPackaged) return false
  } catch {
    return false
  }
  return true
}

/** Default fast-fail probe budget. Short by design — must NOT wait out the
 * ~25s D-Bus activation hang. 2.5s is long enough for a healthy keychain to
 * answer and short enough to keep startup responsive when it is dead. */
const DEFAULT_PROBE_TIMEOUT_MS = 2500

/** Hard cap on the per-platform machine-id discovery subprocess (ioreg / reg)
 * so a hung tool can never stall key derivation. */
const MACHINE_ID_CMD_TIMEOUT_MS = 5000

/** AES-256-GCM constants. */
const IV_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 32
const KEY_BYTES = 32
const FALLBACK_VERSION = 1

/** Pinned scrypt KDF parameters. Made explicit so a future Node default change
 * cannot silently weaken the derivation — or, worse, break round-trip
 * compatibility with already-persisted ciphertext. N=16384,r=8,p=1 is Node's
 * current default cost; `maxmem` is sized to fit it (128*N*r ≈ 16 MiB < 32). */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } as const

/** Minimal structural surface of keytar we depend on — lets tests inject a
 * fake without loading the native binding. */
export interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>
  setPassword(service: string, account: string, password: string): Promise<void>
  deletePassword(service: string, account: string): Promise<boolean>
}

/** Dependency seams for full test isolation (no electron / keytar / fs of the
 * real userData dir required to exercise the logic). */
export interface SecretStoreOptions {
  /** keytar getter (DI seam). Defaults to the real keytar module. */
  keytar?: () => KeytarLike
  /** machine-id source (DI seam). Returns null when no stable machine id is
   * available on this platform — the fallback then FAILS CLOSED (no key is
   * derived) rather than degrading to a salt-only, portable binding. */
  machineId?: () => string | null
  /** userData directory (DI seam). Defaults to the electron userData path
   * (honouring MAILCOPILOT_DATA_DIR). */
  userDataDir?: () => string
  /** Fast-fail probe timeout in ms. */
  probeTimeoutMs?: number
  /** keytar service namespace. */
  service?: string
}

export interface SecretStore {
  get(key: string, surface?: SecretStoreSurface): Promise<string | null>
  set(key: string, value: string, surface?: SecretStoreSurface): Promise<void>
  delete(key: string, surface?: SecretStoreSurface): Promise<void>
}

/**
 * One-shot probe outcome for the session:
 *   - `keytar`   — keychain reachable, use it.
 *   - `fallback` — keychain unavailable (timeout or keychain-unavailable error);
 *                  `err` is handed to the §2.34 helper so the Sentry report
 *                  carries an accurate surface.
 *   - `e2e`      — §2.132: keychain reachability is irrelevant here and is
 *                  deliberately never evaluated (`MAILCOPILOT_E2E=1` in an
 *                  unpackaged build). Same disk path as `fallback`, but it is a
 *                  POLICY decision, not a fault: nothing is probed and nothing
 *                  is reported, because declining to use a keychain is not a
 *                  keychain-unavailability incident.
 *   - `error`    — a real, NON-keychain failure (permission, native-binding
 *                  bug, …). We deliberately do NOT degrade to disk for this; the
 *                  operation rethrows so the fault is visible, not masked.
 */
type ProbeOutcome =
  | { backend: 'keytar' }
  | { backend: 'fallback'; err: unknown }
  | { backend: 'e2e' }
  | { error: unknown }

/** Module-scope cache of the one-shot probe decision (single probe per
 * session). Reset only by the test hook. */
let _probeDecision: ProbeOutcome | null = null
let _probeInFlight: Promise<ProbeOutcome> | null = null

/** Module-scope cache of the resolved default machine id. `undefined` = not yet
 * computed; `null` = computed and genuinely unavailable. Avoids re-shelling the
 * platform discovery tool on every derivation. */
let _cachedDefaultMachineId: string | null | undefined

/** Test-only: reset the per-session module caches (probe decision + default
 * machine id). Mirrors __resetKeychainReportStateForTest in electron/sentry.ts. */
export function __resetSecretStoreProbeForTest(): void {
  _probeDecision = null
  _probeInFlight = null
  _cachedDefaultMachineId = undefined
}

// --- Default dependency providers (real electron / keytar / fs) -------------

function defaultUserDataDir(): string {
  if (process.env.MAILCOPILOT_DATA_DIR) return path.resolve(process.env.MAILCOPILOT_DATA_DIR)
  return app.getPath('userData')
}

/** Linux: stable per-host id at /etc/machine-id (systemd) or
 * /var/lib/dbus/machine-id (dbus). */
function readLinuxMachineId(): string | null {
  for (const candidate of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = fs.readFileSync(candidate, 'utf8').trim()
      if (id) return id
    } catch {
      // Not present / unreadable — try the next, then null.
    }
  }
  return null
}

/** macOS: IOPlatformUUID, a stable per-machine identifier exposed by IOKit. */
function readDarwinMachineId(): string | null {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8',
      timeout: MACHINE_ID_CMD_TIMEOUT_MS,
    })
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
    const id = m?.[1]?.trim()
    return id ? id : null
  } catch {
    return null
  }
}

/** Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid, set at install
 * time and stable for the machine. */
function readWindowsMachineId(): string | null {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: MACHINE_ID_CMD_TIMEOUT_MS },
    )
    // Line shape: "    MachineGuid    REG_SZ    <guid>"
    const m = out.match(/MachineGuid\s+REG_SZ\s+([^\s]+)/i)
    const id = m?.[1]?.trim()
    return id ? id : null
  } catch {
    return null
  }
}

/**
 * Best-effort, cross-platform machine id used to BIND the fallback key to the
 * host. Each platform reads its own stable identifier; every source is wrapped
 * in try/catch and the resolved value (including a genuine `null`) is cached so
 * we shell out at most once. Returns null only when NO source yields an id — in
 * which case the KDF fails closed (see `deriveKey`). The raw id is never logged
 * or sent to telemetry; only the enum platform tag is.
 */
export function defaultMachineId(): string | null {
  if (_cachedDefaultMachineId !== undefined) return _cachedDefaultMachineId
  let id: string | null
  switch (process.platform) {
    case 'darwin':
      id = readDarwinMachineId()
      break
    case 'win32':
      id = readWindowsMachineId()
      break
    default:
      id = readLinuxMachineId()
  }
  _cachedDefaultMachineId = id
  return id
}

function currentPlatformTag(): 'linux' | 'darwin' | 'win32' {
  return process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
}

/** Fire-and-forget telemetry — must never throw out of get/set/delete. */
function safeReport(err: unknown, surface: SecretStoreSurface): void {
  try {
    reportKeychainUnavailable(err, surface)
  } catch {
    /* telemetry must never throw */
  }
}

export function createSecretStore(options: SecretStoreOptions = {}): SecretStore {
  // §2.132 second line of defence. `ensureBackend` already refuses to select
  // the keychain under e2e, so this throw is unreachable through the current
  // get/set/delete paths — it exists so a FUTURE path that forgets the policy
  // fails loudly here instead of silently mutating the developer's keychain.
  // Only the default provider is guarded: an injected `options.keytar` is a
  // test double by definition and owns no real credentials.
  const getKeytar =
    options.keytar ??
    (() => {
      if (isE2E()) {
        throw new Error('secret store: OS keychain access is disabled under MAILCOPILOT_E2E')
      }
      return keytar as KeytarLike
    })
  const getMachineId = options.machineId ?? defaultMachineId
  const getUserDataDir = options.userDataDir ?? defaultUserDataDir
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const service = options.service ?? DEFAULT_SERVICE

  // Derived key cached per store instance (never module-scope, never logged).
  let cachedKey: Buffer | null = null

  function fallbackPath(): string {
    return path.join(getUserDataDir(), FALLBACK_FILE)
  }
  function saltPath(): string {
    return path.join(getUserDataDir(), SALT_FILE)
  }

  /** Load the per-install salt, generating + persisting it (0600) on first use. */
  function loadOrCreateSalt(): Buffer {
    const file = saltPath()
    try {
      const raw = fs.readFileSync(file)
      if (raw.length >= SALT_BYTES) {
        // Re-tighten perms on a pre-existing salt file: writeFileSync's `mode`
        // only applies on creation, so a salt written by an older build (or
        // copied in) with broader perms would otherwise stay loose forever.
        // Idempotent; runs before any mutation so a throw here only fails the
        // read cleanly (consistent with the generate-path chmod below).
        fs.chmodSync(file, 0o600)
        return raw
      }
    } catch {
      // Missing / unreadable — (re)generate below.
    }
    const salt = randomBytes(SALT_BYTES)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, salt, { mode: 0o600 })
    // Enforce 0600 even if the file pre-existed with broader perms (mode on
    // writeFileSync only applies on creation).
    fs.chmodSync(file, 0o600)
    return salt
  }

  /**
   * Derive the AES key. scrypt password = machine id, scrypt salt = the
   * per-install random salt. FAIL-CLOSED: a machine id is mandatory binding
   * material — if none is available we throw rather than deriving a key from an
   * empty password (which, with the salt co-located on disk, would make the
   * ciphertext decryptable on ANY machine that holds a copy of userData). The
   * machine-id check runs BEFORE touching the salt so no on-disk material is
   * created when we are going to refuse anyway.
   */
  function deriveKey(): Buffer {
    if (cachedKey) return cachedKey
    const machineId = getMachineId()
    if (!machineId) {
      throw new Error('secret store fallback unavailable: no machine-binding material')
    }
    const salt = loadOrCreateSalt()
    cachedKey = scryptSync(Buffer.from(machineId, 'utf8'), salt, KEY_BYTES, SCRYPT_PARAMS)
    return cachedKey
  }

  function encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, ciphertext]).toString('base64')
  }

  function decrypt(blob: string): string {
    const buf = Buffer.from(blob, 'base64')
    // Guard before slicing: a truncated / non-base64 blob would otherwise hand a
    // short IV/tag to openssl and surface as an opaque native error. Fail in a
    // controlled way instead.
    if (buf.length < IV_BYTES + TAG_BYTES) {
      throw new Error('secret store fallback: ciphertext too short')
    }
    const iv = buf.subarray(0, IV_BYTES)
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv)
    decipher.setAuthTag(tag)
    // final() throws if the auth tag does not verify (tampered / wrong key).
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }

  /** Index key — SHA-256 of the raw key so the 0600 file never stores raw key
   * names (which embed account ids, e.g. `imap:42`). */
  function indexKey(key: string): string {
    return createHash('sha256').update(key, 'utf8').digest('hex')
  }

  type EntriesState =
    | { status: 'ok'; entries: Record<string, string> }
    | { status: 'missing' }
    | { status: 'corrupt' }

  /**
   * Classify the fallback file. We MUST distinguish "no file / empty" (nothing
   * to lose) from "file present but unparseable" (likely a truncated write or
   * disk corruption holding real encrypted entries). A corrupt classification is
   * what protects the writers from silently clobbering recoverable data.
   */
  function readEntriesState(): EntriesState {
    let raw: string
    try {
      raw = fs.readFileSync(fallbackPath(), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing' }
      // Unreadable for some other reason (e.g. permissions): treat as corrupt so
      // a writer preserves rather than clobbers a file it merely could not read.
      return { status: 'corrupt' }
    }
    if (raw.trim() === '') return { status: 'missing' }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { status: 'corrupt' }
    }
    if (!parsed || typeof parsed !== 'object') return { status: 'corrupt' }
    const entries = (parsed as { entries?: unknown }).entries
    if (entries && typeof entries === 'object') {
      return { status: 'ok', entries: entries as Record<string, string> }
    }
    // Valid JSON object with no usable entries map — nothing to lose, treat empty.
    return { status: 'ok', entries: {} }
  }

  /** Preserve a corrupt/unreadable file before a writer overwrites it. Renames
   * to a `.corrupt-<ts>` sibling so the bytes survive for manual recovery. If
   * the rename itself fails we let it throw — better to fail the write closed
   * than to clobber an unreadable-but-present secrets file. */
  function backupCorruptFile(): void {
    const file = fallbackPath()
    const backup = `${file}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`
    fs.renameSync(file, backup)
    // Re-tighten perms on the preserved sibling: rename carries the original
    // file's mode, so a pre-existing loose corrupt file would stay loose. This
    // runs AFTER renameSync moved the bytes away, so a chmod failure must never
    // throw out of the preserve/rewrite path — hardening only, best-effort.
    try {
      fs.chmodSync(backup, 0o600)
    } catch {
      /* hardening only — never break the preserve/rewrite path */
    }
    log.warn('fallback secret file unreadable; preserved before rewrite', {
      platform: currentPlatformTag(),
    })
  }

  function writeEntries(entries: Record<string, string>): void {
    const dir = getUserDataDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = fallbackPath()
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    const payload = JSON.stringify({ version: FALLBACK_VERSION, entries })
    fs.writeFileSync(tmp, payload, { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
    // rename preserves the temp file's 0600 mode; re-assert for belt-and-suspenders.
    fs.chmodSync(file, 0o600)
  }

  function readFallback(key: string): string | null {
    const state = readEntriesState()
    // Missing or corrupt → null on read (a read never mutates / clobbers).
    if (state.status !== 'ok') return null
    const blob = state.entries[indexKey(key)]
    if (typeof blob !== 'string') return null
    return decrypt(blob)
  }

  function writeFallback(key: string, value: string): void {
    // Encrypt FIRST so deriveKey's fail-closed check runs before we read, back
    // up, or write any file — a binding-less store never mutates the disk.
    const blob = encrypt(value)
    const state = readEntriesState()
    if (state.status === 'corrupt') backupCorruptFile()
    const entries = state.status === 'ok' ? state.entries : {}
    entries[indexKey(key)] = blob
    writeEntries(entries)
  }

  function deleteFallback(key: string): void {
    const state = readEntriesState()
    if (state.status === 'missing') return // nothing to delete
    if (state.status === 'corrupt') {
      // Preserve the unreadable file rather than clobber it; nothing decryptable
      // to remove anyway.
      backupCorruptFile()
      return
    }
    const entries = state.entries
    const idx = indexKey(key)
    if (idx in entries) {
      delete entries[idx]
      writeEntries(entries)
    }
  }

  /**
   * Fast-fail keytar reachability probe. Races a single getPassword against the
   * timeout: a healthy keychain answers (even with null) well within budget; a
   * dead one either rejects with a keychain-unavailable error or hangs past the
   * timeout. A timeout OR a keychain-unavailable rejection resolves to
   * `fallback`; any OTHER rejection resolves to `error` (a real fault we must
   * surface, not mask with the disk fallback). We never wait out the full D-Bus
   * hang.
   */
  function probeKeytar(): Promise<ProbeOutcome> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (outcome: ProbeOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      }
      const timer = setTimeout(
        () => finish({ backend: 'fallback', err: new Error('keytar reachability probe timed out') }),
        probeTimeoutMs,
      )
      // Do not keep the event loop alive on the timeout alone.
      if (typeof timer.unref === 'function') timer.unref()
      Promise.resolve()
        .then(() => getKeytar().getPassword(service, PROBE_ACCOUNT))
        .then(() => finish({ backend: 'keytar' }))
        .catch((err) =>
          finish(isKeychainUnavailableError(err) ? { backend: 'fallback', err } : { error: err }),
        )
    })
  }

  /** Resolve (and cache) the backend decision for this session. */
  async function ensureBackend(): Promise<ProbeOutcome> {
    // §2.132 — the e2e policy outranks the probe and is never cached: it must
    // not depend on whether some earlier call already latched a decision, and
    // it must not leave a latched decision behind for a later non-e2e store.
    // No probe is issued, so the keychain is not even contacted.
    if (isE2E()) {
      // Isolation is only real when the run owns its data directory. With the
      // flag set and no MAILCOPILOT_DATA_DIR, the fallback would resolve to the
      // NORMAL profile and a test would write into — and delete out of — the
      // secrets of a user whose keychain is unavailable. Refuse instead: every
      // launcher in tests/e2e/helpers.ts sets both variables together, so this
      // only ever fires on a hand-rolled or half-configured run, where a loud
      // failure is the correct answer.
      if (!process.env.MAILCOPILOT_DATA_DIR?.trim()) {
        throw new Error('secret store: MAILCOPILOT_E2E requires MAILCOPILOT_DATA_DIR')
      }
      return { backend: 'e2e' }
    }
    if (_probeDecision) return _probeDecision
    if (!_probeInFlight) {
      _probeInFlight = (async () => {
        try {
          const outcome = await probeKeytar()
          if ('backend' in outcome && outcome.backend === 'fallback') {
            log.warn('OS secret store unreachable; using encrypted disk fallback', {
              platform: currentPlatformTag(),
            })
          }
          // Cache keytar + fallback decisions for the session. A hard,
          // NON-keychain probe error is cached too so the operation fails
          // explicitly instead of silently degrading to disk; the test reset
          // hook clears it.
          _probeDecision = outcome
          return outcome
        } finally {
          _probeInFlight = null
        }
      })()
    }
    return _probeInFlight
  }

  /** Flip the cached decision to fallback after an operation observes a live
   * keychain-unavailable error (backend died mid-session / probe raced). */
  function markFallback(err: unknown): void {
    _probeDecision = { backend: 'fallback', err }
    _probeInFlight = null
  }

  async function get(key: string, surface: SecretStoreSurface = 'unknown'): Promise<string | null> {
    const decision = await ensureBackend()
    if ('error' in decision) throw decision.error
    if (decision.backend === 'e2e') return readFallback(key)
    if (decision.backend === 'fallback') {
      safeReport(decision.err ?? new Error('OS secret store unavailable'), surface)
      return readFallback(key)
    }
    try {
      return await getKeytar().getPassword(service, key)
    } catch (err) {
      if (isKeychainUnavailableError(err)) {
        markFallback(err)
        safeReport(err, surface)
        return readFallback(key)
      }
      throw err
    }
  }

  async function set(key: string, value: string, surface: SecretStoreSurface = 'unknown'): Promise<void> {
    const decision = await ensureBackend()
    if ('error' in decision) throw decision.error
    if (decision.backend === 'e2e') {
      writeFallback(key, value)
      return
    }
    if (decision.backend === 'fallback') {
      safeReport(decision.err ?? new Error('OS secret store unavailable'), surface)
      writeFallback(key, value)
      return
    }
    try {
      await getKeytar().setPassword(service, key, value)
    } catch (err) {
      if (isKeychainUnavailableError(err)) {
        markFallback(err)
        safeReport(err, surface)
        writeFallback(key, value)
        return
      }
      throw err
    }
  }

  async function del(key: string, surface: SecretStoreSurface = 'unknown'): Promise<void> {
    const decision = await ensureBackend()
    if ('error' in decision) throw decision.error
    if (decision.backend === 'e2e') {
      deleteFallback(key)
      return
    }
    if (decision.backend === 'fallback') {
      safeReport(decision.err ?? new Error('OS secret store unavailable'), surface)
      deleteFallback(key)
      return
    }
    try {
      await getKeytar().deletePassword(service, key)
    } catch (err) {
      if (isKeychainUnavailableError(err)) {
        markFallback(err)
        safeReport(err, surface)
        deleteFallback(key)
        return
      }
      throw err
    }
  }

  return { get, set, delete: del }
}

/**
 * Default store wired to the real electron / keytar / fs providers. Exported so
 * PR2 can adopt it at the call-sites; PR1 does not import it anywhere (the
 * isolation invariant). Construction is side-effect-free — the providers are
 * lazy closures invoked only when get/set/delete actually run.
 */
export const secretStore: SecretStore = createSecretStore()
