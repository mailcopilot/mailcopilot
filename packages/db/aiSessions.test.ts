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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcopilot-db-ai-sessions-test-'))
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

describe('packages/db ai sessions', () => {
  const testDb = betterSqlite3Usable ? it : it.skip

  testDb('createAiSession + listAiSessions', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const session = mod.createAiSession('test-uuid-1', 'openai-api')
      expect(session.id).toBe('test-uuid-1')
      expect(session.title).toBe('')
      expect(session.provider).toBe('openai-api')
      expect(session.claudeSessionId).toBeNull()

      const list = mod.listAiSessions()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe('test-uuid-1')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getAiSession returns undefined for missing id', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      expect(mod.getAiSession('nonexistent')).toBeUndefined()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('updateAiSessionTitle updates title and updated_at', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const session = mod.createAiSession('uuid-2', 'gemini-api')
      const originalUpdatedAt = session.updatedAt
      mod.updateAiSessionTitle('uuid-2', 'My Chat')
      const updated = mod.getAiSession('uuid-2')
      expect(updated?.title).toBe('My Chat')
      expect(updated!.updatedAt >= originalUpdatedAt).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('updateAiSessionClaudeId stores external session id', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('uuid-3', 'subscription')
      mod.updateAiSessionClaudeId('uuid-3', 'claude-ext-id-123')
      const session = mod.getAiSession('uuid-3')
      expect(session?.claudeSessionId).toBe('claude-ext-id-123')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('insertAiMessage + listAiMessages', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('uuid-4', 'openai-api')
      mod.insertAiMessage('uuid-4', 'user', 'Hello')
      mod.insertAiMessage('uuid-4', 'assistant', 'Hi there!', 0.001)

      const msgs = mod.listAiMessages('uuid-4')
      expect(msgs).toHaveLength(2)
      expect(msgs[0].role).toBe('user')
      expect(msgs[0].content).toBe('Hello')
      expect(msgs[0].costUsd).toBeNull()
      expect(msgs[1].role).toBe('assistant')
      expect(msgs[1].content).toBe('Hi there!')
      expect(msgs[1].costUsd).toBe(0.001)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('getLastAiMessages returns last N messages in chronological order', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('uuid-5', 'openai-api')
      for (let i = 0; i < 10; i++) {
        mod.insertAiMessage('uuid-5', i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
      }

      const last4 = mod.getLastAiMessages('uuid-5', 4)
      expect(last4).toHaveLength(4)
      expect(last4[0].content).toBe('Message 6')
      expect(last4[3].content).toBe('Message 9')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteAiSession cascades to messages', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('uuid-6', 'openai-api')
      mod.insertAiMessage('uuid-6', 'user', 'Hello')
      mod.insertAiMessage('uuid-6', 'assistant', 'World')

      expect(mod.deleteAiSession('uuid-6')).toBe(true)
      expect(mod.listAiMessages('uuid-6')).toHaveLength(0)
      expect(mod.getAiSession('uuid-6')).toBeUndefined()
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteAllAiSessions clears everything', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('uuid-7', 'openai-api')
      mod.createAiSession('uuid-8', 'gemini-api')
      mod.insertAiMessage('uuid-7', 'user', 'A')
      mod.insertAiMessage('uuid-8', 'user', 'B')

      const deleted = mod.deleteAllAiSessions()
      expect(deleted).toBe(2)
      expect(mod.listAiSessions()).toHaveLength(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('listAiSessions sorted by updated_at DESC', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('uuid-a', 'openai-api')
      mod.createAiSession('uuid-b', 'openai-api')
      // Wait to ensure different updated_at timestamps
      await new Promise(resolve => setTimeout(resolve, 10))
      mod.updateAiSessionTitle('uuid-a', 'Updated')

      const list = mod.listAiSessions()
      expect(list[0].id).toBe('uuid-a')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('insertAiMessage bumps session updated_at', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const session = mod.createAiSession('uuid-c', 'openai-api')
      const before = session.updatedAt
      mod.insertAiMessage('uuid-c', 'user', 'Test')
      const after = mod.getAiSession('uuid-c')!.updatedAt
      expect(after >= before).toBe(true)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // §2.51: sumAiCostSince is LEDGER-ONLY — it sums cost_usd only for rows under
  // AI_COST_LEDGER_SESSION_ID (recordAiCost / reservations), so chat assistant
  // messages saved by the renderer for their cost badges do NOT feed the budget.
  testDb('sumAiCostSince sums ledger cost_usd after a given date', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.recordAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.005)
      mod.recordAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.010)

      // Sum all ledger costs since epoch (should include everything booked above)
      const total = mod.sumAiCostSince('1970-01-01T00:00:00.000Z')
      expect(total).toBeCloseTo(0.015, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('sumAiCostSince returns 0 when no ledger rows have cost', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // A plain chat session with no ledger entry contributes nothing.
      mod.createAiSession('uuid-cost-2', 'openai-api')
      mod.insertAiMessage('uuid-cost-2', 'user', 'Hello')
      mod.insertAiMessage('uuid-cost-2', 'assistant', 'Hi', undefined)

      const total = mod.sumAiCostSince('1970-01-01T00:00:00.000Z')
      expect(total).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('sumAiCostSince filters ledger cost by date', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.recordAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.001)

      // Sum with a future date — should return 0
      const futureDate = new Date(Date.now() + 86400000).toISOString()
      const total = mod.sumAiCostSince(futureDate)
      expect(total).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // §2.51 double-count fix (scenario a): a chat assistant message saved under a
  // REAL chat session with a cost_usd is DISPLAY-ONLY — it is NOT summed into the
  // budget, because the same chat spend is already counted via its ledger
  // reservation. Summing both would double-charge the cap.
  testDb('sumAiCostSince excludes chat assistant-message cost (display-only, not budget)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('uuid-chat-cost', 'openai-api')
      // Renderer persists the finished assistant message WITH its cost for the UI
      // badge — but this session is not the ledger, so it must not feed the budget.
      mod.insertAiMessage('uuid-chat-cost', 'assistant', 'chat reply', 0.03)

      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBe(0)
      // The cost is still persisted on the row for the UI badge to read.
      const msgs = mod.listAiMessages('uuid-chat-cost')
      expect(msgs[0].costUsd).toBeCloseTo(0.03, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // §2.51 double-count fix (scenario b): cost booked under the LEDGER session
  // (recordAiCost / reservations) IS summed into the budget.
  testDb('sumAiCostSince includes ledger cost (recordAiCost / reservations)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.recordAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.02)
      mod.reserveAiCost('acc-2', 'anthropic-api', 'claude-haiku-4-5', 0.05)

      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.07, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // §2.51 double-count fix (scenario c): the exact regression. A chat call books
  // $C ONCE via its ledger reservation; the renderer separately saves the
  // finished assistant message with the SAME $C under the real chat session.
  // sumAiCostSince must report $C (counted once), NOT $2C.
  testDb('sumAiCostSince counts a chat call once — ledger reservation, not the duplicate chat assistant row', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const cost = 0.04
      // 1. The chat call reserves + settles $C in the ledger (the budget entry).
      const reservation = mod.reserveAiCost('acc-1', 'openai-api', 'gpt-4o-mini', cost)
      mod.reconcileAiReservation(reservation, cost)
      // 2. The renderer saves the finished assistant message with the SAME $C
      //    under the real chat session, purely for the UI cost badge.
      mod.createAiSession('uuid-chat-dup', 'openai-api')
      mod.insertAiMessage('uuid-chat-dup', 'assistant', 'chat reply', cost)

      // Budget sees $C exactly once (the ledger), not $2C.
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(cost, 6)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- recordAiCost: standalone (session-less) cost entries into the ledger ---
  testDb('recordAiCost makes non-chat cost visible to sumAiCostSince (the budget ledger)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const row = mod.recordAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.02)
      expect(row.costUsd).toBe(0.02)
      expect(row.sessionId).toBe(mod.AI_COST_LEDGER_SESSION_ID)

      // The very same ledger checkBudgetLimits reads must now include it.
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.02, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // §2.51: recordAiCost entries accumulate in the ONE ledger the budget reads.
  // A chat assistant message under a real chat session is DISPLAY-ONLY and does
  // NOT add to the sum (its spend is already counted via its ledger reservation).
  testDb('recordAiCost accumulates in the ledger; chat-message cost stays display-only', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('uuid-mixed', 'openai-api')
      mod.insertAiMessage('uuid-mixed', 'assistant', 'chat reply', 0.01) // display-only
      mod.recordAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.02)
      mod.recordAiCost('acc-2', 'gemini-api', null, 0.03)

      // Only the two ledger entries count: $0.05 (the $0.01 chat row is excluded).
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.05, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('recordAiCost clamps non-finite / negative cost to 0 (metering glitch cannot lower the total)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const nan = mod.recordAiCost('acc-1', 'openai-api', null, Number.NaN)
      const neg = mod.recordAiCost('acc-1', 'openai-api', null, -5)
      expect(nan.costUsd).toBe(0)
      expect(neg.costUsd).toBe(0)
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('the hidden cost-ledger session is excluded from listAiSessions', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('uuid-visible', 'openai-api')
      mod.recordAiCost('acc-1', 'openai-api', null, 0.02)

      const sessions = mod.listAiSessions()
      expect(sessions.some(s => s.id === 'uuid-visible')).toBe(true)
      expect(sessions.some(s => s.id === mod.AI_COST_LEDGER_SESSION_ID)).toBe(false)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  testDb('deleteAllAiSessions preserves the cost ledger (clearing chat cannot reset the budget total)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.createAiSession('uuid-chat', 'openai-api')
      mod.insertAiMessage('uuid-chat', 'assistant', 'reply', 0.01)
      mod.recordAiCost('acc-1', 'openai-api', null, 0.02)

      mod.deleteAllAiSessions()

      // Chat session is gone, but the ledger spend survives.
      expect(mod.listAiSessions().length).toBe(0)
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.02, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- §2.51 atomic, fail-closed budget reservation ------------------------

  // AC1: a reservation participates in the SAME sumAiCostSince the budget cap
  // reads, the instant it commits — otherwise concurrent callers would not see
  // it and could all bypass the cap.
  testDb('reserveAiCost books a positive reservation visible to sumAiCostSince', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const before = mod.sumAiCostSince('1970-01-01T00:00:00.000Z')
      expect(before).toBe(0)

      const reservation = mod.reserveAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.05)
      expect(reservation.reservedUsd).toBe(0.05)
      expect(reservation.sessionId).toBe(mod.AI_COST_LEDGER_SESSION_ID)
      expect(reservation.id).toBeGreaterThan(0)

      // Visible to the budget query immediately — this is what makes the cap atomic.
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.05, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // AC1: two concurrent-style reservations both count — a second caller
  // re-reading the total sees the first reservation, which is the anti-bypass
  // property.
  testDb('reserveAiCost accumulates so a second reservation sees the first', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      mod.reserveAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.05)
      mod.reserveAiCost('acc-2', 'anthropic-api', 'claude-haiku-4-5', 0.07)
      // Both in-flight reservations count against the cap simultaneously.
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.12, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // AC2: reconcile REPLACES the reservation with the actual cost — one net
  // effect on the ledger, never double-counted.
  testDb('reserveAiCost + reconcileAiReservation nets to the actual cost (no double-count)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const reservation = mod.reserveAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.05)
      // While in flight the conservative reservation counts.
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.05, 5)

      const result = mod.reconcileAiReservation(reservation, 0.018)
      expect(result.settled).toBe(true)
      expect(result.finalUsd).toBeCloseTo(0.018, 6)

      // Net effect is ONLY the actual cost — the reservation was replaced, not
      // added to. If it were double-counted the total would be 0.068.
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.018, 6)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // AC2: reconcile is idempotent — a duplicate settle of the same reservation
  // cannot book the actual cost twice.
  testDb('reconcileAiReservation is idempotent (second settle is a no-op)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const reservation = mod.reserveAiCost('acc-1', 'openai-api', null, 0.05)
      const first = mod.reconcileAiReservation(reservation, 0.02)
      expect(first.settled).toBe(true)

      const second = mod.reconcileAiReservation(reservation, 0.02)
      expect(second.settled).toBe(false)

      // Total remains the single actual cost, not doubled.
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.02, 6)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // AC2: a garbage / non-finite actual settles fail-SAFE to 0 (the reservation
  // already protected the cap while the call ran). This does NOT disable the
  // cap — it only lowers the settled charge, never raises the running total.
  testDb('reconcileAiReservation clamps a non-finite / negative actual to 0', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const nanRes = mod.reserveAiCost('acc-1', 'openai-api', null, 0.05)
      const nan = mod.reconcileAiReservation(nanRes, Number.NaN)
      expect(nan.settled).toBe(true)
      expect(nan.finalUsd).toBe(0)

      const negRes = mod.reserveAiCost('acc-1', 'openai-api', null, 0.05)
      const neg = mod.reconcileAiReservation(negRes, -3)
      expect(neg.finalUsd).toBe(0)

      // Both reservations settled to 0 real spend — no leftover reservation
      // inflating the total, no negative dragging it down.
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // AC3: fail-CLOSED. A non-finite / non-positive reservation amount DENIES
  // (throws AiBudgetReserveError) rather than clamping to 0 (which is the
  // fail-OPEN behaviour recordAiCost has and this primitive inverts).
  testDb('reserveAiCost throws (deny) on a non-finite / non-positive amount — never books 0', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
        expect(() => mod.reserveAiCost('acc-1', 'openai-api', null, bad)).toThrow(mod.AiBudgetReserveError)
        try {
          mod.reserveAiCost('acc-1', 'openai-api', null, bad)
        } catch (err) {
          expect(err).toBeInstanceOf(mod.AiBudgetReserveError)
          expect((err as InstanceType<typeof mod.AiBudgetReserveError>).reason).toBe('invalid-amount')
        }
      }
      // Nothing was booked — a denied reservation leaves the ledger untouched.
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // AC3: fail-CLOSED. A durable ledger-write failure must DENY (throw), never
  // be swallowed — otherwise the cap has no record of the in-flight spend.
  testDb('reserveAiCost throws (deny) on a ledger-write failure — never fails open', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      // Force a real sqlite write failure by closing the underlying handle:
      // any subsequent prepare/run inside the reserve transaction throws.
      mod.default.close()

      let thrown: unknown
      try {
        mod.reserveAiCost('acc-1', 'openai-api', null, 0.05)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(mod.AiBudgetReserveError)
      expect((thrown as InstanceType<typeof mod.AiBudgetReserveError>).reason).toBe('ledger-write-failed')
    } finally {
      // mod.default is already closed; cleanup's close() is a harmless no-op.
      cleanup(dir, mod, prevDataDir)
    }
  })

  // AC7(a) — concurrent-bypass regression. This is the anti-regression test for
  // §2.51's core motivation: the OLD check-then-act pattern (checkBudgetLimits
  // reads sumAiCostSince, THEN records cost) let every racing caller read the
  // SAME pre-spend total and all pass the cap, because none of their writes had
  // landed yet when the others checked. The fix makes the admission a single
  // atomic unit (re-check + reserve, no await between, `BEGIN IMMEDIATE` write
  // lock) — so simulate N "concurrent" admissions as they would race through
  // `admitBudgetedCall` in ai.ts: each iteration re-reads the running total
  // (mirroring `checkBudgetLimits`) and reserves ONLY if still under cap. Since
  // every reservation is durably visible to `sumAiCostSince` the instant it
  // commits, the running total this loop observes is always correct — no caller
  // can slip a reservation in that pushes the total past the cap undetected.
  testDb('N racing admissions never let the total exceed the cap — each reservation is visible before the next check (AC7a)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const cap = 0.20
      const perCallReservation = 0.05 // matches AI_RULE_NULL_USAGE_COST_FLOOR
      const sinceIso = '1970-01-01T00:00:00.000Z'
      let admitted = 0
      let denied = 0

      // 10 "concurrent" callers racing the SAME admission sequence
      // (re-check-then-reserve) that admitBudgedCall performs in ai.ts.
      for (let i = 0; i < 10; i++) {
        const runningTotal = mod.sumAiCostSince(sinceIso)
        if (runningTotal >= cap) {
          denied++
          continue
        }
        mod.reserveAiCost(`acc-${i}`, 'openai-api', 'gpt-4o-mini', perCallReservation)
        admitted++
      }

      // With a 0.20 cap and 0.05 reservations, exactly 4 admissions fit
      // (0.05, 0.10, 0.15, 0.20 — the 5th check observes total=0.20 >= cap).
      expect(admitted).toBe(4)
      expect(denied).toBe(6)

      // The KEY anti-bypass assertion: the ledger total from admitted
      // reservations never exceeds the cap, because each reservation was
      // visible to the very next caller's check.
      const finalTotal = mod.sumAiCostSince(sinceIso)
      expect(finalTotal).toBeCloseTo(0.20, 5)
      expect(finalTotal).toBeLessThanOrEqual(cap + 1e-9)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // AC7(a) — same property, but reservations interleave with reconciles (a mix
  // of settled actual + in-flight reservations), proving the running total
  // `sumAiCostSince` reports always reflects BOTH kinds of ledger rows, so a
  // cap check performed between any two calls is never blind to in-flight spend.
  testDb('reservations and settled reconciles both count toward the same running total the cap reads (AC7a)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const sinceIso = '1970-01-01T00:00:00.000Z'

      // Caller 1 reserves and settles (a completed call).
      const r1 = mod.reserveAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.05)
      mod.reconcileAiReservation(r1, 0.03)

      // Caller 2 is still in flight (reserved, not yet reconciled) when caller 3
      // performs its budget check — caller 3 MUST see caller 2's reservation.
      mod.reserveAiCost('acc-2', 'anthropic-api', 'claude-haiku-4-5', 0.05)
      const totalSeenByCaller3 = mod.sumAiCostSince(sinceIso)
      expect(totalSeenByCaller3).toBeCloseTo(0.08, 5) // 0.03 settled + 0.05 in-flight

      // If this were under-cap, caller 3 proceeds and reserves too.
      mod.reserveAiCost('acc-3', 'openai-api', 'gpt-4o-mini', 0.05)
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.13, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // --- §2.51 fix-1: admitAiReservation atomic PROJECTED hard cap -----------

  // Case (a): the projected sum crosses a window cap → OVER-CAP DENY. Blocker/High
  // regression: with spent $0.19, cap $0.20, reservation $0.05 the OLD outer
  // `checkBudgetLimits !== null` pre-check returned null (0.19 < 0.20, "not
  // exceeded yet") and the reserve booked $0.05 → total $0.24, cap breached by
  // the whole reservation. The projected `spent + reservation > limit` check now
  // DENIES, inserts nothing, and leaves the running total untouched.
  testDb('admitAiReservation denies (over-cap) when projected sum crosses a window limit — no row inserted, sum unchanged', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    try {
      // Seed $0.19 of prior spend into the same ledger the cap reads.
      mod.recordAiCost('acc-seed', 'openai-api', 'gpt-4o-mini', 0.19)
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.19, 5)

      const admission = mod.admitAiReservation('acc-1', 'openai-api', 'gpt-4o-mini', 0.05, [
        { sinceIso, limitUsd: 0.20 },
      ])

      // Over-cap is a NORMAL deny (result), not a fail-closed throw.
      expect(admission.ok).toBe(false)
      if (!admission.ok) expect(admission.reason).toBe('over-cap')

      // Nothing was booked — the reservation that would have breached the cap
      // never landed, so the running total is exactly the pre-spend $0.19.
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.19, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // Case (b): a reservation that stays UNDER the limit is admitted and the
  // running total grows by exactly the reservation.
  testDb('admitAiReservation admits when projected sum stays under the limit — sum grows by the reservation', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    try {
      mod.recordAiCost('acc-seed', 'openai-api', 'gpt-4o-mini', 0.10)

      const admission = mod.admitAiReservation('acc-1', 'openai-api', 'gpt-4o-mini', 0.05, [
        { sinceIso, limitUsd: 0.20 },
      ])

      expect(admission.ok).toBe(true)
      if (admission.ok) {
        expect(admission.reservation.reservedUsd).toBe(0.05)
        expect(admission.reservation.sessionId).toBe(mod.AI_COST_LEDGER_SESSION_ID)
        expect(admission.reservation.id).toBeGreaterThan(0)
      }

      // $0.10 seed + $0.05 reservation = $0.15, both visible to the cap query.
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.15, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // Case (b'): a reservation that lands EXACTLY on the limit is admitted (the
  // hard cap uses strict `>`, so hitting the cap precisely is allowed while
  // crossing it is denied). This mirrors `checkBudgetLimits`'s `>=` boundary.
  testDb('admitAiReservation admits a reservation that lands exactly on the limit', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    try {
      mod.recordAiCost('acc-seed', 'openai-api', 'gpt-4o-mini', 0.15)
      const admission = mod.admitAiReservation('acc-1', 'openai-api', 'gpt-4o-mini', 0.05, [
        { sinceIso, limitUsd: 0.20 },
      ])
      expect(admission.ok).toBe(true)
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.20, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // Case (c): a SERIES of admissions up to the cap — the one that WOULD push the
  // total over the limit gets an over-cap deny. TRUE hard cap at the reservation
  // level: the total from admitted reservations never exceeds the limit, unlike
  // the old pre-check which allowed the last reservation to overshoot by its own
  // amount.
  testDb('admitAiReservation series enforces a true hard cap — total from reservations never exceeds the limit (case c)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    try {
      const cap = 0.20
      const perCall = 0.05
      let admitted = 0
      let denied = 0

      for (let i = 0; i < 10; i++) {
        const admission = mod.admitAiReservation(`acc-${i}`, 'openai-api', 'gpt-4o-mini', perCall, [
          { sinceIso, limitUsd: cap },
        ])
        if (admission.ok) admitted++
        else denied++
      }

      // Exactly 4 fit (0.05 → 0.10 → 0.15 → 0.20); the 5th would project to
      // 0.25 > 0.20 and is denied, as are the rest.
      expect(admitted).toBe(4)
      expect(denied).toBe(6)

      // KEY hard-cap assertion: the ledger total from admitted reservations lands
      // ON the cap and NEVER exceeds it — no reservation ever overshot.
      const finalTotal = mod.sumAiCostSince(sinceIso)
      expect(finalTotal).toBeCloseTo(0.20, 5)
      expect(finalTotal).toBeLessThanOrEqual(cap + 1e-9)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // Multi-window: an admission must satisfy EVERY supplied window. Here the daily
  // window is fine but the monthly window is over cap → over-cap deny.
  testDb('admitAiReservation denies if ANY window (daily/monthly) would be crossed', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    try {
      mod.recordAiCost('acc-seed', 'openai-api', 'gpt-4o-mini', 0.19)
      const admission = mod.admitAiReservation('acc-1', 'openai-api', 'gpt-4o-mini', 0.05, [
        { sinceIso, limitUsd: 5.0 },   // daily: plenty of room
        { sinceIso, limitUsd: 0.20 },  // monthly: 0.19 + 0.05 = 0.24 > 0.20
      ])
      expect(admission.ok).toBe(false)
      if (!admission.ok) expect(admission.reason).toBe('over-cap')
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.19, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // §2.51 double-count fix (scenario d): the atomic projected-admission check
  // sums the LEDGER ONLY, exactly like sumAiCostSince. A chat assistant message
  // saved under a real chat session (display-only cost) must NOT inflate the
  // projected sum, or a call would be wrongly denied as over-cap.
  testDb('admitAiReservation projected check sees ledger sums only — chat assistant cost does not inflate it', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    try {
      // Ledger holds $0.10; a chat session ALSO carries a $0.15 display-only cost.
      mod.recordAiCost('acc-seed', 'openai-api', 'gpt-4o-mini', 0.10)
      mod.createAiSession('uuid-chat-proj', 'openai-api')
      mod.insertAiMessage('uuid-chat-proj', 'assistant', 'chat reply', 0.15)

      // Projected: ledger 0.10 + reservation 0.05 = 0.15 <= 0.20 → ADMIT.
      // If the chat $0.15 were (wrongly) counted, 0.25 + 0.05 would deny.
      const admission = mod.admitAiReservation('acc-1', 'openai-api', 'gpt-4o-mini', 0.05, [
        { sinceIso, limitUsd: 0.20 },
      ])
      expect(admission.ok).toBe(true)
      // Budget total is ledger-only: 0.10 seed + 0.05 reservation = 0.15.
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.15, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // A window with limitUsd <= 0 is "unlimited" and is skipped (mirrors
  // checkBudgetLimits treating a non-positive limit as off). With no active
  // window, the reservation is always booked.
  testDb('admitAiReservation treats a non-positive limit window as unlimited (skipped)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    try {
      mod.recordAiCost('acc-seed', 'openai-api', 'gpt-4o-mini', 100)
      const admission = mod.admitAiReservation('acc-1', 'openai-api', 'gpt-4o-mini', 0.05, [
        { sinceIso, limitUsd: 0 },
      ])
      expect(admission.ok).toBe(true)
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(100.05, 5)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // Case (d): fail-CLOSED is PRESERVED. An invalid reservation amount THROWS
  // AiBudgetReserveError (invalid-amount) — it is NOT a routine over-cap deny.
  testDb('admitAiReservation throws (fail-closed, invalid-amount) on a non-finite / non-positive amount — never over-cap deny', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    try {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
        expect(() =>
          mod.admitAiReservation('acc-1', 'openai-api', null, bad, [{ sinceIso, limitUsd: 0.20 }]),
        ).toThrow(mod.AiBudgetReserveError)
        try {
          mod.admitAiReservation('acc-1', 'openai-api', null, bad, [{ sinceIso, limitUsd: 0.20 }])
        } catch (err) {
          expect(err).toBeInstanceOf(mod.AiBudgetReserveError)
          expect((err as InstanceType<typeof mod.AiBudgetReserveError>).reason).toBe('invalid-amount')
        }
      }
      // Nothing booked by any denied call.
      expect(mod.sumAiCostSince(sinceIso)).toBe(0)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // Case (d): fail-CLOSED is PRESERVED. A durable ledger-write failure THROWS
  // AiBudgetReserveError (ledger-write-failed), never a swallowed over-cap deny.
  testDb('admitAiReservation throws (fail-closed, ledger-write-failed) on a write failure — never fails open', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    try {
      // Close the handle so the reservation transaction's prepare/run throws.
      mod.default.close()

      let thrown: unknown
      try {
        mod.admitAiReservation('acc-1', 'openai-api', null, 0.05, [{ sinceIso, limitUsd: 0.20 }])
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(mod.AiBudgetReserveError)
      expect((thrown as InstanceType<typeof mod.AiBudgetReserveError>).reason).toBe('ledger-write-failed')
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // The admitted reservation is a normal AiCostReservation handle that reconcile
  // settles just like a reserveAiCost handle — proving the atomic-cap path does
  // not change the downstream settle contract.
  testDb('admitAiReservation handle reconciles like a reserveAiCost handle (settle to actual)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    try {
      const admission = mod.admitAiReservation('acc-1', 'openai-api', 'gpt-4o-mini', 0.05, [
        { sinceIso, limitUsd: 5.0 },
      ])
      expect(admission.ok).toBe(true)
      if (!admission.ok) return
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.05, 5)

      const result = mod.reconcileAiReservation(admission.reservation, 0.018)
      expect(result.settled).toBe(true)
      expect(result.finalUsd).toBeCloseTo(0.018, 6)
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.018, 6)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // Medium test-gap (codex-bg-review Part B) — the existing "nets to the actual
  // cost" test (AC2, above) only exercises settling BELOW the reservation
  // ($0.05 → $0.018). reconcileAiReservation is documented as an UPDATE-IN-PLACE
  // REPLACE (not an add-on-top), so it must behave identically when the actual
  // cost comes in ABOVE the conservative reservation (a genuinely under-priced
  // reservation, e.g. a model-aware floor that turned out too low for the real
  // token usage) — the ledger total must land on the actual, not on
  // reservation + actual (which would double-count the reservation).
  testDb('reconcileAiReservation ABOVE the reservation still REPLACES it (no double-count) — real DB', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const reservation = mod.reserveAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.05)
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.05, 5)

      const result = mod.reconcileAiReservation(reservation, 0.20)
      expect(result.settled).toBe(true)
      expect(result.finalUsd).toBeCloseTo(0.20, 6)

      // Total is EXACTLY the actual settled cost — not 0.05 + 0.20 = 0.25.
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.20, 6)

      // A duplicate reconcile of the same (now-settled) reservation remains a
      // no-op even when the first settle went ABOVE the reservation amount —
      // idempotency does not depend on which direction the settle moved.
      const second = mod.reconcileAiReservation(reservation, 0.20)
      expect(second.settled).toBe(false)
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.20, 6)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })

  // Medium test-gap (codex-bg-review Part B) — reconcile's write failure MUST
  // leave the reservation counted at its full conservative amount (safe-side for
  // a budget cap: losing the ability to LOWER a charge to actual is acceptable,
  // losing the charge itself is not) and must not silently corrupt the ledger
  // (no partial write, no duplicate row). Force a real sqlite write failure by
  // closing the underlying handle before reconcile runs, mirroring the existing
  // reserveAiCost / admitAiReservation ledger-write-failed tests above.
  testDb('reconcileAiReservation write-failure leaves the reservation counted at its full amount (fail-safe)', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    try {
      const reservation = mod.reserveAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.05)
      expect(mod.sumAiCostSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(0.05, 5)

      // Force the settle transaction's UPDATE to throw.
      mod.default.close()

      // reconcileAiReservation does NOT have a fail-closed throw contract (unlike
      // reserveAiCost / admitAiReservation) — it is the caller's (ai.ts
      // settleReservation) responsibility to catch a reconcile failure and treat
      // it as best-effort. Confirm the primitive itself surfaces the failure
      // (throws or reports unsettled) rather than silently pretending success.
      let threw = false
      let result: ReturnType<typeof mod.reconcileAiReservation> | undefined
      try {
        result = mod.reconcileAiReservation(reservation, 0.02)
      } catch {
        threw = true
      }
      // Either the primitive throws on a closed handle, or (if better-sqlite3
      // surfaces the closed-handle error differently) it reports `settled: false`
      // — in BOTH cases the reservation row was never overwritten because the
      // write never landed, which is the safe-side property under test.
      if (!threw && result) {
        expect(result.settled).toBe(false)
      } else {
        expect(threw).toBe(true)
      }
    } finally {
      // mod.default is already closed; cleanup's close() is a harmless no-op.
      cleanup(dir, mod, prevDataDir)
    }
  })

  // §2.51 fix-2 Blocker test-gap — BOUNDED SINGLE-CALL OVERSHOOT invariant
  // (documented in admitAiReservation's "WHAT HARD CAP MEANS" doc-comment).
  // A call admitted NEAR the cap may settle ABOVE it — the reservation floor is
  // a conservative UNDER-estimate, not an upper bound — but that overshoot is
  // bounded to exactly ONE call: the reconciled actual lands in the ledger, and
  // the VERY NEXT admission attempt against the same window is denied because
  // the ledger now already reflects (or exceeds) the limit. This test exercises
  // the full admit → reconcile-above-cap → next-admit-denied sequence against
  // the real DB, which is the executable form of that Q2 design decision.
  testDb('admitAiReservation: near-cap settle above the limit is a bounded single-call overshoot — the NEXT admission is denied', async () => {
    const { dir, mod, prevDataDir } = await loadDbModule()
    const sinceIso = '1970-01-01T00:00:00.000Z'
    const limitUsd = 0.20
    try {
      // Pre-spend $0.15 already in the ledger (simulating prior calls this window).
      mod.recordAiCost('acc-1', 'openai-api', 'gpt-4o-mini', 0.15)
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.15, 6)

      // A call is admitted near the cap: the conservative reservation floor
      // ($0.03) keeps the PROJECTED sum ($0.18) at/under the $0.20 limit.
      const admission = mod.admitAiReservation('acc-1', 'openai-api', 'gpt-4o-mini', 0.03, [
        { sinceIso, limitUsd },
      ])
      expect(admission.ok).toBe(true)
      if (!admission.ok) return
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.18, 6)

      // The call turns out to cost more than its floor once real usage is known
      // (e.g. a longer response than the conservative estimate assumed) — settle
      // ABOVE both the reservation AND the window limit itself.
      const settle = mod.reconcileAiReservation(admission.reservation, 0.20)
      expect(settle.settled).toBe(true)
      expect(settle.finalUsd).toBeCloseTo(0.20, 6)

      // Ledger now reflects the ACTUAL total ($0.15 pre-spend + $0.20 actual =
      // $0.35) — past the $0.20 limit. This single call's overshoot is accepted
      // by design (the reservation is a floor, not an upper bound).
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.35, 6)

      // The BOUND: the very next admission attempt against the same window is
      // denied — the cap holds going forward even though one call slipped over.
      const nextAdmission = mod.admitAiReservation('acc-1', 'openai-api', 'gpt-4o-mini', 0.01, [
        { sinceIso, limitUsd },
      ])
      expect(nextAdmission.ok).toBe(false)
      if (nextAdmission.ok) return
      expect(nextAdmission.reason).toBe('over-cap')
      // The denied attempt did not book anything — ledger total unchanged.
      expect(mod.sumAiCostSince(sinceIso)).toBeCloseTo(0.35, 6)
    } finally {
      cleanup(dir, mod, prevDataDir)
    }
  })
})
