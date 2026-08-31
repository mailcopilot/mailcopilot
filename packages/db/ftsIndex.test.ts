import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  decodeFtsStructure,
  mergeFtsStep,
  readFtsSegmentCount,
  FTS_MERGE_PAGES_PER_STEP,
  type FtsSqliteHandle,
} from './ftsIndex'

/**
 * Tests for the FTS5 maintenance primitives (§2.156, points 1 and 2).
 *
 * Split deliberately: the protocol and the structure decoder are covered
 * against fakes and byte buffers (these run under plain `npm test`), while the
 * end-state claim — "an incremental merge reaches the same single segment that
 * `optimize` would have produced" — is checked against a real SQLite index and
 * therefore only runs under `npm run test:db` (CLAUDE.md §5, ABI split).
 */

type DbModule = typeof import('./index')

let betterSqlite3Usable = true
try {
  const { default: Database } = await import('better-sqlite3')
  const probe = new Database(':memory:')
  probe.close()
} catch {
  betterSqlite3Usable = false
}

async function loadDbModule(): Promise<{ dir: string; mod: DbModule; prevDataDir: string | undefined }> {
  vi.resetModules()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-fts-test-'))
  const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
  process.env.MAILCOPILOT_DATA_DIR = dir
  const mod = await import('./index')
  return { dir, mod, prevDataDir }
}

function cleanup(dir: string, mod: DbModule, prevDataDir: string | undefined) {
  try { mod.default.close() } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true })
  if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
  else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
}

/** Fake better-sqlite3 handle: records SQL + params, scripts total_changes(). */
function fakeHandle(changeDeltas: number[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let changes = 0
  let pending = 0
  const handle = {
    prepare(sql: string) {
      return {
        get: (...params: unknown[]) => {
          calls.push({ sql, params })
          if (sql.includes('total_changes')) return { c: changes }
          return undefined
        },
        run: (...params: unknown[]) => {
          calls.push({ sql, params })
          changes += changeDeltas[pending++] ?? 1
          return undefined
        },
      }
    },
  }
  return { handle, calls }
}

describe('mergeFtsStep', () => {
  it("issues FTS5's documented merge command with the page budget as rank", () => {
    const { handle, calls } = fakeHandle([180])
    const result = mergeFtsStep(handle, -64)

    const merge = calls.find((c) => c.sql.includes('messages_fts('))!
    // Kills: reverting to `optimize`, which reorganises the entire index in
    // one synchronous call (4 277 ms on a 110 MB index) — the whole defect.
    expect(merge.sql).not.toContain('optimize')
    expect(merge.sql).toContain("VALUES('merge', ?)")
    expect(merge.params).toEqual([-64])
    expect(result.worked).toBe(true)
  })

  it('reads work from total_changes, where a no-op bumps the counter by exactly 1', () => {
    // Kills: treating "the INSERT reported a change" as "a merge happened".
    // FTS5 documents +1 for a no-op merge and +2 or more for real work, so a
    // naive changes-based check would loop until the step budget every time.
    const { handle } = fakeHandle([1])
    expect(mergeFtsStep(handle, 64).worked).toBe(false)

    const real = fakeHandle([2])
    expect(mergeFtsStep(real.handle, 64).worked).toBe(true)
  })

  it('defaults the page budget to a bounded number of pages', () => {
    expect(FTS_MERGE_PAGES_PER_STEP).toBeGreaterThan(0)
    expect(FTS_MERGE_PAGES_PER_STEP).toBeLessThanOrEqual(256)
  })
})

/** cookie + optional v2 marker + varints. Values here stay single-byte. */
function structureBytes(levels: number, segments: number, v2: boolean): Uint8Array {
  const head = v2 ? [0, 0, 0, 1, 0xff] : [0, 0, 0, 1]
  return Uint8Array.from([...head, levels, segments, 0, 0])
}

describe('decodeFtsStructure', () => {
  it('reads level and segment counts from a v1 record', () => {
    expect(decodeFtsStructure(structureBytes(3, 6, false))).toEqual({ levels: 3, segments: 6 })
  })

  it('skips the 0xFF marker of a v2 record', () => {
    // Kills: parsing v2 as v1 — the marker byte then decodes as a continuation
    // and yields nonsense (the real index reported "65 levels" that way).
    expect(decodeFtsStructure(structureBytes(2, 4, true))).toEqual({ levels: 2, segments: 4 })
  })

  it('decodes multi-byte varints', () => {
    // 0x81 0x00 = 128 in SQLite varint encoding.
    const bytes = Uint8Array.from([0, 0, 0, 1, 0x81, 0x00, 0x05, 0])
    expect(decodeFtsStructure(bytes)).toEqual({ levels: 128, segments: 5 })
  })

  it('returns null rather than a wrong number on anything unexpected', () => {
    expect(decodeFtsStructure(null)).toBeNull()
    expect(decodeFtsStructure(Uint8Array.from([1, 2, 3]))).toBeNull()
    // Implausible counts mean we mis-parsed; FTS5_MAX_SEGMENT is 2000.
    const absurd = Uint8Array.from([0, 0, 0, 1, 0xff, 0xff, 0x7f, 0x01, 0])
    expect(decodeFtsStructure(absurd)).toBeNull()
    // Unterminated varint run.
    expect(decodeFtsStructure(Uint8Array.from([0, 0, 0, 1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]))).toBeNull()
  })

  it('rejects an empty blob the same way as a missing one', () => {
    // Kills: a length check that only guards `null`/`undefined` and lets a
    // zero-length BLOB (e.g. a freshly-created, never-merged FTS table) fall
    // through into the varint reader.
    expect(decodeFtsStructure(Uint8Array.from([]))).toBeNull()
  })

  it('decodes the minimal 6-byte record (4-byte cookie + 1-byte levels + 1-byte segments)', () => {
    // Kills: an off-by-one on the `block.length < 6` guard (e.g. requiring 7
    // or 8) that would reject a real, well-formed minimal structure record —
    // every other fixture in this file happens to be 8 bytes, so only this
    // exact-boundary case can catch that regression.
    expect(decodeFtsStructure(Uint8Array.from([0, 0, 0, 1, 3, 6]))).toEqual({ levels: 3, segments: 6 })
  })

  it('returns null when the record is truncated right after the levels varint', () => {
    // Kills: `if (!segments) return null` (the second half of the guard) —
    // every other "returns null" case in this file fails on the FIRST varint
    // (levels) or on the plausibility check; none of them exercise the
    // segments-varint-missing branch on its own. Buffer: cookie + one levels
    // byte + one dangling continuation byte with nothing after it.
    expect(decodeFtsStructure(Uint8Array.from([0, 0, 0, 1, 3, 0x80]))).toBeNull()
  })
})

describe('readFtsSegmentCount', () => {
  function handleReturning(block: Uint8Array | undefined): FtsSqliteHandle {
    return {
      prepare: () => ({
        get: () => (block === undefined ? undefined : { block }),
        run: () => undefined,
      }),
    }
  }

  it('reads the segment count through a well-formed structure row', () => {
    // This is the one path that db/index.ts actually calls in production;
    // everywhere else in this file exercises `decodeFtsStructure` directly.
    expect(readFtsSegmentCount(handleReturning(structureBytes(2, 5, false)))).toBe(5)
  })

  it('returns undefined, not a wrong number, when the row has no block', () => {
    expect(readFtsSegmentCount(handleReturning(undefined))).toBeUndefined()
  })

  it('returns undefined when the query throws (e.g. FTS table absent)', () => {
    // Kills: letting a driver error (missing table, closed handle) propagate
    // out of a "best-effort" reader instead of degrading to "unknown".
    const handle: FtsSqliteHandle = {
      prepare: () => { throw new Error('no such table: messages_fts_data') },
    }
    expect(readFtsSegmentCount(handle)).toBeUndefined()
  })
})

describe('packages/db FTS maintenance against a real index', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('merges incrementally down to a single segment, and counts segments not blocks', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Disable automerge so the batches below leave a deterministic pile of
      // segments to merge, instead of SQLite collapsing them as we insert.
      mod.default.exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 0)`)

      const body = Array.from({ length: 200 }, (_, i) => `token${i} слово${i}`).join(' ')
      for (let batch = 0; batch < 12; batch++) {
        mod.upsertMessages(1, 'INBOX', Array.from({ length: 30 }, (_, i) => ({
          uid: batch * 30 + i + 1,
          subject: `subject ${batch}-${i} ${body.slice(0, 400)}`,
          fromAddr: `sender${i}@example.test`,
          bodyText: body,
          date: new Date(Date.UTC(2026, 0, 1, 0, batch, i)).toISOString(),
          unread: false,
        })))
      }

      const blocks = (mod.default.prepare('SELECT count(*) AS c FROM messages_fts_data').get() as { c: number }).c
      const segmentsBefore = mod.ftsSegmentCount()!
      expect(segmentsBefore).toBeGreaterThan(1)
      // Kills the mislabelled metric of point 2: the old code counted rows of
      // messages_fts_data (~4 KB storage blocks) and called them segments,
      // which is how a six-segment index was logged as "29397 segments".
      expect(blocks).toBeGreaterThan(segmentsBefore)

      let step = mod.mergeFtsIndexStep(-FTS_MERGE_PAGES_PER_STEP)!
      let steps = 1
      let maxStepMs = step.durationMs
      while (step.worked && steps < 500) {
        step = mod.mergeFtsIndexStep(FTS_MERGE_PAGES_PER_STEP)!
        steps += 1
        maxStepMs = Math.max(maxStepMs, step.durationMs)
      }

      // Same end state `optimize` would have produced...
      expect(mod.ftsSegmentCount()).toBe(1)
      // ...reached in bounded steps, none of which may hold the event loop for
      // the multi-second stretch that `optimize` did.
      expect(steps).toBeLessThan(500)
      // Bound chosen for what it must kill, not for how fast this machine is:
      // `optimize` on a real index blocked for 1 384 ms warm and 4 277 ms cold,
      // so a second-scale ceiling still fails the moment someone reverts to it,
      // while leaving room for a loaded CI box where a single 64-page merge can
      // take far longer than the 26 ms measured on an idle one. The tight
      // per-step budget belongs to the service (SLOW_STEP_MS), where it is
      // asserted against an injected duration rather than a real clock.
      expect(maxStepMs).toBeLessThan(1_000)

      // A converged index reports "no work left" instead of spinning.
      expect(mod.mergeFtsIndexStep(-FTS_MERGE_PAGES_PER_STEP)!.worked).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('records slow statements from the real driver without their bind values', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const { takeSlowSqlSamples, installSqlTiming } = await import('./sqlTiming')
      takeSlowSqlSamples()
      // The module installs itself at open time with the production threshold;
      // re-install with a 0 ms one so an ordinary statement qualifies.
      installSqlTiming(mod.default, { slowMs: 0 })

      mod.upsertMessages(1, 'INBOX', [{
        uid: 1, subject: 'quarterly numbers', fromAddr: 'cfo@example.test',
        date: '2026-02-08T00:00:00.000Z', unread: false,
      }])
      mod.searchMessages(1, 'INBOX', 'cfo@example.test', 10)

      const samples = takeSlowSqlSamples()
      expect(samples.length).toBeGreaterThan(0)
      // Whole objects, produced by the REAL driver against real statements —
      // not a hand-built fake. Nothing textual may survive on any of them.
      const serialised = JSON.stringify(samples)
      expect(serialised).not.toContain('cfo@example.test')
      expect(serialised).not.toContain('quarterly numbers')
      expect(samples.every((s) => /^[a-z]+ [a-z0-9_]+$/.test(s.digest))).toBe(true)
      expect(samples.every((s) => /^[0-9a-f]{8}$/.test(s.fingerprint))).toBe(true)
      expect(samples.every((s) => Object.keys(s).length === 4)).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
