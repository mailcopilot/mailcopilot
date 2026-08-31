import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-ai-translations-test-'))
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
 * Run `fn` and return the SQL text it handed to `db.prepare`.
 *
 * Lets a plan assertion target the statement the SHIPPED function runs instead
 * of a copy of it — a copy keeps passing after the real statement drifts.
 * better-sqlite3's `prepare` lives on the prototype, so an own property on the
 * instance shadows it and `delete` restores the original path exactly.
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

/**
 * The translation-contract version every fixture writes under. Part of the KEY
 * since §3.3.B6.f1 — a row produced by an older prompt is not an answer to a
 * request running the current one.
 */
const V = 'v1'

describe('packages/db ai translations (§3.3 B6)', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('stores and reads back a translation, and survives a reopen', async () => {
    const loaded = await loadDbModule()
    const { dir, prevDataDir } = loaded
    let mod = loaded.mod
    try {
      const hash = mod.computeTranslationSourceHash('Guten Tag, anbei die Rechnung.')
      expect(mod.getAiTranslation('1', hash, 'en', V)).toBeUndefined()

      mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
        accountId: '1',
        sourceHash: hash,
        targetLang: 'en',
        sourceLang: 'de',
        translatedText: 'Good afternoon, the invoice is attached.',
        provider: 'openai-api',
      })
      mod.default.close()

      vi.resetModules()
      process.env.MAILCOPILOT_DATA_DIR = dir
      mod = await import('./index')
      const row = mod.getAiTranslation('1', hash, 'en', V)
      expect(row?.translatedText).toBe('Good afternoon, the invoice is attached.')
      expect(row?.sourceLang).toBe('de')
      expect(row?.provider).toBe('openai-api')
      expect(typeof row?.createdAt).toBe('number')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('the same text in two target languages are two independent rows', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const hash = mod.computeTranslationSourceHash('Bonjour.')
      mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
        accountId: '1', sourceHash: hash, targetLang: 'en',
        sourceLang: 'fr', translatedText: 'Hello.', provider: 'openai-api',
      })
      mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
        accountId: '1', sourceHash: hash, targetLang: 'ru',
        sourceLang: 'fr', translatedText: 'Здравствуйте.', provider: 'openai-api',
      })
      expect(mod.getAiTranslation('1', hash, 'en', V)?.translatedText).toBe('Hello.')
      expect(mod.getAiTranslation('1', hash, 'ru', V)?.translatedText).toBe('Здравствуйте.')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('never serves one account the translation cached by another', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // The same message CC'd to two accounts hashes identically — the key is
      // the CONTENT. Only the query-level account scoping keeps them apart.
      const hash = mod.computeTranslationSourceHash('Same message, two mailboxes.')
      mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
        accountId: '1', sourceHash: hash, targetLang: 'ru',
        sourceLang: 'en', translatedText: 'account one', provider: 'openai-api',
      })
      expect(mod.getAiTranslation('2', hash, 'ru', V)).toBeUndefined()

      mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
        accountId: '2', sourceHash: hash, targetLang: 'ru',
        sourceLang: 'en', translatedText: 'account two', provider: 'openai-api',
      })
      expect(mod.getAiTranslation('1', hash, 'ru', V)?.translatedText).toBe('account one')
      expect(mod.getAiTranslation('2', hash, 'ru', V)?.translatedText).toBe('account two')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('re-translating the same text replaces the row instead of adding one', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const hash = mod.computeTranslationSourceHash('Hola.')
      mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
        accountId: '1', sourceHash: hash, targetLang: 'en',
        sourceLang: 'es', translatedText: 'Hi.', provider: 'openai-api', createdAt: 1000,
      })
      mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
        accountId: '1', sourceHash: hash, targetLang: 'en',
        sourceLang: 'es', translatedText: 'Hello.', provider: 'anthropic-api', createdAt: 2000,
      })
      expect(mod.countAiTranslations('1')).toBe(1)
      const row = mod.getAiTranslation('1', hash, 'en', V)
      expect(row?.translatedText).toBe('Hello.')
      expect(row?.provider).toBe('anthropic-api')
      expect(row?.createdAt).toBe(2000)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('enforces the per-account ceiling by evicting the oldest rows', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const cap = mod.AI_TRANSLATIONS_MAX_ROWS_PER_ACCOUNT
      const overflow = 5
      const hashes: string[] = []
      for (let i = 0; i < cap + overflow; i++) {
        const hash = mod.computeTranslationSourceHash(`message number ${i}`)
        hashes.push(hash)
        mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
          accountId: '1', sourceHash: hash, targetLang: 'en',
          sourceLang: null, translatedText: `t${i}`, provider: 'openai-api',
          // Explicit ascending clock: eviction must be deterministic and not
          // depend on two writes landing in different milliseconds.
          createdAt: 1000 + i,
        })
      }
      expect(mod.countAiTranslations('1')).toBe(cap)
      // The oldest `overflow` rows are gone; the newest survive.
      for (let i = 0; i < overflow; i++) {
        expect(mod.getAiTranslation('1', hashes[i], 'en', V)).toBeUndefined()
      }
      expect(mod.getAiTranslation('1', hashes[overflow], 'en', V)?.translatedText).toBe(`t${overflow}`)
      expect(mod.getAiTranslation('1', hashes[cap + overflow - 1], 'en', V)?.translatedText)
        .toBe(`t${cap + overflow - 1}`)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('eviction is scoped to the writing account', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const cap = mod.AI_TRANSLATIONS_MAX_ROWS_PER_ACCOUNT
      const neighbour = mod.computeTranslationSourceHash('neighbour account row')
      mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
        accountId: '2', sourceHash: neighbour, targetLang: 'en',
        sourceLang: null, translatedText: 'keep me', provider: 'openai-api', createdAt: 1,
      })
      for (let i = 0; i < cap + 3; i++) {
        mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
          accountId: '1', sourceHash: mod.computeTranslationSourceHash(`busy ${i}`),
          targetLang: 'en', sourceLang: null, translatedText: `t${i}`,
          provider: 'openai-api', createdAt: 1000 + i,
        })
      }
      // Account 2's row is older than every one of account 1's writes — a
      // globally-scoped eviction would have taken it first.
      expect(mod.getAiTranslation('2', neighbour, 'en', V)?.translatedText).toBe('keep me')
      expect(mod.countAiTranslations('1')).toBe(cap)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleting an account removes its cached translations', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const id = 7
      const hash = mod.computeTranslationSourceHash('derived email content')
      mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
        accountId: String(id), sourceHash: hash, targetLang: 'en',
        sourceLang: 'de', translatedText: 'derived translation', provider: 'openai-api',
      })
      expect(mod.getAiTranslation(String(id), hash, 'en', V)).toBeDefined()

      mod.deleteAccountData(id)
      expect(mod.getAiTranslation(String(id), hash, 'en', V)).toBeUndefined()
      expect(mod.countAiTranslations(String(id))).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('the cache key is the exact text — whitespace is not normalised away', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const a = mod.computeTranslationSourceHash('Hello world')
      const b = mod.computeTranslationSourceHash('Hello  world')
      const c = mod.computeTranslationSourceHash(' Hello world')
      expect(new Set([a, b, c]).size).toBe(3)
      expect(a).toMatch(/^[0-9a-f]{64}$/)
      expect(() => mod.computeTranslationSourceHash('')).toThrow()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- The contract version half of the key (§3.3.B6.f1) ---------------------
  //
  // The content hash pins the INPUT and says nothing about the OUTPUT side. The
  // same text translated by a different provider, a different model or a revised
  // prompt is a different answer, and before this column the FIRST answer won
  // forever with no way to ask again.

  testDb('a row produced under another contract version is not served', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const hash = mod.computeTranslationSourceHash('Guten Tag.')
      mod.upsertAiTranslation({
        accountId: '1', sourceHash: hash, targetLang: 'en', contractVersion: 'v1',
        sourceLang: 'de', translatedText: 'old prompt answer', provider: 'openai-api',
        wasLocal: false,
      })
      // Same account, same text, same target — a bumped contract MISSES, which
      // is the whole point: the next run pays once and replaces the answer.
      expect(mod.getAiTranslation('1', hash, 'en', 'v2')).toBeUndefined()
      expect(mod.getAiTranslation('1', hash, 'en', 'v1')?.translatedText).toBe('old prompt answer')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a bump retires the old row without deleting it, and the new one coexists', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const hash = mod.computeTranslationSourceHash('Bonjour.')
      mod.upsertAiTranslation({
        accountId: '1', sourceHash: hash, targetLang: 'en', contractVersion: 'v1',
        sourceLang: 'fr', translatedText: 'old', provider: 'openai-api', wasLocal: false,
      })
      mod.upsertAiTranslation({
        accountId: '1', sourceHash: hash, targetLang: 'en', contractVersion: 'v2',
        sourceLang: 'fr', translatedText: 'new', provider: 'anthropic-api', wasLocal: false,
      })
      // Two rows, not an overwrite: the retired one ages out through the
      // per-account ceiling rather than through a sweep.
      expect(mod.countAiTranslations('1')).toBe(2)
      expect(mod.getAiTranslation('1', hash, 'en', 'v2')?.translatedText).toBe('new')
      expect(mod.getAiTranslation('1', hash, 'en', 'v1')?.translatedText).toBe('old')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('stores the locality of the run that produced the row', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // A cache hit runs no inference, so the current provider configuration is
      // not evidence about a row written under an earlier one — the fact has to
      // be recorded when it was true.
      const local = mod.computeTranslationSourceHash('ran on this machine')
      const remote = mod.computeTranslationSourceHash('ran on a paid API')
      mod.upsertAiTranslation({
        accountId: '1', sourceHash: local, targetLang: 'en', contractVersion: V,
        sourceLang: null, translatedText: 'l', provider: 'openai-api', wasLocal: true,
      })
      mod.upsertAiTranslation({
        accountId: '1', sourceHash: remote, targetLang: 'en', contractVersion: V,
        sourceLang: null, translatedText: 'r', provider: 'openai-api', wasLocal: false,
      })
      expect(mod.getAiTranslation('1', local, 'en', V)?.wasLocal).toBe(true)
      expect(mod.getAiTranslation('1', remote, 'en', V)?.wasLocal).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('a database holding the pre-f1 table is migrated, not left broken', async () => {
    const loaded = await loadDbModule()
    const { dir, prevDataDir } = loaded
    let mod = loaded.mod
    try {
      // Stand in for a profile written by the first B6 build: no
      // `contract_version`, no `was_local`, and the old three-column key. The
      // new column belongs to the KEY, which SQLite cannot alter in place, so
      // the migration drops and recreates — safe here because the table is a
      // pure cache with no referents.
      mod.upsertThreadSummary({
        accountId: '1', threadHash: 'pre-existing', oneLine: 'kept',
        bullets: ['a'], provider: 'openai-api',
      })
      mod.default.exec(`
DROP INDEX IF EXISTS idx_ai_translations_account_created;
DROP TABLE ai_translations;
CREATE TABLE ai_translations(
  account_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  source_lang TEXT,
  translated_text TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, source_hash, target_lang)
);
INSERT INTO ai_translations VALUES('1', 'deadbeef', 'en', 'de', 'legacy', 'openai-api', 1);
`)
      mod.default.close()

      vi.resetModules()
      process.env.MAILCOPILOT_DATA_DIR = dir
      mod = await import('./index')

      const cols = (mod.default.prepare(`PRAGMA table_info(ai_translations)`).all() as Array<{ name: string }>)
        .map(r => r.name)
      expect(cols).toContain('contract_version')
      expect(cols).toContain('was_local')
      // The eviction index must come back with the recreated table.
      const indexes = (mod.default.prepare(`PRAGMA index_list(ai_translations)`).all() as Array<{ name: string }>)
        .map(r => r.name)
      expect(indexes).toContain('idx_ai_translations_account_created')
      // The legacy rows are gone by design — they were written under a contract
      // we can no longer name, and re-translating costs one call per message the
      // user asks for again.
      expect(mod.countAiTranslations('1')).toBe(0)
      // Everything else in the profile is untouched.
      expect(mod.getThreadSummary('1', 'pre-existing')?.oneLine).toBe('kept')

      const hash = mod.computeTranslationSourceHash('written after the migration')
      mod.upsertAiTranslation({
        accountId: '1', sourceHash: hash, targetLang: 'en', contractVersion: V,
        sourceLang: 'de', translatedText: 'migrated', provider: 'openai-api', wasLocal: false,
      })
      expect(mod.getAiTranslation('1', hash, 'en', V)?.translatedText).toBe('migrated')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- Schema-level hardening (B6 part 2) -----------------------------------
  //
  // The tests above exercise the exported functions. These four hold the
  // properties of the TABLE, which no amount of correct call-site code can
  // supply: a key that is only enforced by the upsert's own `ON CONFLICT`
  // clause is not a key, an eviction that is only fast because the table is
  // small today is not bounded, and a table that reaches an existing profile
  // only on a fresh install has no migration path at all.

  testDb('the composite key is enforced by the schema, not by the upsert SQL', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const hash = mod.computeTranslationSourceHash('keyed by the schema')
      const insert = (accountId: string) => mod.default.prepare(
        `INSERT INTO ai_translations(account_id, source_hash, target_lang, contract_version, source_lang, translated_text, provider, was_local, created_at)
         VALUES(?, ?, 'en', 'v1', NULL, 'x', 'openai-api', 0, 1)`,
      ).run(accountId, hash)

      insert('1')
      // A raw INSERT with no conflict clause: if the duplicate lands, the
      // uniqueness lives in `upsertAiTranslation`'s SQL rather than in the
      // table, and any future writer that forgets the clause silently doubles
      // the row — after which `getAiTranslation` answers with whichever copy
      // SQLite reaches first.
      expect(() => insert('1')).toThrow(/UNIQUE|constraint/i)
      // The same content hash under a different account is a DIFFERENT row,
      // not a conflict — this is the shape that makes cross-account isolation
      // possible at all.
      expect(() => insert('2')).not.toThrow()
      // …and so is the same row under a different contract version, which is
      // what makes a bump a retirement rather than a collision.
      expect(() => mod.default.prepare(
        `INSERT INTO ai_translations(account_id, source_hash, target_lang, contract_version, source_lang, translated_text, provider, was_local, created_at)
         VALUES('1', ?, 'en', 'v2', NULL, 'x', 'openai-api', 0, 1)`,
      ).run(hash)).not.toThrow()
      expect(mod.countAiTranslations('1')).toBe(2)
      expect(mod.countAiTranslations('2')).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('eviction is planned on an index — no full table scan, no sort', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Plan the statement the SHIPPED function prepares, not a copy of it: a
      // copy keeps passing after the real statement drifts, which is exactly
      // the regression worth guarding. Eviction runs on EVERY write, so a plan
      // that scans the whole table would make each cached translation cost a
      // pass over every account's rows.
      const captured = capturePreparedSql(mod.default, () => {
        mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
          accountId: '1', sourceHash: mod.computeTranslationSourceHash('plan probe'),
          targetLang: 'en', sourceLang: null, translatedText: 't', provider: 'openai-api',
        })
      })
      const deleteSql = captured.find(s => /DELETE FROM ai_translations/.test(s))
      expect(deleteSql).toBeDefined()

      const plan = (mod.default.prepare(`EXPLAIN QUERY PLAN ${deleteSql}`)
        .all('1', '1', mod.AI_TRANSLATIONS_MAX_ROWS_PER_ACCOUNT) as Array<{ detail: string }>)
        .map(r => r.detail)

      // `SCAN` (as opposed to `SEARCH`) is SQLite saying it will visit every
      // row of the table, including every other account's.
      expect(plan.filter(d => /^SCAN\b/.test(d)), plan.join(' | ')).toEqual([])
      // The ceiling subquery orders by (created_at DESC, rowid DESC). A temp
      // B-tree here means it materialises and sorts the account's rows on each
      // write instead of walking the index backwards.
      expect(plan.filter(d => /TEMP B-TREE/i.test(d)), plan.join(' | ')).toEqual([])
      expect(plan.join(' | ')).toContain('idx_ai_translations_account_created')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('the cache is outside FTS: eviction cannot corrupt the search index', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // CLAUDE.md §5 storage invariant: a bulk delete from `messages` must go
      // through `rebalanceFtsForBulkDelete`, because an unbalanced FTS5
      // external-content `'delete'` corrupts the index. Eviction here is a bulk
      // delete, so the invariant is only irrelevant while this table stays out
      // of FTS entirely — assert that, rather than assume it.
      const triggers = mod.default.prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%ai_translations%'`,
      ).all() as Array<{ name: string }>
      expect(triggers).toEqual([])
      const external = mod.default.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%content%ai_translations%'`,
      ).all() as Array<{ name: string }>
      expect(external).toEqual([])

      mod.upsertMessages(1, 'INBOX', [{
        uid: 1, subject: 'searchable subject', fromAddr: 'a@example.test',
        date: new Date(1_700_000_000_000).toISOString(), unread: true,
      }])
      const cap = mod.AI_TRANSLATIONS_MAX_ROWS_PER_ACCOUNT
      for (let i = 0; i < cap + 10; i++) {
        mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
          accountId: '1', sourceHash: mod.computeTranslationSourceHash(`evictable ${i}`),
          targetLang: 'en', sourceLang: null, translatedText: `t${i}`,
          provider: 'openai-api', createdAt: 1000 + i,
        })
      }
      expect(mod.countAiTranslations('1')).toBe(cap)
      expect(() => mod.default.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`))
        .not.toThrow()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('the table reaches a database created before it existed', async () => {
    const loaded = await loadDbModule()
    const { dir, prevDataDir } = loaded
    let mod = loaded.mod
    try {
      // Stand in for a profile from a build that predates B6: same file, same
      // rows, no `ai_translations`. There is no version counter in this schema
      // — arrival is the `CREATE TABLE IF NOT EXISTS` at module init, so the
      // only thing that can prove it is opening such a file.
      mod.upsertThreadSummary({
        accountId: '1', threadHash: 'pre-existing', oneLine: 'kept',
        bullets: ['a'], provider: 'openai-api',
      })
      mod.default.exec(`DROP INDEX IF EXISTS idx_ai_translations_account_created`)
      mod.default.exec(`DROP TABLE ai_translations`)
      mod.default.close()

      vi.resetModules()
      process.env.MAILCOPILOT_DATA_DIR = dir
      mod = await import('./index')

      const hash = mod.computeTranslationSourceHash('written after the migration')
      mod.upsertAiTranslation({ contractVersion: V, wasLocal: false,
        accountId: '1', sourceHash: hash, targetLang: 'en',
        sourceLang: 'de', translatedText: 'migrated', provider: 'openai-api',
      })
      expect(mod.getAiTranslation('1', hash, 'en', V)?.translatedText).toBe('migrated')
      // The eviction index must come back with the table, not only on a fresh
      // install — otherwise upgraded profiles get the un-indexed plan forever.
      const indexes = (mod.default.prepare(`PRAGMA index_list(ai_translations)`).all() as Array<{ name: string }>)
        .map(r => r.name)
      expect(indexes).toContain('idx_ai_translations_account_created')
      // Pre-existing data is untouched by the arrival of the new table.
      expect(mod.getThreadSummary('1', 'pre-existing')?.oneLine).toBe('kept')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
