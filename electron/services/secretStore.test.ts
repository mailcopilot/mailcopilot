import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * §2.33 PR1 — isolated unit tests for the keyring-independent secret store.
 *
 * Full isolation via the DI seams (keytar getter, machine-id source, userData
 * dir) + a temp directory — no real electron / keytar / system keychain is ever
 * touched. The real `electron`, `keytar`, `../logger`, and `../sentry` modules
 * are mocked only so importing secretStore.ts does not load the native keytar
 * binding or @sentry/node; the logic under test uses the injected fakes.
 */

// Mock heavy / native imports so importing the module is cheap and side-effect
// free. The DI seams below mean these mocks are never actually exercised by the
// logic under test.
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(async () => null),
    setPassword: vi.fn(async () => {}),
    deletePassword: vi.fn(async () => true),
  },
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

const { reportMock } = vi.hoisted(() => ({ reportMock: vi.fn() }))
vi.mock('../sentry', () => ({ reportKeychainUnavailable: reportMock }))

// Machine-id discovery shells out to ioreg (macOS) / reg (Windows). Mock the
// whole module so the cross-platform source tests can drive it without a real
// subprocess; the DI-injected `machineId` seam means every OTHER test never
// touches it.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

// The Linux machine-id source reads /etc/machine-id directly. ESM namespaces are
// not spy-able, so wrap node:fs: delegate to the REAL fs for everything (temp
// dirs, the fallback/salt files) and only intercept the two machine-id candidate
// paths when a per-test override is installed.
const { machineIdFileOverride } = vi.hoisted(() => ({
  machineIdFileOverride: { fn: null as null | ((p: unknown) => string) },
}))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    const ov = machineIdFileOverride.fn
    if (ov && (p === '/etc/machine-id' || p === '/var/lib/dbus/machine-id')) return ov(p)
    return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof real.readFileSync
  return { ...real, default: { ...real, readFileSync }, readFileSync }
})

import {
  createSecretStore,
  __resetSecretStoreProbeForTest,
  defaultMachineId,
  secretStore,
  type KeytarLike,
} from './secretStore'

const PROBE_ACCOUNT = '__mailcopilot_keytar_probe__'
const FALLBACK_FILE = 'secret-fallback.json'
const SALT_FILE = 'secret-fallback.salt'

let dataDir: string

beforeEach(() => {
  __resetSecretStoreProbeForTest()
  reportMock.mockReset()
  machineIdFileOverride.fn = null
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretstore-'))
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** keytar fake whose behaviour is overridable per method. */
function fakeKeytar(overrides: Partial<KeytarLike> = {}): KeytarLike {
  return {
    getPassword: vi.fn(async () => null),
    setPassword: vi.fn(async () => {}),
    deletePassword: vi.fn(async () => true),
    ...overrides,
  }
}

function makeStore(opts: {
  keytar: KeytarLike
  machineId?: () => string | null
  probeTimeoutMs?: number
}) {
  return createSecretStore({
    keytar: () => opts.keytar,
    machineId: opts.machineId ?? (() => 'test-machine-id'),
    userDataDir: () => dataDir,
    probeTimeoutMs: opts.probeTimeoutMs ?? 2500,
  })
}

const keychainErr = () =>
  new Error('Error calling StartServiceByName for org.freedesktop.secrets: Timeout was reached')

function fallbackPath() {
  return path.join(dataDir, FALLBACK_FILE)
}
function saltPath() {
  return path.join(dataDir, SALT_FILE)
}
function readEntries(): Record<string, string> {
  return JSON.parse(fs.readFileSync(fallbackPath(), 'utf8')).entries
}
function entryBlobFor(key: string): string {
  const hash = createHash('sha256').update(key, 'utf8').digest('hex')
  return readEntries()[hash]
}

describe('§2.33 — secretStore keytar primary path (probe healthy)', () => {
  it('uses keytar for get/set/delete and never writes the disk fallback', async () => {
    const keytar = fakeKeytar({
      getPassword: vi.fn(async (_s, account) => (account === PROBE_ACCOUNT ? null : 'stored-secret')),
    })
    const store = makeStore({ keytar })

    expect(await store.get('imap:1', 'imap_smtp')).toBe('stored-secret')
    await store.set('imap:1', 'new-pw', 'imap_smtp')
    await store.delete('imap:1', 'imap_smtp')

    expect(keytar.setPassword).toHaveBeenCalledWith('mailcopilot', 'imap:1', 'new-pw')
    expect(keytar.deletePassword).toHaveBeenCalledWith('mailcopilot', 'imap:1')
    // No fallback activation: no report, no files on disk.
    expect(reportMock).not.toHaveBeenCalled()
    expect(fs.existsSync(fallbackPath())).toBe(false)
    expect(fs.existsSync(saltPath())).toBe(false)
  })

  it('probes keytar exactly once across many operations (module-scope cache)', async () => {
    const getPassword = vi.fn(
      async (service: string, account: string): Promise<string | null> =>
        service === 'mailcopilot' && account === PROBE_ACCOUNT ? null : null,
    )
    const keytar = fakeKeytar({ getPassword })
    const store = makeStore({ keytar })

    await store.get('a')
    await store.get('b')
    await store.set('c', 'x')

    // One probe call (PROBE_ACCOUNT) + the two real get reads = 3 getPassword
    // calls; the probe itself is NOT repeated per op.
    const probeCalls = getPassword.mock.calls.filter(([, account]) => account === PROBE_ACCOUNT)
    expect(probeCalls).toHaveLength(1)
  })

  it('propagates a non-keychain keytar error instead of masking it with the fallback', async () => {
    const keytar = fakeKeytar({
      getPassword: vi.fn(async (_s, account) => {
        if (account === PROBE_ACCOUNT) return null
        throw new Error('some unrelated keytar failure')
      }),
    })
    const store = makeStore({ keytar })

    await expect(store.get('imap:1', 'imap_smtp')).rejects.toThrow('some unrelated keytar failure')
    expect(reportMock).not.toHaveBeenCalled()
    expect(fs.existsSync(fallbackPath())).toBe(false)
  })
})

describe('§2.33 — fallback activation on keychain-unavailable', () => {
  it('probe rejects with a keychain-unavailable error → AES disk fallback + report(surface)', async () => {
    const err = keychainErr()
    const keytar = fakeKeytar({ getPassword: vi.fn(async () => { throw err }) })
    const store = makeStore({ keytar })

    await store.set('imap:1', 'secret-pw', 'imap_smtp')
    expect(await store.get('imap:1', 'imap_smtp')).toBe('secret-pw')

    // keytar write was NOT attempted (backend already classified as fallback).
    expect(keytar.setPassword).not.toHaveBeenCalled()
    // The §2.34 helper was invoked with the original error and the op surface.
    expect(reportMock).toHaveBeenCalledWith(err, 'imap_smtp')
  })

  it('probe TIMES OUT (no 25s hang) → fallback, without waiting out the D-Bus stall', async () => {
    // getPassword never resolves — simulates the D-Bus activation hang.
    const keytar = fakeKeytar({ getPassword: vi.fn(() => new Promise<string | null>(() => {})) })
    const store = makeStore({ keytar, probeTimeoutMs: 20 })

    const started = Date.now()
    await store.set('oauth-refresh:google:1', 'tok', 'oauth_refresh')
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(2000) // nowhere near the ~25s real hang
    expect(await store.get('oauth-refresh:google:1', 'oauth_refresh')).toBe('tok')
    expect(reportMock).toHaveBeenCalledTimes(2) // one per fallback op (helper dedups in prod)
    const [reportedErr, surface] = reportMock.mock.calls[0] as unknown as [unknown, string]
    expect(String((reportedErr as Error).message)).toMatch(/timed out/i)
    expect(surface).toBe('oauth_refresh')
  })

  it('probe healthy but a live setPassword throws keychain-unavailable → flips to fallback', async () => {
    const err = keychainErr()
    const keytar = fakeKeytar({
      getPassword: vi.fn(async () => null), // probe ok + future reads
      setPassword: vi.fn(async () => { throw err }),
    })
    const store = makeStore({ keytar })

    await store.set('ai:openai', 'sk-test', 'ai_keys')
    // After the flip, the value is readable from the encrypted fallback.
    expect(await store.get('ai:openai', 'ai_keys')).toBe('sk-test')
    expect(reportMock).toHaveBeenCalledWith(err, 'ai_keys')
  })

  it('delete on the fallback removes the entry', async () => {
    const keytar = fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })
    const store = makeStore({ keytar })

    await store.set('k', 'v', 'unknown')
    expect(await store.get('k', 'unknown')).toBe('v')
    await store.delete('k', 'unknown')
    expect(await store.get('k', 'unknown')).toBeNull()
  })

  it('live deletePassword keychain-unavailable error → flips to fallback', async () => {
    const err = keychainErr()
    const keytar = fakeKeytar({
      getPassword: vi.fn(async (_s: string, account: string): Promise<string | null> =>
        account === PROBE_ACCOUNT ? null : null,
      ),
      deletePassword: vi.fn(async () => { throw err }),
    })
    const store = makeStore({ keytar })

    // delete reaches keytar, which throws; the store must flip to fallback.
    await store.delete('k', 'imap_smtp')

    // Subsequent set goes to disk (not keytar) because backend is now fallback.
    await store.set('k', 'v', 'imap_smtp')
    expect(keytar.setPassword).not.toHaveBeenCalled()
    expect(await store.get('k', 'imap_smtp')).toBe('v')
    expect(reportMock).toHaveBeenCalledWith(err, 'imap_smtp')
  })
})

// §2.33 (dbus-disabled) — integration coverage closing the gap that unit tests
// on the predicate alone (packages/core/keychainErrors.test.ts) cannot see:
// does a D-Bus-session-bus-unavailable error thrown BY KEYTAR actually drive
// secretStore to the encrypted-disk fallback (probe path AND live mid-session
// catch path), the same way the pre-existing per-service keychainErr() class
// does? Mirrors the "§2.33 — fallback activation on keychain-unavailable"
// block above, using the confirmed CI marker (pipeline 2293) instead.
describe('§2.33 (dbus-disabled) — fallback activation on D-Bus session-bus-unavailable', () => {
  const dbusDisabledErr = () =>
    new Error("Unknown or unsupported transport 'disabled' for address 'disabled:'")

  it('probe rejects with the D-Bus transport-disabled error → AES disk fallback + report(surface)', async () => {
    const err = dbusDisabledErr()
    const keytar = fakeKeytar({ getPassword: vi.fn(async () => { throw err }) })
    const store = makeStore({ keytar })

    await store.set('imap:1', 'secret-pw', 'imap_smtp')
    expect(await store.get('imap:1', 'imap_smtp')).toBe('secret-pw')

    // keytar write was NOT attempted (backend already classified as fallback
    // from the probe outcome).
    expect(keytar.setPassword).not.toHaveBeenCalled()
    expect(reportMock).toHaveBeenCalledWith(err, 'imap_smtp')
  })

  it('probe healthy but a live setPassword throws the D-Bus-disabled error → flips to fallback', async () => {
    const err = dbusDisabledErr()
    const keytar = fakeKeytar({
      getPassword: vi.fn(async () => null), // probe ok + future reads
      setPassword: vi.fn(async () => { throw err }),
    })
    const store = makeStore({ keytar })

    await store.set('ai:openai', 'sk-test', 'ai_keys')
    // After the flip, the value is readable from the encrypted fallback.
    expect(await store.get('ai:openai', 'ai_keys')).toBe('sk-test')
    expect(reportMock).toHaveBeenCalledWith(err, 'ai_keys')
  })

  it('live deletePassword D-Bus-disabled error → flips to fallback', async () => {
    const err = dbusDisabledErr()
    const keytar = fakeKeytar({
      getPassword: vi.fn(async (_s: string, account: string): Promise<string | null> =>
        account === PROBE_ACCOUNT ? null : null,
      ),
      deletePassword: vi.fn(async () => { throw err }),
    })
    const store = makeStore({ keytar })

    await store.delete('k', 'imap_smtp')

    // Subsequent set goes to disk (not keytar) because backend is now fallback.
    await store.set('k', 'v', 'imap_smtp')
    expect(keytar.setPassword).not.toHaveBeenCalled()
    expect(await store.get('k', 'imap_smtp')).toBe('v')
    expect(reportMock).toHaveBeenCalledWith(err, 'imap_smtp')
  })

  it('probe healthy but a live getPassword throws the D-Bus-disabled error → flips to fallback', async () => {
    const err = dbusDisabledErr()
    const keytar = fakeKeytar({
      getPassword: vi.fn(async (_s: string, account: string) => {
        if (account === PROBE_ACCOUNT) return null // probe ok
        throw err // real read hits the dead D-Bus session bus
      }),
    })
    const store = makeStore({ keytar })

    // The live get() flips to fallback and returns the (empty) disk fallback
    // result rather than propagating the D-Bus error.
    expect(await store.get('imap:1', 'imap_smtp')).toBeNull()
    expect(reportMock).toHaveBeenCalledWith(err, 'imap_smtp')

    // Subsequent ops go disk-only (not keytar) because the backend is now
    // cached as fallback.
    await store.set('imap:1', 'v', 'imap_smtp')
    expect(keytar.setPassword).not.toHaveBeenCalled()
    expect(await store.get('imap:1', 'imap_smtp')).toBe('v')
  })

  it('NEGATIVE: a genuinely non-keychain error still throws — no masking by the disk fallback', async () => {
    // Pins the fail-safe-not-fail-open boundary: broadening the classifier to
    // cover the D-Bus session-bus class must NOT swallow unrelated faults.
    const keytar = fakeKeytar({
      getPassword: vi.fn(async (_s, account) => {
        if (account === PROBE_ACCOUNT) return null
        throw new TypeError('boom')
      }),
    })
    const store = makeStore({ keytar })

    await expect(store.get('imap:1', 'imap_smtp')).rejects.toThrow('boom')
    expect(reportMock).not.toHaveBeenCalled()
    expect(fs.existsSync(fallbackPath())).toBe(false)
  })

  it('NEGATIVE: a genuinely non-keychain error on a live setPassword still throws — no disk fallback', async () => {
    // Fail-safe boundary symmetry: the mid-session flip-to-fallback path must
    // only trigger on a keychain-unavailable classification, never on an
    // unrelated write fault.
    const keytar = fakeKeytar({
      getPassword: vi.fn(async () => null), // healthy probe
      setPassword: vi.fn(async () => { throw new TypeError('boom') }),
    })
    const store = makeStore({ keytar })

    await expect(store.set('imap:1', 'v', 'imap_smtp')).rejects.toThrow('boom')
    expect(reportMock).not.toHaveBeenCalled()
    expect(fs.existsSync(fallbackPath())).toBe(false)
  })

  it('NEGATIVE: a genuinely non-keychain error on a live deletePassword still throws — no disk fallback', async () => {
    const keytar = fakeKeytar({
      getPassword: vi.fn(async () => null), // healthy probe
      deletePassword: vi.fn(async () => { throw new TypeError('boom') }),
    })
    const store = makeStore({ keytar })

    await expect(store.delete('imap:1', 'imap_smtp')).rejects.toThrow('boom')
    expect(reportMock).not.toHaveBeenCalled()
    expect(fs.existsSync(fallbackPath())).toBe(false)
  })
})

describe('§2.33 — AES-256-GCM encryption properties', () => {
  function forcedFallbackStore(machineId?: () => string | null) {
    const keytar = fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })
    return makeStore({ keytar, machineId })
  }

  it('round-trips encrypt → decrypt back to the original plaintext', async () => {
    const store = forcedFallbackStore()
    await store.set('imap:1', 'pässwörd-✓-unicode', 'imap_smtp')
    expect(await store.get('imap:1', 'imap_smtp')).toBe('pässwörd-✓-unicode')
  })

  it('persists iv‖authTag‖ciphertext together (blob ≥ 28 bytes overhead)', async () => {
    const store = forcedFallbackStore()
    await store.set('k', 'x', 'unknown')
    const buf = Buffer.from(entryBlobFor('k'), 'base64')
    // 12 (iv) + 16 (tag) + >=1 (ciphertext for non-empty plaintext)
    expect(buf.length).toBeGreaterThanOrEqual(12 + 16 + 1)
  })

  it('uses a fresh random 12-byte IV per write (same plaintext → different IV)', async () => {
    const store = forcedFallbackStore()
    await store.set('a', 'identical', 'unknown')
    await store.set('b', 'identical', 'unknown')
    const ivA = Buffer.from(entryBlobFor('a'), 'base64').subarray(0, 12)
    const ivB = Buffer.from(entryBlobFor('b'), 'base64').subarray(0, 12)
    expect(ivA).toHaveLength(12)
    expect(ivA.equals(ivB)).toBe(false)
  })

  it('rejects a tampered ciphertext byte (GCM auth failure)', async () => {
    const store = forcedFallbackStore()
    await store.set('k', 'topsecret', 'unknown')

    const entries = readEntries()
    const hash = createHash('sha256').update('k', 'utf8').digest('hex')
    const buf = Buffer.from(entries[hash], 'base64')
    buf[buf.length - 1] ^= 0xff // flip a ciphertext byte
    entries[hash] = buf.toString('base64')
    fs.writeFileSync(fallbackPath(), JSON.stringify({ version: 1, entries }))

    __resetSecretStoreProbeForTest()
    const reopened = forcedFallbackStore()
    await expect(reopened.get('k', 'unknown')).rejects.toThrow()
  })

  it('rejects a tampered auth tag', async () => {
    const store = forcedFallbackStore()
    await store.set('k', 'topsecret', 'unknown')

    const entries = readEntries()
    const hash = createHash('sha256').update('k', 'utf8').digest('hex')
    const buf = Buffer.from(entries[hash], 'base64')
    buf[12] ^= 0xff // flip the first auth-tag byte
    entries[hash] = buf.toString('base64')
    fs.writeFileSync(fallbackPath(), JSON.stringify({ version: 1, entries }))

    __resetSecretStoreProbeForTest()
    const reopened = forcedFallbackStore()
    await expect(reopened.get('k', 'unknown')).rejects.toThrow()
  })

  it('rejects a tampered IV byte (GCM auth failure on wrong keystream counter)', async () => {
    const store = forcedFallbackStore()
    await store.set('k', 'topsecret', 'unknown')

    const entries = readEntries()
    const hash = createHash('sha256').update('k', 'utf8').digest('hex')
    const buf = Buffer.from(entries[hash], 'base64')
    buf[0] ^= 0xff // flip the first byte of the 12-byte IV (bytes 0–11)
    entries[hash] = buf.toString('base64')
    fs.writeFileSync(fallbackPath(), JSON.stringify({ version: 1, entries }))

    __resetSecretStoreProbeForTest()
    const reopened = forcedFallbackStore()
    // Wrong IV → wrong keystream counter → GCM auth tag mismatch → throws.
    await expect(reopened.get('k', 'unknown')).rejects.toThrow()
  })

  it('does not store the raw key name on disk (indexes by SHA-256 hash)', async () => {
    const store = forcedFallbackStore()
    await store.set('imap:42', 'pw', 'imap_smtp')
    const raw = fs.readFileSync(fallbackPath(), 'utf8')
    expect(raw).not.toContain('imap:42')
    expect(raw).toContain(createHash('sha256').update('imap:42', 'utf8').digest('hex'))
  })
})

describe('§2.33 — key derivation (scrypt(machineId, salt))', () => {
  it('fails closed when no machine id is available (no salt-only / near-plaintext write)', async () => {
    const keytar = fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })
    const store = makeStore({ keytar, machineId: () => null })

    // set must REFUSE to persist a weakly-bound secret rather than silently
    // downgrading to salt-only (portable) binding.
    await expect(store.set('k', 'v', 'unknown')).rejects.toThrow(/no machine-binding material/i)

    // Nothing was written: we bail before creating salt or entries files.
    expect(fs.existsSync(fallbackPath())).toBe(false)
    expect(fs.existsSync(saltPath())).toBe(false)

    // get of a MISSING entry still returns null (does not throw) — readFallback
    // short-circuits before the key derivation.
    expect(await store.get('absent', 'unknown')).toBeNull()
  })

  it('is machine-bound: ciphertext written under machine A is undecryptable under machine B', async () => {
    // Store A writes under machine id "A"; it persists the salt + entry.
    const keytarA = fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })
    const storeA = makeStore({ keytar: keytarA, machineId: () => 'machine-A' })
    await storeA.set('k', 'secret', 'unknown')

    // Store B reuses the SAME userData dir + salt but a different machine id —
    // the derived key differs, so GCM verification fails.
    __resetSecretStoreProbeForTest()
    const keytarB = fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })
    const storeB = makeStore({ keytar: keytarB, machineId: () => 'machine-B' })
    await expect(storeB.get('k', 'unknown')).rejects.toThrow()
  })

  it('generates the per-install salt once and reuses it across stores', async () => {
    const keytar = fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })
    const store = makeStore({ keytar })
    await store.set('k', 'v', 'unknown')
    const salt1 = fs.readFileSync(saltPath())

    __resetSecretStoreProbeForTest()
    const store2 = makeStore({ keytar: fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) }) })
    await store2.set('k2', 'v2', 'unknown')
    const salt2 = fs.readFileSync(saltPath())

    expect(salt1.equals(salt2)).toBe(true)
    expect(salt1.length).toBeGreaterThanOrEqual(32)
  })
})

describe('§2.33 — file permissions (0600 owner-only)', () => {
  it('writes both the secrets file and the salt file with mode 0600', async () => {
    const keytar = fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })
    const store = makeStore({ keytar })
    await store.set('k', 'v', 'unknown')

    expect(fs.statSync(fallbackPath()).mode & 0o777).toBe(0o600)
    expect(fs.statSync(saltPath()).mode & 0o777).toBe(0o600)
  })
})

describe('§2.33 PR1 LOW — re-tighten perms on pre-existing secret material', () => {
  function fallbackStore() {
    return makeStore({ keytar: fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) }) })
  }

  it('LOW-1: re-tightens a pre-existing 0644 salt file to 0600 when read', async () => {
    // Seed a salt file with broad perms, as an older build (mode-on-create only)
    // or a copied-in file would leave it.
    fs.writeFileSync(saltPath(), Buffer.alloc(32, 7))
    fs.chmodSync(saltPath(), 0o644)
    expect(fs.statSync(saltPath()).mode & 0o777).toBe(0o644)

    // Any op that derives the key reads the salt → must re-tighten it.
    await fallbackStore().set('k', 'v', 'unknown')

    expect(fs.statSync(saltPath()).mode & 0o777).toBe(0o600)
  })

  it('LOW-2: re-tightens a preserved corrupt-* backup to 0600', async () => {
    // A pre-existing loose corrupt fallback file would carry its mode through
    // renameSync into the .corrupt-* sibling.
    fs.writeFileSync(fallbackPath(), '{"version":1,"entries":{"x":"truncated...')
    fs.chmodSync(fallbackPath(), 0o644)

    await fallbackStore().set('k', 'v', 'unknown')

    const backups = fs.readdirSync(dataDir).filter((f) => f.startsWith(`${FALLBACK_FILE}.corrupt-`))
    expect(backups).toHaveLength(1)
    expect(fs.statSync(path.join(dataDir, backups[0])).mode & 0o777).toBe(0o600)
  })
})

describe('§2.33 — fire-and-forget telemetry never throws out of the API', () => {
  it('get/set/delete do not throw even if reportKeychainUnavailable throws', async () => {
    reportMock.mockImplementation(() => { throw new Error('sentry sink broke') })
    const keytar = fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })
    const store = makeStore({ keytar })

    await expect(store.set('k', 'v', 'imap_smtp')).resolves.toBeUndefined()
    await expect(store.get('k', 'imap_smtp')).resolves.toBe('v')
    await expect(store.delete('k', 'imap_smtp')).resolves.toBeUndefined()
  })
})

describe('§2.33 — default export shape', () => {
  it('exposes a pre-wired default store with get/set/delete', () => {
    expect(typeof secretStore.get).toBe('function')
    expect(typeof secretStore.set).toBe('function')
    expect(typeof secretStore.delete).toBe('function')
  })
})

describe('§2.33 — fallback file robustness', () => {
  function fallbackStore() {
    return makeStore({ keytar: fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) }) })
  }

  it('returns null when the fallback file is empty (no crash)', async () => {
    fs.writeFileSync(fallbackPath(), '')
    expect(await fallbackStore().get('k', 'unknown')).toBeNull()
  })

  it('returns null when the fallback file contains malformed JSON (no crash)', async () => {
    fs.writeFileSync(fallbackPath(), 'not-json-at-all{{{')
    expect(await fallbackStore().get('k', 'unknown')).toBeNull()
  })

  it('returns null when the fallback JSON lacks the entries property', async () => {
    fs.writeFileSync(fallbackPath(), JSON.stringify({ version: 1 }))
    expect(await fallbackStore().get('k', 'unknown')).toBeNull()
  })
})

describe('§2.33 — round-trip persistence across store instances', () => {
  it('a value set by one store instance is readable by a new instance with the same userData and machineId', async () => {
    const keytarFail = () =>
      fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })

    const storeA = makeStore({ keytar: keytarFail(), machineId: () => 'stable-machine-x' })
    await storeA.set('persist:token', 'hello-world', 'imap_smtp')

    // Clear the module-scope probe cache so storeB runs a fresh probe.
    __resetSecretStoreProbeForTest()

    const storeB = makeStore({ keytar: keytarFail(), machineId: () => 'stable-machine-x' })
    // storeB reads from disk, not from storeA's in-memory state.
    expect(await storeB.get('persist:token', 'imap_smtp')).toBe('hello-world')
  })
})

describe('§2.33 — cross-platform machine-id sources (BLOCKER: bind on all OSes)', () => {
  const ORIG_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!

  function withPlatform(platform: NodeJS.Platform, fn: () => void) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try {
      fn()
    } finally {
      Object.defineProperty(process, 'platform', ORIG_PLATFORM)
    }
  }

  beforeEach(() => {
    execFileSyncMock.mockReset()
    __resetSecretStoreProbeForTest() // also clears the machine-id cache
  })

  it('linux: reads /etc/machine-id', () => {
    machineIdFileOverride.fn = (p) => {
      if (p === '/etc/machine-id') return 'linux-machine-uuid\n'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    withPlatform('linux', () => expect(defaultMachineId()).toBe('linux-machine-uuid'))
    expect(execFileSyncMock).not.toHaveBeenCalled() // no subprocess on Linux
  })

  it('linux: falls back to /var/lib/dbus/machine-id when /etc/machine-id is absent', () => {
    machineIdFileOverride.fn = (p) => {
      if (p === '/var/lib/dbus/machine-id') return 'dbus-machine-uuid\n'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    withPlatform('linux', () => expect(defaultMachineId()).toBe('dbus-machine-uuid'))
  })

  it('darwin: parses IOPlatformUUID from ioreg', () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('ioreg')
      expect(args).toContain('IOPlatformExpertDevice')
      return [
        '+-o IOPlatformExpertDevice  <class IOPlatformExpertDevice>',
        '  {',
        '    "IOPlatformUUID" = "AAAA1111-BBBB-2222-CCCC-3333DDDD4444"',
        '  }',
      ].join('\n')
    })
    withPlatform('darwin', () =>
      expect(defaultMachineId()).toBe('AAAA1111-BBBB-2222-CCCC-3333DDDD4444'),
    )
  })

  it('win32: parses MachineGuid from reg query', () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('reg')
      expect(args).toContain('MachineGuid')
      return [
        '',
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography',
        '    MachineGuid    REG_SZ    11112222-3333-4444-5555-666677778888',
        '',
      ].join('\r\n')
    })
    withPlatform('win32', () =>
      expect(defaultMachineId()).toBe('11112222-3333-4444-5555-666677778888'),
    )
  })

  it('returns null on every platform when no source yields an id (fail-closed material)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('command not found')
    })
    machineIdFileOverride.fn = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    withPlatform('darwin', () => expect(defaultMachineId()).toBeNull())
    __resetSecretStoreProbeForTest()
    withPlatform('win32', () => expect(defaultMachineId()).toBeNull())
    __resetSecretStoreProbeForTest()
    withPlatform('linux', () => expect(defaultMachineId()).toBeNull())
  })

  it('caches the resolved machine id (does not re-shell per derivation)', () => {
    execFileSyncMock.mockImplementation(() => '    "IOPlatformUUID" = "CACHED-UUID"')
    withPlatform('darwin', () => {
      expect(defaultMachineId()).toBe('CACHED-UUID')
      expect(defaultMachineId()).toBe('CACHED-UUID')
    })
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
  })
})

describe('§2.33 — machine binding holds via the injected source (cross-machine)', () => {
  it('ciphertext from machine A is undecryptable under machine B (platform-agnostic)', async () => {
    // This proves the binding regardless of WHICH platform source produced the
    // id — the same property now holds on macOS/Windows, not only Linux, because
    // every platform now supplies a real machine id (see source tests above).
    const keytarA = fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })
    const storeA = makeStore({ keytar: keytarA, machineId: () => 'machine-A' })
    await storeA.set('k', 'secret', 'unknown')

    __resetSecretStoreProbeForTest()
    const keytarB = fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) })
    const storeB = makeStore({ keytar: keytarB, machineId: () => 'machine-B' })
    await expect(storeB.get('k', 'unknown')).rejects.toThrow()
  })
})

describe('§2.33 — HIGH-1: probe must not divert NON-keychain faults to disk', () => {
  it('probe rejecting with a non-keychain error → operations throw explicitly (no fallback)', async () => {
    const probeErr = new Error('native keytar binding crashed')
    const keytar = fakeKeytar({ getPassword: vi.fn(async () => { throw probeErr }) })
    const store = makeStore({ keytar })

    // Both reads and writes surface the real fault rather than silently writing
    // a secret to the (unverified) disk fallback.
    await expect(store.get('k', 'imap_smtp')).rejects.toThrow('native keytar binding crashed')
    await expect(store.set('k', 'v', 'imap_smtp')).rejects.toThrow('native keytar binding crashed')

    // No silent fallback: no report, no fallback / salt files on disk.
    expect(reportMock).not.toHaveBeenCalled()
    expect(fs.existsSync(fallbackPath())).toBe(false)
    expect(fs.existsSync(saltPath())).toBe(false)
  })
})

describe('§2.33 — HIGH-2: a corrupt fallback file never loses data', () => {
  function fallbackStore() {
    return makeStore({ keytar: fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) }) })
  }
  function corruptBackups(): string[] {
    return fs.readdirSync(dataDir).filter((f) => f.startsWith(`${FALLBACK_FILE}.corrupt-`))
  }

  it('set() preserves the original (corrupt) bytes in a .corrupt-* sibling, then writes', async () => {
    const corruptBytes = '{"version":1,"entries":{"deadbeef":"truncated-blob...'
    fs.writeFileSync(fallbackPath(), corruptBytes)

    await fallbackStore().set('k', 'v', 'unknown')

    // The new value is stored + readable from the freshly-written file.
    __resetSecretStoreProbeForTest()
    expect(await fallbackStore().get('k', 'unknown')).toBe('v')

    // The original bytes survived for manual recovery — not silently clobbered.
    const backups = corruptBackups()
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe(corruptBytes)
  })

  it('delete() preserves a corrupt file instead of clobbering it', async () => {
    const corruptBytes = 'not-json-but-not-empty'
    fs.writeFileSync(fallbackPath(), corruptBytes)

    await fallbackStore().delete('k', 'unknown')

    const backups = corruptBackups()
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe(corruptBytes)
  })

  it('get() on a corrupt file returns null and does NOT mutate / back up anything', async () => {
    fs.writeFileSync(fallbackPath(), 'totally-corrupt{{{')
    expect(await fallbackStore().get('k', 'unknown')).toBeNull()
    expect(corruptBackups()).toHaveLength(0) // reads never rename
  })
})

describe('§2.33 — MEDIUM: decrypt length guard + pinned scrypt params', () => {
  function fallbackStore(machineId?: () => string | null) {
    return makeStore({
      keytar: fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) }),
      machineId,
    })
  }

  it('a truncated / short blob fails in a controlled way (length guard, not opaque native error)', async () => {
    const hash = createHash('sha256').update('k', 'utf8').digest('hex')
    const shortBlob = Buffer.alloc(10).toString('base64') // 10 < IV(12) + TAG(16)
    fs.writeFileSync(fallbackPath(), JSON.stringify({ version: 1, entries: { [hash]: shortBlob } }))
    await expect(fallbackStore().get('k', 'unknown')).rejects.toThrow(/too short/i)
  })

  it('an invalid-base64 blob fails controlled (decodes below the IV+TAG floor)', async () => {
    const hash = createHash('sha256').update('k', 'utf8').digest('hex')
    fs.writeFileSync(fallbackPath(), JSON.stringify({ version: 1, entries: { [hash]: '@@@' } }))
    await expect(fallbackStore().get('k', 'unknown')).rejects.toThrow(/too short/i)
  })

  it('round-trips under the pinned scrypt parameters across store instances', async () => {
    const storeA = fallbackStore(() => 'fixed-machine-id')
    await storeA.set('k', 'value-123', 'unknown')

    __resetSecretStoreProbeForTest()
    const storeB = fallbackStore(() => 'fixed-machine-id')
    expect(await storeB.get('k', 'unknown')).toBe('value-123')
  })
})

describe('§2.33 — probe reset hook explicit contract', () => {
  it('__resetSecretStoreProbeForTest clears the cached decision so the probe fires again', async () => {
    // First session: probe always fails → cached as fallback.
    const store1 = makeStore({
      keytar: fakeKeytar({ getPassword: vi.fn(async () => { throw keychainErr() }) }),
    })
    await store1.get('x', 'unknown') // triggers probe → caches 'fallback'

    __resetSecretStoreProbeForTest()

    // Second session: probe succeeds → keytar path.
    const healthyGet = vi.fn(async (_s: string, account: string): Promise<string | null> =>
      account === PROBE_ACCOUNT ? null : 'from-keytar',
    )
    const store2 = makeStore({ keytar: fakeKeytar({ getPassword: healthyGet }) })
    expect(await store2.get('x', 'unknown')).toBe('from-keytar')
    // Confirm the probe was re-run (not still cached as fallback after reset).
    expect(healthyGet).toHaveBeenCalledWith('mailcopilot', PROBE_ACCOUNT)
  })
})
