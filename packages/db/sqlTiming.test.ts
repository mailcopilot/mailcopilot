import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  installSqlTiming,
  takeSlowSqlSamples,
  normaliseForDigest,
  sqlFingerprint,
  sqlDigest,
  __uninstallSqlTimingForTest,
} from './sqlTiming'

/**
 * Unit tests for the SQL hot-path instrumentation (§2.156, point 3).
 *
 * These run without the native module on purpose: the patching contract is
 * "whatever better-sqlite3 puts on its prototypes", so a fake with the same
 * shape exercises it and keeps the tests out of the ABI-split skip (see
 * CLAUDE.md §5 — `npm test` cannot prove the DB layer).
 *
 * The two properties worth guarding are (a) a bind value can never reach a
 * sample, and (b) the instrumentation is inert on the fast path and never
 * changes what a query does.
 */

class FakeStatement {
  constructor(public source: string, private readonly behaviour: () => unknown) {}
  run(...params: unknown[]): unknown { void params; return this.behaviour() }
  get(...params: unknown[]): unknown { void params; return this.behaviour() }
  all(...params: unknown[]): unknown { void params; return this.behaviour() }
  iterate(...params: unknown[]): unknown { void params; return this.behaviour() }
}

class FakeDatabase {
  behaviour: () => unknown = () => undefined
  prepare(sql: string): FakeStatement { return new FakeStatement(sql, () => this.behaviour()) }
  exec(sql: string): unknown { void sql; return this.behaviour() }
  pragma(sql: string): unknown { void sql; return this.behaviour() }
}

/**
 * Models the real better-sqlite3 contract for `.iterate()`: the call itself
 * returns an iterator synchronously and cheaply, while the actual per-row
 * work happens later, driven by the CALLER's `.next()` calls — not inside the
 * statement method that the timing patch wraps.
 */
class LazyIteratorStatement {
  constructor(public source: string) {}
  iterate(...params: unknown[]): Iterator<{ id: number }> {
    void params
    let n = 0
    return {
      next: () => {
        n += 1
        if (n > 3) return { done: true as const, value: undefined as unknown as { id: number } }
        vi.advanceTimersByTime(200) // the "row work" a caller pays for per step
        return { done: false as const, value: { id: n } }
      },
    }
  }
}

class LazyIteratorDatabase {
  prepare(sql: string): LazyIteratorStatement { return new LazyIteratorStatement(sql) }
}

/** Burn `ms` of the (faked) clock inside a call, the way SQLite would. */
function burn(ms: number): () => unknown {
  return () => { vi.advanceTimersByTime(ms); return 'ok' }
}

afterEach(() => {
  __uninstallSqlTimingForTest()
  vi.useRealTimers()
})

// normaliseForDigest feeds sqlDigest and nothing else — its output is never
// retained. It exists so the digest's keyword scan cannot land inside a comment
// or a quoted string and emit an identifier-shaped token from there.
describe('normaliseForDigest', () => {
  it('masks quoted text of both kinds and collapses whitespace', () => {
    expect(normaliseForDigest("SELECT *\n  FROM messages\n WHERE from_addr = 'boss@example.test'"))
      .toBe("SELECT * FROM messages WHERE from_addr = '?'")
    expect(normaliseForDigest('UPDATE folder_prefs SET icon = "/home/user/Private/x.png"'))
      .toBe('UPDATE folder_prefs SET icon = "?"')
  })

  it("handles doubled-quote escapes without swallowing the rest of the statement", () => {
    expect(normaliseForDigest("UPDATE messages SET subject = 'it''s here' WHERE id = 7"))
      .toBe("UPDATE messages SET subject = '?' WHERE id = ?".replace(' = ?', ' = 7'))
  })

  it('strips comments, so a `from <word>` pair cannot hide in one', () => {
    expect(normaliseForDigest('VACUUM /* from secret_project */')).toBe('VACUUM')
    expect(normaliseForDigest('VACUUM -- from secret_project')).toBe('VACUUM')
  })

  it('leaves identifiers that contain digits intact', () => {
    expect(normaliseForDigest('SELECT fingerprint_sha256 FROM tls_pins')).toBe('SELECT fingerprint_sha256 FROM tls_pins')
  })

  it('caps how much text the digest pass looks at', () => {
    expect(normaliseForDigest(`SELECT ${'a'.repeat(500)} FROM messages`)).toHaveLength(200)
  })
})

describe('sqlFingerprint', () => {
  // Pinned identically in scripts/sql-fingerprint.mjs (GOLDEN_FP), which checks
  // itself against this value at startup. If this assertion is updated without
  // updating the script, the script refuses to run rather than resolve a log
  // line to the wrong statement.
  it('matches the golden vector the resolver script pins', () => {
    // Written with the line breaks a source file would have, so this vector
    // pins the normalisation step as well as the hash.
    expect(sqlFingerprint('SELECT id\n  FROM messages\n WHERE folder_path = ?')).toBe('adc55a42')
  })

  it('is stable across formatting — the resolver reads multi-line source', () => {
    expect(sqlFingerprint('SELECT a\n  FROM messages\n  WHERE uid = ?'))
      .toBe(sqlFingerprint('SELECT a FROM messages WHERE uid = ?'))
    expect(sqlFingerprint('  SELECT a FROM messages WHERE uid = ?  '))
      .toBe(sqlFingerprint('SELECT a FROM messages WHERE uid = ?'))
  })

  it('separates statements a digest cannot: same verb, same table', () => {
    const a = sqlFingerprint('SELECT id FROM messages WHERE uid = ?')
    const b = sqlFingerprint('SELECT id FROM messages WHERE account_id = ?')
    expect(sqlDigest('SELECT id FROM messages WHERE uid = ?')).toBe(sqlDigest('SELECT id FROM messages WHERE account_id = ?'))
    expect(a).not.toBe(b)
  })

  it('is short, hexadecimal, and carries no substring of its input', () => {
    const fp = sqlFingerprint("SELECT * FROM messages WHERE subject = 'layoffs Q3'")
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
    // What this asserts and all it asserts: the output is a hash, not an
    // encoding, so nothing of the input is transported in it. It does NOT
    // assert secrecy — 32 unsalted bits over a guessable input are recoverable
    // by hashing candidates, which is exactly what the resolver script does.
    expect(fp).not.toContain('layoffs')
    expect('layoffs Q3'.includes(fp)).toBe(false)
  })

  it('is guessable by candidate search — stated so the token is not mistaken for redaction', () => {
    const secret = "SELECT * FROM messages WHERE subject = 'layoffs Q3'"
    const candidates = [
      'SELECT * FROM messages WHERE uid = ?',
      "SELECT * FROM messages WHERE subject = 'layoffs Q3'",
      'SELECT * FROM contacts',
    ]
    const recovered = candidates.find((c) => sqlFingerprint(c) === sqlFingerprint(secret))
    // Kills any future comment claiming the fingerprint is one-way in the sense
    // that matters for privacy. The design's protection is that the text is not
    // retained — not that this token hides it.
    expect(recovered).toBe(secret)
  })
})

describe('sqlDigest', () => {
  it('collapses a statement to verb + table', () => {
    expect(sqlDigest('SELECT * FROM messages WHERE uid = ?')).toBe('select messages')
    expect(sqlDigest('INSERT INTO messages_fts(rowid, subject) VALUES (?, ?)')).toBe('insert messages_fts')
    expect(sqlDigest('UPDATE folder_prefs SET visible = ?')).toBe('update folder_prefs')
    expect(sqlDigest('PRAGMA wal_checkpoint(TRUNCATE)')).toBe('pragma wal_checkpoint')
  })

  it('never emits anything that is not an identifier', () => {
    // A literal that survived into the text cannot reach the tag: only the two
    // matched identifiers are emitted.
    expect(sqlDigest("SELECT * FROM messages WHERE from_addr = 'secret@example.test'")).toBe('select messages')
    expect(sqlDigest('EXPLAIN QUERY PLAN xyz')).toBe('explain unknown')
    expect(sqlDigest('¯\\_(ツ)_/¯')).toBe('other unknown')
  })
})

describe('installSqlTiming', () => {
  it('records statements slower than the threshold, with the shape and not the values', () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    expect(installSqlTiming(db, { slowMs: 50 })).toBe(true)

    db.behaviour = burn(120)
    const stmt = db.prepare("SELECT id FROM messages WHERE from_addr = ? AND subject = ?")
    stmt.get('boss@example.test', 'Salary review')

    const samples = takeSlowSqlSamples()
    expect(samples).toHaveLength(1)
    expect(samples[0]!.durationMs).toBe(120)
    expect(samples[0]!.digest).toBe('select messages')
    expect(samples[0]!.fingerprint).toBe(sqlFingerprint('SELECT id FROM messages WHERE from_addr = ? AND subject = ?'))
    // The sample has no text field at all — see the retention tests below.
    expect(Object.keys(samples[0]!).sort()).toEqual(['at', 'digest', 'durationMs', 'fingerprint'])
  })

  it('leaks no bound value anywhere on the retained sample, not just through one field', () => {
    // Kills the class of bug that let `misspelledWord` escape a sanitized
    // `.message` while that one field looked clean: checking a single field
    // proves nothing about the rest of the object. Here every property of the
    // recorded sample is checked.
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = burn(120)
    const stmt = db.prepare('SELECT id FROM messages WHERE from_addr = ? AND subject = ?')
    stmt.get('boss@example.test', 'Salary review: layoffs Q3')

    const [sample] = takeSlowSqlSamples()
    const serialized = JSON.stringify(sample)
    expect(serialized).not.toContain('boss@example.test')
    expect(serialized).not.toContain('Salary review')
    expect(serialized).not.toContain('layoffs')
  })

  it('ignores calls below the threshold', () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = burn(10)
    db.prepare('SELECT 1').get()
    expect(takeSlowSqlSamples()).toEqual([])
  })

  it('covers exec and pragma, where SQL arrives as text', () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = burn(300)
    db.exec("DELETE FROM messages WHERE account_id = 3")
    db.pragma('wal_checkpoint(TRUNCATE)')

    const digests = takeSlowSqlSamples().map((s) => s.digest)
    expect(digests).toContain('delete messages')
    expect(digests).toContain('pragma wal_checkpoint')
  })

  // Nothing textual is retained on ANY path, so the same six forms are run
  // through both branches: the free-form string handed to `exec`, and a
  // prepared statement whose `source` contains the same literal (which is the
  // case the source-based design could not rule out — `Statement.source`
  // returns whatever reached `prepare()`, and one interpolating call site out
  // of 400+ would have deposited a value there).
  const LEAK_CASES: Array<[string, string, string]> = [
    ['a SQL comment', "DELETE FROM messages WHERE id = 4 /* requested by alice@example.test */", 'alice@example.test'],
    ['double-quoted text', 'UPDATE folder_prefs SET icon = "/home/user/Private Mail/x.png"', '/home/user/Private Mail'],
    ['a hex literal', 'INSERT INTO tls_pins(fingerprint_sha256) VALUES (0xDEADBEEFCAFE)', 'DEADBEEFCAFE'],
    ['exponent notation', 'UPDATE messages SET score = 1.5e10 WHERE uid = 9', '1.5e10'],
    ['a unicode escape', "UPDATE messages SET subject = u'\\u0441\\u0435\\u043a\\u0440\\u0435\\u0442'", '\\u0441'],
    ['a blob literal', "INSERT INTO messages(body_text) VALUES (x'736563726574')", '736563726574'],
  ]

  it.each(LEAK_CASES)('retains no text when exec carries %s', (_label, sql, secret) => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = burn(300)
    db.exec(sql)

    const sample = takeSlowSqlSamples()[0]!
    // Every field, present and future — not just the one we happen to log.
    expect(JSON.stringify(sample)).not.toContain(secret)
    expect(Object.keys(sample).sort()).toEqual(['at', 'digest', 'durationMs', 'fingerprint'])
    expect(sample.digest).toMatch(/^[a-z]+ [a-z0-9_]+$/)
    expect(sample.fingerprint).toBe(sqlFingerprint(sql))
  })

  it.each(LEAK_CASES)('retains no text when a PREPARED statement carries %s', (_label, sql, secret) => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = burn(300)
    db.prepare(sql).run()

    const sample = takeSlowSqlSamples()[0]!
    // Kills the previous design, which kept prepared-statement text on the
    // unverifiable assumption that it only ever holds `?` in place of values.
    expect(JSON.stringify(sample)).not.toContain(secret)
    expect(Object.keys(sample).sort()).toEqual(['at', 'digest', 'durationMs', 'fingerprint'])
  })

  it('retains no text on the pragma path either', () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = burn(300)
    db.pragma('temp_store_directory = "/home/user/private"')

    const sample = takeSlowSqlSamples()[0]!
    expect(JSON.stringify(sample)).not.toContain('/home/user/private')
    expect(sample.digest).toBe('pragma temp_store_directory')
  })

  it('keeps a statement identifiable without keeping the statement', () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = burn(300)
    db.prepare('SELECT id, subject FROM messages WHERE folder_path = ? ORDER BY uid DESC').all('INBOX')
    db.prepare('SELECT id, subject FROM messages WHERE account_id = ? ORDER BY uid DESC').all(1)

    const [a, b] = takeSlowSqlSamples()
    // Same digest — this is exactly why the fingerprint exists.
    expect(a!.digest).toBe(b!.digest)
    expect(a!.fingerprint).not.toBe(b!.fingerprint)
    expect(JSON.stringify([a, b])).not.toContain('ORDER BY')
  })

  it('drains slowest-first and clears, so one stall is never blamed twice', () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = burn(60)
    db.prepare('SELECT a FROM contacts').get()
    db.behaviour = burn(400)
    db.prepare('SELECT b FROM messages').get()

    const first = takeSlowSqlSamples()
    expect(first.map((s) => s.durationMs)).toEqual([400, 60])
    expect(takeSlowSqlSamples()).toEqual([])
  })

  it('keeps the slowest samples when more than the cap arrive', () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    for (let i = 1; i <= 12; i++) {
      db.behaviour = burn(50 + i * 10)
      db.prepare(`SELECT c${i} FROM messages`).get()
    }
    const samples = takeSlowSqlSamples()
    expect(samples).toHaveLength(8)
    expect(samples[0]!.durationMs).toBe(170)
    expect(Math.min(...samples.map((s) => s.durationMs))).toBe(100)
  })

  it('lets errors through unchanged and still times the failed call', () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = () => { vi.advanceTimersByTime(200); throw new Error('database is locked') }

    expect(() => db.prepare('SELECT x FROM messages').all()).toThrow('database is locked')
    expect(takeSlowSqlSamples()[0]!.durationMs).toBe(200)
  })

  it('is idempotent and reversible — a second install does not double-wrap', () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = burn(100)
    db.prepare('SELECT y FROM messages').get()
    expect(takeSlowSqlSamples()).toHaveLength(1)

    __uninstallSqlTimingForTest()
    db.behaviour = burn(100)
    db.prepare('SELECT y FROM messages').get()
    expect(takeSlowSqlSamples()).toEqual([])
  })

  it('is a no-op on anything that is not a database handle', () => {
    expect(installSqlTiming(null)).toBe(false)
    expect(installSqlTiming({})).toBe(false)
  })

  it('still patches iterate() itself — a slow call to obtain the iterator is recorded', () => {
    // Complements the test below: `iterate` must be in the patched method
    // list at all, or the "known limit" (consumption is unmeasured) would be
    // true for a much less defensible reason — the call is never even
    // wrapped. Kills: dropping 'iterate' from the patched-methods list.
    vi.useFakeTimers()
    const db = new FakeDatabase()
    installSqlTiming(db, { slowMs: 50 })
    db.behaviour = burn(80)
    db.prepare('SELECT * FROM messages').iterate()
    expect(takeSlowSqlSamples()).toHaveLength(1)
  })

  it('times iterate() only to the call that returns the iterator, not to consuming it', () => {
    // Documents (and locks) the "Known limits" contract in the module header:
    // if some future change wrapped consumption instead of just the call
    // (e.g. eagerly draining the iterator to get an "honest" duration), that
    // would defeat the whole point of `.iterate()` being lazy/streaming — and
    // it would also flip this test's outcome, since the 600ms of simulated
    // row work would then show up as a slow sample.
    vi.useFakeTimers()
    const db = new LazyIteratorDatabase()
    installSqlTiming(db, { slowMs: 50 })

    const stmt = db.prepare('SELECT * FROM messages')
    const iterator = stmt.iterate()
    // The patched call already returned — nothing to report yet.
    expect(takeSlowSqlSamples()).toEqual([])

    let result = iterator.next()
    while (!result.done) result = iterator.next() // 3 rows * 200ms = 600ms of "work"

    // That 600ms happened entirely outside the wrapped `.iterate()` call, so
    // it is invisible to the instrumentation — exactly as documented.
    expect(takeSlowSqlSamples()).toEqual([])
  })
})
