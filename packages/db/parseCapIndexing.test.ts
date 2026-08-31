import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type DbModule = typeof import('./index')

// better-sqlite3 is a native module built against the Electron ABI. Skip when
// the ABI does not match the Node vitest runs under — see `npm run test:db`.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-test-'))
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

/**
 * §2.145 fix wave 0.1 — behavioural counterpart to
 * `electron/main.parseCapIndexing.test.ts`.
 *
 * That suite reads `main.ts` as text (main.ts is not importable — module-level
 * side effects) and pins that `cacheMessageDetails()` calls the right DB
 * functions, in the right order, with the right guard. It cannot prove those
 * calls actually change what search and the body indexer SEE, because it never
 * runs a real database. This suite closes that gap: it drives the real DB
 * primitives `cacheMessageDetails` delegates to
 * (`updateMessageBodyText` / `getUidsWithoutBodyText` / `listFoldersWithPendingBodies`
 * / `searchMessages`) against the two shapes a capped open produces, and checks
 * the outcome end to end rather than by inspecting source text.
 */
describe('packages/db — §2.145 parse-cap indexing contract', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('a soft-capped (or uncapped) body is written, searchable, and leaves the pending queue', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'Soft capped', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      // Before any indexing: body_text is NULL, so the message is pending.
      expect(mod.hasBodyTextIndexed(1, 'INBOX', 1)).toBe(false)
      expect(mod.getUidsWithoutBodyText(1, 'INBOX')).toContain(1)

      // What `cacheMessageDetails` does for a soft-capped (or uncapped) result:
      // the guard `details.parseCap?.kind !== 'hard'` is true, so it writes.
      mod.updateMessageBodyText(1, 'INBOX', 1, 'the clipped body text, still fully searchable')

      expect(mod.hasBodyTextIndexed(1, 'INBOX', 1)).toBe(true)
      // Drained from the indexer's queue — a later background pass has nothing
      // left to do for this message.
      expect(mod.getUidsWithoutBodyText(1, 'INBOX')).not.toContain(1)
      expect(
        mod.listFoldersWithPendingBodies().find(f => f.accountId === 1 && f.folder === 'INBOX'),
      ).toBeUndefined()

      // And it is genuinely searchable, not just marked as indexed.
      const found = mod.searchMessages(1, 'INBOX', 'body:clipped', 10, 0)
      expect(found.map(m => m.uid)).toEqual([1])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a hard-capped body is never written: body_text stays NULL, unsearchable, and queued for the indexer', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 2, subject: 'Hard capped', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])
      // `cacheMessageDetails` never calls `updateMessageBodyText` on this path
      // (nothing was decoded) — simulated here by simply not calling it.

      expect(mod.hasBodyTextIndexed(1, 'INBOX', 2)).toBe(false)
      expect(mod.getUidsWithoutBodyText(1, 'INBOX')).toContain(2)

      const pending = mod.listFoldersWithPendingBodies().find(f => f.accountId === 1 && f.folder === 'INBOX')
      expect(pending?.pending).toBeGreaterThanOrEqual(1)

      // A NULL body_text row cannot be found by a body: search either — the
      // withholding decision and the search-visibility decision are the same
      // decision, made once, at write time.
      expect(mod.searchMessages(1, 'INBOX', 'body:capped', 10, 0)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('mixed folder: writing the soft-capped row alone drains it from the pending count, the hard-capped row stays', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 10, subject: 'Hard capped sibling', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
        { uid: 11, subject: 'Soft capped sibling', fromAddr: 'a@test', date: '2026-01-01T00:00:01Z', unread: false },
      ])
      expect(mod.listFoldersWithPendingBodies().find(f => f.accountId === 1 && f.folder === 'INBOX')?.pending).toBe(2)

      // Only the soft-capped sibling gets indexed — mirroring one open of each
      // kind landing in the same folder.
      mod.updateMessageBodyText(1, 'INBOX', 11, 'soft body, indexed')

      const pending = mod.listFoldersWithPendingBodies().find(f => f.accountId === 1 && f.folder === 'INBOX')
      expect(pending?.pending).toBe(1)
      expect(mod.getUidsWithoutBodyText(1, 'INBOX')).toEqual([10])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})

/**
 * §2.145 fix wave 1.1 (HIGH gap, codex-bg-review Part B) — pre-§2.145
 * `cached_detail` rows.
 *
 * The gate that REFUSES to serve a legacy oversized row lives entirely inside
 * `electron/main.ts` (`isServableCachedDetailJson` / `isServableCachedDetail`),
 * as two unexported functions in a module that has module-level side effects
 * (window creation, IPC registration, DB open at import time) and therefore
 * cannot be imported by any test. `electron/main.parseCapIndexing.test.ts`
 * pins that gate by reading the source and is mutation-checked against it —
 * that is real coverage of the DECISION.
 *
 * What it cannot prove, because it never runs a database, is the premise the
 * decision depends on: that `messages.cached_detail` will actually still hold
 * a legacy, cap-less, oversized row (nothing in the DB layer itself would have
 * rejected or silently shrunk one), and that main.ts's self-healing promise —
 * "the row is not deleted, it heals on the next successful parse" — is a real
 * property of `setCachedDetail`, not just a comment. This suite is that half:
 * real `setCachedDetail`/`getCachedDetail` round trips, run against a real
 * SQLite file. It is NOT a substitute for the main.ts gate test above — it
 * proves the DB layer applies no gate of its own, which is exactly why the
 * gate has to live in main.ts and not be assumed to happen "underneath".
 */
describe('packages/db — §2.145 fix wave 1.1: pre-cap rows in the details cache', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('a legacy cap-less oversized row round-trips unchanged, then heals in place once a capped result is written', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 5, subject: 'Legacy oversized', fromAddr: 'a@test', date: '2026-01-01T00:00:00Z', unread: false },
      ])

      // The exact shape a pre-§2.145 write produced: no `parseCap` field at
      // all, and a body well above what the current soft cap (1 MiB) would
      // ever let a fresh parse produce.
      const oversizedBody = 'x'.repeat(2 * 1024 * 1024)
      const legacyJson = JSON.stringify({ uid: 5, envelope: { subject: 'Legacy oversized' }, text: oversizedBody })

      mod.setCachedDetail(1, 'INBOX', 5, legacyJson)
      const roundTripped = mod.getCachedDetail(1, 'INBOX', 5)

      // The DB layer stores and returns exactly what it was given — no size
      // limit, no schema check on the JSON shape. This is the premise
      // main.ts's gate exists to cover: if this failed (the row got rejected
      // or truncated here), the main.ts gate would have nothing to refuse.
      expect(roundTripped).toBe(legacyJson)
      const parsed = JSON.parse(roundTripped!) as { parseCap?: unknown; text: string }
      expect(parsed.parseCap).toBeUndefined()
      expect(Buffer.byteLength(parsed.text, 'utf8')).toBeGreaterThan(1024 * 1024)

      // Self-healing: main.ts's fallthrough reparses a refused row and writes
      // the capped result back through the SAME `setCachedDetail` call
      // `cacheMessageDetails` always uses. Simulated here directly — the
      // stored row must become the NEW value, not accumulate alongside it.
      const healedJson = JSON.stringify({
        uid: 5,
        envelope: { subject: 'Legacy oversized' },
        text: 'x'.repeat(1024),
        parseCap: { kind: 'soft', rawBytes: 3 * 1024 * 1024, limitBytes: 1024 * 1024, canShowFull: true },
      })
      mod.setCachedDetail(1, 'INBOX', 5, healedJson)
      expect(mod.getCachedDetail(1, 'INBOX', 5)).toBe(healedJson)
      expect(mod.getCachedDetail(1, 'INBOX', 5)).not.toContain(oversizedBody)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
