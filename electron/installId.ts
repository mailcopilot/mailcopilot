/**
 * Anonymous install identifier.
 *
 * On first run we generate a random UUID via crypto.randomUUID() and persist
 * it to electron-store. On every subsequent run we read the same UUID from
 * disk, hash it, and emit only the first 16 hex chars off-device. The hash
 * is stable across releases so DAU/MAU, retention and cohort analysis don't
 * break every time the app auto-updates.
 *
 * Non-goals:
 *   - User tracking — the hash is not tied to any account/email.
 *   - Per-event attribution — the hash is ONLY emitted in session-level
 *     events (app.session_started, app.session_ended, usage.session_summary).
 *     Attaching it to every event would both bloat Sentry cardinality and
 *     make per-event data trivially joinable into a user-level trace.
 *
 * Storage key: `metrics.installId`, in the standard electron-store file.
 */

import Store from 'electron-store'
import crypto from 'node:crypto'

/**
 * Fixed application-wide salt for the install-id hash. This is intentionally
 * a compile-time constant: it's not a secret (MailCopilot is AGPL, the salt
 * ends up in the bundled source anyway), it exists only to domain-separate
 * MailCopilot install ids from any identical raw UUIDs that might end up in
 * other telemetry datasets in the same Sentry org.
 */
const INSTALL_ID_SALT = 'mailcopilot.v1.install'

const IS_E2E = process.env.MAILCOPILOT_E2E === '1'

type StoreShape = {
  'metrics.installId'?: string
  'metrics.lastVersion'?: string
  'metrics.firstSyncDone'?: Record<string, number>
  'metrics.firstMessageOpened'?: boolean
  /** Per-account timestamp of when we first saw it — used to compute the
   *  "time from account_saved to first header sync" histogram. */
  'metrics.accountSeenAt'?: Record<string, number>
}

let storeInstance: Store<StoreShape> | null = null
let cachedHash: string | null = null

function getStore(): Store<StoreShape> {
  if (storeInstance) return storeInstance
  storeInstance = new Store<StoreShape>({
    name: 'config',
    // Must match packages/net/config.ts projectName so both stores share
    // the same userData directory.
    projectName: IS_E2E ? 'mailcopilot-e2e' : 'mailcopilot',
  } as ConstructorParameters<typeof Store>[0])
  return storeInstance
}

function rawInstallId(): string {
  const store = getStore()
  let id = store.get('metrics.installId')
  if (typeof id === 'string' && id.length > 0) return id
  id = crypto.randomUUID()
  store.set('metrics.installId', id)
  return id
}

/**
 * Returns a stable 16-hex-char hash of the install id. Same machine ⇒ same
 * hash forever, across releases. Rotating on every version bump would break
 * retention / DAU / MAU analytics at every auto-update, so we deliberately
 * do NOT mix the version into the hash.
 *
 * Lazy + cached — safe to call on hot paths, but in practice only session
 * events read it.
 */
export function getInstallIdHash(): string {
  if (cachedHash) return cachedHash
  const raw = rawInstallId()
  const h = crypto.createHash('sha256').update(INSTALL_ID_SALT).update('|').update(raw).digest('hex')
  cachedHash = h.slice(0, 16)
  return cachedHash
}

/**
 * Persistent metrics state — used for app.updated detection and similar
 * one-shot diffs between sessions. Small surface area on purpose.
 */
export function getLastSeenAppVersion(): string | null {
  const v = getStore().get('metrics.lastVersion')
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function setLastSeenAppVersion(version: string): void {
  getStore().set('metrics.lastVersion', version)
}

/**
 * Per-account one-shot: record the timestamp of the first header sync
 * completion. Returns true only on the FIRST call for a given account —
 * subsequent calls are no-ops. Used to emit onboarding.first_headers_sync_completed
 * exactly once per account in the activation funnel.
 */
export function markFirstHeadersSync(accountId: number): number | null {
  const store = getStore()
  const map = (store.get('metrics.firstSyncDone') as Record<string, number> | undefined) ?? {}
  const key = String(accountId)
  if (map[key] != null) return null
  const now = Date.now()
  map[key] = now
  store.set('metrics.firstSyncDone', map)
  return now
}

/** Look up the first-sync timestamp for an account without setting it. */
export function getFirstHeadersSyncAt(accountId: number): number | null {
  const store = getStore()
  const map = (store.get('metrics.firstSyncDone') as Record<string, number> | undefined) ?? {}
  const ts = map[String(accountId)]
  return typeof ts === 'number' ? ts : null
}

/**
 * One-shot install-wide flag: the very first message the user opens after
 * connecting any account. True only on the first call, false thereafter.
 */
export function markFirstMessageOpened(): boolean {
  const store = getStore()
  if (store.get('metrics.firstMessageOpened') === true) return false
  store.set('metrics.firstMessageOpened', true)
  return true
}

/**
 * Record the first time we saw a given account. Called from accounts:save
 * handler so runSyncFolderHeaders can compute accurate value_ms for
 * onboarding.first_headers_sync_completed. Safe to call repeatedly — only
 * the first call for a given account id has any effect.
 */
export function markAccountSeen(accountId: number): void {
  const store = getStore()
  const map = (store.get('metrics.accountSeenAt') as Record<string, number> | undefined) ?? {}
  const key = String(accountId)
  if (map[key] != null) return
  map[key] = Date.now()
  store.set('metrics.accountSeenAt', map)
}

export function getAccountSeenAt(accountId: number): number | null {
  const store = getStore()
  const map = (store.get('metrics.accountSeenAt') as Record<string, number> | undefined) ?? {}
  const ts = map[String(accountId)]
  return typeof ts === 'number' ? ts : null
}

/** Test-only. Clears the in-memory cache so the next call re-reads the store. */
export function resetInstallIdCache(): void {
  cachedHash = null
  storeInstance = null
}
