import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type DbModule = typeof import('./index')
type TelemetryModule = typeof import('./telemetry')

/**
 * Regression for the live-profile defect of 2026-08-20: three rows in one
 * INBOX carried `uid = NULL`. Such a row is unreachable by construction —
 * `net:messageDetails` and `ai:threadSummary:generate` validate `uid` as a
 * number at the IPC boundary, so the request never leaves the app and the
 * user sees "Ошибка загрузки письма". It also cannot heal: the upsert's
 * `ON CONFLICT(account_id, folder_path, uid)` never matches a NULL, so each
 * sync round appends another copy instead of updating the first.
 */

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

async function loadDbModule(
  dir?: string,
  opts?: { onError?: (source: string) => void },
): Promise<{
  dir: string
  mod: DbModule
  telemetry: TelemetryModule
  prevDataDir: string | undefined
}> {
  vi.resetModules()
  const target = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-uidguard-'))
  const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
  process.env.MAILCOPILOT_DATA_DIR = target
  // The seam has to be imported from the SAME fresh module graph as index.ts,
  // otherwise setDbErrorReporter would install into a different instance.
  const telemetry = await import('./telemetry')
  // The migration reports at IMPORT time and nothing buffers a report raised
  // before a reporter exists (see reportDbError). So a test that wants to
  // observe it installs the reporter FIRST — an ordering main.ts cannot have,
  // which is exactly why the report does not reach production Sentry.
  if (opts?.onError) telemetry.setDbErrorReporter((source) => { opts.onError?.(source) })
  const mod = await import('./index')
  return { dir: target, mod, telemetry, prevDataDir }
}

function cleanup(dir: string, mod: DbModule | null, prevDataDir: string | undefined) {
  try { mod?.default.close() } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true })
  if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
  else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
}

/** Open the cache.db directly, drop the storage guard so a pre-fix row can be
 *  written, seed it, then close. Models a database written before this fix.
 *
 *  `excludedFromSearch` reproduces what `upsertMessages` does for a folder
 *  with index_in_search=0: the AFTER INSERT trigger pushes the row into
 *  messages_fts and the upsert immediately issues the FTS5 'delete' command
 *  to take it back out. Without that follow-up the fixture would leave the
 *  row indexed, and the purge's DELETE would look balanced when in
 *  production it is not — the exact hole that hid this class of corruption. */
function seedUidlessRows(
  dir: string,
  rows: Array<{ accountId: number; folder: string; excludedFromSearch?: boolean }>,
): void {
  const dbPath = path.join(dir, 'cache.db')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = new (Database as any)(dbPath)
  raw.exec(`DROP TRIGGER IF EXISTS messages_uid_guard_ins`)
  raw.exec(`DROP TRIGGER IF EXISTS messages_uid_guard_upd`)
  // The rows observed in the wild happened to carry empty subject/from, which
  // makes their FTS document token-free and any 'delete' for them a no-op. The
  // purge predicate is wider than that case, so the fixture gives every seeded
  // row real indexable text — otherwise the FTS bookkeeping below would be
  // untested by construction.
  const stmt = raw.prepare(
    `INSERT INTO messages(account_id, folder_path, uid, subject, from_addr, body_text, date, unread)
     VALUES(?, ?, NULL, 'orphanhdr', 'orphan@example.test', 'orphan body text', ?, 0)`,
  )
  const ftsRemove = raw.prepare(
    `INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, to_addr, body_text, attachment_filenames)
     SELECT 'delete', id, subject, from_addr, from_name, to_addr, body_text, attachment_filenames
     FROM messages WHERE id = ?`,
  )
  for (const r of rows) {
    const info = stmt.run(r.accountId, r.folder, new Date().toISOString())
    if (r.excludedFromSearch) ftsRemove.run(info.lastInsertRowid)
  }
  raw.close()
}

describe('packages/db — messages.uid storability guard', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('reproduces the live defect: a NULL-uid row is invisible to readers and duplicates on re-sync', async () => {
    const first = await loadDbModule()
    try {
      first.mod.upsertMessages(5, 'INBOX', [
        { uid: 42, subject: 'real', fromAddr: 'a@example.test', date: '2026-08-20T10:00:00.000Z', unread: false },
      ])
      first.mod.default.close()

      // Two sync rounds produce two rows rather than one updated row — the
      // ON CONFLICT key can never match, because NULL <> NULL in SQLite.
      seedUidlessRows(first.dir, [
        { accountId: 5, folder: 'INBOX' },
        { accountId: 5, folder: 'INBOX' },
      ])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = new (Database as any)(path.join(first.dir, 'cache.db'))
      const beforeCount = raw.prepare(`SELECT COUNT(*) AS n FROM messages WHERE uid IS NULL`).get() as { n: number }
      expect(beforeCount.n).toBe(2)
      // No reader can address them: every message lookup is keyed by uid.
      const addressable = raw.prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE account_id=5 AND folder_path='INBOX' AND uid IS NOT NULL`,
      ).get() as { n: number }
      expect(addressable.n).toBe(1)
      raw.close()

      // Re-opening the profile runs the purge migration.
      const second = await loadDbModule(first.dir)
      try {
        const remaining = second.mod.getMessages(5, 'INBOX', 100)
        expect(remaining.map(m => m.uid)).toEqual([42])
        const stillNull = second.mod.default
          .prepare(`SELECT COUNT(*) AS n FROM messages WHERE uid IS NULL`)
          .get() as { n: number }
        expect(stillNull.n).toBe(0)
      } finally {
        cleanup(second.dir, second.mod, second.prevDataDir)
      }
    } catch (err) {
      cleanup(first.dir, null, first.prevDataDir)
      throw err
    }
  })

  testDb('purge migration is idempotent: silent on a clean profile, silent again once it has already run', async () => {
    // Three module loads over the same profile, modelling three app restarts:
    //   1) a clean profile with only a valid-uid row — nothing to purge, ever.
    //   2) an unstorable row appears (as it did in the wild) — purged, reported once.
    //   3) restart again with nothing left to purge — must NOT re-report.
    // Report #3 firing would mean the migration counts something other than
    // rows it is about to delete (e.g. it dropped the `purgedCount > 0` guard
    // and always reports the query result, including a zero).
    const reports: string[] = []
    const onError = (source: string) => { reports.push(source) }
    const first = await loadDbModule(undefined, { onError })
    try {
      first.mod.upsertMessages(9, 'INBOX', [
        { uid: 1, subject: 'clean', fromAddr: 'a@example.test', date: '2026-08-20T10:00:00.000Z', unread: false },
      ])
      first.mod.default.close()
      expect(reports).toHaveLength(0) // clean profile: migration ran, found nothing, reported nothing

      const second = await loadDbModule(first.dir, { onError })
      second.mod.default.close()
      expect(reports).toHaveLength(0) // still nothing to purge on a plain reopen

      seedUidlessRows(first.dir, [{ accountId: 9, folder: 'INBOX' }])

      const third = await loadDbModule(first.dir, { onError })
      try {
        expect(reports).toEqual(['db.migrate_purge_uidless_messages']) // purge fired exactly once

        const fourth = await loadDbModule(first.dir, { onError })
        try {
          // Row is already gone — a fourth restart must find nothing left.
          expect(reports).toEqual(['db.migrate_purge_uidless_messages'])
          expect(fourth.mod.getMessages(9, 'INBOX', 10).map(m => m.uid)).toEqual([1])
        } finally {
          cleanup(fourth.dir, fourth.mod, fourth.prevDataDir)
        }
      } finally {
        cleanup(third.dir, third.mod, third.prevDataDir)
      }
    } catch (err) {
      cleanup(first.dir, null, first.prevDataDir)
      throw err
    }
  })

  testDb('a reporter installed after import never sees the purge — the repair happens regardless', async () => {
    // Production ordering: main.ts installs the reporter after its hoisted
    // imports, so the import-time report is dropped on the spot (nothing
    // buffers it — see reportDbError). What must NOT depend on telemetry
    // being wired is the repair itself.
    const first = await loadDbModule()
    try {
      first.mod.upsertMessages(11, 'INBOX', [
        { uid: 3, subject: 'clean', fromAddr: 'a@example.test', date: '2026-08-20T10:00:00.000Z', unread: false },
      ])
      first.mod.default.close()
      seedUidlessRows(first.dir, [{ accountId: 11, folder: 'INBOX' }])

      const second = await loadDbModule(first.dir)
      try {
        const reports: string[] = []
        second.telemetry.setDbErrorReporter((source) => { reports.push(source) })
        expect(reports).toEqual([])
        expect(second.mod.getMessages(11, 'INBOX', 10).map(m => m.uid)).toEqual([3])
      } finally {
        cleanup(second.dir, second.mod, second.prevDataDir)
      }
    } catch (err) {
      cleanup(first.dir, null, first.prevDataDir)
      throw err
    }
  })

  testDb('purge migration leaves FTS integrity, triggers and indexes intact', async () => {
    const first = await loadDbModule()
    try {
      first.mod.upsertMessages(1, 'INBOX', [
        { uid: 7, subject: 'findable needle', fromAddr: 'a@example.test', bodyText: 'haystack body', date: '2026-08-20T09:00:00.000Z', unread: false },
      ])
      // A folder excluded from search exercises the FTS rebalance path: its
      // rows were removed from the index, so the AFTER DELETE trigger's
      // unbalanced 'delete' would corrupt the FTS5 shadow tables.
      first.mod.upsertFolderPref(1, 'Junk', { indexInSearch: false })
      first.mod.upsertMessages(1, 'Junk', [
        { uid: 9, subject: 'spammy', fromAddr: 'z@example.test', bodyText: 'spam body', date: '2026-08-20T09:30:00.000Z', unread: false },
      ])
      first.mod.default.close()

      seedUidlessRows(first.dir, [
        { accountId: 1, folder: 'INBOX' },
        { accountId: 1, folder: 'Junk', excludedFromSearch: true },
      ])

      const second = await loadDbModule(first.dir)
      try {
        const db = second.mod.default
        // FTS5 shadow tables consistent after the delete.
        expect(() => db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`)).not.toThrow()
        // Search still returns the surviving indexed message.
        const hits = second.mod.searchMessages(1, 'INBOX', 'needle', 10)
        expect(hits.map(h => h.uid)).toEqual([7])
        // Triggers and indexes survived (nothing was rebuilt or dropped).
        const objects = db.prepare(
          `SELECT name FROM sqlite_master WHERE tbl_name='messages' AND type IN ('trigger','index')`,
        ).all() as Array<{ name: string }>
        const names = new Set(objects.map(o => o.name))
        for (const required of ['messages_ai', 'messages_ad', 'messages_au', 'idx_messages_folder_uid', 'idx_messages_body_pending']) {
          expect(names.has(required)).toBe(true)
        }
        // The excluded folder's surviving rows are unchanged.
        expect(second.mod.getMessages(1, 'Junk', 10).map(m => m.uid)).toEqual([9])
      } finally {
        cleanup(second.dir, second.mod, second.prevDataDir)
      }
    } catch (err) {
      cleanup(first.dir, null, first.prevDataDir)
      throw err
    }
  })

  testDb('upsertMessages skips the unusable row, stores the rest, and reports counters only', async () => {
    const { dir, mod, telemetry, prevDataDir } = await loadDbModule()
    const reports: Array<{ source: string; message: string; context: Record<string, unknown> }> = []
    telemetry.setDbErrorReporter((source, err, context) => {
      reports.push({
        source,
        message: err instanceof Error ? err.message : String(err),
        context: (context ?? {}) as Record<string, unknown>,
      })
    })
    try {
      const good = { subject: 's', fromAddr: 'a@example.test', date: '2026-08-20T10:00:00.000Z', unread: false }
      mod.upsertMessages(3, 'INBOX', [
        { uid: 11, ...good },
        // The shapes a FETCH response can actually produce once the `as
        // number` cast stops lying: absent, non-integer, out-of-range.
        { uid: undefined as unknown as number, ...good },
        { uid: Number.NaN, ...good },
        { uid: 0, ...good },
        { uid: 12.5, ...good },
        { uid: 12, ...good },
      ])

      expect(mod.getMessages(3, 'INBOX', 100).map(m => m.uid)).toEqual([12, 11])
      const nulls = mod.default.prepare(`SELECT COUNT(*) AS n FROM messages WHERE uid IS NULL`).get() as { n: number }
      expect(nulls.n).toBe(0)

      const skip = reports.find(r => r.message === 'messages.uid_unstorable_row_skipped')
      expect(skip).toBeDefined()
      expect(skip?.source).toBe('db.upsert_messages')
      expect(skip?.context).toEqual({ skipped_count: 4, batch_size: 6 })
      // Nothing identifying may travel with the report.
      const serialized = JSON.stringify(skip?.context)
      expect(serialized).not.toContain('INBOX')
      expect(serialized).not.toContain('example.test')
    } finally {
      telemetry.setDbErrorReporter(null)
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('an all-unusable batch writes nothing and does not throw', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(() => mod.upsertMessages(4, 'INBOX', [
        { uid: undefined as unknown as number, subject: 's', fromAddr: 'a@example.test', date: '2026-08-20T10:00:00.000Z', unread: false },
      ])).not.toThrow()
      expect(mod.getMessages(4, 'INBOX', 10)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsertMessages keeps an out-of-range UID from aborting its batch', async () => {
    // `Number.isInteger(1e100)` is true, so a laxer JS predicate hands this
    // value to SQLite, which binds it as REAL — and the storage trigger then
    // RAISE(ABORT)s. An ABORT inside `upsertMessages`'s transaction costs the
    // WHOLE sync window, which is the failure mode the row-level skip exists
    // to avoid: the guard would cause the outage it was meant to prevent.
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const good = { subject: 's', fromAddr: 'a@example.test', date: '2026-08-21T10:00:00.000Z', unread: false }
      expect(() => mod.upsertMessages(6, 'INBOX', [
        { uid: 1e100, ...good },
        { uid: 13, ...good },
        { uid: Number.MAX_SAFE_INTEGER + 2, ...good },
      ])).not.toThrow()
      // The sibling landed — proof the transaction was never rolled back.
      expect(mod.getMessages(6, 'INBOX', 100).map(m => m.uid)).toEqual([13])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // One predicate per language, checked against each other rather than
  // asserted to be "in one place". The JS form is `isStorableUid`; every SQL
  // form (the startup purge and both guard triggers) is generated by
  // `unstorableUidSql`, so the storage behaviour below exercises all of them.
  const UID_TRUTH_TABLE: Array<{ label: string; value: unknown; storable: boolean }> = [
    { label: 'one', value: 1, storable: true },
    { label: 'RFC 3501 ceiling', value: 4294967295, storable: true },
    // Above the RFC ceiling the STORAGE predicate still says yes: its job is
    // "can SQLite hold this as an integer", not "is this a server UID".
    // Bounding UIDs to the RFC range is readServerUid's job, in packages/net.
    { label: 'above the RFC ceiling', value: 4294967296, storable: true },
    // Offline-move placeholders are negative by design — "positive" would
    // break moveMessagesLocally.
    { label: 'offline-move placeholder', value: -5, storable: true },
    // The bound where the two languages could drift apart: SQLite's INTEGER is
    // 64-bit, so everything up to 2^63 stores as a plain INTEGER and passes a
    // `typeof(uid) = 'integer'` test — while JS stops being able to round-trip
    // at 2^53. These three entries are the only ones that tell the SQL mirror's
    // range check apart from its type check (1e100 cannot: it binds as REAL and
    // is caught by the type check alone, which is why it discriminated nothing).
    { label: 'largest safe integer', value: Number.MAX_SAFE_INTEGER, storable: true },
    { label: 'first unsafe integer, still an INTEGER to SQLite', value: 9007199254740992, storable: false },
    { label: 'first unsafe negative integer', value: -9007199254740992, storable: false },
    { label: 'zero', value: 0, storable: false },
    { label: 'fractional', value: 12.5, storable: false },
    { label: 'beyond IEEE-754 integer safety', value: 1e100, storable: false },
    { label: 'NaN', value: Number.NaN, storable: false },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY, storable: false },
    { label: 'NULL', value: null, storable: false },
    { label: 'undefined', value: undefined, storable: false },
    { label: 'empty string', value: '', storable: false },
  ]

  testDb('JS and SQL forms of the storability predicate agree value by value', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const db = mod.default
      const insert = db.prepare(
        `INSERT INTO messages(account_id, folder_path, uid, subject, from_addr, date, unread)
         VALUES(77, 'INBOX', @uid, 'x', 'a@example.test', '2026-08-21T10:00:00.000Z', 0)`,
      )
      for (const { label, value, storable } of UID_TRUTH_TABLE) {
        expect({ label, js: mod.isStorableUid(value) }).toEqual({ label, js: storable })
        // The storage side: a value the table refuses either fails to bind or
        // trips the trigger. Both are "the row does not land", which is the
        // property the JS predicate has to predict.
        let stored = true
        try {
          insert.run({ uid: value as number })
        } catch {
          stored = false
        }
        expect({ label, stored }).toEqual({ label, stored: storable })
      }
      // Only the legal values survived.
      const rows = db.prepare(`SELECT uid FROM messages WHERE account_id=77`).all() as Array<{ uid: number }>
      expect(rows.map(r => r.uid).sort((a, b) => a - b)).toEqual([
        -5, 1, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER,
      ])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('every SQL site is generated from unstorableUidSql — no hand-written copy left to drift', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const triggers = mod.default.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'messages_uid_guard%'`,
      ).all() as Array<{ name: string; sql: string }>
      expect(triggers.map(t => t.name).sort()).toEqual(['messages_uid_guard_ins', 'messages_uid_guard_upd'])
      for (const t of triggers) {
        expect(t.sql).toContain(mod.unstorableUidSql('new.uid'))
      }
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('storage guard rejects a raw NULL-uid insert but keeps offline-move placeholders legal', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const db = mod.default
      expect(() => db.prepare(
        `INSERT INTO messages(account_id, folder_path, uid, subject, from_addr, date, unread) VALUES(1,'INBOX',NULL,'x','a@b.test','2026-08-20T10:00:00.000Z',0)`,
      ).run()).toThrow(/non-zero integer/)
      expect(() => db.prepare(
        `INSERT INTO messages(account_id, folder_path, uid, subject, from_addr, date, unread) VALUES(1,'INBOX',0,'x','a@b.test','2026-08-20T10:00:00.000Z',0)`,
      ).run()).toThrow(/non-zero integer/)

      // moveMessagesLocally mints NEGATIVE placeholder UIDs; the guard must
      // not be phrased as "positive" or offline move breaks.
      mod.upsertMessages(1, 'INBOX', [
        { uid: 20, subject: 'to move', fromAddr: 'a@example.test', date: '2026-08-20T10:00:00.000Z', unread: false },
      ])
      mod.moveMessagesLocally(1, 'INBOX', 'Archive', [20])
      const moved = mod.getMessages(1, 'Archive', 10)
      expect(moved).toHaveLength(1)
      expect(moved[0].uid).toBeLessThan(0)
      expect(mod.getMessages(1, 'INBOX', 10)).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
