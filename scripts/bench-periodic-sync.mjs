/**
 * §2.156 diagnosis bench — measure the SYNCHRONOUS cost of one periodic-sync
 * pass against a real-size cache.
 *
 * The periodic sync loop (electron/main.ts `syncOneAccountFolders`) awaits IMAP
 * but does every cache read/write on the main thread. This script replays the
 * DB-only part of one pass — the exact production functions from packages/db
 * and the exact call order of the folder loop — and reports per-call wall time,
 * so a stall can be attributed to a named call instead of guessed at.
 *
 * IMAP is NOT exercised: the point is precisely the synchronous half.
 *
 * Usage:
 *   node scripts/bench-periodic-sync.mjs <path-to-throwaway-db-copy>
 *
 *   <path> may be a directory holding `cache.db`, or the `cache.db` file
 *   itself. Copy the WAL and SHM sidecars along with it — the WAL is part of
 *   the state being measured.
 *
 *     cp ~/.mailcopilot/cache.db      /tmp/bench/cache.db
 *     cp ~/.mailcopilot/cache.db-wal  /tmp/bench/cache.db-wal
 *     cp ~/.mailcopilot/cache.db-shm  /tmp/bench/cache.db-shm
 *     node scripts/bench-periodic-sync.mjs /tmp/bench
 *
 * Flags:
 *   --writes   also measure the write calls (applyFolderSyncBatch,
 *              upsertSyncState). Off by default: they mutate the copy, so the
 *              second run of the same copy is no longer a cold measurement.
 *   --json     emit machine-readable JSON instead of the table.
 *
 * Safety: refuses to run against a live profile directory, by FILESYSTEM
 * IDENTITY rather than by path spelling (see `directoryIdentity`). The whole
 * point is a throwaway copy; pointing this at `~/.mailcopilot` would write test
 * rows into real mail state.
 *
 * Privacy: the report names nothing. Folder names come from the IMAP server and
 * the data directory is a real path on the developer's machine — both are the
 * kind of thing that ends up pasted into a bug report — so the output carries
 * positional labels and aggregates only (see `label`).
 *
 * NOT wired into CI — this is a diagnostic tool, run by hand.
 *
 * Requires better-sqlite3 built for the Node ABI (npm rebuild better-sqlite3),
 * and `npx electron-builder install-app-deps` afterwards to restore the
 * Electron ABI. See scripts/run-native-tests.mjs for the same sandwich.
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))
const WITH_WRITES = flags.has('--writes')
const AS_JSON = flags.has('--json')

if (positional.length !== 1) {
  console.error('Usage: node scripts/bench-periodic-sync.mjs <path-to-throwaway-db-copy> [--writes] [--json]')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Resolve and guard the target
// ---------------------------------------------------------------------------
/**
 * Identity of a directory as the FILESYSTEM sees it, not as the path spells it.
 *
 * `path.resolve` normalizes text and nothing else: a symlink pointing at the
 * live profile resolved to its own path and sailed straight through the string
 * comparison this replaces. What follows a passed check is not read-only —
 * MAILCOPILOT_DATA_DIR is exported and packages/db opens the database FOR
 * WRITING (migrations, WAL, and synthetic rows under `--writes`). Writing into
 * live user state from a developer tool is the §2.132 incident class, so the
 * comparison is made on the object (device, inode) after every link is
 * resolved, and both sides are resolved — the target and each candidate.
 *
 * Throws when identity cannot be established; callers refuse rather than guess.
 * A filesystem that reports no meaningful inode collapses distinct directories
 * into one identity — which yields a refusal, i.e. it errs in the safe
 * direction, and the fix is to run the bench from a normal filesystem.
 */
function directoryIdentity(dir) {
  const real = fs.realpathSync(dir)
  const st = fs.statSync(real)
  return `${st.dev}:${st.ino}`
}

const target = path.resolve(positional[0])
if (!fs.existsSync(target)) {
  console.error(`No such path: ${target}`)
  process.exit(1)
}

// Resolve the argument itself before deciding what its directory is: a symlink
// to a FILE inside the live profile would otherwise yield the symlink's own
// parent as `dataDir` and defeat the check below.
let targetReal
try {
  targetReal = fs.realpathSync(target)
} catch (err) {
  console.error(`Refusing to run: cannot resolve ${target} (${err?.message ?? err}).`)
  process.exit(1)
}
const dataDir = fs.statSync(targetReal).isDirectory() ? targetReal : path.dirname(targetReal)

const LIVE_DIRS = [
  path.join(os.homedir(), '.mailcopilot'),
  path.join(os.homedir(), '.config', 'mailcopilot'),
  path.join(os.homedir(), 'Library', 'Application Support', 'mailcopilot'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'mailcopilot'),
]

// Refuse BEFORE packages/db is imported: the import is what opens (and
// migrates) the database.
let dataDirId
try {
  dataDirId = directoryIdentity(dataDir)
} catch (err) {
  console.error(`Refusing to run: cannot establish the identity of ${dataDir} (${err?.message ?? err}).`)
  process.exit(1)
}
for (const live of LIVE_DIRS) {
  let liveId
  try {
    liveId = directoryIdentity(live)
  } catch (err) {
    // A candidate that simply does not exist on this platform is not a match.
    // Any other failure means we could not tell — and not being able to tell
    // resolves to refusal, never to "carry on".
    if (err?.code === 'ENOENT') continue
    console.error(`Refusing to run: cannot check live profile candidate ${live} (${err?.message ?? err}).`)
    process.exit(1)
  }
  if (liveId === dataDirId) {
    console.error(`Refusing to run against the live profile ${live}. Point this at a copy.`)
    process.exit(1)
  }
}

const dbFile = path.join(dataDir, 'cache.db')
if (!fs.existsSync(dbFile)) {
  console.error(`No cache.db in ${dataDir}. Copy the live DB (plus -wal and -shm) there first.`)
  process.exit(1)
}

process.env.MAILCOPILOT_DATA_DIR = dataDir

/**
 * Terminal-safe rendering of a string this script did not author.
 *
 * Allowlist, not blocklist — the same rule the telemetry surfaces follow: only
 * printable ASCII survives, anything else becomes `.`. Third-party text (a
 * mailbox name from the server, a driver's error message) must not be able to
 * move the cursor, set colours or clear the screen of a terminal whose contents
 * a developer then pastes into a bug report.
 */
function safeText(value, max = 200) {
  const s = String(value ?? '')
  let out = ''
  for (const ch of s.slice(0, max)) {
    const code = ch.codePointAt(0)
    out += code >= 0x20 && code <= 0x7e ? ch : '.'
  }
  return out
}

// ---------------------------------------------------------------------------
// Load packages/db through Vite so the TypeScript sources and path aliases
// resolve exactly as they do in the app.
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const { createServer } = await import(pathToFileURL(path.join(repoRoot, 'node_modules/vite/dist/node/index.js')).href)
const server = await createServer({
  root: repoRoot,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
  resolve: {
    alias: {
      '@mailcopilot/types': path.join(repoRoot, 'packages/types'),
      '@mailcopilot/core': path.join(repoRoot, 'packages/core'),
      '@mailcopilot/db': path.join(repoRoot, 'packages/db'),
    },
  },
  ssr: { external: ['better-sqlite3'] },
})
const db = await server.ssrLoadModule('/packages/db/index.ts')

// `listAccounts` / `getAccountMeta` live in packages/net/config (electron-store,
// not SQLite). They are measured because §2.165 puts `getAccountMeta` on the
// path of every outward IMAP operation. Optional: the module pulls keytar, and a
// machine without a usable keychain must still get the DB numbers.
let netConfig = null
try {
  netConfig = await server.ssrLoadModule('/packages/net/config.ts')
} catch (err) {
  console.warn(`packages/net/config not loadable, skipping account-store calls: ${safeText(err?.message ?? err)}`)
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------
/** Wall time of one synchronous call, in ms. */
function timeOnce(fn) {
  const t0 = performance.now()
  const value = fn()
  return { ms: performance.now() - t0, value }
}

/** Accumulates samples for one named call so we can report totals and worst case. */
class Tally {
  constructor(name) {
    this.name = name
    this.samples = []
  }
  add(ms) { this.samples.push(ms) }
  get calls() { return this.samples.length }
  get total() { return this.samples.reduce((a, b) => a + b, 0) }
  get max() { return this.samples.length ? Math.max(...this.samples) : 0 }
  get mean() { return this.samples.length ? this.total / this.samples.length : 0 }
}

const tallies = new Map()
function tally(name) {
  let t = tallies.get(name)
  if (!t) { t = new Tally(name); tallies.set(name, t) }
  return t
}
function measure(name, fn) {
  const { ms, value } = timeOnce(fn)
  tally(name).add(ms)
  return value
}

// ---------------------------------------------------------------------------
// Discover the periodic-sync working set the way the loop does
// ---------------------------------------------------------------------------
// Account ids come from the cache itself, so the bench needs no settings.json
// and no keychain. A separate read-only connection keeps discovery out of the
// measured statements.
const Database = (await import('better-sqlite3')).default
const probe = new Database(dbFile, { readonly: true })
const accountIds = probe
  .prepare('SELECT DISTINCT account_id AS id FROM folder_prefs ORDER BY account_id')
  .all()
  .map((r) => r.id)
const messagesTotal = probe.prepare('SELECT COUNT(*) AS c FROM messages').get().c
probe.close()

const plan = []
for (const accountId of accountIds) {
  const prefs = measure('listFolderPrefs (per account)', () => db.listFolderPrefs(accountId))
  const folders = prefs
    .filter((p) => p.headerSyncMode === 'full' || p.headerSyncMode === 'period')
    .map((p) => p.folderPath)
  plan.push({ accountId, folders })
}
const totalFolders = plan.reduce((a, p) => a + p.folders.length, 0)

// ---------------------------------------------------------------------------
// Report labels — the bench measures a mailbox, it does not describe one
// ---------------------------------------------------------------------------
// Folder names are third-party text: they arrive from the IMAP server and they
// describe how a person organises their mail. Account ids are equally
// identifying against the profile they came from. Neither is needed to read the
// "worst folders" table — its job is to show that ONE folder dominates a pass,
// not which. So the report speaks in positional labels.
//
// The mapping is derived from sorted order, which makes it deterministic: two
// runs against the same copy produce the same labels, so numbers stay
// comparable across runs (including `--writes` vs not).
const accountLabels = new Map(
  [...accountIds].sort((a, b) => a - b).map((id, i) => [id, `acct${String(i + 1).padStart(2, '0')}`]),
)
const folderLabels = new Map()
const folderKey = (accountId, folder) => `${accountId} ${folder}`
for (const { accountId, folders } of plan) {
  const acct = accountLabels.get(accountId) ?? 'acct??'
  ;[...folders].sort().forEach((folder, i) => {
    folderLabels.set(folderKey(accountId, folder), `${acct}/f${String(i + 1).padStart(2, '0')}`)
  })
}

// A 500-row synthetic batch, shaped like what fetchAllFolderHeaders hands the
// callback. UIDs are pushed far above any real UID so the upsert takes the
// INSERT path and no real row is overwritten.
const SYNTHETIC_UID_BASE = 900_000_000
function syntheticBatch(size) {
  const rows = []
  for (let i = 0; i < size; i++) {
    rows.push({
      uid: SYNTHETIC_UID_BASE + i,
      subject: `bench subject ${i} lorem ipsum dolor sit amet consectetur`,
      fromAddr: `bench${i}@example.invalid`,
      fromName: `Bench Sender ${i}`,
      toAddr: 'bench-recipient@example.invalid',
      date: new Date().toISOString(),
      unread: true,
      flagged: false,
      hasAttachments: false,
      messageId: `<bench-${i}@example.invalid>`,
      inReplyTo: undefined,
      references: undefined,
      attachmentFilenames: undefined,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Replay the DB-only half of one pass
// ---------------------------------------------------------------------------
const perFolder = []
for (const { accountId, folders } of plan) {
  for (const folder of folders) {
    const row = { accountId, folder, calls: {} }
    const track = (name, fn) => {
      const { ms, value } = timeOnce(fn)
      tally(name).add(ms)
      row.calls[name] = ms
      return value
    }

    // --- reads the folder loop does before the fetch
    const priorCrawl = track('getFolderCrawlState', () => db.getFolderCrawlState(accountId, folder))
    const priorSync = track('getSyncState', () => db.getSyncState(accountId, folder))

    // --- the post-fetch bookkeeping block (runs even when CONDSTORE skipped
    //     nothing, as long as the fetch itself was not skipped)
    track('getAccountMessageCount', () => db.getAccountMessageCount(accountId, folder))
    track('getMaxUidForFolder', () => db.getMaxUidForFolder(accountId, folder))

    // --- the no-op mail-rules pass (electron/services/mailRulesRunner runOnePass)
    const state = track('getMailRulesState', () => db.getMailRulesState(accountId, folder))
    track('getUidValidity (getSyncState)', () => db.getSyncState(accountId, folder)?.uidValidity ?? null)
    track('getUidsForRulesSince', () =>
      db.getUidsForRulesSince(accountId, folder, state?.watermarkUid ?? db.getMaxUidForFolder(accountId, folder), 200))

    // --- the per-IMAP-operation identity lookup added by §2.165
    //     (withOutcomeReporting -> currentGeneration -> accountExists)
    if (netConfig) {
      track('getAccountMeta (§2.165 per IMAP op)', () => netConfig.getAccountMeta(accountId))
    }

    if (WITH_WRITES) {
      track('applyFolderSyncBatch (500 rows)', () =>
        db.applyFolderSyncBatch(accountId, folder, syntheticBatch(500), null))
      track('upsertSyncState', () =>
        db.upsertSyncState(accountId, folder, priorSync?.highestModseq ?? null, priorSync?.uidValidity ?? null))
      track('applyFolderSyncBatch (final crawl-state commit)', () =>
        db.applyFolderSyncBatch(accountId, folder, [], {
          status: 'covered_full',
          watermarkUid: priorCrawl?.watermarkUid ?? null,
          totalExists: priorCrawl?.totalExists ?? null,
          crawledCount: priorCrawl?.crawledCount ?? null,
          highestModseq: priorCrawl?.highestModseq ?? null,
          lastAttemptAt: new Date().toISOString(),
          completedAt: priorCrawl?.completedAt ?? new Date().toISOString(),
          error: null,
        }))
    }

    row.total = Object.values(row.calls).reduce((a, b) => a + b, 0)
    perFolder.push(row)
  }
}

// ---------------------------------------------------------------------------
// Per-connection trust-store cost (§2.156 — the cause)
// ---------------------------------------------------------------------------
// The folder loop opens ONE dedicated IMAP connection per folder
// (runDedicatedImapRetry -> createDedicatedConnection, logout in `finally`), so
// whatever a single connection pays synchronously is paid `folders` times per
// pass. Handing `ca: string[]` to tls.connect makes Node build a fresh OpenSSL
// trust store per socket; a shared prebuilt SecureContext makes it once.
//
// Offline and deterministic: no server is contacted, this is pure main-thread
// CPU, which is exactly what the event-loop watchdog reports.
const tlsMod = await server.ssrLoadModule('/packages/net/tls.ts')
const tls = (await import('node:tls')).default
const combinedCa = tlsMod.getCombinedCaCertificates()

let trustStoreBefore = null
let trustStoreAfter = null
if (combinedCa) {
  // BEFORE: what `ca: combined` cost on every connection.
  const t0 = performance.now()
  for (let i = 0; i < totalFolders; i++) tls.createSecureContext({ ca: combinedCa })
  trustStoreBefore = performance.now() - t0

  // AFTER: what the shipped buildTlsOptions costs for the same connections.
  const cfg = { tlsPinsSha256: [], tlsPinnedCertsPem: [] }
  tlsMod.buildTlsOptions(cfg) // warm the shared context, as the first connection of a pass does
  const t1 = performance.now()
  for (let i = 0; i < totalFolders; i++) tlsMod.buildTlsOptions(cfg)
  trustStoreAfter = performance.now() - t1
}

// One PASSIVE WAL checkpoint — SQLite runs the same work implicitly at commit
// time once the WAL crosses wal_autocheckpoint, and electron/main.ts runs it
// on a 60s timer. Measured last so writes above are represented in the WAL.
const walBytes = fs.existsSync(`${dbFile}-wal`) ? fs.statSync(`${dbFile}-wal`).size : 0
const checkpoint = timeOnce(() => db.checkpointWalPassive())

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const passTotal = [...tallies.values()].reduce((a, t) => a + t.total, 0)
const rows = [...tallies.values()]
  .sort((a, b) => b.total - a.total)
  .map((t) => ({
    call: t.name,
    calls: t.calls,
    totalMs: +t.total.toFixed(1),
    meanMs: +t.mean.toFixed(2),
    maxMs: +t.max.toFixed(1),
    sharePct: +((t.total / passTotal) * 100).toFixed(1),
  }))

const summary = {
  // No `dataDir`: an absolute path on the developer's machine, and the report
  // is meant to be pasted around. The sizes below carry the information that
  // actually matters about the copy.
  dbBytes: fs.statSync(dbFile).size,
  walBytes,
  accounts: accountIds.length,
  folders: totalFolders,
  messages: messagesTotal,
  withWrites: WITH_WRITES,
  caCerts: combinedCa ? combinedCa.length : null,
  trustStorePerPassMs: {
    caArrayPerConnection: trustStoreBefore == null ? null : +trustStoreBefore.toFixed(1),
    sharedSecureContext: trustStoreAfter == null ? null : +trustStoreAfter.toFixed(1),
  },
  passTotalMs: +passTotal.toFixed(1),
  walCheckpointPassiveMs: +checkpoint.ms.toFixed(1),
  walCheckpointResult: checkpoint.value,
  perCall: rows,
  worstFolders: perFolder
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map((r) => ({
      folder: folderLabels.get(folderKey(r.accountId, r.folder)) ?? 'acct??/f??',
      totalMs: +r.total.toFixed(1),
    })),
}

if (AS_JSON) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`
  console.log(`\ndb=${mb(summary.dbBytes)} wal=${mb(summary.walBytes)} accounts=${summary.accounts} folders=${summary.folders} messages=${summary.messages}`)
  console.log(`writes=${WITH_WRITES ? 'on' : 'off'}  synchronous total for one pass: ${summary.passTotalMs} ms\n`)
  const w = Math.max(...rows.map((r) => r.call.length), 4)
  console.log(`${'call'.padEnd(w)} | calls |  total ms |  mean ms |   max ms | share`)
  console.log(`${'-'.repeat(w)}-+-------+-----------+----------+----------+------`)
  for (const r of rows) {
    console.log(
      `${r.call.padEnd(w)} | ${String(r.calls).padStart(5)} | ${r.totalMs.toFixed(1).padStart(9)} | ${r.meanMs.toFixed(2).padStart(8)} | ${r.maxMs.toFixed(1).padStart(8)} | ${String(r.sharePct).padStart(4)}%`,
    )
  }
  if (combinedCa) {
    console.log(
      `\ntrust store for ${totalFolders} connections (one per folder), ${combinedCa.length} CA certs:\n` +
      `  ca: string[] per connection (pre-§2.156) : ${trustStoreBefore.toFixed(1)} ms of main-thread work\n` +
      `  shared SecureContext (shipped)           : ${trustStoreAfter.toFixed(1)} ms`,
    )
  }
  console.log(`\nWAL checkpoint(PASSIVE) on a ${mb(walBytes)} WAL: ${summary.walCheckpointPassiveMs} ms ${safeText(JSON.stringify(checkpoint.value))}`)
  console.log('\nworst folders (sum of the calls above), labelled — see the label note above:')
  for (const f of summary.worstFolders) {
    console.log(`  ${safeText(f.folder, 40)} — ${f.totalMs} ms`)
  }
}

await server.close()
process.exit(0)
