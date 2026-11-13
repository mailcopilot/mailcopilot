import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type DbModule = typeof import('./index')

// The FTS schema migrations at module load drop and recreate messages_fts and
// its triggers as one unit. They used to run as `db.exec('BEGIN; ... COMMIT;')`
// inside an empty catch: a statement failing part-way stopped exec before
// COMMIT, the catch swallowed the error, and the transaction stayed open for
// the rest of the session, so no later write was ever committed.

let betterSqlite3Usable = true
let Database: typeof import('better-sqlite3')
try {
  const mod = await import('better-sqlite3')
  Database = mod.default as unknown as typeof import('better-sqlite3')
  const probe = new (mod.default as unknown as new (p: string) => { close(): void })(':memory:')
  probe.close()
} catch {
  betterSqlite3Usable = false
}

/**
 * A cache.db whose messages_fts lacks the current column set (so the rebuild
 * migration runs) plus a stray table holding the name of an FTS5 shadow table,
 * so CREATE VIRTUAL TABLE fails after the DROP statements already ran.
 */
function seedDbWhoseFtsRebuildFails(dir: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy = new (Database as any)(path.join(dir, 'cache.db'))
  legacy.exec(`
    CREATE TABLE messages_fts(subject TEXT);
    CREATE TABLE messages_fts_data(x);
  `)
  legacy.close()
}

/** Direct FTS lookup: a search API would fall back to LIKE and hide an empty index. */
function ftsMatchUids(mod: DbModule, term: string): number[] {
  const rows = mod.default.prepare(
    `SELECT m.uid AS uid FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY m.uid`,
  ).all(term) as Array<{ uid: number }>
  return rows.map(r => r.uid)
}

/** A current cache.db with one message, closed again. */
async function seedCurrentDbWithMessage(dir: string, subject: string): Promise<void> {
  const mod = await loadDbModule(dir)
  mod.upsertMessages(1, 'INBOX', [{ uid: 1, subject, fromAddr: 'a@test', date: '2026-11-01T00:00:00.000Z', unread: false }])
  mod.default.close()
}

function rawDb(dir: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (Database as any)(path.join(dir, 'cache.db'))
}

async function loadDbModule(dir: string): Promise<DbModule> {
  vi.resetModules()
  process.env.MAILCOPILOT_DATA_DIR = dir
  return import('./index')
}

describe('packages/db — FTS migration failure leaves no open transaction', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('a rebuild that fails part-way is rolled back and later writes are committed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-fts-migration-'))
    const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
    let mod: DbModule | undefined
    try {
      seedDbWhoseFtsRebuildFails(dir)
      mod = await loadDbModule(dir)

      expect(mod.default.inTransaction).toBe(false)
      // The failed migration was rolled back as a whole: the old table is still there.
      const fts = mod.default.prepare(`SELECT type FROM sqlite_master WHERE name='messages_fts'`).get() as { type?: string } | undefined
      expect(fts?.type).toBe('table')

      mod.enqueueSendQueue(1, { to: 'a@test', subject: 'after migration' }, new Date().toISOString(), 'q-after-migration')
      mod.upsertMessages(1, 'INBOX', [{ uid: 1, subject: 'quokkafestival agenda', fromAddr: 'a@test', date: '2026-11-01T00:00:00.000Z', unread: false }])
      mod.default.close()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reopened = new (Database as any)(path.join(dir, 'cache.db'))
      try {
        const row = reopened.prepare(`SELECT id FROM send_queue WHERE id='q-after-migration'`).get()
        expect(row).toBeTruthy()
        // Remove what made the migration fail; the next start runs it again.
        reopened.exec(`DROP TABLE messages_fts_data`)
      } finally {
        reopened.close()
      }

      mod = await loadDbModule(dir)
      expect(ftsMatchUids(mod, 'quokkafestival')).toEqual([1])
    } finally {
      try { mod?.default.close() } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true })
      if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
      else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
    }
  })

  testDb('an FTS rebuild interrupted after the schema swap is redone on the next start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-fts-rebuild-'))
    const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
    let mod: DbModule | undefined
    const realExec = Database.prototype.exec
    try {
      await seedCurrentDbWithMessage(dir, 'zebracorn quarterly report')
      // An FTS table from an older release: fewer columns, so the next start swaps it.
      const raw = rawDb(dir)
      raw.exec(`
        DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;
        DROP TRIGGER IF EXISTS messages_au;
        DROP TABLE messages_fts;
        CREATE VIRTUAL TABLE messages_fts USING fts5(subject, from_addr, content='messages', content_rowid='id');
      `)
      raw.close()

      // Start 1 dies at the rebuild, after the new table and triggers exist.
      const spy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof Database>, sql: string) {
        if (sql.includes(`VALUES('rebuild')`)) throw new Error('interrupted before rebuild')
        return realExec.call(this, sql)
      })
      try {
        mod = await loadDbModule(dir)
      } finally {
        spy.mockRestore()
      }
      mod.default.close()

      // Start 2: the index must hold the message that was there before the swap.
      mod = await loadDbModule(dir)
      const cols = (mod.default.prepare(`PRAGMA table_info(messages_fts)`).all() as Array<{ name: string }>).map(c => c.name)
      expect(cols).toContain('body_text')
      expect(ftsMatchUids(mod, 'zebracorn')).toEqual([1])
    } finally {
      try { mod?.default.close() } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true })
      if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
      else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
    }
  })

  testDb('the replaced messages_au trigger keeps the index in step with an updated subject', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-fts-trigger-'))
    const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
    let mod: DbModule | undefined
    try {
      await seedCurrentDbWithMessage(dir, 'oldtoken subject')
      // The trigger as older releases created it: AFTER UPDATE without an OF clause.
      const raw = rawDb(dir)
      const body = (raw.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_au'`).get() as { sql: string }).sql
      raw.exec(`DROP TRIGGER messages_au; ${body.replace(/AFTER\s+UPDATE\s+OF\s+[^]*?\s+ON\s+messages/i, 'AFTER UPDATE ON messages')};`)
      expect((raw.prepare(`SELECT sql FROM sqlite_master WHERE name='messages_au'`).get() as { sql: string }).sql).not.toMatch(/UPDATE\s+OF/i)
      raw.close()

      mod = await loadDbModule(dir)
      const sql = (mod.default.prepare(`SELECT sql FROM sqlite_master WHERE name='messages_au'`).get() as { sql: string }).sql
      expect(sql).toMatch(/AFTER\s+UPDATE\s+OF\s+subject/i)
      expect(ftsMatchUids(mod, 'oldtoken')).toEqual([1])

      mod.default.prepare(`UPDATE messages SET subject='newtoken subject' WHERE account_id=1 AND folder_path='INBOX' AND uid=1`).run()
      expect(ftsMatchUids(mod, 'newtoken')).toEqual([1])
      expect(ftsMatchUids(mod, 'oldtoken')).toEqual([])
    } finally {
      try { mod?.default.close() } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true })
      if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
      else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
    }
  })
})

describe('packages/db — FTS migrations that succeed on a database with existing rows', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  /** Creates the full schema with the module, adds a message, then returns the raw handle for downgrading it. */
  async function createDbWithMessage(dir: string): Promise<void> {
    const mod = await loadDbModule(dir)
    mod.upsertMessages(1, 'INBOX', [
      { uid: 1, subject: 'quarterly report', fromAddr: 'alice@example.test', bodyText: 'zebrafish migration body', date: '2026-02-08T00:00:00.000Z', unread: true },
    ])
    mod.default.close()
  }

  testDb('an old messages_fts without the current columns is rebuilt, the old rows stay searchable and the session is not left in a transaction', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-fts-migration-'))
    const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
    let mod: DbModule | undefined
    try {
      await createDbWithMessage(dir)
      // Downgrade to an FTS table of an older shape (subject only) with its old triggers.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = new (Database as any)(path.join(dir, 'cache.db'))
      raw.exec(`
        DROP TRIGGER IF EXISTS messages_ai;
        DROP TRIGGER IF EXISTS messages_ad;
        DROP TRIGGER IF EXISTS messages_au;
        DROP TABLE messages_fts;
        CREATE VIRTUAL TABLE messages_fts USING fts5(subject, content='messages', content_rowid='id');
      `)
      raw.close()

      mod = await loadDbModule(dir)

      expect(mod.default.inTransaction).toBe(false)
      const cols = (mod.default.prepare(`PRAGMA table_info(messages_fts)`).all() as Array<{ name: string }>).map(c => c.name)
      expect(cols).toEqual(['subject', 'from_addr', 'from_name', 'to_addr', 'body_text', 'attachment_filenames'])
      // The row that existed before the migration is searchable by a column the old table did not have.
      expect(mod.searchMessages(1, 'INBOX', 'zebrafish', 10, 0).map(m => m.uid)).toEqual([1])
      // And the recreated triggers index new rows.
      mod.upsertMessages(1, 'INBOX', [
        { uid: 2, subject: 'second', fromAddr: 'bob@example.test', bodyText: 'narwhal arrives', date: '2026-02-09T00:00:00.000Z', unread: true },
      ])
      expect(mod.searchMessages(1, 'INBOX', 'narwhal', 10, 0).map(m => m.uid)).toEqual([2])
    } finally {
      try { mod?.default.close() } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true })
      if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
      else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
    }
  })

  testDb('a legacy messages_au trigger without the OF clause is replaced in one step and indexing keeps working', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-fts-migration-'))
    const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
    let mod: DbModule | undefined
    try {
      await createDbWithMessage(dir)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = new (Database as any)(path.join(dir, 'cache.db'))
      raw.exec(`
        DROP TRIGGER messages_au;
        CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES ('delete', old.id, old.subject, old.from_addr, old.from_name, old.to_addr, old.body_text, old.attachment_filenames);
          INSERT INTO messages_fts(rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames) VALUES (new.id, new.subject, new.from_addr, new.from_name, new.to_addr, new.body_text, new.attachment_filenames);
        END;
      `)
      raw.close()

      mod = await loadDbModule(dir)

      expect(mod.default.inTransaction).toBe(false)
      const triggers = mod.default.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_au'`).all() as Array<{ sql: string }>
      expect(triggers).toHaveLength(1)
      expect(triggers[0].sql).toMatch(/AFTER\s+UPDATE\s+OF\s+subject,/i)
      expect(mod.searchMessages(1, 'INBOX', 'zebrafish', 10, 0).map(m => m.uid)).toEqual([1])

      // Writes after the migration are committed (reopen and read them back).
      mod.enqueueSendQueue(1, { to: 'a@test', subject: 'after trigger migration' }, new Date().toISOString(), 'q-after-trigger')
      mod.default.close()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reopened = new (Database as any)(path.join(dir, 'cache.db'))
      try {
        expect(reopened.prepare(`SELECT id FROM send_queue WHERE id='q-after-trigger'`).get()).toBeTruthy()
      } finally {
        reopened.close()
      }
    } finally {
      try { mod?.default.close() } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true })
      if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
      else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
    }
  })
})
