/**
 * FTS5 index maintenance primitives (§2.156).
 *
 * Two jobs live here, both extracted from packages/db/index.ts so they can be
 * unit-tested without an Electron runtime:
 *
 *  1. `mergeFtsStep` — ONE bounded incremental merge of the FTS5 index.
 *  2. `decodeFtsStructure` / `readFtsSegmentCount` — an honest segment count.
 *
 * ── Why incremental merge and not 'optimize' ──────────────────────────────
 * The FTS5 documentation is explicit about the command this module replaces:
 * "Because it reorganizes the entire FTS index, the optimize command can take
 * a long time to run", and it points at the 'merge' command with a page limit
 * as the way to "achieve the same result as optimize without blocking".
 * better-sqlite3 is synchronous by construction, so "a long time" is measured
 * on the main process event loop: on the reporter's 106 906-message mailbox
 * (110 MB index) a single 'optimize' held the loop for 4 277 ms, eight times
 * per session, which is what killed the tray icon (the D-Bus StatusNotifier
 * object lives in main and cannot answer property reads while blocked).
 *
 * Measured on a copy of that same database (SQLite 3.45, page_size 4096):
 *
 *   optimize (6 segments → 1)              1 384 ms  in ONE blocking call
 *   merge cycle, 64 pages/step (20 → 1)    2 673 ms  over 410 steps
 *                                          median 5.2 ms, p95 12.9 ms, max 26 ms
 *
 * Same end state, no call over a few tens of milliseconds. The scheduler that
 * spreads the steps (and lets the loop breathe between them) is
 * electron/services/ftsMaintenance.ts — this module only does one step.
 *
 * Protocol, per the FTS5 docs: call once with a NEGATIVE page count (starts a
 * merge even when the automerge criteria are not met), then repeatedly with a
 * POSITIVE one until no work is left. "No work left" is reported through
 * `sqlite3_total_changes()`: a no-op merge bumps it by exactly 1, real work by
 * 2 or more. That is the documented signal, and it is why this function reads
 * `total_changes()` around the statement instead of trusting `changes`.
 *
 * automerge / crisismerge are deliberately left at their defaults (4 and 16).
 * Evidence, from the same database: 3 000 single-row FTS commits with the
 * defaults ran at median 1.4 ms / p99 6.8 ms / max 197 ms per commit, and the
 * segment count settled at 20 — i.e. the write path stays under the 200 ms
 * freeze threshold and the automatic merging does keep up. Retuning them
 * without a measurement that says otherwise would be a guess.
 */

/** Minimal structural shape of the better-sqlite3 handle we need. Structural
 *  on purpose: tests pass a plain object, and packages/db stays free of a
 *  type-only dependency in this file. */
export interface FtsSqliteHandle {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
}

export type FtsMergeStepResult = {
  /** Wall-clock duration of the synchronous merge call itself. */
  durationMs: number
  /** True when SQLite actually merged something (total_changes grew by >1). */
  worked: boolean
}

/** Page budget for one merge step. 64 pages ≈ 256 KB of merge work; measured
 *  max 26 ms per step on a 110 MB index (see header). Smaller budgets are
 *  safe but converge slowly (16 pages needed >400 steps for the same work). */
export const FTS_MERGE_PAGES_PER_STEP = 64

const MERGE_SQL = `INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', ?)`
const TOTAL_CHANGES_SQL = `SELECT total_changes() AS c`

function totalChanges(db: FtsSqliteHandle): number {
  const row = db.prepare(TOTAL_CHANGES_SQL).get() as { c?: number } | undefined
  return typeof row?.c === 'number' ? row.c : 0
}

/**
 * Run a single FTS5 'merge' step. `pages` follows the FTS5 convention:
 * negative starts a new merge regardless of the automerge criteria, positive
 * continues one. Errors propagate — the caller (ftsMaintenance) owns the
 * failure metric and the decision to stop the cycle.
 */
export function mergeFtsStep(db: FtsSqliteHandle, pages: number): FtsMergeStepResult {
  const before = totalChanges(db)
  const start = Date.now()
  db.prepare(MERGE_SQL).run(pages)
  const durationMs = Date.now() - start
  const after = totalChanges(db)
  return { durationMs, worked: after - before > 1 }
}

export type FtsStructure = {
  /** Number of levels in the FTS5 structure record. */
  levels: number
  /** Number of segments across all levels — the number that actually matters
   *  for search latency, and the one the old log line got wrong. */
  segments: number
}

/** FTS5_MAX_SEGMENT in fts5_index.c. Values above this mean we mis-parsed. */
const MAX_PLAUSIBLE = 2000

/**
 * Decode the leading fields of the FTS5 structure record (row id=10 of
 * `<table>_data`): 4-byte cookie, an optional 0xFF marker for the v2 record
 * format, then varints `nLevel` and `nSegment`.
 *
 * This reads an internal-but-stable FTS5 layout, so it is best-effort by
 * contract: anything unexpected returns null and the caller reports "unknown"
 * rather than a wrong number. It exists because the alternative honest count,
 * `SELECT count(*) FROM messages_fts_data`, is a full table scan — measured at
 * 34-45 ms on the reporter's index, versus 0.01 ms for this single-row read —
 * and because that count answers a different question anyway: it counts 4 KB
 * storage BLOCKS, not segments. The old log line called blocks "segments" and
 * therefore reported 29 397 where the true segment count was 6.
 */
export function decodeFtsStructure(block: Uint8Array | null | undefined): FtsStructure | null {
  if (!block || block.length < 6) return null
  let i = 4 // cookie
  if (block[i] === 0xff) i += 1 // v2 structure marker
  const levels = readVarint(block, i)
  if (!levels) return null
  const segments = readVarint(block, levels.next)
  if (!segments) return null
  if (levels.value > MAX_PLAUSIBLE || segments.value > MAX_PLAUSIBLE) return null
  return { levels: levels.value, segments: segments.value }
}

/** SQLite varint, limited to 5 bytes: every value this decoder cares about is
 *  far below 2^35, and a longer run means we are not looking at a structure
 *  record. Returns null rather than guessing. */
function readVarint(buf: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0
  for (let n = 0; n < 5; n++) {
    const i = offset + n
    if (i >= buf.length) return null
    const byte = buf[i]!
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) return { value, next: i + 1 }
  }
  return null
}

const STRUCTURE_SQL = `SELECT block FROM messages_fts_data WHERE id = 10`

/**
 * Read the current segment count of `messages_fts`. Cheap (single-row read),
 * best-effort (undefined when FTS is absent or the record cannot be decoded).
 */
export function readFtsSegmentCount(db: FtsSqliteHandle): number | undefined {
  try {
    const row = db.prepare(STRUCTURE_SQL).get() as { block?: Uint8Array } | undefined
    return decodeFtsStructure(row?.block)?.segments
  } catch {
    return undefined
  }
}
