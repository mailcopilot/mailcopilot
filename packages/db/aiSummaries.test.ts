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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-ai-summaries-test-'))
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

describe('packages/db ai summaries', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('table is created and re-import is idempotent', async () => {
    const loaded = await loadDbModule()
    const { dir, prevDataDir } = loaded
    let mod = loaded.mod
    try {
      // First import created the table; a query must succeed without throwing.
      const hash = mod.computeThreadHash(['<a@x>', '<b@x>'])
      expect(mod.getThreadSummary('acc-1', hash)).toBeUndefined()

      // Close and re-open the SAME data dir: `CREATE TABLE IF NOT EXISTS`
      // must not fail and existing data must survive.
      mod.upsertThreadSummary({
        threadHash: hash,
        accountId: 'acc-1',
        oneLine: 'A quick summary',
        bullets: ['one', 'two'],
        provider: 'openai-api',
      })
      mod.default.close()

      vi.resetModules()
      process.env.MAILCOPILOT_DATA_DIR = dir
      const reloaded = await import('./index')
      mod = reloaded
      const row = reloaded.getThreadSummary('acc-1', hash)
      expect(row?.oneLine).toBe('A quick summary')
      expect(row?.bullets).toEqual(['one', 'two'])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsert then get round-trips all fields', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const hash = mod.computeThreadHash(['<m1@example.com>', '<m2@example.com>', '<m3@example.com>'])
      const created = mod.upsertThreadSummary({
        threadHash: hash,
        accountId: 'acc-42',
        oneLine: 'Three-message thread about the quarterly report',
        bullets: ['Point A', 'Point B', 'Point C', 'Point D', 'Point E'],
        provider: 'subscription',
        createdAt: 1_700_000_000_000,
      })
      expect(created.threadHash).toBe(hash)
      expect(created.createdAt).toBe(1_700_000_000_000)

      const row = mod.getThreadSummary('acc-42', hash)
      expect(row).toBeDefined()
      expect(row!.threadHash).toBe(hash)
      expect(row!.accountId).toBe('acc-42')
      expect(row!.oneLine).toBe('Three-message thread about the quarterly report')
      expect(row!.bullets).toEqual(['Point A', 'Point B', 'Point C', 'Point D', 'Point E'])
      expect(row!.provider).toBe('subscription')
      expect(row!.createdAt).toBe(1_700_000_000_000)
      expect(typeof row!.createdAt).toBe('number')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('upsert overwrites an existing summary for the same (account, thread_hash)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const hash = mod.computeThreadHash(['<x@y>', '<z@y>'])
      mod.upsertThreadSummary({
        threadHash: hash,
        accountId: 'acc-1',
        oneLine: 'First version',
        bullets: ['old'],
        provider: 'openai-api',
        createdAt: 1000,
      })
      mod.upsertThreadSummary({
        threadHash: hash,
        accountId: 'acc-1',
        oneLine: 'Second version',
        bullets: ['new-a', 'new-b'],
        provider: 'gemini-api',
        createdAt: 2000,
      })

      const row = mod.getThreadSummary('acc-1', hash)
      expect(row!.oneLine).toBe('Second version')
      expect(row!.bullets).toEqual(['new-a', 'new-b'])
      expect(row!.provider).toBe('gemini-api')
      expect(row!.createdAt).toBe(2000)

      // Exactly one row for the (account, hash) pair (no duplicate accumulation).
      const count = (mod.default
        .prepare('SELECT COUNT(*) AS c FROM ai_summaries WHERE account_id = ? AND thread_hash = ?')
        .get('acc-1', hash) as { c: number }).c
      expect(count).toBe(1)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('get on a missing hash returns undefined', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(mod.getThreadSummary('acc-1', 'nonexistent-hash')).toBeUndefined()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('empty bullets array round-trips as empty array', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const hash = mod.computeThreadHash(['<only@one>', '<other@one>'])
      mod.upsertThreadSummary({
        threadHash: hash,
        accountId: 'acc-1',
        oneLine: 'No bullets yet',
        bullets: [],
        provider: 'openai-api',
      })
      const row = mod.getThreadSummary('acc-1', hash)
      expect(row!.bullets).toEqual([])
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('default createdAt is populated when omitted', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const before = Date.now()
      const hash = mod.computeThreadHash(['<t@s>', '<u@s>'])
      const created = mod.upsertThreadSummary({
        threadHash: hash,
        accountId: 'acc-1',
        oneLine: 'Auto timestamp',
        bullets: [],
        provider: 'openai-api',
      })
      const after = Date.now()
      expect(created.createdAt).toBeGreaterThanOrEqual(before)
      expect(created.createdAt).toBeLessThanOrEqual(after)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- Cross-account cache isolation (privacy invariant) -------------------
  describe('cross-account isolation', () => {
    testDb('same thread_hash under a different account returns undefined (no cross-read)', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        // Two accounts whose threads share the SAME identity tokens produce the
        // same hash (the hash is deliberately account-agnostic).
        const hash = mod.computeThreadHash(['<shared@id>', '<second@id>'])
        mod.upsertThreadSummary({
          threadHash: hash,
          accountId: 'acc-A',
          oneLine: "Account A's private summary",
          bullets: ['a-secret'],
          provider: 'openai-api',
        })

        // Account B must NOT be able to read account A's row via the colliding hash.
        expect(mod.getThreadSummary('acc-B', hash)).toBeUndefined()
        // Account A still reads its own row.
        expect(mod.getThreadSummary('acc-A', hash)!.oneLine).toBe("Account A's private summary")
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('upsert under one account never overwrites another account row for the same hash', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const hash = mod.computeThreadHash(['<collide@id>', '<again@id>'])
        mod.upsertThreadSummary({
          threadHash: hash,
          accountId: 'acc-A',
          oneLine: 'A summary',
          bullets: ['a1'],
          provider: 'openai-api',
          createdAt: 100,
        })
        // Account B writes to the same hash — must create a SECOND, independent row.
        mod.upsertThreadSummary({
          threadHash: hash,
          accountId: 'acc-B',
          oneLine: 'B summary',
          bullets: ['b1'],
          provider: 'gemini-api',
          createdAt: 200,
        })

        // Both rows coexist; neither clobbered the other.
        expect(mod.getThreadSummary('acc-A', hash)!.oneLine).toBe('A summary')
        expect(mod.getThreadSummary('acc-B', hash)!.oneLine).toBe('B summary')
        const total = (mod.default
          .prepare('SELECT COUNT(*) AS c FROM ai_summaries WHERE thread_hash = ?')
          .get(hash) as { c: number }).c
        expect(total).toBe(2)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })
  })

  describe('computeThreadHash', () => {
    testDb('is order-independent (same set in different order → same hash)', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const a = mod.computeThreadHash(['<c@x>', '<a@x>', '<b@x>'])
        const b = mod.computeThreadHash(['<a@x>', '<b@x>', '<c@x>'])
        const c = mod.computeThreadHash(['<b@x>', '<c@x>', '<a@x>'])
        expect(a).toBe(b)
        expect(b).toBe(c)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('de-duplicates and ignores whitespace-only tokens', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const canonical = mod.computeThreadHash(['<a@x>', '<b@x>'])
        const noisy = mod.computeThreadHash(['  <b@x> ', '<a@x>', '<a@x>', '   ', ''])
        expect(noisy).toBe(canonical)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('different identity sets produce different hashes', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const two = mod.computeThreadHash(['<a@x>', '<b@x>'])
        const three = mod.computeThreadHash(['<a@x>', '<b@x>', '<c@x>'])
        expect(two).not.toBe(three)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('delimiter-collision: a newline inside one token cannot forge a boundary', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        // With a naive `\n` join these two DISTINCT sets would hash identically
        // (['a','b'] -> "a\nb"  vs  ['a\nb'] -> "a\nb"). Length-prefixed framing
        // must keep them distinct.
        const twoTokens = mod.computeThreadHash(['a', 'b'])
        const oneJoinedToken = mod.computeThreadHash(['a\nb'])
        expect(twoTokens).not.toBe(oneJoinedToken)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('delimiter-collision: a literal frame-separator char cannot forge a boundary', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        // The framing is `${len}:${tok}`; a token containing a ':' must not be
        // confusable with a length prefix of an adjacent frame.
        const a = mod.computeThreadHash(['1', ':x'])
        const b = mod.computeThreadHash(['1:', 'x'])
        expect(a).not.toBe(b)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('throws when the identity set is empty after normalisation', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        expect(() => mod.computeThreadHash([])).toThrow()
        expect(() => mod.computeThreadHash(['  ', '', '\t'])).toThrow()
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('returns a 64-char lowercase hex SHA-256 string', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const hash = mod.computeThreadHash(['<a@x>'])
        expect(hash).toMatch(/^[0-9a-f]{64}$/)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })
  })

  // --- Budget ledger round-trip (§3.3 B2 TG-H4) -----------------------------
  //
  // The thread-summary generator books a successful paid generation's cost via
  // `recordAiCost` into the SAME `ai_messages` ledger `sumAiCostSince` (and
  // therefore `electron/services/ai.ts` `checkBudgetLimits`) reads. The
  // generator-level test (`electron/services/aiThreadSummary.test.ts`) only
  // asserts the injected `recordCost` dep was called — it does not touch a
  // real DB. These tests close the loop end-to-end: a real `recordAiCost`
  // write is visible to a real subsequent `sumAiCostSince` read, so the
  // pre-call budget check for the NEXT generation actually accounts for it.
  describe('recordAiCost → sumAiCostSince (budget ledger round-trip)', () => {
    testDb('a recorded summary cost is included in a subsequent sumAiCostSince read', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const before = new Date(Date.now() - 1000).toISOString()
        expect(mod.sumAiCostSince(before)).toBe(0)

        mod.recordAiCost('1', 'anthropic-api', 'claude-haiku-4-5-20251001', 0.0021)

        // The exact same query a subsequent budget check would run now sees
        // the booked cost — the pre-call cap is not decorative.
        expect(mod.sumAiCostSince(before)).toBeCloseTo(0.0021, 6)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('accumulates across multiple generations for the same account', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const before = new Date(Date.now() - 1000).toISOString()
        mod.recordAiCost('1', 'openai-api', 'gpt-4o-mini', 0.001)
        mod.recordAiCost('1', 'openai-api', 'gpt-4o-mini', 0.002)
        mod.recordAiCost('1', 'openai-api', 'gpt-4o-mini', 0.0015)
        expect(mod.sumAiCostSince(before)).toBeCloseTo(0.0045, 6)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('costs from different accounts all count toward the SAME global budget sum (cap is app-wide, not per-account)', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const before = new Date(Date.now() - 1000).toISOString()
        mod.recordAiCost('1', 'anthropic-api', 'm', 0.01)
        mod.recordAiCost('2', 'anthropic-api', 'm', 0.02)
        expect(mod.sumAiCostSince(before)).toBeCloseTo(0.03, 6)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('does not book a cost row when costUsd is non-finite or non-positive (metering glitch never reduces or corrupts the ledger)', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const before = new Date(Date.now() - 1000).toISOString()
        mod.recordAiCost('1', 'anthropic-api', 'm', -5)
        mod.recordAiCost('1', 'anthropic-api', 'm', NaN)
        mod.recordAiCost('1', 'anthropic-api', 'm', 0)
        // All three are clamped to 0 — the ledger sum stays at 0, never negative/NaN.
        expect(mod.sumAiCostSince(before)).toBe(0)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('ledger rows use the hidden AI_COST_LEDGER_SESSION_ID and never surface via listAiSessions', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        mod.recordAiCost('1', 'anthropic-api', 'm', 0.005)
        const sessions = mod.listAiSessions()
        expect(sessions.some(s => s.id === mod.AI_COST_LEDGER_SESSION_ID)).toBe(false)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('survives deleteAllAiSessions (chat-clear): the hidden ledger session is preserved', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const before = new Date(Date.now() - 1000).toISOString()
        mod.recordAiCost('1', 'anthropic-api', 'm', 0.005)

        // A normal user chat session, independent of the hidden ledger session.
        mod.createAiSession('chat-1', 'anthropic-api')
        mod.insertAiMessage('chat-1', 'user', 'hi')

        // "Clear all chats" — the ledger session is explicitly excluded from
        // this bulk delete (see deleteAllAiSessions), so summary spend survives.
        mod.deleteAllAiSessions()

        expect(mod.sumAiCostSince(before)).toBeCloseTo(0.005, 6)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    // --- Reserved ledger session is non-deletable via the generic delete path -
    //
    // deleteAiSession backs the `aiSession:delete` IPC, which any renderer can
    // invoke with an arbitrary id. Without a data-layer guard, passing the
    // hidden ledger id would cascade-delete its cost rows, drop the budget sum
    // to zero, and bypass the daily/monthly cap. The guard lives in the db
    // function so it holds for every caller, not just that one handler.
    testDb('deleteAiSession is a no-op for AI_COST_LEDGER_SESSION_ID: session, its cost rows, and the budget sum all survive', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const before = new Date(Date.now() - 1000).toISOString()
        mod.recordAiCost('1', 'anthropic-api', 'm', 0.007)
        expect(mod.sumAiCostSince(before)).toBeCloseTo(0.007, 6)

        // Attempt to delete the reserved ledger session via the generic path —
        // this is exactly what a hostile/buggy renderer would send.
        const deleted = mod.deleteAiSession(mod.AI_COST_LEDGER_SESSION_ID)
        expect(deleted).toBe(false) // reported as "nothing deleted"

        // The session row still exists.
        expect(mod.getAiSession(mod.AI_COST_LEDGER_SESSION_ID)).toBeDefined()

        // Its cost rows are untouched, so the budget sum is unchanged — the cap
        // cannot be bypassed by deleting the ledger.
        expect(mod.sumAiCostSince(before)).toBeCloseTo(0.007, 6)
        const rows = (mod.default
          .prepare('SELECT COUNT(*) AS c FROM ai_messages WHERE session_id = ?')
          .get(mod.AI_COST_LEDGER_SESSION_ID) as { c: number }).c
        expect(rows).toBe(1)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('deleteAiSession still deletes a normal user chat session (guard is scoped to the reserved id only)', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        mod.createAiSession('chat-42', 'anthropic-api')
        mod.insertAiMessage('chat-42', 'user', 'hello')
        expect(mod.getAiSession('chat-42')).toBeDefined()

        const deleted = mod.deleteAiSession('chat-42')
        expect(deleted).toBe(true)
        expect(mod.getAiSession('chat-42')).toBeUndefined()
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    // --- insertAiMessage clamps renderer-supplied cost to a sane invariant -----
    //
    // insertAiMessage backs the `aiSession:addMessage` IPC (renderer-reachable)
    // and accepts an arbitrary costUsd. §2.51: the budget sum is LEDGER-ONLY, so
    // a chat assistant row's cost is display-only (the UI cost badge) and never
    // reaches sumAiCostSince. The clamp still matters for data hygiene: a
    // negative/non-finite value must never be persisted as the badge amount. It
    // shares recordAiCost's non-negative invariant: a finite positive cost
    // records; anything else is stored as null.
    testDb('insertAiMessage clamps a negative cost to null (never persisted as the display amount)', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const before = new Date(Date.now() - 1000).toISOString()
        // Book a real summary cost first (LEDGER — this IS the budget).
        mod.recordAiCost('1', 'anthropic-api', 'm', 0.01)
        expect(mod.sumAiCostSince(before)).toBeCloseTo(0.01, 6)

        // A renderer supplies a large negative "cost" for a chat message.
        mod.createAiSession('chat-neg', 'anthropic-api')
        const msg = mod.insertAiMessage('chat-neg', 'assistant', 'evil', -999)
        expect(msg.costUsd).toBeNull() // clamped away, not persisted as negative

        // The budget sum is ledger-only and unchanged either way — the chat row
        // never contributed, and the real ledger spend is intact.
        expect(mod.sumAiCostSince(before)).toBeCloseTo(0.01, 6)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('insertAiMessage clamps NaN / Infinity / -Infinity costs to null (budget sum stays finite and unchanged)', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const before = new Date(Date.now() - 1000).toISOString()
        mod.recordAiCost('1', 'anthropic-api', 'm', 0.02)
        mod.createAiSession('chat-nf', 'anthropic-api')

        expect(mod.insertAiMessage('chat-nf', 'assistant', 'a', NaN).costUsd).toBeNull()
        expect(mod.insertAiMessage('chat-nf', 'assistant', 'b', Infinity).costUsd).toBeNull()
        expect(mod.insertAiMessage('chat-nf', 'assistant', 'c', -Infinity).costUsd).toBeNull()
        expect(mod.insertAiMessage('chat-nf', 'assistant', 'd', 0).costUsd).toBeNull()

        // The budget sum is ledger-only: only the $0.02 recordAiCost entry is in
        // it, and it stays finite regardless of any chat-row garbage.
        const total = mod.sumAiCostSince(before)
        expect(Number.isFinite(total)).toBe(true)
        expect(total).toBeCloseTo(0.02, 6)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    // §2.51: a chat assistant message persists its positive cost for the UI
    // badge, but that cost is DISPLAY-ONLY — it is not part of the ledger, so it
    // does NOT enter the budget sum.
    testDb('insertAiMessage persists a positive chat cost for the badge but keeps it out of the budget sum', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        const before = new Date(Date.now() - 1000).toISOString()
        mod.createAiSession('chat-pos', 'anthropic-api')
        const msg = mod.insertAiMessage('chat-pos', 'assistant', 'ok', 0.0033)
        // The row keeps its cost so the AiPanel badge can render it.
        expect(msg.costUsd).toBeCloseTo(0.0033, 6)
        // But the ledger-only budget sum does NOT include a chat-session row.
        expect(mod.sumAiCostSince(before)).toBe(0)
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })

    testDb('insertAiMessage with no cost still stores null (unchanged for plain chat messages)', async () => {
      const { dir, mod, prevDataDir } = await loadDbModule()
      try {
        mod.createAiSession('chat-plain', 'anthropic-api')
        const a = mod.insertAiMessage('chat-plain', 'user', 'hi')
        const b = mod.insertAiMessage('chat-plain', 'assistant', 'hello', null)
        expect(a.costUsd).toBeNull()
        expect(b.costUsd).toBeNull()
      } finally {
        cleanup(dir, mod, prevDataDir)
      }
    })
  })
})
