import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * §2.229 — the folder-counter aggregate must be answered from an index alone.
 *
 * `listFolderStats` was holding the main process for 88-225 ms per call on a
 * 416 MB / 106 906-row profile, and it repeated constantly. The cause was not
 * the aggregate itself but ONE missing column: the index stopped at `unread`,
 * while the correlated `NOT EXISTS` against `snoozed` also needs `uid`, so
 * SQLite had to fetch every matching row from the 416 MB table to read a single
 * integer. Widening the index to (account_id, folder_path, unread, uid) turns
 * the plan into a covering scan and drops the call to ~22 ms on the same seed.
 *
 * These tests guard the property, not the timing (timings do not belong in a
 * unit suite): the statement the shipped function prepares must be planned as
 * COVERING, and the widening must actually reach a database created before it.
 * A future SELECT that adds a column outside the index key would silently take
 * the freeze back, and only the plan assertion notices.
 */

type DbModule = typeof import('./index')

let betterSqlite3Usable = true
let Database: new (p: string) => {
  exec(sql: string): unknown
  prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown }
  close(): void
}
try {
  const mod = await import('better-sqlite3')
  Database = mod.default as unknown as typeof Database
  const probe = new Database(':memory:')
  probe.close()
} catch {
  betterSqlite3Usable = false
}

async function loadDbModule(dir?: string): Promise<{ dir: string; mod: DbModule; prevDataDir: string | undefined }> {
  vi.resetModules()
  const target = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-folder-counter-'))
  const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
  process.env.MAILCOPILOT_DATA_DIR = target
  const mod = await import('./index')
  return { dir: target, mod, prevDataDir }
}

function cleanup(dir: string, mod: DbModule | null, prevDataDir: string | undefined) {
  try { mod?.default.close() } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true })
  if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
  else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
}

const WIDE = 'idx_messages_unread_uid'
const NARROW = 'idx_messages_unread'

function indexNames(db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } }): Set<string> {
  const rows = db.prepare(`PRAGMA index_list(messages)`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

function indexColumns(db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } }, name: string): string[] {
  const rows = db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>
  return rows.map(r => r.name)
}

/**
 * Run `fn` and return the SQL text it hands to `db.prepare`.
 *
 * The point is to assert the plan of the statement the SHIPPED function runs,
 * without copying that SQL into the test — a copy would keep passing after the
 * real statement drifted, which is precisely the regression being guarded.
 * better-sqlite3's `prepare` lives on the prototype (and sqlTiming wraps it
 * there), so an own property on the instance shadows it and `delete` restores
 * the original path exactly.
 */
function capturePreparedSql(db: { prepare: (sql: string) => unknown }, fn: () => void): string[] {
  const captured: string[] = []
  const original = Object.getPrototypeOf(db).prepare as (this: unknown, sql: string) => unknown
  Object.defineProperty(db, 'prepare', {
    configurable: true,
    writable: true,
    value: function patched(this: unknown, sql: string) {
      captured.push(sql)
      return original.call(this, sql)
    },
  })
  try {
    fn()
  } finally {
    delete (db as unknown as Record<string, unknown>).prepare
  }
  return captured
}

function seed(mod: DbModule, folders: number, perFolder: number) {
  for (let f = 0; f < folders; f++) {
    const folder = f === 0 ? 'INBOX' : `Folder/${f}`
    mod.upsertMessages(1, folder, Array.from({ length: perFolder }, (_, i) => ({
      uid: i + 1,
      subject: `s${f}-${i}`,
      fromAddr: `a${i % 20}@example.test`,
      date: new Date(1_700_000_000_000 + (f * perFolder + i) * 1000).toISOString(),
      unread: i % 4 === 0,
    })))
  }
}

describe('§2.229 folder-counter index', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('listFolderStats is planned as a covering index scan — the table is never opened', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      seed(mod, 6, 400)
      mod.insertSnooze(1, null, 'INBOX', 3, '2026-12-01T10:00:00Z')

      const [sql] = capturePreparedSql(mod.default, () => { mod.listFolderStats(1) })
      expect(sql).toBeDefined()

      const plan = (mod.default.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as Array<{ detail: string }>)
        .map(r => r.detail)
      const messagesStep = plan.find(d => / messages\b/.test(d))
      expect(messagesStep).toBeDefined()
      // Kills the regression directly: "USING INDEX" (as opposed to "USING
      // COVERING INDEX") is SQLite saying it will go back to the table for at
      // least one column, which is the 200 ms.
      expect(messagesStep).toContain('COVERING INDEX')
      expect(messagesStep).toContain(WIDE)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('under the pre-fix key the same statement is NOT covering — the added column is what fixed it', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      seed(mod, 6, 400)
      mod.insertSnooze(1, null, 'INBOX', 3, '2026-12-01T10:00:00Z')
      const [sql] = capturePreparedSql(mod.default, () => { mod.listFolderStats(1) })

      // Put the schema back the way it was before §2.229 and re-plan. No other
      // index on `messages` carries all four columns, so nothing can rescue it:
      // whichever one the planner picks, it has to return to the table.
      mod.default.exec(`CREATE INDEX IF NOT EXISTS ${NARROW} ON messages(account_id, folder_path, unread)`)
      mod.default.exec(`DROP INDEX ${WIDE}`)

      const plan = (mod.default.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as Array<{ detail: string }>)
        .map(r => r.detail)
      const messagesStep = plan.find(d => / messages\b/.test(d))
      expect(messagesStep).toBeDefined()
      expect(messagesStep).not.toContain('COVERING INDEX')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('the counters themselves are unchanged: snoozed messages stay out of both', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.upsertMessages(1, 'INBOX', [
        { uid: 1, subject: 'a', fromAddr: 'a@example.test', date: '2026-02-08T00:00:00.000Z', unread: true },
        { uid: 2, subject: 'b', fromAddr: 'b@example.test', date: '2026-02-08T00:01:00.000Z', unread: true },
        { uid: 3, subject: 'c', fromAddr: 'c@example.test', date: '2026-02-08T00:02:00.000Z', unread: false },
      ])
      mod.insertSnooze(1, null, 'INBOX', 2, '2026-12-01T10:00:00Z')

      expect(mod.listFolderStats(1)).toEqual([
        { folderPath: 'INBOX', messageCount: 2, unreadCount: 1 },
      ])
      // Same unit of counting as the per-folder call it must agree with (§2.237).
      expect(mod.countUnreadMessages(1, 'INBOX')).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('the index carries exactly the four columns the aggregate reads', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(indexColumns(mod.default, WIDE)).toEqual(['account_id', 'folder_path', 'unread', 'uid'])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a database written before the fix is widened in place, and the narrow index is retired', async () => {
    const first = await loadDbModule()
    try {
      seed(first.mod, 3, 50)
      first.mod.default.close()

      // Model a pre-§2.229 profile: narrow index present, wide one absent.
      const rawPath = path.join(first.dir, 'cache.db')
      const raw = new Database(rawPath)
      raw.exec(`DROP INDEX IF EXISTS ${WIDE}`)
      raw.exec(`CREATE INDEX IF NOT EXISTS ${NARROW} ON messages(account_id, folder_path, unread)`)
      expect(indexNames(raw).has(NARROW)).toBe(true)
      expect(indexNames(raw).has(WIDE)).toBe(false)
      raw.close()

      const second = await loadDbModule(first.dir)
      try {
        const names = indexNames(second.mod.default)
        expect(names.has(WIDE)).toBe(true)
        // Left behind, the narrow index would be pure write-side cost: its key
        // is an exact prefix of the wide one, so no plan can prefer it.
        expect(names.has(NARROW)).toBe(false)
        // The rewrite is an index rebuild, not a table rebuild — rows survive.
        expect(second.mod.listFolderStats(1).map(r => r.messageCount)).toEqual([50, 50, 50])
      } finally {
        cleanup(second.dir, second.mod, second.prevDataDir)
      }
    } catch (err) {
      cleanup(first.dir, null, first.prevDataDir)
      throw err
    }
  })

  testDb('opening an already-migrated database is a no-op', async () => {
    const first = await loadDbModule()
    try {
      seed(first.mod, 2, 20)
      const before = [...indexNames(first.mod.default)].sort()
      first.mod.default.close()

      const second = await loadDbModule(first.dir)
      try {
        expect([...indexNames(second.mod.default)].sort()).toEqual(before)
        expect(second.mod.listFolderStats(1)).toHaveLength(2)
      } finally {
        cleanup(second.dir, second.mod, second.prevDataDir)
      }
    } catch (err) {
      cleanup(first.dir, null, first.prevDataDir)
      throw err
    }
  })
})
