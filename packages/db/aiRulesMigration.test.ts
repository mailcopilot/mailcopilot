import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type DbModule = typeof import('./index')

// §2.39 — verify the ai_rules "disabled by default" invariant is enforced at
// the DB schema level for UPGRADED installations (legacy DEFAULT 1 → 0).

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

/** Create a legacy cache.db whose ai_rules table still declares DEFAULT 1,
 *  seeded with one enabled and one disabled rule, BEFORE the db module loads
 *  (the module's CREATE TABLE IF NOT EXISTS will not overwrite it). */
function seedLegacyDb(dir: string): void {
  const dbPath = path.join(dir, 'cache.db')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy = new (Database as any)(dbPath)
  legacy.exec(`
    CREATE TABLE ai_rules(
      id TEXT PRIMARY KEY,
      account_id TEXT,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      prompt TEXT NOT NULL,
      allowed_actions TEXT NOT NULL,
      budget_per_day_usd REAL DEFAULT 0.50,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const now = new Date().toISOString()
  legacy.prepare(
    `INSERT INTO ai_rules(id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('rule-enabled', null, 'was on', 1, 'p', '["archive"]', 0.5, now, now)
  legacy.prepare(
    `INSERT INTO ai_rules(id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('rule-disabled', null, 'was off', 0, 'p', '["archive"]', 0.5, now, now)
  legacy.close()
}

/** Seed a legacy cache.db whose ai_rules table still declares DEFAULT 1 (so the
 *  migration WILL fire) but whose `name` column is nullable and holds a NULL —
 *  data the HARDENED schema (name TEXT NOT NULL) cannot accept. The rebuild's
 *  `INSERT ... SELECT` therefore throws a NOT NULL violation mid-transaction,
 *  exercising the atomic-rollback path with zero production hooks. */
function seedLegacyDbWithBadRow(dir: string): void {
  const dbPath = path.join(dir, 'cache.db')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy = new (Database as any)(dbPath)
  legacy.exec(`
    CREATE TABLE ai_rules(
      id TEXT PRIMARY KEY,
      account_id TEXT,
      name TEXT,
      enabled INTEGER DEFAULT 1,
      prompt TEXT NOT NULL,
      allowed_actions TEXT NOT NULL,
      budget_per_day_usd REAL DEFAULT 0.50,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const now = new Date().toISOString()
  // A valid row plus a NULL-name row the hardened schema rejects on copy.
  legacy.prepare(
    `INSERT INTO ai_rules(id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ok-row', null, 'fine', 1, 'p', '["archive"]', 0.5, now, now)
  legacy.prepare(
    `INSERT INTO ai_rules(id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('bad-row', null, null, 0, 'p', '["archive"]', 0.5, now, now)
  legacy.close()
}

/** Seed a legacy DEFAULT 1 table with a fully-populated row across EVERY column
 *  (non-default account_id / budget / timestamps) so a later rebuild can be
 *  checked for verbatim column preservation, not just enabled+id. */
function seedLegacyDbFullRow(dir: string): void {
  const dbPath = path.join(dir, 'cache.db')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy = new (Database as any)(dbPath)
  legacy.exec(`
    CREATE TABLE ai_rules(
      id TEXT PRIMARY KEY,
      account_id TEXT,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      prompt TEXT NOT NULL,
      allowed_actions TEXT NOT NULL,
      budget_per_day_usd REAL DEFAULT 0.50,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  legacy.prepare(
    `INSERT INTO ai_rules(id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('full-1', '42', 'A rule', 1, 'the prompt text', '["archive","move","mark_read"]', 3.75, '2024-01-02T03:04:05.000Z', '2024-06-07T08:09:10.000Z')
  legacy.prepare(
    `INSERT INTO ai_rules(id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('full-2', null, 'Другое правило', 0, 'prompt 2 with "quotes"', '["trash"]', 0.01, '2023-12-31T23:59:59.000Z', '2024-01-01T00:00:00.000Z')
  legacy.close()
}

async function loadDbModule(dir: string): Promise<{ mod: DbModule; prevDataDir: string | undefined }> {
  vi.resetModules()
  const prevDataDir = process.env.MAILCOPILOT_DATA_DIR
  process.env.MAILCOPILOT_DATA_DIR = dir
  const mod = await import('./index')
  return { mod, prevDataDir }
}

function cleanup(dir: string, mod: DbModule, prevDataDir: string | undefined) {
  try { mod.default.close() } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true })
  if (prevDataDir === undefined) delete process.env.MAILCOPILOT_DATA_DIR
  else process.env.MAILCOPILOT_DATA_DIR = prevDataDir
}

describe('ai_rules enabled-default migration (§2.39)', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('rebuilds a legacy DEFAULT 1 table so the declared default becomes 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-airule-mig-'))
    seedLegacyDb(dir)
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      // The schema default is now 0 (hardened at migration time).
      expect(mod.__aiRulesEnabledColumnDefaultForTest()).toBe('0')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('preserves existing row enabled values across the rebuild', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-airule-mig-'))
    seedLegacyDb(dir)
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const rules = mod.listAiRules()
      const byId = new Map(rules.map(r => [r.id, r]))
      // An already-enabled rule stays enabled; a disabled rule stays disabled.
      expect(byId.get('rule-enabled')?.enabled).toBe(true)
      expect(byId.get('rule-disabled')?.enabled).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a raw INSERT omitting enabled now defaults to 0 (disabled) on the upgraded schema', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-airule-mig-'))
    seedLegacyDb(dir)
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      const now = new Date().toISOString()
      // Simulate a raw INSERT that OMITS the enabled column — before the
      // migration this would have inherited DEFAULT 1 and created an ENABLED
      // rule. After the migration it must default to 0.
      mod.default.prepare(
        `INSERT INTO ai_rules(id, account_id, name, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('raw-insert', null, 'raw', 'p', '["archive"]', 0.5, now, now)
      const raw = mod.getAiRule('raw-insert')
      expect(raw?.enabled).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a fresh DB already has DEFAULT 0 and createAiRule defaults enabled to false', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-airule-mig-'))
    // No legacy seed — fresh schema.
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      expect(mod.__aiRulesEnabledColumnDefaultForTest()).toBe('0')
      const created = mod.createAiRule({ name: 'n', prompt: 'p', allowedActions: '["archive"]' })
      expect(created.enabled).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('re-running the migration is idempotent (no-op the second time)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-airule-mig-'))
    seedLegacyDb(dir)
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      // Rows survive the first run; force a second run via the test hook.
      mod.__runAiRulesEnabledDefaultOffMigrationV1ForTest()
      expect(mod.__aiRulesEnabledColumnDefaultForTest()).toBe('0')
      const rules = mod.listAiRules()
      expect(rules.map(r => r.id).sort()).toEqual(['rule-disabled', 'rule-enabled'])
      expect(rules.find(r => r.id === 'rule-enabled')?.enabled).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('rolls back the ai_rules rebuild atomically on copy failure', async () => {
    // A NULL-name legacy row violates the hardened `name TEXT NOT NULL` schema,
    // so the rebuild's INSERT ... SELECT throws mid-transaction. The whole
    // rebuild (RENAME + CREATE + copy) must roll back as one unit: the original
    // legacy table (DEFAULT 1) stays intact, no rebuilt table survives, no
    // scratch `ai_rules_legacy_pre239` is left behind, and the migration marker
    // is NOT written (so it retries next start).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-airule-mig-'))
    seedLegacyDbWithBadRow(dir)
    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      // The module-init migration attempt threw and was swallowed → rolled back.
      // Declared default is STILL the legacy '1' (rebuild undone).
      expect(mod.__aiRulesEnabledColumnDefaultForTest()).toBe('1')
      // Both original rows are still present and untouched (atomic rollback).
      const ids = (mod.default
        .prepare('SELECT id FROM ai_rules ORDER BY id')
        .all() as Array<{ id: string }>).map(r => r.id)
      expect(ids).toEqual(['bad-row', 'ok-row'])
      // The scratch rename target must not linger.
      const leftover = mod.default
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ai_rules_legacy_pre239'`)
        .get()
      expect(leftover).toBeUndefined()
      // The migration marker was NOT recorded — it will retry on next start.
      const marker = mod.default
        .prepare(`SELECT 1 FROM schema_migrations WHERE name=?`)
        .get('migrate_ai_rules_enabled_default_off_v1')
      expect(marker).toBeUndefined()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('preserves every ai_rules column across the rebuild (raw-row equality)', async () => {
    // Capture the raw legacy rows, run the migration, and assert the rebuilt
    // rows are byte-for-byte equal across EVERY column — not just enabled+id.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-airule-mig-'))
    seedLegacyDbFullRow(dir)

    // Snapshot the raw legacy rows BEFORE the module loads (before migration).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = new (Database as any)(path.join(dir, 'cache.db'))
    const before = raw
      .prepare('SELECT id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at FROM ai_rules ORDER BY id')
      .all()
    raw.close()

    const { mod, prevDataDir } = await loadDbModule(dir)
    try {
      // The rebuild ran (default hardened to 0).
      expect(mod.__aiRulesEnabledColumnDefaultForTest()).toBe('0')
      const after = mod.default
        .prepare('SELECT id, account_id, name, enabled, prompt, allowed_actions, budget_per_day_usd, created_at, updated_at FROM ai_rules ORDER BY id')
        .all()
      // Every column of every row survives verbatim.
      expect(after).toEqual(before)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
