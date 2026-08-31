/**
 * SQL hot-path instrumentation (§2.156, point 3).
 *
 * better-sqlite3 is synchronous by construction, so every statement runs ON
 * the main-process event loop: a slow statement IS a main-process freeze. The
 * freeze watchdog in electron/ipc.ts used to attribute a stall to the
 * oldest-inflight IPC handler, which is systematically wrong — a handler
 * waiting on the network holds no loop time at all (the reporter's log blamed
 * `net:setSeen` for 67 s and `search:coverageStats`, which runs in the search
 * worker thread, for 3 s). This module supplies the honest attribution:
 * measure the synchronous DB calls themselves and remember the slow ones.
 *
 * ── How it is wired ───────────────────────────────────────────────────────
 * Instead of touching 400+ call sites, we patch the better-sqlite3 PROTOTYPES
 * once (Statement.run/get/all/iterate, Database.exec/pragma). The fast path is
 * two `Date.now()` reads and one comparison; nothing is allocated and the SQL
 * text is not even looked at unless the call crossed the threshold.
 *
 * Cost, measured against the real driver (median of 9 alternating rounds,
 * 200 000 calls each, in-memory `SELECT a, b FROM t WHERE a = ?` — about the
 * cheapest statement that exists): 480 ns/call unpatched, 562 ns/call patched,
 * i.e. ~80 ns of wrapper. Every statement this codebase actually runs costs
 * microseconds to milliseconds, so the instrumentation cannot itself become a
 * source of the pauses it measures.
 *
 * ── What is recorded: never the statement text ────────────────────────────
 * A sample carries a DIGEST and a FINGERPRINT. The text itself is read, hashed
 * and dropped — no branch retains it, not for prepared statements and not for
 * `exec`/`pragma`.
 *
 * An earlier revision kept the text of prepared statements, on the theory that
 * `Statement.source` is our own source code with `?` wherever a value goes.
 * That theory rests on an assumption the instrumentation CANNOT CHECK: `source`
 * returns whatever string reached `prepare()`, and the `?` are there only if
 * the caller put them there. One of 400+ call sites interpolating a folder
 * name, an address or a search query before `prepare()` would deposit it in the
 * retained text, and nothing here could tell the difference. In a mail client
 * the database is the user's correspondence, so an unverifiable assumption is
 * not an acceptable guard — decided 2026-08-19 after security review.
 *
 *  - `digest` — "<verb> <table>", two identifiers matched by the digest's own
 *    pattern. Low cardinality, safe as a telemetry tag.
 *  - `fingerprint` — 8 hex characters of SHA-256 over the whitespace-normalised
 *    text: a short PSEUDONYMOUS CORRELATION TOKEN, stable across runs and
 *    builds, that tells apart the dozens of statements which all digest to
 *    "select messages". Resolve it with
 *    `node scripts/sql-fingerprint.mjs <fingerprint>`.
 *    Read it for what it is: 32 unsalted bits are NOT a confidentiality
 *    boundary. Against a low-entropy input a candidate can simply be hashed and
 *    compared — the resolver script does exactly that, over the repository's
 *    own sources. That is precisely why the statement text is not stored: the
 *    protection is that nothing sensitive is hashed in the first place, not
 *    that the hash would hide it.
 *
 * Samples are held in a bounded in-memory buffer and are drained by the freeze
 * watchdog; nothing here writes to disk or to telemetry directly.
 *
 * ── Known limits (stated so nobody reads more into the data) ──────────────
 * - `iterate()` is timed to first return, not over the whole iteration.
 * - COMMIT/fsync inside `db.transaction(...)` is executed by better-sqlite3's
 *   internal statements and is NOT visible here; the constituent statements
 *   are.
 */

import { createHash } from 'node:crypto'

export type SlowSqlSample = {
  /** Low-cardinality "<verb> <table>" descriptor, safe as a telemetry tag. */
  digest: string
  /**
   * 8 hex chars identifying WHICH statement this was, without carrying its
   * text. A correlation token, not a redaction: see `sqlFingerprint` for why 32
   * unsalted bits guarantee no secrecy. Map it to a source location with
   * `node scripts/sql-fingerprint.mjs <fingerprint>`.
   */
  fingerprint: string
  durationMs: number
  /** Date.now() at completion. */
  at: number
}

/**
 * A statement slower than this is worth remembering. Deliberately well below
 * the 200 ms watchdog threshold so that a freeze can be attributed to a pair
 * of medium statements, not only to one huge one.
 */
export const DEFAULT_SLOW_SQL_MS = 50

/** Upper bound on retained samples between drains — the slowest ones win. */
const MAX_SAMPLES = 8

/** Cap on how much text the digest pass looks at. Nothing here is retained. */
const MAX_SQL_CHARS = 200

/**
 * Mutable state is process-global, not module-global, and deliberately so: the
 * patch lands on the shared better-sqlite3 prototypes, so a second instance of
 * this module (test suites re-import packages/db under `vi.resetModules()`)
 * must see the same patch marker and drain the same buffer. Without this the
 * wrappers would stack one layer per reload and each layer would report into a
 * buffer nobody reads.
 */
type SqlTimingState = {
  thresholdMs: number
  samples: SlowSqlSample[]
  restorers: Array<() => void>
}

const STATE_KEY = Symbol.for('mailcopilot.sqlTiming.state')
const globalScope = globalThis as unknown as Record<symbol, SqlTimingState | undefined>
const state: SqlTimingState = globalScope[STATE_KEY] ?? {
  thresholdMs: DEFAULT_SLOW_SQL_MS,
  samples: [],
  restorers: [],
}
globalScope[STATE_KEY] = state

const samples = state.samples

/**
 * Input pass for `sqlDigest` — NOT a sanitiser of anything that gets stored,
 * because nothing textual gets stored any more. Its only job is to keep the
 * digest's keyword scan from landing inside a comment or a quoted string and
 * emitting an identifier-shaped token from there. Exported for its tests; the
 * result is never retained, never logged and never sent.
 */
export function normaliseForDigest(sql: string): string {
  return String(sql)
    // Comments first: a `/* ... */` can otherwise hide a `from <word>` pair.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    // String literals, including doubled-quote escapes. Written as
    // '[^']*(?:''[^']*)*' rather than '(?:[^']|'')*' so the match is linear.
    .replace(/'[^']*(?:''[^']*)*'/g, "'?'")
    .replace(/"[^"]*(?:""[^"]*)*"/g, '"?"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SQL_CHARS)
}

/**
 * 8 hex characters of SHA-256 over the whitespace-normalised statement — a
 * pseudonymous correlation token, not a redaction mechanism.
 *
 * Why a fingerprint at all: the digest says "select messages", and this schema
 * has dozens of those — the field log that started §2.156 was only readable
 * because it carried full text. The fingerprint keeps that precision without
 * keeping the text, and 8 hex characters are short enough to sit in a log line
 * and wide enough (4 billion values) not to collide across a few hundred
 * statements.
 *
 * What it does NOT provide: secrecy of the input. 32 bits, unsalted, over an
 * input drawn from a small guessable set is recoverable by hashing candidates
 * and comparing — `scripts/sql-fingerprint.mjs` is a working demonstration.
 * So this function must never be reached for as a way to "safely include"
 * something sensitive; the design holds because the text it hashes is not
 * retained anywhere, in any form.
 *
 * Normalisation is whitespace-only and deliberately trivial, because
 * `scripts/sql-fingerprint.mjs` has to reproduce it byte-for-byte from source
 * files, where the same statement is written across several lines. That script
 * carries the identical three lines plus a self-check against the golden vector
 * pinned in this module's tests — if the algorithms ever drift, the script
 * refuses to run instead of printing wrong answers.
 */
export function sqlFingerprint(sql: string): string {
  return createHash('sha256')
    .update(String(sql).replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 8)
}

const SQL_VERBS = new Set([
  'select', 'insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter',
  'pragma', 'begin', 'commit', 'rollback', 'vacuum', 'with', 'explain',
  'analyze', 'reindex', 'attach', 'detach',
])

/**
 * Collapse a statement to "<verb> <table>" — two identifiers, both from our own
 * schema. Low enough cardinality for a telemetry tag, and structurally
 * incapable of carrying a literal: only characters matched by the identifier
 * pattern are emitted.
 */
export function sqlDigest(sql: string): string {
  const text = normaliseForDigest(sql)
  const verbMatch = /^([A-Za-z]+)/.exec(text)
  const verb = verbMatch && SQL_VERBS.has(verbMatch[1]!.toLowerCase())
    ? verbMatch[1]!.toLowerCase()
    : 'other'
  if (verb === 'pragma') {
    const pragmaName = /^pragma\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(text)
    return `pragma ${pragmaName ? pragmaName[1]!.toLowerCase() : 'unknown'}`
  }
  const target = /\b(?:from|into|update|join|table)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(text)
  return `${verb} ${target ? target[1]!.toLowerCase().slice(0, 40) : 'unknown'}`
}

/**
 * Read the text, derive the two things we keep, drop the text. `sql` is a
 * parameter of this function and of nothing else — it is never assigned to a
 * field of the sample, so there is no branch, no flag and no source
 * classification that could ever put it in the buffer.
 */
function record(sql: string, durationMs: number): void {
  const sample: SlowSqlSample = {
    digest: sqlDigest(sql),
    fingerprint: sqlFingerprint(sql),
    durationMs,
    at: Date.now(),
  }
  if (samples.length < MAX_SAMPLES) {
    samples.push(sample)
    return
  }
  let slowestOfTheWeak = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.durationMs < samples[slowestOfTheWeak]!.durationMs) slowestOfTheWeak = i
  }
  if (durationMs > samples[slowestOfTheWeak]!.durationMs) samples[slowestOfTheWeak] = sample
}

/**
 * Drain the slow-statement buffer, slowest first.
 *
 * The buffer starts filling when the database opens, which is earlier than any
 * consumer exists — the first drain therefore carries schema migrations and
 * other startup work. Deciding what belongs to a given window is the CONSUMER's
 * job, which is why every sample carries `at`: the freeze watchdog keeps the
 * ones that completed inside the window it measured and reports the rest
 * separately (electron/ipc.ts). Draining clears, so a statement is never
 * offered to two consumers.
 */
export function takeSlowSqlSamples(): SlowSqlSample[] {
  if (samples.length === 0) return []
  const drained = samples.splice(0, samples.length)
  drained.sort((a, b) => b.durationMs - a.durationMs)
  return drained
}

// --- Prototype patching ----------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown
type Describe = (self: unknown, args: unknown[]) => string

const PATCHED = Symbol.for('mailcopilot.sqlTiming.patched')
const restorers = state.restorers

function patch(
  proto: Record<string | symbol, unknown> | null,
  method: string,
  describe: Describe,
): void {
  if (!proto) return
  const original = proto[method]
  if (typeof original !== 'function') return
  if ((original as unknown as Record<symbol, unknown>)[PATCHED]) return
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const started = Date.now()
    try {
      return (original as AnyFn).apply(this, args)
    } finally {
      const durationMs = Date.now() - started
      if (durationMs >= state.thresholdMs) {
        // Instrumentation must never turn a working query into a failure.
        try { record(describe(this, args), durationMs) } catch { /* ignore */ }
      }
    }
  }
  Object.defineProperty(wrapped, PATCHED, { value: true })
  proto[method] = wrapped
  restorers.push(() => { proto[method] = original })
}

const describeStatement: Describe = (self) => {
  const source = (self as { source?: unknown } | null)?.source
  return typeof source === 'string' ? source : 'unknown'
}

const describeExec: Describe = (_self, args) =>
  typeof args[0] === 'string' ? args[0] : 'unknown'

const describePragma: Describe = (_self, args) =>
  typeof args[0] === 'string' ? `PRAGMA ${args[0]}` : 'PRAGMA unknown'

/**
 * Patch the better-sqlite3 prototypes reachable from `db`. Idempotent, and a
 * no-op on anything that does not look like a better-sqlite3 handle — a
 * failure to instrument must not stop the database from opening.
 *
 * Returns true when the patch was applied.
 */
export function installSqlTiming(db: unknown, options?: { slowMs?: number }): boolean {
  if (options?.slowMs != null && Number.isFinite(options.slowMs)) {
    state.thresholdMs = Math.max(0, options.slowMs)
  }
  try {
    const handle = db as { prepare?: (sql: string) => unknown }
    if (typeof handle?.prepare !== 'function') return false
    const statement = handle.prepare('SELECT 1')
    const statementProto = Object.getPrototypeOf(statement) as Record<string, unknown> | null
    for (const method of ['run', 'get', 'all', 'iterate']) {
      patch(statementProto, method, describeStatement)
    }
    const dbProto = Object.getPrototypeOf(handle) as Record<string, unknown> | null
    patch(dbProto, 'exec', describeExec)
    patch(dbProto, 'pragma', describePragma)
    return true
  } catch {
    return false
  }
}

/** Test-only: undo the prototype patches and clear retained samples. */
export function __uninstallSqlTimingForTest(): void {
  while (restorers.length > 0) restorers.pop()!()
  samples.length = 0
  state.thresholdMs = DEFAULT_SLOW_SQL_MS
}
